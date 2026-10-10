// The live Go usage panel for the sidebar footer slot.
//
// A designed instrument, not a data dump: one dim header naming the plan,
// then three fixed lines - ROLL (5h), WEEK (1w), MONTH (1m). Each line is a
// short uppercase label, a thin-rule meter, a right-aligned percent column
// and a dim reset countdown, so the footer reads as one gauge block.
//
// Pure, like ./go-usage.js: the clock arrives as `nowMs`, the animation phase
// as `frame`, and the usage and its no-data reason as values, so the panel is
// a function of its inputs and testable without a server, a store, or a
// frozen clock. There is no I/O, no timer and no hidden `Date.now()`.
// `layout` is `unknown` on principle - it crosses the config boundary - so
// its bar width is re-read defensively instead of trusted.
//
// Every glyph is written as a `\uXXXX` escape so this source stays ASCII
// whatever the write path does with it: U+25C8 is the header diamond, U+2501
// is the filled cell, U+2500 the track. The bar is capped so the longest line
// stays within the ~40-column sidebar and can never overflow or wrap.

import { asCount, asRecord } from "./coerce.js";
import { goTone, type GoUsage, type GoWindow } from "./go-usage.js";
import type { RailLine } from "./presentation.js";
import type { StatSegment } from "./rows.js";
import { DEFAULT_PLACEHOLDER } from "./stat-fields.js";
import type { StyleColor } from "./style.js";

/** The panel's three windows and their short labels, in canonical 5h -> 1w -> 1m order. */
const PANEL_WINDOWS: readonly { readonly id: GoWindow["id"]; readonly label: string }[] = [
  { id: "5h", label: "ROLL" },
  { id: "1w", label: "WEEK" },
  { id: "1m", label: "MONTH" },
];

/** U+25C8 BLACK DIAMOND CONTAINING WHITE SMALL DIAMOND: the header mark. */
const HEADER_GLYPH = "\u25C8";
/** U+2501 BOX DRAWINGS HEAVY HORIZONTAL: one filled cell of the progress bar. */
const FILLED = "\u2501";
/** U+2500 BOX DRAWINGS LIGHT HORIZONTAL: one track cell behind the fill. */
const TRACK = "\u2500";

/**
 * Fraction of a window at which the panel switches to the warning role.
 *
 * Between the error threshold (./go-usage.js's `GO_ERROR_RATIO`, 0.9) and the
 * midpoint: it warns while there is still headroom to act, without colouring
 * ordinary use. The error decision stays `goTone`'s, so the panel and the row
 * can never disagree about what "in trouble" means.
 */
export const GO_WARNING_RATIO = 0.6;

/** Width of the short label column: the longest label (`MONTH`) needs no more. */
const PANEL_LABEL_WIDTH = 5;
/** Bar width when the caller supplies no readable `layout.barWidth`. */
const PANEL_DEFAULT_BAR_WIDTH = 14;
/**
 * Widest bar that keeps the longest line within the sidebar.
 *
 * Longest line is leading space (1) + label (5) + gap (2) + bar + gap (2) +
 * percent (4) + gap (2) + countdown (`30d23h`, 6): `22 + bar`. At 18 the line
 * is exactly 40 columns, so anything wider is capped rather than wrapped.
 */
const PANEL_MAX_BAR_WIDTH = 18;
/** Width of the right-aligned percent column: `100%` is the widest value. */
const PERCENT_WIDTH = 4;

/**
 * One label cell: leading space, the label padded to the common width, and
 * the two-space gap before the meter.
 *
 * The leading space aligns the rows under the header's own leading space, so
 * the block reads as one instrument. The gap is fixed (not from
 * `layout.labelWidth`): the short labels need only five columns, and the
 * rail's ten would waste the sidebar and risk overflow.
 */
function labelCell(label: string): string {
  return ` ${label.padEnd(PANEL_LABEL_WIDTH)}  `;
}

/**
 * The panel's bar width, re-read from an untrusted hint.
 *
 * A missing, malformed, or non-positive knob falls back to the panel's own
 * default, and anything that would overflow the sidebar is capped, so a bad
 * `layout` can change the meter but never break or wrap a line.
 */
function readBarWidth(layout: unknown): number {
  const hint = asRecord(layout) ?? {};
  const raw = Math.floor(asCount(hint["barWidth"]) ?? PANEL_DEFAULT_BAR_WIDTH);
  const width = raw >= 1 ? raw : PANEL_DEFAULT_BAR_WIDTH;
  return Math.min(width, PANEL_MAX_BAR_WIDTH);
}

