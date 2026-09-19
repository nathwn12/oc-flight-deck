import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import flightDeck from "../src/tui/index.js";
import { sparkline } from "../src/tui/stats.js";

// These tests mount the exact JSX the plugin hands to the host, in a real
// headless OpenTUI renderer, and read the resulting character frame. That is
// the only way to prove the slot bodies render — calling them outside a
// renderer throws "No renderer found".
//
// Config is global, so `location.directory` no longer isolates anything. Every
// test instead points `$XDG_CONFIG_HOME` at a throwaway directory, so the rail
// never depends on the config file on the machine running the suite.

type Render = (input: { sessionID: string }) => unknown;

interface Claim {
  readonly path: string;
  readonly render: Render;
}

/** A snapshot shaped exactly like the live `Session.Info` observed from the server. */
const LIVE_SESSION = {
  id: "ses_test",
  projectID: "proj_a",
  agent: "orchestrator",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "high" },
  cost: 0.1913,
  tokens: { input: 517512, output: 75683, reasoning: 152995, cache: { read: 29174144, write: 0 } },
};

const created: string[] = [];
let savedXdg: string | undefined;
let xdgDirectory: string | undefined;

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-render-"));
  created.push(directory);
  return directory;
}

/** The one config file the plugin will read, inside this test's XDG root. */
function globalConfigFile(): string {
  const directory = join(xdgDirectory!, "opencode");
  mkdirSync(directory, { recursive: true });
  return join(directory, "flight-deck.jsonc");
}

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  xdgDirectory = workspace();
  process.env.XDG_CONFIG_HOME = xdgDirectory;
});

afterEach(() => {
  // An unset variable must go back to being unset, never the string "undefined".
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  savedXdg = undefined;
  xdgDirectory = undefined;
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

interface HarnessExtras {
  readonly branch?: string;
  readonly family?: readonly string[];
  readonly children?: Record<string, unknown>;
  readonly messages?: readonly unknown[];
  readonly models?: readonly unknown[];
  /**
   * What `session.list()` returns. Not scoped by the host: that list holds every
   * session it knows about, across every directory, which is why the `project`
   * row has to filter it itself.
   */
  readonly sessions?: readonly unknown[];
  /**
   * Family root for a session id. Defaults to "every session is its own root",
   * which is what a host without `root()` gives you.
   */
  readonly root?: (id: string) => string;
  /** Per-session status; omit for the default idle. May throw for one id. */
  readonly status?: (id: string) => string | undefined;
  readonly shells?: readonly unknown[];
  /** Simulate a host with no shell API at all. */
  readonly omitShell?: boolean;
}

function harness(options: unknown, directory: string, session: unknown = undefined, extras: HarnessExtras = {}) {
  const claims: Claim[] = [];
  const toasts: string[] = [];
  const counts = { sessionList: 0, modelList: 0 };
  const context = {
    options,
    location: { directory },
    theme: { text: { default: "#ffffff", subdued: "#888888" } },
    data: {
      location: {
        default: () => ({ directory }),
        vcs: {
          info: () => (extras.branch === undefined ? undefined : { branch: { current: extras.branch } }),
        },
        model: {
          list: () => {
            counts.modelList += 1;
            return extras.models ?? [];
          },
        },
      },
      session: {
        get: (id: string) => (id === "ses_test" ? session : extras.children?.[id]),
        list: () => {
          counts.sessionList += 1;
          return extras.sessions ?? [];
        },
        // An explicit undefined from the knob must survive: `??` would turn it
        // back into the default idle and hide the "host said nothing" case.
        status: (id: string) =>
          extras.status === undefined ? (session === undefined ? undefined : "idle") : extras.status(id),
        family: () => extras.family ?? [],
        // Absent by default, so the "host without root()" path is the one every
        // other test exercises.
        ...(extras.root === undefined ? {} : { root: (id: string) => extras.root!(id) }),
        message: { list: () => extras.messages ?? [] },
        permission: { list: () => [] },
      },
      // Shell support is optional so its absence can be pinned as well.
      ...(extras.omitShell === true ? {} : { shell: { list: () => extras.shells ?? [] } }),
    },
    ui: {
      slot: (claim: { append?: string; prepend?: string; render: Render }) => {
        const entry: Claim = { path: claim.append ?? claim.prepend ?? "unknown", render: claim.render };
        claims.push(entry);
        return () => {
          const index = claims.indexOf(entry);
          if (index >= 0) claims.splice(index, 1);
        };
      },
      toast: {
        show: (value: { message: string }) => {
          toasts.push(value.message);
        },
      },
    },
  };
  return { context: context as unknown as Parameters<typeof flightDeck.setup>[0], claims, toasts, counts };
}

async function frameOf(render: Render, width: number, height: number): Promise<string> {
  const setup = await testRender(() => render({ sessionID: "ses_test" }) as never, { width, height });
  try {
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

function railClaims(claims: Claim[]) {
  const sidebar = claims.find((claim) => claim.path === "sidebar.content");
  const footer = claims.find((claim) => claim.path === "prompt.footer.status");
  return { sidebar, footer };
}

test("renders the live rail with no configuration at all", async () => {
  const { context, claims, toasts } = harness(undefined, workspace(), LIVE_SESSION, { branch: "main" });
  flightDeck.setup(context);
  // The whole point: zero configuration, real numbers.
  expect(toasts).toEqual([]);

  const { sidebar, footer } = railClaims(claims);
  expect(sidebar).toBeDefined();
  // The prompt footer is opt-in, so a default setup claims only the sidebar.
  expect(footer).toBeUndefined();

  const frame = await frameOf(sidebar!.render, 40, 20);
  expect(frame).toContain("FLIGHT DECK");
  expect(frame).toContain("orchestrator");
  expect(frame).toContain("deepseek-v4.1-flash · high");
  expect(frame).toContain("main");
  expect(frame).toContain("$0.191");
  expect(frame).toContain("518k in · 76k out");
  expect(frame).toContain("29.2M read");
  // The old placeholder text must be gone for good.
  expect(frame).not.toContain("visual rail");
  expect(frame).not.toContain("cosmetic build");
});

test("totals subagent sessions and reads context from the last request", async () => {
  const messages = [
    { tokens: { input: 100, output: 10, cache: { read: 1000, write: 0 } } },
    { tokens: { input: 212, output: 415, reasoning: 686, cache: { read: 175744, write: 0 } } },
  ];
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION, {
    family: ["ses_test", "ses_child"],
    children: { ses_child: { cost: 0.02010514 } },
    messages,
  });
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 14);
  // Parent cost plus the subagent's, not the parent alone.
  expect(frame).toContain("$0.211");
  expect(frame).toContain("1 subagent");
  // Occupancy is the last request (212 input + 175,744 cache read), not a sum.
  expect(frame).toContain("176k used");
});

test("draws the context gauge, matching provider as well as model id", async () => {
  const messages = [{ tokens: { input: 212, output: 415, cache: { read: 175744, write: 0 } } }];
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION, {
    messages,
    models: [
      // Same model id, different provider, different window. Matching on id
      // alone would read this ceiling and show 17%.
      { id: "deepseek-v4.1-flash", providerID: "openrouter", limit: { context: 1048576, output: 384000 } },
      { id: "deepseek-v4.1-flash", providerID: "opencode-go", limit: { context: 1000000, output: 384000 } },
    ],
  });
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 16);
  // 212 + 175,744 against a 1,000,000 window is 18%, not the 17% the other
  // provider's larger window would give.
  expect(frame).toContain("context");
  expect(frame).toContain("██░░░░░░░░ 18%");
  expect(frame).not.toContain("17%");
});

