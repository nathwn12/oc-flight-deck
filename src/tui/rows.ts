// Row rendering for the Flight Deck rail: one padded line per named field.
//
// `statLine` renders a single field or `undefined` when the host has not
// supplied it yet; `statRows` renders a list of fields and folds in the
// persistence behaviour. Every value passes through `plain`, so a control
// character in a host-supplied string cannot move the cursor. Pure, so the
// rendering is trivial to test.

import { DEFAULT_BAR_WIDTH, clip, formatCost, formatCount, formatDuration, fuelBar, sparkline } from "./format.js";
import { asCount, asRecord, asText } from "./coerce.js";
import { goResetSuffix, goTone, type GoWindow } from "./go-usage.js";
import { guardToken } from "./guard-tokens.js";
import type { StyleColor } from "./style.js";
import {
  DEFAULT_LABEL_WIDTH,
  DEFAULT_PLACEHOLDER,
  DEFAULT_SPARK_WIDTH,
  isStatField,
  type LayoutHint,
  type StatSource,
} from "./stat-fields.js";

/** Braille frames, advanced by the ticker, shown only while the session runs. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * Flatten control characters in anything about to be drawn.
 *
 * A rail is one line per row, so a newline or an escape sequence in a
 * host-supplied string does not get seen — it moves the cursor. Config text is
 * already flattened in ./config.ts, but a tool name, a permission resource or a
 * branch name arrives straight from the host, so every row value passes through
 * here on its way out. `replace` is unconditional rather than `test` + `replace`:
 * a global regex used with `test` carries `lastIndex` between calls.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function plain(value: string): string {
  return value.replace(CONTROL_CHARS, " ");
}

/**
 * One padded rail row: the label in its column, at least one space, then the
 * flattened value. Shared by live rows and persistent placeholders so both
 * keep the same column.
 */
function formatRow(label: string, value: string, labelWidth: number): string {
  return `${labelPrefix(label, labelWidth)}${plain(value)}`;
}

/**
 * The label column plus its guaranteed separator, before a row's value.
 *
 * Extracted so the plain and segmented renderers pad a label identically: a
 * label wider than its column (`reasoning` at width 8) must still get a space
 * in both, or the two views of one row would differ by one character.
 */
function labelPrefix(label: string, labelWidth: number): string {
  return `${label.padEnd(labelWidth)}${label.length >= labelWidth ? " " : ""}`;
}

/**
 * One coloured run of a rail row.
 *
 * `tone` is a theme role from ./style.js, absent when the run keeps the row's
 * own colour — a healthy row must read exactly as it did before the row could
 * colour part of itself. A row's plain text is exactly the join of its
 * segments, so the string view and the coloured view can never disagree.
 */
export interface StatSegment {
  readonly text: string;
  readonly tone?: StyleColor;
}

/** Canonical `go` window order, so the dials always read 5h then 1w then 1m. */
const GO_ORDER: readonly GoWindow["id"][] = ["5h", "1w", "1m"];

/**
 * Quarter-fill dials, from the approved design.
 *
 * The glyph is the shape, the number beside it is the precision; the thresholds
 * are the design's own percent cutoffs kept exact. The empty circle doubles as
 * the sane-zero, so a fresh window reads `○ 0` rather than a dash — the dash is
 * reserved for "no data yet", which the persist layer draws.
 */
const DIAL_STEPS: readonly (readonly [number, string])[] = [
  [13, "○"],
  [38, "◔"],
  [63, "◑"],
  [88, "◕"],
  [101, "●"],
];

function dialGlyph(percent: number): string {
  for (const [limit, glyph] of DIAL_STEPS) {
    if (percent < limit) return glyph;
  }
  return "●";
}

/**
 * The Go windows the row can draw, in canonical order.
 *
 * The source is `unknown` on principle, so the shape is re-validated here: an
 * entry is kept only when its `id` is one of the three windows and its `ratio`
 * is a finite, non-negative number. The ratio is clamped to 1 at this boundary
 * too, so a hand-built source cannot fill a dial past full or print `150`. A
 * window with no ratio cannot draw an honest dial — a count with no known limit
 * would fill the gauge by guesswork — so it is dropped rather than shown
 * half-read.
 */
