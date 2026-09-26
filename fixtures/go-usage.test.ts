import { describe, expect, test } from "bun:test";
import {
  GO_ERROR_RATIO,
  goResetSuffix,
  goTone,
  normalizeGoUsage,
} from "../src/tui/go-usage.js";

const FLAT = {
  rollingUsage: 50,
  rollingLimit: 100,
  weeklyUsage: 10,
  weeklyLimit: 1_000,
  monthlyUsage: 900,
  monthlyLimit: 1_000,
  timeRollingUpdated: 1,
  timeWeeklyUpdated: 2,
  timeMonthlyUpdated: 3,
};

describe("go usage normalization", () => {
  test("reads the flat rolling/weekly/monthly shape", () => {
    const usage = normalizeGoUsage(FLAT);
    expect(usage?.windows.map((w) => w.id)).toEqual(["5h", "1w", "1m"]);
    expect(usage?.windows[0]).toEqual({ id: "5h", used: 50, limit: 100, ratio: 0.5 });
    expect(usage?.windows[1]?.ratio).toBe(0.01);
    expect(usage?.windows[2]?.ratio).toBe(0.9);
    // Updated-at is not a reset time: it must never surface as resetAtMs.
    expect(usage?.windows.every((w) => w.resetAtMs === undefined)).toBe(true);
  });

  test("reads the nested usage map shape", () => {
    const usage = normalizeGoUsage({
      usage: {
        rolling: { usage: 5, limit: 10, resetAt: 1_700_000_000_000 },
        weekly: { used: 1, limit: 4 },
        monthly: { usage: 3 },
      },
    });
    expect(usage?.windows.map((w) => w.id)).toEqual(["5h", "1w", "1m"]);
    expect(usage?.windows[0]?.ratio).toBe(0.5);
    expect(usage?.windows[0]?.resetAtMs).toBe(1_700_000_000_000);
    expect(usage?.windows[1]?.ratio).toBe(0.25);
    // A bare count has no known limit, so no fabricated ratio.
    expect(usage?.windows[2]?.used).toBe(3);
    expect(usage?.windows[2]?.ratio).toBeUndefined();
  });

  test("reads a windows array and a bare array of window objects", () => {
    const named = normalizeGoUsage({
      windows: [
        { window: "5h", used: 20, limit: 40 },
        { name: "weekly", usage: 2, limit: 8, resetInSec: 120 },
      ],
    });
    expect(named?.windows.map((w) => w.id)).toEqual(["5h", "1w"]);
    expect(named?.windows[0]?.ratio).toBe(0.5);
    // A relative reset is deliberately not turned into an absolute instant.
    expect(named?.windows[1]?.resetAtMs).toBeUndefined();

    const bare = [{ id: "1m", usage: 1, limit: 2 }];
    expect(normalizeGoUsage(bare)?.windows).toEqual([{ id: "1m", used: 1, limit: 2, ratio: 0.5 }]);
  });

  test("accepts id aliases and rejects unknown window names", () => {
    const usage = normalizeGoUsage({
      windows: [
        { window: "rolling", usage: 1, limit: 2 },
        { window: "7d", usage: 1, limit: 2 },
        { window: "30d", usage: 1, limit: 2 },
        { window: "fortnightly", usage: 9, limit: 10 },
      ],
    });
    expect(usage?.windows.map((w) => w.id)).toEqual(["5h", "1w", "1m"]);
  });

  test("rejects garbage top levels", () => {
    for (const value of [undefined, null, 0, "x", 42, true, {}, { usage: {} }, { windows: [] }]) {
      expect(normalizeGoUsage(value)).toBeUndefined();
    }
  });

  test("leaves ratio undefined for a missing or non-positive limit", () => {
    const missing = normalizeGoUsage({ rollingUsage: 50 });
    expect(missing?.windows[0]?.used).toBe(50);
    expect(missing?.windows[0]?.limit).toBeUndefined();
    expect(missing?.windows[0]?.ratio).toBeUndefined();

    for (const limit of [0, -10]) {
      const zero = normalizeGoUsage({ rollingUsage: 50, rollingLimit: limit });
      expect(zero?.windows[0]?.ratio).toBeUndefined();
    }
    // A zero use against a positive limit is a legitimate ratio of zero.
    expect(normalizeGoUsage({ rollingUsage: 0, rollingLimit: 100 })?.windows[0]?.ratio).toBe(0);
  });

  test("computes ratio arithmetic without rounding", () => {
    const usage = normalizeGoUsage({ rollingUsage: 1, rollingLimit: 3 });
    expect(usage?.windows[0]?.ratio).toBeCloseTo(1 / 3, 10);
  });

  test("drops NaN, Infinity, and non-numeric columns rather than printing them", () => {
    const usage = normalizeGoUsage({
      rollingUsage: Number.NaN,
      rollingLimit: Number.POSITIVE_INFINITY,
      weeklyUsage: "5",
      weeklyLimit: 100,
      monthlyUsage: 7,
      monthlyLimit: "lots",
    });
    expect(usage?.windows.map((w) => w.id)).toEqual(["1w", "1m"]);
    expect(usage?.windows[0]?.used).toBeUndefined();
    expect(usage?.windows[0]?.limit).toBe(100);
    expect(usage?.windows[0]?.ratio).toBeUndefined();
    expect(usage?.windows[1]?.used).toBe(7);
    expect(usage?.windows[1]?.ratio).toBeUndefined();
  });

  test("never throws on hostile payloads", () => {
    expect(() => normalizeGoUsage({ get usage() { throw new Error("x"); } })).not.toThrow();
    expect(normalizeGoUsage({ get usage() { throw new Error("x"); } })).toBeUndefined();
    expect(() =>
      normalizeGoUsage({ windows: [{ get usage() { throw new Error("x"); } }] }),
    ).not.toThrow();
  });
});

