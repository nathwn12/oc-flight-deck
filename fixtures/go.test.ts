import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GO_CREDENTIAL_TIMEOUT_MS,
  GO_KEY,
  GO_KEY_ENV,
  GO_LOG_MAX_LINES,
  GO_NO_DATA_REASONS,
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

/** A credential entry shaped like `GET /api/credential` returns. */
function entry(integrationID: string, active: boolean, value: unknown) {
  return { id: `${integrationID}:${String(active)}`, integrationID, label: "test", active, value };
}

/** The `key`-type value a usable credential carries. */
const keyValue = (key: string) => ({ type: "key", key });

/** `fakeHost` plus a credential-store client, so the store path is exercised. */
function fakeHostWithStore(list: (() => Promise<unknown>) | undefined, initialValue: unknown = null) {
  const { host, state, seen } = fakeHost(initialValue);
  const withClient: GoHost = {
    storage: host.storage,
    client: list === undefined ? undefined : { credential: { list } },
  };
  return { host: withClient, state, seen };
}

/** `fakeHost` plus a provider collection, so the provider path is exercised. */
function fakeHostWithProvider(provider: unknown, initialValue: unknown = null) {
  const { host, state, seen } = fakeHost(initialValue);
  const withData: GoHost = {
    storage: host.storage,
    data: { location: { provider } },
  };
  return { host: withData, state, seen };
}

/** A `ProviderInfo` for the Go integration, carrying its resolved api key. */
function goProvider(apiKey: unknown) {
  return {
    id: "opencode-go",
    name: "Go",
    activation: "enabled",
    package: "opencode-go",
    settings: { apiKey },
  };
}

/** Run `body` with `OPENCODE_GO_API_KEY` set (or cleared), restoring it after. */
async function withEnvKey<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = process.env[GO_KEY_ENV];
  if (value === undefined) delete process.env[GO_KEY_ENV];
  else process.env[GO_KEY_ENV] = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env[GO_KEY_ENV];
    else process.env[GO_KEY_ENV] = saved;
  }
}

