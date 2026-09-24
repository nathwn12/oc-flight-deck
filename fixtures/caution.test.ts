import { describe, expect, test } from "bun:test";
import {
  CAUTION_GLYPH,
  WATCH_GLYPH,
  cautionDetail,
  cautionText,
  detectCautions,
  formatElapsed,
  glyphFor,
  hasSevereCaution,
  readToolCall,
  stableKey,
  toolCalls,
  worstCaution,
  type CautionThresholds,
} from "../src/tui/caution.js";

// The annunciator's value is entirely in when it stays quiet. A caution light
// that fires on a slow build is one you learn to ignore, so most of these tests
// assert silence: an exempt tool, a settled tool, a healthy session.

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

const thresholds: CautionThresholds = {
  toolWatchMs: 3 * MINUTE,
  toolCautionMs: 7 * MINUTE,
  turnWatchMs: 10 * MINUTE,
  turnCautionMs: 20 * MINUTE,
  repeatThreshold: 3,
  exemptTools: ["question"],
};

function part(name: string, status: string, input: unknown, time: Record<string, number> = {}): unknown {
  return { type: "tool", id: `call_${name}`, name, state: { status, input }, time };
}

function shell(status: string, startedMsAgo: number, command = "npm install") {
  return { id: "sh_1", status, command, time: { started: NOW - startedMsAgo } };
}

function run(options: {
  parts?: readonly unknown[];
  shells?: readonly unknown[];
  sessionRunning?: boolean;
  lastMessageAt?: number;
  now?: number;
  overrides?: Partial<CautionThresholds>;
}) {
  return detectCautions({
    parts: options.parts ?? [],
    shells: options.shells ?? [],
    now: options.now ?? NOW,
    sessionRunning: options.sessionRunning ?? true,
    lastMessageAt: options.lastMessageAt,
    thresholds: { ...thresholds, ...options.overrides },
  });
}

const kinds = (found: ReturnType<typeof run>) => found.map((c) => c.kind);

// ---------------------------------------------------------------------------

describe("reading the host's shapes", () => {
  test("reads a tool part, preferring the recorded run time", () => {
    const call = readToolCall(part("shell", "running", { command: "ls" }, { created: 10, ran: 20 }));
    expect(call?.name).toBe("shell");
    expect(call?.startedAt).toBe(20);
    expect(call?.settledAt).toBeUndefined();
  });

  test("ignores text, reasoning and malformed parts", () => {
    expect(readToolCall({ type: "text", text: "hi" })).toBeUndefined();
    expect(readToolCall({ type: "tool", state: {} })).toBeUndefined();
    expect(readToolCall("nonsense")).toBeUndefined();
  });

  test("toolCalls keeps order and drops the rest", () => {
    const calls = toolCalls([
      { type: "text", text: "thinking" },
      part("read", "completed", { path: "a" }),
      part("grep", "completed", { pattern: "b" }),
    ]);
    expect(calls.map((c) => c.name)).toEqual(["read", "grep"]);
  });

  test("stableKey ignores key order so two identical inputs match", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
    expect(stableKey(undefined)).toBe("");
  });
});

