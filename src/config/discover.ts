import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mergeFlightDeckConfig, type FlightDeckConfig, type FlightDeckConfigPatch } from "./schema.js";
import { parseFlightDeckConfig } from "./parse.js";

export interface ConfigSources {
  readonly globalPath: string;
  readonly projectPath?: string;
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly fs?: {
    readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
    readonly access: (path: string) => Promise<void>;
  };
}

const files = { readFile: (path: string, encoding: "utf8") => readFile(path, encoding), access };

export function globalConfigPath(home = homedir()): string {
  return join(home, ".config", "opencode", "ocfd.jsonc");
}

export function discoverProjectConfigPath(cwd: string, exists: (path: string) => boolean = defaultExists): string | undefined {
  let directory = resolve(cwd);
  while (true) {
    const candidate = join(directory, "ocfd.jsonc");
    if (exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function defaultExists(path: string): boolean {
  return existsSync(path);
}

export function resolveConfigSources(cwd = process.cwd(), home = homedir(), exists: (path: string) => boolean = defaultExists): ConfigSources {
  const projectPath = discoverProjectConfigPath(cwd, exists);
  return projectPath ? { globalPath: globalConfigPath(home), projectPath } : { globalPath: globalConfigPath(home) };
}

export async function loadFlightDeckConfig(options: LoadConfigOptions = {}): Promise<{
  readonly config: FlightDeckConfig;
  readonly sources: ConfigSources;
  readonly problems: readonly string[];
}> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const fs = options.fs ?? files;
  const sources = resolveConfigSources(cwd, home, defaultExists);
  const patches: FlightDeckConfigPatch[] = [];
  const problems: string[] = [];
  for (const path of [sources.globalPath, sources.projectPath]) {
    if (!path) continue;
    try {
      await fs.access(path);
      const parsed = parseFlightDeckConfig(await fs.readFile(path, "utf8"));
      patches.push(parsed.patch);
      problems.push(...parsed.errors.map((error) => `${path}: ${error}`));
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (!code.toLowerCase().includes("enoent") && !code.toLowerCase().includes("not find")) problems.push(`${path}: ${code}`);
    }
  }
  return { config: mergeFlightDeckConfig(...patches), sources, problems };
}
