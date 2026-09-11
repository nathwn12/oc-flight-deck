import { describe, expect, test } from "bun:test";
import { formatCost, formatCount, formatDuration, fuelBar, sparkline, statLine, statRows } from "../src/tui/stats.js";

// Shaped exactly like the live `Session.Info` read from the server, so the
// assertions stay tied to real data rather than a convenient invention.
const LIVE_SESSION = {
  agent: "orchestrator",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "high" },
  cost: 0.2246,
  tokens: { input: 533201, output: 91342, reasoning: 174857, cache: { read: 31974784, write: 0 } },
  branch: "main",
};

describe("flight deck live rows", () => {
  test("formats counts short enough for a narrow rail", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(940)).toBe("940");
    expect(formatCount(75683)).toBe("76k");
    expect(formatCount(517512)).toBe("518k");
    expect(formatCount(29174144)).toBe("29.2M");
    expect(formatCount(31974784)).toBe("32M");
  });

  test("keeps a third decimal below a dollar so a cheap run never reads $0.00", () => {
    expect(formatCost(0)).toBe("$0.000");
    expect(formatCost(0.1913)).toBe("$0.191");
    expect(formatCost(0.5)).toBe("$0.500");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(12.345)).toBe("$12.35");
  });

  test("formats durations at the scale a session actually runs", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(14 * 60_000)).toBe("14m");
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatDuration(3 * 3_600_000)).toBe("3h");
  });

  test("renders the default panel from a real session snapshot", () => {
    expect(
      statRows(["agent", "model", "branch", "cost", "total", "tokens", "cache"], {
        ...LIVE_SESSION,
        tree: { cost: 0.2447, count: 2 },
      }),
    ).toEqual([
      "agent     orchestrator",
      "model     deepseek-v4.1-flash · high",
      "branch    main",
      "cost      $0.225",
      "total     $0.245 · 2 subagents",
      "tokens    533k in · 91k out",
      "cache     98% hit · 32M read",
    ]);
  });

  test("only shows a tree total once a subagent has actually run", () => {
    // No family data, or a family of one, must not invent a total row.
    expect(statLine("total", { cost: 0.2 })).toBeUndefined();
    expect(statLine("total", { cost: 0.2, tree: { cost: 0.2, count: 0 } })).toBeUndefined();
    expect(statLine("total", { tree: { cost: 0.2447, count: 1 } })).toBe("total     $0.245 · 1 subagent");
    expect(statLine("total", { tree: { cost: 0.9, count: 3 } })).toContain("3 subagents");
  });

  test("reads context occupancy from the last request, not the running total", () => {
    expect(statLine("context", { context: { used: 218_000 } })).toBe("context   218k used");
    expect(statLine("context", { context: { used: 218_000, limit: 1_000_000 } })).toBe(
      "context   ██░░░░░░░░ 22%",
    );
    // A window the host never reports still shows the honest half of the answer.
    expect(statLine("context", { context: { used: 0 } })).toBeUndefined();
  });

  test("shows elapsed and turns only when they are meaningful", () => {
    expect(statLine("elapsed", { elapsedMs: 2 * 3_600_000 + 14 * 60_000 })).toBe("elapsed   2h 14m");
    expect(statLine("elapsed", { elapsedMs: 0 })).toBeUndefined();
    expect(statLine("turns", { turns: 42 })).toBe("turns     42");
    expect(statLine("turns", { turns: 0 })).toBeUndefined();
  });

  test("shows reasoning tokens only when the model produced any", () => {
    expect(statLine("reasoning", { tokens: { reasoning: 174857 } })).toBe("reasoning 175k");
    expect(statLine("reasoning", { tokens: { reasoning: 0 } })).toBeUndefined();
  });

  test("falls back to a raw cache read when the hit ratio is underivable", () => {
    expect(statLine("cache", { tokens: { cache: { read: 1000 } } })).toBe("cache     1k read");
  });

  test("omits a row instead of inventing a placeholder", () => {
    expect(statLine("branch", {})).toBeUndefined();
    expect(statLine("agent", {})).toBeUndefined();
    expect(statLine("cache", { tokens: { cache: { read: 0 } } })).toBeUndefined();
    expect(statRows(["agent", "cost"], {})).toEqual([]);
  });

  test("shows the model without a variant when the host omits one", () => {
    expect(statLine("model", { model: { id: "gpt-5" } })).toBe("model     gpt-5");
  });

  test("animates the status glyph while anything is working, not just the session", () => {
    expect(statLine("status", { status: "idle" })).toBe("status    ○ idle");
    expect(statLine("status", { status: "running", frame: 0 })).toBe("status    ⠋ running");
    expect(statLine("status", { status: "running", frame: 1 })).toBe("status    ⠙ running");
    // The spinner wraps rather than running off the end of the frame list.
    expect(statLine("status", { status: "running", frame: 10 })).toBe("status    ⠋ running");
    // A subagent runs in its own session, so the parent can read idle while work
    // is plainly happening. `busy` keeps the glyph turning through that, and a
    // running shell counts the same way.
    expect(statLine("status", { status: "idle", busy: true, frame: 2 })).toBe("status    ⠹ running");
    expect(statLine("status", { busy: true, frame: 0 })).toBe("status    ⠋ running");
    // Nothing anywhere: only then does it read as idle.
    expect(statLine("status", { status: "idle", busy: false })).toBe("status    ○ idle");
    // The session's own status wins over a missing busy flag: an explicit false
    // must not stop the glyph while the turn is still running.
    expect(statLine("status", { status: "running", busy: false, frame: 0 })).toBe("status    ⠋ running");
    // A fractional frame would index the frame list with a non-integer, and a
    // non-numeric one would render the literal text `undefined`.
    expect(statLine("status", { busy: true, frame: 2.7 })).toBe("status    ⠹ running");
    expect(statLine("status", { busy: true, frame: "x" })).toBe("status    ⠋ running");
    expect(statLine("status", {})).toBeUndefined();
  });

  test("only surfaces pending permissions when something is actually waiting", () => {
    expect(statLine("perms", {})).toBeUndefined();
    expect(statLine("perms", { perms: 0 })).toBeUndefined();
    expect(statLine("perms", { perms: 1 })).toBe("perms     1 waiting");
    expect(statLine("perms", { perms: 3 })).toBe("perms     3 waiting");
  });

  test("reports project spend, naming the session count only when it adds meaning", () => {
    expect(statLine("project", { project: { cost: 0.5 } })).toBe("project   $0.500");
    expect(statLine("project", { project: { cost: 1.482, count: 12 } })).toBe("project   $1.48 · 12 sessions");
    expect(statLine("project", { project: { cost: 1.482, count: 1 } })).toBe("project   $1.48");
    expect(statLine("project", {})).toBeUndefined();
  });

  test("reports measured throughput, not an estimate", () => {
    expect(statLine("tps", { tps: 106.3 })).toBe("tps       106 tok/s");
    expect(statLine("tps", { tps: 0 })).toBeUndefined();
  });

  test("draws recent turn sizes as a sparkline", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([0, 0])).toBe("▁▁");
    expect(sparkline([100])).toBe("█");
    // Scaled against the largest value in the window, so the shape survives
    // whether the turns are tiny or enormous.
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe("▁▂▃▄▅▆▇█");
    expect(statLine("spark", { spark: [1, 8, 4] })).toBe("spark     ▁█▄");
    // One point is not a shape.
    expect(statLine("spark", { spark: [5] })).toBeUndefined();
  });

  test("draws the context gauge at both extremes", () => {
    expect(fuelBar(0)).toBe("░░░░░░░░░░");
    expect(fuelBar(0.5)).toBe("█████░░░░░");
    expect(fuelBar(1)).toBe("██████████");
    // Never draws more than a full bar, however the host reports the window.
    expect(fuelBar(2)).toBe("██████████");
  });

  test("ignores host data of the wrong shape rather than throwing", () => {
    expect(statLine("agent", { agent: 42 })).toBeUndefined();
    expect(statLine("model", { model: "deepseek" })).toBeUndefined();
    expect(statLine("cost", { cost: Number.NaN })).toBeUndefined();
    expect(statLine("cost", { cost: -1 })).toBeUndefined();
    expect(statLine("tokens", { tokens: { input: -5 } })).toBeUndefined();
    expect(statLine("tokens", { tokens: "518k" })).toBeUndefined();
    expect(statLine("unknown-field", {})).toBeUndefined();
  });
});
