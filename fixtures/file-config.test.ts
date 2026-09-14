import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeOptions, resolveConfig } from "../src/tui/config.js";
import {
  CONFIG_FILE_CANDIDATES,
  globalConfigDirectory,
  loadConfigFile,
} from "../src/tui/file-config.js";
import { footerLine, sidebarLines } from "../src/tui/presentation.js";

const created: string[] = [];
let savedXdg: string | undefined;
let xdgRoot: string | undefined;

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-"));
  created.push(directory);
  return directory;
}

beforeEach(() => {
  // Never let a test that forgets to isolate reach the real machine config:
  // point the lookup at a throwaway XDG root unless the test says otherwise.
  savedXdg = process.env.XDG_CONFIG_HOME;
  xdgRoot = workspace();
  process.env.XDG_CONFIG_HOME = xdgRoot;
});

afterEach(() => {
  // Restore exactly: an unset variable must go back to being unset, never the
  // string "undefined".
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  savedXdg = undefined;
  xdgRoot = undefined;
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("globalConfigDirectory", () => {
  test("uses XDG_CONFIG_HOME, joined with opencode and trimmed", () => {
    const xdg = workspace();
    process.env.XDG_CONFIG_HOME = `  ${xdg}  `;
    expect(globalConfigDirectory()).toBe(join(xdg, "opencode"));
  });

  test("falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(globalConfigDirectory()).toBe(join(homedir(), ".config", "opencode"));
  });

  test("falls back when XDG_CONFIG_HOME is empty or whitespace", () => {
    const expected = join(homedir(), ".config", "opencode");
    process.env.XDG_CONFIG_HOME = "";
    expect(globalConfigDirectory()).toBe(expected);
    process.env.XDG_CONFIG_HOME = "   ";
    expect(globalConfigDirectory()).toBe(expected);
  });

  test("ignores a relative XDG_CONFIG_HOME, per the XDG base directory spec", () => {
    // A relative value would be joined against the host's working directory,
    // which is the directory-dependence the global lookup exists to remove.
    process.env.XDG_CONFIG_HOME = "rel/path";
    expect(globalConfigDirectory()).toBe(join(homedir(), ".config", "opencode"));
  });

  test("still honours an absolute XDG_CONFIG_HOME", () => {
    const xdg = workspace();
    process.env.XDG_CONFIG_HOME = xdg;
    expect(globalConfigDirectory()).toBe(join(xdg, "opencode"));
  });
});

describe("flight deck config file", () => {
  test("searches only the two global file names", () => {
    // No project-relative candidate may come back: there is one global file.
    expect(CONFIG_FILE_CANDIDATES).toEqual(["flight-deck.jsonc", "flight-deck.json"]);
  });

  test("is silent when no config file exists", () => {
    const loaded = loadConfigFile(workspace());
    expect(loaded.options).toBeUndefined();
    expect(loaded.source).toBeUndefined();
    expect(loaded.issue).toBeUndefined();
  });

  test("reads the global file by default, with no directory argument", () => {
    const directory = join(xdgRoot!, "opencode");
    mkdirSync(directory);
    writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": "global rail" } }`);
    const loaded = loadConfigFile();
    expect(loaded.issue).toBeUndefined();
    expect(loaded.source).toBe(join(directory, "flight-deck.jsonc"));
    expect(footerLine(resolveConfig(mergeOptions(loaded.options, undefined)).config)).toBe("global rail");
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

  test("prefers flight-deck.jsonc over flight-deck.json in the same directory", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.json"), `{ "footer": { "text": "plain json" } }`);
    writeFileSync(
      join(directory, "flight-deck.jsonc"),
      `{ "footer": { "text": "jsonc" }, "sidebar": { "lines": ["jsonc line"], "persist": false } }`,
    );
    const loaded = loadConfigFile(directory);
    expect(loaded.source).toContain("flight-deck.jsonc");
    const { config } = resolveConfig(mergeOptions(loaded.options, undefined));
    expect(footerLine(config)).toBe("jsonc");
    expect(sidebarLines(config)).toEqual(["jsonc line"]);
  });

  test("reads flight-deck.json when there is no .jsonc beside it", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.json"), `{ "footer": { "text": "plain json" } }`);
    const loaded = loadConfigFile(directory);
    expect(loaded.source).toContain("flight-deck.json");
    expect(footerLine(resolveConfig(mergeOptions(loaded.options, undefined)).config)).toBe("plain json");
  });

  test("reports a file that parses but is not an object", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.jsonc"), `[1, 2, 3]`);
    const loaded = loadConfigFile(directory);
    expect(loaded.options).toBeUndefined();
    expect(loaded.issue).toContain("must contain a JSON object");
  });

  test("reports a candidate that is not a regular file", () => {
    const directory = workspace();
    // A directory named like the config file: `existsSync` finds it, `statSync`
    // says it is not a file, and the loader must warn rather than throw.
    mkdirSync(join(directory, "flight-deck.jsonc"));
    const loaded = loadConfigFile(directory);
    expect(loaded.options).toBeUndefined();
    expect(loaded.source).toContain("flight-deck.jsonc");
    expect(loaded.issue).toContain("is not a regular file");
  });

  test("reports an unparseable file instead of throwing", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": }`);
    const loaded = loadConfigFile(directory);
    expect(loaded.options).toBeUndefined();
    expect(loaded.issue).toContain("could not be parsed");
    expect(resolveConfig(mergeOptions(loaded.options, undefined)).config).toEqual(DEFAULT_CONFIG);
  });

  test("reports an empty file", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.json"), "   \n");
    const loaded = loadConfigFile(directory);
    expect(loaded.issue).toContain("is empty");
  });

  test("refuses to read an oversized file", () => {
    const directory = workspace();
    writeFileSync(join(directory, "flight-deck.jsonc"), `{ "footer": { "text": "${"x".repeat(70 * 1024)}" } }`);
    const loaded = loadConfigFile(directory);
    expect(loaded.options).toBeUndefined();
    expect(loaded.issue).toContain("larger than");
  });

  test("lets host options override the file", () => {
    const directory = workspace();
    writeFileSync(
      join(directory, "flight-deck.jsonc"),
      `{ "sidebar": { "lines": ["file"], "persist": false }, "footer": { "text": "file footer" } }`,
    );
    const loaded = loadConfigFile(directory);
    const { config } = resolveConfig(mergeOptions(loaded.options, { footer: { text: "host footer" } }));
    expect(footerLine(config)).toBe("host footer");
    expect(sidebarLines(config)).toEqual(["file"]);
  });
});
