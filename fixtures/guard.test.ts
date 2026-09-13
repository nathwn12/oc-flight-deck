import { describe, expect, test } from "bun:test";
import {
  GUARD_CONTRACT,
  GUARD_KEY,
  GUARD_POLL_MS,
  normalizeGuardStatus,
  startGuardBridge,
  type GuardDeps,
  type GuardHost,
} from "../src/tui/guard.js";
import { statLine, statRows } from "../src/tui/stats.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HEALTHY = {
  airworthiness: { available: true, checks: 3, findings: 0, counts: 0 },
  warden: { available: true, children: 0, budgets: 0, breaches: 0, orphans: 0 },
  flightPlan: { available: true, goalPresent: true, planPresent: true, logPresent: false, blockChars: 12 },
};

/** Plain-object host store holding the guard value, with write counting. */
function fakeHost(initialValue: unknown = null) {
  const state: { value: unknown } = { value: initialValue };
  const seen: { keys: string[]; writes: number } = { keys: [], writes: 0 };
  const host: GuardHost = {
    storage: {
      memory: (key: string, options: { readonly initial: { value: unknown } }) => {
        seen.keys.push(key);
        state.value = options.initial.value;
        return [
          state,
          (mutation: (draft: { value: unknown }) => void) => {
            seen.writes += 1;
            mutation(state);
          },
        ];
      },
    },
    client: {},
  };
  return { host, state, seen };
}

function depsReturning(payload: unknown, calls: string[] = []): GuardDeps {
  return {
    status: async ({ sessionID }: { readonly sessionID: string }) => {
      calls.push(sessionID);
      // Return a deep copy so a test cannot mutate the fixture through the store.
      return JSON.parse(JSON.stringify(payload)) as unknown;
    },
  };
}

