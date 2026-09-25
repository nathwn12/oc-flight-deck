// `elapsed` is accumulated active wall time, not wall-clock since the session
// was created. A session left open overnight must not read as a night's work:
// the clock runs only while the displayed session, its agent family, or one of
// its owned shells is busy, and freezes the moment everything settles. These
// tests drive that clock with a controlled `now` and a scripted busy predicate,
// so every transition is deterministic.

import { describe, expect, test } from "bun:test";
import { createActiveElapsed } from "../src/tui/active-elapsed.js";
import { createSessionReads } from "../src/tui/session-reads.js";

describe("active elapsed clock", () => {
  test("stays at zero while nothing has ever run", () => {
    const clock = createActiveElapsed(() => false);
    expect(clock("s", 0)).toBeUndefined();
    expect(clock("s", 30_000)).toBeUndefined();
    expect(clock("s", 600_000)).toBeUndefined();
  });

  test("freezes while idle and resumes cumulatively while busy", () => {
    let busy = false;
    const clock = createActiveElapsed(() => busy);

    // Idle at start: the first two seconds are not work and must not bank.
    expect(clock("s", 0)).toBeUndefined();
    expect(clock("s", 2_000)).toBeUndefined();

    // Busy begins somewhere before the next observation.
    busy = true;
    expect(clock("s", 2_000)).toBeUndefined();
    expect(clock("s", 3_000)).toBe(1_000);

    // Idle again: the seven-second gap must not count.
    busy = false;
    expect(clock("s", 10_000)).toBe(1_000);
    expect(clock("s", 30_000)).toBe(1_000);

    // Resuming continues from the banked second, not from zero.
    busy = true;
    expect(clock("s", 31_000)).toBe(1_000);
    expect(clock("s", 32_500)).toBe(2_500);
  });

  test("treats an unknown busy state as frozen", () => {
    // The host has not said either way; inventing motion is worse than silence.
    const clock = createActiveElapsed(() => undefined);
    expect(clock("s", 0)).toBeUndefined();
    expect(clock("s", 120_000)).toBeUndefined();
  });

  test("treats a throwing busy read as frozen", () => {
    const clock = createActiveElapsed(() => {
      throw new Error("no host");
    });
    expect(clock("s", 0)).toBeUndefined();
    expect(clock("s", 120_000)).toBeUndefined();
  });

  test("keeps unrelated sessions independent", () => {
    const working = new Set(["busy"]);
    const clock = createActiveElapsed((id) => working.has(id));

    // Two reads in a row while only `busy` is on screen bank its one second.
    expect(clock("busy", 0)).toBeUndefined();
    expect(clock("busy", 1_000)).toBe(1_000);

    // `idle` is not busy, so it banks nothing for itself...
    expect(clock("idle", 1_000)).toBeUndefined();
    expect(clock("idle", 9_000)).toBeUndefined();

    // ...and because it was on screen in between, `busy`'s next read
    // rebaselines rather than banking the away window: its tally stays at the
    // value banked while it was on screen.
    expect(clock("busy", 9_000)).toBe(1_000);

    // However long `busy` then runs, a later look at `idle` still banks
    // nothing for it, while `busy` resumed from its fresh baseline.
    expect(clock("busy", 20_000)).toBe(12_000);
    expect(clock("idle", 20_000)).toBeUndefined();
  });

  test("does not rewind when the clock stalls or steps back", () => {
    const clock = createActiveElapsed(() => true);
    expect(clock("s", 1_000)).toBeUndefined();
    expect(clock("s", 2_000)).toBe(1_000);
    // A non-monotonic host clock must never subtract banked time.
    const banked = clock("s", 1_500);
    expect(banked).toBe(1_000);
    expect(clock("s", 1_500)).toBe(banked as number);
    expect(clock("s", 2_000)).toBeGreaterThanOrEqual(banked as number);
  });

  test("does not bank a gap while a different session was on screen", () => {
    // The clock sees one session at a time. Reading B in between means A's gap
    // was never observed, however long the tally would otherwise bill it. The
    // cap is deliberately generous so only the session boundary can stop it.
    const working = new Set(["a"]);
    const clock = createActiveElapsed((id) => working.has(id), { maxBankedMs: 3_600_000 });

    expect(clock("a", 0)).toBeUndefined();
    expect(clock("a", 1_000)).toBe(1_000);

    expect(clock("b", 1_000)).toBeUndefined();
    // A was busy at both ends, but the away window must not be banked; only a
    // fresh baseline is taken when A comes back on screen.
    expect(clock("a", 100_000)).toBe(1_000);
    // Normal accumulation resumes from that baseline.
    expect(clock("a", 101_000)).toBe(2_000);
  });

  test("does not bank an unobserved gap beyond the cap", () => {
    // A suspended process is busy at both ends of a window it never saw. The
    // cap treats that window as unobserved: undercount, never over-count.
    const clock = createActiveElapsed(() => true, { maxBankedMs: 5_000 });

    expect(clock("s", 0)).toBeUndefined();
    expect(clock("s", 1_000)).toBe(1_000);
    // Ten minutes of sleep: far beyond the cap, so nothing is banked.
    expect(clock("s", 601_000)).toBe(1_000);
    // A normal in-bound read resumes accumulation from the fresh baseline.
    expect(clock("s", 602_000)).toBe(2_000);
  });

  test("starts from a seed, then accumulates observed work on top", () => {
    // The seed is host-recorded work already on record; the accumulator then
    // adds the busy windows seen this process.
    const clock = createActiveElapsed(() => true, { seedOf: () => 5_000 });
    expect(clock("s", 0)).toBe(5_000);
    expect(clock("s", 1_000)).toBe(6_000);
    expect(clock("s", 2_500)).toBe(7_500);
  });

  test("asks for the seed exactly once per session", () => {
    let calls = 0;
    const clock = createActiveElapsed(() => true, {
      seedOf: () => {
        calls += 1;
        return 3_000;
      },
    });
    expect(clock("s", 0)).toBe(3_000);
    expect(clock("s", 1_000)).toBe(4_000);
    expect(clock("s", 2_000)).toBe(5_000);
    expect(calls).toBe(1);
  });

  test("floors a non-finite, negative or throwing seed at zero", () => {
    // A NaN or backwards seed must never poison the tally; a throwing read
    // must never reach the rail.
    const nan = createActiveElapsed(() => false, { seedOf: () => Number.NaN });
    expect(nan("s", 0)).toBeUndefined();
    const infinite = createActiveElapsed(() => false, { seedOf: () => Number.POSITIVE_INFINITY });
    expect(infinite("s", 0)).toBeUndefined();
    const negative = createActiveElapsed(() => false, { seedOf: () => -50 });
    expect(negative("s", 0)).toBeUndefined();
    const throwing = createActiveElapsed(() => false, {
      seedOf: () => {
        throw new Error("no host");
      },
    });
    expect(throwing("s", 0)).toBeUndefined();
  });

  test("a seeded tally still freezes on idle, unknown and throwing busy", () => {
    const seed = () => 4_000;
    const idle = createActiveElapsed(() => false, { seedOf: seed });
    expect(idle("s", 0)).toBe(4_000);
    expect(idle("s", 90_000)).toBe(4_000);

    const unknown = createActiveElapsed(() => undefined, { seedOf: seed });
    expect(unknown("s", 0)).toBe(4_000);
    expect(unknown("s", 90_000)).toBe(4_000);

    const throwing = createActiveElapsed(
      () => {
        throw new Error("no host");
      },
      { seedOf: seed },
    );
    expect(throwing("s", 0)).toBe(4_000);
    expect(throwing("s", 90_000)).toBe(4_000);
  });
});

