// Row rendering for the Flight Deck rail: one padded line per named field.
//
// `statLine` renders a single field or `undefined` when the host has not
// supplied it yet; `statRows` renders a list of fields and folds in the
// persistence behaviour. Every value passes through `plain`, so a control
// character in a host-supplied string cannot move the cursor. Pure and
// dependency-free so the rendering is trivial to test.

import { DEFAULT_BAR_WIDTH, clip, formatCost, formatCount, formatDuration, fuelBar, sparkline } from "./format.js";
import {
  DEFAULT_LABEL_WIDTH,
  DEFAULT_PLACEHOLDER,
  DEFAULT_SPARK_WIDTH,
  asCount,
  asRecord,
  asText,
  isStatField,
  type LayoutHint,
  type StatSource,
} from "./stat-fields.js";

/**
 * A guard count: a non-negative whole number, or an array counted by length.
 *
 * The RPC aggregates are numbers, but an array (findings, breaches) reads the
 * same way — how many — so both count. Anything else is dropped to `undefined`
 * so the caller can fall back to zero rather than print garbage.
 */
function asGuardCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function guardCountOrZero(...candidates: readonly unknown[]): number {
  for (const candidate of candidates) {
    const count = asGuardCount(candidate);
    if (count !== undefined) return count;
  }
  return 0;
}

/**
 * Short harness token for the `guard` row, or `undefined` when there is no
 * usable data (the persist layer then renders the placeholder).
 *
 * A section counts as usable only with an explicit boolean `available`: a
 * present section with a missing or garbage flag is dropped, not read as
 * either `ok` or `unknown`. Any usable section reporting `available: false`
 * reads as `unknown` — a failed or disabled source never renders a false `ok`.
 * Otherwise the worst signal wins: breaches, then orphans, then findings.
 * ASCII, short, no padding.
 */
function guardToken(value: unknown): string | undefined {
  try {
    const top = asRecord(value);
    if (top === undefined) return undefined;

  const air = asRecord(top.airworthiness);
  const war = asRecord(top.warden);
  const plan = asRecord(top.flightPlan);

  const airUsable = air !== undefined && (air.available === true || air.available === false);
  const warUsable = war !== undefined && (war.available === true || war.available === false);
  const planUsable = plan !== undefined && (plan.available === true || plan.available === false);
  if (!airUsable && !warUsable && !planUsable) return undefined;

  if ((airUsable && air.available === false) || (warUsable && war.available === false) || (planUsable && plan.available === false)) {
    return "unknown";
  }

  const breaches = warUsable ? guardCountOrZero(war.breaches) : 0;
  const orphans = warUsable ? guardCountOrZero(war.orphans) : 0;
  const findings = airUsable ? guardCountOrZero(air.findings, air.counts) : 0;

  // Abbreviated so a huge count cannot exceed the rail width; stays ASCII.
  if (breaches > 0) return `${formatCount(breaches)} breach`;
  if (orphans > 0) return `${formatCount(orphans)} orphan`;
  if (findings > 0) return `${formatCount(findings)} finding`;
  return "ok";
  } catch {
    return undefined;
  }
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
    case "guard": {
      const token = guardToken(source.guard);
      return token === undefined ? undefined : row("guard", token);
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
