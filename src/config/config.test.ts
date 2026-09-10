import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFlightDeckConfig, parseFlightDeckConfig, discoverProjectConfigPath, mergeFlightDeckConfig, patchFlightDeckConfigFile, patchFlightDeckConfigText } from "./index.js";

describe("Flight Deck config", () => {
  test("has safe defaults and autopilot is off", () => {
    const result = mergeFlightDeckConfig();
    expect(result.metrics.tps).toBe(true);
    expect(result.ui.footer).toBe("always");
    expect(result.autopilot.enabled).toBe(false);
  });

  test("parses JSONC and rejects malformed values without enabling autopilot", () => {
    const parsed = parseFlightDeckConfig(`{
      // comments are supported
      "metrics": { "tps": false },
      "metrics": { "ttft": false },
      "autopilot": { "enabled": "yes", "backoff": true },
    }`);
    const config = mergeFlightDeckConfig(parsed.patch);
    expect(config.metrics.ttft).toBe(false);
    expect(config.metrics.tps).toBe(true);
    expect(config.autopilot.enabled).toBe(false);
    expect(config.autopilot.backoff).toBe(true);
  });

  test("project overrides global sparsely", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocfd-config-"));
    const project = join(root, "project", "nested");
    const home = join(root, "home");
    const globalPath = join(home, ".config", "opencode", "ocfd.jsonc");
    const projectPath = join(root, "project", "ocfd.jsonc");
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(globalPath, '{ "telemetry": { "enabled": false }, "metrics": { "tps": false }, "autopilot": { "backoff": false } }');
    await writeFile(projectPath, '{ "telemetry": { "cost": false }, "autopilot": { "enabled": true } }');
    const result = await loadFlightDeckConfig({ cwd: project, home, fs: { readFile: (path, encoding) => readFile(path, encoding), access: async (path) => { await readFile(path); } } });
    expect(result.config.telemetry.enabled).toBe(false);
    expect(result.config.metrics.tps).toBe(false);
    expect(result.config.metrics.cost).toBe(true);
    expect(result.config.autopilot.enabled).toBe(true);
    expect(result.config.autopilot.backoff).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("discovers the nearest project file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocfd-discovery-"));
    const project = join(root, "a", "b");
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a", "ocfd.jsonc"), "{}");
    expect(discoverProjectConfigPath(project, (path) => path.endsWith("\\a\\ocfd.jsonc") || path.endsWith("/a/ocfd.jsonc"))).toContain("ocfd.jsonc");
    await rm(root, { recursive: true, force: true });
  });

  test("patches JSONC while retaining comments", () => {
    const source = "{\n  // keep this\n  \"metrics\": { \"tps\": true },\n}\n";
    const output = patchFlightDeckConfigText(source, ["metrics", "tps"], false);
    expect(output).toContain("// keep this");
    expect(output).toContain('"tps": false');
  });

  test("writes a selected config file and preserves the patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocfd-patch-"));
    const file = join(root, "ocfd.jsonc");
    await writeFile(file, "{ // user config\n}\n");
    await patchFlightDeckConfigFile(file, ["autopilot", "enabled"], true);
    const text = await readFile(file, "utf8");
    expect(text).toContain("// user config");
    expect(parseFlightDeckConfig(text).patch.autopilot?.enabled).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
