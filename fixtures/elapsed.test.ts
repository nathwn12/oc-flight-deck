// `elapsed` is the active time over the session scope's whole lifetime,
// derived from the host's own assistant-turn timestamps rather than
// accumulated in this process. A session left open overnight must not read as
// a night's work: the figure is the merged union of the scope's turn spans,
// so a restart recomputes the same figure instead of resetting, a turn in
// flight climbs while it runs, and a settled scope freezes. A per-session
// high-water mark keeps the row monotonic across compactions and failed
// reads. These tests drive the figure with a controlled `now`, so every
// transition is deterministic.

import { describe, expect, test } from "bun:test";
import { createActiveTime } from "../src/tui/session-elapsed.js";
import { createSessionReads } from "../src/tui/session-reads.js";

describe("active time derivation", () => {
  test("reads nothing to show yet as undefined", () => {
    const clock = createActiveTime({ spansOf: () => [] });
    expect(clock("s", 0)).toBeUndefined();
    expect(clock("s", 30_000)).toBeUndefined();
    expect(clock("s", 600_000)).toBeUndefined();
  });

  test("floors a throwing read at undefined rather than reaching the rail", () => {
    const clock = createActiveTime({
      spansOf: () => {
        throw new Error("no host");
      },
    });
    expect(clock("s", 0)).toBeUndefined();
  });

  test("a transient failure never shrinks the high-water", () => {
    let fail = false;
    const clock = createActiveTime({
      spansOf: () => {
        if (fail) throw new Error("no host");
        return [{ key: "a", start: 0, end: 4_000 }];
      },
    });
    expect(clock("s", 0)).toBe(4_000);
    fail = true;
    // The recompute degrades to empty, so the row holds what it showed.
    expect(clock("s", 60_000)).toBe(4_000);
  });

  test("serves a stepped-back clock from the record rather than rescanning", () => {
    let calls = 0;
    const clock = createActiveTime({
      spansOf: () => {
        calls += 1;
        return [{ key: "a", start: 0, end: 4_000 }];
      },
    });
    expect(clock("s", 10_000)).toBe(4_000);
    expect(clock("s", 5_000)).toBe(4_000);
    expect(calls).toBe(1);
  });

  test("caches the union for a second and recomputes after", () => {
    let calls = 0;
    const clock = createActiveTime({
      spansOf: () => {
        calls += 1;
        return [{ key: "a", start: 0, end: 4_000 }];
      },
    });
    expect(clock("s", 0)).toBe(4_000);
    // Within the display resolution the cached union is served, not rescanned.
    expect(clock("s", 500)).toBe(4_000);
    expect(calls).toBe(1);
    expect(clock("s", 1_500)).toBe(4_000);
    expect(calls).toBe(2);
  });

  test("a live session's mark survives crowding past the bound", () => {
    const seen = new Map<string, number>([["a", 4_000]]);
    const clock = createActiveTime(
      {
        spansOf: (id) => {
          const end = seen.get(id) ?? 0;
          return end === 0 ? [] : [{ key: `${id}:m1`, start: 0, end }];
        },
      },
      { maxSessions: 2 },
    );
    expect(clock("a", 0)).toBe(4_000);
    clock("b", 0);
    clock("c", 0);
    // No recency cut ever evicts a live session: with no `knows` read every
    // session counts as known, so the sweep drops nothing and "a" holds its
    // high-water even though the host record has since shrunk.
    seen.set("a", 900);
    expect(clock("a", 10_000)).toBe(4_000);
  });

  test("the sweep drops only sessions the host no longer knows", () => {
    const seen = new Map<string, number>([
      ["gone", 4_000],
      ["a", 4_000],
    ]);
    const clock = createActiveTime(
      {
        spansOf: (id) => {
          const end = seen.get(id) ?? 0;
          return end === 0 ? [] : [{ key: `${id}:m1`, start: 0, end }];
        },
        knows: (id) => id !== "gone",
      },
      { maxSessions: 2 },
    );
    expect(clock("gone", 0)).toBe(4_000);
    expect(clock("a", 0)).toBe(4_000);
    // Past the bound the sweep drops "gone" — the host forgot it — and keeps
    // "a". The revisit re-derives "gone" from the host's current record
    // instead of holding its stale mark, while "a" holds.
    clock("b", 0);
    seen.set("gone", 900);
    expect(clock("gone", 10_000)).toBe(900);
    expect(clock("a", 10_000)).toBe(4_000);
  });

  test("a live session's mark survives a 256-entry sweep", () => {
    // The defect's repro: the mark used to share the cache's LRU eviction, so
    // fifty other sessions threw it away and the row stepped backwards.
    let end = 10_000;
    const clock = createActiveTime({
      spansOf: () => [{ key: "x", start: 0, end }],
    });
    expect(clock("a", 10_000)).toBe(10_000);
    end = 1_000;
    for (let index = 0; index < 300; index += 1) clock(`b${index}`, 11_000);
    // Three hundred other sessions tripped the sweep, but the host still knows
    // "a": the shrunken recompute cannot move the held mark.
    expect(clock("a", 12_000)).toBe(10_000);
  });
});