test("renders branding alone until the host supplies session data", async () => {
  const { context, claims } = harness({ sidebar: { persist: false } }, workspace());
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 4);
  expect(frame).toContain("FLIGHT DECK");
  // With `persist: false` there are no placeholders: a row appears only once
  // it has a value.
  expect(frame).not.toContain("agent");
  expect(frame).not.toContain("branch");
});

test("renders the text a user configured, alongside the live rows", async () => {
  const { context, claims } = harness(
    { sidebar: { lines: ["CUSTOM RAIL"], rows: ["agent"] }, footer: { text: "hello deck" } },
    workspace(),
    LIVE_SESSION,
  );
  flightDeck.setup(context);

  const { sidebar, footer } = railClaims(claims);
  const sidebarFrame = await frameOf(sidebar!.render, 40, 4);
  expect(sidebarFrame).toContain("CUSTOM RAIL");
  expect(sidebarFrame).toContain("orchestrator");
  expect(sidebarFrame).not.toContain("FLIGHT DECK");

  const footerFrame = await frameOf(footer!.render, 60, 3);
  expect(footerFrame).toContain("hello deck");
  expect(footerFrame).not.toContain("Flight Deck");
});

test("merges the on-disk config file with host options", async () => {
  writeFileSync(
    globalConfigFile(),
    `{
      // file config
      "sidebar": { "lines": ["FILE RAIL"] },
      "footer": { "text": "FILE FOOTER" },
    }`,
  );

  const { context, claims } = harness({ footer: { text: "HOST FOOTER" } }, workspace());
  flightDeck.setup(context);

  const { sidebar, footer } = railClaims(claims);
  // Sidebar comes from the file; footer is overridden by the host.
  expect(await frameOf(sidebar!.render, 40, 16)).toContain("FILE RAIL");
  expect(await frameOf(footer!.render, 60, 3)).toContain("HOST FOOTER");
});

