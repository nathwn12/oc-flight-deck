// Configuration model for the cosmetic Flight Deck rail.
//
// Options arrive from the host through `context.options` — the `options` object
// on a plugin entry in `opencode.jsonc` / `cli.json`:
//
//   { "plugins": [{ "package": "oc-flight-deck", "options": { ... } }] }
//
// Everything is optional. Missing or invalid values fall back to the sane
// defaults below, so the rail always renders and a typo can never break the TUI.

import { DEFAULT_PLACEHOLDER, canonicalField, isStatField, STAT_FIELDS } from "./stats.js";
import type { CautionThresholds } from "./caution.js";
import type { DurationStyle } from "./format.js";
import {
  DEFAULT_STYLE,
  STYLE_ATTRIBUTES,
  STYLE_COLORS,
  type LineStyle,
  type StyleAttribute,
  type StyleColor,
  type StyleConfig,
} from "./style.js";

interface SidebarConfig {
  /** Show the sidebar rail. Default `true`. */
  readonly enabled: boolean;
  /**
   * Fixed lines rendered above the live rows. Default `DEFAULT_SIDEBAR_LINES`
   * (empty since 0.8.0 — the branding pair moved to the sidebar footer).
   */
  readonly lines: readonly string[];
  /** Fixed lines rendered in the sidebar footer slot. Default `DEFAULT_SIDEBAR_FOOTER_LINES`. */
  readonly footer: SidebarFooterConfig;
  /** Live session fields to render, top to bottom. Default `DEFAULT_SIDEBAR_ROWS`. */
  readonly rows: readonly string[];
  /**
   * Render every named row even when the host has no data for it, using
   * `placeholder` as the value. Default `true`; `false` restores omission.
   */
  readonly persist: boolean;
  /** Value shown for a row with no data when `persist` is on. Default `"—"`. */
  readonly placeholder: string;
  /**
   * Cap on the whole rail: fixed lines plus live rows. Default `MAX_LINES`
   * (24). The fixed lines and the live rows draw from one budget, so this is
   * the one number that decides how tall the panel may grow.
   */
  readonly maxLines: number;
}

/**
 * The live Go panel's look, when `sidebar.footer.go` is an object.
 *
 * An object enables the panel exactly like `true`, with these knobs replacing
 * the defaults. Absent keys fall back to the defaults below; a malformed value
 * is reported and ignored, never a crash.
 */
export interface GoPanelLook {
  /** Draw the dim `◈ OPENCODE GO` header above the three meters. Default `false`. */
  readonly header: boolean;
  /** Cells in the panel meter. Default `10`. */
  readonly barWidth: number;
  /**
   * Minimum width of the panel label column. Default `6`.
   *
   * A minimum, not a fixed width: the panel auto-widens past it to hold the
   * longest rendered rename, so a rename can never overflow or wrap.
   */
  readonly labelWidth: number;
  /** Draw the right-aligned percent column. Default `true`. */
  readonly percent: boolean;
  /** Draw the right-aligned reset countdown column. Default `true`. */
  readonly reset: boolean;
  /**
   * Where a value sits inside its own fixed-width trailing cell.
   * Default `"right"`.
   *
   * The percent (4) and reset (6) cell widths stay fixed; this moves the
   * value within them. `"right"` pins the value to the cell's right edge, so
   * the digits stay put as values change length; `"left"` hugs the bar and
   * `"center"` splits the padding. Both trailing cells use the same setting.
   */
  readonly align: "left" | "right" | "center";
  /**
   * Let a bright cell sweep the fill while the ticker runs. Default `false`:
   * the bar is static and changes only when the percentage itself changes.
   */
  readonly sweep: boolean;
  /**
   * The three meter labels by window: `rolling` (5h), `weekly` (1w),
   * `monthly` (1m). Default the lowercase wire names.
   */
  readonly labels: {
    readonly rolling: string;
    readonly weekly: string;
    readonly monthly: string;
  };
  /**
   * Draw the slow breathing mark at the start of the first meter line.
   * Default `true`: only the mark breathes, the meter stays static.
   */
  readonly blink: boolean;
  /** Milliseconds per breath step. Default `700`, honoured from 200 to 5000. */
  readonly blinkMs: number;
}

/** The panel look `true` enables: no header, static meter, both columns on. */
export const DEFAULT_GO_PANEL_LOOK: GoPanelLook = {
  header: false,
  barWidth: 10,
  labelWidth: 6,
  percent: true,
  reset: true,
  align: "right",
  sweep: false,
  labels: { rolling: "rolling", weekly: "weekly", monthly: "monthly" },
  blink: true,
  blinkMs: 700,
};

interface SidebarFooterConfig {
  /**
   * The footer's fixed lines. Empty by default since 0.8.1.
   *
   * An explicitly empty list removes the fixed lines; `go` can still claim the
   * slot on its own. Set the documented two-line `▸ FLIGHT DECK` branding pair
   * back here to re-enable it. The two lists are independent, and the footer
   * draws outside the rail's `maxLines` budget.
   */
  readonly lines: readonly string[];
  /**
   * The live Go usage panel: three fixed-width lines - rolling (5h),
   * weekly (1w), monthly (1m) - each with a bar, a right-aligned percent, and
   * a right-aligned reset countdown. Off by default.
   *
   * `true` enables it with the default look (no header, static meter, both
   * columns); an object enables it with a custom look (`header`, `barWidth`,
   * `labelWidth`, `percent`, `reset`, `align`, `sweep`, `labels`, `blink`, `blinkMs`,
   * each falling back to its default). Independent of `lines`, and it claims
   * the footer slot on its own so the panel can sit under the rail with no
   * fixed text. Turning it on starts the same account-wide poll the `go` row
   * uses (one key, one quota), reads the active `opencode-go` credential from
   * OpenCode's own credential store, and draws a resting placeholder until the
   * first poll lands - never a blank slot.
   */
  readonly go: boolean | GoPanelLook;
}

