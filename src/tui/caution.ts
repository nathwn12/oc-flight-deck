// The caution annunciator: the one failure nothing else on the rail can see.
//
// Everything else in Flight Deck is event-driven state. A hang emits no events
// at all — no completion, no error, no signal of any kind — so every observable
// thing about a hang is the *absence* of something. Catching it needs a clock
// and a baseline instead of a listener, which is why this module exists next to
// the ticker rather than next to the stats.
//
// Four rules, all pure functions of the session snapshot and the current time:
//
//   1. A tool that has not come back. The host records when execution started
//      (`time.ran`, falling back to `time.created`) and when it settled
//      (`time.completed`). A start with no completion is in flight.
//   2. A shell the host still reports as running. This is deliberately separate
//      from rule 1: when a shell command is backgrounded its tool call returns
//      immediately and settles, so the tool part looks finished while the
//      process is still going. `ShellInfo` outlives that.
//   3. The same call, over and over. Three identical consecutive calls is a
//      loop; two is a retry.
//   4. The same call, failing over and over. Distinct from rule 3 because the
//      interesting death spiral is not a repeated success — it is an agent
//      retrying the same broken action and being refused each time.
//
// Followed by one weak rule, kept last and given generous thresholds because it
// cannot distinguish thinking from wedging: a session that reports itself
// running while nothing has settled.
//
// Every rule reports an **observation**, never a verdict. "shell running 8m41s"
// is a fact. "stuck" is a guess, and a ten-minute MSVC build is not a hang. A
// caution light that cries wolf is worse than no caution light.

/** Flight Deck's rail has one line for this, so only the worst is ever drawn. */
export type CautionSeverity = "watch" | "caution";

export type CautionKind = "hung-tool" | "hung-shell" | "repeat-loop" | "failure-loop" | "silent-turn";

export interface CautionThresholds {
  readonly toolWatchMs: number;
  readonly toolCautionMs: number;
  readonly turnWatchMs: number;
  readonly turnCautionMs: number;
  readonly repeatThreshold: number;
  /** How slow a tool may legitimately be before it is worth mentioning. */
  readonly exemptTools: readonly string[];
}

export interface Caution {
  readonly kind: CautionKind;
  readonly severity: CautionSeverity;
  readonly tool?: string;
  /** `running` (executing) or `streaming` (the model is still writing the call). */
  readonly status?: string;
  readonly elapsedMs?: number;
  readonly repeats?: number;
  /** Stable identity, so a toast fires once per distinct problem. */
  readonly key: string;
}

export interface CautionInput {
  /** The snapshot's tool parts, oldest first. */
  readonly parts: readonly unknown[];
  /** Running shells from `context.data.shell`, when the host exposes them. */
  readonly shells?: readonly unknown[];
  readonly now: number;
  readonly sessionRunning: boolean;
  readonly lastMessageAt?: number;
  readonly thresholds: CautionThresholds;
}

// ---------------------------------------------------------------------------
// Reading the host's shapes
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

/** Statuses that mean a tool has stopped. Anything else counts as live. */
const SETTLED_TOOL = new Set(["completed", "error", "aborted", "cancelled"]);

export interface ToolCall {
  readonly name: string;
  readonly status: string;
  /** Canonical form of the input, for comparing one call with the next. */
  readonly inputKey: string;
  readonly startedAt?: number;
  readonly settledAt?: number;
}

/** One message part, or `undefined` for anything that is not a tool call. */
export function readToolCall(value: unknown): ToolCall | undefined {
  const part = asRecord(value);
  if (part === undefined || part["type"] !== "tool") return undefined;

  const name = asText(part["name"]);
  if (name === undefined) return undefined;

  const state = asRecord(part["state"]);
  const time = asRecord(part["time"]);

  return {
    name,
    status: asText(state?.["status"]) ?? "unknown",
    inputKey: stableKey(state?.["input"]),
    startedAt: asCount(time?.["ran"]) ?? asCount(time?.["created"]),
    settledAt: asCount(time?.["completed"]),
  };
}

export function toolCalls(parts: readonly unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of parts) {
    const call = readToolCall(part);
    if (call !== undefined) calls.push(call);
  }
  return calls;
}

/** Key order must not decide whether two identical inputs look identical. */
export function stableKey(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(sortValue(value)).slice(0, 512);
  } catch {
    return "";
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  const record = asRecord(value);
  if (record === undefined) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key]);
  return sorted;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<CautionSeverity, number> = { caution: 0, watch: 1 };

