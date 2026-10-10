import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { mergeOptions, resolveConfig } from "../src/tui/config.js";
import { loadConfigFile } from "../src/tui/file-config.js";
import { createGoLookReader } from "../src/tui/go-look.js";
import { goPanelLines } from "../src/tui/go-panel.js";

// Breathe ring, bar cells, and placeholder as escapes so this file stays
// ASCII, like the go-panel tests.
const REST = String.fromCharCode(0x25cb);
const NOW = 1_700_000_000_000;

const created: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-go-look-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** Write the config file and force a mtime the reader cannot miss. */
function writeConfig(directory: string, body: string, mtimeMs: number): string {
  const path = join(directory, "flight-deck.jsonc");
  writeFileSync(path, body);
  const atime = new Date(mtimeMs);
  utimesSync(path, atime, atime);
  return path;
}

/** The setup path: load, merge with host options, resolve, take the layout. */
function setupLayout(directory: string, hostOptions: unknown): unknown {
  const file = loadConfigFile(directory);
  const { config } = resolveConfig(mergeOptions(file.options, hostOptions));
  const go = config.sidebar.footer.go;
  return go === true ? undefined : typeof go === "object" && go !== null ? go : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe("go look reader", () => {
  test("adopts the new look after the config file's mtime changes", () => {
    const directory = workspace();
    const first = writeConfig(directory, `{ "sidebar": { "footer": { "go": { "reset": false } } } }`, 1_700_000_000_000);
    void first;
    const reader = createGoLookReader({ directory, initial: setupLayout(directory, undefined) });

    // The first render takes the cheap path: primed at creation, no re-read.
    const before = asRecord(reader.current());
    expect(before["reset"]).toBe(false);
    expect(before["blink"]).toBe(true);
    expect(reader.reads()).toBe(0);

    // The owner's second edit: the reset countdown AND the breathing mark go.
    writeConfig(
      directory,
      `{ "sidebar": { "footer": { "go": { "reset": false, "blink": false } } } }`,
      1_700_000_100_000,
    );
    const after = asRecord(reader.current());
    expect(after["reset"]).toBe(false);
    expect(after["blink"]).toBe(false);
    expect(reader.reads()).toBe(1);

    // And the render follows: no reset column, no mark column.
    const lines = goPanelLines(undefined, NOW, after);
    expect(lines[0]?.text.startsWith(`${REST} `)).toBe(false);
    expect(lines[0]?.text).not.toContain("1h");
  });

  test("does not re-read the file when the mtime is unchanged", () => {
    const directory = workspace();
    writeConfig(directory, `{ "sidebar": { "footer": { "go": { "reset": false } } } }`, 1_700_000_000_000);
    const reader = createGoLookReader({ directory, initial: setupLayout(directory, undefined) });

    const first = reader.current();
    for (let frame = 0; frame < 10; frame += 1) {
      expect(reader.current()).toBe(first);
    }
    expect(reader.reads()).toBe(0);
  });

  test("keeps the last good look when the file is missing, unreadable, or malformed", () => {
    const directory = workspace();
    writeConfig(directory, `{ "sidebar": { "footer": { "go": { "reset": false } } } }`, 1_700_000_000_000);
    const reader = createGoLookReader({ directory, initial: setupLayout(directory, undefined) });
    const good = reader.current();

    // Malformed: unparseable text with a newer mtime still re-reads (cheaply,
    // once) but never replaces the look and never throws.
    writeConfig(directory, `{ "sidebar": { "footer": { "go": `, 1_700_000_100_000);
    expect(() => reader.current()).not.toThrow();
    expect(reader.current()).toBe(good);

    // Deleted outright: the look survives that too.
    rmSync(join(directory, "flight-deck.jsonc"));
    expect(() => reader.current()).not.toThrow();
    expect(reader.current()).toBe(good);

    // A file that parses but is not an object is reported, not adopted.
    writeConfig(directory, `[1, 2, 3]`, 1_700_000_200_000);
    expect(reader.current()).toBe(good);
  });

  test("lets host-forwarded options keep precedence over later file edits", () => {
    const directory = workspace();
    writeConfig(directory, `{ "sidebar": { "footer": { "go": { "reset": false } } } }`, 1_700_000_000_000);
    const hostOptions = { sidebar: { footer: { go: { blink: false } } } };
    const reader = createGoLookReader({ directory, hostOptions, initial: setupLayout(directory, hostOptions) });

    const setup = asRecord(reader.current());
    expect(setup["blink"]).toBe(false);
    // The host's `sidebar.footer` replaces the file's wholesale (the merge is
    // per section, not per key), so the file's `reset: false` does not apply
    // while the host claims the footer: the default comes back.
    expect(setup["reset"]).toBe(true);

    // A later file edit enabling the mark cannot override the host's look.
    writeConfig(
      directory,
      `{ "sidebar": { "footer": { "go": { "reset": true, "blink": true } } } }`,
      1_700_000_100_000,
    );
    const live = asRecord(reader.current());
    expect(live["blink"]).toBe(false);
    expect(live["reset"]).toBe(true);
  });

  test("starts from the setup look when no config file exists yet", () => {
    const directory = workspace();
    const reader = createGoLookReader({ directory, initial: undefined });
    expect(reader.current()).toBeUndefined();
    expect(reader.reads()).toBe(0);

    // A file created after setup is a change like any other: it is adopted.
    writeConfig(directory, `{ "sidebar": { "footer": { "go": { "reset": false } } } }`, 1_700_000_100_000);
    expect(asRecord(reader.current())["reset"]).toBe(false);
    expect(reader.reads()).toBe(1);
  });
});
