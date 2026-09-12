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
  /**
   * Prompt tokens sent on the last request: input, cache reads, and cache
   * writes. All three occupy the window, so all three count.
   */
  readonly used?: unknown;
  /** The model's context window, when the catalog knows it. */
  readonly limit?: unknown;
}

/** Whole-project spend, across every session in this project. */
export interface StatProject {
  readonly cost?: unknown;
  readonly count?: unknown;
}

/** The subset of a session snapshot the rail reads. All fields are untrusted. */
export interface StatSource {
  /**
   * The annunciator line, precomputed by the caller.
   *
   * A plain string on purpose: the rules that decide whether something is wrong
   * live in ./caution.ts and need the clock and the session snapshot, not a
   * formatting function. Severity is already encoded in the glyph.
   */
  readonly caution?: unknown;
  readonly agent?: unknown;
  readonly model?: unknown;
  readonly cost?: unknown;
  readonly tokens?: unknown;
  readonly branch?: unknown;
  readonly tree?: unknown;
  readonly context?: unknown;
  readonly project?: unknown;
  readonly status?: unknown;
  /** True when anything is working: this session, a subagent, or a shell. */
  readonly busy?: unknown;
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
  "caution",
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

/**
 * Fields whose value only ever changes on a clock tick.
 *
 * The ticker exists to animate these. When none of them is on screen there is
 * nothing to animate, so the plugin does not start a timer at all.
 *
 * `caution` belongs here for a stronger reason than the others: its whole job is
 * noticing that time has passed without anything happening, so without a tick
 * its thresholds could never be crossed on screen.
 */
export const ANIMATED_FIELDS = ["caution", "status", "elapsed"] as const;

export function isStatField(value: string): value is StatField {
  return (STAT_FIELDS as readonly string[]).includes(value);
}

/**
 * Row geometry, overridable per call.
 *
 * A structural type rather than an import of `FlightDeckConfig`: ./config.ts
 * imports this module, so reaching back into it would create a cycle. The
 * shapes are compatible, so the config passes straight through.
 */
export interface LayoutHint {
  readonly labelWidth?: number;
  readonly barWidth?: number;
  readonly sparkWidth?: number;
  /**
   * True when the rail already draws a `total` row.
   *
   * The `cost` row merges the subagent total into itself only when nothing else
   * on the rail already shows it — which makes "do I want one money row or two"
   * a property of `sidebar.rows`, not a separate setting to find.
   */
  readonly hasTotalRow?: boolean;
  /**
   * When true, `statRows` renders one row per named field even when the host
   * has no data for it, using `placeholder` as the value. Default off when
   * calling `statRows` directly; `sidebarLines` turns it on from
   * `config.sidebar.persist`.
   */
  readonly persist?: boolean;
  /** Value shown for a row with no data when `persist` is on. Default `"—"`. */
  readonly placeholder?: string;
}

/** Placeholder value for a persistent row with no data yet. */
export const DEFAULT_PLACEHOLDER = "—";

const DEFAULT_LABEL_WIDTH = 10;
const DEFAULT_BAR_WIDTH = 10;
const DEFAULT_SPARK_WIDTH = 12;

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
  // Round *before* choosing the unit. Rounding only inside the `k` branch made
  // anything from 999,500 to 999,999 print as `1000k` — a number with two
  // magnitudes in it, and one an agent reads as a different size entirely.
  const thousands = Math.round(value / 1_000);
  if (thousands < 1_000) return `${thousands}k`;
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
export function fuelBar(ratio: number, width: number = DEFAULT_BAR_WIDTH): string {
  const cells = Math.max(1, Math.floor(width));
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Shorten a value for a narrow rail.
 *
 * The sidebar is roughly thirty-odd columns wide and the label already costs
 * ten, so a resource path has to be cut. The ellipsis is deliberate: a silently
 * truncated path reads as a complete one.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  // Never cut a surrogate pair in half: the orphaned half renders as a
  // replacement character, which reads as corruption rather than as a shortened
  // path. Losing one more column is the cheaper mistake.
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${safe}…`;
}

/** Braille frames, advanced by the ticker, shown only while the session runs. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * Flatten control characters in anything about to be drawn.
 *
 * A rail is one line per row, so a newline or an escape sequence in a
 * host-supplied string does not get seen — it moves the cursor. Config text is
 * already flattened in ./config.ts, but a tool name, a permission resource or a
 * branch name arrives straight from the host, so every row value passes through
 * here on its way out. `replace` is unconditional rather than `test` + `replace`:
 * a global regex used with `test` carries `lastIndex` between calls.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function plain(value: string): string {
  return value.replace(CONTROL_CHARS, " ");
}

/**
 * One padded rail row: the label in its column, at least one space, then the
 * flattened value. Shared by live rows and persistent placeholders so both
 * keep the same column.
 */
function formatRow(label: string, value: string, labelWidth: number): string {
  return `${label.padEnd(labelWidth)}${label.length >= labelWidth ? " " : ""}${plain(value)}`;
}

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
export function statLine(
  field: string,
  source: StatSource,
  layout: LayoutHint = {},
): string | undefined {
  // Bound here rather than at module scope so a config file can change the
  // column width without every call site having to know about it.
  const labelWidth = layout.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const barWidth = layout.barWidth ?? DEFAULT_BAR_WIDTH;
  const sparkWidth = layout.sparkWidth ?? DEFAULT_SPARK_WIDTH;
  // At least one space, always.
  //
  // `padEnd` returns the label unchanged when it is already wider than the
  // column, so a label longer than `labelWidth` was glued straight onto its
  // value: at labelWidth 8 the `reasoning` row rendered as "reasoning153k".
  // The label is nine characters, which made this reachable from a config file.
  const row = (label: string, value: string): string => formatRow(label, value, labelWidth);

  switch (field) {
    case "caution": {
      // Rendered only when the caller found something to say, which is what
      // keeps a healthy session visually identical to one without the
      // annunciator at all. The string already carries its glyph; nothing here
      // knows or cares about severity.
      const text = asText(source.caution);
      return text === undefined ? undefined : row("caution", text);
    }
    case "status": {
      const status = asText(source.status);
      if (status === undefined && source.busy === undefined) return undefined;
      // The spinner lives here rather than in a row of its own: an animated
      // glyph beside "running" says the same thing without spending a line.
      //
      // `busy` folds in work the session's own status misses — a subagent
      // running in its own session, or a shell command still going — so the
      // glyph only stops when there is genuinely nothing happening. A host that
      // does not report it falls back to the session's own status.
      if (source.busy !== true && status !== "running") return row("status", "○ idle");
      // Floored at the boundary: a fractional frame would index the frame list
      // with a non-integer and render `undefined`.
      const frame = Math.floor(asCount(source.frame) ?? 0);
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
      const tree = asRecord(source.tree);
      const treeCost = asCount(tree?.cost);
      const count = asCount(tree?.count);
      const family = count !== undefined && count > 0 ? count : 0;

      // Merge only when subagents actually ran, and only when the rail is not
      // already showing a `total` row. Two rows holding a number and its own
      // superset was the thing worth fixing; a setting to choose between them
      // would just be that duplication with extra steps.
      const merge =
        layout.hasTotalRow !== true &&
        cost !== undefined &&
        treeCost !== undefined &&
        family > 0 &&
        treeCost > cost;

      if (!merge) {
        const value = layout.hasTotalRow === true ? (cost ?? treeCost) : (treeCost ?? cost);
        return value === undefined ? undefined : row("cost", formatCost(value));
      }

      // The delta (`+$0.020`) used to be here and pushed the row to 40 columns,
      // wide enough to wrap in a normal sidebar. It was real information that
      // did not earn its width: the count already explains why the figure is
      // higher, and this form is the same width as the old `total` row.
      const plural = family === 1 ? "subagent" : "subagents";
      return row("cost", `${formatCost(treeCost as number)} · ${family} ${plural}`);
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
      return row("context", `${fuelBar(ratio, barWidth)} ${Math.round(Math.min(1, ratio) * 100)}%`);
    }
    case "perms": {
      const perms = asRecord(source.perms);
      const count = asCount(perms?.["count"]);
      if (count === undefined || count === 0) return undefined;
      const action = asText(perms?.["action"]);
      const resource = asText(perms?.["resource"]);

      // One request: name it, because that is the decision you are being asked
      // to make. Several: the count leads, because the first request in the
      // queue is not necessarily the one you are about to be shown.
      if (count > 1) {
        return row("perms", action === undefined ? `${count} waiting` : `${count} waiting · ${action}`);
      }
      if (action === undefined) return row("perms", "1 waiting");
      // Clipped hard: a row that wraps costs the reader more than a row that
      // shortens a path, and there is no way to ask the host how wide it is.
      return row("perms", resource === undefined ? action : `${action} · ${clip(resource, 18)}`);
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
      // The newest samples are the interesting ones, so a narrowed window keeps
      // the recent shape rather than the oldest.
      const windowed = values.slice(-Math.max(2, Math.floor(sparkWidth)));
      if (windowed.length < 2) return undefined;
      return row("spark", sparkline(windowed));
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

/** Render every named field, in the given order.
 *
 * By default only fields with data render; with `layout.persist` every known
 * field renders exactly one row, using `layout.placeholder` (default `"—"`)
 * for the value when the host has nothing to show yet. `statLine` keeps
 * returning `string | undefined` — persistence lives here, not there.
 */
export function statRows(
  fields: readonly string[],
  source: StatSource,
  layout: LayoutHint = {},
): readonly string[] {
  // The rows list decides whether `cost` merges the subagent total into itself.
  // Passing that down means the choice lives in `sidebar.rows`, where someone
  // is already deciding what the rail shows.
  const hint: LayoutHint = { ...layout, hasTotalRow: fields.includes("total") };
  const persist = hint.persist === true;
  const placeholder = hint.placeholder ?? DEFAULT_PLACEHOLDER;
  const labelWidth = hint.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const rows: string[] = [];
  for (const field of fields) {
    const line = statLine(field, source, hint);
    if (line !== undefined) {
      rows.push(line);
      continue;
    }
    // Unknown names stay skipped even when persistent: a typo must stay a
    // reported-and-skipped row, not a placeholder that looks intentional.
    if (!persist || !isStatField(field)) continue;
    rows.push(formatRow(field, placeholder, labelWidth));
  }
  return rows;
}
