// Configuration model for the cosmetic Flight Deck rail.
//
// Options arrive from the host through `context.options` — the `options` object
// on a plugin entry in `opencode.jsonc` / `cli.json`:
//
//   { "plugins": [{ "package": "oc-flight-deck", "options": { ... } }] }
//
// Everything is optional. Missing or invalid values fall back to the sane
// defaults below, so the rail always renders and a typo can never break the TUI.

import { isStatField, STAT_FIELDS } from "./stats.js";
import type { CautionThresholds } from "./caution.js";

export interface SidebarConfig {
  /** Show the sidebar rail. Default `true`. */
  readonly enabled: boolean;
  /** Fixed lines rendered above the live rows. Default `DEFAULT_SIDEBAR_LINES`. */
  readonly lines: readonly string[];
  /** Live session fields to render, top to bottom. Default `DEFAULT_SIDEBAR_ROWS`. */
  readonly rows: readonly string[];
}

export interface FooterConfig {
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

export interface CautionConfig {
  /** Show the caution annunciator. Default `true`. */
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
   * Calibrated against 53,672 real settled tool calls: at a 180-second watch
   * threshold, 307 calls exceed it — and 218 of those are these tools.
   * `subagent` alone accounts for 152, with a p99 of 14.7 minutes. A delegated
   * agent running a quarter of an hour is working as designed, and an
   * annunciator that lights on every delegation is one you learn to ignore.
   * With these exempt, 0.16% of real calls cross the threshold.
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
   * Silent when healthy, which is why it costs nothing visually.
   */
  readonly caution: CautionConfig;
  /** Geometry of a row. Every value has a sane default. */
  readonly layout: LayoutConfig;
  /** Glyphs for the annunciator, for terminals that render the defaults badly. */
  readonly glyphs: GlyphConfig;
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
export interface LayoutConfig {
  /** Width of the row label column. Default `10`. */
  readonly labelWidth: number;
  /** Cells in the context gauge. Default `10`. */
  readonly barWidth: number;
  /** Samples drawn in the sparkline. Default `12`. */
  readonly sparkWidth: number;
}

/**
 * The annunciator's glyphs.
 *
 * Configurable because this is the one row that has to read at a glance, and
 * some terminals render `⚠` as a box or the wrong width. Swapping it for `!` is
 * a worse-looking but working panel, which beats an unreadable one.
 */
export interface GlyphConfig {
  readonly watch: string;
  readonly caution: string;
  readonly clear: string;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  labelWidth: 10,
  barWidth: 10,
  sparkWidth: 12,
};

export const DEFAULT_GLYPHS: GlyphConfig = {
  watch: "▲",
  caution: "⚠",
  clear: "○",
};

export const DEFAULT_CAUTION: CautionConfig = {
  enabled: true,
  toolWatchSeconds: 180,
  toolCautionSeconds: 420,
  turnWatchSeconds: 600,
  turnCautionSeconds: 1200,
  repeatThreshold: 3,
  exemptTools: ["question", "task", "subagent", "agent", "delegate", "delegate_many", "delegate_task"],
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
 * Fixed lines shown above the live rows — branding only.
 *
 * The rail exists to show session state, so nothing here is filler: there is no
 * placeholder text to delete before it looks finished.
 */
export const DEFAULT_SIDEBAR_LINES: readonly string[] = [
  "✈ FLIGHT DECK",
  "─────────────────",
];

/**
 * Live fields shown by default, in reading order.
 *
 * Every one of these is read from the open session at render time, so a fresh
 * install shows real numbers with no configuration file at all.
 */
export const DEFAULT_SIDEBAR_ROWS: readonly string[] = [
  "caution",
  "status",
  "agent",
  "model",
  "branch",
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
  sidebar: { enabled: true, lines: DEFAULT_SIDEBAR_LINES, rows: DEFAULT_SIDEBAR_ROWS },
  footer: { enabled: false, text: DEFAULT_FOOTER_TEXT },
  caution: DEFAULT_CAUTION,
  layout: DEFAULT_LAYOUT,
  glyphs: DEFAULT_GLYPHS,
  refresh: DEFAULT_REFRESH_MS,
};

/** Layout guards: keep a hand-edited config from producing an unusable rail. */
export const MAX_LINES = 24;
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

export interface ConfigResolution {
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

function readLines(value: unknown, issues: string[]): readonly string[] {
  if (value === undefined) return DEFAULT_SIDEBAR_LINES;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push("sidebar.lines must be a non-empty array of strings; using the default lines");
    return DEFAULT_SIDEBAR_LINES;
  }

  const lines: string[] = [];
  value.forEach((entry, index) => {
    const path = `sidebar.lines[${index}]`;
    if (typeof entry !== "string") {
      issues.push(`${path} must be a string; skipping it`);
      return;
    }
    const text = normalizeText(entry, path, issues);
    if (text.length === 0) {
      issues.push(`${path} is empty; skipping it`);
      return;
    }
    if (text.length > MAX_LINE_LENGTH) {
      issues.push(`${path} was longer than ${MAX_LINE_LENGTH} characters; it was shortened`);
      lines.push(text.slice(0, MAX_LINE_LENGTH));
      return;
    }
    lines.push(text);
  });

  if (lines.length === 0) {
    issues.push("sidebar.lines had no usable entries; using the default lines");
    return DEFAULT_SIDEBAR_LINES;
  }
  if (lines.length > MAX_LINES) {
    issues.push(`sidebar.lines has ${lines.length} entries; keeping the first ${MAX_LINES}`);
    return lines.slice(0, MAX_LINES);
  }
  return lines;
}

/**
 * Read the list of live fields to render.
 *
 * An unknown name is reported rather than silently dropped: otherwise a typo in
 * `sidebar.rows` looks identical to the host simply not having the data yet.
 */
function readRows(value: unknown, issues: string[]): readonly string[] {
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
    const name = entry.trim().toLowerCase();
    if (!isStatField(name)) {
      issues.push(`${path} is not a known field (${STAT_FIELDS.join(", ")}); skipping it`);
      return;
    }
    rows.push(name);
  });

