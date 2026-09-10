import { describe, expect, test } from "bun:test";
import { DEFAULT_FLIGHT_DECK_CONFIG, mergeFlightDeckConfig } from "../config/schema.js";
import type { FlightDeckConfigPatch } from "../config/schema.js";
import { FlightDeckState, type StorageLike } from "./state.js";

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

function makeState(storage = new MemoryStorage(), clock: () => number = () => 1_000, patch: FlightDeckConfigPatch = {}) {
  return { storage, state: new FlightDeckState({ storage, config: mergeFlightDeckConfig(patch), location: "C:\\repo", now: clock }) };
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
    expect(storage.values.has("fd:session:s1")).toBe(true);
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
    await state.createTask({ id: "t1", title: "review" });
    expect((await state.claim("t1", "s1")).ok).toBe(true);
    expect((await state.report("t1", "s2", "complete")).reason).toBe("not-owner");
    expect((await state.report("t1", "s1", "start")).ok).toBe(true);
    expect((await state.report("t1", "s1", "complete")).task?.state).toBe("done");
    expect(storage.values.has("fd:lease:t1")).toBe(false);
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
});
