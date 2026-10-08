// Session throughput: output and reasoning tokens per second, measured over the
// provider-active time the host actually recorded rather than over the wall
// clock.
//
// Pure: no clock, no I/O, no rendering. Untrusted sample fields are coerced
// through ./coerce.js so a garbage value is skipped rather than guessed at.
//
// Three rates live here. `sessionThroughput` is the whole-lifetime average, kept
// as the metric of last resort for a host that exposes no per-message
// timestamps. `unionSpanThroughput` is the active-work average: output plus
// reasoning tokens divided by the union of the assistant turns' own streaming
// spans, so idle and tool-settlement time is never in the denominator and the
// figure freezes once everything settles. `createInstantTps` is the live row's
// tracker: generation-token per-poll deltas over generating-time deltas, smoothed
// with an EWMA and repainted through hysteresis, so the rail shows what the
// decoder is doing now instead of everything the session ever did.

import { asCount, asText } from "./coerce.js";

/**
 * Overall session throughput: output plus reasoning tokens over the session's
 * lifetime.
 *
 * `tokens` is the same numerator the active-work average divides — a session
 * record's `tokens` is a `TokenUsage.Info`, so its `reasoning` rung is present
 * and belongs on this path too. Counting output alone would under-report a
 * thinking-heavy model and disagree with the row's stated definition.
 *
 * Unlike the active-work average, this is the whole conversation's average, so
 * it includes every subagent and every pause. A just-started session is floored
 * at one second so it cannot divide by a sliver of time and flash an absurd
 * rate. Returns `undefined` when there is nothing to divide.
 */
export function sessionThroughput(tokens: unknown, elapsedMs: unknown): number | undefined {
  const total = asCount(tokens);
  const elapsed = asCount(elapsedMs);
  if (total === undefined || total <= 0) return undefined;
  if (elapsed === undefined || elapsed <= 0) return undefined;
  return total / (Math.max(elapsed, 1_000) / 1_000);
}

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
 * Which recorded stamp ends an assistant turn's span when more than one is
 * present. The choice is the caller's, not the helper's: the two consumers want
 * different clocks off the same record.
 *
 * `"streamed"` ends at `time.streamed`, the moment the provider stopped
 * decoding - the official TUI's numerator clock, used by `tps`.
 * `"completed"` ends at `time.completed`, once the turn's tools have settled -
 * the busy clock, used by the `elapsed` seed.
 */
export type SpanEndPreference = "streamed" | "completed";

/**
 * Resolve one assistant turn's span from its timestamp rungs.
 *
 * `start` is `time.created`. `end` is the stamp `preference` names first when
 * both are recorded, else the other rung, else the caller's `nowMs` for a turn
 * still in flight. So `"streamed"` reads `streamed`, then `completed`;
 * `"completed"` reads `completed`, then `streamed`. A clock that steps backwards
 * is clamped to a zero-length span rather than a negative one, so skew can never
 * subtract time from the union. Returns `undefined` when there is no usable
 * start - the turn is skipped, never guessed at.
 */