/** Capture the Authorization header of every request a bridge makes. */
function authDeps(auth: string[], payload: unknown = FLAT): GoDeps {
  return {
    fetchJson: async (_url: string, init: RequestInit) => {
      auth.push((init.headers as Record<string, string>)["Authorization"] ?? "");
      return payload;
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

  test("resolves the key from the host credential store", async () => {
    const { host } = fakeHostWithStore(async () => [entry("opencode-go", true, keyValue("store-key"))]);
    const auth: string[] = [];
    const bridge = startGoBridge(host, authDeps(auth), 1_000);
    await sleep(25);
    expect(auth).toContain("Bearer store-key");
    expect(bridge?.usage?.windows.length).toBe(3);
    bridge?.dispose();
  });

  test("prefers the active entry among matching credentials", async () => {
    const { host } = fakeHostWithStore(async () => [
      entry("opencode-go", false, keyValue("inactive-key")),
      entry("opencode-go", true, keyValue("active-key")),
    ]);
    const auth: string[] = [];
    const bridge = startGoBridge(host, authDeps(auth), 1_000);
    await sleep(25);
    expect(auth).toContain("Bearer active-key");
    expect(auth).not.toContain("Bearer inactive-key");
    bridge?.dispose();
  });

  test("ignores a credential whose value is not a key", async () => {
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: 1, methodID: "m" };
    const { host, state } = fakeHostWithStore(async () => [
      entry("opencode-go", true, oauth),
      entry("opencode-go", false, keyValue("later-key")),
    ]);
    const auth: string[] = [];
    const bridge = startGoBridge(host, authDeps(auth), 1_000);
    await sleep(25);
    // The non-`key` value is skipped, not selected: the usable entry is used.
    expect(auth).toContain("Bearer later-key");
    expect(state.value).not.toBeNull();
    bridge?.dispose();
  });

  test("stores null and makes no request when the only credential is not a key", async () => {
    await withEnvKey(undefined, async () => {
      const oauth = { type: "oauth", access: "a", refresh: "r", expires: 1, methodID: "m" };
      const { host, state } = fakeHostWithStore(async () => [entry("opencode-go", true, oauth)]);
      let fetches = 0;
      const bridge = startGoBridge(host, { fetchJson: async () => { fetches += 1; return FLAT; } }, 5);
      await sleep(25);
      expect(fetches).toBe(0);
      expect(state.value).toBeNull();
      bridge?.dispose();
    });
  });

  test("falls back to the env var when the store has no matching key", async () => {
    await withEnvKey("env-key", async () => {
      const { host } = fakeHostWithStore(async () => [entry("someone-else", true, keyValue("other-key"))]);
      const auth: string[] = [];
      const bridge = startGoBridge(host, authDeps(auth), 1_000);
      await sleep(25);
      expect(auth).toContain("Bearer env-key");
      bridge?.dispose();
    });
  });

  test("falls back to the env var on a host whose client has no credential.list", async () => {
    await withEnvKey("env-key", async () => {
      const { host } = fakeHostWithStore(undefined);
      const auth: string[] = [];
      const bridge = startGoBridge(host, authDeps(auth), 1_000);
      await sleep(25);
      expect(auth).toContain("Bearer env-key");
      bridge?.dispose();
    });
  });

  test("degrades to the env var when credential.list throws", async () => {
    await withEnvKey("env-key", async () => {
      const { host } = fakeHostWithStore(async () => {
        throw new Error("no store");
      });
      const auth: string[] = [];
      const bridge = startGoBridge(host, authDeps(auth), 1_000);
      await sleep(25);
      expect(auth).toContain("Bearer env-key");
      bridge?.dispose();
    });
  });

  test("stores null and makes no request when neither the store nor the env has a key", async () => {
    await withEnvKey(undefined, async () => {
      const { host, state } = fakeHostWithStore(async () => []);
      let fetches = 0;
      const bridge = startGoBridge(host, { fetchJson: async () => { fetches += 1; return FLAT; } }, 5);
      expect(bridge).toBeDefined();
      await sleep(25);
      expect(fetches).toBe(0);
      expect(state.value).toBeNull();
      expect(bridge?.usage).toBeUndefined();
      bridge?.dispose();
    });
  });

  test("lets an async resolveKey override win over the store", async () => {
    const { host } = fakeHostWithStore(async () => [entry("opencode-go", true, keyValue("store-key"))]);
    const auth: string[] = [];
    const bridge = startGoBridge(host, { ...authDeps(auth), resolveKey: async () => "override-key" }, 1_000);
    await sleep(25);
    expect(auth).toContain("Bearer override-key");
    expect(auth).not.toContain("Bearer store-key");
    bridge?.dispose();
  });

  test("records no-client when the credential client cannot be asked", async () => {
    await withEnvKey(undefined, async () => {
      // No `client` at all: the lookup never had a chance.
      const absent = fakeHost();
      const absentBridge = startGoBridge(absent.host, { fetchJson: async () => FLAT }, 1_000);
      await sleep(25);
      expect(absentBridge?.usage).toBeUndefined();
      expect(absentBridge?.reason).toBe("no-client");
      expect(absent.state.value).toBeNull();
      absentBridge?.dispose();

      // A client whose `list` throws is the same "could not ask" case.
      const thrown = fakeHostWithStore(async () => {
        throw new Error("no store");
      });
      const thrownBridge = startGoBridge(thrown.host, { fetchJson: async () => FLAT }, 1_000);
      await sleep(25);
      expect(thrownBridge?.reason).toBe("no-client");
      thrownBridge?.dispose();

      // A non-array answer is not a usable list either.
      const malformed = fakeHostWithStore(async () => "not-a-list");
      const malformedBridge = startGoBridge(malformed.host, { fetchJson: async () => FLAT }, 1_000);
      await sleep(25);
      expect(malformedBridge?.reason).toBe("no-client");
      malformedBridge?.dispose();
    });
  });

  test("records no-key when the store answers but holds no usable entry", async () => {
    await withEnvKey(undefined, async () => {
      // A different integration's credential is not ours.
      const other = fakeHostWithStore(async () => [entry("someone-else", true, keyValue("other-key"))]);
      const otherBridge = startGoBridge(other.host, { fetchJson: async () => FLAT }, 1_000);
      await sleep(25);
      expect(otherBridge?.reason).toBe("no-key");
      otherBridge?.dispose();

      // An empty list is the same: the store answered, there was nothing in it.
      const empty = fakeHostWithStore(async () => []);
      const emptyBridge = startGoBridge(empty.host, { fetchJson: async () => FLAT }, 1_000);
      await sleep(25);
      expect(emptyBridge?.reason).toBe("no-key");
      emptyBridge?.dispose();

      // An injected accessor that yields nothing is no-key too.
      const injected = fakeHost();
      const injectedBridge = startGoBridge(
        injected.host,
        { key: () => undefined, fetchJson: async () => FLAT },
        1_000,
      );
      await sleep(20);
      expect(injectedBridge?.reason).toBe("no-key");
      injectedBridge?.dispose();
    });
  });

  test("records http when the request fails and parse when the body is unusable", async () => {
    const http = fakeHost("stale");
    const httpBridge = startGoBridge(
      http.host,
      { key: () => "k", fetchJson: async () => { throw new Error("refused"); } },
      1_000,
    );
    await sleep(25);
    expect(httpBridge?.usage).toBeUndefined();
    expect(httpBridge?.reason).toBe("http");
    httpBridge?.dispose();

    const parse = fakeHost("stale");
    const parseBridge = startGoBridge(parse.host, { key: () => "k", fetchJson: async () => "nonsense" }, 1_000);
    await sleep(25);
    expect(parseBridge?.usage).toBeUndefined();
    expect(parseBridge?.reason).toBe("parse");
    parseBridge?.dispose();
  });

  test("clears the reason once a value lands", async () => {
    const { host } = fakeHost();
    const bridge = startGoBridge(host, { key: () => "k", fetchJson: async () => FLAT }, 1_000);
    await sleep(25);
    expect(bridge?.usage?.windows.length).toBe(3);
    expect(bridge?.reason).toBeUndefined();
    bridge?.dispose();
  });

  test("resolves a hung credential read to timeout and does not stall", async () => {
    await withEnvKey(undefined, async () => {
      const { host, state } = fakeHostWithStore(() => new Promise<unknown>(() => {}));
      const started = Date.now();
      const bridge = startGoBridge(host, { fetchJson: async () => FLAT, credentialTimeoutMs: 30 }, 1_000);
      await sleep(90);
      // The read never settles, yet the poll finished and named the cause.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(bridge?.usage).toBeUndefined();
      expect(bridge?.reason).toBe("timeout");
      expect(state.value).toBeNull();
      bridge?.dispose();
    });
  });

  test("accepts a bare array and the data/output envelopes from the credential store", async () => {
    await withEnvKey(undefined, async () => {
      const shapes: readonly { readonly value: unknown; readonly key: string }[] = [
        { value: [entry("opencode-go", true, keyValue("bare-key"))], key: "bare-key" },
        { value: { data: [entry("opencode-go", true, keyValue("data-key"))] }, key: "data-key" },
        { value: { output: [entry("opencode-go", true, keyValue("output-key"))] }, key: "output-key" },
      ];
      for (const shape of shapes) {
        const { host } = fakeHostWithStore(async () => shape.value);
        const auth: string[] = [];
        const bridge = startGoBridge(host, authDeps(auth), 1_000);
        await sleep(25);
        expect(auth).toContain(`Bearer ${shape.key}`);
        bridge?.dispose();
      }
    });
  });

  test("resolves the key from the provider catalog's settings.apiKey", async () => {
    await withEnvKey(undefined, async () => {
      // A `list()` collection.
      const listed = fakeHostWithProvider({ list: () => [goProvider("provider-list-key")] });
      const listAuth: string[] = [];
      const listBridge = startGoBridge(listed.host, authDeps(listAuth), 1_000);
      await sleep(25);
      expect(listAuth).toContain("Bearer provider-list-key");
      listBridge?.dispose();

      // A `get(id)` collection, wrapped in the RPC's `{ data }` envelope.
      const got = fakeHostWithProvider({
        get: (id: string) => (id === "opencode-go" ? { data: goProvider("provider-get-key") } : undefined),
      });
      const getAuth: string[] = [];
      const getBridge = startGoBridge(got.host, authDeps(getAuth), 1_000);
      await sleep(25);
      expect(getAuth).toContain("Bearer provider-get-key");
      getBridge?.dispose();
    });
  });

  test("uses the provider key only after the credential store yields none", async () => {
    await withEnvKey(undefined, async () => {
      const { host } = fakeHostWithStore(async () => [entry("opencode-go", true, keyValue("store-key"))]);
      // Same host shape plus a provider that also holds a key: the store wins.
      const both: GoHost = {
        storage: host.storage,
        client: host.client,
        data: { location: { provider: { list: () => [goProvider("provider-key")] } } },
      };
      const auth: string[] = [];
      const bridge = startGoBridge(both, authDeps(auth), 1_000);
      await sleep(25);
      expect(auth).toContain("Bearer store-key");
      expect(auth).not.toContain("Bearer provider-key");
      bridge?.dispose();
    });
  });

  test("uses the env var only after the store and the provider yield no key", async () => {
    await withEnvKey("env-key", async () => {
      // The provider holds a key: it wins over the env var.
      const { host: providerHost } = fakeHostWithProvider({ list: () => [goProvider("provider-key")] });
      const providerAuth: string[] = [];
      const providerBridge = startGoBridge(providerHost, authDeps(providerAuth), 1_000);
      await sleep(25);
      expect(providerAuth).toContain("Bearer provider-key");
      expect(providerAuth).not.toContain("Bearer env-key");
      providerBridge?.dispose();

      // Neither yields a key: the env var is the last resort.
      const { host: emptyHost } = fakeHostWithProvider({ list: () => [goProvider(undefined)] });
      const envAuth: string[] = [];
      const envBridge = startGoBridge(emptyHost, authDeps(envAuth), 1_000);
      await sleep(25);
      expect(envAuth).toContain("Bearer env-key");
      envBridge?.dispose();
    });
  });

  test("treats a numeric 1 as active and prefers it over an inactive entry", async () => {
    await withEnvKey(undefined, async () => {
      const numericActive = {
        id: "opencode-go:1",
        integrationID: "opencode-go",
        label: "test",
        active: 1,
        value: keyValue("numeric-active-key"),
      };
      const { host } = fakeHostWithStore(async () => [
        entry("opencode-go", false, keyValue("inactive-key")),
        numericActive,
      ]);
      const auth: string[] = [];
      const bridge = startGoBridge(host, authDeps(auth), 1_000);
      await sleep(25);
      expect(auth).toContain("Bearer numeric-active-key");
      expect(auth).not.toContain("Bearer inactive-key");
      bridge?.dispose();
    });
  });

  test("falls back to a non-active entry only when no entry is marked active", async () => {
    await withEnvKey(undefined, async () => {
      const { host } = fakeHostWithStore(async () => [
        { id: "opencode-go:0", integrationID: "opencode-go", label: "test", active: 0, value: keyValue("only-key") },
      ]);
      const auth: string[] = [];
      const bridge = startGoBridge(host, authDeps(auth), 1_000);
      await sleep(25);
      expect(auth).toContain("Bearer only-key");
      bridge?.dispose();
    });
  });

  test("names timeout and pending in the closed reason set, with a 6s credential bound", () => {
    expect(GO_NO_DATA_REASONS).toContain("timeout");
    expect(GO_NO_DATA_REASONS).toContain("pending");
    expect(GO_CREDENTIAL_TIMEOUT_MS).toBe(6_000);
  });

  test("writes one bounded observation line per poll and never the key", async () => {
    const { host } = fakeHostWithStore(async () => [entry("opencode-go", true, keyValue("secret-key-value"))]);
    const bridge = startGoBridge(host, authDeps([]), 1_000);
    await sleep(25);
    bridge?.dispose();

    const path = join(tmpdir(), "opencode", "flight-deck-go.log");
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("secret-key-value");
    expect(text).not.toContain("Bearer");
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(GO_LOG_MAX_LINES);
    const last = lines[lines.length - 1] ?? "";
    expect(last).toMatch(
      /^ts=\S+ src=(credential|provider|env|none) key=(yes|no) http=\S+ parse=\S+ reason=\S+$/,
    );
  });
});
