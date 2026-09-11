import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/tui/config.js";
import flightDeck from "../src/tui/index.js";
import { footerLine, sidebarLines } from "../src/tui/presentation.js";

const root = join(import.meta.dir, "..");
const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function stubContext(options: Record<string, unknown> = {}) {
  const slots: { readonly path: string; readonly release: () => void }[] = [];
  // Point at an empty workspace so the result never depends on a config file
  // that happens to exist in the repo root.
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-scaffold-"));
  created.push(directory);
  const context = {
    options,
    location: { directory },
    theme: { text: { default: "#ffffff", subdued: "#888888" } },
    data: {
      location: { default: () => ({ directory }), vcs: { info: () => undefined }, model: { list: () => [] } },
      session: { get: () => undefined, family: () => [], message: { list: () => [] } },
    },
    ui: {
      slot: (claim: { append: string }) => {
        const release = () => {
          const index = slots.findIndex((slot) => slot.release === release);
          if (index >= 0) slots.splice(index, 1);
        };
        slots.push({ path: claim.append, release });
        return release;
      },
      toast: { show: () => {} },
    },
  } as unknown as Parameters<typeof flightDeck.setup>[0];
  return { context, slots };
}

describe("flight deck plugin", () => {
  test("ships a live readout with no orchestration surface", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(Object.keys(packageJson.exports)).toEqual([".", "./tui"]);
    expect(packageJson.exports["."]).toMatchObject({ import: "./src/index.ts" });
    expect(packageJson.exports["./tui"]).toMatchObject({ import: "./src/tui/index.tsx" });
    expect(packageJson.dependencies).toMatchObject({ "@opencode/plugin": "0.0.0-beta-19425" });
    // Deliberate exact pin: a supply-chain guard on the beta we build against.
    expect(packageJson.dependencies["jsonc-parser"]).toBeUndefined();
    expect(packageJson.peerDependencies).toMatchObject({
      "@opentui/core": ">=0.5.10",
      "@opentui/solid": ">=0.5.10",
      "solid-js": ">=1.9.0",
    });
    expect(packageJson.scripts.check).toContain("typecheck");
    expect(packageJson.scripts.check).toContain("test");

    // The repo config loads the checkout; the commented template beside it is
    // what users copy to configure the rail.
    const opencodeConfig = await readFile(join(root, "opencode.jsonc"), "utf8");
    expect(opencodeConfig).toContain('"plugins": ["."]');
    expect(opencodeConfig).toContain("flight-deck.example.jsonc");
    expect(existsSync(join(root, "flight-deck.example.jsonc"))).toBe(true);

    // Server/core/config orchestration surfaces are gone, including the
    // config example and schema that only served coordination.
    for (const gone of ["src/server", "src/core", "src/config", "ocfd.example.jsonc", "ocfd.schema.json"]) {
      expect(existsSync(join(root, ...gone.split("/")))).toBe(false);
    }

    // The public README installs and configures the plugin without leaking a
    // specific development machine.
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toContain("## Install");
    expect(readme).toContain("## Configuration");
    expect(readme).toContain("oc-flight-deck");
    expect(readme).toContain("flight-deck.jsonc");
    expect(readme).toContain("https://opencode.ai/v2/docs/build/plugins/cli");
    expect(readme).not.toContain("Q:\\");
    expect(readme).not.toContain("Q:/");

    // The shipped TUI source stays inside its boundary: slot claims, theme
    // tokens, read-only config, and read-only session state. No RPC, no polling,
    // no storage, no keymap, and nothing that writes anywhere.
    const source = await readFile(join(root, "src", "tui", "index.tsx"), "utf8");
    expect(source).toContain("@opencode/plugin/tui");
    expect(source).toContain("context.ui.slot");
    expect(source).toContain("context.theme");
    expect(source).toContain("resolveConfig(mergeOptions(file.options, context.options))");
    expect(source).toContain("loadConfigFile(directory)");
    expect(source).toContain("context.data.session.get");
    expect(source).not.toMatch(/client\.rpc|createSignal|setInterval|context\.keymap|context\.storage|server\/|config\//);
    // Reading session state is the whole data surface: nothing is written out.
    expect(source).not.toMatch(/\.set\(|\.remove\(|fetch\(|context\.storage/);

    // Every default row is live host state, not text we invented.
    const framed = sidebarLines(DEFAULT_CONFIG, {
      agent: "orchestrator",
      model: { id: "gpt-5" },
      cost: 0.25,
      tokens: { input: 1200, output: 340 },
      branch: "main",
    });
    expect(framed[0]).toContain("FLIGHT DECK");
    expect(framed).toContain("agent     orchestrator");
    expect(framed).toContain("model     gpt-5");
    expect(framed).toContain("branch    main");
    expect(framed).toContain("cost      $0.250");
    expect(framed).toContain("tokens    1k in · 340 out");
    // The prompt footer is opt-in; the sidebar already carries the data.
    expect(footerLine(DEFAULT_CONFIG)).toBeUndefined();
    expect(sidebarLines(DEFAULT_CONFIG)).not.toContain("visual rail");

    const hostSource = await readFile(join(root, "src", "index.ts"), "utf8");
    expect(hostSource).toContain('id: "flight-deck.host"');
    expect(hostSource).not.toMatch(/ctx\.(rpc|tool|event|storage)|session\.hook/);
  });

  test("registers the sidebar slot by default and removes it on cleanup", async () => {
    const { context, slots } = stubContext();
    expect(flightDeck.id).toBe("flight-deck-tui");
    const cleanup = await flightDeck.setup(context);
    expect(cleanup).toBeTypeOf("function");
    // The footer is opt-in, so a default setup claims only the sidebar.
    expect(slots.map((slot) => slot.path)).toEqual(["sidebar.content"]);
    await cleanup?.();
    expect(slots).toEqual([]);
    // Cleanup must stay harmless if the host calls it twice.
    expect(() => cleanup?.()).not.toThrow();
    expect(slots).toEqual([]);
  });

  test("claims both slots once the footer is configured", async () => {
    const { context, slots } = stubContext({ footer: { text: "Flight Deck" } });
    await flightDeck.setup(context);
    expect(slots.map((slot) => slot.path)).toEqual(["sidebar.content", "prompt.footer.status"]);
  });
});
