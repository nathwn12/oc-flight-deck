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

/**
 * How `formatDuration` joins its segments: `"compact"` hugs the units
 * (`2h14m37s`), `"spaced"` puts one space between them (`2h 14m 37s`).
 */
export type DurationStyle = "compact" | "spaced";

/**
 * `45s`, `14m07s`, `2h14m37s`; with `spaced`, one space between the segments
 * (`14m 07s`, `2h 14m 37s`). Seconds always show, so the row ticks every
 * second. Zero-padding is identical in both styles: minutes pad when hours are
 * present, seconds pad when minutes are present.
 *
 * The parameter default stays `"compact"`: this formatter's own contract is
 * unchanged for direct callers, while the rail's shipped default comes from
 * `format.duration` (spaced).
 */
export function formatDuration(ms: number, style: DurationStyle = "compact"): string {
  const total = Math.floor(ms / 1_000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  const ss = String(seconds).padStart(2, "0");
  // Only the join between segments differs; with `compact` the join is empty,
  // so that style stays byte-identical to what it has always rendered.
  const join = style === "spaced" ? " " : "";
  if (hours > 0) return `${hours}h${join}${String(minutes).padStart(2, "0")}m${join}${ss}s`;
  return minutes > 0 ? `${minutes}m${join}${ss}s` : `${seconds}s`;
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
 * Terminal cell width of one code point: East Asian wide/fullwidth ranges and
 * emoji take two cells, everything else one. Deliberately conservative - an
 * ambiguous or unknown character counts one, so the rail may clip slightly
 * early but can never overrun its column. Combines nothing: a combining mark
 * counts one for the same reason, since over-counting only ever clips earlier.
 */
function cellWidthOf(code: number): number {
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff) ||
    (code >= 0x1f000 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

/** The columns a string draws: its cell width, not its length. */
function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) width += cellWidthOf(char.codePointAt(0) ?? 0);
  return width;
}

/**
 * Shorten a value for a narrow rail.
 *
 * The sidebar is roughly thirty-odd columns wide and the label already costs
 * ten, so a resource path has to be cut. The ellipsis is deliberate: a silently
 * truncated path reads as a complete one. The budget is CELLS, not characters:
 * a CJK or emoji value that fits in characters can still draw twice as wide,
 * so the cut keeps the longest prefix of at most `max - 1` cells and reserves
 * the last cell for the ellipsis. Iterating by code point never splits a
 * surrogate pair, so the orphaned-half guard the length-based cut needed is
 * structurally gone.
 */
export function clip(text: string, max: number): string {
  const ellipsis = String.fromCharCode(0x2026);
  if (cellWidth(text) <= max) return text;
  const budget = max - 1;
  let kept = "";
  let width = 0;
  for (const char of text) {
    const next = width + cellWidthOf(char.codePointAt(0) ?? 0);
    // The first character is always kept, mirroring the old floor: a budget
    // below one cell still shortens rather than returning a bare ellipsis.
    if (kept !== "" && next > budget) break;
    kept += char;
    width = next;
  }
  return `${kept}${ellipsis}`;
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