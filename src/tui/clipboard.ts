// The one clipboard write in the plugin: a session id, copied on a gesture.
//
// The plugin Context exposes no clipboard member, so this reaches through the
// renderer OpenTUI already hands the plugin and writes OSC52 directly. That is
// not a sanctioned plugin API, so it is kept to a single narrow function and
// two rules hold it in place:
//
//   1. It is called only from an explicit mouse gesture on the `ses` row. There
//      is no render-time, background, or automatic write, ever.
//   2. A renderer that cannot take the write degrades to a no-op. A copy that
//      did not happen must never take the panel (or the click) down with it.
//
// `createRendererClipboardAdapter` is the OSC52 boundary: it reads the
// renderer's terminal capabilities and, unless OSC52 is reported unsupported,
// calls `renderer.copyToClipboardOSC52`. Wrapping it here keeps the rest of the
// rail from knowing the clipboard exists.

import { createRendererClipboardAdapter } from "@opentui/core";

type RendererBoundary = Parameters<typeof createRendererClipboardAdapter>[0];

/**
 * Write `text` to the terminal clipboard, or do nothing.
 *
 * Returns true only when the adapter attempted the write. An absent renderer, a
 * terminal without OSC52, or a renderer missing the OSC52 method all return
 * false without throwing.
 */
export function copyToClipboard(renderer: unknown, text: string): boolean {
  if (renderer === undefined || renderer === null) return false;
  try {
    const terminal = createRendererClipboardAdapter(renderer as RendererBoundary);
    return terminal.writeText(text, "clipboard").status === "attempted";
  } catch {
    return false;
  }
}

/**
 * The confirmation for a copy gesture, as a host-toast description.
 *
 * Split from {@link copyToClipboard} so the success and failure wordings are
 * pure and tested directly: a click must always report what actually happened,
 * and the two outcomes must never read alike. `ok` mirrors the attempted write.
 * The success text names the full `id` and says the copy was *sent* - an
 * `attempted` status only confirms the local dispatch to the terminal, not that
 * the terminal then copied - so a message never claims a write that was not
 * guaranteed. The failure text names the terminal's inability and carries no id
 * at all, because nothing was copied, so a silent no-op can never masquerade as
 * a success.
 */
export function copyFeedback(
  attempted: boolean,
  id: string,
): {
  readonly ok: boolean;
  readonly variant: "success" | "error";
  readonly message: string;
} {
  return attempted
    ? { ok: true, variant: "success", message: `Sent the full session id ${id} to the clipboard.` }
    : { ok: false, variant: "error", message: "This terminal cannot copy to the clipboard." };
}
