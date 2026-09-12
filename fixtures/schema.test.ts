import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/tui/config.js";
import { STAT_FIELDS } from "../src/tui/stats.js";

// The schema is how an AI is expected to discover this plugin's settings, so it
// has to be true. A schema that quietly drifts from the code is worse than no
// schema at all: it is documentation that lies, and it lies to the one reader
// that cannot tell.

const root = join(import.meta.dir, "..");
const schema = JSON.parse(readFileSync(join(root, "flight-deck.schema.json"), "utf8")) as {
  properties: Record<string, any>;
};
const props = schema.properties;

const example = readFileSync(join(root, "flight-deck.example.jsonc"), "utf8");

describe("the schema describes the real config", () => {
  test("every top-level key in the code is documented", () => {
    // The load-bearing one: a new option cannot be added without appearing in
    // the schema, so an AI can never be reading a stale list of knobs.
    const documented = new Set(Object.keys(props));
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(documented.has(key)).toBe(true);
    }
  });

  test("and the schema documents nothing that is not real", () => {
    const real = new Set([...Object.keys(DEFAULT_CONFIG), "$schema"]);
    for (const key of Object.keys(props)) {
      expect(real.has(key)).toBe(true);
    }
  });

  test("every documented default matches the code", () => {
    expect(props["refresh"]!.default).toBe(DEFAULT_CONFIG.refresh);
    expect(props["sidebar"]!.properties.enabled.default).toBe(DEFAULT_CONFIG.sidebar.enabled);
    expect(props["sidebar"]!.properties.lines.default).toEqual([...DEFAULT_CONFIG.sidebar.lines]);
    expect(props["sidebar"]!.properties.rows.default).toEqual([...DEFAULT_CONFIG.sidebar.rows]);
    expect(props["footer"]!.properties.text.default).toBe(DEFAULT_CONFIG.footer.text);

    expect(props["caution"]!.properties.enabled.default).toBe(DEFAULT_CONFIG.caution.enabled);
    expect(props["caution"]!.properties.toolWatchSeconds.default).toBe(DEFAULT_CONFIG.caution.toolWatchSeconds);
    expect(props["caution"]!.properties.toolCautionSeconds.default).toBe(DEFAULT_CONFIG.caution.toolCautionSeconds);
    expect(props["caution"]!.properties.turnWatchSeconds.default).toBe(DEFAULT_CONFIG.caution.turnWatchSeconds);
    expect(props["caution"]!.properties.turnCautionSeconds.default).toBe(DEFAULT_CONFIG.caution.turnCautionSeconds);
    expect(props["caution"]!.properties.repeatThreshold.default).toBe(DEFAULT_CONFIG.caution.repeatThreshold);
    expect(props["caution"]!.properties.exemptTools.default).toEqual([...DEFAULT_CONFIG.caution.exemptTools]);
    expect(props["caution"]!.properties.toast.default).toBe(DEFAULT_CONFIG.caution.toast);

    expect(props["layout"]!.properties.labelWidth.default).toBe(DEFAULT_CONFIG.layout.labelWidth);
    expect(props["layout"]!.properties.barWidth.default).toBe(DEFAULT_CONFIG.layout.barWidth);
    expect(props["layout"]!.properties.sparkWidth.default).toBe(DEFAULT_CONFIG.layout.sparkWidth);

    expect(props["glyphs"]!.properties.watch.default).toBe(DEFAULT_CONFIG.glyphs.watch);
    expect(props["glyphs"]!.properties.caution.default).toBe(DEFAULT_CONFIG.glyphs.caution);
    expect(props["glyphs"]!.properties.clear.default).toBe(DEFAULT_CONFIG.glyphs.clear);
  });

  test("the rows enum is the real list of fields", () => {
    expect(props["sidebar"]!.properties.rows.items.enum).toEqual([...STAT_FIELDS]);
  });

  test("every option carries a description, because that is the point", () => {
    const undocumented: string[] = [];
    for (const [key, value] of Object.entries(props) as Array<[string, any]>) {
      if (key === "$schema") continue;
      if (typeof value.description !== "string" || value.description.length < 20) {
        undocumented.push(key);
        continue;
      }
      for (const [child, childValue] of Object.entries(value.properties ?? {}) as Array<[string, any]>) {
        if (typeof childValue.description !== "string" || childValue.description.length < 20) {
          undocumented.push(`${key}.${child}`);
        }
      }
    }
    expect(undocumented).toEqual([]);
  });

  test("no option is described as required, because none of them are", () => {
    expect(schema as unknown as { required?: unknown }).not.toHaveProperty("required");
  });
});

describe("the example config points at the schema", () => {
  test("so an editor or an AI can find the authoritative list", () => {
    expect(example).toContain('"$schema"');
    expect(example).toContain("flight-deck.schema.json");
  });
});
