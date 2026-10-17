import { describe, expect, test } from "bun:test";
import { copyFeedback, copyToClipboard, type CopyResult } from "../src/tui/clipboard.js";

// The copy path has two transports and a copy counts only when it is verified:
//
//   1. the real host clipboard write, whose `written` status is the only thing
//      that may be reported to the user as a success; and
//   2. the OSC52 dispatch through the renderer, which is verified by reading
//      the OS clipboard back through the same host service: an exact match is
//      a confirmed copy (`osc52-confirmed`), anything else stays advisory.
//
// These pin the properties that make the path honest and safe: success is
// claimed only for a verified copy, an unconfirmed OSC52 dispatch is never
// dressed up as one, and a backend that fails or is absent degrades to a
// definite non-success rather than throwing out of the caller's mouse handler.

/** A host clipboard factory whose write resolves to `status`. */
function hostReturning(status: string) {
  const writes: string[] = [];
  return {
    writes,
    createHost: () => ({
      writeText: async (text: string) => {
        writes.push(text);
        return { status };
      },
    }),
  };
}

/**
 * A host clipboard factory whose write resolves to `writeStatus` and whose
 * read returns `clipboardText` — or throws, or reports empty, so the read-back
 * polling can be pinned without a real clipboard.
 */
function hostWithReadBack(writeStatus: string, clipboardText: string | undefined | Error) {
  const writes: string[] = [];
  const reads: number[] = [];
  return {
    writes,
    reads,
    createHost: () => ({
      writeText: async (text: string) => {
        writes.push(text);
        return { status: writeStatus };
      },
      read: async () => {
        reads.push(1);
        if (clipboardText instanceof Error) throw clipboardText;
        if (clipboardText === undefined) return { status: "empty" };
        return {
          status: "read",
          representation: { mimeType: "text/plain", bytes: new TextEncoder().encode(clipboardText) },
        };
      },
    }),
  };
}

/** A host clipboard factory whose write rejects. */
function hostRejecting(error: Error) {
  return () => ({
    writeText: async (): Promise<{ status: string }> => {
      throw error;
    },
  });
}

/** A host clipboard factory that throws synchronously on construction. */
function hostThrowingOnCreate(error: Error) {
  return (): never => {
    throw error;
  };
}

/** A renderer that records what it was asked to dispatch, like a supported host. */
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

/** A host that never writes, so the OSC52 fallback is what an assertion tests. */
const unsupportedHost = () => ({ writeText: async () => ({ status: "unsupported" }) });

/** A host factory that throws: there is no host service at all. */
const noHost = (): { writeText: (text: string) => Promise<{ status: string }> } => {
  throw new Error("no host clipboard");
};