test("uses the config file alone when the host sends nothing", async () => {
  writeFileSync(globalConfigFile(), `{ "footer": { "text": "FILE ONLY" } }`);

  const { context, claims } = harness(undefined, workspace());
  flightDeck.setup(context);

  const { footer } = railClaims(claims);
  expect(await frameOf(footer!.render, 60, 3)).toContain("FILE ONLY");
});

test("omits disabled rails and warns once about bad config", async () => {
  const { context, claims, toasts } = harness({ sidebar: { enabled: false }, footer: { text: 7 } }, workspace());
  flightDeck.setup(context);

  expect(claims.map((claim) => claim.path)).toEqual(["prompt.footer.status"]);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatch(/^Ignoring invalid config: /);
  expect(toasts[0]).toContain("footer.text");
});

test("warns about an unknown row name", async () => {
  const { context, toasts } = harness({ sidebar: { rows: ["agent", "nope"] } }, workspace());
  flightDeck.setup(context);

  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain("sidebar.rows[1]");
  expect(toasts[0]).toContain("not a known field");
});

test("registers only the sidebar when just the footer is disabled", async () => {
  const { context, claims, toasts } = harness({ footer: { enabled: false } }, workspace());
  flightDeck.setup(context);

  expect(toasts).toEqual([]);
  expect(claims.map((claim) => claim.path)).toEqual(["sidebar.content"]);
});

test("summarises additional config problems", async () => {
  const { context, toasts } = harness({ footer: { enabled: "yes", text: 7 } }, workspace());
  flightDeck.setup(context);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatch(/\(\+1 more\)$/);
});

test("warns and keeps rendering when the config file is broken", async () => {
  writeFileSync(globalConfigFile(), `{ "footer": { "text": }`);

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  let claims: Claim[] = [];
  let toasts: string[] = [];
  try {
    const built = harness(undefined, workspace(), LIVE_SESSION);
    claims = built.claims;
    toasts = built.toasts;
    await flightDeck.setup(built.context);
  } finally {
    console.warn = original;
  }

  expect(warnings.some((line) => line.includes("flight-deck") && line.includes("could not be parsed"))).toBe(true);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain("could not be parsed");

  // Still renders the defaults.
  const { sidebar, footer } = railClaims(claims);
  expect(await frameOf(sidebar!.render, 40, 20)).toContain("FLIGHT DECK");
  // A broken file falls back to the off-by-default footer, not a guessed one.
  expect(footer).toBeUndefined();
});

// The status row is the rail's only moving part, so "is anything working" comes
// from more than the session's own status: a subagent runs in its own session,
// and a shell command outlives the turn that started it. These pin that
// derivation through the real slot render rather than through a stub.

test("keeps the glyph turning while a subagent runs, though the parent reads idle", async () => {
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION, {
    family: ["ses_test", "ses_child"],
    children: { ses_child: { cost: 0.02 } },
    status: (id) => (id === "ses_child" ? "running" : "idle"),
  });
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 16);
  expect(frame).toContain("running");
  expect(frame).not.toContain("idle");
});

test("keeps the glyph turning while a shell command runs", async () => {
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION, {
    status: () => "idle",
    shells: [{ status: "running", command: "bun test", metadata: { sessionID: "ses_test" } }],
  });
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 16);
  expect(frame).toContain("running");
  expect(frame).not.toContain("idle");
});

test("finds a running subagent even when a sibling status cannot be read", async () => {
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION, {
    family: ["ses_test", "ses_broken", "ses_child"],
    children: { ses_broken: {}, ses_child: {} },
    status: (id) => {
      if (id === "ses_broken") throw new Error("unreadable");
      return id === "ses_child" ? "running" : "idle";
    },
  });
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  expect(await frameOf(sidebar!.render, 40, 16)).toContain("running");
});

test("reads idle only when nothing anywhere is running", async () => {
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION, {
    status: () => "idle",
    shells: [{ status: "exited", command: "bun test", metadata: { sessionID: "ses_test" } }],
  });
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  expect(await frameOf(sidebar!.render, 40, 16)).toContain("○ idle");
});

test("omits the status row rather than guess when the host will not say", async () => {
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION, {
    // A host with no shell API and no session status: the rail must omit the row
    // rather than invent "idle".
    status: () => undefined,
    omitShell: true,
  });
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 16);
  expect(frame).toContain("FLIGHT DECK");
  expect(frame).not.toContain("idle");
  expect(frame).not.toContain("running");
});

// `session.list()` is not scoped by the host: it returns every session the host
// knows about, across every directory. Summing it unfiltered reads as the whole
// database while the row claims to be this project, so the row filters by the
// project id itself.

