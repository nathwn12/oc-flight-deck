import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFlightDeckConfig, mergeFlightDeckConfig } from "../src/config/index.js";

const root = join(import.meta.dir, "..");

describe("package scaffold", () => {
  test("declares the three plugin entrypoints and a private repository package", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.exports).toMatchObject({ ".": { import: "./src/server/index.ts" }, "./rpc": { import: "./src/server/rpc.ts" }, "./tui": { import: "./src/tui/index.tsx" } });
    expect(packageJson.dependencies).toMatchObject({ "@opencode/plugin": "0.0.0-beta-19425", "jsonc-parser": "3.3.1" });
  });

  test("uses one check gate and strict TypeScript", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const tsconfig = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
    expect(packageJson.scripts.check).toContain("typecheck");
    expect(packageJson.scripts.check).toContain("test");
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noEmit).toBe(true);
  });

  test("ships a safe JSONC config example", async () => {
    const parsed = parseFlightDeckConfig(await readFile(join(root, "ocfd.example.jsonc"), "utf8"));
    const config = mergeFlightDeckConfig(parsed.patch);
    expect(parsed.errors).toEqual([]);
    expect(config.metrics.tps).toBe(true);
    expect(config.ui.footer).toBe("always");
    expect(config.autopilot.enabled).toBe(false);
  });

  test("local probe config uses the installed beta's directory plugin key", async () => {
    const text = await readFile(join(root, "opencode.jsonc"), "utf8");
    expect(text).toContain('"plugins"');
    expect(text).toContain("./src/server");
  });
});