describe("guard row tokens", () => {
  test("renders ok when every source is available and quiet", () => {
    expect(statLine("guard", { guard: HEALTHY })).toBe("guard     ok");
  });

  test("renders the worst signal first: breach, then orphan, then finding", () => {
    const breach = {
      ...HEALTHY,
      warden: { available: true, breaches: 2, orphans: 1 },
      airworthiness: { available: true, findings: 3 },
    };
    expect(statLine("guard", { guard: breach })).toBe("guard     2 breach");

    const orphan = {
      ...HEALTHY,
      warden: { available: true, breaches: 0, orphans: 1 },
      airworthiness: { available: true, findings: 3 },
    };
    expect(statLine("guard", { guard: orphan })).toBe("guard     1 orphan");

    const finding = { ...HEALTHY, airworthiness: { available: true, findings: 3 } };
    expect(statLine("guard", { guard: finding })).toBe("guard     3 finding");
  });

  test("renders a singular breach count of one", () => {
    const one = { ...HEALTHY, warden: { available: true, breaches: 1, orphans: 0 } };
    expect(statLine("guard", { guard: one })).toBe("guard     1 breach");
  });

  test("renders unknown when any usable section reports unavailable", () => {
    expect(statLine("guard", { guard: { ...HEALTHY, warden: { available: false } } })).toBe(
      "guard     unknown",
    );
    expect(statLine("guard", { guard: { airworthiness: { available: false } } })).toBe(
      "guard     unknown",
    );
    expect(statLine("guard", { guard: { flightPlan: { available: false } } })).toBe(
      "guard     unknown",
    );
    // Unavailable outranks a breach elsewhere: without the full picture the
    // row must not claim to know the worst signal.
    const breachPlusDown = {
      airworthiness: { available: true, findings: 5 },
      warden: { available: false },
    };
    expect(statLine("guard", { guard: breachPlusDown })).toBe("guard     unknown");
  });

  test("renders no row when there is no usable data", () => {
    for (const guard of [undefined, null, 42, "ok", [], {}, { airworthiness: {} }, { warden: { breaches: 1 } }]) {
      expect(statLine("guard", { guard })).toBeUndefined();
      expect(statLine("guard", {})).toBeUndefined();
    }
    // Missing or garbage `available` drops the section; with nothing usable
    // left there is no row, not a false ok.
    expect(statLine("guard", { guard: { airworthiness: { findings: 2 } } })).toBeUndefined();
    expect(statLine("guard", { guard: { warden: { available: "yes", breaches: 2 } } })).toBeUndefined();
  });

  test("counts arrays by length and floors numbers", () => {
    expect(statLine("guard", { guard: { airworthiness: { available: true, findings: [1, 2] } } })).toBe(
      "guard     2 finding",
    );
    expect(statLine("guard", { guard: { warden: { available: true, breaches: 2.7 } } })).toBe(
      "guard     2 breach",
    );
  });

  test("treats garbage counts as zero rather than throwing or printing them", () => {
    const garbage = {
      airworthiness: { available: true, findings: Number.NaN },
      warden: { available: true, breaches: -1, orphans: "x" },
    };
    expect(statLine("guard", { guard: garbage })).toBe("guard     ok");
  });

  test("keeps the label separated from the value at a narrow width", () => {
    expect(statLine("guard", { guard: HEALTHY }, { labelWidth: 8 })).toBe("guard   ok");
    expect(statLine("guard", { guard: { warden: { available: true, breaches: 1 } } }, { labelWidth: 8 })).toBe(
      "guard   1 breach",
    );
  });

  test("is ascii, short, and unpadded", () => {
    for (const guard of [
      HEALTHY,
      { warden: { available: true, breaches: 12 } },
      { warden: { available: true, orphans: 3 } },
      { airworthiness: { available: true, findings: 7 } },
      { warden: { available: false } },
    ]) {
      const line = statLine("guard", { guard });
      expect(line).toMatch(/^guard\s+\S/);
      expect(line).toMatch(/^[\x00-\x7F]*$/);
      // The longest realistic token still fits the rail budget with room.
      expect(line!.length).toBeLessThanOrEqual(24);
    }
  });

  test("persists like every other row", () => {
    expect(statRows(["guard"], {}, { persist: true })).toEqual(["guard     —"]);
    expect(statRows(["guard"], {}, { persist: true, placeholder: "n/a" })).toEqual(["guard     n/a"]);
    expect(statRows(["guard"], {})).toEqual([]);
    expect(statRows(["guard"], { guard: HEALTHY }, { persist: true })).toEqual(["guard     ok"]);
  });

  test("never throws on hostile input", () => {
    const hostile = [null, 0, "", [], {}, { guard: () => {} }, { guard: { warden: { available: true, breaches: 1n } } }];
    for (const source of hostile) {
      expect(() => statLine("guard", (source ?? {}) as never)).not.toThrow();
    }
    // The getter sits on a path `guardToken` actually reads (`warden`, and a
    // count inside it), so this proves the read path is defensive — not just
    // that an unread property is ignored.
    expect(() => statLine("guard", { guard: { get warden() { throw new Error("x"); } } })).not.toThrow();
    expect(statLine("guard", { guard: { get warden() { throw new Error("x"); } } })).toBeUndefined();
    expect(
      () => statLine("guard", { guard: { warden: { available: true, get breaches() { throw new Error("x"); } } } }),
    ).not.toThrow();
  });

  test("abbreviates huge counts so the token stays short and ascii", () => {
    expect(statLine("guard", { guard: { warden: { available: true, breaches: 1_500_000 } } })).toBe(
      "guard     1.5M breach",
    );
    expect(statLine("guard", { guard: { warden: { available: true, orphans: 12_000 } } })).toBe(
      "guard     12k orphan",
    );
    expect(statLine("guard", { guard: { airworthiness: { available: true, findings: 2_500_000 } } })).toBe(
      "guard     2.5M finding",
    );
    for (const line of [
      statLine("guard", { guard: { warden: { available: true, breaches: 9_999_999_999 } } }),
      statLine("guard", { guard: { airworthiness: { available: true, findings: 1_000_000_000 } } }),
    ]) {
      expect(line).toMatch(/^[\x00-\x7F]*$/);
      expect(line!.length).toBeLessThanOrEqual(24);
    }
  });
});

