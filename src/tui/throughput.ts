// Session throughput: output tokens per second, measured over the active work
// the host actually recorded rather than over the wall clock.
//
// Pure: no clock, no I/O, no rendering. Untrusted sample fields are coerced
// through ./coerce.js so a garbage value is skipped rather than guessed at.
//
// Two rates live here. `sessionThroughput` is the whole-lifetime average, kept
// as the metric of last resort for a host that exposes no per-message
// timestamps. `unionSpanThroughput` is the active-work average: output tokens
// divided by the union of the assistant turns' own spans, so idle between turns
// is never in the denominator and the figure freezes once everything settles.

import { asCount, asText } from "./coerce.js";

/**
 * Overall session throughput: output tokens over the session's lifetime.
 *
 * Unlike the active-work average, this is the whole conversation's average, so
 * it includes every subagent and every pause. A just-started session is floored
 * at one second so it cannot divide by a sliver of time and flash an absurd
 * rate. Returns `undefined` when there is nothing to divide.
 */
export function sessionThroughput(outputTokens: unknown, elapsedMs: unknown): number | undefined {
  const output = asCount(outputTokens);
  const elapsed = asCount(elapsedMs);
  if (output === undefined || output <= 0) return undefined;
  if (elapsed === undefined || elapsed <= 0) return undefined;
  return output / (Math.max(elapsed, 1_000) / 1_000);
}

/**
 * One assistant turn's contribution to the active-work average.
 *
 * `key` is the turn's identity (see `turnKey`); `tokens` is its output count;
 * `start` and `end` are its span on the host's epoch clock. Every field is
 * untrusted and coerced before use.
 */
export interface ThroughputSpan {
  readonly key?: unknown;
  readonly tokens?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
}

/**
 * Resolve one assistant turn's span from its timestamp rungs.
 *
 * `start` is `time.created`. `end` is `time.completed`, else `time.streamed`,
 * else the caller's `nowMs` for a turn still in flight. A clock that steps
 * backwards is clamped to a zero-length span rather than a negative one, so
 * skew can never subtract time from the union. Returns `undefined` when there
 * is no usable start — the turn is skipped, never guessed at.
 */
export function turnSpan(
  created: unknown,
  completed: unknown,
  streamed: unknown,
  nowMs: unknown,
): { readonly start: number; readonly end: number } | undefined {
  const start = asCount(created);
  if (start === undefined) return undefined;
  const ended = asCount(completed) ?? asCount(streamed) ?? asCount(nowMs);
  if (ended === undefined) return undefined;
  return { start, end: Math.max(start, ended) };
}

/**
 * Identity of one assistant turn: the host's own message id when it carries
 * one, otherwise the tuple `(created, completed, output)` that defines the
 * record. Retries, replays and re-sent records share a key, so they contribute
 * their tokens once and their time once.
 */
export function turnKey(id: unknown, created: unknown, completed: unknown, output: unknown): string {
  const own = asText(id);
  if (own !== undefined) return `id:${own}`;
  return `t:${asCount(created) ?? "?"}:${asCount(completed) ?? "?"}:${asCount(output) ?? "?"}`;
}

/** Output tokens and wall time the accepted turns actually cover. */
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
 * turn with no usable token count contributes to neither side: the numerator
 * and the denominator always cover exactly the same turns.
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
    const output = asCount(span.tokens);
    if (start === undefined || end === undefined) continue;
    if (output === undefined || output <= 0) continue;

    seen.add(key);
    accepted.push({ start, end: Math.max(start, end) });
    tokens += output;
  }

  return { tokens, unionMs: mergedSpanMs(accepted) };
}

/**
 * The union length of distinct turn spans, with tokens ignored entirely.
 *
 * The same identity rule, clamp, pre-sort and merge as `unionSpanTotals`, but
 * a turn's output count never enters the decision: a zero-output turn still
 * took wall time and still contributes its span. This is what seeds `elapsed`,
 * which must not undercount real work the way a token-gated union would.
 * A missing key is skipped; the first-seen key wins; a span without a usable
 * start and end is skipped; `0` when nothing is usable.
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
 * Active-work throughput: output tokens of the scope divided by the union of
 * its active turn spans. Idle time between turns is not in the denominator, so
 * the figure stops moving once everything settles instead of decaying or
 * hiding. A turn still in flight ends at the caller's `now`, so the value keeps
 * climbing while work happens.
 *
 * Floored at one second, the same floor the lifetime average uses, so a sliver
 * of time cannot flash an absurd rate. Returns `undefined` when there is
 * nothing to divide — no positive output, or no span with positive length.
 */
export function unionSpanThroughput(spans: readonly ThroughputSpan[]): number | undefined {
  const { tokens, unionMs } = unionSpanTotals(spans);
  if (tokens <= 0 || unionMs <= 0) return undefined;
  return tokens / (Math.max(unionMs, 1_000) / 1_000);
}
