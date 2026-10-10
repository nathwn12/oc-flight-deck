// The live Go usage panel for the sidebar footer slot.
//
// Three fixed lines - Rolling (5h), Weekly (1w), Monthly (1m) - drawn in the
// footer, below the rail's rows. The `go` ROW carries the same three windows on
// one line as quarter-fill dials (./rows.ts); the footer has the room for a bar
// each, so this panel reuses `fuelBar` and the same error tone to read as the
// same instrument, one size up. The glyphs are the `context` row's own, so the
// panel matches the rail exactly rather than inventing a second gauge.
//
// Pure, like ./go-usage.js: the clock arrives as `nowMs` and the usage as a
// value, so the panel is a function of its inputs and testable without a
// server, a store, or a frozen clock. `layout` is `unknown` on principle - it
// crosses the config boundary - so its geometry is re-read defensively instead
// of trusted from a type that may not match the caller.

import { asCount, asRecord } from "./coerce.js";
import { DEFAULT_BAR_WIDTH, fuelBar } from "./format.js";
import { formatRemaining, goTone, type GoUsage, type GoWindow } from "./go-usage.js";
import type { RailLine } from "./presentation.js";
import type { StatSegment } from "./rows.js";
import { DEFAULT_LABEL_WIDTH, DEFAULT_PLACEHOLDER } from "./stat-fields.js";
import type { StyleColor } from "./style.js";

/** The panel's three windows and their labels, in the canonical 5h -> 1w -> 1m order. */
const PANEL_WINDOWS: readonly { readonly id: GoWindow["id"]; readonly label: string }[] = [
  { id: "5h", label: "Rolling" },
  { id: "1w", label: "Weekly" },
  { id: "1m", label: "Monthly" },
];

/**
 * The label column plus its guaranteed separator.
 *
 * The exact rule ./rows.ts pads a live row's label with, repeated here because
 * the panel's lines carry no field of their own to reuse it through. It matters
 * only when `layout.labelWidth` is narrowed below a label's length ("Monthly"
 * is seven): `padEnd` then returns the label unchanged, and the separator is
 * what keeps the value from being glued onto it.
 */
function labelPrefix(label: string, labelWidth: number): string {
  return `${label.padEnd(labelWidth)}${label.length >= labelWidth ? " " : ""}`;
}

/**
 * The panel's geometry, re-read from an untrusted hint.
 *
 * A missing, malformed, or non-positive knob falls back to the rail's own
 * default, so a bad `layout` can change the width but never break a line.
 */
function readGeometry(layout: unknown): { readonly labelWidth: number; readonly barWidth: number } {
  const hint = asRecord(layout) ?? {};
  const labelWidth = Math.floor(asCount(hint["labelWidth"]) ?? DEFAULT_LABEL_WIDTH);
  const barWidth = Math.floor(asCount(hint["barWidth"]) ?? DEFAULT_BAR_WIDTH);
  return {
    labelWidth: labelWidth >= 1 ? labelWidth : DEFAULT_LABEL_WIDTH,
    barWidth: barWidth >= 1 ? barWidth : DEFAULT_BAR_WIDTH,
  };
}

/**
 * The usage's windows by id, re-validated at the boundary.
 *
 * The usage normally comes from the poll bridge, but it arrives through the
 * host's memory store and may be a hand-built source in a test, so the shape is
 * checked here rather than trusted from the declared type: an entry counts only
 * when its id is one of the three windows. The ratio is clamped into `[0, 1]`
 * as well as in ./rows.ts, so a source cannot fill a bar past full or print a
 * percent above 100. A window with no readable ratio is kept - it draws an
 * empty bar and the placeholder, which is the honest read of "no limit known" -
 * and a bad entry is dropped rather than throwing.
 */
function windowById(usage: GoUsage | undefined): Map<GoWindow["id"], GoWindow> {
  const byId = new Map<GoWindow["id"], GoWindow>();
  const list = asRecord(usage)?.["windows"];
  if (!Array.isArray(list)) return byId;

  for (const entry of list) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const id = record["id"];
    if (id !== "5h" && id !== "1w" && id !== "1m") continue;
    // First one wins: the canonical order is decided here, not by the payload.
    if (byId.has(id)) continue;

    const window: {
      -readonly [K in keyof GoWindow]: GoWindow[K];
    } = { id };
    const ratio = asCount(record["ratio"]);
    if (ratio !== undefined) window.ratio = Math.min(1, ratio);
    const resetAtMs = asCount(record["resetAtMs"]);
    if (resetAtMs !== undefined) window.resetAtMs = resetAtMs;
    const status = record["status"];
    if (typeof status === "string" && status !== "") window.status = status;
    byId.set(id, window);
  }
  return byId;
}

