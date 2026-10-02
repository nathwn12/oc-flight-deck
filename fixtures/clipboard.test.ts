import { describe, expect, test } from "bun:test";
import { copyFeedback, copyToClipboard } from "../src/tui/clipboard.js";

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

// The click's confirmation is derived from the attempt, never assumed. These
// pin that a copy which happened is reported as one - naming the full id - and
// that a copy which did not happen is not: the two outcomes must differ, so a
// silent no-op cannot read as success.
describe("the copy confirmation", () => {
  const id = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";

  test("reports an attempted write as a success naming the full id", () => {
    const fb = copyFeedback(true, id);
    expect(fb.ok).toBe(true);
    expect(fb.variant).toBe("success");
    expect(fb.message).toContain(id);
  });

  test("reports a failed write as an error, with a message unlike the success one", () => {
    const success = copyFeedback(true, id);
    const failed = copyFeedback(false, id);
    expect(failed.ok).toBe(false);
    expect(failed.variant).toBe("error");
    // A failure must never carry the success wording: the user has to be able
    // to tell that nothing was copied.
    expect(failed.message).not.toBe(success.message);
    // Nothing was copied, so the failure must not name the id as if it had been.
    expect(failed.message).not.toContain(id);
  });
});
