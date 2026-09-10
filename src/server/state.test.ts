import { describe, expect, test } from "bun:test";
import { DEFAULT_FLIGHT_DECK_CONFIG, mergeFlightDeckConfig } from "../config/schema.js";
import type { FlightDeckConfigPatch } from "../config/schema.js";
import { FlightDeckState, storageKeyPrefix, type StorageLike } from "./state.js";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, unknown>();
  async get(key: string): Promise<unknown> { return this.values.get(key); }
  async set(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async remove(key: string): Promise<void> { this.values.delete(key); }
  async scan(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }> {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = options.after ? Math.max(0, keys.indexOf(options.after) + 1) : 0;
    const page = keys.slice(start, start + (options.limit ?? 256));
    const nextKey = keys[start + page.length];
    return { entries: page.map((key) => ({ key, value: this.values.get(key) })), ...(nextKey ? { next: nextKey } : {}) };
  }
}

const LOCATION = "C:\\repo";

function makeState(storage = new MemoryStorage(), clock: () => number = () => 1_000, patch: FlightDeckConfigPatch = {}) {
  return { storage, state: new FlightDeckState({ storage, config: mergeFlightDeckConfig(patch), location: LOCATION, now: clock }) };
}

function keys(storage: MemoryStorage) {
  return { prefix: storageKeyPrefix(LOCATION), values: storage.values };
}