/**
 * The usage's windows by id, re-validated at the boundary.
 *
 * The usage normally comes from the poll bridge, but it arrives through the
 * host's memory store and may be a hand-built source in a test, so the shape
 * is checked here rather than trusted from the declared type: an entry counts
 * only when its id is one of the three windows. The ratio is clamped into
 * `[0, 1]` as well as in ./rows.ts, so a source cannot fill a bar past full
 * or print a percent above 100. A window with no readable ratio is kept - it
 * draws an empty bar and the placeholder, which is the honest read of "no
 * limit known" - and a bad entry is dropped rather than throwing.
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
 * A duration as one or two compact units: `45s`, `12m`, `2h`, `4h44m`, `1d6h`,
 * `30d23h`.
 *
 * Deliberately not ./go-usage.js's `formatRemaining`: that one is the one-line
 * `go` row's hint and stays single-unit. The panel has the columns for the
 * next unit down, and the next unit is what turns "4h" into something an agent
 * can plan against. Seconds are dropped once hours are on the clock - two
 * units is the whole budget - and a unit is omitted when it is zero, so an
 * exact `2h` reads `2h` rather than `2h0m`.
 *
 * The sub-hour branches round up (as the row's hint does), so a countdown
 * never understates the wait: 90s reads `2m`, not `1m30s`.
 */
export function formatCompactRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(ms / 3_600_000);
  if (totalHours < 24) {
    // Just under the hour: `totalMinutes` is 60 and the hours place is empty,
    // so name the minutes rather than print a hollow `0h59m`.
    if (totalHours === 0) return `${totalMinutes}m`;
    const minutes = Math.floor((ms - totalHours * 3_600_000) / 60_000);
    return minutes > 0 ? `${totalHours}h${minutes}m` : `${totalHours}h`;
  }
  const totalDays = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms - totalDays * 86_400_000) / 3_600_000);
  return hours > 0 ? `${totalDays}d${hours}h` : `${totalDays}d`;
}

/**
 * The reset countdown for one window, or `undefined` when the reset is unknown
 * or already past.
 *
 * Just the compact time (`4h44m`): the column gap before it is the separator,
 * so no dot is drawn. A past reset is omitted, since it would read as a
 * promise already broken.
 */
function resetCountdown(window: GoWindow, nowMs: number): string | undefined {
  const resetAtMs = window.resetAtMs;
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return undefined;
  const remaining = resetAtMs - nowMs;
  if (remaining <= 0) return undefined;
  return formatCompactRemaining(remaining);
}

/**
 * The colour role a window's meter and percent draw in.
 *
 * `goTone` owns the error decision (>= 90% or a non-benign status), so the
 * panel cannot disagree with the row; the warning band above
 * {@link GO_WARNING_RATIO} is the panel's own, and everything below keeps the
 * row's own colour (`undefined`, which the renderer inherits). The countdown
 * stays dim regardless: it is relief, not severity.
 */
function panelTone(window: GoWindow): StyleColor | undefined {
  if (goTone(window) === "error") return "error";
  const ratio = window.ratio;
  if (ratio !== undefined && ratio >= GO_WARNING_RATIO) return "warning";
  return undefined;
}

/**
 * The frame the sweep reads, or `undefined` when there is no live animation.
 *
 * A missing, non-finite or negative frame means the ticker is not running, and
 * the bar is drawn static: the sweep is motion, and inventing one from a
 * broken phase would be a lie.
 */
function readFrame(frame: unknown): number | undefined {
  return typeof frame === "number" && Number.isFinite(frame) && frame >= 0 ? Math.floor(frame) : undefined;
}

/**
 * The index of the bright cell within the filled region, or `-1` for no sweep.
 *
 * Sweeping only makes sense over a non-empty fill, so a 0% window is static.
 * The modulo keeps the cell inside `[0, filled)` for any frame, including a
 * frame the host advanced past the bar's width.
 */
function sweepIndex(frame: number | undefined, filled: number): number {
  if (frame === undefined || filled <= 0) return -1;
  return frame % filled;
}

/**
 * Append one run to the line, merging it with the previous run when the colour
 * role is the same. Merging is what keeps a uniform bar (or an all-error
 * line) as one coloured span rather than one span per cell, so the renderer is
 * handed a handful of runs, not `barWidth` of them.
 */
function appendRun(runs: StatSegment[], text: string, tone: StyleColor | undefined): void {
  if (text === "") return;
  const last = runs[runs.length - 1];
  if (last !== undefined && (last.tone ?? undefined) === tone) {
    runs[runs.length - 1] = tone === undefined ? { text: last.text + text } : { text: last.text + text, tone };
    return;
  }
  runs.push(tone === undefined ? { text } : { text, tone });
}

/**
 * The reason tag, re-validated at the untrusted boundary.
 *
 * The reason comes from the bridge (or is the caller's `"no-bridge"`), so it
 * is one of our own short tokens; anything else - a long string, whitespace,
 * a control character - is dropped rather than rendered into the panel.
 */
function readReason(reason: unknown): string | undefined {
  return typeof reason === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(reason) ? reason : undefined;
}

/**
 * The dim header naming the plan: a small diamond plus the label.
 *
 * Drawn once, above the three meters, in `subdued` so it frames the block
 * without competing with a flagged meter. It carries the `go` field so the
 * footer resolves the same row style the inline `go` row does.
 */
function headerLine(): RailLine {
  const text = ` ${HEADER_GLYPH} OPENCODE GO`;
  return { field: "go", text, segments: [{ text, tone: "subdued" }] };
}

