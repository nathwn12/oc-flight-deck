/** Pure telemetry math. Invalid or unsupported measurements stay null. */

export interface StreamSample {
  readonly outputTokens: number;
  readonly at: number;
}

export interface StreamSnapshot {
  readonly totalOutputTokens: number;
  readonly lastTps: number | null;
  readonly ewmaTps: number | null;
  readonly lastIntervalMs: number | null;
  readonly usableIntervals: number;
  readonly unusableSamples: number;
}

export interface StreamMeter {
  observe(sample: StreamSample): number | null;
  snapshot(): StreamSnapshot;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function ewma(previous: number | null, value: number, alpha = 0.3): number | null {
  if (!finite(value) || !finite(alpha) || alpha <= 0 || alpha > 1) return previous;
  return previous === null ? value : alpha * value + (1 - alpha) * previous;
}

export function ttftMs(firstTokenAt: number | null | undefined, requestStartedAt: number | null | undefined): number | null {
  if (!finite(firstTokenAt) || !finite(requestStartedAt)) return null;
  const value = firstTokenAt - requestStartedAt;
  return value >= 0 ? value : null;
}

export function createStreamMeter(alpha = 0.3): StreamMeter {
  let previous: StreamSample | null = null;
  let lastTps: number | null = null;
  let smoothed: number | null = null;
  let interval: number | null = null;
  let usableIntervals = 0;
  let unusableSamples = 0;

  return {
    observe(sample) {
      if (!finite(sample.outputTokens) || sample.outputTokens < 0 || !finite(sample.at)) {
        unusableSamples++;
        return null;
      }
      if (!previous) {
        previous = sample;
        return null;
      }
      const elapsed = sample.at - previous.at;
      const delta = sample.outputTokens - previous.outputTokens;
      if (elapsed <= 0 || delta <= 0) {
        if (elapsed > 0) previous = sample;
        unusableSamples++;
        return null;
      }
      const tps = delta / (elapsed / 1000);
      previous = sample;
      lastTps = tps;
      smoothed = ewma(smoothed, tps, alpha);
      interval = elapsed;
      usableIntervals++;
      return tps;
    },
    snapshot() {
      return {
        totalOutputTokens: previous?.outputTokens ?? 0,
        lastTps,
        ewmaTps: smoothed,
        lastIntervalMs: interval,
        usableIntervals,
        unusableSamples,
      };
    },
  };
}
