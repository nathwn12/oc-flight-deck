import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, resolveConfig } from "../src/tui/config.js";
import { parseJsonc } from "../src/tui/file-config.js";
import { STAT_FIELDS } from "../src/tui/stats.js";
import flightDeck from "../src/tui/index.js";
import { footerLine, sidebarLines } from "../src/tui/presentation.js";

const root = join(import.meta.dir, "..");
const created: string[] = [];
let savedXdg: string | undefined;

beforeEach(() => {
  // `setup()` reads one global config file, so every test points the lookup at
  // an empty throwaway directory: the real machine config can never leak in.
  savedXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "flight-deck-xdg-"));
  created.push(xdg);
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(() => {
  // An unset variable must go back to being unset, never the string "undefined".
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  savedXdg = undefined;
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function stubContext(options: Record<string, unknown> = {}) {
  const slots: { readonly path: string; readonly release: () => void }[] = [];
  const memoryCalls: string[] = [];
  // A workspace for `location.directory`; config isolation comes from the
  // `$XDG_CONFIG_HOME` the enclosing `beforeEach` points at a throwaway dir.
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-scaffold-"));
  created.push(directory);
  const context = {
    options,
    location: { directory },
    theme: { text: { default: "#ffffff", subdued: "#888888" } },
    data: {
      location: { default: () => ({ directory }), vcs: { info: () => undefined }, model: { list: () => [] } },
      session: {
        get: () => undefined,
        list: () => [],
        status: () => undefined,
        family: () => [],
        message: { list: () => [] },
        permission: { list: () => [] },
      },
      // Session-scoped shells keep the spinner turning while a command runs.
      shell: { list: () => [] },
    },
    // The animation tick lives in the host's memory store, so the stub provides
    // one the way a real host does: a readable frame plus a mutation that lands
    // on that same object. Calls are recorded so the wiring can be asserted
    // behaviourally instead of by grepping the source for a function name.
    storage: {
      memory: (key: string, options: { initial: { frame: number } }) => {
        memoryCalls.push(key);
        const state = { frame: options.initial.frame };
        return [state, (mutation: (draft: { frame: number }) => void) => mutation(state)];
      },
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
  return { context, slots, memoryCalls };
}

describe("flight deck plugin", () => {
  test("ships a live readout with no orchestration surface", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta?: Record<string, unknown>;
      scripts: Record<string, string>;
    };
    expect(Object.keys(packageJson.exports)).toEqual([".", "./tui"]);
    expect(packageJson.exports["."]).toMatchObject({ import: "./src/index.ts" });
    expect(packageJson.exports["./tui"]).toMatchObject({ import: "./src/tui/index.tsx" });
    expect(packageJson.dependencies).toMatchObject({ "@opencode/plugin": "2.0.16" });
    // Deliberate exact pin: a supply-chain guard on the beta we build against.
    expect(packageJson.dependencies["jsonc-parser"]).toBeUndefined();
    expect(packageJson.peerDependencies).toMatchObject({
      "@opentui/core": ">=0.5.10",
      "@opentui/solid": ">=0.5.10",
      "solid-js": ">=1.9.0",
    });
    // These peers MUST NOT be optional. The render entrypoint imports
    // @opentui/solid and solid-js directly, and npm skips optional peers, so
    // marking them optional ships a package that cannot resolve its own
    // imports after install. It worked locally only because the checkout's
    // node_modules happened to satisfy them. That mistake shipped once.
    expect(packageJson.peerDependenciesMeta).toBeUndefined();
    expect(packageJson.scripts.check).toContain("typecheck");
    expect(packageJson.scripts.check).toContain("test");

    // There is deliberately no repo-local opencode.jsonc.
    //
    // A committed `"plugins": ["."]` makes the repo declare the plugin while it
    // may also be installed globally, which registers the same plugin id twice
    // and shows one of them as failed in the host's plugin list. Loading from
    // source is a per-developer choice, documented in the README's Development
    // section, not a property of the repo.
    expect(existsSync(join(root, "opencode.jsonc"))).toBe(false);
    expect(existsSync(join(root, "flight-deck.example.jsonc"))).toBe(true);

    // Server/core/config orchestration surfaces are gone, including the
    // config example and schema that only served coordination.
    for (const gone of ["src/server", "src/core", "src/config", "ocfd.example.jsonc", "ocfd.schema.json"]) {
      expect(existsSync(join(root, ...gone.split("/")))).toBe(false);
    }

    // The public README installs and configures the plugin, documents every
    // row it can render, and never leaks a specific development machine.
    // Headings are the README's own business, so these assert the substance a
    // reader acts on: the plugin entry, the restart, the one config file's
    // real path, and the official API link.
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toMatch(/"plugins"\s*:\s*\[\s*"oc-flight-deck"\s*\]/);
    expect(readme).toMatch(/\brestart\b/i);
    expect(readme).toContain("flight-deck.jsonc");
    expect(readme).toContain("~/.config/opencode/flight-deck.jsonc");
    expect(readme).toContain("XDG_CONFIG_HOME");
    expect(readme).toContain("https://opencode.ai/v2/docs/build/plugins/cli");
    // Every row the code can render has to stay named in the README. A summary
    // table that lists only the default rows is exactly how `spark`,
    // `reasoning`, `turns`, `total`, and `guard` vanished from the docs before
    // while this guard stayed green.
    for (const field of STAT_FIELDS) {
      expect(readme).toContain(`\`${field}\``);
    }
    // Loading from source is a per-developer choice, so the README has to keep
    // saying how: the plugin entry names a git file URL, never a bare path.
    expect(readme).toContain("git+file://");
    expect(readme).not.toContain("Q:\\");
    expect(readme).not.toContain("Q:/");

    // The shipped example config must parse and still describe the real
    // defaults, so the documentation cannot silently drift from the code.
    const example = await readFile(join(root, "flight-deck.example.jsonc"), "utf8");
    const exampleResolution = resolveConfig(parseJsonc(example));
    expect(exampleResolution.issues).toEqual([]);
    expect(exampleResolution.config).toEqual(DEFAULT_CONFIG);
    // Every knob must be reachable from the file, not just from the host.
    // `$schema` is not a setting: it is how an editor or an AI finds the
    // authoritative list of the ones that are.
    expect(Object.keys(parseJsonc(example) as Record<string, unknown>).sort()).toEqual([
      "$schema",
      "caution",
      "footer",
      "format",
      "glyphs",
      "layout",
      "refresh",
      "sidebar",
      "style",
    ]);

    // The shipped TUI source stays inside its boundary: slot claims, theme
    // tokens, read-only config, and read-only session state. No RPC, no keymap,
    // no session writes, and no direct storage — the single write it performs is
    // delegated to ./ticker.ts, which the next block pins down.
    const source = await readFile(join(root, "src", "tui", "index.tsx"), "utf8");
    expect(source).toContain("@opencode/plugin/tui");
    expect(source).toContain("context.ui.slot");
    expect(source).toContain("context.theme");
    expect(source).toContain("resolveConfig(mergeOptions(file.options, context.options))");
    expect(source).toContain("loadConfigFile()");
    expect(source).toContain("context.data.session.get");
    expect(source).not.toMatch(/client\.rpc|context\.keymap|context\.storage|server\/|config\//);
    // Reading session state is the whole data surface: nothing is written out.
    expect(source).not.toMatch(/\.set\(|\.remove\(|fetch\(|context\.storage/);
    // The ticker exists for clock-derived rows and is opt-out via `refresh: 0`.
    // It is the plugin's only write, so it lives in its own module where the
    // boundary can be read and pinned in one place.
    const tickerSource = await readFile(join(root, "src", "tui", "ticker.ts"), "utf8");
    expect(tickerSource).toContain("setInterval");
    expect(tickerSource).toContain("clearInterval");
    expect(tickerSource).toContain("storage.memory");
    // Ephemeral, in-process host state only: never the durable store, never a
    // request, never a file. The frame counter must not outlive the TUI.
    expect(tickerSource).not.toMatch(/storage\.store|fetch\(|client\.|writeFile|readFile/);

    // Every default row is live host state, not text we invented.
    const framed = sidebarLines(DEFAULT_CONFIG, {
      agent: "orchestrator",
      model: { id: "gpt-5" },
      cost: 0.25,
      tokens: { input: 1200, output: 340 },
    });
    expect(framed[0]).toContain("FLIGHT DECK");
    expect(framed).toContain("agent     orchestrator");
    expect(framed).toContain("model     gpt-5");
    // `branch` is off the default rail now: a VCS call is opt-in.
    expect(framed).not.toContain("branch");
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
    const cleanup = await flightDeck.setup(context);
    expect(slots.map((slot) => slot.path)).toEqual(["sidebar.content", "prompt.footer.status"]);
    // Always clean up: setup starts a real interval otherwise, which would outlive
    // the test and surface as an unrelated async failure later in the run.
    await cleanup?.();
  });

  // Behavioural rather than textual: grepping for `storage.memory` proves nothing
  // about whether the wiring actually reaches it. A revert to a private
  // `createSignal` ticker would keep every source guard green while re-breaking
  // the feature — these fail instead.
  test("starts the host ticker through the wiring, and skips it when told to", async () => {
    const on = stubContext();
    const cleanup = await flightDeck.setup(on.context);
    expect(on.memoryCalls).toEqual(["flight-deck.frame"]);
    await cleanup?.();

    const off = stubContext({ refresh: 0 });
    const offCleanup = await flightDeck.setup(off.context);
    expect(off.memoryCalls).toEqual([]);
    await offCleanup?.();
  });

  test("never starts a ticker when nothing on the rail animates", async () => {
    // No `status` and no `elapsed`: there is nothing for a clock to move, so the
    // host renderer must not be woken ten times a second for it.
    const statics = stubContext({ sidebar: { rows: ["agent", "model"] } });
    const cleanup = await flightDeck.setup(statics.context);
    expect(statics.memoryCalls).toEqual([]);
    await cleanup?.();
  });
});