function severityFor(elapsed: number, watchMs: number, cautionMs: number): CautionSeverity {
  return elapsed >= cautionMs ? "caution" : "watch";
}

function newestActivity(calls: readonly ToolCall[]): number | undefined {
  let newest: number | undefined;
  for (const call of calls) {
    const stamp = call.settledAt ?? call.startedAt;
    if (stamp === undefined) continue;
    if (newest === undefined || stamp > newest) newest = stamp;
  }
  return newest;
}

export function detectCautions(input: CautionInput): Caution[] {
  const { parts, now, sessionRunning, thresholds } = input;
  const calls = toolCalls(parts);
  const shells = input.shells ?? [];
  const found: Caution[] = [];
  const exempt = (name: string) => thresholds.exemptTools.includes(name);

  // Rule 1 — a tool that has not come back.
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call === undefined || SETTLED_TOOL.has(call.status) || exempt(call.name)) continue;
    // No recorded start means no measurable duration; silence beats a guess.
    if (call.startedAt === undefined) continue;

    const elapsedMs = now - call.startedAt;
    if (elapsedMs < thresholds.toolWatchMs) continue;

    found.push({
      kind: "hung-tool",
      severity: severityFor(elapsedMs, thresholds.toolWatchMs, thresholds.toolCautionMs),
      tool: call.name,
      status: call.status,
      elapsedMs,
      // Deliberately excludes the status: streaming -> running is progress, and
      // re-raising the alert for it would be noise.
      key: `hung:${call.name}`,
    });
    break;
  }

  // Rule 2 — a shell the host still reports as running.
  //
  // A backgrounded command returns its tool result immediately, so the tool part
  // above settles while the process keeps going. This is the only signal that
  // survives that, and it reads the host's own shell record rather than ours.
  for (const raw of shells) {
    const shell = asRecord(raw);
    if (shell === undefined || shell["status"] !== "running") continue;
    const time = asRecord(shell["time"]);
    const startedAt = asCount(time?.["started"]);
    if (startedAt === undefined) continue;

    const elapsedMs = now - startedAt;
    if (elapsedMs < thresholds.toolWatchMs) continue;
    // Only the long pole matters: twenty backgrounded commands is one problem.
    if (elapsedMs < (found.find((c) => c.kind === "hung-shell")?.elapsedMs ?? 0)) continue;

    const command = asText(shell["command"]) ?? "shell";
    const label = command.split(/\s+/)[0] ?? "shell";
    const existing = found.findIndex((c) => c.kind === "hung-shell");
    const caution: Caution = {
      kind: "hung-shell",
      severity: severityFor(elapsedMs, thresholds.toolWatchMs, thresholds.toolCautionMs),
      tool: label,
      status: "running",
      elapsedMs,
      key: `shell:${label}`,
    };
    if (existing >= 0) found[existing] = caution;
    else found.push(caution);
  }

  // Rule 3 — the same call, over and over.
  //
  // Deliberately excludes a run where every call errored: that is rule 4's
  // business, and one problem should not be reported as two.
  const threshold = Math.max(2, Math.floor(thresholds.repeatThreshold));
  if (calls.length >= threshold) {
    const tail = calls.slice(-threshold);
    const first = tail[0];
    if (
      first !== undefined &&
      !exempt(first.name) &&
      first.inputKey.length > 0 &&
      tail.some((call) => call.status !== "error") &&
      tail.every((call) => call.name === first.name && call.inputKey === first.inputKey)
    ) {
      found.push({
        kind: "repeat-loop",
        severity: "caution",
        tool: first.name,
        repeats: threshold,
        key: `repeat:${first.name}:${first.inputKey.slice(0, 64)}`,
      });
    }
  }

  // Rule 4 — the same call failing over and over.
  //
  // Measured on real history, the genuine death spiral was not a repeated
  // success: it was an agent calling the same unavailable tool again and again
  // and being refused each time. `invalid: unavailable tool 'bash'` repeated is
  // the shape this catches.
  //
  // Identical input is required, the same as rule 3. Three *different* reads
  // that each failed is a rough patch, not a loop — and a rule loose enough to
  // fire on that is one that fires on ordinary work.
  if (calls.length >= threshold) {
    const tail = calls.slice(-threshold);
    const first = tail[0];
    if (
      first !== undefined &&
      !exempt(first.name) &&
      first.inputKey.length > 0 &&
      tail.every(
        (call) =>
          call.name === first.name && call.status === "error" && call.inputKey === first.inputKey,
      )
    ) {
      found.push({
        kind: "failure-loop",
        severity: "caution",
        tool: first.name,
        repeats: threshold,
        key: `failing:${first.name}:${first.inputKey.slice(0, 64)}`,
      });
    }
  }

  // Rule 5 — running, but nothing is moving.
  //
  // A live tool or shell is progress and rules 1 and 2 own it, so this stays out
  // of the way whenever one exists — including an exempt one, because an exempt
  // tool is usually waiting on a person.
  const hasLiveWork =
    calls.some((call) => !SETTLED_TOOL.has(call.status)) ||
    shells.some((raw) => asRecord(raw)?.["status"] === "running");
  if (sessionRunning && !hasLiveWork) {
    const settledAt = newestActivity(calls) ?? input.lastMessageAt;
    if (settledAt !== undefined) {
      const elapsedMs = now - settledAt;
      if (elapsedMs >= thresholds.turnWatchMs) {
        found.push({
          kind: "silent-turn",
          severity: severityFor(elapsedMs, thresholds.turnWatchMs, thresholds.turnCautionMs),
          elapsedMs,
          key: "silent-turn",
        });
      }
    }
  }

  return found.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.kind.length - a.kind.length ||
      a.key.localeCompare(b.key),
  );
}

