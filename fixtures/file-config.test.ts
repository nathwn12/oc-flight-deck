import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { mergeOptions, resolveConfig } from "../src/tui/config.js";
import { loadConfigFile } from "../src/tui/file-config.js";
import { footerLine, sidebarLines } from "../src/tui/presentation.js";

const created: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("flight deck config file", () => {
  test("is silent when no config file exists", () => {
    const loaded = loadConfigFile(workspace());
    expect(loaded.options).toBeUndefined();
    expect(loaded.source).toBeUndefined();
    expect(loaded.issue).toBeUndefined();
  });

  test("reads a commented, trailing-comma JSONC file", () => {
    const directory = workspace();
    writeFileSync(
      join(directory, "flight-deck.jsonc"),
      `{
        // a comment the parser must ignore
        "footer": { "text": "commented rail", },
      }`,
    );
    const loaded = loadConfigFile(directory);
    expect(loaded.issue).toBeUndefined();
    expect(loaded.source).toContain("flight-deck.jsonc");
    expect(footerLine(resolveConfig(mergeOptions(loaded.options, undefined)).config)).toBe("commented rail");
  });

  test("prefers .opencode/flight-deck.jsonc over the project root", () => {
    const directory = workspace();
    mkdirSync(join(directory, ".opencode"));
    writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": "root" } }`);
    writeFileSync(
      join(directory, ".opencode", "flight-deck.jsonc"),
      `{ "footer": { "text": "dot-opencode" }, "sidebar": { "lines": ["dot line"] } }`,
    );
    const loaded = loadConfigFile(directory);
    expect(loaded.source).toContain(".opencode");
    const { config } = resolveConfig(mergeOptions(loaded.options, undefined));
    expect(footerLine(config)).toBe("dot-opencode");
    expect(sidebarLines(config)).toEqual(["dot line"]);
  });

  test("reports a file that parses but is not an object", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.jsonc"), `[1, 2, 3]`);
    const loaded = loadConfigFile(directory);
    expect(loaded.options).toBeUndefined();
    expect(loaded.issue).toContain("must contain a JSON object");
  });

  test("reads .opencode/flight-deck.json and prefers it over the project root", () => {
    const directory = workspace();
    mkdirSync(join(directory, ".opencode"));
    // Candidate 2 (.opencode, .json) must beat candidate 3 (root, .jsonc).
    writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": "root jsonc" } }`);
    writeFileSync(join(directory, ".opencode", "flight-deck.json"), `{ "footer": { "text": "dot json" } }`);
    const loaded = loadConfigFile(directory);
    expect(loaded.source).toContain(".opencode");
    expect(loaded.source).toContain(".json");
    expect(footerLine(resolveConfig(mergeOptions(loaded.options, undefined)).config)).toBe("dot json");
  });

  test("reads a root flight-deck.json as the last candidate", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.json"), `{ "footer": { "text": "root json" } }`);
    const loaded = loadConfigFile(directory);
    expect(loaded.source).toContain("flight-deck.json");
    expect(footerLine(resolveConfig(mergeOptions(loaded.options, undefined)).config)).toBe("root json");
  });

  test("reports an unparseable file instead of throwing", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": }`);
    const loaded = loadConfigFile(directory);
    expect(loaded.options).toBeUndefined();
    expect(loaded.issue).toContain("could not be parsed");
    expect(resolveConfig(mergeOptions(loaded.options, undefined)).config).toEqual({
      sidebar: { enabled: true, lines: ["✈ FLIGHT DECK", "─────────────", "visual rail", "cosmetic build"] },
      footer: { enabled: true, text: "Flight Deck · cosmetic rail" },
    });
  });

  test("reports an empty file", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.json"), "   \n");
    const loaded = loadConfigFile(directory);
    expect(loaded.issue).toContain("is empty");
  });

  test("lets host options override the file", () => {
    const directory = workspace();
    writeFileSync(
      join(directory, "flight-deck.jsonc"),
      `{ "sidebar": { "lines": ["file"] }, "footer": { "text": "file footer" } }`,
    );
    const loaded = loadConfigFile(directory);
    const { config } = resolveConfig(mergeOptions(loaded.options, { footer: { text: "host footer" } }));
    expect(footerLine(config)).toBe("host footer");
    expect(sidebarLines(config)).toEqual(["file"]);
  });
});
