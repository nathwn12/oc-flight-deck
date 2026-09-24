import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, resolveConfig } from "../src/tui/config.js";
import { parseJsonc } from "../src/tui/file-config.js";
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
    expect(props["sidebar"]!.properties.persist.default).toBe(DEFAULT_CONFIG.sidebar.persist);
    expect(props["sidebar"]!.properties.placeholder.default).toBe(DEFAULT_CONFIG.sidebar.placeholder);
    expect(props["sidebar"]!.properties.maxLines.default).toBe(DEFAULT_CONFIG.sidebar.maxLines);
    expect(DEFAULT_CONFIG.sidebar.persist).toBe(true);
    expect(DEFAULT_CONFIG.sidebar.placeholder).toBe("—");
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

    expect(props["style"]!.properties.lines.default).toEqual(DEFAULT_CONFIG.style.lines);
    expect(props["style"]!.properties.lines.properties.color.default).toBe(DEFAULT_CONFIG.style.lines.color);
    expect(props["style"]!.properties.lines.properties.attributes.default).toEqual([
      ...DEFAULT_CONFIG.style.lines.attributes,
    ]);
    expect(props["style"]!.properties.rows.default).toEqual({
      "*": {
        color: DEFAULT_CONFIG.style.rows.wildcard.color,
        attributes: [...DEFAULT_CONFIG.style.rows.wildcard.attributes],
      },
    });
    expect(props["style"]!.properties.lines.properties.color.enum).toEqual([
      "default",
      "subdued",
      "warning",
      "error",
      "success",
      "info",
    ]);
    expect(props["style"]!.properties.lines.properties.attributes.items.enum).toEqual([
      "bold",
      "dim",
      "italic",
      "underline",
      "blink",
      "inverse",
      "hidden",
      "strikethrough",
    ]);
    const rowStyle = props["style"]!.properties.rows.additionalProperties;
    expect(rowStyle.properties.color.enum).toEqual(props["style"]!.properties.lines.properties.color.enum);
    expect(rowStyle.properties.color.default).toBe(DEFAULT_CONFIG.style.rows.wildcard.color);
    expect(rowStyle.properties.attributes.default).toEqual([
      ...DEFAULT_CONFIG.style.rows.wildcard.attributes,
    ]);
    expect(rowStyle.properties.attributes.items.enum).toEqual(
      props["style"]!.properties.lines.properties.attributes.items.enum,
    );
    expect(props["style"]!.properties.rows.propertyNames.enum).toEqual(["*", ...STAT_FIELDS]);
    for (const option of [
      props["style"]!.properties.lines.properties.color,
      props["style"]!.properties.lines.properties.attributes,
      rowStyle.properties.color,
      rowStyle.properties.attributes,
    ]) {
      expect(option.description.length).toBeGreaterThanOrEqual(20);
    }
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

// A dependency-free walk of the shipped schema: enough to prove the shipped
// example is schema-valid and that hostile values are not. A validation
// library would do more, but it would also be a new install for something the
// schema's own subset (objects, booleans, strings, integers, arrays, enums,
// ranges, `additionalProperties: false`) already expresses — and nothing here
// may ship at runtime.
interface SchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly additionalProperties?: boolean | SchemaNode;
  readonly items?: SchemaNode;
  readonly enum?: readonly unknown[];
  readonly propertyNames?: SchemaNode;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxItems?: number;
  readonly required?: readonly string[];
}