  if (rows.length === 0) {
    issues.push("sidebar.rows had no usable entries; using the default rows");
    return DEFAULT_SIDEBAR_ROWS;
  }
  return rows.slice(0, MAX_LINES);
}

/** Every config section that can be set from the file and overridden by the host. */
type SectionKey = "sidebar" | "footer" | "caution" | "layout" | "glyphs";

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
    glyphs: mergeSection(file, host, "glyphs"),
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
  if (rawSidebar !== undefined && !isRecord(rawSidebar)) {
    issues.push("sidebar must be an object; using defaults");
  }
  if (rawFooter !== undefined && !isRecord(rawFooter)) {
    issues.push("footer must be an object; using defaults");
  }
  if (rawCaution !== undefined && !isRecord(rawCaution)) {
    issues.push("caution must be an object; using defaults");
  }

  const sidebar = isRecord(rawSidebar) ? rawSidebar : {};
  const footer = isRecord(rawFooter) ? rawFooter : {};
  const caution = isRecord(rawCaution) ? rawCaution : {};
  const layout = isRecord(options.layout) ? options.layout : {};
  const glyphs = isRecord(options.glyphs) ? options.glyphs : {};

  // Writing any footer setting counts as asking for the footer, so the rail
  // turns on as soon as you configure it. It is off only when you said nothing
  // about it, and an explicit `enabled` always wins either way.
  const footerConfigured = Object.keys(footer).length > 0;

  return {
    config: {
      sidebar: {
        enabled: readBoolean(sidebar.enabled, DEFAULT_CONFIG.sidebar.enabled, "sidebar.enabled", issues),
        lines: readLines(sidebar.lines, issues),
        rows: readRows(sidebar.rows, issues),
      },
      footer: {
        enabled: readBoolean(footer.enabled, footerConfigured, "footer.enabled", issues),
        text: readText(footer.text, DEFAULT_CONFIG.footer.text, "footer.text", issues),
      },
      caution: readCaution(caution, issues),
      layout: readLayout(layout, issues),
      glyphs: readGlyphs(glyphs, issues),
      refresh: readRefresh(options.refresh, issues),
    },
    issues,
  };
}
