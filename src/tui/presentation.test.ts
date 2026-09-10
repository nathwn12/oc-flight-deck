import { describe, expect, test } from "bun:test";
import { contextPercent, formatFooter, formatSidebar, formatTasks, formatTps, formatTtft, sidebarVisible } from "./presentation.js";

describe("Flight Deck presentation", () => {
  test("renders honest unavailable telemetry", () => {
    expect(formatTps(null)).toBe("-- tok/s");
    expect(formatTtft(undefined)).toBe("-- TTFT");
    expect(formatFooter({ status: "busy", tps: null, ttftMs: null, costUsd: 0 }, { tps: true, ttft: true, cost: true, context: true, compact: true })).toContain("--");
    expect(formatFooter({ status: "busy", tps: 10, ttftMs: 20, costUsd: null }, { tps: true, ttft: true, cost: true, context: true, compact: true })).toContain("$--");
    expect(contextPercent(50, 100)).toBe(50);
    expect(contextPercent(undefined, 100)).toBeNull();
  });

  test("keeps sidebar compact by default and expands on request", () => {
    const status = { activeWorkers: 2, blockedWorkers: 1, aggregateTps: 83, queuedTasks: 3, activeTasks: 2, costUsd: 0.84, autopilot: false };
    expect(formatSidebar(status, true)).toHaveLength(3);
    expect(formatSidebar(status, false)).toContain("Autopilot: off");
    expect(sidebarVisible(status, "hidden")).toBe(false);
    expect(sidebarVisible(null, "always")).toBe(true);
    expect(sidebarVisible(null, "auto")).toBe(false);
  });

  test("surfaces persistence failures without changing the quiet default", () => {
    expect(formatSidebar({ activeWorkers: 1, persistFailures: 2 }, true).join("\n")).toContain("persistence failures");
    expect(formatSidebar({ activeWorkers: 1, persistFailures: 0 }, true).join("\n")).not.toContain("persistence failures");
  });

  test("formats bounded task rows", () => {
    expect(formatTasks([{ id: "abcdefghijk", title: "Fix it", state: "queued" }])).toEqual(["queued    abcdefgh Fix it"]);
  });
});
