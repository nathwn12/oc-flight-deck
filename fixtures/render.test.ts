import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import flightDeck from "../src/tui/index.js";

// These tests mount the exact JSX the plugin hands to the host, in a real
// headless OpenTUI renderer, and read the resulting character frame. That is
// the only way to prove the slot bodies render — calling them outside a
// renderer throws "No renderer found".
//
// Every test pins `location.directory` to a throwaway workspace, so the result
// never depends on whatever config file happens to sit in the repo root.

type Render = (input: { sessionID: string }) => unknown;

interface Claim {
  readonly path: string;
  readonly render: Render;
}

/** A snapshot shaped exactly like the live `Session.Info` observed from the server. */
const LIVE_SESSION = {
  agent: "orchestrator",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "high" },
  cost: 0.1913,
  tokens: { input: 517512, output: 75683, reasoning: 152995, cache: { read: 29174144, write: 0 } },
};

const created: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-render-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
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
}

function harness(options: unknown, directory: string, session: unknown = undefined, extras: HarnessExtras = {}) {
  const claims: Claim[] = [];
  const toasts: string[] = [];
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
        model: { list: () => extras.models ?? [] },
      },
      session: {
        get: (id: string) => (id === "ses_test" ? session : extras.children?.[id]),
        list: () => [],
        status: () => (session === undefined ? undefined : "idle"),
        family: () => extras.family ?? [],
        message: { list: () => extras.messages ?? [] },
        permission: { list: () => [] },
      },
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
  return { context: context as unknown as Parameters<typeof flightDeck.setup>[0], claims, toasts };
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

  const frame = await frameOf(sidebar!.render, 40, 12);
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
  const { context, claims } = harness(undefined, workspace());
  flightDeck.setup(context);

  const { sidebar } = railClaims(claims);
  const frame = await frameOf(sidebar!.render, 40, 4);
  expect(frame).toContain("FLIGHT DECK");
  // No invented placeholders: a row appears only once it has a value.
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
  const directory = workspace();
  writeFileSync(
    join(directory, "flight-deck.jsonc"),
    `{
      // file config
      "sidebar": { "lines": ["FILE RAIL"] },
      "footer": { "text": "FILE FOOTER" },
    }`,
  );

  const { context, claims } = harness({ footer: { text: "HOST FOOTER" } }, directory);
  flightDeck.setup(context);

  const { sidebar, footer } = railClaims(claims);
  // Sidebar comes from the file; footer is overridden by the host.
  expect(await frameOf(sidebar!.render, 40, 4)).toContain("FILE RAIL");
  expect(await frameOf(footer!.render, 60, 3)).toContain("HOST FOOTER");
});

test("uses the config file alone when the host sends nothing", async () => {
  const directory = workspace();
  writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": "FILE ONLY" } }`);

  const { context, claims } = harness(undefined, directory);
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
  const directory = workspace();
  writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": }`);

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  let claims: Claim[] = [];
  let toasts: string[] = [];
  try {
    const built = harness(undefined, directory, LIVE_SESSION);
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
  expect(await frameOf(sidebar!.render, 40, 12)).toContain("FLIGHT DECK");
  // A broken file falls back to the off-by-default footer, not a guessed one.
  expect(footer).toBeUndefined();
});