interface FooterConfig {
  /**
   * Show the prompt-footer rail. Default `false`.
   *
   * Off by default on purpose: the prompt footer is prime real estate and the
   * sidebar already carries the data, so a line that only restates the plugin's
   * name is decoration. Turn it on for a one-line reminder or a custom label.
   */
  readonly enabled: boolean;
  /** Footer text. Default `DEFAULT_FOOTER_TEXT`. */
  readonly text: string;
}

interface CautionConfig {
  /** Show the caution annunciator. Default `false`. */
  readonly enabled: boolean;
  /** A tool running longer than this is worth noting. Default `180`. */
  readonly toolWatchSeconds: number;
  /** ... and longer than this is a real caution. Default `420`. */
  readonly toolCautionSeconds: number;
  /** A running session quiet for this long is worth noting. Default `600`. */
  readonly turnWatchSeconds: number;
  /** ... and quieter than this is a real caution. Default `1200`. */
  readonly turnCautionSeconds: number;
  /** Identical consecutive calls before it counts as a loop. Default `3`. */
  readonly repeatThreshold: number;
  /**
   * Tools that are slow by nature, so "slow" is not an anomaly for them.
   *
   * Calibrated against 54,218 real settled tool calls: at a 180-second watch
   * threshold, 307 calls exceed it — and 200 of those are these tools.
   * `subagent` alone accounts for 152, with a p99 of 14.7 minutes. A delegated
   * agent running a quarter of an hour is working as designed, and an
   * annunciator that lights on every delegation is one you learn to ignore.
   * With these exempt, 0.20% of real calls cross the threshold.
   *
   * Matching is by exact tool name. Add your own long-running tools.
   */
  readonly exemptTools: readonly string[];
  /** Raise a toast the first time a caution appears, once per distinct problem. */
  readonly toast: boolean;
}

export interface FlightDeckConfig {
  readonly sidebar: SidebarConfig;
  readonly footer: FooterConfig;
  /**
   * The annunciator: the one thing on the rail that is not session state.
   *
   * It exists because a hang emits no events, so nothing else here can see it.
   * Silent when healthy, which is why it costs nothing visually. Off by default:
   * it is opt-in, so an install that never asks for it spends no timer on it.
   */
  readonly caution: CautionConfig;
  /** Geometry of a row. Every value has a sane default. */
  readonly layout: LayoutConfig;
  /** How values are written on the rail, e.g. the `elapsed` duration style. */
  readonly format: FormatConfig;
  /** Glyphs for the annunciator, for terminals that render the defaults badly. */
  readonly glyphs: GlyphConfig;
  /**
   * Per-line appearance: a colour role and text attributes for the fixed lines
   * and the live rows. Absent config leaves the theme-native look untouched.
   */
  readonly style: StyleConfig;
  /**
   * Update cadence in milliseconds for time-derived rows.
   *
   * Cost and tokens arrive with events, so they stay current without a timer.
   * Anything derived from the clock — `elapsed`, the status spinner's frames,
   * and the annunciator's escalating thresholds — has nothing to react to, so
   * it needs a tick. `0` turns the ticker off, leaving every row event-driven.
   */
  readonly refresh: number;
}

/** The millisecond view the rules in ./caution.ts operate on. */
export function cautionThresholds(config: CautionConfig): CautionThresholds {
  return {
    toolWatchMs: config.toolWatchSeconds * 1_000,
    toolCautionMs: config.toolCautionSeconds * 1_000,
    turnWatchMs: config.turnWatchSeconds * 1_000,
    turnCautionMs: config.turnCautionSeconds * 1_000,
    repeatThreshold: config.repeatThreshold,
    exemptTools: config.exemptTools,
  };
}

/** Pure cosmetics: the geometry of a row. */
interface LayoutConfig {
  /** Width of the row label column. Default `10`. */
  readonly labelWidth: number;
  /** Cells in the context gauge. Default `10`. */
  readonly barWidth: number;
  /** Samples drawn in the sparkline. Default `12`. */
  readonly sparkWidth: number;
}

/**
 * The annunciator's glyphs: one mark per severity.
 *
 * All three are single-cell marks — `▲` watch, `●` caution, `○` clear — so the
 * annunciator row lines up with every other row on the rail regardless of how
 * the terminal classifies their East Asian width. Configurable because this is
 * the one row that has to read at a glance, and a terminal that draws one of
 * these badly can be given a substitute without a rebuild.
 */
interface GlyphConfig {
  readonly watch: string;
  readonly caution: string;
  readonly clear: string;
}

/**
 * How values are written on the rail.
 *
 * Display only: nothing here changes what is measured, only how a number is
 * drawn.
 */
