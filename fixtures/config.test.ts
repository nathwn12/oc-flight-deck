import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_TEXT,
  DEFAULT_SIDEBAR_LINES,
  mergeOptions,
  resolveConfig,
} from "../src/tui/config.js";
import { footerLine, sidebarLines } from "../src/tui/presentation.js";

describe("flight deck config", () => {
  test("uses the sane defaults when no options are supplied", () => {
    const resolution = resolveConfig(undefined);
    expect(resolution.issues).toEqual([]);
    expect(resolution.config).toEqual(DEFAULT_CONFIG);
    // Literal defaults, so a silent edit to the constants is still caught.
    expect(sidebarLines(resolution.config)).toEqual(["✈ FLIGHT DECK", "─────────────", "visual rail", "cosmetic build"]);
    expect(footerLine(resolution.config)).toBe("Flight Deck · cosmetic rail");
    expect(DEFAULT_FOOTER_TEXT).toBe("Flight Deck · cosmetic rail");
    expect(DEFAULT_SIDEBAR_LINES[0]).toBe("✈ FLIGHT DECK");
  });

  test("applies user overrides and trims whitespace", () => {
    const resolution = resolveConfig({
      sidebar: { enabled: true, lines: ["  MY RAIL  ", "second"] },
      footer: { text: " custom footer " },
    });
    expect(resolution.issues).toEqual([]);
    expect(sidebarLines(resolution.config)).toEqual(["MY RAIL", "second"]);
    expect(footerLine(resolution.config)).toBe("custom footer");
  });

  test("hides rails that are disabled", () => {
    const resolution = resolveConfig({ sidebar: { enabled: false }, footer: { enabled: false } });
    expect(resolution.issues).toEqual([]);
    expect(sidebarLines(resolution.config)).toEqual([]);
    expect(footerLine(resolution.config)).toBeUndefined();
  });

  test("falls back and reports every malformed value", () => {
    const resolution = resolveConfig({
      sidebar: { enabled: "yes", lines: [123, "  ", "ok"] },
      footer: { enabled: "yes", text: "" },
    });
    expect(sidebarLines(resolution.config)).toEqual(["ok"]);
    expect(footerLine(resolution.config)).toBe(DEFAULT_FOOTER_TEXT);
    expect(resolution.issues.length).toBeGreaterThanOrEqual(4);
    expect(resolution.issues.join(" ")).toContain("sidebar.enabled");
    expect(resolution.issues.join(" ")).toContain("footer.enabled");
    expect(resolution.issues.join(" ")).toContain("sidebar.lines[0]");
    expect(resolution.issues.join(" ")).toContain("sidebar.lines[1]");
  });

  test("falls back to the default lines when every entry is unusable", () => {
    const resolution = resolveConfig({ sidebar: { lines: [42, "   ", null] } });
    expect(sidebarLines(resolution.config)).toEqual(["✈ FLIGHT DECK", "─────────────", "visual rail", "cosmetic build"]);
    expect(resolution.issues.join(" ")).toContain("no usable entries");
  });

  test("flattens control characters so a rail can never become two lines", () => {
    const resolution = resolveConfig({ sidebar: { lines: ["A\nB", "C\td"] }, footer: { text: "x\u001b[31my" } });
    expect(sidebarLines(resolution.config)).toEqual(["A B", "C d"]);
    expect(footerLine(resolution.config)).toBe("x [31my");
    expect(resolution.issues.join(" ")).toContain("control characters");
    for (const line of sidebarLines(resolution.config)) {
      expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    }
  });

  test("reports truncation instead of silently shortening", () => {
    const resolution = resolveConfig({ sidebar: { lines: ["y".repeat(400)] }, footer: { text: "z".repeat(400) } });
    expect(sidebarLines(resolution.config)[0]).toHaveLength(120);
    expect(footerLine(resolution.config)).toHaveLength(120);
    expect(resolution.issues.join(" ")).toContain("longer than 120 characters");
  });

  test("survives a non-object options payload and ignores unknown keys", () => {
    expect(resolveConfig("nope").issues).toHaveLength(1);
    expect(resolveConfig(42).config).toEqual(DEFAULT_CONFIG);
    const unknown = resolveConfig({ future: true, sidebar: { colour: "red" } });
    expect(unknown.issues).toEqual([]);
    expect(unknown.config).toEqual(DEFAULT_CONFIG);
  });

  test("caps runaway line counts and very long lines after trimming", () => {
    const many = resolveConfig({ sidebar: { lines: Array.from({ length: 40 }, (_, index) => `line ${index}`) } });
    expect(sidebarLines(many.config)).toHaveLength(24);
    expect(many.issues.join(" ")).toContain("keeping the first 24");

    const long = resolveConfig({ sidebar: { lines: ["x".repeat(400)] } });
    expect(sidebarLines(long.config)[0]).toHaveLength(120);

    // Trimming happens before capping, so padding must not eat visible width.
    const padded = resolveConfig({ sidebar: { lines: [" ".repeat(50) + "y".repeat(400)] } });
    expect(sidebarLines(padded.config)[0]).toBe("y".repeat(120));

    const paddedFooter = resolveConfig({ footer: { text: " ".repeat(50) + "z".repeat(400) } });
    expect(footerLine(paddedFooter.config)).toBe("z".repeat(120));
  });
});

describe("flight deck option precedence", () => {
  test("uses file options when the host sends none", () => {
    const merged = mergeOptions({ footer: { text: "from file" } }, undefined);
    expect(footerLine(resolveConfig(merged).config)).toBe("from file");
  });

  test("lets host options win key by key without dropping file siblings", () => {
    const merged = mergeOptions(
      { sidebar: { lines: ["file line"], enabled: true }, footer: { text: "file footer" } },
      { sidebar: { enabled: false } },
    );
    const { config, issues } = resolveConfig(merged);
    expect(issues).toEqual([]);
    expect(config.sidebar.enabled).toBe(false);
    expect(config.sidebar.lines).toEqual(["file line"]);
    expect(footerLine(config)).toBe("file footer");
  });

  test("reports a malformed section from either source", () => {
    expect(resolveConfig(mergeOptions({ sidebar: "nope" }, undefined)).issues.join(" ")).toContain("sidebar");
    expect(resolveConfig(mergeOptions(undefined, { footer: 12 })).issues.join(" ")).toContain("footer");
  });

  // Pins the intended direction: a malformed section replaces the other source
  // and resolveConfig reports it, so the problem is loud rather than masked.
  test("lets a malformed host section win loudly over a valid file section", () => {
    const { config, issues } = resolveConfig(mergeOptions({ footer: { text: "file footer" } }, { footer: 12 }));
    expect(issues.join(" ")).toContain("footer must be an object");
    expect(footerLine(config)).toBe(DEFAULT_FOOTER_TEXT);
  });

  // The mirror case: when the host supplies a valid section, it takes over and
  // the malformed file section is dropped. (With no host section present, the
  // malformed file value is surfaced instead — see the test above.)
  test("lets a valid host section take over a malformed file section", () => {
    const { config, issues } = resolveConfig(mergeOptions({ sidebar: "nope" }, { sidebar: { lines: ["host"] } }));
    expect(issues).toEqual([]);
    expect(sidebarLines(config)).toEqual(["host"]);
  });

  test("merging two empty sources yields the defaults", () => {
    expect(resolveConfig(mergeOptions(undefined, undefined)).config).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig(mergeOptions({}, {})).config).toEqual(DEFAULT_CONFIG);
  });
});
