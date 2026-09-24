// Plain-string and per-line views of the Flight Deck rail.
//
// Keeping the text layer pure makes it trivial to test, and leaves the JSX in
// index.tsx to do nothing but wrap these lines in themed <text> elements. The
// live rows come from ./stats.ts and are read-only: nothing here mutates
// session state, and nothing leaves the process.

import type { FlightDeckConfig } from "./config.js";
import { statLine, statRows, type StatSource } from "./stats.js";
import { rowStyle, type LineStyle, type StyleConfig } from "./style.js";

/**
 * One line of the rail, before it is themed.
 *
 * `field` names the live row (`cost`, `tps`, ...) and is absent on the fixed
 * branding lines. Carrying the name — rather than only "fixed or live" — is
 * what lets the caller resolve the row's style, wildcard fallback included,
 * without re-deriving which fields were drawn.
 */
export interface RailLine {
  readonly text: string;
  /** The live row's field name; absent on a fixed line. */
  readonly field?: string;
}

/**
 * The rail's lines in render order: the fixed lines first, then the live rows
 * named by `sidebar.rows`, together capped at `sidebar.maxLines`.
 *
 * With `sidebar.persist` (the default) every named row renders exactly once,
 * using `sidebar.placeholder` when the host has no data yet; with
 * `persist: false` rows with no data are omitted.
 */
export function railLines(config: FlightDeckConfig, source: StatSource = {}): readonly RailLine[] {
  if (!config.sidebar.enabled) return [];

  // The display side of the config, which the row renderer reads alongside its
  // geometry. `format` is a top-level section, so it is mapped here.
  const layout = {
    ...config.layout,
    persist: config.sidebar.persist,
    placeholder: config.sidebar.placeholder,
    durationStyle: config.format.duration,
    // Decided from the whole row list, the way `statRows` decides it: `cost`
    // folds the subagent total into itself only when no `total` row was asked
    // for, even if the cap later drops that row.
    hasTotalRow: config.sidebar.rows.includes("total"),
  };

  const lines: RailLine[] = config.sidebar.lines.map((text) => ({ text }));
  for (const field of config.sidebar.rows) {
    // `statLine` is the half that knows the field's name; persistence stays in
    // `statRows`, which turns a data-less known field into the placeholder.
    // For a row that rendered, the fallback is never reached.
    const text = statLine(field, source, layout) ?? statRows([field], source, layout)[0];
    if (text !== undefined) lines.push({ field, text });
  }

  return lines.slice(0, config.sidebar.maxLines);
}

/** The rail's lines as plain strings, in render order. */
export function sidebarTextLines(config: FlightDeckConfig, source: StatSource = {}): readonly string[] {
  return railLines(config, source).map((line) => line.text);
}

/**
 * The pre-style-layer name for {@link sidebarTextLines}.
 *
 * Kept as an alias while callers migrate to the rail-line view: the string
 * view is still the right one for tests and for anything that only wants the
 * text.
 */
export const sidebarLines = sidebarTextLines;

/** The resolved style for one line: fixed lines use `style.lines`, rows their own entry. */
export function railLineStyle(style: StyleConfig, line: RailLine): LineStyle {
  return line.field === undefined ? style.lines : rowStyle(style, line.field);
}

/** Footer text to render, or `undefined` when the footer rail is disabled. */
export function footerLine(config: FlightDeckConfig): string | undefined {
  return config.footer.enabled ? config.footer.text : undefined;
}
