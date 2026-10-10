// Session throughput: output and reasoning tokens per second, measured over the
// provider-active time the host actually recorded rather than over the wall
// clock.
//
// Pure: no clock, no I/O, no rendering. Untrusted sample fields are coerced
// through ./coerce.js so a garbage value is skipped rather than guessed at.
//
// Two pieces live here. The union helpers sum generation tokens (output plus
// reasoning, the same pair the official TUI divides) and merge the assistant
// turns' own streaming spans, so idle time is never in the denominator and the
// figure freezes once everything settles. `createInstantTps` is the live row's
// tracker: generation-token per-poll deltas over generating-time deltas, smoothed
// with an EWMA and repainted through hysteresis, so the rail shows what the
// decoder is doing now instead of everything the session ever did.

import { asCount, asText } from "./coerce.js";

/**
 * One assistant turn's contribution to the active-work average.
 *
 * `key` is the turn's identity (see `turnKey`); `tokens` is its output count and
 * `reasoning` its reasoning count, which the numerator adds together; `start`
 * and `end` are its span on the host's epoch clock. Every field is untrusted and
 * coerced before use.
 */
export interface ThroughputSpan {
  readonly key?: unknown;
  readonly tokens?: unknown;
  readonly reasoning?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
}

/**
 * Resolve one assistant turn's span from its timestamp rungs.
 *
 * `start` is `time.created`. `end` is `time.streamed` — the moment the
 * provider stopped decoding, the official TUI's numerator clock — then
 * `time.completed`, else the caller's `nowMs` for a turn still in flight.
 * (The elapsed clock used to prefer `completed` here so a turn's tool
 * settlement stayed in its tally; it now resolves that end itself in
 * ./session-reads.js, leaving this helper with the single decoding clock
 * both remaining callers want.) A clock that steps backwards
 * is clamped to a zero-length span rather than a negative one, so skew can never
 * subtract time from the union. Returns `undefined` when there is no usable
 * start - the turn is skipped, never guessed at.
 */
export function turnSpan(
  created: unknown,
  completed: unknown,
  streamed: unknown,
  nowMs: unknown,
): { readonly start: number; readonly end: number } | undefined {
  const start = asCount(created);
  if (start === undefined) return undefined;
  const ended = asCount(streamed) ?? asCount(completed) ?? asCount(nowMs);
  if (ended === undefined) return undefined;
  return { start, end: Math.max(start, ended) };
}

/**
 * Identity of one assistant turn: the host's own message id when it carries
 * one, otherwise the tuple `(created, completed)` plus - only once the turn
 * has stopped decoding - its `output` count. A turn with neither end rung yet
 * is still streaming, so its output count is still growing: leaving it out of
 * the key keeps one stable identity across polls instead of re-keying (and
 * re-counting) every snapshot of the same turn. A turn that finished decoding
 * (`streamed` or `completed` recorded) has a final output count, so it stays
 * in the key and two settled turns that share a start stay distinct. Retries,
 * replays and re-sent records share a key, so they contribute their tokens
 * once and their time once.
 */
export function turnKey(
  id: unknown,
  created: unknown,
  completed: unknown,
  output: unknown,
  streamed?: unknown,
): string {
  const own = asText(id);
  if (own !== undefined) return `id:${own}`;
  const stamp = `t:${asCount(created) ?? "?"}:${asCount(completed) ?? "?"}`;
  if (asCount(completed) === undefined && asCount(streamed) === undefined) return stamp;
  return `${stamp}:${asCount(output) ?? "?"}`;
}

/** Output + reasoning tokens and wall time the accepted turns actually cover. */
export interface SpanTotals {
  readonly tokens: number;
  readonly unionMs: number;
}

/**
 * The merged length of already-accepted spans.
 *
 * The shared second half of both unions: it pre-sorts so the result cannot
 * depend on the order the host returned the spans, then merges overlapping and
 * touching spans (`next.start <= openEnd`, so a span that starts exactly when
 * another ends is continuous work) into one. `0` when nothing was accepted.
 */
function mergedSpanMs(accepted: Array<{ start: number; end: number }>): number {
  // Pre-sort so the merge cannot depend on the order the host returned them.
  accepted.sort((a, b) => a.start - b.start || a.end - b.end);
  const first = accepted[0];
  if (first === undefined) return 0;

  let unionMs = 0;
  let openStart = first.start;
  let openEnd = first.end;
  for (let index = 1; index < accepted.length; index += 1) {
    const next = accepted[index];
    if (next === undefined) continue;
    // Touching spans (`next.start === openEnd`) merge as well as overlapping
    // ones: a turn that starts exactly when another ends is continuous work.
    if (next.start <= openEnd) {
      if (next.end > openEnd) openEnd = next.end;
    } else {
      unionMs += openEnd - openStart;
      openStart = next.start;
      openEnd = next.end;
    }
  }
  unionMs += openEnd - openStart;

  return unionMs;
}