interface FormatConfig {
  /**
   * How the `elapsed` row joins its segments: `"spaced"` separates the units
   * with one space (`2h 14m 37s`, the default), `"compact"` hugs them
   * (`2h14m37s`). Zero-padding is identical either way.
   */
  readonly duration: DurationStyle;
}

const DEFAULT_LAYOUT: LayoutConfig = {
  labelWidth: 10,
  barWidth: 10,
  sparkWidth: 12,
};

const DEFAULT_FORMAT: FormatConfig = { duration: "spaced" };

const DEFAULT_GLYPHS: GlyphConfig = {
  watch: "▲",
  caution: "●",
  clear: "○",
};

const DEFAULT_CAUTION: CautionConfig = {
  enabled: false,
  toolWatchSeconds: 180,
  toolCautionSeconds: 420,
  turnWatchSeconds: 600,
  turnCautionSeconds: 1200,
  repeatThreshold: 3,
  exemptTools: ["question", "task", "subagent", "agent", "delegate", "delegate_many", "delegate_task", "tools.delegate", "tools.delegate_many", "tools.subagent", "tools.task"],
  /**
   * Off by default. The rail is the signal; a toast is an interruption.
   *
   * The annunciator's job is to sit there and be ignorable until it isn't, and a
   * notification that takes over the screen is the opposite of that. It is worth
   * turning on if you walk away from long runs, which is why it exists at all.
   */
  toast: false,
};

/**
 * Fixed lines shown above the live rows.
 *
 * Empty since 0.8.0: the branding pair moved to the sidebar footer slot
 * (`DEFAULT_SIDEBAR_FOOTER_LINES`), so the top of the rail starts with the
 * live rows. The rail exists to show session state, so nothing here is
 * filler: there is no placeholder text to delete before it looks finished.
 */
export const DEFAULT_SIDEBAR_LINES: readonly string[] = [];

/**
 * The sidebar footer's default fixed lines.
 *
 * Empty since 0.8.1: a fresh install renders no footer text at all, so the
 * rail is the live rows and nothing else. The `▸ FLIGHT DECK` pair is a
 * documented opt-in - set `sidebar.footer.lines` to the pair to re-enable it
 * (see the README's Configure section). An explicitly empty
 * `sidebar.footer.lines` from a config file removes the slot's fixed lines;
 * `sidebar.footer.go` can still claim the slot on its own.
 */
export const DEFAULT_SIDEBAR_FOOTER_LINES: readonly string[] = [];

/**
 * Live fields shown by default, in reading order.
 *
 * Every one of these is read from the open session at render time, so a fresh
 * install shows real numbers with no configuration file at all. The rows that
 * need extra machinery or a second source — `caution` (a clock), `branch` (a
 * VCS call), and `go` (an account-wide poll) — are opt-in via `sidebar.rows`.
 */
export const DEFAULT_SIDEBAR_ROWS: readonly string[] = [
  "status",
  "agent",
  "model",
  "cost",
  "project",
  "tokens",
  "cache",
  "context",
  "perms",
  "elapsed",
  "tps",
];

/**
 * Default cap on the whole rail: fixed lines plus live rows.
 *
 * The rail shares the sidebar with the host's own content, so a config file
 * naming two dozen rows must not silently push the host off screen.
 * `sidebar.maxLines` exposes it; this is the shipped default.
 */
export const MAX_LINES = 24;

/**
 * Ten ticks a second: the status spinner has ten frames, so one rotation takes a
 * second and reads as motion instead of as a stuck glyph. A tick costs one
 * host-store write plus a recompute measured in microseconds, and when nothing
 * on the rail changed the host's renderer diffs the frame away to nothing.
 * Raise it to spend less on idle sessions; `0` turns the ticker off entirely.
 */
export const DEFAULT_REFRESH_MS = 100;

/** A tick slower than once a minute is indistinguishable from no ticker. */
const MAX_REFRESH_MS = 60_000;

/**
 * A tick wakes the host's renderer, so a sub-frame interval from a config file
 * is a way to wedge the TUI rather than a way to make it smoother. 16ms is one
 * frame at 60Hz; below that there is nothing left to animate.
 */
export const MIN_REFRESH_MS = 16;

export const DEFAULT_FOOTER_TEXT = "Flight Deck";

export const DEFAULT_CONFIG: FlightDeckConfig = {
  sidebar: {
    enabled: true,
    lines: DEFAULT_SIDEBAR_LINES,
    footer: { lines: DEFAULT_SIDEBAR_FOOTER_LINES, go: false },
    rows: DEFAULT_SIDEBAR_ROWS,
    persist: true,
    placeholder: DEFAULT_PLACEHOLDER,
    maxLines: MAX_LINES,
  },
  footer: { enabled: false, text: DEFAULT_FOOTER_TEXT },
  caution: DEFAULT_CAUTION,
  layout: DEFAULT_LAYOUT,
  format: DEFAULT_FORMAT,
  glyphs: DEFAULT_GLYPHS,
  style: DEFAULT_STYLE,
  refresh: DEFAULT_REFRESH_MS,
};

/** Layout guards: keep a hand-edited config from producing an unusable rail. */
const MAX_LINE_LENGTH = 120;

// Rails render on a single line, so control characters are replaced with
// spaces rather than being passed to the renderer.
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function normalizeText(value: string, path: string, issues: string[]): string {
  if (!CONTROL_CHAR.test(value)) return value.trim();
  issues.push(`${path} contained control characters; they were replaced with spaces`);
  return value.replace(CONTROL_CHARS, " ").replace(/ {2,}/g, " ").trim();
}