// The clock reads its verdict from `busy()`, so these pin the coupling: a
// running subagent or shell is activity for the root, but a sibling or an
// unrelated session is not, and two simultaneous activities still count once.
describe("session elapsed integration", () => {
  function stubContext(
    statuses: Record<string, string | undefined>,
    families: Record<string, readonly string[]> = {},
    shells: readonly unknown[] = [],
    messages: Record<string, readonly unknown[]> = {},
  ) {
    const directory = "C:\\workspace";
    const context = {
      location: { directory },
      data: {
        location: { default: () => ({ directory }), model: { list: () => [] } },
        session: {
          get: (id: string) => ({ id, time: { created: 0 } }),
          status: (id: string) => statuses[id],
          family: (id: string) => families[id] ?? [id],
          message: { list: (id: string) => messages[id] ?? [] },
          permission: { list: () => [] },
        },
        shell: { list: () => shells },
      },
    };
    return context as unknown as Parameters<typeof createSessionReads>[0];
  }

  // A completed assistant turn: a span the host has already stamped, so the
  // seed is deterministic and does not depend on the test's wall clock.
  const turn = (id: string, created: number, completed: number, output = 10) => ({
    id,
    type: "assistant",
    time: { created, completed },
    tokens: { output },
  });

  test("counts overlapping session and subagent activity once", () => {
    const reads = createSessionReads(
      stubContext({ root: "running", child: "running" }, { root: ["root", "child"] }),
    );

    expect(reads.sessionElapsed("root", 0)).toBeUndefined();
    // Both the root and its subagent are running, but time is time: 1s, not 2s.
    expect(reads.sessionElapsed("root", 1_000)).toBe(1_000);
    expect(reads.sessionElapsed("root", 2_500)).toBe(2_500);
  });

  test("counts an owned running shell as activity", () => {
    const reads = createSessionReads(
      stubContext(
        { root: "idle" },
        { root: ["root"] },
        [{ metadata: { sessionID: "root" }, status: "running" }],
      ),
    );

    expect(reads.sessionElapsed("root", 0)).toBeUndefined();
    expect(reads.sessionElapsed("root", 1_000)).toBe(1_000);
  });

  test("freezes once the session and its family settle", () => {
    const statuses: Record<string, string | undefined> = { root: "running" };
    const reads = createSessionReads(stubContext(statuses, { root: ["root"] }));

    expect(reads.sessionElapsed("root", 0)).toBeUndefined();
    expect(reads.sessionElapsed("root", 2_000)).toBe(2_000);

    statuses.root = "idle";
    expect(reads.sessionElapsed("root", 9_000)).toBe(2_000);
    expect(reads.sessionElapsed("root", 40_000)).toBe(2_000);
  });

  test("bounds the banked window when a cap is supplied", () => {
    const reads = createSessionReads(
      stubContext({ root: "running" }, { root: ["root"] }),
      5_000,
    );

    expect(reads.sessionElapsed("root", 0)).toBeUndefined();
    expect(reads.sessionElapsed("root", 1_000)).toBe(1_000);
    // Beyond the cap the window was unobserved, so it banks nothing...
    expect(reads.sessionElapsed("root", 601_000)).toBe(1_000);
    // ...and a normal read resumes from the fresh baseline.
    expect(reads.sessionElapsed("root", 602_000)).toBe(2_000);
  });

  test("an unrelated session contributes nothing", () => {
    const reads = createSessionReads(
      stubContext({ root: "running" }, { root: ["root"], other: ["other"] }),
    );

    expect(reads.sessionElapsed("other", 0)).toBeUndefined();
    expect(reads.sessionElapsed("root", 0)).toBeUndefined();
    expect(reads.sessionElapsed("root", 1_000)).toBe(1_000);
    expect(reads.sessionElapsed("other", 1_000)).toBeUndefined();
    expect(reads.sessionElapsed("other", 15_000)).toBeUndefined();
  });

  test("seeds a first idle read from the session's recorded turns", () => {
    // Two completed turns, four and three seconds, with a two-second idle gap
    // between them that the union must exclude.
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root"] }, [], {
        root: [turn("m1", 0, 4_000), turn("m2", 6_000, 9_000)],
      }),
    );
    expect(reads.sessionElapsed("root", 0)).toBe(7_000);
    // Idle afterwards: the figure freezes on the seeded value.
    expect(reads.sessionElapsed("root", 500_000)).toBe(7_000);
  });

  test("a fresh clock over the same host data reproduces the seeded figure", () => {
    const families = { root: ["root"] };
    const messages = { root: [turn("m1", 0, 4_000), turn("m2", 6_000, 9_000)] };

    const before = createSessionReads(stubContext({ root: "idle" }, families, [], messages));
    const first = before.sessionElapsed("root", 0);
    expect(first).toBe(7_000);

    // A restart (a brand-new reader) over the same host data comes back with
    // the work on record instead of `—`.
    const after = createSessionReads(stubContext({ root: "idle" }, families, [], messages));
    expect(after.sessionElapsed("root", 100_000)).toBe(first);
    expect(after.sessionElapsed("root", 100_000)).toBeGreaterThan(0);
  });

  test("an in-flight turn seeds once and is never counted twice", () => {
    const created = Date.now() - 4_000;
    const reads = createSessionReads(
      stubContext({ root: "running" }, { root: ["root"] }, [], {
        root: [{ id: "live", type: "assistant", time: { created }, tokens: { output: 5 } }],
      }),
    );

    const seed = reads.sessionElapsed("root", 0);
    expect(seed).toBeGreaterThan(0);
    // The post-seed busy windows add on top of the seed; the turn in flight,
    // already billed into the seed as [created, now], is not billed again.
    expect(reads.sessionElapsed("root", 1_000)).toBe((seed as number) + 1_000);
    expect(reads.sessionElapsed("root", 2_500)).toBe((seed as number) + 2_500);
  });

  test("a seeded tally still banks nothing across a session switch", () => {
    // Generous cap so only the session boundary can stop the window.
    const reads = createSessionReads(
      stubContext({ a: "running", b: "idle" }, { a: ["a"], b: ["b"] }, [], {
        a: [turn("a1", 0, 2_000)],
        b: [turn("b1", 0, 1_000)],
      }),
      3_600_000,
    );

    expect(reads.sessionElapsed("a", 0)).toBe(2_000);
    expect(reads.sessionElapsed("a", 1_000)).toBe(3_000);
    expect(reads.sessionElapsed("b", 1_000)).toBe(1_000);
    // A was busy at both ends, but the away window was off-watch: no banking.
    expect(reads.sessionElapsed("a", 100_000)).toBe(3_000);
    expect(reads.sessionElapsed("a", 101_000)).toBe(4_000);
  });

  test("a seeded tally still banks nothing beyond the cap", () => {
    const reads = createSessionReads(
      stubContext({ root: "running" }, { root: ["root"] }, [], { root: [turn("m1", 0, 2_000)] }),
      5_000,
    );

    expect(reads.sessionElapsed("root", 0)).toBe(2_000);
    expect(reads.sessionElapsed("root", 1_000)).toBe(3_000);
    // Beyond the cap the window was unobserved, so it banks nothing...
    expect(reads.sessionElapsed("root", 601_000)).toBe(3_000);
    // ...and a normal read resumes from the fresh baseline.
    expect(reads.sessionElapsed("root", 602_000)).toBe(4_000);
  });

  test("seeds from the same family scope busy() consults", () => {
    const families = { root: ["root", "child"], child: ["root", "child"] };
    const messages = {
      root: [turn("r1", 0, 1_000)],
      child: [turn("c1", 2_000, 5_000)],
    };
    const reads = createSessionReads(stubContext({ root: "idle", child: "idle" }, families, [], messages));
    // The root's seed is the union across its tree: 1s + 3s.
    expect(reads.sessionElapsed("root", 0)).toBe(4_000);

    // A child asking `family()` gets the whole tree on this host too, so its
    // seed uses the same scope `busy()` would consult — not gated on being
    // the family root.
    const childReads = createSessionReads(
      stubContext({ root: "idle", child: "idle" }, families, [], messages),
    );
    expect(childReads.sessionElapsed("child", 0)).toBe(4_000);
  });

  test("an unstamped host seeds zero and keeps today's behaviour", () => {
    const reads = createSessionReads(
      stubContext({ root: "running" }, { root: ["root"] }, [], {
        root: [{ id: "m1", type: "assistant", tokens: { output: 10 } }],
      }),
    );
    // No stamp: no span to seed from, so the row behaves exactly as before.
    expect(reads.sessionElapsed("root", 0)).toBeUndefined();
    expect(reads.sessionElapsed("root", 1_000)).toBe(1_000);
  });
});