/**
 * Sum the tokens of distinct turns and the union length of their spans.
 *
 * De-duplicates by `key` first, so a re-sent record adds its tokens once and
 * enters the union once — a dropped duplicate drops both sides together.
 * Spans are clamped (`end >= start`), then sorted and merged so overlapping
 * and touching turns count once and input order cannot change the result. A
 * turn's numerator is its output plus its reasoning count, the same pair the
 * official TUI divides.
 *
 * Every turn with a usable span counts in the denominator, including one that
 * produced no tokens: a stamped step that streamed for two seconds still took
 * two seconds, and dropping its span would inflate the rate above the official
 * figure. The caller decides there is no rate at all when the total numerator
 * or the total duration is not positive.
 */
export function unionSpanTotals(spans: readonly ThroughputSpan[]): SpanTotals {
  const seen = new Set<string>();
  const accepted: Array<{ start: number; end: number }> = [];
  let tokens = 0;

  for (const span of spans) {
    const key = asText(span.key);
    if (key === undefined || seen.has(key)) continue;

    const start = asCount(span.start);
    const end = asCount(span.end);
    if (start === undefined || end === undefined) continue;
    const output = asCount(span.tokens);
    const reasoning = asCount(span.reasoning);

    seen.add(key);
    accepted.push({ start, end: Math.max(start, end) });
    tokens += (output ?? 0) + (reasoning ?? 0);
  }

  return { tokens, unionMs: mergedSpanMs(accepted) };
}

/**
 * The union length of distinct turn spans, returned without the token sum.
 *
 * The same identity rule, clamp, pre-sort and merge as `unionSpanTotals`:
 * `elapsed` needs only the wall time, so the numerator never enters the
 * decision. A missing key is skipped; the first-seen key wins; a span without
 * a usable start and end is skipped; `0` when nothing is usable.
 */
export function unionSpanMs(spans: readonly ThroughputSpan[]): number {
  const seen = new Set<string>();
  const accepted: Array<{ start: number; end: number }> = [];

  for (const span of spans) {
    const key = asText(span.key);
    if (key === undefined || seen.has(key)) continue;

    const start = asCount(span.start);
    const end = asCount(span.end);
    if (start === undefined || end === undefined) continue;

    seen.add(key);
    accepted.push({ start, end: Math.max(start, end) });
  }

  return mergedSpanMs(accepted);
}

/**
 * Smoothing weight for the instantaneous TPS rate: each new per-poll sample
 * moves the displayed figure 30% of the way toward it. Heavy enough to stop
 * the row flickering on every poll, light enough that a real speedup shows
 * within a few polls rather than sagging behind a lifetime average.
 */
export const TPS_EWMA_ALPHA = 0.3;

/**
 * Hysteresis for the TPS repaint: the held figure moves only when the new
 * smoothed rate differs by at least one whole token/second or by at least
 * ten percent, so sub-token jitter never repaints the row.
 */
export const TPS_REPAINT_ABS = 1;
export const TPS_REPAINT_RATIO = 0.1;

/**
 * One per-poll instantaneous rate: generation-token DELTA over generating-time
 * DELTA, never over idle time. The caller passes only what happened since the
 * previous poll; both deltas exclude idle by construction (the union of
 * streaming spans, or the busy-gated active clock), so a pause can never sag
 * the figure. Returns `undefined` when there is no new generating time to
 * divide by.
 */
export function instantTpsRate(deltaTokens: unknown, deltaMs: unknown): number | undefined {
  const tokens = asCount(deltaTokens);
  const ms = asCount(deltaMs);
  if (tokens === undefined || ms === undefined || ms <= 0) return undefined;
  return tokens / (ms / 1_000);
}

/**
 * Fold one instantaneous sample into the running rate. The first sample seeds
 * the average directly; every later one moves it `alpha` of the way toward
 * the sample, so a single fast or slow poll bends the figure instead of
 * replacing it.
 */
export function smoothTpsRate(previous: number | undefined, sample: number, alpha: number = TPS_EWMA_ALPHA): number {
  if (previous === undefined || !Number.isFinite(previous)) return sample;
  if (!Number.isFinite(sample)) return previous;
  return previous + alpha * (sample - previous);
}

