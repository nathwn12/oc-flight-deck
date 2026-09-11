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

export interface FlightDeckConfig {
  readonly sidebar: SidebarConfig;
  readonly footer: FooterConfig;
}

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
  "agent",
  "model",
  "branch",
  "cost",
  "total",
  "tokens",
  "cache",
  "context",
];

export const DEFAULT_FOOTER_TEXT = "Flight Deck";

export const DEFAULT_CONFIG: FlightDeckConfig = {
  sidebar: { enabled: true, lines: DEFAULT_SIDEBAR_LINES, rows: DEFAULT_SIDEBAR_ROWS },
  footer: { enabled: false, text: DEFAULT_FOOTER_TEXT },
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

function sectionOf(options: Record<string, unknown>, key: "sidebar" | "footer"): Record<string, unknown> {
  const value = options[key];
  return isRecord(value) ? value : {};
}

function mergeSection(file: Record<string, unknown>, host: Record<string, unknown>, key: "sidebar" | "footer"): unknown {
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
  if (rawSidebar !== undefined && !isRecord(rawSidebar)) {
    issues.push("sidebar must be an object; using defaults");
  }
  if (rawFooter !== undefined && !isRecord(rawFooter)) {
    issues.push("footer must be an object; using defaults");
  }

  const sidebar = isRecord(rawSidebar) ? rawSidebar : {};
  const footer = isRecord(rawFooter) ? rawFooter : {};

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
    },
    issues,
  };
}
