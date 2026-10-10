// The live Go usage panel for the sidebar footer slot.
//
// A designed instrument, not a data dump: three fixed lines - rolling (5h),
// weekly (1w), monthly (1m) - plus an opt-in dim header naming the plan. Each
// line is a strict fixed-width column layout - a breathing mark, a
// left-aligned label, a thin-rule meter, a percent cell and a reset
// countdown cell - separated by single spaces, so all three
// rows share one axis and the bar's start and end never wander between rows.
// The two trailing cells keep their widths; `align` moves each value inside
// its own cell, defaulting to the right edge.
//
// Pure, like ./go-usage.js: the clock arrives as `nowMs`, the animation phase
// as `frame`, and the usage and its no-data reason as values, so the panel is
// a function of its inputs and testable without a server, a store, or a
// frozen clock. There is no I/O, no timer and no hidden `Date.now()`.
// `layout` is `unknown` on principle - it crosses the config boundary - so
// its look is re-read defensively instead of trusted.
//
// Every glyph is written as a `\uXXXX` escape or a `String.fromCharCode`
// so this source stays ASCII whatever the write path does with it: U+25C8 is
// the header diamond, U+2500 is the meter's single cell - fill and track
// alike, told apart by tone alone so the bar's right edge can never drift
// row to row the way two different advance widths would - and
// U+25CB/U+25CE/U+25CF are the breathing mark's rest/swell/live rings. The
// bar is capped so the longest line stays within the ~40-column sidebar and
// can never overflow or wrap.

import { asCount, asRecord } from "./coerce.js";
import { goTone, type GoUsage, type GoWindow } from "./go-usage.js";
import type { RailLine } from "./presentation.js";
import type { StatSegment } from "./rows.js";
import { DEFAULT_PLACEHOLDER } from "./stat-fields.js";
import type { StyleColor } from "./style.js";

/** The panel's three windows, in canonical 5h -> 1w -> 1m order. Labels live in the look. */
const PANEL_WINDOWS: readonly GoWindow["id"][] = ["5h", "1w", "1m"];

/** Default labels by wire name: lowercase signature look. */
export const PANEL_DEFAULT_LABELS = {
  rolling: "rolling",
  weekly: "weekly",
  monthly: "monthly",
} as const;

/** One label per window id. */
export interface GoPanelLabels {
  readonly rolling: string;
  readonly weekly: string;
  readonly monthly: string;
}

function labelKeyFor(id: GoWindow["id"]): keyof GoPanelLabels {
  if (id === "5h") return "rolling";
  if (id === "1w") return "weekly";
  return "monthly";
}

/** U+25C8 BLACK DIAMOND CONTAINING WHITE SMALL DIAMOND: the header mark. */
const HEADER_GLYPH = "\u25C8";
/** U+25CB WHITE CIRCLE, U+25CE BULLSEYE, U+25CF BLACK CIRCLE: the breathing mark. */
const MARK_REST = String.fromCharCode(0x25cb);
const MARK_MID = String.fromCharCode(0x25ce);
const MARK_LIVE = String.fromCharCode(0x25cf);
/** One slow breath: rest -> swell -> live -> swell, stepping once per `blinkMs`. */
const MARK_FRAMES: readonly string[] = [MARK_REST, MARK_MID, MARK_LIVE, MARK_MID];
/** Cells the mark column occupies: the glyph plus one space. */
const MARK_WIDTH = 2;
/**
 * U+2500 BOX DRAWINGS LIGHT HORIZONTAL: the panel's one and only meter cell.
 *
 * Fill and track are the SAME glyph - the fill draws bright (the window's
 * tone, or the theme's primary text when calm) and the track draws dim
 * (`subdued`), so the two never differ in advance width and every row's right
 * edge lands on the same pixel. The light line is the panel's existing
 * aesthetic; the contrast that the heavy fill used to carry now lives in the
 * tone alone.
 */
const CELL = "\u2500";
/**
 * The sweep highlight's tone: the travelling cell over the fill.
 *
 * `default` would vanish into a calm fill - the calm fill IS the theme's
 * primary text - so the highlight is the neutral `info` tint instead, which
 * stays visible over a bright, warning, or error fill alike.
 */
const SWEEP_TONE: StyleColor = "info";

/**
 * Fraction of a window at which the panel switches to the warning role.
 *
 * Between the error threshold (./go-usage.js's `GO_ERROR_RATIO`, 0.9) and the
 * midpoint: it warns while there is still headroom to act, without colouring
 * ordinary use. The error decision stays `goTone`'s, so the panel and the row
 * can never disagree about what "in trouble" means.
 */
