// The footer Go panel's live look.
//
// `sidebar.footer.go` used to be resolved once at setup, which froze the
// panel's look until the next client restart: editing `flight-deck.jsonc`
// never re-ran setup, so the running panel kept its old look. This reader
// re-resolves the look from the file at render time, without reading or
// parsing per frame: each render cheap-stats the file (mtime + size) and
// re-reads + re-parses only when either moved. The last good look is cached,
// so a missing, unreadable, or malformed file keeps the panel exactly as it
// was and never throws out of a render.
//
// No host subscription: the plugin API (`context.data.on`) does offer a
// `config.updated` event, but that fires for the host's own config documents,
// never for this plugin's file — and the event stream is volatile by
// contract (a slow consumer misses events). The footer already repaints on
// the ticker, so one stat rides a render that happens anyway: no extra timer,
// no missed change. Host-supplied options keep their setup precedence by
// construction — every re-read merges through the same
// `mergeOptions(file, host)` + `resolveConfig` path setup uses.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { mergeOptions, resolveConfig } from "./config.js";
import { CONFIG_FILE_CANDIDATES, globalConfigDirectory, loadConfigFile } from "./file-config.js";

export interface GoLookReader {
  /** The current look for `goPanelLines`' `layout`: `undefined` or a `GoPanelLook`. Never throws. */
  readonly current: () => unknown;
  /** Times the file was re-read + re-parsed since creation. Exposed for tests. */
  readonly reads: () => number;
}

/** First config candidate that exists in `directory`, mirroring `loadConfigFile`. */
function findCandidate(directory: string): string | undefined {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = join(directory, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** The cheap per-render probe: mtime + size, or `undefined` when unstatable. */
function snapshotOf(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return undefined;
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return undefined;
  }
}

/** The `layout` shape `goPanelLines` takes: `true` means its own defaults. */
function layoutOf(go: unknown): unknown {
  return go === true ? undefined : typeof go === "object" && go !== null ? go : undefined;
}

/**
 * Watch `sidebar.footer.go` in `directory` (default the global config
 * directory), starting from the setup-resolved `initial` look.
 *
 * `hostOptions` is the setup `context.options`, merged on every re-read so
 * host-forwarded options keep precedence exactly as at setup. Only a file the
 * loader accepts (present, regular, sized, parseable as an object) replaces
 * the cached look; anything else keeps it.
 */
export function createGoLookReader(input: {
  readonly directory?: string;
  readonly hostOptions?: unknown;
  readonly initial: unknown;
}): GoLookReader {
  const directory = input.directory ?? globalConfigDirectory();
  const hostOptions = input.hostOptions;
  let look: unknown = input.initial;
  let reads = 0;

  // Primed so the first render takes the cheap path when nothing changed.
  // Neither probe throws (`existsSync` returns false on error; `snapshotOf`
  // catches), so creation is as safe as a render.
  let seenPath: string | undefined = findCandidate(directory);
  let seen: { mtimeMs: number; size: number } | undefined =
    seenPath === undefined ? undefined : snapshotOf(seenPath);

  const current = (): unknown => {
    try {
      const path = findCandidate(directory);
      if (path === undefined) {
        seenPath = undefined;
        seen = undefined;
        return look;
      }
      const snap = snapshotOf(path);
      if (snap === undefined) {
        // Gone or unstatable between the scan and the stat: keep the look.
        seenPath = undefined;
        seen = undefined;
        return look;
      }
      if (seenPath === path && seen !== undefined && snap.mtimeMs === seen.mtimeMs && snap.size === seen.size) {
        return look;
      }
      // The file moved: re-read + re-parse, then re-stat so a write landing
      // mid-parse is itself a change the next render picks up.
      const loaded = loadConfigFile(directory);
      reads += 1;
      seenPath = path;
      seen = snapshotOf(path) ?? snap;
      if (loaded.options === undefined) return look;
      const { config } = resolveConfig(mergeOptions(loaded.options, hostOptions));
      look = layoutOf(config.sidebar.footer.go);
      return look;
    } catch {
      return look;
    }
  };

  return { current, reads: () => reads };
}