interface ConfigResolution {
  readonly config: FlightDeckConfig;
  /** Human-readable problems found in the supplied options; empty when clean. */
  readonly issues: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean, path: string, issues: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  issues.push(`${path} must be true or false; using ${fallback}`);
  return fallback;
}

function readText(value: unknown, fallback: string, path: string, issues: string[]): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string; using the default`);
    return fallback;
  }
  const text = normalizeText(value, path, issues);
  if (text.length === 0) {
    issues.push(`${path} must not be empty; using the default`);
    return fallback;
  }
  if (text.length > MAX_LINE_LENGTH) {
    issues.push(`${path} was longer than ${MAX_LINE_LENGTH} characters; it was shortened`);
    return text.slice(0, MAX_LINE_LENGTH);
  }
  return text;
}

/**
 * One fixed-line list, shared by the top rail and the sidebar footer.
 *
 * An explicitly empty list is a real choice for both rails - the top rail's
 * lines default to empty since 0.8.0, and an empty footer list removes the
 * footer slot entirely. A list with no usable entries still falls back to
 * `fallback`, loudly, like every other bad option.
 */
function readLineList(
  value: unknown,
  issues: string[],
  maxLines: number,
  fallback: readonly string[],
  path: string,
): readonly string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of strings; using the default lines`);
    return fallback;
  }
  if (value.length === 0) return [];

  const lines: string[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (typeof entry !== "string") {
      issues.push(`${entryPath} must be a string; skipping it`);
      return;
    }
    const text = normalizeText(entry, entryPath, issues);
    if (text.length === 0) {
      issues.push(`${entryPath} is empty; skipping it`);
      return;
    }
    if (text.length > MAX_LINE_LENGTH) {
      issues.push(`${entryPath} was longer than ${MAX_LINE_LENGTH} characters; it was shortened`);
      lines.push(text.slice(0, MAX_LINE_LENGTH));
      return;
    }
    lines.push(text);
  });

  if (lines.length === 0) {
    issues.push(`${path} had no usable entries; using the default lines`);
    return fallback;
  }
  if (lines.length > maxLines) {
    issues.push(`${path} has ${lines.length} entries; keeping the first ${maxLines}`);
    return lines.slice(0, maxLines);
  }
  return lines;
}

function readLines(value: unknown, issues: string[], maxLines: number): readonly string[] {
  return readLineList(value, issues, maxLines, DEFAULT_SIDEBAR_LINES, "sidebar.lines");
}

/**
 * The sidebar footer's fixed lines - empty by default since 0.8.1.
 *
 * Unlike the top rail, an explicitly empty list is meaningful: it removes the
 * footer's fixed lines (the live Go panel, `sidebar.footer.go`, can still claim
 * the slot). A non-empty list with no usable entries falls back to the (empty)
 * default, reported like every other bad value, and a runaway footer is capped
 * at `MAX_LINES` the way the top rail is.
 */
function readSidebarFooterLines(value: unknown, issues: string[]): readonly string[] {
  return readLineList(value, issues, MAX_LINES, DEFAULT_SIDEBAR_FOOTER_LINES, "sidebar.footer.lines");
}

/**
 * The sidebar footer Go panel: `true`/`false` or a look object.
 *
 * A boolean keeps working exactly as before (`true` enables with the default
 * look). An object enables with a custom look: absent keys fall back to
 * {@link DEFAULT_GO_PANEL_LOOK}, a malformed value is reported and ignored,
 * and unknown keys are ignored forward-compatibly. Anything else falls back
 * to `false`, loudly, like every other bad option. Never throws.
 */
/** Longest rename the panel honours per label; longer would eat the sidebar. */
const GO_LABEL_MAX_LENGTH = 24;