/**
 * The reset countdown for one window, or `undefined` when the reset is unknown
 * or already past.
 *
 * Deliberately not ./go-usage.js's `goResetSuffix`: that gates the hint on the
 * error tone, because on the one-line `go` row a hint beside a calm dial is
 * noise. This panel gives every window a line of its own, so the time to relief
 * is worth the columns on a calm one too - while a past reset is still omitted,
 * since it would read as a promise already broken.
 */
function resetCountdown(window: GoWindow, nowMs: number): string | undefined {
  const resetAtMs = window.resetAtMs;
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return undefined;
  const remaining = resetAtMs - nowMs;
  if (remaining <= 0) return undefined;
  // The separator is written as an escape so it is byte-identical to the one
  // ./go-usage.js's own reset suffix draws: the row and this panel must read the
  // same way.
  return ` \u00B7 ${formatRemaining(remaining)}`;
}

/**
 * One resting line: the label and a dim placeholder, for a window with no data
 * at all.
 *
 * The panel is fixed at three lines, so "no data yet" is three labelled lines
 * with the placeholder rather than a blank region - a blank panel would read as
 * "no Go account". The placeholder run is toned `subdued` explicitly so a
 * resting line stays dim even when `style.rows.go` is set bright: it is not a
 * value.
 */
function restingLine(label: string, labelWidth: number): RailLine {
  const segments: StatSegment[] = [
    { text: labelPrefix(label, labelWidth) },
    { text: DEFAULT_PLACEHOLDER, tone: "subdued" },
  ];
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}

/**
 * One drawn line: the label, a bar, the percent used, and the countdown.
 *
 * Only the bar, the number, and the countdown can take the error tone - the
 * label keeps the line's own colour, so a flagged window reads as this panel
 * with a problem rather than as a different kind of line. A window whose ratio
 * is unknown draws the placeholder for the number beside an empty bar: the
 * percent is the precision, and inventing one from a count with no limit is
 * exactly the confident guess the model refuses to make.
 */
function valueLine(
  label: string,
  labelWidth: number,
  barWidth: number,
  window: GoWindow,
  nowMs: number,
): RailLine {
  const tone: StyleColor | undefined = goTone(window) === "error" ? "error" : undefined;
  const ratio = window.ratio;
  const bar = fuelBar(ratio ?? 0, barWidth);
  const percent = ratio === undefined ? DEFAULT_PLACEHOLDER : `${Math.round(ratio * 100)}%`;

  const segments: StatSegment[] = [{ text: labelPrefix(label, labelWidth) }];
  const value = `${bar} ${percent}`;
  segments.push(tone === undefined ? { text: value } : { text: value, tone });
  const countdown = resetCountdown(window, nowMs);
  if (countdown !== undefined) {
    segments.push(tone === undefined ? { text: countdown } : { text: countdown, tone });
  }
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}

/**
 * The footer's Go usage panel: exactly three {@link RailLine}s, Rolling ->
 * Weekly -> Monthly, ready for the host's themed renderer.
 *
 * Never throws and never returns fewer than three lines - a panel that vanished
 * or took the footer slot down with it would be worse than one that says
 * nothing yet - so a missing, empty, or hostile usage payload degrades to the
 * same three labels with the resting placeholder.
 */
export function goPanelLines(
  usage: GoUsage | undefined,
  nowMs: number,
  layout?: unknown,
): readonly RailLine[] {
  try {
    const { labelWidth, barWidth } = readGeometry(layout);
    const windows = windowById(usage);
    return PANEL_WINDOWS.map(({ id, label }) => {
      const window = windows.get(id);
      return window === undefined
        ? restingLine(label, labelWidth)
        : valueLine(label, labelWidth, barWidth, window, nowMs);
    });
  } catch {
    // Belt and braces: the body above is defensive, but a renderer must never
    // be taken down by the panel, so any unexpected throw lands on the resting
    // placeholder - the same three lines, with no values.
    return PANEL_WINDOWS.map(({ label }) => restingLine(label, DEFAULT_LABEL_WIDTH));
  }
}