function asGoWindows(value: unknown): readonly GoWindow[] {
  const list = asRecord(value)?.windows;
  if (!Array.isArray(list)) return [];
  const windows: GoWindow[] = [];
  for (const entry of list) {
    const window = asRecord(entry);
    if (window === undefined) continue;
    const id = asText(window["id"]);
    if (id !== "5h" && id !== "1w" && id !== "1m") continue;
    const ratio = asCount(window["ratio"]);
    if (ratio === undefined) continue;
    const result: {
      -readonly [K in keyof GoWindow]: GoWindow[K];
    } = { id, ratio: Math.min(1, ratio) };
    const resetAtMs = asCount(window["resetAtMs"]);
    if (resetAtMs !== undefined) result.resetAtMs = resetAtMs;
    const status = asText(window["status"]);
    if (status !== undefined) result.status = status;
    windows.push(result);
  }
  windows.sort((a, b) => GO_ORDER.indexOf(a.id) - GO_ORDER.indexOf(b.id));
  return windows;
}

/**
 * The `go` row's value as coloured segments, or `undefined` when there is
 * nothing to draw (so the caller falls back to the placeholder).
 *
 * Only the offending window takes the error tone: the dial and its number turn
 * red while its healthy neighbours keep the row's own colour, which is what
 * makes the row read as one panel with a problem rather than as a different
 * kind of line.
 */
function goValueSegments(source: StatSource, layout: LayoutHint): StatSegment[] | undefined {
  const windows = asGoWindows(source.go);
  if (windows.length === 0) return undefined;

  const nowMs = layout.nowMs ?? Date.now();
  // Only the worst flagged window carries a reset hint. With every window red,
  // three hints overflow the rail (the 38-column budget) for information that is
  // redundant three times over; the first in the fixed 5h → 1w → 1m order is the
  // nearest relief, so it is the one worth naming. A single flagged window is
  // unchanged: it is the worst, and it keeps its hint.
  const flagged = windows.findIndex((window) => goTone(window) === "error");
  const chunks: StatSegment[][] = [];
  for (const [index, window] of windows.entries()) {
    const percent = Math.round((window.ratio ?? 0) * 100);
    const tone: StyleColor | undefined = goTone(window) === "error" ? "error" : undefined;
    const chunk: StatSegment[] = [{ text: `${dialGlyph(percent)} ${percent}`, tone }];
    // A reset hint beside a calm dial is noise and one in the past is a promise
    // already broken, so it is drawn only on the flagged window that needs it.
    const suffix = index === flagged ? goResetSuffix(window, nowMs) : undefined;
    if (suffix !== undefined) chunk.push({ text: suffix, tone });
    chunks.push(chunk);
  }

  const segments: StatSegment[] = [];
  chunks.forEach((chunk, index) => {
    // The separator inherits the row's colour: only the dial and number of a
    // flagged window go red, never the space between windows.
    if (index > 0) segments.push({ text: " " });
    segments.push(...chunk);
  });
  return segments;
}

/**
 * Render one named field, or `undefined` when the host has not supplied it yet.
 *
 * Returning `undefined` rather than a placeholder is deliberate: a rail that
 * shows `branch   unknown` before the repo loads looks broken, while a rail
 * that simply grows a row when the data arrives looks alive.
 */