export const GO_WARNING_RATIO = 0.6;

/** Bar width when the caller supplies no readable `layout.barWidth`. */
export const PANEL_DEFAULT_BAR_WIDTH = 10;
/** Label width when the caller supplies no readable `layout.labelWidth`. */
export const PANEL_DEFAULT_LABEL_WIDTH = 6;
/** Whether the breathing mark draws when the caller says nothing. */
export const PANEL_DEFAULT_BLINK = true;
/** Milliseconds per breath step when the caller supplies no readable `layout.blinkMs`. */
export const PANEL_DEFAULT_BLINK_MS = 700;
/** Slowest breath the panel honours; slower would read as stuck. */
const PANEL_MIN_BLINK_MS = 200;
/** Fastest breath the panel honours; faster would read as flicker. */
const PANEL_MAX_BLINK_MS = 5000;
/** Longest rename the panel honours per label; longer would eat the sidebar. */
const PANEL_MAX_LABEL_LENGTH = 24;
/** Whether the header draws when the caller says nothing. */
export const PANEL_DEFAULT_HEADER = false;
/** Whether the percent column draws when the caller says nothing. */
export const PANEL_DEFAULT_PERCENT = true;
/** Whether the reset column draws when the caller says nothing. */
export const PANEL_DEFAULT_RESET = true;
/**
 * Where a trailing value sits inside its fixed-width cell when the caller
 * says nothing: pinned to the cell's right edge.
 */
export const PANEL_DEFAULT_ALIGN = "right" as const;
/**
 * Whether the sweep may move when the caller says nothing.
 *
 * Off: the meter is static and changes only when the percentage itself
 * changes. Opt in with `sweep: true` for the travelling highlight.
 */
export const PANEL_DEFAULT_SWEEP = false;
/** Width of the right-aligned percent column: `100%` is the widest value. */
export const PANEL_PERCENT_WIDTH = 4;
/** Width of the right-aligned reset column: `30d21h` is the widest usual value. */
export const PANEL_RESET_WIDTH = 6;
/** The sidebar width budget: no line may draw past it. */
export const PANEL_SIDEBAR_BUDGET = 40;
/** Narrowest label column the panel honours; shorter would misalign the grid. */
const PANEL_MIN_LABEL_WIDTH = 5;
/** Widest label column the panel honours; wider would eat the sidebar. */
const PANEL_MAX_LABEL_WIDTH = 24;
/** Widest bar the config may name before the sidebar cap applies. */
const PANEL_MAX_NAMED_BAR_WIDTH = 40;

/** The panel's look, re-read from an untrusted hint. */
interface PanelLook {
  readonly header: boolean;
  readonly barWidth: number;
  readonly labelWidth: number;
  readonly showPercent: boolean;
  readonly showReset: boolean;
  readonly align: "left" | "right" | "center";
  readonly sweep: boolean;
  readonly labels: GoPanelLabels;
  readonly blink: boolean;
  readonly blinkMs: number;
}

function readLookFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * One trailing value inside its fixed-width cell.
 *
 * The width never moves - only the value does. `right` pins it to the cell's
 * right edge so digits stay put as values change length; `left` hugs the bar
 * with the padding trailing; `center` splits the padding, the odd cell going
 * right. A value already at or past the width is returned as-is.
 */
function alignCell(value: string, width: number, align: PanelLook["align"]): string {
  if (value.length >= width) return value;
  const padding = width - value.length;
  if (align === "left") return value + " ".repeat(padding);
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return " ".repeat(left) + value + " ".repeat(padding - left);
  }
  return " ".repeat(padding) + value;
}

/**
 * One label column: the label left-aligned to the common width.
 *
 * The single space AFTER it is the column separator, so every row's meter
 * starts on the same axis regardless of label length.
 */
function labelField(label: string, labelWidth: number): string {
  return label.padEnd(labelWidth);
}

/**
 * One rename, re-read from an untrusted hint.
 *
 * A non-string, an empty string, or a rename longer than the widest label
 * column falls back to the default: a rename must never overflow or wrap the
 * sidebar, and the auto-widen below can only grow to what fits.
 */
function readLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (text.length === 0 || text.length > PANEL_MAX_LABEL_LENGTH) return fallback;
  return text;
}