/** One rename: a non-empty string within the sidebar's label budget. */
function readGoLabel(value: unknown, fallback: string, path: string, issues: string[]): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string; using the default`);
    return fallback;
  }
  const text = value.trim();
  if (text.length === 0) {
    issues.push(`${path} must not be empty; using the default`);
    return fallback;
  }
  if (text.length > GO_LABEL_MAX_LENGTH) {
    issues.push(`${path} was longer than ${GO_LABEL_MAX_LENGTH} characters; using the default`);
    return fallback;
  }
  return text;
}

/** The three renames: each key optional, each falling back per-key. */
function readGoLabels(value: unknown, issues: string[]): GoPanelLook["labels"] {
  if (value === undefined) return DEFAULT_GO_PANEL_LOOK.labels;
  if (!isRecord(value)) {
    issues.push("sidebar.footer.go.labels must be an object; using the defaults");
    return DEFAULT_GO_PANEL_LOOK.labels;
  }
  return {
    rolling: readGoLabel(value["rolling"], DEFAULT_GO_PANEL_LOOK.labels.rolling, "sidebar.footer.go.labels.rolling", issues),
    weekly: readGoLabel(value["weekly"], DEFAULT_GO_PANEL_LOOK.labels.weekly, "sidebar.footer.go.labels.weekly", issues),
    monthly: readGoLabel(value["monthly"], DEFAULT_GO_PANEL_LOOK.labels.monthly, "sidebar.footer.go.labels.monthly", issues),
  };
}

/**
 * Where a trailing value sits inside its fixed-width cell.
 *
 * Only the three exact strings count: anything else present is malformed, so
 * the default comes back loudly. An absent key falls back silently, like
 * every other optional knob.
 */
function readGoAlign(value: unknown, issues: string[]): GoPanelLook["align"] {
  if (value === undefined) return DEFAULT_GO_PANEL_LOOK.align;
  if (value === "left" || value === "right" || value === "center") return value;
  issues.push('sidebar.footer.go.align must be "left", "right" or "center"; using "right"');
  return DEFAULT_GO_PANEL_LOOK.align;
}

function readFooterGo(value: unknown, issues: string[]): boolean | GoPanelLook {
  if (value === undefined) return DEFAULT_CONFIG.sidebar.footer.go;
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) {
    issues.push("sidebar.footer.go must be true, false or an object; using false");
    return false;
  }
  return {
    header: readBoolean(value["header"], DEFAULT_GO_PANEL_LOOK.header, "sidebar.footer.go.header", issues),
    barWidth: readNumber(
      value["barWidth"],
      DEFAULT_GO_PANEL_LOOK.barWidth,
      "sidebar.footer.go.barWidth",
      issues,
      1,
      40,
    ),
    labelWidth: readNumber(
      value["labelWidth"],
      DEFAULT_GO_PANEL_LOOK.labelWidth,
      "sidebar.footer.go.labelWidth",
      issues,
      5,
      24,
    ),
    percent: readBoolean(value["percent"], DEFAULT_GO_PANEL_LOOK.percent, "sidebar.footer.go.percent", issues),
    reset: readBoolean(value["reset"], DEFAULT_GO_PANEL_LOOK.reset, "sidebar.footer.go.reset", issues),
    align: readGoAlign(value["align"], issues),
    sweep: readBoolean(value["sweep"], DEFAULT_GO_PANEL_LOOK.sweep, "sidebar.footer.go.sweep", issues),
    labels: readGoLabels(value["labels"], issues),
    blink: readBoolean(value["blink"], DEFAULT_GO_PANEL_LOOK.blink, "sidebar.footer.go.blink", issues),
    blinkMs: readNumber(
      value["blinkMs"],
      DEFAULT_GO_PANEL_LOOK.blinkMs,
      "sidebar.footer.go.blinkMs",
      issues,
      200,
      5000,
    ),
  };
}

/**
 * Read the list of live fields to render.
 *
 * An unknown name is reported rather than silently dropped: otherwise a typo in
 * `sidebar.rows` looks identical to the host simply not having the data yet.
 * The `session` alias folds back to its canonical key `ses` silently, so the
 * list never carries two spellings of one row and every downstream consumer
 * (the `wants()` set, `railLines`' `field`, the `ses` click-copy and wrap mode)
 * keeps working unchanged.
 */
function readRows(value: unknown, issues: string[], maxLines: number): readonly string[] {
  if (value === undefined) return DEFAULT_SIDEBAR_ROWS;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push("sidebar.rows must be a non-empty array of field names; using the default rows");
    return DEFAULT_SIDEBAR_ROWS;
  }

  const rows: string[] = [];
  value.forEach((entry, index) => {
    const path = `sidebar.rows[${index}]`;
    if (typeof entry !== "string") {
      issues.push(`${path} must be a string; skipping it`);
      return;
    }
    // Control characters are normalized before matching, like every other
    // config string: `cache\n` is the `cache` row, not an unknown field.
    const name = normalizeText(entry, path, issues).toLowerCase();
    if (name.length === 0) {
      issues.push(`${path} is empty; skipping it`);
      return;
    }
    if (!isStatField(name)) {
      issues.push(`${path} is not a known field (${STAT_FIELDS.join(", ")}); skipping it`);
      return;
    }
    rows.push(canonicalField(name));
  });

  if (rows.length === 0) {
    issues.push("sidebar.rows had no usable entries; using the default rows");
    return DEFAULT_SIDEBAR_ROWS;
  }
  return rows.slice(0, maxLines);
}

/**
 * The cap on the whole rail, as a whole number of lines.
 *
 * `0` would not draw a small rail, it would draw nothing: anything below one
 * is a bad value, so the default comes back and the key is named.
 */
function readMaxLines(value: unknown, issues: string[]): number {
  return readNumber(value, MAX_LINES, "sidebar.maxLines", issues, 1, MAX_LINES);
}

/** Every config section that can be set from the file and overridden by the host. */
type SectionKey = "sidebar" | "footer" | "caution" | "layout" | "format" | "glyphs" | "style";

function sectionOf(options: Record<string, unknown>, key: SectionKey): Record<string, unknown> {
  const value = options[key];
  return isRecord(value) ? value : {};
}

/**
 * Read the ticker cadence.
 *
 * `0` is a deliberate value meaning "no ticker", so it must not be treated as a
 * missing setting.
 */
function readRefresh(value: unknown, issues: string[]): number {
  if (value === undefined) return DEFAULT_REFRESH_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    issues.push("refresh must be a number of milliseconds; using the default");
    return DEFAULT_REFRESH_MS;
  }
  if (value > MAX_REFRESH_MS) {
    issues.push(`refresh was longer than ${MAX_REFRESH_MS}ms; using ${MAX_REFRESH_MS}`);
    return MAX_REFRESH_MS;
  }
  // `0` is "off", not "as fast as possible", so it is deliberately not clamped.
  if (value > 0 && value < MIN_REFRESH_MS) {
    issues.push(`refresh was faster than ${MIN_REFRESH_MS}ms; using ${MIN_REFRESH_MS}`);
    return MIN_REFRESH_MS;
  }
  return value;
}

function mergeSection(
  file: Record<string, unknown>,
  host: Record<string, unknown>,
  key: SectionKey,
): unknown {
  const fileValue = file[key];
  const hostValue = host[key];
  // A malformed section from either source replaces the other and is reported
  // by resolveConfig, so the problem stays visible instead of being masked by
  // silently preferring the valid side.
  if (hostValue !== undefined && !isRecord(hostValue)) return hostValue;
  if (fileValue !== undefined && !isRecord(fileValue) && hostValue === undefined) return fileValue;
  return { ...sectionOf(file, key), ...sectionOf(host, key) };
}

/**
 * Merge the plugin's own config file with host-supplied options.
 *
 * Precedence is the host's `context.options` over the file, decided key by key,
 * so an installed host can override a single value without restating the rest.
 */
export function mergeOptions(fileOptions: unknown, hostOptions: unknown): Record<string, unknown> {
  const file = isRecord(fileOptions) ? fileOptions : {};
  const host = isRecord(hostOptions) ? hostOptions : {};
  return {
    ...file,
    ...host,
    sidebar: mergeSection(file, host, "sidebar"),
    footer: mergeSection(file, host, "footer"),
    caution: mergeSection(file, host, "caution"),
    layout: mergeSection(file, host, "layout"),
    format: mergeSection(file, host, "format"),
    glyphs: mergeSection(file, host, "glyphs"),
    style: mergeSection(file, host, "style"),
  };
}

/**
 * A non-negative whole number, or the default with a reported issue.
 *
 * Used for both seconds and counts: the validation is identical, and the path
 * in the message tells the reader which they are looking at.
 */
function readNumber(
  value: unknown,
  fallback: number,
  path: string,
  issues: string[],
  min: number,
  max: number = Number.POSITIVE_INFINITY,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path} must be a number; using the default`);
    return fallback;
  }
  if (value < min || value > max) {
    const limit = max === Number.POSITIVE_INFINITY ? `at least ${min}` : `between ${min} and ${max}`;
    issues.push(`${path} must be ${limit}; using the default`);
    return fallback;
  }
  return Math.floor(value);
}