describe("guard normalization", () => {
  test("mirrors the harness-guard contract id and method", () => {
    expect(GUARD_CONTRACT.id).toBe("harness-guard");
    expect(Object.keys(GUARD_CONTRACT.methods)).toEqual(["status"]);
    expect(GUARD_CONTRACT.events).toEqual({});
  });

  test("keeps its store key namespaced and its poll on a dedicated cadence", () => {
    expect(GUARD_KEY).toBe("flight-deck.guard");
    expect(GUARD_POLL_MS).toBe(10_000);
  });

  test("rejects garbage top levels", () => {
    for (const value of [undefined, null, 0, "x", [], [1], 42]) {
      expect(normalizeGuardStatus(value)).toBeUndefined();
    }
    expect(normalizeGuardStatus({})).toBeUndefined();
  });

  test("rejects NaN and negatives without throwing", () => {
    const normalized = normalizeGuardStatus({
      airworthiness: { available: true, findings: Number.NaN },
      warden: { available: true, breaches: -2, orphans: Number.POSITIVE_INFINITY },
    });
    expect(normalized).toBeDefined();
    expect(normalized?.airworthiness?.findings).toBe(0);
    expect(normalized?.warden?.breaches).toBe(0);
    expect(normalized?.warden?.orphans).toBe(0);
  });

  test("floors fractional counts", () => {
    const normalized = normalizeGuardStatus({
      airworthiness: { available: true, findings: 2.9 },
      warden: { available: true, breaches: 1.2, orphans: 0.7 },
    });
    expect(normalized?.airworthiness?.findings).toBe(2);
    expect(normalized?.warden?.breaches).toBe(1);
    expect(normalized?.warden?.orphans).toBe(0);
  });

  test("reads booleans only via explicit true", () => {
    expect(normalizeGuardStatus({ warden: { available: 1, breaches: 0 } })).toBeUndefined();
    expect(normalizeGuardStatus({ warden: { available: "true", breaches: 0 } })).toBeUndefined();
    expect(normalizeGuardStatus({ warden: { available: true, breaches: 0 } })?.warden?.available).toBe(true);
    expect(normalizeGuardStatus({ warden: { available: false } })?.warden?.available).toBe(false);
  });

  test("never throws on hostile payloads", () => {
    expect(() =>
      normalizeGuardStatus({ get airworthiness() { throw new Error("x"); } }),
    ).not.toThrow();
    expect(normalizeGuardStatus({ get airworthiness() { throw new Error("x"); } })).toBeUndefined();
  });
});

