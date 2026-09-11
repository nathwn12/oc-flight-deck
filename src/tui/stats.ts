// Live session readouts for the Flight Deck rail.
//
// Everything here is derived from state the host already holds in memory and
// hands to the plugin. There is no network call, no server, and no storage
// write: this module turns a session snapshot into strings.
//
// Kept pure and dependency-free so the formatting is trivial to test.

/** A subagent subtree total, relative to the session being displayed. */
export interface StatTree {
  /** Combined cost of the session plus every subagent session. */
  readonly cost?: unknown;
  /** Number of subagent sessions in the tree. */
  readonly count?: unknown;
}

/** Context-window occupancy for the most recent request. */
export interface StatContext {
  /** Prompt tokens sent on the last request: input plus cache reads. */
  readonly used?: unknown;
  /** The model's context window, when the catalog knows it. */
  readonly limit?: unknown;
}

/** Whole-project spend, across every session in this repository. */
export interface StatProject {
  readonly cost?: unknown;
  readonly count?: unknown;
}

/** The subset of a session snapshot the rail reads. All fields are untrusted. */
export interface StatSource {
  readonly agent?: unknown;
  readonly model?: unknown;
  readonly cost?: unknown;
  readonly tokens?: unknown;
  readonly branch?: unknown;
  readonly tree?: unknown;
  readonly context?: unknown;
  readonly project?: unknown;
  readonly status?: unknown;
  readonly perms?: unknown;
  readonly tps?: unknown;
  readonly elapsedMs?: unknown;
  readonly turns?: unknown;
  /** Recent per-turn output sizes, oldest first, for the sparkline. */
  readonly spark?: unknown;
  /** Animation frame counter, advanced by the ticker. */
  readonly frame?: unknown;
}

/** Fields a user may name in `sidebar.rows`, in the order they are documented. */
export const STAT_FIELDS = [
  "status",
  "agent",
  "model",
  "branch",
  "cost",
  "total",
  "project",
  "tokens",
  "cache",
  "context",
  "perms",
  "elapsed",
  "tps",
  "spark",
  "reasoning",
  "turns",
] as const;

export type StatField = (typeof STAT_FIELDS)[number];

export function isStatField(value: string): value is StatField {
  return (STAT_FIELDS as readonly string[]).includes(value);
}

const LABEL_WIDTH = 10;
const BAR_WIDTH = 10;

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** `518k`, `29.2M`, `32M`, `940` — short enough for a narrow rail, precise enough to read. */
export function formatCount(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  const millions = (value / 1_000_000).toFixed(1);
  return `${millions.endsWith(".0") ? millions.slice(0, -2) : millions}M`;
}

/** Sub-dollar sessions keep a third decimal so a cheap run never reads `$0.00`. */
export function formatCost(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

/** `45s`, `14m`, `2h 14m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** A ten-cell gauge, so a percentage is readable at a glance rather than parsed. */
export function fuelBar(ratio: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(ratio * BAR_WIDTH)));
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Braille frames, advanced by the ticker, shown only while the session runs. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * Recent turn sizes as a shape.
 *
 * Scaled against the largest value in the window rather than an absolute scale,
 * so the sparkline stays readable whether turns are tiny or enormous.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (!Number.isFinite(max) || max <= 0) return SPARK_LEVELS[0].repeat(values.length);
  return values
    .map((value) => {
      const level = Math.floor((Math.max(0, value) / max) * (SPARK_LEVELS.length - 1));
      return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, level)];
    })
    .join("");
}

/**
 * Render one named field, or `undefined` when the host has not supplied it yet.
 *
 * Returning `undefined` rather than a placeholder is deliberate: a rail that
 * shows `branch   unknown` before the repo loads looks broken, while a rail
 * that simply grows a row when the data arrives looks alive.
 */