test("sums only the open session's project, not every session the host knows", async () => {
  const { context, claims } = harness({ sidebar: { rows: ["project"] } }, workspace(), LIVE_SESSION, {
    sessions: [
      { id: "ses_test", projectID: "proj_a", cost: 0.1913 },
      { id: "ses_sibling", projectID: "proj_a", cost: 0.5 },
      { id: "ses_third", projectID: "proj_a", cost: 0.25 },
      { id: "ses_other", projectID: "proj_b", cost: 900 },
      { id: "ses_legacy", cost: 5 },
    ],
  });
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // 0.1913 + 0.5 + 0.25, and the three sessions that carry proj_a.
  expect(frame).toContain("project   $0.941 · 3 sessions");
  // Another project, and a session with no project id at all, must not leak in.
  expect(frame).not.toContain("$900");
  expect(frame).not.toContain("5 sessions");
});

test("falls back to every session when the host reports no project id", async () => {
  const { context, claims } = harness(
    { sidebar: { rows: ["project"] } },
    workspace(),
    { ...LIVE_SESSION, projectID: undefined },
    { sessions: [{ id: "ses_test", cost: 0.1913 }, { id: "ses_other", cost: 900 }] },
  );
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  // Documented degradation: no project id means no way to scope, so the
  // unfiltered total is shown rather than an empty row.
  expect(await frameOf(sidebar!.render, 40, 6)).toContain("project   $900.19 · 2 sessions");
});

test("the spark row renders as many samples as sparkWidth asks for", async () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    type: "assistant",
    tokens: { output: index + 1 },
  }));
  const { context, claims } = harness(
    { sidebar: { rows: ["spark"] }, layout: { sparkWidth: 16 } },
    workspace(),
    LIVE_SESSION,
    { messages },
  );
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // The newest 16 samples, scaled against the largest of them.
  const expected = sparkline(Array.from({ length: 16 }, (_, index) => index + 5));
  // The whole row, label included: asserting only the shape would also pass if
  // the row silently fell back to a shorter window, because the tail of the
  // longer shape is the shorter shape.
  expect(frame).toContain(`spark     ${expected}`);
});

test("the turns row counts prompts, not every message record", async () => {
  const messages = [
    { type: "user" },
    { type: "assistant", tokens: { output: 10 } },
    { type: "system" },
    { type: "shell" },
    { type: "user" },
  ];
  const { context, claims } = harness({ sidebar: { rows: ["turns"] } }, workspace(), LIVE_SESSION, {
    messages,
  });
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // Two user messages. Counting every record would say five.
  expect(frame).toContain("turns     2");
  expect(frame).not.toContain("turns     5");
});

test("derives only the rows actually on the rail", async () => {
  const { context, claims, counts } = harness(
    { sidebar: { rows: ["agent"], persist: false } },
    workspace(),
    LIVE_SESSION,
  );
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  expect(frame).toContain("orchestrator");
  // The rows that were not asked for must not cost a walk of the session
  // database (`project`) or the model catalog (`context`).
  expect(counts.sessionList).toBe(0);
  expect(counts.modelList).toBe(0);
});

test("a subagent session does not claim its parent's family as its own", async () => {
  // The host keys `family()` by the family root, so asking from a child returns
  // the root and every sibling. Merging that into `cost` would report the whole
  // tree under a label that promises this conversation plus its own subagents.
  const { context, claims } = harness(
    { sidebar: { rows: ["cost", "total"], persist: false } },
    workspace(),
    LIVE_SESSION,
    {
    family: ["ses_root", "ses_test", "ses_sibling"],
    children: { ses_root: { cost: 5 }, ses_sibling: { cost: 3 } },
    root: () => "ses_root",
  });
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 8);
  // Its own figure, and no family row at all.
  expect(frame).toContain("cost      $0.191");
  expect(frame).not.toContain("$8");
  expect(frame).not.toContain("2 subagents");
  expect(frame).not.toContain("total");
});

test("a subagent total is still summed for the family root", async () => {
  const { context, claims } = harness({ sidebar: { rows: ["cost"] } }, workspace(), LIVE_SESSION, {
    family: ["ses_test", "ses_child"],
    children: { ses_child: { cost: 0.02 } },
    root: (id) => id,
  });
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 8);
  expect(frame).toContain("cost      $0.211 · 1 subagent");
});

test("reads tps as the whole family's session average", async () => {
  // The main chat's own 30,000 output tokens plus a subagent's 10,000, over a
  // minute of session life: 40,000 / 60s = 667 tok/s. The session's average,
  // not the last turn's rate — the parent alone would read 500 tok/s.
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: 0, updated: 60_000 }, tokens: { output: 30_000 } },
    {
      family: ["ses_test", "ses_child"],
      children: { ses_child: { tokens: { output: 10_000 } } },
    },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  expect(frame).toContain("667 tok/s");
  expect(frame).not.toContain("500 tok/s");
});
