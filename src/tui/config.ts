// Configuration model for the cosmetic Flight Deck rail.
//
// Options arrive from the host through `context.options` — the `options` object
// on a plugin entry in `opencode.jsonc` / `cli.json`:
//
//   { "plugins": [{ "package": "oc-flight-deck", "options": { ... } }] }
//
// Everything is optional. Missing or invalid values fall back to the sane
// defaults below, so the rail always renders and a typo can never break the TUI.

export interface SidebarConfig {
  /** Show the sidebar rail. Default `true`. */
  readonly enabled: boolean;
  /** Lines rendered top to bottom beside a session. Default `DEFAULT_SIDEBAR_LINES`. */
  readonly lines: readonly string[];
}

export interface FooterConfig {
  /** Show the prompt-footer rail. Default `true`. */
  readonly enabled: boolean;
  /** Footer text. Default `DEFAULT_FOOTER_TEXT`. */
  readonly text: string;
}

export interface FlightDeckConfig {
  readonly sidebar: SidebarConfig;
  readonly footer: FooterConfig;
}

/** The brand mark and tagline shown by default. */
export const DEFAULT_SIDEBAR_LINES: readonly string[] = [
  "✈ FLIGHT DECK",
  "─────────────",
  "visual rail",
  "cosmetic build",
];

export const DEFAULT_FOOTER_TEXT = "Flight Deck · cosmetic rail";

export const DEFAULT_CONFIG: FlightDeckConfig = {
  sidebar: { enabled: true, lines: DEFAULT_SIDEBAR_LINES },
  footer: { enabled: true, text: DEFAULT_FOOTER_TEXT },
};

/** Layout guards: keep a hand-edited config from producing an unusable rail. */
const MAX_LINES = 24;
const MAX_LINE_LENGTH = 120;

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
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push(`${path} must not be empty; using the default`);
    return fallback;
  }
  return trimmed.length > MAX_LINE_LENGTH ? trimmed.slice(0, MAX_LINE_LENGTH) : trimmed;
}

function readLines(value: unknown, issues: string[]): readonly string[] {
  if (value === undefined) return DEFAULT_SIDEBAR_LINES;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push("sidebar.lines must be a non-empty array of strings; using the default lines");
    return DEFAULT_SIDEBAR_LINES;
  }

  const lines: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      issues.push(`sidebar.lines[${index}] must be a string; skipping it`);
      return;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      issues.push(`sidebar.lines[${index}] is empty; skipping it`);
      return;
    }
    lines.push(trimmed.length > MAX_LINE_LENGTH ? trimmed.slice(0, MAX_LINE_LENGTH) : trimmed);
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

  return {
    config: {
      sidebar: {
        enabled: readBoolean(sidebar.enabled, DEFAULT_CONFIG.sidebar.enabled, "sidebar.enabled", issues),
        lines: readLines(sidebar.lines, issues),
      },
      footer: {
        enabled: readBoolean(footer.enabled, DEFAULT_CONFIG.footer.enabled, "footer.enabled", issues),
        text: readText(footer.text, DEFAULT_CONFIG.footer.text, "footer.text", issues),
      },
    },
    issues,
  };
}
