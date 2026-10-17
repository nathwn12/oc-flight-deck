// The host-clipboard seam, split from `./clipboard.ts` for one reason: the
// render tests mount the real JSX in a real headless renderer, where mocking
// the whole UI toolkit would break the renderer itself. This module is the
// only thing those tests replace, so they can stand in a fake host write while
// the renderer stays real.
//
// Production uses the REAL host clipboard: `createHostClipboard` imported from
// `@opentui/core` resolves to the host's own core instance, because that
// specifier is host-served to plugins (the host rewrites it to its own copy)
// and `scripts/build.ts` keeps `@opentui/*` external, so nothing of theirs is
// ever bundled. The `HostClipboardLike` shape stays structural so tests can
// keep standing in a fake without importing the toolkit.

import { createHostClipboard as createCoreHostClipboard } from "@opentui/core";

/**
 * The subset of a host clipboard service the copy path uses.
 *
 * `writeText` carries the copy; `read` is the read-back the OSC52 fallback is
 * verified with. It is optional so a fake (or a future backend without reads)
 * can offer writes only — the copy path skips verification when it is absent
 * and reports the dispatch as unconfirmed rather than throwing. The options
 * mirror `@opentui/core`: `preferredTypes: ["text/plain"]` with
 * `selection: "clipboard"`, and on `status === "read"` the
 * `representation.bytes` hold the clipboard text as a `Uint8Array`.
 */
export interface HostClipboardLike {
  writeText(text: string): Promise<{ readonly status: string }>;
  read?(options: {
    readonly preferredTypes: readonly [string, ...string[]];
    readonly selection?: "clipboard" | "primary";
  }): Promise<{ readonly status: string; readonly representation?: { readonly bytes: Uint8Array } }>;
}

/**
 * The lazily created process-wide host clipboard service. One singleton per
 * module instance: creating it once avoids paying backend setup per click, and
 * every copy in the session shares the same OS handle.
 */
let cached: HostClipboardLike | undefined;
let attempted = false;

/**
 * The default host clipboard factory: the real host-served clipboard.
 *
 * Never throws: a backend that cannot even be constructed degrades to
 * `undefined` ("no host service at all"), so the copy path reports
 * `no-backend` when no renderer can take the OSC52 fallback either.
 *
 * The singleton is never disposed. It wraps process-wide OS clipboard state
 * owned by the host, not by this plugin — disposing it from here could break
 * the host's own clipboard — and a plugin reload re-imports a fresh module
 * instance with its own cache anyway, so nothing here can leak across one.
 */
export function createHostClipboard(): HostClipboardLike | undefined {
  if (attempted) return cached;
  attempted = true;
  try {
    cached = createCoreHostClipboard();
  } catch {
    cached = undefined;
  }
  return cached;
}
