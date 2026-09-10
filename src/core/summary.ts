export interface ValueSummary {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!finite(p) || p < 0 || p > 100 || sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
}

export function summarize(values: readonly number[]): ValueSummary {
  const valid = values.filter(finite);
  if (valid.length === 0) return { count: 0, min: null, max: null, mean: null, p50: null, p90: null, p99: null };
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return { count: valid.length, min, max, mean, p50: percentile(valid, 50), p90: percentile(valid, 90), p99: percentile(valid, 99) };
}

export interface RollingWindow<T> {
  push(value: T): void;
  values(): readonly T[];
  size(): number;
}

export function createRollingWindow<T>(maxItems = 256): RollingWindow<T> {
  const limit = Number.isInteger(maxItems) && maxItems > 0 ? maxItems : 256;
  const values: T[] = [];
  return {
    push(value) {
      values.push(value);
      if (values.length > limit) values.splice(0, values.length - limit);
    },
    values: () => [...values],
    size: () => values.length,
  };
}
