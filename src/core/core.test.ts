import { describe, expect, test } from "bun:test";
import { createStreamMeter, recommendLane, heartbeat, isExpired, tryAcquire, percentile, summarize, transition, transitionOnEvent } from "./index.js";

describe("Flight Deck core", () => {
  test("computes streamed TPS and EWMA without fabricating the first interval", () => {
    const meter = createStreamMeter(0.5);
    expect(meter.observe({ outputTokens: 0, at: 1_000 })).toBeNull();
    expect(meter.observe({ outputTokens: 100, at: 2_000 })).toBe(100);
    expect(meter.observe({ outputTokens: 150, at: 3_000 })).toBe(50);
    expect(meter.snapshot().ewmaTps).toBe(75);
  });

  test("rejects unusable stream samples", () => {
    const meter = createStreamMeter();
    meter.observe({ outputTokens: 10, at: 1_000 });
    expect(meter.observe({ outputTokens: 10, at: 2_000 })).toBeNull();
    expect(meter.observe({ outputTokens: 5, at: 3_000 })).toBeNull();
    expect(meter.snapshot().unusableSamples).toBe(2);
  });

  test("summaries ignore invalid values", () => {
    expect(percentile([1, 2, 3], 50)).toBe(2);
    expect(summarize([1, 2, Number.NaN])).toMatchObject({ count: 2, min: 1, max: 2, mean: 1.5 });
  });

  test("enforces task transitions", () => {
    expect(transition("queued", "claimed").ok).toBe(true);
    expect(transition("done", "running").ok).toBe(false);
    expect(transitionOnEvent("running", "review").to).toBe("review");
  });

  test("leases expire and only a live holder can heartbeat", () => {
    const acquired = tryAcquire(null, "task", "session-a", 0, 100);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(isExpired(acquired.lease, 100)).toBe(true);
    expect(tryAcquire(acquired.lease, "task", "session-b", 100, 100).ok).toBe(true);
    expect(heartbeat(acquired.lease, "session-b", 50, 100).ok).toBe(false);
  });

  test("TPS alone never selects a lane", () => {
    expect(recommendLane({ tps: 10_000 })).toEqual({ ok: false, reason: "insufficient-evidence" });
    expect(recommendLane({ taskPriority: "high", tps: 1 }).ok).toBe(true);
  });
});