describe("guard bridge", () => {
  test("degrades to undefined when the host store is unusable", () => {
    expect(startGuardBridge(undefined, depsReturning(HEALTHY), 5)).toBeUndefined();
    expect(startGuardBridge({}, depsReturning(HEALTHY), 5)).toBeUndefined();
    expect(startGuardBridge({ storage: {} } as GuardHost, depsReturning(HEALTHY), 5)).toBeUndefined();
    expect(
      startGuardBridge(
        { storage: { memory: () => { throw new Error("no store"); } } },
        depsReturning(HEALTHY),
        5,
      ),
    ).toBeUndefined();
    for (const returned of [undefined, {}, "nonsense", [undefined], [{ value: null }], [{ value: null }, null], [null, () => {}]]) {
      const host = { storage: { memory: () => returned } } as unknown as GuardHost;
      expect(startGuardBridge(host, depsReturning(HEALTHY), 5)).toBeUndefined();
    }
  });

  test("starts with no data and writes the poll result", async () => {
    const { host, seen } = fakeHost();
    const bridge = startGuardBridge(host, depsReturning(HEALTHY), 5);
    expect(bridge).toBeDefined();
    expect(bridge?.status).toBeUndefined();
    expect(seen.keys).toEqual([GUARD_KEY]);

    bridge?.follow("ses_a");
    await sleep(30);
    expect(bridge?.status?.warden?.available).toBe(true);
    expect(statLine("guard", { guard: bridge?.status })).toBe("guard     ok");
    bridge?.dispose();
  });

  test("recovers from refused and malformed output", async () => {
    let mode: "ok" | "refused" | "garbage" = "ok";
    const deps: GuardDeps = {
      status: async () => {
        if (mode === "refused") throw new Error("refused");
        if (mode === "garbage") return "nonsense";
        return HEALTHY;
      },
    };
    const { host } = fakeHost();
    const bridge = startGuardBridge(host, deps, 5);
    bridge?.follow("ses_a");
    await sleep(30);
    expect(bridge?.status).toBeDefined();

    mode = "refused";
    // Force a re-poll on a new session: the follow fetches immediately.
    bridge?.follow("ses_b");
    await sleep(30);
    expect(bridge?.status).toBeUndefined();

    mode = "garbage";
    bridge?.follow("ses_c");
    await sleep(30);
    expect(bridge?.status).toBeUndefined();

    mode = "ok";
    bridge?.follow("ses_d");
    await sleep(30);
    expect(bridge?.status?.warden?.available).toBe(true);
    bridge?.dispose();
  });

  test("keeps polling an unavailable RPC so a late install appears", async () => {
    const { host } = fakeHost();
    // No deps and no client rpc: every poll writes null, but the bridge stays.
    const bridge = startGuardBridge(host, undefined, 5);
    expect(bridge).toBeDefined();
    bridge?.follow("ses_a");
    await sleep(30);
    expect(bridge?.status).toBeUndefined();
    bridge?.dispose();
  });

  test("follows only session changes", async () => {
    const calls: string[] = [];
    const { host } = fakeHost();
    const bridge = startGuardBridge(host, depsReturning(HEALTHY, calls), 50);
    bridge?.follow("ses_a");
    await sleep(30);
    const first = calls.length;
    expect(first).toBeGreaterThanOrEqual(1);

    // Same session: no immediate re-fetch.
    bridge?.follow("ses_a");
    await sleep(10);
    expect(calls.length).toBe(first);

    bridge?.follow("ses_b");
    await sleep(30);
    expect(calls).toContain("ses_b");
    bridge?.dispose();
  });

  test("dispose clears the timer", async () => {
    const { host, seen } = fakeHost();
    const bridge = startGuardBridge(host, depsReturning(HEALTHY), 5);
    bridge?.follow("ses_a");
    await sleep(30);
    expect(seen.writes).toBeGreaterThan(0);
    bridge?.dispose();
    const frozen = seen.writes;
    const status = bridge?.status;
    await sleep(30);
    expect(seen.writes).toBe(frozen);
    expect(bridge?.status).toEqual(status);
    expect(() => bridge?.dispose()).not.toThrow();
  });

  test("never throws into the caller or the render", async () => {
    const { host } = fakeHost();
    const failing: GuardDeps = { status: async () => { throw new Error("refused"); } };
    const bridge = startGuardBridge(host, failing, 5);
    expect(() => bridge?.follow("ses_a")).not.toThrow();
    expect(() => bridge?.follow(undefined)).not.toThrow();
    expect(() => bridge?.follow("")).not.toThrow();
    expect(() => bridge?.status).not.toThrow();
    await sleep(20);
    expect(() => bridge?.status).not.toThrow();
    expect(bridge?.status).toBeUndefined();
    bridge?.dispose();

    // A store that starts failing mid-run stops the timer instead of raising.
    let calls = 0;
    const flaky: GuardHost = {
      storage: {
        memory: () => {
          const store = { value: null as unknown };
          return [store, () => { calls += 1; throw new Error("store closed"); }];
        },
      },
    };
    const shaky = startGuardBridge(flaky, depsReturning(HEALTHY), 5);
    expect(shaky).toBeDefined();
    shaky?.follow("ses_a");
    await sleep(30);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(() => shaky?.status).not.toThrow();
    shaky?.dispose();
  });

  test("reads whatever the host store currently holds, defensively", () => {
    const { host, state } = fakeHost();
    const bridge = startGuardBridge(host, depsReturning(HEALTHY), 1_000);
    state.value = HEALTHY;
    expect(bridge?.status?.warden?.breaches).toBe(0);
    state.value = { warden: { available: true, breaches: 2 } };
    expect(statLine("guard", { guard: bridge?.status })).toBe("guard     2 breach");
    state.value = "garbage";
    expect(bridge?.status).toBeUndefined();
    state.value = null;
    expect(bridge?.status).toBeUndefined();
    bridge?.dispose();
  });

  test("invokes the real-client rpc factory directly, never via .call", async () => {
    // The real client builds `client.rpc` as
    // `Object.assign(makeRpc(...), raw.rpc)`, so the callable factory carries
    // a `.call` property (the raw `rpc.call` endpoint) that shadows
    // `Function.prototype.call`. The bridge must invoke the factory directly.
    const factoryInputs: unknown[] = [];
    const remoteInputs: string[] = [];
    let callPropHits = 0;
    const fakeRpc = ((definition: unknown) => {
      factoryInputs.push(definition);
      return {
        status: async (input: { readonly sessionID: string }) => {
          remoteInputs.push(input.sessionID);
          return HEALTHY;
        },
      };
    }) as unknown as ((definition: unknown) => unknown) & { call: unknown };
    (fakeRpc as { call: unknown }).call = (..._args: unknown[]) => {
      callPropHits += 1;
      throw new Error("must not use .call on the rpc factory");
    };
    const { host } = fakeHost();
    (host as { client: unknown }).client = { rpc: fakeRpc };
    const bridge = startGuardBridge(host, undefined, 1_000);
    expect(bridge).toBeDefined();
    bridge?.follow("ses_real");
    await sleep(30);
    expect(factoryInputs.length).toBeGreaterThanOrEqual(1);
    expect(factoryInputs[0]).toBe(GUARD_CONTRACT);
    expect(callPropHits).toBe(0);
    expect(remoteInputs).toContain("ses_real");
    expect(bridge?.status?.warden?.available).toBe(true);
    bridge?.dispose();
  });

  test("a pending poll never writes after disposal", async () => {
    const { host, state } = fakeHost();
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const bridge = startGuardBridge(host, { status: () => gate }, 1_000);
    bridge?.follow("ses_a");
    // The immediate clear wrote null; the gated poll is still in flight.
    expect(state.value).toBeNull();
    bridge?.dispose();
    release(HEALTHY);
    await sleep(20);
    expect(state.value).toBeNull();
    expect(bridge?.status).toBeUndefined();
  });

  test("only the newest overlapping poll for a session may write", async () => {
    const { host, state } = fakeHost();
    let calls = 0;
    const deps: GuardDeps = {
      status: async () => {
        calls += 1;
        if (calls === 1) {
          await sleep(50);
          return { warden: { available: true, breaches: 9 } };
        }
        return HEALTHY;
      },
    };
    const bridge = startGuardBridge(host, deps, 5);
    bridge?.follow("ses_a");
    // The first poll is slow; timer polls overlap and finish first with the
    // healthy payload. The stale breach must never overwrite them.
    await sleep(80);
    expect(bridge?.status?.warden?.breaches).toBe(0);
    expect(statLine("guard", { guard: bridge?.status })).toBe("guard     ok");
    expect((state.value as { warden?: { breaches?: number } } | null)?.warden?.breaches ?? 0).toBe(0);
    bridge?.dispose();
  });

  test("a stale A response cannot overwrite after A→B→A", async () => {
    const { host } = fakeHost();
    const pending: Array<{ sessionID: string; resolve: (value: unknown) => void }> = [];
    const deps: GuardDeps = {
      status: ({ sessionID }: { readonly sessionID: string }) =>
        new Promise<unknown>((resolve) => {
          pending.push({ sessionID, resolve });
        }),
    };
    const bridge = startGuardBridge(host, deps, 1_000);
    bridge?.follow("ses_a");
    bridge?.follow("ses_b");
    bridge?.follow("ses_a");
    expect(pending.map((entry) => entry.sessionID)).toEqual(["ses_a", "ses_b", "ses_a"]);
    const breachy = { warden: { available: true, breaches: 4 } };
    // Resolve newest first, then stale ones out of order.
    pending[2]!.resolve(HEALTHY);
    await sleep(10);
    expect(bridge?.status?.warden?.breaches).toBe(0);
    pending[0]!.resolve(breachy);
    await sleep(10);
    expect(bridge?.status?.warden?.breaches).toBe(0);
    pending[1]!.resolve(breachy);
    await sleep(10);
    expect(bridge?.status?.warden?.breaches).toBe(0);
    expect(statLine("guard", { guard: bridge?.status })).toBe("guard     ok");
    bridge?.dispose();
  });

  test("a failing store on the missing-RPC path stops the timer", async () => {
    let writes = 0;
    const failing: GuardHost = {
      storage: {
        memory: () => {
          const store = { value: null as unknown };
          return [
            store,
            () => {
              writes += 1;
              throw new Error("store closed");
            },
          ];
        },
      },
      client: {},
    };
    const bridge = startGuardBridge(failing, undefined, 5);
    expect(bridge).toBeDefined();
    bridge?.follow("ses_a");
    await sleep(30);
    // Without the fix this keeps failing on every tick; stopped means one write.
    expect(writes).toBe(1);
    bridge?.dispose();
  });

  test("a failing store on follow(undefined) stops the timer", async () => {
    let writes = 0;
    const { host } = fakeHost();
    const state: { value: unknown } = { value: null };
    const flaky: GuardHost = {
      storage: {
        memory: () => [
          state,
          () => {
            writes += 1;
            throw new Error("store closed");
          },
        ],
      },
      client: {},
    };
    void host;
    const bridge = startGuardBridge(flaky, depsReturning(HEALTHY), 5);
    bridge?.follow("ses_a");
    await sleep(20);
    const afterFollow = writes;
    expect(afterFollow).toBeGreaterThanOrEqual(1);
    bridge?.follow(undefined);
    await sleep(30);
    // No further timer writes after the failing clear stopped it.
    expect(writes).toBe(afterFollow + 1);
    bridge?.dispose();
  });
});
