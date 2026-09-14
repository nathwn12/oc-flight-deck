// Reads Flight Deck's own config file.
//
// The host's `context.options` is the official configuration channel, but not
// every host build forwards it (and `cli.json` may not allow comments). So the
// plugin also reads a small global JSONC file, which guarantees inline comments
// work everywhere. `context.options` still wins when present.
//
// There is exactly one config file, in the user's config directory. There is no
// per-project channel: what the rail shows cannot change with the directory the
// host happens to open.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Searched in order inside `globalConfigDirectory()`; first hit wins. Both
 * candidates live in the same directory — one file configures every session.
 */
export const CONFIG_FILE_CANDIDATES: readonly string[] = ["flight-deck.jsonc", "flight-deck.json"];

/**
 * The one directory Flight Deck reads its config from: `$XDG_CONFIG_HOME/opencode`
 * when that variable holds an absolute path, else `~/.config/opencode`. A
 * relative value is ignored, as the XDG base directory spec requires — otherwise
 * the lookup would resolve against the host's working directory.
 */
export function globalConfigDirectory(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  return xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)
    ? join(xdg, "opencode")
    : join(homedir(), ".config", "opencode");
}

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

/**
 * Find the first config file that exists in `directory`, which defaults to the
 * global config directory. A missing directory simply has no candidates.
 */
export function findConfigFile(directory: string = globalConfigDirectory()): string | undefined {
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
 * Load the first config file that exists in `directory`, which defaults to the
 * global config directory (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`).
 * There is no per-project lookup.
 *
 * A missing file is normal and silent. A present-but-broken file is reported in
 * `issue` so the caller can warn once, and then behaves as if it were absent.
 * Only regular files under the size cap are read.
 */
export function loadConfigFile(directory: string = globalConfigDirectory()): FileConfig {
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