/** The three renames, each falling back per-key to its default. */
function readLabels(layout: unknown): GoPanelLabels {
  const hint = asRecord(asRecord(layout)?.["labels"]) ?? {};
  return {
    rolling: readLabel(hint["rolling"], PANEL_DEFAULT_LABELS.rolling),
    weekly: readLabel(hint["weekly"], PANEL_DEFAULT_LABELS.weekly),
    monthly: readLabel(hint["monthly"], PANEL_DEFAULT_LABELS.monthly),
  };
}

/**
 * The breath step for one wall-clock instant: one ring per `blinkMs`,
 * cycling rest -> swell -> live -> swell.
 *
 * Indexed from `nowMs`, never from the ticker frame, so the breath keeps its
 * own cadence whatever the ticker's period is. A broken clock reads as the
 * rest ring, never a throw.
 */
function markIndex(nowMs: number, blinkMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(blinkMs) || blinkMs <= 0) return 0;
  const step = Math.floor(nowMs / blinkMs) % MARK_FRAMES.length;
  return ((step % MARK_FRAMES.length) + MARK_FRAMES.length) % MARK_FRAMES.length;
}

/**
 * The mark's tone at one breath step: dim at the rest ring, normal at the
 * live dot, so the pulse reads in monochrome. The swell rings stay dim with
 * the rest - only the live dot lights.
 */
function markToneAt(index: number): StyleColor | undefined {
  return index === 2 ? undefined : "subdued";
}

/**
 * The panel's look, re-read from an untrusted hint.
 *
 * A missing, malformed, or out-of-range knob falls back to the panel's own
 * default, and the bar is capped so the longest line - mark plus label plus
 * meter plus the enabled columns - stays within the sidebar, so a bad
 * `layout` can change the look but never break or wrap a line. The label
 * column auto-widens past the configured width to hold the longest rendered
 * rename, so a rename can never overflow its column.
 */