describe("go tone and reset suffix", () => {
  test("thresholds at GO_ERROR_RATIO and stays normal below it", () => {
    expect(GO_ERROR_RATIO).toBe(0.9);
    expect(goTone({ id: "5h", ratio: 0.899_999 })).toBe("normal");
    expect(goTone({ id: "5h", ratio: 0.9 })).toBe("error");
    expect(goTone({ id: "5h", ratio: 1.5 })).toBe("error");
    // No ratio is never an error: unknown is not a warning.
    expect(goTone({ id: "5h" })).toBe("normal");
    expect(goTone({ id: "5h", used: 9, limit: 10 })).toBe("normal");
  });

  test("shows a reset suffix only under the error tone and a known future reset", () => {
    const now = 1_000_000;
    expect(goResetSuffix({ id: "5h", ratio: 0.95, resetAtMs: now + 2 * 3_600_000 }, now)).toBe(" · 2h");
    expect(goResetSuffix({ id: "5h", ratio: 0.95, resetAtMs: now + 90_000 }, now)).toBe(" · 2m");
    expect(goResetSuffix({ id: "5h", ratio: 0.95, resetAtMs: now + 5_000 }, now)).toBe(" · 5s");
    expect(goResetSuffix({ id: "5h", ratio: 1.2, resetAtMs: now + 5 * 86_400_000 }, now)).toBe(" · 5d");

    // A calm bar gets no hint even when a reset time is known.
    expect(goResetSuffix({ id: "5h", ratio: 0.5, resetAtMs: now + 3_600_000 }, now)).toBeUndefined();
    // Error but the reset is already past, or never known.
    expect(goResetSuffix({ id: "5h", ratio: 0.95, resetAtMs: now - 1 }, now)).toBeUndefined();
    expect(goResetSuffix({ id: "5h", ratio: 0.95 }, now)).toBeUndefined();
    expect(goResetSuffix({ id: "5h", ratio: 0.95, resetAtMs: Number.NaN }, now)).toBeUndefined();
  });
});
