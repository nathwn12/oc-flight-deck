import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import flightDeck from "../src/tui/index.js";

// The caution-toast cadence: the toast displays whole-second cautions, so its
// timer must never poll at the animation cadence (`refresh`, floor 16ms).
// Config is global, so every test points `$XDG_CONFIG_HOME` at a throwaway
// directory, mirroring fixtures/render.test.ts.

const created: string[] = [];
let savedXdg: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-toast-"));
  created.push(directory);
  process.env.XDG_CONFIG_HOME = directory;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  savedXdg = undefined;
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function fakeContext(options: unknown): Parameters<typeof flightDeck.setup>[0] {
  return {
    options,
    location: { directory: "/tmp" },
    theme: { text: {} },
    data: {
      location: {
        default: () => ({ directory: "/tmp" }),
        vcs: { info: () => undefined },
        model: { list: () => [] },
      },
      session: {
        get: () => undefined,
        list: () => [],
        status: () => "idle",
        family: () => [],
        message: { list: () => [] },
        permission: { list: () => [] },
      },
      shell: { list: () => [] },
    },
    ui: {
      slot: () => () => {},
      toast: { show: () => {} },
    },
  } as unknown as Parameters<typeof flightDeck.setup>[0];
}

test("no toast timer exists when the sidebar is off", () => {
  const delays: number[] = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms: number, ...rest: unknown[]) => {
    delays.push(ms);
    return real(fn, ms, ...(rest as []));
  }) as typeof setInterval;
  try {
    // `watchedSession` is assigned only inside the `sidebar.content` render,
    // which is registered only when the sidebar is enabled: with it off, a
    // toast timer could never fire, so setup must not create one.
    const cleanup = flightDeck.setup(
      fakeContext({
        refresh: 100,
        caution: { enabled: true, toast: true },
        sidebar: { enabled: false, rows: ["agent"] },
      }),
    );
    try {
      expect(delays).toHaveLength(0);
    } finally {
      if (typeof cleanup === "function") cleanup();
    }
  } finally {
    globalThis.setInterval = real;
  }
});
test("the caution-toast timer never polls faster than once a second", () => {
  const delays: number[] = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms: number, ...rest: unknown[]) => {
    delays.push(ms);
    return real(fn, ms, ...(rest as []));
  }) as typeof setInterval;
  try {
    // `refresh: 16` with the toast armed: the rail's own ticker is off here
    // (no animated row, so nothing to animate) and guard/go are not asked
    // for, so the toast timer is the only interval setup creates.
    const cleanup = flightDeck.setup(
      fakeContext({ refresh: 16, caution: { enabled: true, toast: true }, sidebar: { rows: ["agent"] } }),
    );
    try {
      expect(delays).toHaveLength(1);
      expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    } finally {
      if (typeof cleanup === "function") cleanup();
    }
  } finally {
    globalThis.setInterval = real;
  }
});
