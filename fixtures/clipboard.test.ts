import { describe, expect, test } from "bun:test";
import { copyToClipboard } from "../src/tui/clipboard.js";

// The plugin Context exposes no clipboard member, so the copy path is a
// hand-rolled OSC52 write through the renderer OpenTUI already hands the
// plugin. It is not a sanctioned plugin API, so these pin the two safety
// properties that make it acceptable at all: it writes when, and only when, a
// gesture asks it to, and a renderer that cannot take the write degrades to a
// no-op instead of throwing out of a mouse handler.

/** A renderer that records what it was asked to copy, like a supported host. */
function recordingRenderer() {
  const writes: string[] = [];
  return {
    writes,
    renderer: {
      capabilities: { osc52_support: "supported", remote: false },
      copyToClipboardOSC52: (text: string) => {
        writes.push(text);
        return true;
      },
    },
  };
}

describe("the session-id copy path", () => {
  test("writes the exact full text once through the renderer's OSC52 boundary", () => {
    const { renderer, writes } = recordingRenderer();
    const id = "ses_abcdef1234567890";
    expect(copyToClipboard(renderer, id)).toBe(true);
    expect(writes).toEqual([id]);
  });

  test("does not attempt a write when the terminal reports OSC52 unsupported", () => {
    const writes: string[] = [];
    const renderer = {
      capabilities: { osc52_support: "unsupported", remote: false },
      copyToClipboardOSC52: (text: string) => {
        writes.push(text);
        return true;
      },
    };
    expect(copyToClipboard(renderer, "ses_x")).toBe(false);
    expect(writes).toEqual([]);
  });

  test("returns false without throwing when the renderer or OSC52 method is unavailable", () => {
    // No renderer at all, and a renderer with no capabilities or write method:
    // a click must never throw because the host cannot take the copy.
    expect(copyToClipboard(undefined, "ses_x")).toBe(false);
    expect(copyToClipboard({}, "ses_x")).toBe(false);
    expect(copyToClipboard({ capabilities: { osc52_support: "unknown" } }, "ses_x")).toBe(false);
  });
});
