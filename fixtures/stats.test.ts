import { describe, expect, test } from "bun:test";
import { clip, formatCost, formatCount, formatDuration, fuelBar, sessionThroughput, sparkline, statLine, statRows, TPS_WINDOW_MS, windowedThroughput } from "../src/tui/stats.js";

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
    expect(formatDuration(14 * 60_000)).toBe("14m00s");
    expect(formatDuration(8 * 60_000 + 41_000)).toBe("8m41s");
    expect(formatDuration(61_000)).toBe("1m01s");
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2h14m00s");
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000 + 37_000)).toBe("2h14m37s");
    expect(formatDuration(3 * 3_600_000)).toBe("3h00m00s");
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
      // `total` is on this rail, so `cost` stays the session figure and `total`
      // carries the family total. One number is not repeated.
      "cost      $0.225",
      "total     $0.245 · 2 subagents",
      "tokens    533k in · 91k out",
      "cache     98% hit · 32M read",
    ]);
  });

  test("cost merges the subagent total only when nothing else shows it", () => {
    const source = { cost: 0.2246, tree: { cost: 0.2447, count: 2 } };

    // No `total` row on the rail: cost carries the family figure itself.
    expect(statLine("cost", source)).toBe("cost      $0.245 · 2 subagents");
    // `total` row present: cost goes back to the session figure.
    expect(statLine("cost", source, { hasTotalRow: true })).toBe("cost      $0.225");

    // Nothing to merge when no subagent ran, whichever way the rail is set up.
    expect(statLine("cost", { cost: 0.1913 })).toBe("cost      $0.191");
    expect(statLine("cost", { cost: 0.1913, tree: { cost: 0.1913, count: 0 } })).toBe("cost      $0.191");
    expect(statLine("cost", { cost: 0.2, tree: { cost: 0.2, count: 1 } })).toBe("cost      $0.200");
    expect(statLine("cost", { cost: 0.2, tree: { cost: 0.25, count: 1 } })).toBe("cost      $0.250 · 1 subagent");
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
    expect(statLine("elapsed", { elapsedMs: 2 * 3_600_000 + 14 * 60_000 })).toBe("elapsed   2h14m00s");
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
    // Omission is `persist: false`: the default for a direct `statRows` call,
    // and the opt-out for `sidebarLines`.
    expect(statRows(["agent", "cost"], {}, { persist: false })).toEqual([]);
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

  test("names what is waiting for approval, not just how many", () => {
    expect(statLine("perms", {})).toBeUndefined();
    expect(statLine("perms", { perms: { count: 0 } })).toBeUndefined();
    // One request: name it, because that is the decision being asked for.
    expect(statLine("perms", { perms: { count: 1, action: "shell", resource: "npm publish" } })).toBe(
      "perms     shell · npm publish",
    );
    // Several: the count leads, because the first is not necessarily the one
    // about to be shown.
    expect(statLine("perms", { perms: { count: 3, action: "shell" } })).toBe("perms     3 waiting · shell");
    expect(statLine("perms", { perms: { count: 3 } })).toBe("perms     3 waiting");
    // A request with no resource still says what it is.
    expect(statLine("perms", { perms: { count: 1, action: "edit" } })).toBe("perms     edit");
    expect(statLine("perms", { perms: { count: 1 } })).toBe("perms     1 waiting");
  });

  test("shortens a long resource with a visible ellipsis, never silently", () => {
    const line = statLine("perms", {
      perms: { count: 1, action: "read", resource: "/very/long/path/to/a/config/file/that/needs/clipping/opencode.jsonc" },
    });
    expect(line).toContain("…");
    expect(line?.length).toBeLessThan(45);
    // A short resource is left alone.
    expect(clip("short", 22)).toBe("short");
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

  test("computes overall session throughput, floored at one second", () => {
    // Nothing to divide: absent, zero or negative on either side.
    expect(sessionThroughput(0, 10_000)).toBeUndefined();
    expect(sessionThroughput(-5, 10_000)).toBeUndefined();
    expect(sessionThroughput(undefined, 10_000)).toBeUndefined();
    expect(sessionThroughput(600, 0)).toBeUndefined();
    expect(sessionThroughput(600, -1)).toBeUndefined();
    expect(sessionThroughput(600, undefined)).toBeUndefined();
    // A sub-second session is floored at 1000ms, so a sliver of time cannot
    // flash an absurd rate: 10 tokens over 200ms reads as 10 tok/s, not 50.
    expect(sessionThroughput(10, 200)).toBe(10);
    // The ordinary case: 600 tokens over two seconds.
    expect(sessionThroughput(600, 2_000)).toBe(300);
  });

  test("hides the tps row rather than printing a zero rate", () => {
    expect(statLine("tps", { tps: 0 })).toBeUndefined();
    expect(statLine("tps", { tps: Number.NaN })).toBeUndefined();
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

// Boundaries are where a short formatter goes wrong: the unit has to change
// exactly once, and a rounded value must never carry the wrong unit into the
// string. `999,600` printing as `1000k` was a real number, with two magnitudes
// in it.
describe("number boundaries", () => {
  test("changes unit once, and never prints a four-figure thousands count", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_000)).toBe("1k");
    expect(formatCount(999_499)).toBe("999k");
    expect(formatCount(999_500)).toBe("1M");
    expect(formatCount(999_999)).toBe("1M");
    expect(formatCount(1_000_000)).toBe("1M");
    expect(formatCount(1_050_000)).toBe("1.1M");
    expect(formatCount(31_974_784)).toBe("32M");
  });

  test("never cuts a surrogate pair in half", () => {
    // 18 code units against a 4-unit budget, so the cut lands mid-pair. The
    // orphaned half renders as a replacement character, which reads as
    // corruption rather than as a shortened path.
    expect(clip("😀".repeat(9), 4)).toBe("😀…");
    expect(clip("😀".repeat(9), 5)).toBe("😀😀…");
    // Nothing to clip means nothing is touched.
    expect(clip("short", 18)).toBe("short");
    expect(clip("😀", 18)).toBe("😀");
  });
});

// Config text is flattened in ./config.ts, but a tool name, a permission resource
// or a branch name arrives straight from the host and lands on the same rail. A
// control character there moves the cursor instead of being seen.
describe("host text is flattened before it is drawn", () => {
  test("strips an escape sequence out of a permission resource", () => {
    expect(statLine("perms", { perms: { count: 1, action: "shell", resource: "a\u001b[31mb" } })).toBe(
      "perms     shell · a [31mb",
    );
  });

  test("keeps a newline in a branch name from breaking the row", () => {
    expect(statLine("branch", { branch: "ma\nin" })).toBe("branch    ma in");
  });

  test("flattens a control character inside a tool name", () => {
    expect(statLine("caution", { caution: "⚠ sh\u0007ell running" })).toBe("caution   ⚠ sh ell running");
  });
});

// The windowed rate is the whole point of the tps row on a modern host: a single
// trailing minute rather than a whole-conversation average. These pin the
// arithmetic, the clamp that keeps a fresh session honest, and the guards that
// make an idle window report nothing at all rather than a decaying number.
describe("windowed throughput", () => {
  const NOW = 1_800_000_000_000;
  const LONG_AGO = NOW - 600_000;

  test("returns undefined when nothing usable is inside the window", () => {
    expect(windowedThroughput([], NOW, TPS_WINDOW_MS, LONG_AGO)).toBeUndefined();
    // Older than the window is not a zero rate: it is no rate at all, which is
    // what hides the row of an idle session.
    expect(
      windowedThroughput([{ tokens: 500, at: NOW - TPS_WINDOW_MS - 1 }], NOW, TPS_WINDOW_MS, LONG_AGO),
    ).toBeUndefined();
  });

  test("sums only the output inside a settled window", () => {
    const samples = [
      { tokens: 120, at: NOW - 5_000 },
      { tokens: 180, at: NOW - 55_000 },
      // Outside the window: must not inflate the rate.
      { tokens: 9_999, at: NOW - TPS_WINDOW_MS - 1 },
    ];
    // 300 tokens over a full 60s window.
    expect(windowedThroughput(samples, NOW, TPS_WINDOW_MS, LONG_AGO)).toBe(5);
  });

  test("clamps a fresh session's denominator to its real age", () => {
    // Alive two seconds, so 100 tokens reads as 50 tok/s, not 1.67.
    expect(windowedThroughput([{ tokens: 100, at: NOW - 500 }], NOW, TPS_WINDOW_MS, NOW - 2_000)).toBe(50);
    // A sub-second session is floored at one second, the same floor the lifetime
    // average uses, so a sliver of time cannot flash an absurd rate.
    expect(windowedThroughput([{ tokens: 10, at: NOW - 100 }], NOW, TPS_WINDOW_MS, NOW - 200)).toBe(10);
  });

  test("uses the full window when the session age is unusable", () => {
    expect(windowedThroughput([{ tokens: 60, at: NOW - 1_000 }], NOW, TPS_WINDOW_MS, Number.NaN)).toBe(1);
  });

  test("rejects a window or clock it cannot trust", () => {
    expect(windowedThroughput([{ tokens: 10, at: NOW }], NOW, 0, LONG_AGO)).toBeUndefined();
    expect(windowedThroughput([{ tokens: 10, at: NOW }], NOW, -1, LONG_AGO)).toBeUndefined();
    expect(windowedThroughput([{ tokens: 10, at: NOW }], NOW, Number.NaN, LONG_AGO)).toBeUndefined();
    expect(windowedThroughput([{ tokens: 10, at: NOW }], Number.NaN, TPS_WINDOW_MS, LONG_AGO)).toBeUndefined();
  });

  test("skips a sample with no usable timestamp or no positive output", () => {
    const samples = [
      { tokens: 120, at: NOW - 1_000 },
      { tokens: 120 }, // no timestamp at all
      { at: NOW - 1_000 }, // no token count
      { tokens: 0, at: NOW - 1_000 },
      { tokens: -5, at: NOW - 1_000 },
      { tokens: 120, at: "not a number" },
      { tokens: 120, at: Number.NaN },
      { tokens: 120, at: Number.POSITIVE_INFINITY },
    ];
    // Only the first sample counts: 120 over a full window is 2 tok/s.
    expect(windowedThroughput(samples, NOW, TPS_WINDOW_MS, LONG_AGO)).toBe(2);
  });

  test("counts both window boundaries as inside", () => {
    const start = NOW - TPS_WINDOW_MS;
    const samples = [
      { tokens: 60, at: start },
      { tokens: 60, at: NOW },
      { tokens: 60, at: start - 1 }, // one millisecond too old
      { tokens: 60, at: NOW + 1 }, // one millisecond into the future
    ];
    expect(windowedThroughput(samples, NOW, TPS_WINDOW_MS, LONG_AGO)).toBe(2);
  });
});