function readLook(layout: unknown): PanelLook {
  const hint = asRecord(layout) ?? {};
  const header = readLookFlag(hint["header"], PANEL_DEFAULT_HEADER);
  const showPercent = readLookFlag(hint["percent"], PANEL_DEFAULT_PERCENT);
  const showReset = readLookFlag(hint["reset"], PANEL_DEFAULT_RESET);
  const rawAlign = hint["align"];
  const align: PanelLook["align"] =
    rawAlign === "left" || rawAlign === "right" || rawAlign === "center" ? rawAlign : PANEL_DEFAULT_ALIGN;
  const sweep = readLookFlag(hint["sweep"], PANEL_DEFAULT_SWEEP);
  const rawLabel = hint["labelWidth"];
  const flooredLabel = rawLabel === undefined ? undefined : Math.floor(asCount(rawLabel) ?? Number.NaN);
  const configuredLabelWidth =
    flooredLabel !== undefined &&
    Number.isFinite(flooredLabel) &&
    flooredLabel >= PANEL_MIN_LABEL_WIDTH &&
    flooredLabel <= PANEL_MAX_LABEL_WIDTH
      ? flooredLabel
      : PANEL_DEFAULT_LABEL_WIDTH;
  const labels = readLabels(layout);
  // Auto-align: the column holds the longest rendered rename, never less
  // than the configured width. A rename can widen the column but never
  // overflow or wrap it.
  const longestLabel = Math.max(labels.rolling.length, labels.weekly.length, labels.monthly.length);
  const labelWidth = Math.max(configuredLabelWidth, longestLabel);
  const blink = readLookFlag(hint["blink"], PANEL_DEFAULT_BLINK);
  const rawBlinkMs = hint["blinkMs"];
  const flooredBlinkMs = rawBlinkMs === undefined ? undefined : Math.floor(asCount(rawBlinkMs) ?? Number.NaN);
  const blinkMs =
    flooredBlinkMs !== undefined &&
    Number.isFinite(flooredBlinkMs) &&
    flooredBlinkMs >= PANEL_MIN_BLINK_MS &&
    flooredBlinkMs <= PANEL_MAX_BLINK_MS
      ? flooredBlinkMs
      : PANEL_DEFAULT_BLINK_MS;
  const rawBar = hint["barWidth"];
  const flooredBar = rawBar === undefined ? undefined : Math.floor(asCount(rawBar) ?? Number.NaN);
  const namedBar =
    flooredBar !== undefined && Number.isFinite(flooredBar) && flooredBar >= 1
      ? Math.min(flooredBar, PANEL_MAX_NAMED_BAR_WIDTH)
      : PANEL_DEFAULT_BAR_WIDTH;
  // Longest line is mark? + label + separator + bar + (separator + percent)? +
  // (separator + reset)?: every separator is one space, and the mark column
  // is two cells (the glyph plus one space) drawn only when blink is on.
  const markWidth = blink ? MARK_WIDTH : 0;
  const fixed =
    markWidth + labelWidth + 1 + (showPercent ? 1 + PANEL_PERCENT_WIDTH : 0) + (showReset ? 1 + PANEL_RESET_WIDTH : 0);
  const maxBar = Math.max(1, PANEL_SIDEBAR_BUDGET - fixed);
  return { header, barWidth: Math.min(namedBar, maxBar), labelWidth, showPercent, showReset, align, sweep, labels, blink, blinkMs };
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
 * Sweeping only makes sense over a non-empty fill when the caller opted in, so
 * a static panel (`sweep: false`, the default) or a 0% window is never given a
 * bright cell. The modulo keeps the cell inside `[0, filled)` for any frame,
 * including a frame the host advanced past the bar's width.
 */
function sweepIndex(frame: number | undefined, filled: number, sweep: boolean): number {
  if (!sweep || frame === undefined || filled <= 0) return -1;
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
 * Drawn only when the caller opts in with `header: true`, above the three
 * meters, in `subdued` so it frames the block without competing with a flagged
 * meter. It carries the `go` field so the footer resolves the same row style
 * the inline `go` row does.
 */
function headerLine(): RailLine {
  const text = ` ${HEADER_GLYPH} OPENCODE GO`;
  return { field: "go", text, segments: [{ text, tone: "subdued" }] };
}

/**
 * The mark column's cells for one row: the breathing glyph plus one space on
 * the first meter line, two spaces on every other line so all three rows share
 * one axis, and nothing at all when blink is off.
 *
 * The glyph steps rest -> swell -> live -> swell once per `blinkMs`, indexed
 * from the wall clock (`nowMs`), so the breath is independent of the ticker
 * period. Only this column breathes: the meter stays static and changes only
 * when the percentage itself changes.
 */
function markField(look: PanelLook, nowMs: number, isFirst: boolean): StatSegment | undefined {
  if (!look.blink) return undefined;
  if (!isFirst) return { text: "  " };
  const index = markIndex(nowMs, look.blinkMs);
  const text = `${MARK_FRAMES[index] ?? MARK_REST} `;
  const tone = markToneAt(index);
  return tone === undefined ? { text } : { text, tone };
}

/**
 * One resting line: the label, the empty track, and the placeholder - plus a
 * dim reason tag when the caller knows why there is no data.
 *
 * Every column is fixed-width and separated by one space, so a resting line
 * and a reading line share one grid. The tag sits IMMEDIATELY after the
 * label's separator, before the track, and the track is shortened by the tag's
 * width so the line never grows past the meter column and the tag can never be
 * clipped off the sidebar's edge. The track is kept even with no data, so the
 * panel's shape never jumps between "waiting" and "reading": the meter column
 * is always there. Everything past the label is toned `subdued` explicitly so
 * a resting line stays dim even when `style.rows.go` is set bright - none of
 * it is a value.
 */
function restingLine(
  label: string,
  look: PanelLook,
  reason: string | undefined,
  nowMs: number,
  isFirst: boolean,
): RailLine {
  const cells = Math.max(1, Math.floor(look.barWidth));
  const segments: StatSegment[] = [];
  const mark = markField(look, nowMs, isFirst);
  if (mark !== undefined) segments.push(mark);
  segments.push({ text: `${labelField(label, look.labelWidth)} ` });
  let trackCells = cells;
  if (reason !== undefined) {
    segments.push({ text: `${reason} `, tone: "subdued" });
    trackCells = Math.max(0, cells - reason.length - 1);
  }
  const tail =
    CELL.repeat(trackCells) +
    (look.showPercent ? ` ${alignCell(DEFAULT_PLACEHOLDER, PANEL_PERCENT_WIDTH, look.align)}` : "");
  segments.push({ text: tail, tone: "subdued" });
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}

/**
 * One drawn line: the label, a single-glyph meter, the percent cell, and the
 * dim countdown cell.
 *
 * Columns are fixed-width with one space between them: the label is
 * left-aligned to `labelWidth`, the meter is exactly `barWidth` cells of
 * `CELL` - the fill bright (the window's tone, or the theme's primary text
 * when calm) over a `subdued` track - the percent is 4 wide and the reset 6,
 * so the percent and the countdown sit on a shared axis on every row. `align`
 * moves each trailing value inside its own cell without moving the axis.
 * The meter carries one highlight cell (`info`, so it stays visible over a
 * bright, warning, or error fill) sweeping across the filled region only when
 * the caller opts in with `sweep: true` and supplies a live frame; by default
 * the bar is static and changes only when the percentage itself changes. Only the meter and the
 * percent can take the window's tone - the label keeps the line's own colour
 * and the countdown stays dim, so a flagged window reads as this panel with a
 * problem rather than as a different kind of line. A window whose ratio is
 * unknown draws the placeholder for the number beside an empty meter: the
 * percent is the precision, and inventing one from a count with no limit is
 * exactly the confident guess the model refuses to make. Disabled columns are
 * omitted entirely, never left as a gap.
 */
function valueLine(
  label: string,
  look: PanelLook,
  window: GoWindow,
  nowMs: number,
  frame: number | undefined,
  isFirst: boolean,
): RailLine {
  const tone = panelTone(window);
  const ratio = window.ratio;
  const cells = Math.max(1, Math.floor(look.barWidth));
  const filled = Math.max(0, Math.min(cells, Math.round((ratio ?? 0) * cells)));
  const sweep = sweepIndex(frame, filled, look.sweep);
  // Bright fill, dim track, one glyph throughout: the fill takes the window's
  // tone - or the theme's primary text when calm - while the track stays
  // `subdued`, so fill and track can never differ in advance width.
  const fillTone: StyleColor | undefined = tone ?? "default";

  const runs: StatSegment[] = [];
  for (let index = 0; index < filled; index += 1) {
    appendRun(runs, CELL, index === sweep ? SWEEP_TONE : fillTone);
  }
  for (let index = filled; index < cells; index += 1) {
    appendRun(runs, CELL, "subdued");
  }
  if (look.showPercent) {
    const percent = ratio === undefined ? DEFAULT_PLACEHOLDER : `${Math.round(ratio * 100)}%`;
    // The percent joins the meter's trailing run so a uniform meter stays one
    // span; the countdown is its own dim run (relief, not severity).
    appendRun(runs, ` ${alignCell(percent, PANEL_PERCENT_WIDTH, look.align)}`, tone);
  }

  const segments: StatSegment[] = [];
  const mark = markField(look, nowMs, isFirst);
  if (mark !== undefined) segments.push(mark);
  segments.push({ text: `${labelField(label, look.labelWidth)} ` }, ...runs);
  if (look.showReset) {
    const countdown = resetCountdown(window, nowMs);
    if (countdown !== undefined) {
      segments.push({ text: ` ${alignCell(countdown, PANEL_RESET_WIDTH, look.align)}`, tone: "subdued" });
    }
  }
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}

/**
 * The footer's Go usage panel: exactly three {@link RailLine}s, rolling ->
 * weekly -> monthly, ready for the host's themed renderer, plus the dim header
 * only when the caller opts in with `header: true`.
 *
 * Never throws and never returns fewer than three lines - a panel that
 * vanished or took the footer slot down with it would be worse than one that
 * says nothing yet - so a missing, empty, or hostile usage payload degrades
 * to the same three labels with the resting placeholder.
 *
 * `frame` is the host ticker's counter, passed in rather than read here so
 * the panel stays pure; it moves a bright cell only when the look opts in
 * with `sweep: true`, so by default the bar is static. The breathing mark is
 * different: it steps from the wall clock (`nowMs`), so it breathes whether
 * or not the ticker runs. `reason` names why there is no data (a ./go.js
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
    const look = readLook(layout);
    const windows = windowById(usage);
    // The reason explains the whole panel, so it is only meaningful when no
    // window rendered at all, and it is tagged once rather than three times.
    const tag = windows.size === 0 ? readReason(reason) : undefined;
    const sweepFrame = readFrame(frame);
    const rows = PANEL_WINDOWS.map((id, index) => {
      const label = look.labels[labelKeyFor(id)];
      const window = windows.get(id);
      return window === undefined
        ? restingLine(label, look, index === 0 ? tag : undefined, nowMs, index === 0)
        : valueLine(label, look, window, nowMs, sweepFrame, index === 0);
    });
    return look.header ? [headerLine(), ...rows] : rows;
  } catch {
    // Belt and braces: the body above is defensive, but a renderer must never
    // be taken down by the panel, so any unexpected throw lands on the resting
    // placeholder - the same three lines, with no values.
    const fallback = readLook(undefined);
    return PANEL_WINDOWS.map((id, index) =>
      restingLine(fallback.labels[labelKeyFor(id)], fallback, undefined, nowMs, index === 0),
    );
  }
}
