// Measure every default row's rendered width, with subagents present.
import { testRender } from "@opentui/solid";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import flightDeck from "./src/tui/index.js";
import { sidebarLines } from "./src/tui/presentation.js";
import { DEFAULT_CONFIG } from "./src/tui/config.js";

const directory = mkdtempSync(join(tmpdir(), "width-check-"));

const session = {
  agent: "orchestrator",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "high" },
  cost: 0.2246,
  tokens: { input: 517512, output: 75683, reasoning: 152995, cache: { read: 29174144, write: 0 } },
};

const context = {
  options: undefined,
  location: { directory },
  theme: { text: { default: "#ffffff", subdued: "#888888" } },
  data: {
    location: {
      default: () => ({ directory }),
      vcs: { info: () => ({ branch: { current: "main" } }) },
      model: { list: () => [{ id: "deepseek-v4.1-flash", providerID: "opencode-go", limit: { context: 1000000 } }] },
    },
    session: {
      get: () => session,
      list: () => [{ cost: 0.2246 }, { cost: 11.2 }, { cost: 0.9 }],
      family: () => ["ses_test", "ses_child"],
      status: () => "running",
      message: { list: () => [{ tokens: { input: 212, output: 415, cache: { read: 175744, write: 0 } } }] },
      permission: { list: () => [{ action: "shell", resources: ["npm publish"] }] },
      shell: { listBySession: () => [] },
    },
  },
  ui: { slot: () => () => {}, toast: { show: () => {} } },
  storage: {
    memory: (_k: string, o: { initial: { frame: number } }) => {
      const s = { ...o.initial };
      return [{ get frame() { return s.frame; } }, (m: (d: { frame: number }) => void) => m(s)];
    },
  },
};

flightDeck.setup(context as never);

const source = {
  ...session,
  branch: "main",
  tree: { cost: 0.2447, count: 2 },
  context: { used: 218000, limit: 1000000 },
  project: { cost: 12.5, count: 40 },
  status: "running",
  busy: true,
  perms: { count: 1, action: "shell", resource: "npm publish" },
  tps: 87,
  elapsedMs: 840000,
  turns: 48,
  frame: 0,
};

const lines = sidebarLines(DEFAULT_CONFIG, source as never);
console.log("width of each rendered line (sidebar is commonly 30-40 cols):\n");
let widest = 0;
for (const line of lines) {
  widest = Math.max(widest, line.length);
  const flag = line.length > 34 ? "  <-- OVERFLOWS" : "";
  console.log(`  ${String(line.length).padStart(3)}  |${line}|${flag}`);
}
console.log(`\nwidest line: ${widest}`);
console.log(`over 34 cols: ${lines.filter((l) => l.length > 34).length}`);
