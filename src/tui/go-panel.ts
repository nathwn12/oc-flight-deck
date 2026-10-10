// The live Go usage panel for the sidebar footer slot.
//
// Three fixed lines - Rolling (5h), Weekly (1w), Monthly (1m) - drawn in the
// footer, below the rail's rows. Each line is label, a full/light-shade bar, an
// integer percent and a compact reset countdown, so the footer reads as the
// same instrument as the one-line `go` row (./rows.ts), one size up.
//
// Pure, like ./go-usage.js: the clock arrives as `nowMs`, the animation phase
// as `frame`, and the usage and its no-data reason as values, so the panel is a
// function of its inputs and testable without a server, a store, or a frozen
// clock. There is no I/O, no timer and no hidden `Date.now()`. `layout` is
// `unknown` on principle - it crosses the config boundary - so its geometry is
// re-read defensively instead of trusted from a type that may not match the
// caller.
//
// Every glyph is written as a `\uXXXX` escape so this source stays ASCII
// whatever the write path does with it: U+2588 is the filled cell, U+2591 the
// track. The bar is never allowed to exceed its width, so the panel cannot
// overflow the sidebar.

import { asCount, asRecord } from "./coerce.js";
import { DEFAULT_BAR_WIDTH } from "./format.js";
import { goTone, type GoUsage, type GoWindow } from "./go-usage.js";
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

/** U+2588 FULL BLOCK: one filled cell of the progress bar. */
const FILLED = "\u2588";
/** U+2591 LIGHT SHADE: one track cell behind the fill. */
const TRACK = "\u2591";

/**
 * Fraction of a window at which the panel switches to the warning role.
 *
 * Between the error threshold (./go-usage.js's `GO_ERROR_RATIO`, 0.9) and the
 * midpoint: it warns while there is still headroom to act, without colouring
 * ordinary use. The error decision stays `goTone`'s, so the panel and the row
 * can never disagree about what "in trouble" means.
 */
export const GO_WARNING_RATIO = 0.6;

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
 * A duration as one or two compact units: `45s`, `12m`, `2h`, `4h44m`, `1d6h`,
 * `30d23h`.
 *
 * Deliberately not ./go-usage.js's `formatRemaining`: that one is the one-line
 * `go` row's hint and stays single-unit. The panel has the columns for the next
 * unit down, and the next unit is what turns "4h" into something an agent can
 * plan against. Seconds are dropped once hours are on the clock - two units is
 * the whole budget - and a unit is omitted when it is zero, so an exact `2h`
 * reads `2h` rather than `2h0m`.
 *
 * The sub-hour branches round up (as the row's hint does), so a countdown never
 * understates the wait: 90s reads `2m`, not `1m30s`.
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
  return ` \u00B7 ${formatCompactRemaining(remaining)}`;
}

/**
 * The colour role a window's bar, percent and countdown draw in.
 *
 * `goTone` owns the error decision (>= 90% or a non-benign status), so the
 * panel cannot disagree with the row; the warning band above
 * {@link GO_WARNING_RATIO} is the panel's own, and everything below keeps the
 * row's own colour (`undefined`, which the renderer inherits).
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
 * the bar is drawn static: the sweep is motion, and inventing one from a broken
 * phase would be a lie.
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
 * role is the same. Merging is what keeps a uniform bar (or an all-error line)
 * as one coloured span rather than one span per cell, so the renderer is handed
 * a handful of runs, not `barWidth` of them.
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
 * The reason comes from the bridge (or is the caller's `"no-bridge"`), so it is
 * one of our own short tokens; anything else - a long string, whitespace, a
 * control character - is dropped rather than rendered into the panel.
 */
function readReason(reason: unknown): string | undefined {
  return typeof reason === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(reason) ? reason : undefined;
}

/**
 * One resting line: the label, the empty track, and the placeholder - plus a
 * dim reason tag when the caller knows why there is no data.
 *
 * The track is kept even with no data, so the panel's shape never jumps between
 * "waiting" and "reading": the bar column is always there. The placeholder and
 * the reason are toned `subdued` explicitly so a resting line stays dim even
 * when `style.rows.go` is set bright - neither is a value.
 */
function restingLine(
  label: string,
  labelWidth: number,
  barWidth: number,
  reason: string | undefined,
): RailLine {
  const cells = Math.max(1, Math.floor(barWidth));
  const segments: StatSegment[] = [
    { text: labelPrefix(label, labelWidth) },
    { text: `${TRACK.repeat(cells)} ${DEFAULT_PLACEHOLDER}`, tone: "subdued" },
  ];
  if (reason !== undefined) segments.push({ text: `  ${reason}`, tone: "subdued" });
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}

/**
 * One drawn line: the label, a bar, the percent used, and the countdown.
 *
 * The bar is `FILLED` over `TRACK`, with one brighter cell (`default`, the
 * theme's primary text colour) sweeping across the filled region when a live
 * frame is supplied. Only the bar, the number, and the countdown can take the
 * window's tone - the label keeps the line's own colour, so a flagged window
 * reads as this panel with a problem rather than as a different kind of line. A
 * window whose ratio is unknown draws the placeholder for the number beside an
 * empty bar: the percent is the precision, and inventing one from a count with
 * no limit is exactly the confident guess the model refuses to make.
 */
function valueLine(
  label: string,
  labelWidth: number,
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
  // The percent joins the bar's trailing run so a uniform bar stays one span,
  // while the countdown is its own run (the row's own split).
  appendRun(runs, ` ${percent}`, tone);

  const segments: StatSegment[] = [{ text: labelPrefix(label, labelWidth) }, ...runs];
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
 *
 * `frame` is the host ticker's counter, passed in rather than read here so the
 * panel stays pure; `reason` names why there is no data (a
 * ./go.js `GoNoDataReason`, or the caller's `"no-bridge"`) and is drawn once, on
 * the first line, only when the whole panel is empty.
 */
export function goPanelLines(
  usage: GoUsage | undefined,
  nowMs: number,
  layout?: unknown,
  frame?: number,
  reason?: unknown,
): readonly RailLine[] {
  try {
    const { labelWidth, barWidth } = readGeometry(layout);
    const windows = windowById(usage);
    // The reason explains the whole panel, so it is only meaningful when no
    // window rendered at all, and it is tagged once rather than three times.
    const tag = windows.size === 0 ? readReason(reason) : undefined;
    const sweepFrame = readFrame(frame);
    return PANEL_WINDOWS.map(({ id, label }, index) => {
      const window = windows.get(id);
      return window === undefined
        ? restingLine(label, labelWidth, barWidth, index === 0 ? tag : undefined)
        : valueLine(label, labelWidth, barWidth, window, nowMs, sweepFrame);
    });
  } catch {
    // Belt and braces: the body above is defensive, but a renderer must never
    // be taken down by the panel, so any unexpected throw lands on the resting
    // placeholder - the same three lines, with no values.
    return PANEL_WINDOWS.map(({ label }) =>
      restingLine(label, DEFAULT_LABEL_WIDTH, DEFAULT_BAR_WIDTH, undefined),
    );
  }
}
