import { describe, expect, test } from "bun:test";
import { normalizeGoUsage } from "../src/tui/go-usage.js";
import { clip, formatCost, formatCount, formatDuration, fuelBar, sessionThroughput, sparkline, statLine, statRows, statSegments, turnKey, turnSpan, unionSpanMs, unionSpanThroughput, unionSpanTotals } from "../src/tui/stats.js";

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

  test("draws a real zero and falls back to the placeholder with no data", () => {
    // The empty circle doubles as the sane-zero: a fresh window reads `○ 0`,
    // never the persist layer's dash.
    expect(statLine("go", { go: { windows: [{ id: "5h", ratio: 0 }] } })).toBe("go        ○ 0");
    // No go data at all is no row from `statLine`, and the placeholder when the
    // rail is persistent — the same shape every other row uses.
    expect(statLine("go", {})).toBeUndefined();
    expect(statRows(["go"], {}, { persist: true })).toEqual(["go        —"]);
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

// The tps row measures work actually done: output tokens divided by the union
// of the assistant turns' own spans. Idle between turns is never in the
// denominator, so an idle session keeps the figure it settled on instead of
// decaying or hiding. These pin the union arithmetic and the mandatory
// defences: dedup, clamp, pre-sort, and the one-second floor.
describe("active-work throughput", () => {
  const NOW = 1_800_000_000_000;

  test("resolves a turn span from the timestamp rungs, in flight ending at now", () => {
    // `completed` wins; `streamed` next; otherwise the turn is in flight and
    // ends at the caller's now.
    expect(turnSpan(1_000, 5_000, 4_000, NOW)).toEqual({ start: 1_000, end: 5_000 });
    expect(turnSpan(1_000, undefined, 4_000, NOW)).toEqual({ start: 1_000, end: 4_000 });
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
    expect(unionSpanThroughput([{ key: "a", tokens: 10, start: 5_000, end: 1_000 }])).toBeUndefined();
  });

  test("returns undefined when there is nothing to divide", () => {
    expect(unionSpanTotals([])).toEqual({ tokens: 0, unionMs: 0 });
    expect(unionSpanThroughput([])).toBeUndefined();
    // No positive output, or no usable span, is no rate at all.
    expect(unionSpanThroughput([{ key: "a", tokens: 0, start: 0, end: 10_000 }])).toBeUndefined();
    expect(unionSpanThroughput([{ key: "a", start: 0, end: 10_000 }])).toBeUndefined();
    expect(unionSpanThroughput([{ key: "a", tokens: -5, start: 0, end: 10_000 }])).toBeUndefined();
    expect(unionSpanThroughput([{ key: "a", tokens: 10, start: "x", end: 10_000 }])).toBeUndefined();
    // A zero-output turn contributes to neither side: both tokens and time drop.
    expect(unionSpanTotals([{ key: "a", tokens: 0, start: 0, end: 5_000 }])).toEqual({
      tokens: 0,
      unionMs: 0,
    });
  });

  test("divides tokens by the union of the spans, merging overlap and touch", () => {
    // Overlapping turns: 100 tokens over a 2 s union, not 3 s.
    expect(
      unionSpanThroughput([
        { key: "a", tokens: 60, start: 0, end: 1_000 },
        { key: "b", tokens: 40, start: 500, end: 2_000 },
      ]),
    ).toBe(50);
    // Touching turns merge too: 200 tokens over 2 s.
    expect(
      unionSpanThroughput([
        { key: "a", tokens: 100, start: 0, end: 1_000 },
        { key: "b", tokens: 100, start: 1_000, end: 2_000 },
      ]),
    ).toBe(100);
    // A gap between turns is idle and is not counted: 200 tokens over 2 s.
    expect(
      unionSpanThroughput([
        { key: "a", tokens: 100, start: 0, end: 1_000 },
        { key: "b", tokens: 100, start: 60_000, end: 61_000 },
      ]),
    ).toBe(100);
  });

  test("does not let a long idle gap lower the figure", () => {
    const close = [
      { key: "a", tokens: 300, start: 0, end: 1_000 },
      { key: "b", tokens: 300, start: 2_000, end: 3_000 },
    ];
    const farApart = [
      { key: "a", tokens: 300, start: 0, end: 1_000 },
      { key: "b", tokens: 300, start: 3_600_000, end: 3_601_000 },
    ];
    // Same tokens, same active time: an idle hour between them changes nothing.
    expect(unionSpanThroughput(farApart)).toBe(unionSpanThroughput(close));
    expect(unionSpanThroughput(farApart)).toBe(300);
  });

  test("counts an identical duplicate once on both sides", () => {
    const turn = { key: "id:msg_1", tokens: 120, start: 0, end: 1_000 };
    expect(unionSpanTotals([turn, turn, turn])).toEqual({ tokens: 120, unionMs: 1_000 });
    expect(unionSpanThroughput([turn, turn, turn])).toBe(120);
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

  test("floors a sliver of time at one second", () => {
    // Half a second of work would otherwise read as double the rate.
    expect(unionSpanThroughput([{ key: "a", tokens: 10, start: 0, end: 500 }])).toBe(10);
    expect(unionSpanThroughput([{ key: "a", tokens: 600, start: 0, end: 2_000 }])).toBe(300);
  });

  test("gives the same answer whatever order the turns arrive in", () => {
    const spans = [
      { key: "a", tokens: 60, start: 5_000, end: 9_000 },
      { key: "b", tokens: 40, start: 0, end: 3_000 },
      { key: "c", tokens: 90, start: 7_000, end: 12_000 },
    ];
    // b is 3 s; a and c overlap into one 7 s stretch; 190 tokens over 10 s.
    expect(unionSpanThroughput(spans)).toBe(19);
    expect(unionSpanThroughput([...spans].reverse())).toBe(19);
    expect(unionSpanThroughput(shuffle(spans, 7))).toBe(19);
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
      expect(unionSpanThroughput(shuffled)).toBe(unionSpanThroughput(spans));
    }
  });
});

// `unionSpanMs` is the token-blind twin of `unionSpanTotals`, used to seed
// `elapsed`. It shares the dedup, clamp, pre-sort and merge, but a zero-output
// turn still took wall time and must still contribute its span.
describe("elapsed span union (tokens ignored)", () => {
  test("counts a zero-output turn's wall time", () => {
    // `unionSpanTotals` drops this turn entirely (output <= 0), which is why it
    // cannot seed elapsed; the token-blind union keeps it.
    expect(unionSpanMs([{ key: "a", tokens: 0, start: 0, end: 5_000 }])).toBe(5_000);
    expect(unionSpanMs([{ key: "a", start: 0, end: 5_000 }])).toBe(5_000);
    expect(unionSpanTotals([{ key: "a", tokens: 0, start: 0, end: 5_000 }])).toEqual({
      tokens: 0,
      unionMs: 0,
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