describe("rule 1 — a tool that has not come back", () => {
  test("silent below the watch threshold", () => {
    expect(run({ parts: [part("shell", "running", {}, { ran: NOW - MINUTE })] })).toEqual([]);
  });

  test("notes it past the watch threshold, escalates past the caution one", () => {
    const watch = run({ parts: [part("shell", "running", {}, { ran: NOW - 5 * MINUTE })] });
    expect(watch[0]?.severity).toBe("watch");
    expect(watch[0]?.elapsedMs).toBe(5 * MINUTE);

    const severe = run({ parts: [part("shell", "running", {}, { ran: NOW - 8 * MINUTE })] });
    expect(severe[0]?.severity).toBe("caution");
  });

  test("silent once the tool has settled", () => {
    expect(
      run({
        parts: [part("shell", "completed", {}, { ran: NOW - 30 * MINUTE, completed: NOW - 29 * MINUTE })],
        sessionRunning: false,
      }),
    ).toEqual([]);
  });

  test("silent when the host recorded no start time", () => {
    // No start means no measurable duration, and a guess is worse than silence.
    expect(run({ parts: [part("shell", "running", {})] })).toEqual([]);
  });

  test("reports the real phase: a still-streaming call is not 'running'", () => {
    const found = run({ parts: [part("write", "streaming", "{", { created: NOW - 5 * MINUTE })] });
    expect(found[0]?.status).toBe("streaming");
    expect(cautionText(found[0]!)).toContain("streaming");
    expect(cautionText(found[0]!)).not.toContain("running");
  });

  test("never flags an exempt tool, however long it runs", () => {
    // `question` waits for a person: by the clock that is a hang.
    expect(run({ parts: [part("question", "running", {}, { ran: NOW - 60 * MINUTE })] })).toEqual([]);
  });

  test("reports the newest running tool, not the oldest", () => {
    const found = run({
      parts: [
        part("read", "running", {}, { ran: NOW - 20 * MINUTE }),
        part("shell", "running", {}, { ran: NOW - 4 * MINUTE }),
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.tool).toBe("shell");
  });
});

describe("rule 2 — a shell the host still reports as running", () => {
  test("catches a backgrounded command the tool part can no longer see", () => {
    // A backgrounded command returns its tool result immediately, so the part
    // settles while the process keeps going. This is the only signal that
    // survives that, and it is why this rule is separate from rule 1.
    const found = run({
      parts: [part("shell", "completed", {}, { ran: NOW - 9 * MINUTE, completed: NOW - 8 * MINUTE })],
      shells: [shell("running", 8 * MINUTE)],
    });
    expect(kinds(found)).toContain("hung-shell");
    expect(found[0]?.severity).toBe("caution");
  });

  test("silent for a shell that already exited", () => {
    expect(run({ shells: [shell("exited", 30 * MINUTE)] })).toEqual([]);
  });

  test("keeps only the longest-running shell", () => {
    const found = run({
      shells: [shell("running", 4 * MINUTE, "a"), shell("running", 12 * MINUTE, "b")],
    });
    expect(found.filter((c) => c.kind === "hung-shell")).toHaveLength(1);
    expect(found[0]?.elapsedMs).toBe(12 * MINUTE);
  });
});

describe("rule 3 — the same call over and over", () => {
  const same = { path: "src/index.ts" };

  test("silent on two identical calls; two is a retry", () => {
    expect(run({ parts: [part("read", "completed", same), part("read", "completed", same)] })).toEqual([]);
  });

  test("flags three identical consecutive calls", () => {
    const found = run({
      parts: [part("read", "completed", same), part("read", "completed", same), part("read", "completed", same)],
    });
    const repeat = found.find((c) => c.kind === "repeat-loop");
    expect(repeat?.severity).toBe("caution");
    expect(repeat?.repeats).toBe(3);
  });

  test("silent when a different call breaks the run", () => {
    const found = run({
      parts: [
        part("read", "completed", same),
        part("grep", "completed", { pattern: "x" }),
        part("read", "completed", same),
      ],
    });
    expect(kinds(found)).not.toContain("repeat-loop");
  });

  test("treats reordered identical input as identical", () => {
    const found = run({
      parts: [
        part("edit", "completed", { file: "a", text: "x" }),
        part("edit", "completed", { text: "x", file: "a" }),
        part("edit", "completed", { file: "a", text: "x" }),
      ],
    });
    expect(kinds(found)).toContain("repeat-loop");
  });
});

describe("rule 4 — the same call failing over and over", () => {
  test("flags an identical error repeated, which is the real death spiral", () => {
    // Measured on real history: the genuine loop was an agent calling the same
    // unavailable tool and being refused each time, not repeating a success.
    const found = run({
      parts: [
        part("bash", "error", { command: "ls" }),
        part("bash", "error", { command: "ls" }),
        part("bash", "error", { command: "ls" }),
      ],
    });
    expect(kinds(found)).toContain("failure-loop");
    expect(found.find((c) => c.kind === "failure-loop")?.severity).toBe("caution");
  });

  test("silent for errors that differ", () => {
    const found = run({
      parts: [
        part("read", "error", { path: "a" }),
        part("read", "error", { path: "b" }),
        part("read", "error", { path: "c" }),
      ],
    });
    expect(kinds(found)).not.toContain("failure-loop");
  });

  test("silent for successes, which rule 3 covers instead", () => {
    const found = run({
      parts: [
        part("read", "completed", { path: "a" }),
        part("read", "completed", { path: "a" }),
        part("read", "completed", { path: "a" }),
      ],
    });
    expect(kinds(found)).toContain("repeat-loop");
    expect(kinds(found)).not.toContain("failure-loop");
  });
});

describe("rule 5 — running, but nothing is moving", () => {
  const settled = (ago: number) =>
    part("read", "completed", { path: "a" }, { ran: NOW - ago - 1_000, completed: NOW - ago });

  test("notes a quiet running session, and escalates", () => {
    expect(run({ parts: [settled(11 * MINUTE)] })[0]?.severity).toBe("watch");
    expect(run({ parts: [settled(21 * MINUTE)] })[0]?.severity).toBe("caution");
  });

  test("silent when the session is not running", () => {
    expect(run({ parts: [settled(60 * MINUTE)], sessionRunning: false })).toEqual([]);
  });

  test("silent while a tool is running, because rule 1 owns that", () => {
    expect(run({ parts: [settled(30 * MINUTE), part("shell", "running", {}, { ran: NOW - 1_000 })] })).toEqual([]);
  });

  test("silent while a shell is running, because rule 2 owns that", () => {
    expect(run({ parts: [settled(30 * MINUTE)], shells: [shell("running", 1_000)] })).toEqual([]);
  });

  test("falls back to the newest message when there are no tool parts", () => {
    expect(kinds(run({ parts: [], lastMessageAt: NOW - 12 * MINUTE }))).toEqual(["silent-turn"]);
  });

  test("silent with nothing to measure from", () => {
    expect(run({ parts: [] })).toEqual([]);
  });
});

describe("ordering, helpers and wording", () => {
  test("sorts cautions ahead of watches", () => {
    const found = run({
      parts: [settledForTest(), part("shell", "running", {}, { ran: NOW - 8 * MINUTE })],
    });
    expect(found[0]?.severity).toBe("caution");
  });

  test("worstCaution picks the most severe", () => {
    const found = [
      { kind: "silent-turn" as const, severity: "watch" as const, key: "a" },
      { kind: "repeat-loop" as const, severity: "caution" as const, key: "b" },
    ];
    expect(worstCaution(found)?.key).toBe("b");
    expect(worstCaution([])).toBeUndefined();
  });

  test("hasSevereCaution is true only for a real caution", () => {
    expect(hasSevereCaution([{ kind: "hung-tool", severity: "watch", key: "k" }])).toBe(false);
    expect(hasSevereCaution([{ kind: "hung-tool", severity: "caution", key: "k" }])).toBe(true);
  });

  test("says what was seen, not what it means", () => {
    const found = run({ parts: [part("shell", "running", {}, { ran: NOW - 8 * MINUTE })] });
    expect(cautionText(found[0]!)).toBe(`${CAUTION_GLYPH} shell running 8m00s`);
    expect(glyphFor(found[0])).toBe(CAUTION_GLYPH);
    expect(glyphFor(undefined)).toBe("○");
    expect(WATCH_GLYPH).toBe("▲");
  });

  test("a quiet turn admits it could be thinking rather than wedged", () => {
    const found = run({ parts: [], lastMessageAt: NOW - 21 * MINUTE });
    const detail = cautionDetail(found[0]!);
    expect(detail).toContain("thinking");
    expect(detail).toContain("wedged");
  });

  test("formatElapsed covers seconds, minutes and hours", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(14 * MINUTE)).toBe("14m00s");
    expect(formatElapsed(8 * MINUTE + 41_000)).toBe("8m41s");
    expect(formatElapsed(61_000)).toBe("1m01s");
    expect(formatElapsed(2 * 60 * MINUTE + 14 * MINUTE)).toBe("2h14m00s");
    expect(formatElapsed(2 * 60 * MINUTE + 14 * MINUTE + 37_000)).toBe("2h14m37s");
    expect(formatElapsed(3 * 60 * MINUTE)).toBe("3h00m00s");
    expect(formatElapsed(-5_000)).toBe("0s");
  });

  test("a healthy session produces nothing at all", () => {
    expect(
      run({
        parts: [part("edit", "completed", { path: "a", text: "x" }, { ran: NOW - 3_000, completed: NOW - 2_000 })],
        sessionRunning: false,
      }),
    ).toEqual([]);
  });
});