describe("the session-id copy path", () => {
  const id = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";

  test("reports a verified host write and passes the exact full text", async () => {
    const { createHost, writes } = hostReturning("written");
    const { renderer, writes: osc52 } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, createHost);
    expect(result).toEqual({ verified: true, outcome: "written" });
    expect(writes).toEqual([id]);
    // The verified path carried it: the OSC52 fallback was never reached.
    expect(osc52).toEqual([]);
  });

  test("a host write failure plus a confirmed OSC52 dispatch is a verified copy", async () => {
    // The host write reports anything but `written`, the renderer dispatches
    // OSC52, and the OS clipboard reads back the exact text: the dispatch
    // demonstrably landed, whatever the terminal claims.
    const { createHost, writes } = hostWithReadBack("unsupported", id);
    const { renderer, writes: osc52 } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, createHost);
    expect(result).toEqual({ verified: true, outcome: "osc52-confirmed" });
    expect(writes).toEqual([id]);
    expect(osc52).toEqual([id]);
  });

  test("a stale read-back keeps the dispatch advisory, never a verified copy", async () => {
    const { createHost } = hostWithReadBack("unsupported", "something else entirely");
    const { renderer } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, createHost);
    expect(result).toEqual({ verified: false, outcome: "osc52-dispatched" });
  });

  test("an empty clipboard keeps the dispatch advisory, never a verified copy", async () => {
    const { createHost } = hostWithReadBack("unsupported", undefined);
    const { renderer } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, createHost);
    expect(result).toEqual({ verified: false, outcome: "osc52-dispatched" });
  });

  test("a read-back that throws degrades to advisory, never a throw", async () => {
    const { createHost } = hostWithReadBack("unsupported", new Error("boom"));
    const { renderer } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, createHost);
    expect(result).toEqual({ verified: false, outcome: "osc52-dispatched" });
  });

  test("no host read surface means no verification, never a throw", async () => {
    // A host with writes only (like the render-test fake): the dispatch is
    // issued but cannot be confirmed, so it stays advisory.
    const { createHost } = hostReturning("unsupported");
    const { renderer, writes } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, createHost);
    expect(result).toEqual({ verified: false, outcome: "osc52-dispatched" });
    expect(writes).toEqual([id]);
  });

  test("an OSC52 dispatch is best-effort, never a verified copy", async () => {
    const { renderer, writes } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, unsupportedHost);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("osc52-dispatched");
    // The dispatch did happen, but that is not a success and must not be one.
    expect(writes).toEqual([id]);
  });

  test("reports no-backend when neither the host nor the renderer can copy", async () => {
    const result = await copyToClipboard(undefined, id, noHost);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("no-backend");
  });

  test("propagates each host non-written status distinctly", async () => {
    for (const status of ["unsupported", "cancelled", "timed-out", "failed"] as const) {
      const { createHost } = hostReturning(status);
      const result = await copyToClipboard(undefined, id, createHost);
      expect(result.verified).toBe(false);
      expect(result.outcome).toBe(status);
    }
  });

  test("a host write that rejects degrades to a non-success, never a throw", async () => {
    const result = await copyToClipboard(undefined, id, hostRejecting(new Error("boom")));
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("failed");
  });

  test("a host factory that throws synchronously degrades to no-backend, never a throw", async () => {
    // The service cannot even be constructed, so with no OSC52 renderer either
    // there is no transport at all. The point is that the throw never escapes.
    const result = await copyToClipboard(undefined, id, hostThrowingOnCreate(new Error("boom")));
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("no-backend");
  });

  test("returns a failure without throwing when the renderer cannot take OSC52", async () => {
    expect(await copyToClipboard(undefined, "ses_x", noHost)).toEqual({
      verified: false,
      outcome: "no-backend",
    });
    expect(await copyToClipboard({}, "ses_x", noHost)).toEqual({ verified: false, outcome: "no-backend" });
    expect(
      await copyToClipboard({ capabilities: { osc52_support: "unknown" } }, "ses_x", noHost),
    ).toEqual({ verified: false, outcome: "no-backend" });
  });

  test("does not fall back to OSC52 when the terminal reports it unsupported", async () => {
    const writes: string[] = [];
    const renderer = {
      capabilities: { osc52_support: "unsupported", remote: false },
      copyToClipboardOSC52: (text: string) => {
        writes.push(text);
        return true;
      },
    };
    const result = await copyToClipboard(renderer, "ses_x", unsupportedHost);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("unsupported");
    expect(writes).toEqual([]);
  });

  test("the production default has a stable singleton shape, never called here", async () => {
    // Shape only: constructing the service performs no clipboard I/O, and
    // neither `writeText` nor `read` is ever invoked in this suite.
    const { createHostClipboard } = await import("../src/tui/host-clipboard.js");
    const first = createHostClipboard();
    expect(first).toBeDefined();
    expect(typeof first?.writeText).toBe("function");
    expect(typeof first?.read).toBe("function");
    expect(createHostClipboard()).toBe(first);
  });

  test("a missing host service degrades to a non-success without a real backend", async () => {
    // Injected factory returning `undefined`: no real backend is touched, and
    // the OSC52 dispatch stays advisory, never a verified copy.
    const { renderer, writes } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, () => undefined);
    expect(result).toEqual({ verified: false, outcome: "osc52-dispatched" });
    expect(writes).toEqual([id]);
  });
});

// The click's confirmation is derived from the result, never assumed. These pin
// that a verified write is reported as a success - naming the full id - and
// that every other outcome is a distinct, honest non-success.
describe("the copy confirmation", () => {
  const id = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";
  const errorOutcomes = ["unsupported", "cancelled", "timed-out", "failed", "no-backend"] as const;

  test("reports only a verified write as a success naming the full id", () => {
    const fb = copyFeedback({ verified: true, outcome: "written" }, id);
    expect(fb.ok).toBe(true);
    expect(fb.variant).toBe("success");
    expect(fb.message).toContain(id);
    // A confirmed OSC52 dispatch is verified too, so it succeeds the same way.
    const confirmed = copyFeedback({ verified: true, outcome: "osc52-confirmed" }, id);
    expect(confirmed.ok).toBe(true);
    expect(confirmed.variant).toBe("success");
    expect(confirmed.message).toContain(id);
  });

  test("every genuine failure is an error that never claims the id was copied", () => {
    const success = copyFeedback({ verified: true, outcome: "written" }, id);
    const seen = new Set<string>([success.message]);
    for (const outcome of errorOutcomes) {
      const fb = copyFeedback({ verified: false, outcome } satisfies CopyResult, id);
      expect(fb.ok).toBe(false);
      expect(fb.variant).toBe("error");
      // No non-success may carry the success wording or name the id as copied.
      expect(fb.message).not.toBe(success.message);
      expect(fb.message).not.toContain(id);
      // Every outcome reads differently: a user can tell them apart.
      expect(seen.has(fb.message)).toBe(false);
      seen.add(fb.message);
    }
  });

  test("an osc52 dispatch is advisory, never an error and never a verified copy", async () => {
    const fb = copyFeedback({ verified: false, outcome: "osc52-dispatched" }, id);
    expect(fb.ok).toBe(false);
    expect(fb.variant).toBe("warning");
    // Truthful wording: sent, but unconfirmable - and never naming the id.
    expect(fb.message).not.toContain(id);
    expect(fb.message).not.toBe(copyFeedback({ verified: true, outcome: "written" }, id).message);
    // End to end with a write-only host (no read surface): the dispatch is
    // issued but cannot be confirmed, so it still never reports a verified
    // copy. The production default is intentionally not asserted here - this
    // machine's real clipboard may confirm the copy.
    const { renderer } = recordingRenderer();
    const result = await copyToClipboard(renderer, id, unsupportedHost);
    expect(result).toEqual({ verified: false, outcome: "osc52-dispatched" });
    expect(copyFeedback(result, id).variant).toBe("warning");
  });
});
