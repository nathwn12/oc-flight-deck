import { describe, expect, test } from "bun:test";
import { copyFeedback, copyToClipboard, type CopyResult } from "../src/tui/clipboard.js";

// The copy path has two transports and only one of them can be verified:
//
//   1. the real host clipboard write, whose `written` status is the only thing
//      that may be reported to the user as a success; and
//   2. the OSC52 dispatch through the renderer, whose `attempted` status only
//      says a sequence was emitted - the terminal may ignore it entirely.
//
// These pin the properties that make the path honest and safe: success is
// claimed only for a verified host write, an OSC52 dispatch is never dressed up
// as one, and a backend that fails or is absent degrades to a definite
// non-success rather than throwing out of the caller's mouse handler.

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
    const result = await copyToClipboard(undefined, id, createHost);
    expect(result).toEqual({ verified: true, outcome: "written" });
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

  test("the production default has no host backend: OSC52-only fallback, unmocked", async () => {
    // No factory passed, so this exercises the real default
    // (`createHostClipboard`, explicitly absent): the only transport left is
    // the OSC52 dispatch through the renderer, which is never verified.
    const { renderer, writes } = recordingRenderer();
    const result = await copyToClipboard(renderer, id);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("osc52-dispatched");
    expect(writes).toEqual([id]);
    // And with no renderer either, the default path reports no backend.
    expect(await copyToClipboard(undefined, id)).toEqual({ verified: false, outcome: "no-backend" });
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
    // End to end on the production path (no host backend): the dispatch still
    // never reports a verified copy.
    const { renderer } = recordingRenderer();
    const result = await copyToClipboard(renderer, id);
    expect(result).toEqual({ verified: false, outcome: "osc52-dispatched" });
    expect(copyFeedback(result, id).variant).toBe("warning");
  });
});