/**
 * Whether the held TPS figure should repaint for a new smoothed rate. The
 * first rate always paints; afterwards only a move of at least one tok/s or
 * at least ten percent does, so the row holds steady through noise.
 */
export function tpsNeedsRepaint(displayed: number | undefined, smoothed: number): boolean {
  if (displayed === undefined || !Number.isFinite(displayed)) return true;
  if (!Number.isFinite(smoothed)) return false;
  if (Math.abs(smoothed - displayed) >= TPS_REPAINT_ABS) return true;
  if (displayed === 0) return smoothed !== 0;
  return Math.abs(smoothed - displayed) / Math.abs(displayed) >= TPS_REPAINT_RATIO;
}

/**
 * Generation tokens and generating time for the TPS numerator: output plus
 * reasoning, the same pair the official TUI divides.
 *
 * The same identity rule, clamp, pre-sort and merge as `unionSpanTotals`.
 * Only the live TPS path uses this.
 */
export function unionGenerationTotals(spans: readonly ThroughputSpan[]): SpanTotals {
  const seen = new Set<string>();
  const accepted: Array<{ start: number; end: number }> = [];
  let tokens = 0;

  for (const span of spans) {
    const key = asText(span.key);
    if (key === undefined || seen.has(key)) continue;

    const start = asCount(span.start);
    const end = asCount(span.end);
    if (start === undefined || end === undefined) continue;
    const output = asCount(span.tokens);
    const reasoning = asCount(span.reasoning);

    seen.add(key);
    accepted.push({ start, end: Math.max(start, end) });
    tokens += (output ?? 0) + (reasoning ?? 0);
  }

  return { tokens, unionMs: mergedSpanMs(accepted) };
}

/**
 * Near-instantaneous generation rate for one displayed session scope.
 *
 * The caller feeds each poll's cumulative generation tokens and cumulative
 * generating milliseconds (the streaming-span union, which excludes idle by
 * construction) and gets back the figure to draw. The rule is per-session and
 * honest about idle: the first sample only sets the baselines and reads as
 * zero — no rate is known yet, and a session deep into its life must not flash
 * its lifetime average as if it were live. A poll whose generating time did
 * not advance means the session is not generating right now: it reads as zero
 * with the smoother untouched, so the next poll that does add generating time
 * resumes from the held smoothed figure rather than from zero. A backwards
 * counter rebaselines (baselines and smoother alike, since the pre-reset
 * average belongs to another era) and reads as zero. Otherwise the
 * instantaneous rate is the delta of generation tokens over the delta of
 * generating milliseconds, smoothed by the EWMA and held through the
 * hysteresis. Deltas between successive polls are the rate, so a pause can
 * never sag the figure — it reads as zero while it lasts.
 */
export function createInstantTps(alpha: number = TPS_EWMA_ALPHA) {
  let prevTokens: number | undefined;
  let prevGenMs: number | undefined;
  let smoothed: number | undefined;
  let displayed: number | undefined;

  return function sample(totalTokens: unknown, totalGenMs: unknown): number | undefined {
    const tokens = asCount(totalTokens);
    const genMs = asCount(totalGenMs);
    if (tokens === undefined || genMs === undefined) return displayed;

    // First sight sets the baselines. No rate is known yet — not even the
    // cumulative lifetime average, which would flash a whole session's history
    // as if it were live — so the row reads as zero until the next poll
    // brings a delta to divide.
    if (prevTokens === undefined || prevGenMs === undefined) {
      prevTokens = tokens;
      prevGenMs = genMs;
      return 0;
    }

    const deltaTokens = tokens - prevTokens;
    const deltaMs = genMs - prevGenMs;
    // Counters must not step backwards; a reset rebaselines - baselines and
    // smoother alike, since the pre-reset average belongs to another era -
    // instead of dividing a negative delta into a nonsense rate.
    if (deltaTokens < 0 || deltaMs < 0) {
      prevTokens = tokens;
      prevGenMs = genMs;
      smoothed = undefined;
      return 0;
    }
    prevTokens = tokens;
    prevGenMs = genMs;

    // No new generating time: the session is not generating right now, so the
    // rate is zero — and the smoother is left untouched, so the next poll that
    // does add generating time resumes from the held smoothed figure rather
    // than from zero.
    if (deltaMs <= 0) return 0;
    const instant = deltaTokens / (deltaMs / 1_000);
    smoothed = smoothTpsRate(smoothed, instant, alpha);
    if (tpsNeedsRepaint(displayed, smoothed)) displayed = smoothed;
    return displayed;
  };
}
