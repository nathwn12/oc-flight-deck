// The one clipboard write in the plugin: a session id, copied on a gesture.
//
// Two transports are available, and they are not equals:
//
//   1. The process host clipboard (`createHostClipboard`). This is a real write
//      through the OS clipboard, it resolves asynchronously, and it can report
//      `written` - a status that means the platform completed the copy. Only
//      this transport may ever be reported to the user as a success.
//   2. OSC52 through the renderer (`createRendererClipboardAdapter`). This is a
//      fire-and-forget escape sequence emitted on the terminal's wire. Its
//      `attempted` status confirms only that a local dispatch was issued - the
//      terminal is free to ignore it, and on this machine's Windows Terminal it
//      does, so an independent read still sees the old clipboard. It is kept as
//      a best-effort fallback and is NEVER reported as a verified copy.
//
// The gesture is still the one and only trigger: there is no render-time,
// background, or automatic write, ever. And nothing here may throw out of the
// caller's mouse handler: every backend call is wrapped, and a backend that is
// missing, refuses, or throws degrades to a definite non-success result.

import { createRendererClipboardAdapter } from "@opentui/core";
import { createHostClipboard } from "./host-clipboard.js";

type RendererBoundary = Parameters<typeof createRendererClipboardAdapter>[0];

/**
 * The outcome of a copy gesture.
 *
 * `verified` is true only when the host backend reported `written`. Every other
 * value - including an OSC52 dispatch that was merely issued - is false, so the
 * caller can never accidentally treat a best-effort attempt as a real copy.
 */
export interface CopyResult {
  /** True only for a verified host write. */
  readonly verified: boolean;
  /** How the copy was carried, or why it was not. */
  readonly outcome:
    | "written"
    | "unsupported"
    | "cancelled"
    | "timed-out"
    | "failed"
    | "osc52-dispatched"
    | "no-backend";
}

/** The subset of the host clipboard service this path uses. */
interface HostClipboardLike {
  writeText(text: string): Promise<{ readonly status: string }>;
}

/** A factory for the host clipboard; injectable so tests can stand in a fake. */
type HostClipboardFactory = () => HostClipboardLike;

/**
 * Determine the OSC52 dispatch outcome for `text`, or `false` when the
 * renderer cannot take it. Kept separate so the renderer type can stay
 * `unknown` at the public boundary.
 */
function dispatchOsc52(renderer: unknown, text: string): boolean {
  if (renderer === undefined || renderer === null) return false;
  try {
    const terminal = createRendererClipboardAdapter(renderer as RendererBoundary);
    return terminal.writeText(text, "clipboard").status === "attempted";
  } catch {
    return false;
  }
}

/**
 * Write `text` to the clipboard, preferring the verified host backend.
 *
 * Resolution:
 *   1. Try the host clipboard write and await it. `written` -> `verified: true`.
 *   2. If the host is unavailable or reports anything other than `written`, issue
 *      the OSC52 fallback and report `osc52-dispatched`. That is a best-effort
 *      dispatch, NOT a verified copy, so `verified` stays false.
 *   3. If neither transport can take the write, report `no-backend`.
 *
 * Never throws: a backend that rejects, is missing, or throws a synchronous
 * error collapses into a definite non-success result.
 *
 * @param renderer The host renderer, or `undefined` when the host gave none.
 * @param text The text to copy. Empty text is rejected by the host backend and
 *   degrades to the fallback rather than throwing.
 * @param createHost Optional factory for the host clipboard, for tests.
 */
export async function copyToClipboard(
  renderer: unknown,
  text: string,
  createHost: HostClipboardFactory = createHostClipboard,
): Promise<CopyResult> {
  // 1. The verified path: a real host write that can report back `written`.
  let hostReached = true;
  let hostStatus: string = "failed";
  try {
    const host = createHost();
    try {
      const result = await host.writeText(text);
      hostStatus = result.status;
    } catch {
      // The service exists but the write itself failed or rejected: a definite
      // host failure, never an exception out of this call.
      hostStatus = "failed";
    }
  } catch {
    // The factory itself threw: there is no host service at all.
    hostReached = false;
  }
  if (hostStatus === "written") return { verified: true, outcome: "written" };

  // 2. Best-effort fallback: dispatch OSC52 and never call it a verified copy.
  if (dispatchOsc52(renderer, text)) return { verified: false, outcome: "osc52-dispatched" };

  // 3. No transport took the write. Report it plainly by the host's own reason
  //    when the host was reachable, otherwise that there was no backend at all.
  if (!hostReached) return { verified: false, outcome: "no-backend" };
  const outcome =
    hostStatus === "unsupported" ||
    hostStatus === "cancelled" ||
    hostStatus === "timed-out" ||
    hostStatus === "failed"
      ? hostStatus
      : "failed";
  return { verified: false, outcome };
}

/**
 * The confirmation for a copy gesture, as a host-toast description.
 *
 * Split from {@link copyToClipboard} so the wordings are pure and tested
 * directly. Success is claimed ONLY for a verified host write, and only then
 * does the message name the full `id`. Every other outcome - an OSC52 dispatch
 * included - is a distinct non-success that does not claim the id is on the
 * clipboard: it is better to say the copy could not be confirmed than to imply
 * one that was never verified.
 */
export function copyFeedback(
  result: CopyResult,
  id: string,
): {
  readonly ok: boolean;
  readonly variant: "success" | "error";
  readonly message: string;
} {
  if (result.verified) {
    return { ok: true, variant: "success", message: `Copied the full session id ${id} to the clipboard.` };
  }
  switch (result.outcome) {
    case "osc52-dispatched":
      return {
        ok: false,
        variant: "error",
        message: "Sent the session id to the terminal, but could not confirm it was copied.",
      };
    case "unsupported":
      return { ok: false, variant: "error", message: "This terminal cannot copy to the clipboard." };
    case "cancelled":
      return { ok: false, variant: "error", message: "The clipboard copy was cancelled." };
    case "timed-out":
      return { ok: false, variant: "error", message: "The clipboard copy timed out." };
    case "failed":
      return { ok: false, variant: "error", message: "Could not copy the session id to the clipboard." };
    case "no-backend":
    default:
      return { ok: false, variant: "error", message: "No clipboard is available to copy the session id." };
  }
}