/** A settled tool long enough ago to trip rule 5 on its own. */
function settledForTest() {
  return part("read", "completed", { path: "a" }, { ran: NOW - 11 * MINUTE - 1_000, completed: NOW - 11 * MINUTE });
}

// The threshold comparisons are the whole product: a stroke the wrong way either
// fires on a normal build or never escalates at all. `>=` and `<` are pinned
// here so an off-by-one cannot ship quietly.
describe("threshold boundaries", () => {
  function runningFor(ms: number) {
    return part("shell", "running", { command: "bun test" }, { created: NOW - ms, ran: NOW - ms });
  }

  test("a tool fires exactly at the watch threshold, not a millisecond later", () => {
    const atWatch = run({ parts: [runningFor(3 * MINUTE)] });
    expect(kinds(atWatch)).toEqual(["hung-tool"]);
    expect(atWatch[0]?.severity).toBe("watch");
    // One millisecond short is silence: nothing has been observed yet.
    expect(run({ parts: [runningFor(3 * MINUTE - 1)] })).toEqual([]);
  });

  test("escalates exactly at the caution threshold", () => {
    expect(run({ parts: [runningFor(7 * MINUTE)] })[0]?.severity).toBe("caution");
    expect(run({ parts: [runningFor(7 * MINUTE - 1)] })[0]?.severity).toBe("watch");
  });

  test("a silent turn fires exactly at its watch threshold", () => {
    const settledAt = NOW - 10 * MINUTE;
    const atThreshold = run({
      parts: [part("read", "completed", { path: "a" }, { ran: settledAt, completed: settledAt })],
    });
    expect(kinds(atThreshold)).toEqual(["silent-turn"]);
    expect(atThreshold[0]?.severity).toBe("watch");

    const justShort = NOW - 10 * MINUTE + 1;
    expect(
      run({ parts: [part("read", "completed", { path: "a" }, { ran: justShort, completed: justShort })] }),
    ).toEqual([]);
  });
});
