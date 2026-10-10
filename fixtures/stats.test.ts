import { describe, expect, test } from "bun:test";
import { normalizeGoUsage } from "../src/tui/go-usage.js";
import { clip, formatCost, formatCount, formatDuration, fuelBar, isStatField, sparkline, statLine, statRows, statSegments, turnKey, turnSpan, unionSpanMs, unionSpanTotals } from "../src/tui/stats.js";
import { canonicalField } from "../src/tui/stat-fields.js";
import { createInstantTps, instantTpsRate, smoothTpsRate, tpsNeedsRepaint, unionGenerationTotals } from "../src/tui/throughput.js";

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
    // An estimate, not an exact count: the occupancy proxy earns its `~`.
    expect(statLine("context", { context: { used: 218_000 } })).toBe("context   ~218k used");
    expect(statLine("context", { context: { used: 218_000, limit: 1_000_000 } })).toBe(
      "context   ██░░░░░░░░ ~22%",
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

  test("draws a zero cache read instead of hiding it", () => {
    // "No cache" is a state worth seeing, distinct from "no data yet" (which
    // still hides and lets persist draw the placeholder).
    expect(statLine("cache", { tokens: { input: 500, cache: { read: 0 } } })).toBe(
      "cache     0% hit · 0 read",
    );
    expect(statLine("cache", { tokens: { cache: { read: 0 } } })).toBe("cache     0 read");
    expect(statLine("cache", { tokens: {} })).toBeUndefined();
    expect(statLine("cache", {})).toBeUndefined();
  });

  test("omits a row instead of inventing a placeholder", () => {
    expect(statLine("branch", {})).toBeUndefined();
    expect(statLine("agent", {})).toBeUndefined();
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
    // Whole tokens/second, honestly rounded: the value is already an EWMA of
    // per-poll deltas, so a decimal would fake a precision the samples never
    // had. No fractional rendering, ever.
    expect(statLine("tps", { tps: 106.3 })).toBe("tps       106 tok/s");
    expect(statLine("tps", { tps: 106 })).toBe("tps       106 tok/s");
    expect(statLine("tps", { tps: 106.5 })).toBe("tps       107 tok/s");
    expect(statLine("tps", { tps: 0 })).toBeUndefined();
  });

  test("hides the tps row rather than printing a zero rate", () => {
    expect(statLine("tps", { tps: 0 })).toBeUndefined();
    expect(statLine("tps", { tps: Number.NaN })).toBeUndefined();
    // Below half a token/second rounds to zero, which hides rather than
    // printing "0 tok/s".
    expect(statLine("tps", { tps: 0.4 })).toBeUndefined();
    expect(statLine("tps", { tps: 0.5 })).toBe("tps       1 tok/s");
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

// The `go` row is the rail's only row whose severity lives on part of the line:
// one window over its limit turns red while its healthy neighbours keep the row
// colour. `statSegments` is the coloured view, `statLine` the plain one, and the
// plain text is the exact join of the segments — that invariant is what keeps
// the string tests and the JSX from drifting apart.
describe("the go usage row", () => {
  const NOW = Date.parse("2026-09-27T00:00:00.000Z");

  // The verified live shape: `{ usage: { rolling, weekly, monthly } }` with
  // `percent` 0–100 used. Normalized here exactly as the bridge normalizes it,
  // so the row is exercised against real data rather than a hand-built window.
  const live = () =>
    normalizeGoUsage({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-09-26T13:07:26.662Z" },
        weekly: { status: "ok", percent: 79, resetsAt: "2026-09-28T00:00:00.000Z" },
        monthly: { status: "ok", percent: 39, resetsAt: "2026-10-24T02:24:22.000Z" },
      },
    });

  test("draws the three live windows in fixed 5h → 1w → 1m order", () => {
    // 0, 79 and 39 from the live sample: a real zero, then two healthy dials.
    expect(statLine("go", { go: live() })).toBe("go        ○ 0 ◕ 79 ◑ 39");
  });

  test("renders the windows in order however the payload lists them", () => {
    const scrambled = {
      windows: [
        { id: "1m", ratio: 0.39 },
        { id: "5h", ratio: 0 },
        { id: "1w", ratio: 0.79 },
      ],
    };
    expect(statLine("go", { go: scrambled })).toBe("go        ○ 0 ◕ 79 ◑ 39");
  });

  test("the plain string is the exact join of the coloured segments", () => {
    const source = { go: live() };
    const line = statLine("go", source);
    const segments = statSegments("go", source);
    expect(segments).toBeDefined();
    expect(line).toBe("go        ○ 0 ◕ 79 ◑ 39");
    expect(segments!.map((segment) => segment.text).join("")).toBe(line!);
  });

  test("flags only the window at or above the error ratio", () => {
    const source = {
      go: {
        windows: [
          { id: "5h", ratio: 0 },
          { id: "1w", ratio: 0.95, resetAtMs: NOW + 2 * 3_600_000 },
          { id: "1m", ratio: 0.39 },
        ],
      },
    };
    const segments = statSegments("go", source, { nowMs: NOW })!;
    // The label and the two healthy dials keep the row's own colour; only the
    // flagged window's dial, number and reset hint take `error`.
    expect(segments.filter((segment) => segment.tone !== undefined)).toEqual([
      { text: "● 95", tone: "error" },
      { text: " · 2h", tone: "error" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe("go        ○ 0 ● 95 · 2h ◑ 39");
  });

  test("shows the reset suffix on the flagged window and nowhere else", () => {
    // A calm window with a known reset gets no hint: beside a healthy dial it is
    // noise. The flagged one carries it, and it is the only ` · ` on the row.
    const source = {
      go: {
        windows: [
          { id: "5h", ratio: 0.79, resetAtMs: NOW + 2 * 3_600_000 },
          { id: "1w", ratio: 0.95, resetAtMs: NOW + 2 * 3_600_000 },
        ],
      },
    };
    const line = statLine("go", source, { nowMs: NOW })!;
    expect(line).toBe("go        ◕ 79 ● 95 · 2h");
    expect(line.match(/ · /g)).toHaveLength(1);
  });

  test("draws a reset hint on the worst flagged window only", () => {
    // Three flagged windows would otherwise carry three hints and overflow the
    // rail. The fullest one (5h at 100) carries it and the other two are drawn
    // bare, even though they are also red.
    const source = {
      go: {
        windows: [
          { id: "5h", ratio: 1, resetAtMs: NOW + 3_600_000 },
          { id: "1w", ratio: 0.95, resetAtMs: NOW + 2 * 86_400_000 },
          { id: "1m", ratio: 0.95, resetAtMs: NOW + 30 * 86_400_000 },
        ],
      },
    };
    const line = statLine("go", source, { nowMs: NOW })!;
    expect(line.match(/ · /g)).toHaveLength(1);
    expect(line).toBe("go        ● 100 · 1h ● 95 ● 95");
  });

  test("puts the reset hint on the worst flagged window, not the earliest", () => {
    // The earliest flagged window is NOT the worst here: 5h sits at 90 and 1m at
    // 100. An implementation that took the first flagged index drew no hint at
    // all, so this case is the one the old suite could not see.
    const source = {
      go: {
        windows: [
          { id: "5h", ratio: 0.9, resetAtMs: NOW + 3_600_000 },
          { id: "1m", ratio: 1, resetAtMs: NOW + 3 * 3_600_000 },
        ],
      },
    };
    const line = statLine("go", source, { nowMs: NOW })!;
    expect(line.match(/ · /g)).toHaveLength(1);
    expect(line).toBe("go        ● 90 ● 100 · 3h");
  });

  test("breaks a ratio tie toward the earlier fixed window", () => {
    // Both flagged and equal, so the fixed 5h → 1w → 1m order decides: the 5h
    // window is the nearest relief and keeps the hint.
    const source = {
      go: {
        windows: [
          { id: "5h", ratio: 0.95, resetAtMs: NOW + 3_600_000 },
          { id: "1w", ratio: 0.95, resetAtMs: NOW + 2 * 86_400_000 },
        ],
      },
    };
    const line = statLine("go", source, { nowMs: NOW })!;
    expect(line.match(/ · /g)).toHaveLength(1);
    expect(line).toBe("go        ● 95 · 1h ● 95");
  });

  test("draws a real zero and falls back to the skeleton with no data", () => {
    // The empty circle doubles as the sane-zero: a fresh window reads `○ 0`,
    // never the persist layer's dash.
    expect(statLine("go", { go: { windows: [{ id: "5h", ratio: 0 }] } })).toBe("go        ○ 0");
    // No go data at all is no row from `statLine`, and the zero skeleton when
    // the rail is persistent — three calm dials, never the old dash.
    expect(statLine("go", {})).toBeUndefined();
    expect(statRows(["go"], {}, { persist: true })).toEqual(["go        ○ 0 ○ 0 ○ 0"]);
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
    expect(statLine("caution", { caution: "● sh\u0007ell running" })).toBe("caution   ● sh ell running");
  });
});

// A deterministic shuffle, so the order-independence claims are pinned against
// a real reordering rather than the one input order the test happened to write.
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    const current = out[index];
    const target = out[swap];
    if (current === undefined || target === undefined) continue;
    out[index] = target;
    out[swap] = current;
  }
  return out;
}

// The union helpers measure work actually done: generation tokens (output plus
// reasoning) summed over distinct turns, and the union of the assistant turns'
// own streaming spans. Idle between turns is never in the denominator. These
// pin the union arithmetic and the mandatory defences: dedup, clamp, pre-sort
// and merge.
describe("active-work throughput", () => {
  const NOW = 1_800_000_000_000;

  test("resolves a turn span from the timestamp rungs, ending at streamed", () => {
    // The end rung is fixed: `streamed` is the moment decoding stopped, the
    // numerator clock. `completed` settles the turn after its tools ran and is
    // only the fallback when `streamed` was never recorded.
    expect(turnSpan(1_000, 5_000, 4_000, NOW)).toEqual({ start: 1_000, end: 4_000 });
    // Whichever rung is missing, the other is the fallback.
    expect(turnSpan(1_000, 5_000, undefined, NOW)).toEqual({ start: 1_000, end: 5_000 });
    // Neither rung: the turn is in flight and ends at the caller's now.
    expect(turnSpan(1_000, undefined, undefined, NOW)).toEqual({ start: 1_000, end: NOW });
    // No usable start: the turn is skipped, never guessed at.
    expect(turnSpan(undefined, 5_000, 4_000, NOW)).toBeUndefined();
    expect(turnSpan("nope", 5_000, 4_000, NOW)).toBeUndefined();
    // A clock that cannot even say "now" leaves the in-flight end unresolvable.
    expect(turnSpan(1_000, undefined, undefined, Number.NaN)).toBeUndefined();
  });

  test("clamps a backwards clock to a zero-length span, never negative", () => {
    // `end < start` is skew: the span is zero-length rather than negative, so
    // it can never subtract time from the union.
    expect(turnSpan(5_000, 1_000, undefined, NOW)).toEqual({ start: 5_000, end: 5_000 });
    expect(unionSpanTotals([{ key: "a", tokens: 10, start: 5_000, end: 1_000 }])).toEqual({
      tokens: 10,
      unionMs: 0,
    });
  });

  test("returns zero tokens and zero time when there is nothing to sum", () => {
    expect(unionSpanTotals([])).toEqual({ tokens: 0, unionMs: 0 });
    expect(unionSpanTotals([{ key: "a", tokens: 0, start: 0, end: 5_000 }])).toEqual({
      tokens: 0,
      unionMs: 5_000,
    });
  });

  test("merges overlap and touch into one union, leaving gaps out", () => {
    // Overlapping turns: 100 tokens over a 2 s union, not 3 s.
    expect(
      unionSpanTotals([
        { key: "a", tokens: 60, start: 0, end: 1_000 },
        { key: "b", tokens: 40, start: 500, end: 2_000 },
      ]),
    ).toEqual({ tokens: 100, unionMs: 2_000 });
    // Touching turns merge too: 200 tokens over 2 s.
    expect(
      unionSpanTotals([
        { key: "a", tokens: 100, start: 0, end: 1_000 },
        { key: "b", tokens: 100, start: 1_000, end: 2_000 },
      ]),
    ).toEqual({ tokens: 200, unionMs: 2_000 });
    // A gap between turns is idle and is not counted: 200 tokens over 2 s.
    expect(
      unionSpanTotals([
        { key: "a", tokens: 100, start: 0, end: 1_000 },
        { key: "b", tokens: 100, start: 60_000, end: 61_000 },
      ]),
    ).toEqual({ tokens: 200, unionMs: 2_000 });
  });

  test("adds reasoning to the numerator alongside output", () => {
    // The same pair the official TUI sums, so a thinking-heavy model is not
    // under-reported: 60 output + 40 reasoning over 1 s.
    expect(unionSpanTotals([{ key: "a", tokens: 60, reasoning: 40, start: 0, end: 1_000 }])).toEqual({
      tokens: 100,
      unionMs: 1_000,
    });
    // Reasoning alone still sums: a turn that only thought has a numerator.
    expect(unionSpanTotals([{ key: "a", reasoning: 120, start: 0, end: 2_000 }])).toEqual({
      tokens: 120,
      unionMs: 2_000,
    });
    expect(unionSpanTotals([{ key: "a", reasoning: 0, start: 0, end: 2_000 }])).toEqual({
      tokens: 0,
      unionMs: 2_000,
    });
  });

  test("counts a stamped turn that produced no tokens in the denominator", () => {
    // The official TUI's rule: a step with a streamed rung counts in the
    // denominator even when it produced nothing. 100 tokens over the two 2 s
    // turns sum to 100 over 4 s; dropping the empty turn's span would leave 2 s.
    const spans = [
      { key: "producing", tokens: 100, start: 0, end: 2_000 },
      { key: "empty", tokens: 0, start: 2_000, end: 4_000 },
    ];
    expect(unionSpanTotals(spans)).toEqual({ tokens: 100, unionMs: 4_000 });
  });

  test("counts an identical duplicate once on both sides", () => {
    const turn = { key: "id:msg_1", tokens: 120, start: 0, end: 1_000 };
    expect(unionSpanTotals([turn, turn, turn])).toEqual({ tokens: 120, unionMs: 1_000 });
  });

  test("dedups by identity, so a conflicting repeat cannot widen the span", () => {
    // A replay carrying the same id keeps the first record: the denominator is
    // the first span, not the wider second one.
    expect(
      unionSpanTotals([
        { key: "id:msg_1", tokens: 60, start: 0, end: 1_000 },
        { key: "id:msg_1", tokens: 60, start: 0, end: 9_000 },
      ]),
    ).toEqual({ tokens: 60, unionMs: 1_000 });
  });

  test("builds the dedup key from the id, else the record tuple", () => {
    expect(turnKey("msg_1", 1, 2, 3)).toBe("id:msg_1");
    // No id: the fields that define the record, so a re-sent copy matches.
    expect(turnKey(undefined, 1, 2, 3)).toBe(turnKey(undefined, 1, 2, 3));
    expect(turnKey(undefined, 1, 2, 3)).not.toBe(turnKey(undefined, 1, 2, 4));
    expect(turnKey(undefined, 1, 2, 3)).not.toBe(turnKey(undefined, 9, 2, 3));
  });

  test("gives the same answer whatever order the turns arrive in", () => {
    const spans = [
      { key: "a", tokens: 60, start: 5_000, end: 9_000 },
      { key: "b", tokens: 40, start: 0, end: 3_000 },
      { key: "c", tokens: 90, start: 7_000, end: 12_000 },
    ];
    // b is 3 s; a and c overlap into one 7 s stretch; 190 tokens over 10 s.
    const expected = { tokens: 190, unionMs: 10_000 };
    expect(unionSpanTotals(spans)).toEqual(expected);
    expect(unionSpanTotals([...spans].reverse())).toEqual(expected);
    expect(unionSpanTotals(shuffle(spans, 7))).toEqual(expected);
  });

  test("property: the union stays inside the time actually available", () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const count = 1 + ((seed * 7) % 10);
      const spans: Array<{ key: string; tokens: number; start: number; end: number }> = [];
      for (let index = 0; index < count; index += 1) {
        const start = NOW - 1 - ((seed * 131 + index * 977) % 60_000);
        const width = 1 + ((seed * 17 + index * 53) % 5_000);
        spans.push({
          key: `s${seed}-${index}`,
          tokens: 1 + ((seed * 13 + index * 29) % 500),
          start,
          end: Math.min(NOW, start + width),
        });
      }
      const earliest = Math.min(...spans.map((span) => span.start));
      const forward = unionSpanTotals(spans);
      // Non-negative, and never more than the span from the earliest start to
      // the latest end (which cannot exceed now).
      expect(forward.unionMs).toBeGreaterThanOrEqual(0);
      expect(forward.unionMs).toBeLessThanOrEqual(NOW - earliest);
      // Reordering the input cannot change either side.
      const shuffled = shuffle(spans, seed);
      expect(unionSpanTotals(shuffled)).toEqual(forward);
    }
  });
});

// The live `tps` row is a NEAR-INSTANTANEOUS generation rate, not an average:
// the delta of generation tokens (output plus reasoning) between successive
// polls over the delta of generating time (the streaming-span union, which
// excludes idle by construction), smoothed with an EWMA (alpha 0.3) and
// repainted only on a move of >= 1 tok/s or >= 10%. The first poll only sets
// the baselines and reads as zero; a poll whose generating time did not
// advance reads as zero with the smoother untouched; rendering is whole
// tokens/second, never fractional.
describe("instantaneous tps", () => {
  test("divides deltas, never idle-inclusive totals", () => {
    expect(instantTpsRate(100, 2_000)).toBe(50);
    expect(instantTpsRate(0, 2_000)).toBe(0);
    // No new generating time is no sample, not a zero rate and never an
    // infinity: the tracker holds instead of dividing.
    expect(instantTpsRate(100, 0)).toBeUndefined();
    expect(instantTpsRate(100, -5)).toBeUndefined();
    expect(instantTpsRate(undefined, 2_000)).toBeUndefined();
  });

  test("smooths with an EWMA that bends instead of replacing", () => {
    // The first sample seeds the average directly.
    expect(smoothTpsRate(undefined, 100)).toBe(100);
    // Alpha 0.3: 100 moves 30% of the way toward 200.
    expect(smoothTpsRate(100, 200)).toBeCloseTo(130, 10);
    // A single slow poll dents the figure; it does not halve it.
    expect(smoothTpsRate(130, 0)).toBeCloseTo(91, 10);
  });

  test("repaints only past the hysteresis band", () => {
    // The first rate always paints.
    expect(tpsNeedsRepaint(undefined, 50)).toBe(true);
    // Sub-token jitter holds.
    expect(tpsNeedsRepaint(100, 100.5)).toBe(false);
    // One whole token/second moves it, and so does ten percent.
    expect(tpsNeedsRepaint(100, 101)).toBe(true);
    expect(tpsNeedsRepaint(100, 99)).toBe(true);
    expect(tpsNeedsRepaint(10, 11)).toBe(true);
    expect(tpsNeedsRepaint(10, 10.5)).toBe(false);
  });

  test("the TPS union counts generation, so reasoning reads as speed", () => {
    expect(unionGenerationTotals([{ key: "a", tokens: 60, reasoning: 40, start: 0, end: 1_000 }])).toEqual({
      tokens: 100,
      unionMs: 1_000,
    });
    // Reasoning alone is generation too: a thinking-heavy turn that emits
    // nothing still paced the decoder for two seconds.
    expect(unionGenerationTotals([{ key: "a", reasoning: 120, start: 0, end: 2_000 }])).toEqual({
      tokens: 120,
      unionMs: 2_000,
    });
    // Dedup and merge match the union's own rules.
    expect(
      unionGenerationTotals([
        { key: "id:msg_1", tokens: 60, reasoning: 40, start: 0, end: 1_000 },
        { key: "id:msg_1", tokens: 60, reasoning: 40, start: 0, end: 9_000 },
      ]),
    ).toEqual({ tokens: 100, unionMs: 1_000 });
  });

  test("an id-less streaming turn keeps one identity across polls, so repeat polls never inflate the rate", () => {
    // The review's mechanism: the fallback key embedded the growing output
    // count, so each poll of the same in-flight turn looked like a new span
    // and the union summed the cumulative snapshots repeatedly.
    const created = 1_000;
    const now = created + 10_000;
    const polls = [10, 20, 30].map((output) => {
      const span = turnSpan(created, undefined, undefined, now)!;
      return { key: turnKey(undefined, created, undefined, output), tokens: output, ...span };
    });
    // Stable identity: every poll keys the same, whatever the output count.
    expect(polls[1]?.key).toBe(polls[0]?.key);
    expect(polls[2]?.key).toBe(polls[0]?.key);
    // Every snapshot seen together (re-sent history beside the live record)
    // counts once: never above the single latest-poll baseline.
    const baseline = unionGenerationTotals([polls[2]!]);
    expect(unionGenerationTotals(polls).tokens).toBeLessThanOrEqual(baseline.tokens);
    expect(unionGenerationTotals(polls).unionMs).toBe(baseline.unionMs);
  });

  test("a settled id-less turn still keys on its final output count", () => {
    // Once `completed` is recorded the output count is final, so it stays in
    // the key and two settled records with different totals stay distinct.
    expect(turnKey(undefined, 1, 2, 3)).toBe(turnKey(undefined, 1, 2, 3));
    expect(turnKey(undefined, 1, 2, 3)).not.toBe(turnKey(undefined, 1, 2, 4));
    // A turn that finished decoding (`streamed` recorded, tools unsettled) has
    // a final output count too: same start, different totals stay distinct.
    expect(turnKey(undefined, 1, undefined, 200, 2)).not.toBe(turnKey(undefined, 1, undefined, 300, 2));
  });

  test("reads zero on first sight, never a seeded cumulative average", () => {
    // No rate is known yet on the first poll — not even the lifetime average,
    // which would flash a whole session's history as if it were live. A
    // session deep into its life (500 tokens over 2 s would seed 250) still
    // reads as zero until the next poll brings a delta to divide.
    expect(createInstantTps()(500, 500)).toBe(0);
    expect(createInstantTps()(5, 10_000)).toBe(0);
    expect(createInstantTps()(500, 2_000)).toBe(0);
  });

  test("tracks per-poll deltas once baselines are set", () => {
    const tps = createInstantTps();
    expect(tps(200, 2_000)).toBe(0);
    // 100 new tokens over 1 new second: instant 100, the first smoothed rate,
    // which always paints.
    expect(tps(300, 3_000)).toBe(100);
    // 400 new tokens over 1 new second: instant 400, EWMA bends 100 toward it
    // (100 + 0.3 * 300 = 190), which clears hysteresis and repaints.
    expect(tps(700, 4_000)).toBeCloseTo(190, 10);
  });

  test("reads zero while generating time does not advance, then resumes held", () => {
    const tps = createInstantTps();
    expect(tps(200, 2_000)).toBe(0);
    expect(tps(300, 3_000)).toBe(100);
    // The clock has not advanced: the session is not generating right now, so
    // the rate is zero — never a division by zero new time.
    expect(tps(300, 3_000)).toBe(0);
    // Work resumes: the delta spans only the new second, and the smoother
    // resumes from the held 100 rather than from zero — instant 100 bends
    // nothing, so the held figure stands.
    expect(tps(400, 4_000)).toBe(100);
  });

  test("rebaselines a backwards counter instead of dividing it", () => {
    const tps = createInstantTps();
    expect(tps(200, 2_000)).toBe(0);
    expect(tps(300, 3_000)).toBe(100);
    expect(tps(50, 1_000)).toBe(0);
    // The new baselines stand with a fresh smoother: the next honest delta
    // (100 tokens over 1 s) seeds 100 again, not a blend with the old era.
    expect(tps(150, 2_000)).toBe(100);
  });
});
// `unionSpanMs` is the token-blind twin of `unionSpanTotals`, used to seed
// `elapsed`. It shares the dedup, clamp, pre-sort and merge, and simply returns
// the wall time without the numerator `elapsed` has no use for.
describe("elapsed span union (tokens ignored)", () => {
  test("counts a zero-output turn's wall time", () => {
    // `unionSpanMs` returns the same wall time as `unionSpanTotals` for this
    // turn, without the token sum `elapsed` has no use for.
    expect(unionSpanMs([{ key: "a", tokens: 0, start: 0, end: 5_000 }])).toBe(5_000);
    expect(unionSpanMs([{ key: "a", start: 0, end: 5_000 }])).toBe(5_000);
    expect(unionSpanTotals([{ key: "a", tokens: 0, start: 0, end: 5_000 }])).toEqual({
      tokens: 0,
      unionMs: 5_000,
    });
  });

  test("merges overlapping and touching spans once", () => {
    expect(
      unionSpanMs([
        { key: "a", start: 0, end: 3_000 },
        { key: "b", start: 1_000, end: 5_000 },
      ]),
    ).toBe(5_000);
    // Touching (b starts exactly when a ends) is continuous work, not a gap.
    expect(
      unionSpanMs([
        { key: "a", start: 0, end: 3_000 },
        { key: "b", start: 3_000, end: 7_000 },
      ]),
    ).toBe(7_000);
    // A real gap on either side is counted once each.
    expect(
      unionSpanMs([
        { key: "a", start: 0, end: 1_000 },
        { key: "b", start: 5_000, end: 6_000 },
      ]),
    ).toBe(2_000);
  });

  test("counts a duplicate key once, first record winning", () => {
    expect(
      unionSpanMs([
        { key: "id:msg_1", start: 0, end: 1_000 },
        { key: "id:msg_1", start: 0, end: 9_000 },
      ]),
    ).toBe(1_000);
    // A missing key is skipped, and one with no usable start or end likewise.
    expect(unionSpanMs([{ start: 0, end: 9_000 }])).toBe(0);
    expect(unionSpanMs([{ key: "a", start: 0 }])).toBe(0);
    expect(unionSpanMs([{ key: "a", end: 9_000 }])).toBe(0);
  });

  test("clamps a backwards clock and cannot be reordered", () => {
    expect(unionSpanMs([{ key: "a", start: 5_000, end: 1_000 }])).toBe(0);
    const spans = [
      { key: "a", start: 5_000, end: 9_000 },
      { key: "b", start: 0, end: 3_000 },
      { key: "c", start: 7_000, end: 12_000 },
    ];
    // b is 3 s; a and c overlap into one 7 s stretch; total 10 s.
    expect(unionSpanMs(spans)).toBe(10_000);
    expect(unionSpanMs([...spans].reverse())).toBe(10_000);
    expect(unionSpanMs(shuffle(spans, 7))).toBe(10_000);
  });

  test("is zero when nothing is usable", () => {
    expect(unionSpanMs([])).toBe(0);
    expect(unionSpanMs([{ key: "a", start: "x", end: 5_000 }])).toBe(0);
  });
});

// The `ses` row draws a SHORT PRUNED PREVIEW of the session id - `clip` to 18
// cells, matching the `perms` row's column budget - because a full 30-character
// id runs past the roughly thirty-odd-column rail. The ellipsis `clip` appends
// is what tells the reader this is a preview of a longer value. The full id
// stays on the source and is what the row's click gesture copies, so the
// display and the copy are deliberately different strings. The row's label is
// `session` (the config key stays `ses`, with `session` accepted as an alias),
// and at a narrow `labelWidth` the preview budget shrinks by the label's column
// overflow so the row never grows because of the rename.
describe("the session-id row", () => {
  const FULL_ID = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";

  test("labels the row session, padded to the label width", () => {
    // The default label column is 10: `session` (7) plus three spaces.
    expect(statLine("ses", { sessionId: "ses_abcdefghijklmnopqrstuvwxyz" }, {})).toBe(
      "session   ses_abcdefghijklm…",
    );
  });

  test("accepts session as an alias for the ses key, byte for byte", () => {
    // The alias lives outside `STAT_FIELDS` (the config vocabulary) but passes
    // `isStatField` and canonicalizes at renderer entry.
    expect(isStatField("session")).toBe(true);
    expect(isStatField("ses")).toBe(true);
    expect(canonicalField("session")).toBe("ses");
    expect(canonicalField("ses")).toBe("ses");
    expect(canonicalField("cost")).toBe("cost");
    const source = { sessionId: "ses_abcdefghijklmnopqrstuvwxyz" };
    expect(statLine("session", source, {})).toBe(statLine("ses", source, {}));
    expect(statLine("session", source, {})).toBe("session   ses_abcdefghijklm…");
    expect(statRows(["session"], source, {})).toEqual(statRows(["ses"], source, {}));
    expect(statRows(["session"], {}, { persist: true })).toEqual(statRows(["ses"], {}, { persist: true }));
    // Neither spelling is segment-aware, so both agree on having no segments.
    expect(statSegments("session", source, {})).toBe(statSegments("ses", source, {}));
  });

  test("prunes a long id to a preview that fits the value column", () => {
    // A real 30-character id: `clip(id, 18)` keeps 17 characters plus its
    // ellipsis, so the value is 18 cells and the row cannot bleed.
    expect(statLine("ses", { sessionId: FULL_ID })).toBe(`session   ${FULL_ID.slice(0, 17)}…`);
  });

  test("the rendered row stays inside the label column plus an 18-cell value", () => {
    const line = statLine("ses", { sessionId: FULL_ID })!;
    // Label column (10) plus its guaranteed separator (1) plus the value budget
    // (18) is what the rail was designed to fit; the row must not exceed it.
    expect(line.length).toBeLessThanOrEqual(10 + 1 + 18);
    // The full id must never appear in the display.
    expect(line).not.toContain(FULL_ID);
    // And it still reads as a preview, not a silently truncated value.
    expect(line.endsWith("…")).toBe(true);
  });

  test("a short id is drawn whole, since it already fits", () => {
    // `clip` is width-aware, not a fixed slice: an id within the budget is
    // unchanged and gains no ellipsis.
    expect(statLine("ses", { sessionId: "ses_abcd" })).toBe("session   ses_abcd");
  });

  test("omits the row when the id is absent or not a string", () => {
    expect(statLine("ses", {})).toBeUndefined();
    expect(statLine("ses", { sessionId: 42 })).toBeUndefined();
    // Persistence still supplies the zero skeleton for a known field, and an
    // unknown name is still skipped when persistent.
    expect(statRows(["ses"], {}, { persist: true })).toEqual(["session   none"]);
    expect(statRows(["ses", "nope"], { sessionId: "ses_abcd" }, { persist: true })).toEqual([
      "session   ses_abcd",
    ]);
  });

  test("flattens a control character in the id before it is drawn", () => {
    // A newline in the middle of the id: `plain` replaces it, so the row can
    // never become two lines.
    expect(statLine("ses", { sessionId: "ses_ab\ncd1234" })).toBe("session   ses_ab cd1234");
  });
});