export function statLine(field: string, source: StatSource): string | undefined {
  switch (field) {
    case "status": {
      const status = asText(source.status);
      if (status === undefined) return undefined;
      // The spinner lives here rather than in a row of its own: an animated
      // glyph beside "running" says the same thing without spending a line.
      if (status !== "running") return row("status", "○ idle");
      const frame = asCount(source.frame) ?? 0;
      return row("status", `${SPINNER[frame % SPINNER.length]} running`);
    }
    case "agent": {
      const agent = asText(source.agent);
      return agent === undefined ? undefined : row("agent", agent);
    }
    case "model": {
      const model = asRecord(source.model);
      const id = asText(model?.id);
      if (id === undefined) return undefined;
      const variant = asText(model?.variant);
      return row("model", variant === undefined ? id : `${id} · ${variant}`);
    }
    case "branch": {
      const branch = asText(source.branch);
      return branch === undefined ? undefined : row("branch", branch);
    }
    case "cost": {
      const cost = asCount(source.cost);
      return cost === undefined ? undefined : row("cost", formatCost(cost));
    }
    case "total": {
      // Only worth a row once a subagent has actually run: subagent sessions are
      // separate, so the parent's `cost` alone understates what was spent.
      const tree = asRecord(source.tree);
      const count = asCount(tree?.count);
      const cost = asCount(tree?.cost);
      if (cost === undefined || count === undefined || count === 0) return undefined;
      const plural = count === 1 ? "subagent" : "subagents";
      return row("total", `${formatCost(cost)} · ${count} ${plural}`);
    }
    case "project": {
      const project = asRecord(source.project);
      const cost = asCount(project?.cost);
      if (cost === undefined) return undefined;
      const count = asCount(project?.count);
      return row("project", `${formatCost(cost)}${count !== undefined && count > 1 ? ` · ${count} sessions` : ""}`);
    }
    case "tokens": {
      const tokens = asRecord(source.tokens);
      const input = asCount(tokens?.input);
      const output = asCount(tokens?.output);
      if (input === undefined && output === undefined) return undefined;
      return row("tokens", `${formatCount(input ?? 0)} in · ${formatCount(output ?? 0)} out`);
    }
    case "cache": {
      const tokens = asRecord(source.tokens);
      const cache = asRecord(tokens?.cache);
      const read = asCount(cache?.read);
      if (read === undefined || read === 0) return undefined;
      const input = asCount(tokens?.input);
      // Hit ratio is the whole point: it explains a cheap bill on a huge token
      // count, and it is the first thing to break when caching stops working.
      const total = input === undefined ? undefined : read + input;
      const value =
        total === undefined || total === 0
          ? `${formatCount(read)} read`
          : `${Math.round((read / total) * 100)}% hit · ${formatCount(read)} read`;
      return row("cache", value);
    }
    case "context": {
      const context = asRecord(source.context);
      const used = asCount(context?.used);
      if (used === undefined || used === 0) return undefined;
      const limit = asCount(context?.limit);
      if (limit === undefined || limit === 0) return row("context", `${formatCount(used)} used`);
      const ratio = used / limit;
      // Show the percentage whenever the host reports it, but never a bar that
      // reads as more than full.
      return row("context", `${fuelBar(ratio)} ${Math.round(Math.min(1, ratio) * 100)}%`);
    }
    case "perms": {
      const perms = asCount(source.perms);
      if (perms === undefined || perms === 0) return undefined;
      return row("perms", perms === 1 ? "1 waiting" : `${perms} waiting`);
    }
    case "elapsed": {
      const ms = asCount(source.elapsedMs);
      if (ms === undefined || ms <= 0) return undefined;
      return row("elapsed", formatDuration(ms));
    }
    case "tps": {
      const tps = asCount(source.tps);
      if (tps === undefined || tps === 0) return undefined;
      return row("tps", `${Math.round(tps)} tok/s`);
    }
    case "spark": {
      const values = Array.isArray(source.spark) ? source.spark.map((value) => asCount(value) ?? 0) : [];
      if (values.length < 2) return undefined;
      return row("spark", sparkline(values));
    }
    case "reasoning": {
      const reasoning = asCount(asRecord(source.tokens)?.reasoning);
      if (reasoning === undefined || reasoning === 0) return undefined;
      return row("reasoning", formatCount(reasoning));
    }
    case "turns": {
      const turns = asCount(source.turns);
      if (turns === undefined || turns === 0) return undefined;
      return row("turns", String(turns));
    }
    default:
      return undefined;
  }
}

/** Render every named field that currently has data, in the given order. */
export function statRows(fields: readonly string[], source: StatSource): readonly string[] {
  const rows: string[] = [];
  for (const field of fields) {
    const line = statLine(field, source);
    if (line !== undefined) rows.push(line);
  }
  return rows;
}