function readLayout(section: Record<string, unknown>, issues: string[]): LayoutConfig {
  return {
    // The label column has to fit "caution" plus a space, and must not eat the
    // rail: six is the narrowest still legible, twenty-four is all of it.
    labelWidth: readNumber(section["labelWidth"], DEFAULT_LAYOUT.labelWidth, "layout.labelWidth", issues, 6, 24),
    barWidth: readNumber(section["barWidth"], DEFAULT_LAYOUT.barWidth, "layout.barWidth", issues, 1, 40),
    sparkWidth: readNumber(section["sparkWidth"], DEFAULT_LAYOUT.sparkWidth, "layout.sparkWidth", issues, 2, 64),
  };
}

/**
 * The duration style, as one of a fixed set of strings.
 *
 * Unlike a free-text value there is no sensible repair for a misspelled style:
 * the default is restored and the key named, like every other invalid option.
 */
function readDurationStyle(value: unknown, issues: string[]): DurationStyle {
  if (value === undefined) return DEFAULT_FORMAT.duration;
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "compact" || text === "spaced") return text;
  issues.push('format.duration must be "compact" or "spaced"; using the default');
  return DEFAULT_FORMAT.duration;
}

function readFormat(section: Record<string, unknown>, issues: string[]): FormatConfig {
  return { duration: readDurationStyle(section["duration"], issues) };
}

/**
 * One glyph, validated for width.
 *
 * A glyph wider than two cells pushes every row out of alignment, and a control
 * character can break the renderer outright — so both fall back rather than
 * being passed through.
 */
function readGlyph(value: unknown, fallback: string, path: string, issues: string[]): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string; using the default`);
    return fallback;
  }
  const text = value.trim();
  if (text.length === 0 || [...text].length > 2) {
    issues.push(`${path} must be one or two characters; using the default`);
    return fallback;
  }
  if (CONTROL_CHAR.test(text)) {
    issues.push(`${path} contained control characters; using the default`);
    return fallback;
  }
  return text;
}

function readGlyphs(section: Record<string, unknown>, issues: string[]): GlyphConfig {
  return {
    watch: readGlyph(section["watch"], DEFAULT_GLYPHS.watch, "glyphs.watch", issues),
    caution: readGlyph(section["caution"], DEFAULT_GLYPHS.caution, "glyphs.caution", issues),
    clear: readGlyph(section["clear"], DEFAULT_GLYPHS.clear, "glyphs.clear", issues),
  };
}

/**
 * One colour role, as named in the config.
 *
 * The vocabulary is fixed (`STYLE_COLORS`): a config names a role like
 * `warning`, never a raw theme token, so the mapping onto the host's actual
 * tokens stays in ./style.ts, where a host renaming its tokens can be absorbed.
 */
function readStyleColor(value: unknown, fallback: StyleColor, path: string, issues: string[]): StyleColor {
  if (value === undefined) return fallback;
  const text = typeof value === "string" ? value.trim() : "";
  if ((STYLE_COLORS as readonly string[]).includes(text)) return text as StyleColor;
  issues.push(`${path} must be one of ${STYLE_COLORS.join(", ")}; using ${fallback}`);
  return fallback;
}

/** Attribute names, validated one by one: an unknown name is skipped, not fatal. */
function readStyleAttributes(
  value: unknown,
  fallback: readonly StyleAttribute[],
  path: string,
  issues: string[],
): readonly StyleAttribute[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of attribute names; using the default`);
    return fallback;
  }
  const attributes: StyleAttribute[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (typeof entry !== "string") {
      issues.push(`${at} must be a string; skipping it`);
      return;
    }
    const name = entry.trim();
    if (!(STYLE_ATTRIBUTES as readonly string[]).includes(name)) {
      issues.push(`${at} is not a known attribute (${STYLE_ATTRIBUTES.join(", ")}); skipping it`);
      return;
    }
    attributes.push(name as StyleAttribute);
  });
  return attributes;
}

