import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/solid";
import flightDeck from "../src/tui/index.js";
import { copyFeedback } from "../src/tui/clipboard.js";
import { sparkline } from "../src/tui/stats.js";

// The render tests mount the real JSX, so the copy path reaches the real host
// clipboard unless it is stood in for. This seam replaces ONLY the host
// clipboard module (never all of `@opentui/core`, which the headless renderer
// itself needs) with a controllable fake. Each click test sets the behaviour it
// needs; the default keeps the fake harmless.
type HostWrite = (text: string) => Promise<{ status: string }>;
let hostWrite: HostWrite = async () => ({ status: "written" });

mock.module("../src/tui/host-clipboard.js", () => ({
  createHostClipboard: () => ({ writeText: (text: string) => hostWrite(text) }),
}));

/** Set the fake host write for one test, recording what it is asked to copy. */
function hostReturns(status: string): string[] {
  const writes: string[] = [];
  hostWrite = async (text: string) => {
    writes.push(text);
    return { status };
  };
  return writes;
}

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
  // Default the fake host to a verified write; a test that cares overrides it.
  hostWrite = async () => ({ status: "written" });
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
  /**
   * Messages keyed by session id. A subagent runs in its own session, so its
   * throughput samples live under its own id, not the rendered session's.
   */
  readonly messagesBySession?: Record<string, readonly unknown[]>;
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
  /** Override the message read entirely, e.g. to fail a specific session. */
  readonly messageList?: (id: string) => readonly unknown[];
  /**
   * The host renderer. Only the opt-in `ses` row reads it - its click gesture
   * copies through the renderer's OSC52 boundary - so tests that exercise that
   * path inject a recording fake here.
   */
  readonly renderer?: unknown;
}

