// The host-clipboard seam, split from `./clipboard.ts` for one reason: the
// render tests mount the real JSX in a real headless renderer, where mocking
// the whole UI toolkit would break the renderer itself. This module is the
// only thing those tests replace, so they can stand in a fake host write while
// the renderer stays real.
//
// Production resolves to NO host backend: the plugin contract sanctions no
// host clipboard surface, so this factory returns `undefined` and the copy
// path degrades cleanly to the OSC52/no-backend outcomes (which are never
// reported as a verified copy). The `HostClipboardLike` shape is structural so
// a future sanctioned backend can plug in without touching the call site.

/** The subset of a host clipboard service the copy path uses. */
interface HostClipboardLike {
  writeText(text: string): Promise<{ readonly status: string }>;
}

/**
 * The default host clipboard factory: explicitly absent. Returning
 * `undefined` (rather than throwing) marks "no host service at all", so the
 * copy path reports `no-backend` when no renderer can take the OSC52 fallback
 * either.
 */
export function createHostClipboard(): HostClipboardLike | undefined {
  return undefined;
}
