// Session throughput: output tokens per second, as a lifetime average or as a
// trailing-window rate.
//
// Pure and dependency-free: no clock, no I/O, no rendering. Untrusted sample
// fields are coerced here so a garbage value is skipped rather than guessed at.

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Overall session throughput: output tokens over the session's lifetime.
 *
 * Unlike a per-turn rate, this is the whole conversation's average, so it
 * includes every subagent and every pause. A just-started session is floored
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

/** Length of the trailing window, in milliseconds, that `windowedThroughput` measures. */
export const TPS_WINDOW_MS = 60_000;

/**
 * One assistant turn's contribution to a throughput window.
 *
 * Both fields are untrusted: `tokens` is the turn's output count and `at` is the
 * timestamp it finished at. Anything unusable is skipped rather than guessed at.
 */
export interface ThroughputSample {
  readonly tokens?: unknown;
  readonly at?: unknown;
}

/**
 * A trailing-window throughput rate: output tokens per second over the last
 * `windowMs`, measured from `nowMs`.
 *
 * The denominator is how much of the window the session has actually lived, so
 * a just-started session ramps up against its real age instead of being divided
 * by a full minute it has not run — floored at one second, the same floor the
 * lifetime average uses, so a sliver of time cannot flash an absurd rate. Once
 * the session is older than the window, it settles into a clean rolling minute.
 *
 * Returns `undefined` — the caller hides the row — unless at least one sample
 * carries a usable timestamp inside the window and a positive output count. An
 * idle session therefore reports no rate rather than a decaying one. The window
 * is inclusive at both ends (`start <= at <= now`) so a boundary sample counts.
 *
 * Pure and dependency-free: no clock, no I/O, no rendering.
 */
export function windowedThroughput(
  samples: readonly ThroughputSample[],
  nowMs: number,
  windowMs: number,
  sessionCreatedMs: number,
): number | undefined {
  if (!Number.isFinite(nowMs)) return undefined;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined;

  // An unusable creation time cannot tell us how long the session has lived, so
  // the whole window is assumed available rather than dropping the rate.
  const created = Number.isFinite(sessionCreatedMs) ? sessionCreatedMs : undefined;
  const alive = created === undefined ? windowMs : nowMs - created;
  const denominatorMs = Math.max(1_000, Math.min(windowMs, alive));

  const start = nowMs - windowMs;
  let output = 0;
  let sawOne = false;
  for (const sample of samples) {
    const at = asCount(sample.at);
    if (at === undefined || at < start || at > nowMs) continue;
    const tokens = asCount(sample.tokens);
    if (tokens === undefined || tokens <= 0) continue;
    output += tokens;
    sawOne = true;
  }

  if (!sawOne) return undefined;
  return output / (denominatorMs / 1_000);
}
