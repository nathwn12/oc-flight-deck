// Narrow-rail rendering: turn values into short strings and glyph strips.
//
// The sidebar is roughly thirty-odd columns wide, so every figure is shortened
// to something an agent can read in one glance: counts (`518k`), costs
// (`$0.023`), durations (`2h14m37s`), paths (clipped with an ellipsis), a
// ten-cell fuel gauge, and a sparkline shaped from recent turn sizes. All pure
// and dependency-free, so the formatting is trivial to test.

/** `518k`, `29.2M`, `32M`, `940` — short enough for a narrow rail, precise enough to read. */
export function formatCount(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  // Round *before* choosing the unit. Rounding only inside the `k` branch made
  // anything from 999,500 to 999,999 print as `1000k` — a number with two
  // magnitudes in it, and one an agent reads as a different size entirely.
  const thousands = Math.round(value / 1_000);
  if (thousands < 1_000) return `${thousands}k`;
  const millions = (value / 1_000_000).toFixed(1);
  return `${millions.endsWith(".0") ? millions.slice(0, -2) : millions}M`;
}

/** Sub-dollar sessions keep a third decimal so a cheap run never reads `$0.00`. */
export function formatCost(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

/** `45s`, `14m07s`, `2h14m37s`. Seconds always show, so the row ticks every second. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1_000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m${ss}s`;
  return minutes > 0 ? `${minutes}m${ss}s` : `${seconds}s`;
}

/** Fuel-gauge width in cells when the caller does not override it. */
export const DEFAULT_BAR_WIDTH = 10;

/** A ten-cell gauge, so a percentage is readable at a glance rather than parsed. */
export function fuelBar(ratio: number, width: number = DEFAULT_BAR_WIDTH): string {
  const cells = Math.max(1, Math.floor(width));
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Shorten a value for a narrow rail.
 *
 * The sidebar is roughly thirty-odd columns wide and the label already costs
 * ten, so a resource path has to be cut. The ellipsis is deliberate: a silently
 * truncated path reads as a complete one.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  // Never cut a surrogate pair in half: the orphaned half renders as a
  // replacement character, which reads as corruption rather than as a shortened
  // path. Losing one more column is the cheaper mistake.
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${safe}…`;
}

/**
 * Recent turn sizes as a shape.
 *
 * Scaled against the largest value in the window rather than an absolute scale,
 * so the sparkline stays readable whether turns are tiny or enormous.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (!Number.isFinite(max) || max <= 0) return SPARK_LEVELS[0].repeat(values.length);
  return values
    .map((value) => {
      const level = Math.floor((Math.max(0, value) / max) * (SPARK_LEVELS.length - 1));
      return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, level)];
    })
    .join("");
}