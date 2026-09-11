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

interface Claim {
  readonly path: string;
  readonly render: () => unknown;
}

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

function harness(options: unknown, directory: string) {
  const claims: Claim[] = [];
  const toasts: string[] = [];
  const context = {
    options,
    location: { directory },
    theme: { text: { default: "#ffffff", subdued: "#888888" } },
    ui: {
      slot: (claim: { append?: string; prepend?: string; render: () => unknown }) => {
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

async function frameOf(render: () => unknown, width: number, height: number): Promise<string> {
  const setup = await testRender(() => render() as never, { width, height });
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

test("renders both cosmetic rails from the default config", async () => {
  const { context, claims, toasts } = harness(undefined, workspace());
  flightDeck.setup(context);
  expect(toasts).toEqual([]);

  const { sidebar, footer } = railClaims(claims);
  expect(sidebar).toBeDefined();
  expect(footer).toBeDefined();

  const sidebarFrame = await frameOf(sidebar!.render, 40, 10);
  expect(sidebarFrame).toContain("FLIGHT DECK");
  expect(sidebarFrame).toContain("cosmetic build");

  const footerFrame = await frameOf(footer!.render, 60, 3);
  expect(footerFrame).toContain("Flight Deck");
  expect(footerFrame).toContain("cosmetic rail");
});

test("renders the text a user configured, replacing the defaults", async () => {
  const { context, claims } = harness({ sidebar: { lines: ["CUSTOM RAIL"] }, footer: { text: "hello deck" } }, workspace());
  flightDeck.setup(context);

  const { sidebar, footer } = railClaims(claims);
  const sidebarFrame = await frameOf(sidebar!.render, 40, 4);
  expect(sidebarFrame).toContain("CUSTOM RAIL");
  expect(sidebarFrame).not.toContain("FLIGHT DECK");

  const footerFrame = await frameOf(footer!.render, 60, 3);
  expect(footerFrame).toContain("hello deck");
  expect(footerFrame).not.toContain("cosmetic rail");
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
    const built = harness(undefined, directory);
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
  expect(await frameOf(sidebar!.render, 40, 10)).toContain("FLIGHT DECK");
  expect(await frameOf(footer!.render, 60, 3)).toContain("cosmetic rail");
});
