// Reads Flight Deck's own config file.
//
// The host's `context.options` is the official configuration channel, but not
// every host build forwards it (and `cli.json` may not allow comments). So the
// plugin also reads a small JSONC file from the project, which guarantees
// inline comments work everywhere. `context.options` still wins when present.
//
// Parsing uses `Bun.JSONC.parse`, which tolerates comments and trailing commas.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Searched in order, relative to the project directory; first hit wins. */
export const CONFIG_FILE_CANDIDATES: readonly string[] = [
  join(".opencode", "flight-deck.jsonc"),
  join(".opencode", "flight-deck.json"),
  "flight-deck.jsonc",
  "flight-deck.json",
];

export interface FileConfig {
  /** Parsed file contents, or undefined when no config file was found. */
  readonly options: unknown;
  /** Path of the file that was read, when one was. */
  readonly source?: string;
  /** Set when a file was found but was empty or could not be parsed. */
  readonly issue?: string;
}

export function findConfigFile(directory: string): string | undefined {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = join(directory, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Load the first config file that exists under `directory`.
 *
 * A missing file is normal and silent. A present-but-broken file is reported in
 * `issue` so the caller can warn once, and then behaves as if it were absent.
 */
export function loadConfigFile(directory: string): FileConfig {
  const source = findConfigFile(directory);
  if (source === undefined) return { options: undefined };

  try {
    const text = readFileSync(source, "utf8");
    if (text.trim().length === 0) {
      return { options: undefined, source, issue: `${source} is empty; using defaults` };
    }
    const parsed: unknown = Bun.JSONC.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { options: undefined, source, issue: `${source} must contain a JSON object; using defaults` };
    }
    return { options: parsed, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { options: undefined, source, issue: `${source} could not be parsed (${message}); using defaults` };
  }
}