/**
 * One line's look; every field falls back independently.
 *
 * An entry that names only a colour keeps the attributes it inherited (and the
 * other way round), so a per-row override can change one thing about a row.
 */
function readLineStyle(value: unknown, fallback: LineStyle, path: string, issues: string[]): LineStyle {
  if (value === undefined) return fallback;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object with color and attributes; using the default`);
    return fallback;
  }
  return {
    color: readStyleColor(value["color"], fallback.color, `${path}.color`, issues),
    attributes: readStyleAttributes(value["attributes"], fallback.attributes, `${path}.attributes`, issues),
  };
}

/**
 * The `style` section: the fixed lines, the wildcard every live row inherits,
 * and per-row overrides.
 *
 * A per-row key must name a known field. That check is what keeps a typo
 * (`style.rows.costly`) from silently styling nothing: unknown names are
 * reported and skipped, exactly like `sidebar.rows`. The `session` alias
 * folds back to `ses`, so `style.rows.session` styles the `ses` row.
 */
function readStyle(section: Record<string, unknown>, issues: string[]): StyleConfig {
  const rawRows = section["rows"];
  if (rawRows !== undefined && !isRecord(rawRows)) {
    issues.push("style.rows must be an object of row names; using the default");
  }
  const rows = isRecord(rawRows) ? rawRows : {};

  const lines = readLineStyle(section["lines"], DEFAULT_STYLE.lines, "style.lines", issues);
  const wildcard = readLineStyle(rows["*"], DEFAULT_STYLE.rows.wildcard, "style.rows.*", issues);

  const overrides: Record<string, LineStyle> = {};
  for (const [key, entry] of Object.entries(rows)) {
    if (key === "*") continue;
    const path = `style.rows.${key}`;
    // Keyed like `sidebar.rows`: normalized for control characters and case,
    // so `"Cost"` is the `cost` row.
    const name = normalizeText(key, path, issues).toLowerCase();
    if (name.length === 0) {
      issues.push(`${path} is empty; skipping it`);
      continue;
    }
    if (!isStatField(name)) {
      issues.push(`${path} is not a known field (${STAT_FIELDS.join(", ")}); skipping it`);
      continue;
    }
    overrides[canonicalField(name)] = readLineStyle(entry, wildcard, path, issues);
  }

  return { lines, rows: { wildcard, overrides } };
}

/** Tool names, matched exactly. A malformed list falls back whole, not partly. */
function readToolNames(value: unknown, issues: string[]): readonly string[] {
  if (value === undefined) return DEFAULT_CAUTION.exemptTools;
  if (!Array.isArray(value)) {
    issues.push("caution.exemptTools must be an array of tool names; using the default");
    return DEFAULT_CAUTION.exemptTools;
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push("caution.exemptTools must contain only non-empty tool names; using the default");
      return DEFAULT_CAUTION.exemptTools;
    }
    names.push(entry.trim());
  }
  return names;
}

function readCaution(section: Record<string, unknown>, issues: string[]): CautionConfig {
  const toolWatchSeconds = readNumber(
    section["toolWatchSeconds"],
    DEFAULT_CAUTION.toolWatchSeconds,
    "caution.toolWatchSeconds",
    issues,
    0,
  );
  const turnWatchSeconds = readNumber(
    section["turnWatchSeconds"],
    DEFAULT_CAUTION.turnWatchSeconds,
    "caution.turnWatchSeconds",
    issues,
    0,
  );

  // A caution threshold at or below its watch threshold makes the escalating
  // state unreachable. Raise it and say so, rather than accept a config that
  // cannot do what it claims.
  let toolCautionSeconds = readNumber(
    section["toolCautionSeconds"],
    DEFAULT_CAUTION.toolCautionSeconds,
    "caution.toolCautionSeconds",
    issues,
    0,
  );
  let turnCautionSeconds = readNumber(
    section["turnCautionSeconds"],
    DEFAULT_CAUTION.turnCautionSeconds,
    "caution.turnCautionSeconds",
    issues,
    0,
  );
  if (toolCautionSeconds < toolWatchSeconds) {
    issues.push("caution.toolCautionSeconds is below caution.toolWatchSeconds; raised to match");
    toolCautionSeconds = toolWatchSeconds;
  }
  if (turnCautionSeconds < turnWatchSeconds) {
    issues.push("caution.turnCautionSeconds is below caution.turnWatchSeconds; raised to match");
    turnCautionSeconds = turnWatchSeconds;
  }

  return {
    enabled: readBoolean(section["enabled"], DEFAULT_CAUTION.enabled, "caution.enabled", issues),
    toolWatchSeconds,
    toolCautionSeconds,
    turnWatchSeconds,
    turnCautionSeconds,
    repeatThreshold: readNumber(
      section["repeatThreshold"],
      DEFAULT_CAUTION.repeatThreshold,
      "caution.repeatThreshold",
      issues,
      2,
    ),
    exemptTools: readToolNames(section["exemptTools"], issues),
    toast: readBoolean(section["toast"], DEFAULT_CAUTION.toast, "caution.toast", issues),
  };
}

/**
 * Turn raw, untrusted `context.options` into a complete config.
 *
 * Unknown keys are ignored (forward compatible), known keys are validated, and
 * any problem is both corrected and reported in `issues` so the plugin can warn
 * once instead of rendering a broken rail.
 */
export function resolveConfig(options: unknown): ConfigResolution {
  const issues: string[] = [];

  if (options === undefined || options === null) {
    return { config: DEFAULT_CONFIG, issues };
  }
  if (!isRecord(options)) {
    issues.push("plugin options must be an object; using defaults");
    return { config: DEFAULT_CONFIG, issues };
  }

  const rawSidebar = options.sidebar;
  const rawFooter = options.footer;
  const rawCaution = options.caution;
  const rawFormat = options.format;
  const rawStyle = options.style;
  if (rawSidebar !== undefined && !isRecord(rawSidebar)) {
    issues.push("sidebar must be an object; using defaults");
  }
  if (rawFooter !== undefined && !isRecord(rawFooter)) {
    issues.push("footer must be an object; using defaults");
  }
  if (rawCaution !== undefined && !isRecord(rawCaution)) {
    issues.push("caution must be an object; using defaults");
  }
  if (rawFormat !== undefined && !isRecord(rawFormat)) {
    issues.push("format must be an object; using defaults");
  }
  if (rawStyle !== undefined && !isRecord(rawStyle)) {
    issues.push("style must be an object; using defaults");
  }

  const sidebar = isRecord(rawSidebar) ? rawSidebar : {};
  const footer = isRecord(rawFooter) ? rawFooter : {};
  const caution = isRecord(rawCaution) ? rawCaution : {};
  const layout = isRecord(options.layout) ? options.layout : {};
  const format = isRecord(rawFormat) ? rawFormat : {};
  const glyphs = isRecord(options.glyphs) ? options.glyphs : {};
  const style = isRecord(rawStyle) ? rawStyle : {};

  // Writing any footer setting counts as asking for the footer, so the rail
  // turns on as soon as you configure it. It is off only when you said nothing
  // about it, and an explicit `enabled` always wins either way.
  const footerConfigured = Object.keys(footer).length > 0;

  const maxLines = readMaxLines(sidebar.maxLines, issues);
  // The sidebar footer is its own host slot with its own list; a malformed
  // section is reported and the default branding comes back.
  const rawSidebarFooter = sidebar.footer;
  if (rawSidebarFooter !== undefined && !isRecord(rawSidebarFooter)) {
    issues.push("sidebar.footer must be an object; using defaults");
  }
  const sidebarFooter = isRecord(rawSidebarFooter) ? rawSidebarFooter : {};
  const lines = readLines(sidebar.lines, issues, maxLines);
  const footerLines = readSidebarFooterLines(sidebarFooter.lines, issues);
  const rows = readRows(sidebar.rows, issues, maxLines);
  // `railLines` caps the whole rail at `sidebar.maxLines`, so the fixed lines
  // and the live rows draw from one budget. `readLines` already reports its own
  // cut; this is the other half, which used to be silent — a long `lines` list
  // ate live rows off the bottom of the rail without saying so.
  if (lines.length + rows.length > maxLines) {
    issues.push(
      `sidebar.lines and sidebar.rows total ${lines.length + rows.length} lines; the rail draws the first ${maxLines}`,
    );
  }

  return {
    config: {
      sidebar: {
        enabled: readBoolean(sidebar.enabled, DEFAULT_CONFIG.sidebar.enabled, "sidebar.enabled", issues),
        lines,
        footer: {
          lines: footerLines,
          // Independent of `lines`, and off by default like the other opt-in
          // machinery (`caution`, and the `go` row): the panel claims the slot
          // on its own, so `lines: []` no longer means "no footer at all".
          // `true` enables with the default look; an object enables with a
          // custom one.
          go: readFooterGo(sidebarFooter.go, issues),
        },
        rows,
        persist: readBoolean(sidebar.persist, DEFAULT_CONFIG.sidebar.persist, "sidebar.persist", issues),
        placeholder: readText(
          sidebar.placeholder,
          DEFAULT_CONFIG.sidebar.placeholder,
          "sidebar.placeholder",
          issues,
        ),
        maxLines,
      },
      footer: {
        enabled: readBoolean(footer.enabled, footerConfigured, "footer.enabled", issues),
        text: readText(footer.text, DEFAULT_CONFIG.footer.text, "footer.text", issues),
      },
      caution: readCaution(caution, issues),
      layout: readLayout(layout, issues),
      format: readFormat(format, issues),
      glyphs: readGlyphs(glyphs, issues),
      style: readStyle(style, issues),
      refresh: readRefresh(options.refresh, issues),
    },
    issues,
  };
}