/**
 * One resting line: the label, the empty track, and the placeholder - plus a
 * dim reason tag when the caller knows why there is no data.
 *
 * The tag sits IMMEDIATELY after the label, before the track, and the track
 * is shortened by the tag's width so the line never grows past the meter
 * column and the tag can never be clipped off the sidebar's edge. The track
 * is kept even with no data, so the panel's shape never jumps between
 * "waiting" and "reading": the meter column is always there. The percent
 * placeholder is right-aligned into the same column the values use, so a
 * resting line and a reading line share one grid. Everything past the label
 * is toned `subdued` explicitly so a resting line stays dim even when
 * `style.rows.go` is set bright - none of it is a value.
 */
function restingLine(label: string, barWidth: number, reason: string | undefined): RailLine {
  const cells = Math.max(1, Math.floor(barWidth));
  const segments: StatSegment[] = [{ text: labelCell(label) }];
  let trackCells = cells;
  if (reason !== undefined) {
    segments.push({ text: `${reason} `, tone: "subdued" });
    trackCells = Math.max(0, cells - reason.length - 1);
  }
  const tail = `${TRACK.repeat(trackCells)}  ${DEFAULT_PLACEHOLDER.padStart(PERCENT_WIDTH)}`;
  segments.push({ text: tail, tone: "subdued" });
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}

/**
 * One drawn line: the label, a thin-rule meter, the right-aligned percent,
 * and the dim countdown.
 *
 * The meter is `FILLED` over `TRACK`, with one brighter cell (`default`, the
 * theme's primary text colour) sweeping across the filled region when a live
 * frame is supplied. Only the meter and the percent can take the window's
 * tone - the label keeps the line's own colour and the countdown stays dim,
 * so a flagged window reads as this panel with a problem rather than as a
 * different kind of line. A window whose ratio is unknown draws the
 * placeholder for the number beside an empty meter: the percent is the
 * precision, and inventing one from a count with no limit is exactly the
 * confident guess the model refuses to make.
 */
function valueLine(
  label: string,
  barWidth: number,
  window: GoWindow,
  nowMs: number,
  frame: number | undefined,
): RailLine {
  const tone = panelTone(window);
  const ratio = window.ratio;
  const cells = Math.max(1, Math.floor(barWidth));
  const filled = Math.max(0, Math.min(cells, Math.round((ratio ?? 0) * cells)));
  const sweep = sweepIndex(frame, filled);

  const runs: StatSegment[] = [];
  for (let index = 0; index < filled; index += 1) {
    appendRun(runs, FILLED, index === sweep ? "default" : tone);
  }
  for (let index = filled; index < cells; index += 1) {
    appendRun(runs, TRACK, tone);
  }
  const percent = ratio === undefined ? DEFAULT_PLACEHOLDER : `${Math.round(ratio * 100)}%`;
  // The percent joins the meter's trailing run so a uniform meter stays one
  // span; the countdown is its own dim run (relief, not severity).
  appendRun(runs, `  ${percent.padStart(PERCENT_WIDTH)}`, tone);

  const segments: StatSegment[] = [{ text: labelCell(label) }, ...runs];
  const countdown = resetCountdown(window, nowMs);
  if (countdown !== undefined) {
    segments.push({ text: `  ${countdown}`, tone: "subdued" });
  }
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}

/**
 * The footer's Go usage panel: a dim header plus exactly three
 * {@link RailLine}s, ROLL -> WEEK -> MONTH, ready for the host's themed
 * renderer.
 *
 * Never throws and never returns fewer than four lines - a panel that
 * vanished or took the footer slot down with it would be worse than one that
 * says nothing yet - so a missing, empty, or hostile usage payload degrades
 * to the header plus the same three labels with the resting placeholder.
 *
 * `frame` is the host ticker's counter, passed in rather than read here so
 * the panel stays pure; `reason` names why there is no data (a ./go.js
 * `GoNoDataReason`, or the caller's `"no-bridge"`) and is drawn once, on the
 * first meter line, only when the whole panel is empty.
 */
export function goPanelLines(
  usage: GoUsage | undefined,
  nowMs: number,
  layout?: unknown,
  frame?: number,
  reason?: unknown,
): readonly RailLine[] {
  try {
    const barWidth = readBarWidth(layout);
    const windows = windowById(usage);
    // The reason explains the whole panel, so it is only meaningful when no
    // window rendered at all, and it is tagged once rather than three times.
    const tag = windows.size === 0 ? readReason(reason) : undefined;
    const sweepFrame = readFrame(frame);
    const head = headerLine();
    const rows = PANEL_WINDOWS.map(({ id, label }, index) => {
      const window = windows.get(id);
      return window === undefined
        ? restingLine(label, barWidth, index === 0 ? tag : undefined)
        : valueLine(label, barWidth, window, nowMs, sweepFrame);
    });
    return [head, ...rows];
  } catch {
    // Belt and braces: the body above is defensive, but a renderer must never
    // be taken down by the panel, so any unexpected throw lands on the resting
    // placeholder - the same header plus three lines, with no values.
    const fallback = readBarWidth(undefined);
    return [
      headerLine(),
      ...PANEL_WINDOWS.map(({ label }) => restingLine(label, fallback, undefined)),
    ];
  }
}