/** True when anything in the set is worth interrupting for, not just noting. */
export function hasSevereCaution(cautions: readonly Caution[]): boolean {
  return cautions.some((caution) => caution.severity === "caution");
}

/** The rail has one line, so it draws the worst of the set. */
export function worstCaution(cautions: readonly Caution[]): Caution | undefined {
  return [...cautions].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0];
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

export const WATCH_GLYPH = "▲";
export const CAUTION_GLYPH = "⚠";
export const CLEAR_GLYPH = "○";

export function glyphFor(caution: Caution | undefined): string {
  if (caution === undefined) return CLEAR_GLYPH;
  return caution.severity === "caution" ? CAUTION_GLYPH : WATCH_GLYPH;
}

/** The short value beside the label. Says what was seen, not what it means. */
export function cautionText(caution: Caution): string {
  const glyph = glyphFor(caution);
  const elapsed = caution.elapsedMs === undefined ? "" : ` ${formatElapsed(caution.elapsedMs)}`;
  switch (caution.kind) {
    case "hung-tool": {
      // `streaming` means the model is still writing the call's arguments, which
      // is a different situation from a tool that is executing and has not
      // returned. Calling both "running" would be a small lie.
      const phase = caution.status === "streaming" ? "streaming" : "running";
      return `${glyph} ${caution.tool ?? "tool"} ${phase}${elapsed}`;
    }
    case "hung-shell":
      return `${glyph} ${caution.tool ?? "shell"} running${elapsed}`;
    case "repeat-loop":
      return `${glyph} ${caution.tool ?? "tool"} ×${caution.repeats ?? 0} identical`;
    case "failure-loop":
      return `${glyph} ${caution.tool ?? "tool"} failing ×${caution.repeats ?? 0}`;
    case "silent-turn":
      return `${glyph} no progress${elapsed}`;
    default:
      return `${glyph} unknown`;
  }
}

/** The longer sentence, used for the toast. States the observation, then the readings. */
export function cautionDetail(caution: Caution): string {
  const elapsed = caution.elapsedMs === undefined ? "a while" : formatElapsed(caution.elapsedMs);
  const tool = caution.tool ?? "a tool";
  switch (caution.kind) {
    case "hung-tool":
      if (caution.status === "streaming") {
        return `${tool} has been streaming its arguments for ${elapsed}. Either a very large call, or the model has lost the thread.`;
      }
      return `${tool} has been running for ${elapsed} without returning. Slow, or waiting on something that will never finish.`;
    case "hung-shell":
      return `A shell command has been running for ${elapsed}. A build, or a process that will never exit.`;
    case "repeat-loop":
      return `${tool} was called ${caution.repeats ?? 0} times with identical input. That is usually a loop rather than a retry.`;
    case "failure-loop":
      return `${tool} failed ${caution.repeats ?? 0} times in a row. The agent is retrying something that is not working.`;
    case "silent-turn":
      return `The session is running but nothing has settled for ${elapsed}. Either the model is still thinking, or the turn is wedged.`;
    default:
      return "Something looks wrong, but this build cannot say what.";
  }
}

/** `45s`, `14m`, `2h 14m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
