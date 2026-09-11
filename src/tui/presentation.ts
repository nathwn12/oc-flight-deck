// Plain-string views of the cosmetic rail.
//
// Keeping the text layer pure makes it trivial to test, and leaves the JSX in
// index.tsx to do nothing but wrap these strings in themed <text> elements.
// There is no telemetry, server state, or live data here.

import type { FlightDeckConfig } from "./config.js";

/** Sidebar lines to render, or an empty list when the sidebar rail is disabled. */
export function sidebarLines(config: FlightDeckConfig): readonly string[] {
  return config.sidebar.enabled ? config.sidebar.lines : [];
}

/** Footer text to render, or `undefined` when the footer rail is disabled. */
export function footerLine(config: FlightDeckConfig): string | undefined {
  return config.footer.enabled ? config.footer.text : undefined;
}