// The figure reads its spans through `createSessionReads`, so these pin the
// coupling: the scope is the displayed session plus its family, `completed`
// ends a settled turn, and an unstamped host hides the row.
describe("session elapsed integration", () => {
  function stubContext(
    families: Record<string, readonly string[]> = {},
    messages: Record<string, readonly unknown[]> = {},
    status: string = "idle",
  ) {
    const directory = "C:\\workspace";
    const context = {
      location: { directory },
      data: {
        location: { default: () => ({ directory }), model: { list: () => [] } },
        session: {
          get: (id: string) => ({ id, time: { created: 0 } }),
          status: () => status,
          family: (id: string) => families[id] ?? [id],
          message: { list: (id: string) => messages[id] ?? [] },
          permission: { list: () => [] },
        },
        shell: { list: () => [] },
      },
    };
    return context as unknown as Parameters<typeof createSessionReads>[0];
  }

  // A completed assistant turn: a span the host has already stamped, so the
  // figure is deterministic and does not depend on the test's wall clock.
  const turn = (id: string, created: number, completed: number, output = 10) => ({
    id,
    type: "assistant",
    time: { created, completed },
    tokens: { output },
  });

  test("a fresh reader over the same host data reproduces the figure", () => {
    const families = { root: ["root"] };
    const messages = { root: [turn("m1", 0, 4_000), turn("m2", 6_000, 9_000)] };

    const before = createSessionReads(stubContext(families, messages));
    const first = before.sessionElapsed("root", 0);
    expect(first).toBe(7_000);

    // A restart (a brand-new reader) over the same host data comes back with
    // the work on record instead of `—`.
    const after = createSessionReads(stubContext(families, messages));
    expect(after.sessionElapsed("root", 100_000)).toBe(first);
    expect(after.sessionElapsed("root", 100_000)).toBeGreaterThan(0);
  });

  test("a second read after the list shrinks never reports less", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [turn("m1", 0, 4_000), turn("m2", 6_000, 9_000)],
    };
    const reads = createSessionReads(stubContext({ root: ["root"] }, messages));
    expect(reads.sessionElapsed("root", 0)).toBe(7_000);

    // A compaction drops the older record: the union recomputes smaller, but
    // the high-water holds what the row already showed.
    messages.root = [turn("m2", 6_000, 9_000)];
    expect(reads.sessionElapsed("root", 60_000)).toBe(7_000);
  });

  test("an in-flight turn climbs with now and freezes once completed", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [{ id: "live", type: "assistant", time: { created: 10_000 }, tokens: { output: 5 } }],
    };
    // The scope is working, so the uncompleted turn ends at `now` and the
    // figure climbs.
    const reads = createSessionReads(stubContext({ root: ["root"] }, messages, "running"));

    expect(reads.sessionElapsed("root", 12_000)).toBe(2_000);
    expect(reads.sessionElapsed("root", 15_000)).toBe(5_000);

    // Settled: the span ends at `completed` and `now` stops mattering.
    messages.root = [
      {
        id: "live",
        type: "assistant",
        time: { created: 10_000, completed: 16_000 },
        tokens: { output: 5 },
      },
    ];
    expect(reads.sessionElapsed("root", 50_000)).toBe(6_000);
    expect(reads.sessionElapsed("root", 500_000)).toBe(6_000);
  });

  test("a settled scope freezes and an empty one hides", () => {
    const reads = createSessionReads(
      stubContext({ root: ["root"] }, { root: [turn("m1", 0, 4_000), turn("m2", 6_000, 9_000)] }),
    );
    expect(reads.sessionElapsed("root", 0)).toBe(7_000);
    // Idle afterwards: the figure freezes on the recorded work.
    expect(reads.sessionElapsed("root", 500_000)).toBe(7_000);

    // Nothing on record anywhere: the row hides rather than printing zero.
    const empty = createSessionReads(stubContext({ root: ["root"] }, {}));
    expect(empty.sessionElapsed("root", 0)).toBeUndefined();
    expect(empty.sessionElapsed("root", 500_000)).toBeUndefined();
  });

  test("a live session's mark survives a 256-entry sweep through the reader", () => {
    const messages: Record<string, readonly unknown[]> = {
      a: [turn("m1", 0, 4_000)],
    };
    const reads = createSessionReads(stubContext({ a: ["a"] }, messages));
    expect(reads.sessionElapsed("a", 0)).toBe(4_000);
    for (let index = 0; index < 300; index += 1) {
      reads.sessionElapsed(`s${index}`, 0);
    }
    messages.a = [turn("m1", 0, 900)];
    // The sweep drops only sessions the host forgot: "a" is still known, so
    // the shrunken record cannot move the held mark (which would read 900 if
    // an eviction had thrown the mark away with the entry).
    expect(reads.sessionElapsed("a", 60_000)).toBe(4_000);
  });

  test("ends a settled turn at completed, not streamed, when both are stamped", () => {
    // `tps` ends this record at `streamed` (2 s of decoding); the elapsed
    // figure must not. It covers the turn's tool settlement at `completed`
    // (5 s), so the figure is 5 s — the settlement time stays in the tally.
    const reads = createSessionReads(
      stubContext({ root: ["root"] }, {
        root: [
          {
            id: "m1",
            type: "assistant",
            time: { created: 0, streamed: 2_000, completed: 5_000 },
            tokens: { output: 10 },
          },
        ],
      }),
    );
    expect(reads.sessionElapsed("root", 0)).toBe(5_000);
  });

  test("an uncompleted turn with streamed set grows while busy and freezes when idle", () => {
    // Finished streaming but tools still running: `streamed` is stamped, no
    // `completed` yet. Created=1000, streamed=6000.
    const messages: Record<string, readonly unknown[]> = {
      root: [
        {
          id: "m1",
          type: "assistant",
          time: { created: 1_000, streamed: 6_000 },
          tokens: { output: 5 },
        },
      ],
    };
    const families = { root: ["root"] };
    // The scope is working: the turn ends at `now`, so the settlement window
    // stays in the tally and the figure keeps growing past `streamed`.
    const working = createSessionReads(stubContext(families, messages, "running"));
    expect(working.sessionElapsed("root", 10_000)).toBe(9_000);
    expect(working.sessionElapsed("root", 12_000)).toBe(11_000);
    // Nothing working: the same record collapses to its last stamp, so a
    // stalled turn bills no idle time however far `now` advances.
    const settled = createSessionReads(stubContext(families, messages));
    expect(settled.sessionElapsed("root", 10_000)).toBe(5_000);
    expect(settled.sessionElapsed("root", 12_000)).toBe(5_000);
  });

  test("counts zero-output turns: wall time is wall time", () => {
    // Tokens are ignored by the union: a stamped step that took two seconds
    // still took two seconds, even with nothing to show for it.
    const reads = createSessionReads(
      stubContext({ root: ["root"] }, {
        root: [{ id: "m1", type: "assistant", time: { created: 0, completed: 2_000 } }],
      }),
    );
    expect(reads.sessionElapsed("root", 0)).toBe(2_000);
  });

  test("covers the same family scope busy() consults", () => {
    const families = { root: ["root", "child"], child: ["root", "child"] };
    const messages = {
      root: [turn("r1", 0, 1_000)],
      child: [turn("c1", 2_000, 5_000)],
    };
    const reads = createSessionReads(stubContext(families, messages));
    // The root's figure is the union across its tree: 1s + 3s.
    expect(reads.sessionElapsed("root", 0)).toBe(4_000);
  });

  test("an unstamped host hides the row", () => {
    const reads = createSessionReads(
      stubContext({ root: ["root"] }, {
        root: [{ id: "m1", type: "assistant", tokens: { output: 10 } }],
      }),
    );
    // No stamp: no span to derive from, so there is nothing honest to show.
    expect(reads.sessionElapsed("root", 0)).toBeUndefined();
    expect(reads.sessionElapsed("root", 500_000)).toBeUndefined();
  });

  test("a throwing family read degrades to the session's own turns", () => {
    const directory = "C:\\workspace";
    const context = {
      location: { directory },
      data: {
        location: { default: () => ({ directory }), model: { list: () => [] } },
        session: {
          get: (id: string) => ({ id, time: { created: 0 } }),
          status: () => "idle",
          family: () => {
            throw new Error("no family");
          },
          message: { list: () => [turn("m1", 0, 3_000)] },
          permission: { list: () => [] },
        },
        shell: { list: () => [] },
      },
    } as unknown as Parameters<typeof createSessionReads>[0];
    const reads = createSessionReads(context);
    expect(reads.sessionElapsed("root", 0)).toBe(3_000);
  });
});
