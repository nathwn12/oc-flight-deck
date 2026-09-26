import { describe, expect, test } from "bun:test";
import {
  GO_KEY,
  GO_KEY_ENV,
  GO_POLL_MS,
  GO_USAGE_URL,
  startGoBridge,
  type GoDeps,
  type GoHost,
} from "../src/tui/go.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FLAT = {
  rollingUsage: 950,
  rollingLimit: 1_000,
  weeklyUsage: 1,
  weeklyLimit: 10,
  monthlyUsage: 2,
  monthlyLimit: 10,
};

/** Plain-object host store holding the usage value, with write counting. */
function fakeHost(initialValue: unknown = null) {
  const state: { value: unknown } = { value: initialValue };
  const seen: { keys: string[]; writes: number } = { keys: [], writes: 0 };
  const host: GoHost = {
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
  };
  return { host, state, seen };
}

/** A deps bundle that counts key reads and fetch calls and never hits the net. */
function countingDeps(payload: () => unknown, calls: string[] = []): GoDeps {
  return {
    key: () => {
      calls.push("key");
      return "test-key";
    },
    fetchJson: async (url: string) => {
      calls.push(url);
      return payload();
    },
  };
}

describe("go bridge", () => {
  test("keeps its constants fixed and namespaced", () => {
    expect(GO_KEY).toBe("flight-deck.go");
    expect(GO_POLL_MS).toBe(60_000);
    expect(GO_USAGE_URL).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(GO_KEY_ENV).toBe("OPENCODE_GO_API_KEY");
  });

  test("degrades to undefined when the host store is unusable", () => {
    expect(startGoBridge(undefined, countingDeps(() => FLAT), 5)).toBeUndefined();
    expect(startGoBridge({}, countingDeps(() => FLAT), 5)).toBeUndefined();
    expect(startGoBridge({ storage: {} } as GoHost, countingDeps(() => FLAT), 5)).toBeUndefined();
    expect(
      startGoBridge(
        { storage: { memory: () => { throw new Error("no store"); } } },
        countingDeps(() => FLAT),
        5,
      ),
    ).toBeUndefined();
    for (const returned of [undefined, {}, "nonsense", [undefined], [{ value: null }], [{ value: null }, null], [null, () => {}]]) {
      const host = { storage: { memory: () => returned } } as unknown as GoHost;
      expect(startGoBridge(host, countingDeps(() => FLAT), 5)).toBeUndefined();
    }
  });

  test("writes null and makes no request when the key is absent or empty", async () => {
    const calls: string[] = [];
    for (const missing of [undefined, ""]) {
      const { host, state, seen } = fakeHost("stale");
      const bridge = startGoBridge(host, { key: () => missing, fetchJson: async () => { calls.push("fetch"); return FLAT; } }, 5);
      expect(bridge).toBeDefined();
      expect(seen.keys).toEqual([GO_KEY]);
      await sleep(25);
      expect(calls).toEqual([]);
      expect(state.value).toBeNull();
      expect(bridge?.usage).toBeUndefined();
      bridge?.dispose();
    }
  });

  test("reads a key loaded after startup, per poll", async () => {
    let key: string | undefined;
    const { host, state } = fakeHost();
    const bridge = startGoBridge(host, { key: () => key, fetchJson: async () => FLAT }, 5);
    await sleep(20);
    expect(state.value).toBeNull();
    key = "late";
    await sleep(25);
    expect(bridge?.usage?.windows.length).toBe(3);
    bridge?.dispose();
  });

  test("normalizes an OK payload into the store", async () => {
    const { host, state, seen } = fakeHost();
    const calls: string[] = [];
    const bridge = startGoBridge(host, countingDeps(() => FLAT, calls), 1_000);
    await sleep(25);
    expect(calls).toContain("key");
    expect(calls).toContain(GO_USAGE_URL);
    expect(bridge?.usage?.windows.map((w) => w.id)).toEqual(["5h", "1w", "1m"]);
    expect((state.value as { windows: unknown[] } | null)?.windows.length).toBe(3);
    expect(seen.writes).toBeGreaterThan(0);
    bridge?.dispose();
  });

  test("writes null for a non-OK response on the default fetch path", async () => {
    const originalFetch = globalThis.fetch;
    const { host, state } = fakeHost();
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      const bridge = startGoBridge(host, { key: () => "k" }, 1_000);
      await sleep(25);
      expect(state.value).toBeNull();
      expect(bridge?.usage).toBeUndefined();
      bridge?.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("writes null when the request throws or is refused", async () => {
    const { host, state } = fakeHost("stale");
    const bridge = startGoBridge(
      host,
      { key: () => "k", fetchJson: async () => { throw new Error("refused"); } },
      1_000,
    );
    await sleep(25);
    expect(state.value).toBeNull();
    expect(bridge?.usage).toBeUndefined();
    bridge?.dispose();
  });

  test("writes null when the payload is unusable", async () => {
    const { host, state } = fakeHost("stale");
    const bridge = startGoBridge(host, { key: () => "k", fetchJson: async () => "nonsense" }, 1_000);
    await sleep(25);
    expect(state.value).toBeNull();
    bridge?.dispose();
  });

  test("never throws when the key accessor throws", async () => {
    const { host, state } = fakeHost();
    const bridge = startGoBridge(
      host,
      { key: () => { throw new Error("no env"); }, fetchJson: async () => FLAT },
      1_000,
    );
    expect(bridge).toBeDefined();
    await sleep(20);
    expect(state.value).toBeNull();
    expect(() => bridge?.usage).not.toThrow();
    bridge?.dispose();
  });

  test("dispose stops polling", async () => {
    const { host } = fakeHost();
    const calls: string[] = [];
    const bridge = startGoBridge(host, countingDeps(() => FLAT, calls), 5);
    await sleep(30);
    const fetches = calls.filter((call) => call === GO_USAGE_URL).length;
    expect(fetches).toBeGreaterThan(0);
    bridge?.dispose();
    const frozen = calls.length;
    await sleep(30);
    expect(calls.length).toBe(frozen);
    expect(() => bridge?.dispose()).not.toThrow();
  });

  test("a pending poll never writes after disposal", async () => {
    const { host, state } = fakeHost();
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const bridge = startGoBridge(host, { key: () => "k", fetchJson: () => gate }, 1_000);
    expect(state.value).toBeNull();
    bridge?.dispose();
    release(FLAT);
    await sleep(20);
    expect(state.value).toBeNull();
    expect(bridge?.usage).toBeUndefined();
  });

  test("only the newest overlapping poll may write", async () => {
    const { host, state } = fakeHost();
    let calls = 0;
    const bridge = startGoBridge(
      host,
      {
        key: () => "k",
        fetchJson: async () => {
          calls += 1;
          if (calls === 1) {
            await sleep(50);
            return { rollingUsage: 999, rollingLimit: 1_000 };
          }
          return FLAT;
        },
      },
      5,
    );
    // The first poll is slow; timer polls overlap and finish first. The stale
    // near-limit payload must never overwrite the newer, healthier one.
    await sleep(80);
    expect(bridge?.usage?.windows[0]?.ratio).toBe(0.95);
    expect((state.value as { windows?: unknown[] } | null)?.windows?.length ?? 0).toBe(3);
    bridge?.dispose();
  });

  test("reads whatever the host store currently holds, defensively", () => {
    const { host, state } = fakeHost();
    const bridge = startGoBridge(host, { key: () => "k", fetchJson: async () => FLAT }, 1_000);
    state.value = FLAT;
    expect(bridge?.usage?.windows[0]?.ratio).toBe(0.95);
    state.value = "garbage";
    expect(bridge?.usage).toBeUndefined();
    state.value = null;
    expect(bridge?.usage).toBeUndefined();
    bridge?.dispose();
  });
});