export function turnSpan(
  created: unknown,
  completed: unknown,
  streamed: unknown,
  nowMs: unknown,
  preference: SpanEndPreference,
): { readonly start: number; readonly end: number } | undefined {
  const start = asCount(created);
  if (start === undefined) return undefined;
  const ended =
    preference === "streamed"
      ? asCount(streamed) ?? asCount(completed) ?? asCount(nowMs)
      : asCount(completed) ?? asCount(streamed) ?? asCount(nowMs);
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
 * Active-work throughput: output and reasoning tokens of the scope divided by
 * the union of its streaming turn spans. Idle time between turns and the
 * settlement after a turn are not in the denominator, so the figure stops moving
 * once everything settles instead of decaying or hiding. A turn still in flight
 * ends at the caller's `now`, so the value keeps climbing while work happens.
 *
 * Floored at one second, the same floor the lifetime average uses, so a sliver
 * of time cannot flash an absurd rate. Returns `undefined` when there is
 * nothing to divide — no positive tokens, or no span with positive length.
 */
export function unionSpanThroughput(spans: readonly ThroughputSpan[]): number | undefined {
  const { tokens, unionMs } = unionSpanTotals(spans);
  if (tokens <= 0 || unionMs <= 0) return undefined;
  return tokens / (Math.max(unionMs, 1_000) / 1_000);
}

/**
 * Smoothing weight for the instantaneous TPS rate: each new per-poll sample
 * moves the displayed figure 30% of the way toward it. Heavy enough to stop
 * the row flickering on every poll, light enough that a real speedup shows
 * within a few polls rather than sagging behind a lifetime average.
 */
export const TPS_EWMA_ALPHA = 0.3;

/**
 * Minimum generating time (ms) and output tokens before the TPS row draws
 * anything. Below either, a per-poll rate is one lucky sample over a sliver
 * of time - the exact "cheaty" flash the row used to print.
 */
export const TPS_MIN_GEN_MS = 2_000;
export const TPS_MIN_TOKENS = 10;

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
 * Only the live TPS path uses this. `unionOutputTotals` below stays as the
 * output-only twin, and `unionSpanTotals` (which feeds the other rows) is
 * unchanged.
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
 * Output tokens and generating time: the output-only twin of
 * `unionGenerationTotals`.
 *
 * The same identity rule, clamp, pre-sort and merge as `unionSpanTotals`, but
 * the numerator counts OUTPUT tokens only. The live TPS path no longer uses
 * this - it divides generation tokens (`unionGenerationTotals`) - so a
 * thinking-heavy turn reads as speed on that row rather than as time spent
 * with no output yet.
 */
export function unionOutputTotals(spans: readonly ThroughputSpan[]): SpanTotals {
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

    seen.add(key);
    accepted.push({ start, end: Math.max(start, end) });
    tokens += output ?? 0;
  }

  return { tokens, unionMs: mergedSpanMs(accepted) };
}

/**
 * Near-instantaneous generation rate for one displayed session scope.
 *
 * The caller feeds each poll's cumulative generation tokens and cumulative
 * generating milliseconds (streaming-span union, or the busy-gated active
 * clock - both exclude idle by construction) plus whether the scope is busy,
 * and gets back the figure to draw, or `undefined` while there is nothing
 * honest to show yet. Deltas between successive polls are the rate; the
 * EWMA smooths it; hysteresis holds the paint; the minimum sample hides the
 * row until ~2 s of generating time and ~10 tokens are on record; and a
 * non-busy poll freezes on the last figure without touching the baselines, so
 * idle can never dilute the rate - it only holds it.
 */
export function createInstantTps(alpha: number = TPS_EWMA_ALPHA) {
  let prevTokens: number | undefined;
  let prevGenMs: number | undefined;
  let smoothed: number | undefined;
  let displayed: number | undefined;

  return function sample(
    totalTokens: unknown,
    totalGenMs: unknown,
    busy: unknown,
  ): number | undefined {
    // Not busy means frozen: hold the last figure, baselines untouched, so
    // the idle stretch contributes nothing to either side of the next delta.
    if (busy === false) return displayed;

    const tokens = asCount(totalTokens);
    const genMs = asCount(totalGenMs);
    if (tokens === undefined || genMs === undefined) return displayed;

    // First sight sets the baselines. The cumulative active average seeds the
    // smoother, but only once the minimum sample is on record - before that
    // the row hides rather than flashing a one-sample rate.
    if (prevTokens === undefined || prevGenMs === undefined) {
      prevTokens = tokens;
      prevGenMs = genMs;
      if (tokens < TPS_MIN_TOKENS || genMs < TPS_MIN_GEN_MS) return displayed;
      smoothed = tokens / (genMs / 1_000);
      if (tpsNeedsRepaint(displayed, smoothed)) displayed = smoothed;
      return displayed;
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
      return displayed;
    }
    prevTokens = tokens;
    prevGenMs = genMs;

    if (tokens < TPS_MIN_TOKENS || genMs < TPS_MIN_GEN_MS) return displayed;
    // No new generating time: nothing was produced *in time*, so there is no
    // sample - hold, rather than dividing zero new tokens by zero new time.
    if (deltaMs <= 0) return displayed;
    const instant = deltaTokens / (deltaMs / 1_000);
    smoothed = smoothTpsRate(smoothed, instant, alpha);
    if (tpsNeedsRepaint(displayed, smoothed)) displayed = smoothed;
    return displayed;
  };
}
