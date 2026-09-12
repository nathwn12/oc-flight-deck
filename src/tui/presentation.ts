// Plain-string views of the Flight Deck rail.
//
// Keeping the text layer pure makes it trivial to test, and leaves the JSX in
// index.tsx to do nothing but wrap these strings in themed <text> elements.
// The live rows come from ./stats.ts and are read-only: nothing here mutates
// session state, and nothing leaves the process.

import type { FlightDeckConfig } from "./config.js";
import { MAX_LINES } from "./config.js";
import { statRows, type StatSource } from "./stats.js";

/**
 * Sidebar lines to render, or an empty list when the sidebar rail is disabled.
 *
 * Configured `lines` render first (branding, separators, any fixed text), then
 * the live rows named by `sidebar.rows`, each included only once the host has
 * data for it.
 */
export function sidebarLines(config: FlightDeckConfig, source: StatSource = {}): readonly string[] {
  if (!config.sidebar.enabled) return [];
  return [...config.sidebar.lines, ...statRows(config.sidebar.rows, source, config.layout)].slice(0, MAX_LINES);
}

/** Footer text to render, or `undefined` when the footer rail is disabled. */
export function footerLine(config: FlightDeckConfig): string | undefined {
  return config.footer.enabled ? config.footer.text : undefined;
}

/** Index of the first live row, so the caller can theme branding apart from data. */
export function liveRowOffset(config: FlightDeckConfig): number {
  return config.sidebar.enabled ? config.sidebar.lines.length : 0;
}