export function statLine(
  field: string,
  source: StatSource,
  layout: LayoutHint = {},
): string | undefined {
  // Bound here rather than at module scope so a config file can change the
  // column width without every call site having to know about it.
  const labelWidth = layout.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const barWidth = layout.barWidth ?? DEFAULT_BAR_WIDTH;
  const sparkWidth = layout.sparkWidth ?? DEFAULT_SPARK_WIDTH;
  // At least one space, always.
  //
  // `padEnd` returns the label unchanged when it is already wider than the
  // column, so a label longer than `labelWidth` was glued straight onto its
  // value: at labelWidth 8 the `reasoning` row rendered as "reasoning153k".
  // The label is nine characters, which made this reachable from a config file.
  const row = (label: string, value: string): string => formatRow(label, value, labelWidth);

  switch (field) {
    case "caution": {
      // Rendered only when the caller found something to say, which is what
      // keeps a healthy session visually identical to one without the
      // annunciator at all. The string already carries its glyph; nothing here
      // knows or cares about severity.
      const text = asText(source.caution);
      return text === undefined ? undefined : row("caution", text);
    }
    case "status": {
      const status = asText(source.status);
      if (status === undefined && source.busy === undefined) return undefined;
      // The spinner lives here rather than in a row of its own: an animated
      // glyph beside "running" says the same thing without spending a line.
      //
      // `busy` folds in work the session's own status misses — a subagent
      // running in its own session, or a shell command still going — so the
      // glyph only stops when there is genuinely nothing happening. A host that
      // does not report it falls back to the session's own status.
      if (source.busy !== true && status !== "running") return row("status", "○ idle");
      // Floored at the boundary: a fractional frame would index the frame list
      // with a non-integer and render `undefined`.
      const frame = Math.floor(asCount(source.frame) ?? 0);
      return row("status", `${SPINNER[frame % SPINNER.length]} running`);
    }
    case "agent": {
      const agent = asText(source.agent);
      return agent === undefined ? undefined : row("agent", agent);
    }
    case "model": {
      const model = asRecord(source.model);
      const id = asText(model?.id);
      if (id === undefined) return undefined;
      const variant = asText(model?.variant);
      return row("model", variant === undefined ? id : `${id} · ${variant}`);
    }
    case "branch": {
      const branch = asText(source.branch);
      return branch === undefined ? undefined : row("branch", branch);
    }
    case "cost": {
      const cost = asCount(source.cost);
      const tree = asRecord(source.tree);
      const treeCost = asCount(tree?.cost);
      const count = asCount(tree?.count);
      const family = count !== undefined && count > 0 ? count : 0;

      // Merge only when subagents actually ran, and only when the rail is not
      // already showing a `total` row. Two rows holding a number and its own
      // superset was the thing worth fixing; a setting to choose between them
      // would just be that duplication with extra steps.
      const merge =
        layout.hasTotalRow !== true &&
        cost !== undefined &&
        treeCost !== undefined &&
        family > 0 &&
        treeCost > cost;

      if (!merge) {
        const value = layout.hasTotalRow === true ? (cost ?? treeCost) : (treeCost ?? cost);
        return value === undefined ? undefined : row("cost", formatCost(value));
      }

      // The delta (`+$0.020`) used to be here and pushed the row to 40 columns,
      // wide enough to wrap in a normal sidebar. It was real information that
      // did not earn its width: the count already explains why the figure is
      // higher, and this form is the same width as the old `total` row.
      const plural = family === 1 ? "subagent" : "subagents";
      return row("cost", `${formatCost(treeCost as number)} · ${family} ${plural}`);
    }
    case "total": {
      // Only worth a row once a subagent has actually run: subagent sessions are
      // separate, so the parent's `cost` alone understates what was spent.
      const tree = asRecord(source.tree);
      const count = asCount(tree?.count);
      const cost = asCount(tree?.cost);
      if (cost === undefined || count === undefined || count === 0) return undefined;
      const plural = count === 1 ? "subagent" : "subagents";
      return row("total", `${formatCost(cost)} · ${count} ${plural}`);
    }
    case "project": {
      const project = asRecord(source.project);
      const cost = asCount(project?.cost);
      if (cost === undefined) return undefined;
      const count = asCount(project?.count);
      return row("project", `${formatCost(cost)}${count !== undefined && count > 1 ? ` · ${count} sessions` : ""}`);
    }
    case "tokens": {
      const tokens = asRecord(source.tokens);
      const input = asCount(tokens?.input);
      const output = asCount(tokens?.output);
      if (input === undefined && output === undefined) return undefined;
      return row("tokens", `${formatCount(input ?? 0)} in · ${formatCount(output ?? 0)} out`);
    }
    case "cache": {
      const tokens = asRecord(source.tokens);
      const cache = asRecord(tokens?.cache);
      const read = asCount(cache?.read);
      if (read === undefined || read === 0) return undefined;
      const input = asCount(tokens?.input);
      // Hit ratio is the whole point: it explains a cheap bill on a huge token
      // count, and it is the first thing to break when caching stops working.
      const total = input === undefined ? undefined : read + input;
      const value =
        total === undefined || total === 0
          ? `${formatCount(read)} read`
          : `${Math.round((read / total) * 100)}% hit · ${formatCount(read)} read`;
      return row("cache", value);
    }
    case "context": {
      const context = asRecord(source.context);
      const used = asCount(context?.used);
      if (used === undefined || used === 0) return undefined;
      const limit = asCount(context?.limit);
      if (limit === undefined || limit === 0) return row("context", `${formatCount(used)} used`);
      const ratio = used / limit;
      // Show the percentage whenever the host reports it, but never a bar that
      // reads as more than full.
      return row("context", `${fuelBar(ratio, barWidth)} ${Math.round(Math.min(1, ratio) * 100)}%`);
    }
    case "perms": {
      const perms = asRecord(source.perms);
      const count = asCount(perms?.["count"]);
      if (count === undefined || count === 0) return undefined;
      const action = asText(perms?.["action"]);
      const resource = asText(perms?.["resource"]);

      // One request: name it, because that is the decision you are being asked
      // to make. Several: the count leads, because the first request in the
      // queue is not necessarily the one you are about to be shown.
      if (count > 1) {
        return row("perms", action === undefined ? `${count} waiting` : `${count} waiting · ${action}`);
      }
      if (action === undefined) return row("perms", "1 waiting");
      // Clipped hard: a row that wraps costs the reader more than a row that
      // shortens a path, and there is no way to ask the host how wide it is.
      return row("perms", resource === undefined ? action : `${action} · ${clip(resource, 18)}`);
    }
    case "elapsed": {
      const ms = asCount(source.elapsedMs);
      if (ms === undefined || ms <= 0) return undefined;
      return row("elapsed", formatDuration(ms, layout.durationStyle));
    }
    case "tps": {
      const tps = asCount(source.tps);
      if (tps === undefined || tps === 0) return undefined;
      return row("tps", `${Math.round(tps)} tok/s`);
    }
    case "spark": {
      const values = Array.isArray(source.spark) ? source.spark.map((value) => asCount(value) ?? 0) : [];
      // The newest samples are the interesting ones, so a narrowed window keeps
      // the recent shape rather than the oldest.
      const windowed = values.slice(-Math.max(2, Math.floor(sparkWidth)));
      if (windowed.length < 2) return undefined;
      return row("spark", sparkline(windowed));
    }
    case "reasoning": {
      const reasoning = asCount(asRecord(source.tokens)?.reasoning);
      if (reasoning === undefined || reasoning === 0) return undefined;
      return row("reasoning", formatCount(reasoning));
    }
    case "turns": {
      const turns = asCount(source.turns);
      if (turns === undefined || turns === 0) return undefined;
      return row("turns", String(turns));
    }
    case "guard": {
      const token = guardToken(source.guard);
      return token === undefined ? undefined : row("guard", token);
    }
    case "go": {
      // The plain string is the exact join of the coloured segments, so the
      // string view (tests, `sidebarTextLines`) and the JSX view agree
      // character-for-character.
      const value = goValueSegments(source, layout);
      return value === undefined ? undefined : row("go", value.map((segment) => segment.text).join(""));
    }
    default:
      return undefined;
  }
}

