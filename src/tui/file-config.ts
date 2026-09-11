// Reads Flight Deck's own config file.
//
// The host's `context.options` is the official configuration channel, but not
// every host build forwards it (and `cli.json` may not allow comments). So the
// plugin also reads a small JSONC file from the project, which guarantees
// inline comments work everywhere. `context.options` still wins when present.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Searched in order, relative to the project directory; first hit wins. */
export const CONFIG_FILE_CANDIDATES: readonly string[] = [
  join(".opencode", "flight-deck.jsonc"),
  join(".opencode", "flight-deck.json"),
  "flight-deck.jsonc",
  "flight-deck.json",
];

/** Refuse to pull an unreasonable file into the TUI at startup. */
const MAX_CONFIG_BYTES = 64 * 1024;

export interface FileConfig {
  /** Parsed file contents, or undefined when no config file was found. */
  readonly options: unknown;
  /** Path of the file that was read, when one was. */
  readonly source?: string;
  /** Set when a file was found but was empty, unreadable, or unusable. */
  readonly issue?: string;
}

export function findConfigFile(directory: string): string | undefined {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = join(directory, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function parseJsonc(text: string): unknown {
  // Bun parses comments and trailing commas. Under a runtime without it we fall
  // back to strict JSON and let the caller report the parse failure.
  const jsonc = (globalThis as { Bun?: { JSONC?: { parse?: (value: string) => unknown } } }).Bun?.JSONC;
  if (typeof jsonc?.parse === "function") return jsonc.parse(text);
  return JSON.parse(text);
}

/**
 * Load the first config file that exists under `directory`.
 *
 * A missing file is normal and silent. A present-but-broken file is reported in
 * `issue` so the caller can warn once, and then behaves as if it were absent.
 * Only regular files under the size cap are read.
 */
export function loadConfigFile(directory: string): FileConfig {
  const source = findConfigFile(directory);
  if (source === undefined) return { options: undefined };

  try {
    const stats = statSync(source);
    if (!stats.isFile()) {
      return { options: undefined, source, issue: `${source} is not a regular file; using defaults` };
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      const limit = Math.floor(MAX_CONFIG_BYTES / 1024);
      return { options: undefined, source, issue: `${source} is larger than ${limit} KiB; using defaults` };
    }

    const text = readFileSync(source, "utf8");
    if (text.trim().length === 0) {
      return { options: undefined, source, issue: `${source} is empty; using defaults` };
    }
    const parsed: unknown = parseJsonc(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { options: undefined, source, issue: `${source} must contain a JSON object; using defaults` };
    }
    return { options: parsed, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { options: undefined, source, issue: `${source} could not be parsed (${message}); using defaults` };
  }
}