function harness(options: unknown, directory: string, session: unknown = undefined, extras: HarnessExtras = {}) {
  const claims: Claim[] = [];
  const toasts: string[] = [];
  const counts = { sessionList: 0, modelList: 0 };
  const context = {
    options,
    location: { directory },
    renderer: extras.renderer,
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
        message: {
          list: (id: string) =>
            extras.messageList !== undefined
              ? extras.messageList(id)
              : (extras.messagesBySession?.[id] ?? extras.messages ?? []),
        },
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

async function frameOf(render: Render, width: number, height: number, sessionID = "ses_test"): Promise<string> {
  const setup = await testRender(() => render({ sessionID }) as never, { width, height });
  try {
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

function railClaims(claims: Claim[]) {
  const sidebar = claims.find((claim) => claim.path === "sidebar.content");
  const sidebarFooter = claims.find((claim) => claim.path === "sidebar.footer");
  const footer = claims.find((claim) => claim.path === "prompt.footer.status");
  return { sidebar, sidebarFooter, footer };
}

test("renders the live rail with no configuration at all", async () => {
  const { context, claims, toasts } = harness(undefined, workspace(), LIVE_SESSION);
  flightDeck.setup(context);
  // The whole point: zero configuration, real numbers.
  expect(toasts).toEqual([]);

  const { sidebar, sidebarFooter, footer } = railClaims(claims);
  expect(sidebar).toBeDefined();
  // The sidebar footer slot is opt-in since 0.8.1: the empty default
  // registers nothing. The prompt footer is opt-in too, so a default setup
  // claims neither footer slot.
  expect(sidebarFooter).toBeUndefined();
  expect(footer).toBeUndefined();

  const frame = await frameOf(sidebar!.render, 40, 20);
  // Branding is opt-in since 0.8.1: nothing renders below the live rows.
  expect(frame).not.toContain("FLIGHT DECK");
  expect(frame).toContain("orchestrator");
  expect(frame).toContain("deepseek-v4.1-flash · high");
  // A real default row, not the branch: `branch` is off the shipped rail now,
  // so the VCS call is only made when a config file asks for it.
  expect(frame).toContain("○ idle");
  expect(frame).toContain("$0.191");
  expect(frame).toContain("518k in · 76k out");
  expect(frame).toContain("29.2M read");
  // The old placeholder text must be gone for good.
  expect(frame).not.toContain("visual rail");
  expect(frame).not.toContain("cosmetic build");
});

test("renders the opt-in branding pair when sidebar.footer.lines is set", async () => {
  const { context, claims } = harness(
    { sidebar: { footer: { lines: ["▸ FLIGHT DECK", "─────────────────"] } } },
    workspace(),
    LIVE_SESSION,
  );
  flightDeck.setup(context);

  // The documented opt-in: the pair in `sidebar.footer.lines` claims the
  // sidebar footer slot and renders both lines — proving the re-enable path.
  const { sidebarFooter } = railClaims(claims);
  expect(sidebarFooter).toBeDefined();
  const footerFrame = await frameOf(sidebarFooter!.render, 40, 3);
  expect(footerFrame).toContain("▸ FLIGHT DECK");
  expect(footerFrame).toContain("─────────────────");
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
  // 212 + 175,744 against a 1,000,000 window is ~18%, not the 17% the other
  // provider's larger window would give. The `~` marks the occupancy proxy.
  expect(frame).toContain("context");
  expect(frame).toContain("██░░░░░░░░ ~18%");
  expect(frame).not.toContain("17%");
});

test("keeps the sidebar empty until the host supplies session data", async () => {
  const { context, claims } = harness({ sidebar: { persist: false } }, workspace());
  flightDeck.setup(context);

  const { sidebar, sidebarFooter } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 4);
  // Branding is opt-in and the default is empty, so an empty rail is fully empty.
  expect(frame).not.toContain("FLIGHT DECK");
  // With `persist: false` there are no placeholders: a row appears only once
  // it has a value.
  expect(frame).not.toContain("agent");
  // A default row with no data must stay absent, not render its placeholder.
  expect(frame).not.toContain("cost");
  // No footer slot by default: the empty `sidebar.footer.lines` registers
  // nothing, independent of the rail.
  expect(sidebarFooter).toBeUndefined();
});

test("renders the text a user configured, alongside the live rows", async () => {
  const { context, claims } = harness(
    { sidebar: { lines: ["CUSTOM RAIL"], rows: ["agent"] }, footer: { text: "hello deck" } },
    workspace(),
    LIVE_SESSION,
  );
  flightDeck.setup(context);

  const { sidebar, sidebarFooter, footer } = railClaims(claims);
  const sidebarFrame = await frameOf(sidebar!.render, 40, 4);
  expect(sidebarFrame).toContain("CUSTOM RAIL");
  expect(sidebarFrame).toContain("orchestrator");
  expect(sidebarFrame).not.toContain("FLIGHT DECK");
  // An explicit `sidebar.lines` does not turn the footer on: the two lists
  // are independent, and the footer default is empty.
  expect(sidebarFooter).toBeUndefined();

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

test("registers the sidebar slots when just the prompt footer is disabled", async () => {
  const { context, claims, toasts } = harness({ footer: { enabled: false } }, workspace());
  flightDeck.setup(context);

  expect(toasts).toEqual([]);
  // With the empty footer default, only the sidebar itself is claimed — no
  // footer slot at all; the prompt footer is opt-in and disabled here.
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
  const { sidebar, sidebarFooter, footer } = railClaims(claims);
  expect(await frameOf(sidebar!.render, 40, 20)).toContain("orchestrator");
  // The fallback also lands on the empty footer default: no slot is claimed.
  expect(sidebarFooter).toBeUndefined();
  // A broken file falls back to the off-by-default prompt footer, not a guessed one.
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
  // A live default row proves the rail rendered; the branding lives elsewhere.
  expect(frame).toContain("orchestrator");
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

test("reads tps as the family's live generation rate, integer and reasoning-inclusive", async () => {
  // One settled 2 s turn on the parent (200 output + 900 reasoning) and one
  // settled 2 s turn on a subagent (300 output, same span): 1,400 generation
  // tokens over a 2 s union = 700 tok/s, drawn whole. Reasoning rides the
  // numerator (and keeps its own row too); idle never enters the denominator;
  // the session records' lifetime totals must not leak in.
  const now = Date.now();
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 30_000, reasoning: 30_000 } },
    {
      family: ["ses_test", "ses_child"],
      messagesBySession: {
        ses_test: [
          {
            type: "assistant",
            time: { created: now - 60_000, streamed: now - 58_000 },
            tokens: { output: 200, reasoning: 900 },
          },
        ],
        ses_child: [
          { type: "assistant", time: { created: now - 60_000, streamed: now - 58_000 }, tokens: { output: 300 } },
        ],
      },
      status: () => "running",
    },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  expect(frame).toContain("tps       700 tok/s");
  expect(frame).not.toContain("250 tok/s");
});

// The tps row is selected by host CAPABILITY - are assistant messages stamped? -
// and never by the momentary state of the session. A stamped host takes the
// live generation rate: per-poll generation deltas over the union of the turns' own
// spans, so idle between turns is never billed and the figure freezes when
// work stops.

test("sums the family's active turn spans, not the wall clock between them", async () => {
  const now = Date.now();
  const parent = [
    // A turn an hour earlier: the idle gap to the rest must not be billed.
    { type: "assistant", time: { created: now - 3_600_000, completed: now - 3_599_000 }, tokens: { output: 30 } },
    { type: "assistant", time: { created: now - 10_000, completed: now - 9_000 }, tokens: { output: 90 } },
  ];
  const child = [
    { type: "assistant", time: { created: now - 9_500, completed: now - 8_000 }, tokens: { output: 180 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    // A lifetime figure of 30,000 / 600 s = 50 tok/s: a different metric, so it
    // must not be what is drawn.
    { time: { created: now - 600_000 }, tokens: { output: 30_000 } },
    {
      family: ["ses_test", "ses_child"],
      messagesBySession: { ses_test: parent, ses_child: child },
      status: () => "running",
    },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // The old turn (1 s) | the recent turn (1 s) | the subagent (1.5 s,
  // overlapping the recent turn) = 3 s of active work for 300 tokens.
  expect(frame).toContain("tps       100 tok/s");
  expect(frame).not.toContain("50 tok/s");
});

test("holds the settled figure when the host goes idle", async () => {
  const now = Date.now();
  // A settled 2 s turn with 500 output tokens seeds 250 tok/s while running,
  // then holds it once idle: idle is never divided, only frozen on.
  const messages = [
    { type: "assistant", time: { created: now - 120_000, completed: now - 118_000 }, tokens: { output: 500 } },
  ];
  let running = true;
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 500 } },
    { messages, status: () => (running ? "running" : "idle") },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const first = await frameOf(sidebar!.render, 40, 6);
  expect(first).toContain("tps       250 tok/s");
  // Past the reader's 1 s cache, so the second render re-derives rather than
  // re-reading the cache: the idle poll must hold, not hide or decay.
  running = false;
  await Bun.sleep(1_100);
  const second = await frameOf(sidebar!.render, 40, 6);
  expect(second).toContain("tps       250 tok/s");
});

test("a long gap between turns does not lower the figure", async () => {
  const now = Date.now();
  const messages = [
    { type: "assistant", time: { created: now - 100_000, completed: now - 99_000 }, tokens: { output: 100 } },
    { type: "assistant", time: { created: now - 5_000, completed: now - 4_000 }, tokens: { output: 100 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 200 } },
    { messages, status: () => "running" },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // 200 tokens over the 2 s the two turns actually ran, even though ~95 s of
  // idle sat between them. Billing that idle would read 2 tok/s.
  expect(frame).toContain("tps       100 tok/s");
  expect(frame).not.toContain("2 tok/s");
});

test("ends a turn at streamed, then completed, and never at created", async () => {
  const now = Date.now();
  const messages = [
    // Both rungs present: `streamed` decides the end, `completed` does not.
    // 60 tokens over the 2 s the provider streamed. `completed` (5 s) would
    // settle the turn after its tools ran and read a slower rate instead.
    {
      type: "assistant",
      time: { created: now - 60_000, streamed: now - 58_000, completed: now - 55_000 },
      tokens: { output: 60 },
    },
    // No `streamed`: `completed` decides the end the same way.
    { type: "assistant", time: { created: now - 20_000, completed: now - 18_000 }, tokens: { output: 60 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 0 } },
    { messages, status: () => "running" },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // 2 s + 2 s = 4 s of streaming work for 120 tokens.
  expect(frame).toContain("tps       30 tok/s");
  expect(frame).not.toContain("17 tok/s");
});

test("counts a turn's reasoning in the numerator", async () => {
  const now = Date.now();
  // One message carrying both timestamps and both token counts, the shape a
  // real host hands over: `streamed` is the decoding clock, `completed` settles
  // the turn 28 s later once its tools have run.
  const messages = [
    {
      type: "assistant",
      time: { created: now - 60_000, streamed: now - 58_000, completed: now - 30_000 },
      tokens: { output: 60, reasoning: 40 },
    },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 0 } },
    { messages, status: () => "running" },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // 100 generation (60 output + 40 reasoning) over the 2 s streamed = 50
  // tok/s. The old output-only numerator read 30 tok/s; the old denominator
  // (completed) reads 3 tok/s.
  expect(frame).toContain("tps       50 tok/s");
  expect(frame).not.toContain("30 tok/s");
  expect(frame).not.toContain("3 tok/s");
});

test("keeps reasoning on its own row while tps counts generation", async () => {
  const now = Date.now();
  const messages = [
    {
      type: "assistant",
      time: { created: now - 60_000, streamed: now - 58_000 },
      tokens: { output: 60, reasoning: 174857 },
    },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps", "reasoning"], persist: false } },
    workspace(),
    // The reasoning rung lives on the session record (the row's source); the
    // tps numerator reads generation off the turns. Same host state, two rows.
    { time: { created: now - 600_000 }, tokens: { output: 60, reasoning: 174857 } },
    { messages, status: () => "running" },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // 174,917 generation (60 output + 174,857 reasoning) over 2 s = 87,459
  // tok/s; the reasoning tokens still ride their own row (175k).
  expect(frame).toContain("tps       87459 tok/s");
  expect(frame).toContain("reasoning 175k");
});

test("counts a stamped turn that produced no tokens in the denominator", async () => {
  const now = Date.now();
  // The reviewer's two-turn shape: 100 tokens streamed over 2 s, then a second
  // stamped turn that streamed for 2 s and produced nothing. The union divides
  // by both spans: 100 / 4 s = 25 tok/s. Dropping the empty turn's span would
  // inflate the figure to 50 tok/s.
  const messages = [
    { type: "assistant", time: { created: now - 4_000, streamed: now - 2_000 }, tokens: { output: 100 } },
    { type: "assistant", time: { created: now - 2_000, streamed: now }, tokens: { output: 0 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 0 } },
    { messages, status: () => "running" },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  expect(frame).toContain("tps       25 tok/s");
  expect(frame).not.toContain("50 tok/s");
});

test("hides an in-flight turn until the minimum sample is on record", async () => {
  const now = Date.now();
  // Half a second of work: a per-poll rate over this sliver would flash an
  // absurd figure, so the row hides until ~2 s of generating time is on
  // record - no more one-second floor inventing a rate for a sliver.
  const messages = [{ type: "assistant", time: { created: now - 500 }, tokens: { output: 50 } }];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 0 } },
    { messages, status: () => "running" },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  expect(frame).not.toContain("tok/s");
});

test("hides tps on an unstamped host instead of billing idle as work", async () => {
  const now = Date.now();
  const messages = [
    { type: "assistant", tokens: { output: 10_000 } },
    { type: "assistant", tokens: { output: 20_000 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 60_000, updated: now }, tokens: { output: 30_000 } },
    { messages, status: () => "running" },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // No usable stamps means no span union, and the busy-gated clock has banked
  // nothing on first sight: there is no honest denominator, so the row hides
  // rather than printing the old lifetime average (30,000 / 60 s).
  expect(frame).not.toContain("tok/s");
});

test("hides tps until the host has proven it stamps or not", async () => {
  const now = Date.now();
  // A successful read carrying no assistant turns says nothing about the host,
  // so neither metric is chosen: the row hides rather than guessing.
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 60_000, updated: now }, tokens: { output: 30_000 } },
    { messages: [{ type: "user" }, { type: "system" }] },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  expect(frame).not.toContain("tok/s");
});

test("a zero-output stamped turn proves the host stamps and is counted, but yields no rate", async () => {
  const now = Date.now();
  // The turn carries a stamp, so the host is known to stamp. Its span still
  // counts in the denominator - that is the current rule - but the numerator
  // stays at zero, so there is nothing to divide and the row hides rather
  // than printing a rate. It must NOT be mistaken for a host with no
  // timestamps and fall back to a lifetime average over the session record.
  const messages = [
    { type: "assistant", time: { created: now - 2_000, completed: now - 1_000 }, tokens: { output: 0 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 60_000, updated: now }, tokens: { output: 30_000 } },
    { messages },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  expect(frame).not.toContain("tok/s");
});

test("never falls back once the host is known to stamp, even if a read fails", async () => {
  const now = Date.now();
  const stamped = [
    { type: "assistant", time: { created: now - 3_000, completed: now - 1_000 }, tokens: { output: 60 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    { time: { created: now - 600_000 }, tokens: { output: 0 } },
    {
      children: {
        ses_other: { time: { created: now - 60_000, updated: now }, tokens: { output: 30_000 } },
      },
      // The first session's read succeeds and proves the host stamps; the second
      // session's read fails, as a transient host error would.
      messageList: (id) => {
        if (id === "ses_other") throw new Error("transient message read failure");
        return stamped;
      },
      status: (id) => (id === "ses_test" ? "running" : "idle"),
    },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);

  const first = await frameOf(sidebar!.render, 40, 6);
  expect(first).toContain("tps       30 tok/s");

  // A different session is a cache miss, so the read is attempted again - and
  // fails. The capability is already known true, so the row hides rather than
  // reverting to a lifetime average over the session record.
  const second = await frameOf(sidebar!.render, 40, 6, "ses_other");
  expect(second).not.toContain("tok/s");
});

test("a subagent session keeps its own spans, not its family's", async () => {
  const now = Date.now();
  const child = [
    { type: "assistant", time: { created: now - 10_000, completed: now - 8_000 }, tokens: { output: 120 } },
  ];
  const root = [
    { type: "assistant", time: { created: now - 10_000, completed: now - 8_000 }, tokens: { output: 6_000 } },
  ];
  const sibling = [
    { type: "assistant", time: { created: now - 10_000, completed: now - 8_000 }, tokens: { output: 6_000 } },
  ];
  const { context, claims } = harness(
    { sidebar: { rows: ["tps"], persist: false } },
    workspace(),
    // The rendered session is a CHILD: `root()` names someone else, so the host
    // keys `family()` by that root and returns ancestors plus siblings.
    { time: { created: now - 600_000 }, tokens: { output: 120 } },
    {
      family: ["ses_root", "ses_test", "ses_sibling"],
      messagesBySession: { ses_root: root, ses_test: child, ses_sibling: sibling },
      root: () => "ses_root",
      status: () => "running",
    },
  );
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 6);
  // Only the child's own 120 tokens over its 2 s: 60 tok/s. Folding the
  // family in would read (120 + 6,000 + 6,000) / 2 s = 6060 tok/s.
  expect(frame).toContain("tps       60 tok/s");
  expect(frame).not.toContain("6060 tok/s");
});

// The `ses` row is opt-in and draws a SHORT PRUNED PREVIEW of the id (clipped
// width-aware to the value column, with an ellipsis), while its click gesture
// must carry the FULL id. These pin the pruned display, the gesture-only copy
// against the full id, the silent verified success, and the honest, distinctly
// reported toast when the copy genuinely fails.

test("draws no ses row unless it is opted in", async () => {
  const { context, claims } = harness(undefined, workspace(), LIVE_SESSION);
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 20);
  // The default rail never names a session, so no `ses_` text appears.
  expect(frame).not.toContain("ses_");
});

test("renders the opt-in ses row as a pruned preview, never the full id", async () => {
  const id = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";
  const { context, claims } = harness({ sidebar: { rows: ["ses"] } }, workspace(), LIVE_SESSION);
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 60, 4, id);
  // The preview is drawn, inside the label column plus an 18-cell value.
  expect(frame).toContain("ses       ses_f07dc9b3bffeV…");
  // The full 30-character id is never drawn: that is the bleed this fixes.
  expect(frame).not.toContain(id);
});

test("never lets the ses row exceed the value column, even at a narrow width", async () => {
  const id = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";
  const { context, claims } = harness({ sidebar: { rows: ["ses"] } }, workspace(), LIVE_SESSION);
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);
  // A width well under the 30-character id: the value was clipped before the
  // renderer ever saw it, so the full id never reaches the frame even though
  // the narrow width wraps the preview row into two lines.
  const frame = await frameOf(sidebar!.render, 20, 6, id);
  // The full id must not be drawn, wrapped or otherwise. The designed column
  // budget (10 label + 1 separator + 18 value) is asserted against the unwrapped
  // line in fixtures/stats.test.ts.
  expect(frame.replace(/\s/g, "")).not.toContain(id);
});

test("copies the full session id on a click while the row shows the pruned preview, with no success toast", async () => {
  // The host backend is stood in for; the OSC52 renderer is present too, so if
  // the host write is what carries the copy, the OSC52 path must stay untouched.
  const writes = hostReturns("written");
  const osc52: string[] = [];
  const renderer = {
    capabilities: { osc52_support: "supported", remote: false },
    copyToClipboardOSC52: (text: string) => {
      osc52.push(text);
      return true;
    },
  };
  const fullId = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";
  const { context, claims, toasts } = harness({ sidebar: { rows: ["ses"] } }, workspace(), LIVE_SESSION, { renderer });
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);

  const setup = await testRender(
    () => sidebar!.render({ sessionID: fullId }) as never,
    { width: 40, height: 4 },
  );
  try {
    await setup.renderOnce();
    // The display shows the preview, not the full id.
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain(fullId);
    expect(frame).toContain("ses_f07dc9b3bffeV…");
    // Painting the row is not a gesture: nothing is copied, nothing is toasted.
    expect(writes).toEqual([]);
    expect(toasts).toEqual([]);
    // The `ses` row is the only line, at the top-left of the rail.
    await setup.mockMouse.click(2, 0);
    // The handler awaits the host write before it decides on a toast.
    await Bun.sleep(1);
    // The FULL id was copied, not the preview: pruning never leaked this way.
    expect(writes).toEqual([fullId]);
    expect(writes[0]).not.toBe("ses_f07dc9b3bffeV…");
    // The verified path carried it: the OSC52 fallback was never reached.
    expect(osc52).toEqual([]);
    // A verified success is silent: the noise on a copy that worked is the
    // whole objection this change answers.
    expect(toasts).toEqual([]);
  } finally {
    setup.renderer.destroy();
  }
});

test("an OSC52-only dispatch on a click reports a non-success, never a verified copy", async () => {
  // The host backend fails and the renderer can only dispatch OSC52: the copy
  // may never have landed in the terminal, so the toast must not claim it did.
  hostReturns("unsupported");
  const { context, claims, toasts } = harness({ sidebar: { rows: ["ses"] } }, workspace(), LIVE_SESSION, {
    renderer: {
      capabilities: { osc52_support: "supported", remote: false },
      copyToClipboardOSC52: () => true,
    },
  });
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);

  const setup = await testRender(
    () => sidebar!.render({ sessionID: "ses_abcdef1234567890" }) as never,
    { width: 40, height: 4 },
  );
  try {
    await setup.renderOnce();
    await setup.mockMouse.click(2, 0);
    await Bun.sleep(1);
    // A failure still speaks: the silent-success change must not silence this.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toBe(copyFeedback({ verified: false, outcome: "osc52-dispatched" }, "ses_abcdef1234567890").message);
    expect(toasts[0]).not.toContain("ses_abcdef1234567890");
  } finally {
    setup.renderer.destroy();
  }
});

test("a click on the ses row reports failure and never the success when no backend can copy", async () => {
  // The host write is unsupported and the harness supplies no renderer, so no
  // transport is reachable: the click must not throw, the rail must keep
  // rendering, and the confirmation must state the failure rather than
  // implying a copy that did not happen.
  hostReturns("unsupported");
  const { context, claims, toasts } = harness({ sidebar: { rows: ["ses"] } }, workspace(), LIVE_SESSION);
  flightDeck.setup(context);
  const { sidebar } = railClaims(claims);

  const setup = await testRender(
    () => sidebar!.render({ sessionID: "ses_abcdef1234567890" }) as never,
    { width: 40, height: 4 },
  );
  try {
    await setup.renderOnce();
    await setup.mockMouse.click(2, 0);
    await Bun.sleep(1);
    // The failure is reported, and it is not the success wording.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toBe(copyFeedback({ verified: false, outcome: "unsupported" }, "ses_abcdef1234567890").message);
    expect(toasts[0]).not.toBe(copyFeedback({ verified: true, outcome: "written" }, "ses_abcdef1234567890").message);
    // The rail kept rendering, and it shows the pruned preview, not the full id.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("ses       ses_abcdef1234567…");
    expect(frame).not.toContain("ses_abcdef1234567890");
  } finally {
    setup.renderer.destroy();
  }
});