/**
 * One field's rail row as coloured segments, or `undefined` when the field is
 * not segment-aware or has nothing to draw.
 *
 * Only `go` is segment-aware today — the one row whose severity lives on part
 * of the line rather than the whole. Every other field returns `undefined` and
 * the caller falls through to {@link statLine}, so there is still exactly one
 * place that knows a row's text.
 */
export function statSegments(
  field: string,
  source: StatSource,
  layout: LayoutHint = {},
): readonly StatSegment[] | undefined {
  if (field !== "go") return undefined;
  const value = goValueSegments(source, layout);
  if (value === undefined) return undefined;
  return [{ text: labelPrefix("go", layout.labelWidth ?? DEFAULT_LABEL_WIDTH) }, ...value];
}

/** Render every named field, in the given order.
 *
 * By default only fields with data render; with `layout.persist` every known
 * field renders exactly one row, using `layout.placeholder` (default `"—"`)
 * for the value when the host has nothing to show yet. `statLine` keeps
 * returning `string | undefined` — persistence lives here, not there.
 */
export function statRows(
  fields: readonly string[],
  source: StatSource,
  layout: LayoutHint = {},
): readonly string[] {
  // The rows list decides whether `cost` merges the subagent total into itself.
  // Passing that down means the choice lives in `sidebar.rows`, where someone
  // is already deciding what the rail shows.
  const hint: LayoutHint = { ...layout, hasTotalRow: fields.includes("total") };
  const persist = hint.persist === true;
  const placeholder = hint.placeholder ?? DEFAULT_PLACEHOLDER;
  const labelWidth = hint.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const rows: string[] = [];
  for (const field of fields) {
    const line = statLine(field, source, hint);
    if (line !== undefined) {
      rows.push(line);
      continue;
    }
    // Unknown names stay skipped even when persistent: a typo must stay a
    // reported-and-skipped row, not a placeholder that looks intentional.
    if (!persist || !isStatField(field)) continue;
    rows.push(formatRow(field, placeholder, labelWidth));
  }
  return rows;
}