function schemaErrors(node: SchemaNode, value: unknown, path: string): string[] {
  const at = path === "" ? "config" : path;
  if (node.enum !== undefined) {
    return (node.enum as readonly unknown[]).includes(value) ? [] : [`${at} is not one of the allowed values`];
  }
  switch (node.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${at} must be an object`];
      const record = value as Record<string, unknown>;
      const errors: string[] = [];
      const props = node.properties ?? {};
      if (node.propertyNames !== undefined) {
        for (const key of Object.keys(record)) {
          errors.push(...schemaErrors(node.propertyNames, key, `${at} property name`));
        }
      }
      for (const [key, child] of Object.entries(props)) {
        if (key in record) errors.push(...schemaErrors(child, record[key], `${at}.${key}`));
      }
      for (const [key, childValue] of Object.entries(record)) {
        if (key in props) continue;
        if (node.additionalProperties === false) {
          errors.push(`${at}.${key} is not a known option`);
        } else if (typeof node.additionalProperties === "object") {
          errors.push(...schemaErrors(node.additionalProperties, childValue, `${at}.${key}`));
        }
      }
      for (const key of node.required ?? []) {
        if (!(key in record)) errors.push(`${at}.${key} is required`);
      }
      return errors;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at} must be true or false`];
    case "string": {
      if (typeof value !== "string") return [`${at} must be a string`];
      const errors: string[] = [];
      if (node.minLength !== undefined && value.length < node.minLength) {
        errors.push(`${at} must be at least ${node.minLength} characters`);
      }
      if (node.maxLength !== undefined && value.length > node.maxLength) {
        errors.push(`${at} must be at most ${node.maxLength} characters`);
      }
      return errors;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return [`${at} must be an integer`];
      const errors: string[] = [];
      if (node.minimum !== undefined && value < node.minimum) errors.push(`${at} must be at least ${node.minimum}`);
      if (node.maximum !== undefined && value > node.maximum) errors.push(`${at} must be at most ${node.maximum}`);
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${at} must be an array`];
      const errors: string[] = [];
      if (node.maxItems !== undefined && value.length > node.maxItems) {
        errors.push(`${at} must have at most ${node.maxItems} items`);
      }
      if (node.items !== undefined) {
        value.forEach((entry, index) => {
          errors.push(...schemaErrors(node.items as SchemaNode, entry, `${at}[${index}]`));
        });
      }
      return errors;
    }
    default:
      return [];
  }
}

describe("the shipped example validates against the shipped schema", () => {
  test("the example parses and every key, type and default checks out", () => {
    const parsed = parseJsonc(example) as Record<string, unknown>;
    expect(schemaErrors(schema as unknown as SchemaNode, parsed, "")).toEqual([]);
    // The new knobs are written out at their defaults, like every other key.
    const sidebar = parsed["sidebar"] as Record<string, unknown>;
    expect(sidebar["persist"]).toBe(true);
    expect(sidebar["placeholder"]).toBe("—");
    expect(sidebar["maxLines"]).toBe(DEFAULT_CONFIG.sidebar.maxLines);
    const style = parsed["style"] as Record<string, unknown>;
    expect(resolveConfig(parsed).config.style).toEqual(DEFAULT_CONFIG.style);
    expect(style["rows"]).toEqual({ "*": { color: "subdued", attributes: [] } });
  });

  test("hostile values are rejected by the schema or normalized safely by parseConfig", () => {
    // Wrong type: the schema rejects it, and the config falls back loudly.
    const persist = { sidebar: { persist: "yes" } };
    expect(schemaErrors(schema as unknown as SchemaNode, persist, "")).not.toEqual([]);
    const persistResolution = resolveConfig(persist);
    expect(persistResolution.config.sidebar.persist).toBe(true);
    expect(persistResolution.issues.join(" ")).toContain("sidebar.persist");

    // The schema cannot ban control characters, so the config is the net:
    // it normalizes the escape away and reports it, never throwing.
    const placeholder = { sidebar: { placeholder: "x\u001b[31my" } };
    const placeholderResolution = resolveConfig(placeholder);
    expect(placeholderResolution.config.sidebar.placeholder).toBe("x [31my");
    expect(placeholderResolution.issues.join(" ")).toContain("sidebar.placeholder");
    expect(placeholderResolution.issues.join(" ")).toContain("control characters");

    // A non-string row entry fails the rows enum, and is skipped loudly.
    const rows = { sidebar: { rows: [42] } };
    expect(schemaErrors(schema as unknown as SchemaNode, rows, "")).not.toEqual([]);
    const rowsResolution = resolveConfig(rows);
    expect(rowsResolution.config.sidebar.rows).toEqual(DEFAULT_CONFIG.sidebar.rows);
    expect(rowsResolution.issues.join(" ")).toContain("sidebar.rows[0]");

    const maxLines = { sidebar: { maxLines: 25 } };
    expect(schemaErrors(schema as unknown as SchemaNode, maxLines, "")).not.toEqual([]);
    const maxLinesResolution = resolveConfig(maxLines);
    expect(maxLinesResolution.config.sidebar.maxLines).toBe(DEFAULT_CONFIG.sidebar.maxLines);
    expect(maxLinesResolution.issues.join(" ")).toContain("sidebar.maxLines");
  });
});