describe("Flight Deck server state", () => {
  test("persists telemetry and derives TPS/TTFT", async () => {
    const { state, storage } = makeState();
    state.recordStepStart({ sessionId: "s1", messageId: "m1", at: 1_000, provider: "p", model: "m" });
    state.recordTextDelta("s1", 1_250, "m1");
    state.recordUsage({ sessionId: "s1", at: 1_000, outputTokens: 0, costUsd: 0.01 });
    state.recordUsage({ sessionId: "s1", at: 2_000, outputTokens: 50, costUsd: 0.02 });
    const status = await state.status();
    expect(status.sessions[0]).toMatchObject({ sessionId: "s1", tps: 50, ttftMs: 250, costUsd: 0.02 });
    const { prefix, values } = keys(storage);
    expect(values.has(`${prefix}session:s1`)).toBe(true);
    expect(prefix).toMatch(/^fd:[0-9a-f]{16}:$/);
  });

  test("namespaces keys per location so shared storage isolates two locations", async () => {
    const storage = new MemoryStorage();
    const now = () => 1_000;
    const a = new FlightDeckState({ storage, config: mergeFlightDeckConfig({}), location: "C:\\repo-a", now });
    const b = new FlightDeckState({ storage, config: mergeFlightDeckConfig({}), location: "C:\\repo-b", now });
    await a.createTask({ id: "shared", title: "from a" });
    await b.createTask({ id: "shared", title: "from b" });
    await a.setPaused(true);
    const aRestored = new FlightDeckState({ storage, config: mergeFlightDeckConfig({}), location: "C:\\repo-a", now });
    await aRestored.hydrate();
    const bRestored = new FlightDeckState({ storage, config: mergeFlightDeckConfig({}), location: "C:\\repo-b", now });
    await bRestored.hydrate();
    const aStatus = await aRestored.status();
    const bStatus = await bRestored.status();
    expect(aStatus.tasks.map((task) => task.title)).toEqual(["from a"]);
    expect(aStatus.paused).toBe(true);
    expect(bStatus.tasks.map((task) => task.title)).toEqual(["from b"]);
    expect(bStatus.paused).toBe(false);
    const prefixA = storageKeyPrefix("C:\\repo-a");
    const prefixB = storageKeyPrefix("C:\\repo-b");
    expect(prefixA).not.toBe(prefixB);
    expect(storage.values.has(`${prefixA}control`)).toBe(true);
    expect(storage.values.has(`${prefixB}control`)).toBe(false);
  });

  test("coordination disabled gates create, claim, heartbeat, report, and lease expiry", async () => {
    const storage = new MemoryStorage();
    const enabled = makeState(storage).state;
    await enabled.createTask({ id: "t1", title: "gated" });
    expect((await enabled.claim("t1", "s1")).ok).toBe(true);
    await enabled.flush();
    const disabled = makeState(storage, () => 1_000, { coordination: { enabled: false } }).state;
    await disabled.hydrate();
    let message = "";
    try {
      await disabled.createTask({ id: "t2", title: "nope" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("coordination is disabled");
    expect(await disabled.claim("t1", "s1")).toMatchObject({ ok: false, reason: "coordination-disabled" });
    expect(await disabled.heartbeat("t1", "s1")).toMatchObject({ ok: false, reason: "coordination-disabled" });
    expect(await disabled.report("t1", "s1", "start")).toMatchObject({ ok: false, reason: "coordination-disabled" });
    expect(await disabled.expireLeases()).toEqual([]);
  });

  test("serializes concurrent claims so exactly one wins", async () => {
    const { state } = makeState();
    const task = await state.createTask({ id: "t1", title: "single writer", artifact: "src/a.ts" });
    const results = await Promise.all(["a", "b", "c", "d"].map((holder) => state.claim(task.id, holder)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(3);
  });

  test("prevents two live claims from owning the same artifact", async () => {
    const { state } = makeState();
    await state.createTask({ id: "t1", title: "first", artifact: "src/shared.ts" });
    await state.createTask({ id: "t2", title: "second", artifact: "src/shared.ts" });
    expect((await state.claim("t1", "s1")).ok).toBe(true);
    expect(await state.claim("t2", "s2")).toMatchObject({ ok: false, reason: "artifact-held" });
  });

  test("owner can report and a completed task releases its lease", async () => {
    const { state, storage } = makeState();
    const { prefix, values } = keys(storage);
    await state.createTask({ id: "t1", title: "review" });
    expect((await state.claim("t1", "s1")).ok).toBe(true);
    expect((await state.report("t1", "s2", "complete")).reason).toBe("not-owner");
    expect((await state.report("t1", "s1", "start")).ok).toBe(true);
    expect((await state.report("t1", "s1", "complete")).task?.state).toBe("done");
    expect(values.has(`${prefix}lease:t1`)).toBe(false);
  });

  test("autopilot backoff and lease requeue are opt-in", async () => {
    let now = 1_000;
    const { state } = makeState(new MemoryStorage(), () => now);
    await state.createTask({ id: "t1", title: "recover" });
    await state.claim("t1", "s1");
    now = 200_000;
    expect(await state.expireLeases()).toEqual([]);
    await state.setAutopilot(true);
    expect(state.onRetry("provider", 50, 429)).toBeGreaterThanOrEqual(1_000);
    expect(await state.expireLeases()).toEqual(["t1"]);
    expect((await state.status()).tasks[0]?.state).toBe("queued");
  });

  test("honors telemetry and recommendation switches", async () => {
    const disabled = makeState(new MemoryStorage(), () => 1_000, { telemetry: { enabled: false } }).state;
    disabled.recordStepStart({ sessionId: "off", at: 1_000 });
    disabled.recordStatus("off", "busy", 1_000);
    disabled.recordUsage({ sessionId: "off", at: 1_000, outputTokens: 1, costUsd: 1 });
    expect((await disabled.status()).sessions).toHaveLength(0);

    const noRecommendations = makeState(new MemoryStorage(), () => 1_000, { autopilot: { enabled: true, recommendations: false } }).state;
    await noRecommendations.createTask({ id: "t1", title: "quiet" });
    expect((await noRecommendations.status()).recommendations).toEqual([]);
  });

  test("rejects duplicate task IDs", async () => {
    const { state } = makeState();
    await state.createTask({ id: "t1", title: "first" });
    let message = "";
    try {
      await state.createTask({ id: "t1", title: "second" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("task id already exists");
  });

  test("hydration restores board and session records", async () => {
    const storage = new MemoryStorage();
    const first = makeState(storage).state;
    await first.createTask({ id: "t1", title: "survive restart" });
    first.recordUsage({ sessionId: "s1", at: 1_000, outputTokens: 1, costUsd: 0.03 });
    await first.flush();
    const second = makeState(storage).state;
    await second.hydrate();
    const status = await second.status();
    expect(status.tasks[0]?.title).toBe("survive restart");
    expect(status.sessions[0]?.costUsd).toBe(0.03);
  });

  test("hydrate repairs wedged tasks and stale leases after a crash mid-claim", async () => {
    const storage = new MemoryStorage();
    const prefix = storageKeyPrefix(LOCATION);
    storage.values.set(`${prefix}task:w1`, { id: "w1", title: "crashed running", state: "running", priority: "normal", owner: "s1", updatedAt: 900 });
    storage.values.set(`${prefix}lease:w1`, { taskId: "w1", holder: "s1", expiresAt: 500, epoch: 1 });
    storage.values.set(`${prefix}task:w2`, { id: "w2", title: "half claim", state: "claimed", priority: "normal", owner: "s2", updatedAt: 900 });
    storage.values.set(`${prefix}task:w3`, { id: "w3", title: "stale lease", state: "queued", priority: "normal", updatedAt: 900 });
    storage.values.set(`${prefix}lease:w3`, { taskId: "w3", holder: "s3", expiresAt: 90_000, epoch: 1 });
    storage.values.set(`${prefix}task:live`, { id: "live", title: "healthy", state: "running", priority: "normal", owner: "s4", updatedAt: 900 });
    storage.values.set(`${prefix}lease:live`, { taskId: "live", holder: "s4", expiresAt: 90_000, epoch: 1 });
    storage.values.set(`${prefix}lease:ghost`, { taskId: "ghost", holder: "s5", expiresAt: 90_000, epoch: 1 });
    const state = makeState(storage).state;
    await state.hydrate();
    expect(storage.values.has(`${prefix}lease:w1`)).toBe(true);
    expect(storage.values.has(`${prefix}lease:ghost`)).toBe(false);
    expect(storage.values.has(`${prefix}lease:w3`)).toBe(false);
    const tasks = new Map((await state.status()).tasks.map((task) => [task.id, task]));
    expect(tasks.get("w1")).toMatchObject({ state: "running", owner: "s1" });
    expect(tasks.get("w2")).toMatchObject({ state: "queued" });
    expect(tasks.get("w2")?.owner).toBeUndefined();
    expect(tasks.get("w3")?.state).toBe("queued");
    expect(tasks.get("live")).toMatchObject({ state: "running", owner: "s4" });
    expect(storage.values.has(`${prefix}lease:live`)).toBe(true);
  });

  test("bounds retained terminal tasks and idle sessions by history.maxItems", async () => {
    const storage = new MemoryStorage();
    const prefix = storageKeyPrefix(LOCATION);
    let now = 1_000;
    const { state } = makeState(storage, () => now, { history: { maxItems: 2 } });
    for (let i = 1; i <= 4; i++) {
      await state.createTask({ id: `t${i}`, title: `task ${i}` });
      await state.claim(`t${i}`, "worker");
      await state.report(`t${i}`, "worker", "start");
      await state.report(`t${i}`, "worker", "complete");
      state.recordStatus(`w${i}`, "idle", now);
      now += 1_000;
    }
    state.recordStatus("busy-1", "busy", now);
    const status = await state.status();
    expect(status.tasks.map((task) => task.id).sort()).toEqual(["t3", "t4"]);
    expect(status.sessions.map((session) => session.sessionId).sort()).toEqual(["busy-1", "w3", "w4"]);
    expect(storage.values.has(`${prefix}task:t1`)).toBe(false);
    expect(storage.values.has(`${prefix}task:t2`)).toBe(false);
    expect(storage.values.has(`${prefix}task:t3`)).toBe(true);
    expect(storage.values.has(`${prefix}session:w1`)).toBe(false);
    expect(storage.values.has(`${prefix}session:w2`)).toBe(false);
    expect(storage.values.has(`${prefix}session:busy-1`)).toBe(true);
  });

  test("counts queued write failures instead of swallowing them", async () => {
    class FailingStorage extends MemoryStorage {
      override async set(): Promise<void> { throw new Error("disk full"); }
    }
    const { state } = makeState(new FailingStorage());
    state.recordStepStart({ sessionId: "s1", at: 1_000, provider: "p", model: "m" });
    state.recordUsage({ sessionId: "s1", at: 1_000, outputTokens: 1, costUsd: 0.01 });
    const status = await state.status();
    expect(status.persistFailures).toBeGreaterThan(0);
    expect((await state.status()).persistFailures).toBe(status.persistFailures);
  });

  test("aggregates model cost across sessions and survives hydration", async () => {
    const storage = new MemoryStorage();
    const first = makeState(storage).state;
    first.recordStepStart({ sessionId: "s1", at: 1_000, provider: "p", model: "m" });
    first.recordUsage({ sessionId: "s1", at: 1_000, outputTokens: 1, costUsd: 0.02 });
    first.recordStepStart({ sessionId: "s2", at: 1_000, provider: "p", model: "m" });
    first.recordUsage({ sessionId: "s2", at: 1_000, outputTokens: 1, costUsd: 0.03 });
    await first.flush();
    expect((await first.status()).models[0]?.costUsd).toBeCloseTo(0.05);
    const second = makeState(storage).state;
    await second.hydrate();
    expect((await second.status()).models[0]?.costUsd).toBeCloseTo(0.05);
  });
});
