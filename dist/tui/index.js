// @bun
// src/tui/index.tsx
import { Plugin } from "@opencode/plugin/tui";

// src/tui/caution.ts
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function asCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function asText(value) {
  if (typeof value !== "string")
    return;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}
var SETTLED_TOOL = new Set(["completed", "error", "aborted", "cancelled"]);
function readToolCall(value) {
  const part = asRecord(value);
  if (part === undefined || part["type"] !== "tool")
    return;
  const name = asText(part["name"]);
  if (name === undefined)
    return;
  const state = asRecord(part["state"]);
  const time = asRecord(part["time"]);
  return {
    name,
    status: asText(state?.["status"]) ?? "unknown",
    inputKey: stableKey(state?.["input"]),
    startedAt: asCount(time?.["ran"]) ?? asCount(time?.["created"]),
    settledAt: asCount(time?.["completed"])
  };
}
function toolCalls(parts) {
  const calls = [];
  for (const part of parts) {
    const call = readToolCall(part);
    if (call !== undefined)
      calls.push(call);
  }
  return calls;
}
function stableKey(value) {
  if (value === undefined)
    return "";
  try {
    return JSON.stringify(sortValue(value)).slice(0, 512);
  } catch {
    return "";
  }
}
function sortValue(value) {
  if (Array.isArray(value))
    return value.map(sortValue);
  const record = asRecord(value);
  if (record === undefined)
    return value;
  const sorted = {};
  for (const key of Object.keys(record).sort())
    sorted[key] = sortValue(record[key]);
  return sorted;
}
var SEVERITY_ORDER = { caution: 0, watch: 1 };
function severityFor(elapsed, cautionMs) {
  return elapsed >= cautionMs ? "caution" : "watch";
}
function newestActivity(calls) {
  let newest;
  for (const call of calls) {
    const stamp = call.settledAt ?? call.startedAt;
    if (stamp === undefined)
      continue;
    if (newest === undefined || stamp > newest)
      newest = stamp;
  }
  return newest;
}
function detectCautions(input) {
  const { parts, now, sessionRunning, thresholds } = input;
  const calls = toolCalls(parts);
  const shells = input.shells ?? [];
  const found = [];
  const exempt = (name) => thresholds.exemptTools.includes(name);
  for (let index = calls.length - 1;index >= 0; index -= 1) {
    const call = calls[index];
    if (call === undefined || SETTLED_TOOL.has(call.status) || exempt(call.name))
      continue;
    if (call.startedAt === undefined)
      continue;
    const elapsedMs = now - call.startedAt;
    if (elapsedMs < thresholds.toolWatchMs)
      continue;
    found.push({
      kind: "hung-tool",
      severity: severityFor(elapsedMs, thresholds.toolCautionMs),
      tool: call.name,
      status: call.status,
      elapsedMs,
      key: `hung:${call.name}`
    });
    break;
  }
  for (const raw of shells) {
    const shell = asRecord(raw);
    if (shell === undefined || shell["status"] !== "running")
      continue;
    const time = asRecord(shell["time"]);
    const startedAt = asCount(time?.["started"]);
    if (startedAt === undefined)
      continue;
    const elapsedMs = now - startedAt;
    if (elapsedMs < thresholds.toolWatchMs)
      continue;
    if (elapsedMs < (found.find((c) => c.kind === "hung-shell")?.elapsedMs ?? 0))
      continue;
    const command = asText(shell["command"]) ?? "shell";
    const label = command.split(/\s+/)[0] ?? "shell";
    const existing = found.findIndex((c) => c.kind === "hung-shell");
    const caution = {
      kind: "hung-shell",
      severity: severityFor(elapsedMs, thresholds.toolCautionMs),
      tool: label,
      status: "running",
      elapsedMs,
      key: `shell:${label}`
    };
    if (existing >= 0)
      found[existing] = caution;
    else
      found.push(caution);
  }
  const threshold = Math.max(2, Math.floor(thresholds.repeatThreshold));
  if (calls.length >= threshold) {
    const tail = calls.slice(-threshold);
    const first = tail[0];
    if (first !== undefined && !exempt(first.name) && first.inputKey.length > 0 && tail.some((call) => call.status !== "error") && tail.every((call) => call.name === first.name && call.inputKey === first.inputKey)) {
      found.push({
        kind: "repeat-loop",
        severity: "caution",
        tool: first.name,
        repeats: threshold,
        key: `repeat:${first.name}:${first.inputKey.slice(0, 64)}`
      });
    }
  }
  if (calls.length >= threshold) {
    const tail = calls.slice(-threshold);
    const first = tail[0];
    if (first !== undefined && !exempt(first.name) && first.inputKey.length > 0 && tail.every((call) => call.name === first.name && call.status === "error" && call.inputKey === first.inputKey)) {
      found.push({
        kind: "failure-loop",
        severity: "caution",
        tool: first.name,
        repeats: threshold,
        key: `failing:${first.name}:${first.inputKey.slice(0, 64)}`
      });
    }
  }
  const hasLiveWork = calls.some((call) => !SETTLED_TOOL.has(call.status)) || shells.some((raw) => asRecord(raw)?.["status"] === "running");
  if (sessionRunning && !hasLiveWork) {
    const settledAt = newestActivity(calls) ?? input.lastMessageAt;
    if (settledAt !== undefined) {
      const elapsedMs = now - settledAt;
      if (elapsedMs >= thresholds.turnWatchMs) {
        found.push({
          kind: "silent-turn",
          severity: severityFor(elapsedMs, thresholds.turnCautionMs),
          elapsedMs,
          key: "silent-turn"
        });
      }
    }
  }
  return found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.kind.length - a.kind.length || a.key.localeCompare(b.key));
}
function worstCaution(cautions) {
  return [...cautions].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0];
}
var WATCH_GLYPH = "\u25B2";
var CAUTION_GLYPH = "\u25CF";
var CLEAR_GLYPH = "\u25CB";
function glyphFor(caution, glyphs = {}) {
  if (caution === undefined)
    return glyphs.clear ?? CLEAR_GLYPH;
  return caution.severity === "caution" ? glyphs.caution ?? CAUTION_GLYPH : glyphs.watch ?? WATCH_GLYPH;
}
function cautionBody(caution) {
  const elapsed = caution.elapsedMs === undefined ? "" : ` ${formatElapsed(caution.elapsedMs)}`;
  switch (caution.kind) {
    case "hung-tool": {
      const phase = caution.status === "streaming" ? "streaming" : "running";
      return `${caution.tool ?? "tool"} ${phase}${elapsed}`;
    }
    case "hung-shell":
      return `${caution.tool ?? "shell"} running${elapsed}`;
    case "repeat-loop":
      return `${caution.tool ?? "tool"} \xD7${caution.repeats ?? 0} identical`;
    case "failure-loop":
      return `${caution.tool ?? "tool"} failing \xD7${caution.repeats ?? 0}`;
    case "silent-turn":
      return `no progress${elapsed}`;
    default:
      return "unknown";
  }
}
function cautionMark(caution, glyphs = {}) {
  const glyph = glyphFor(caution, glyphs);
  return {
    glyph,
    tone: caution.severity === "caution" ? "error" : "warning",
    text: `${glyph} ${cautionBody(caution)}`
  };
}
function cautionDetail(caution) {
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
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0)
    return `${hours}h${String(minutes).padStart(2, "0")}m${ss}s`;
  return minutes > 0 ? `${minutes}m${ss}s` : `${seconds}s`;
}

// src/tui/host-clipboard.ts
import { createHostClipboard as createCoreHostClipboard } from "@opentui/core";
var cached;
var attempted = false;
function createHostClipboard() {
  if (attempted)
    return cached;
  attempted = true;
  try {
    cached = createCoreHostClipboard();
  } catch {
    cached = undefined;
  }
  return cached;
}

// src/tui/clipboard.ts
function dispatchOsc52(renderer, text) {
  if (renderer === undefined || renderer === null)
    return false;
  try {
    const boundary = renderer;
    if (boundary.capabilities?.osc52_support === "unsupported")
      return false;
    if (typeof boundary.copyToClipboardOSC52 !== "function")
      return false;
    return boundary.copyToClipboardOSC52.call(renderer, text) === true;
  } catch {
    return false;
  }
}
var READ_BACK_ATTEMPTS = 5;
var READ_BACK_INTERVAL_MS = 60;
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function readBackMatches(host, text) {
  const read = host?.read;
  if (host === undefined || read === undefined)
    return false;
  for (let attempt = 0;attempt < READ_BACK_ATTEMPTS; attempt += 1) {
    if (attempt > 0)
      await delay(READ_BACK_INTERVAL_MS);
    let current;
    try {
      current = await read.call(host, { preferredTypes: ["text/plain"], selection: "clipboard" });
    } catch {
      return false;
    }
    if (current.status !== "read")
      continue;
    const bytes = current.representation?.bytes;
    if (bytes === undefined)
      continue;
    let decoded;
    try {
      decoded = new TextDecoder().decode(bytes);
    } catch {
      return false;
    }
    if (decoded === text)
      return true;
  }
  return false;
}
async function copyToClipboard(renderer, text, createHost = createHostClipboard) {
  let hostReached = true;
  let hostStatus = "failed";
  let host;
  try {
    host = createHost();
  } catch {
    host = undefined;
  }
  if (host === undefined) {
    hostReached = false;
  } else {
    try {
      const result = await host.writeText(text);
      hostStatus = result.status;
    } catch {
      hostStatus = "failed";
    }
  }
  if (hostStatus === "written")
    return { verified: true, outcome: "written" };
  if (dispatchOsc52(renderer, text)) {
    if (await readBackMatches(host, text))
      return { verified: true, outcome: "osc52-confirmed" };
    return { verified: false, outcome: "osc52-dispatched" };
  }
  if (!hostReached)
    return { verified: false, outcome: "no-backend" };
  const outcome = hostStatus === "unsupported" || hostStatus === "cancelled" || hostStatus === "timed-out" || hostStatus === "failed" ? hostStatus : "failed";
  return { verified: false, outcome };
}
function copyFeedback(result, id) {
  if (result.verified) {
    return { ok: true, variant: "success", message: `Copied the full session id ${id} to the clipboard.` };
  }
  switch (result.outcome) {
    case "osc52-dispatched":
      return {
        ok: false,
        variant: "warning",
        message: "Sent the session id to the terminal; the terminal does not confirm copies, so paste to verify."
      };
    case "unsupported":
      return { ok: false, variant: "error", message: "This terminal cannot copy to the clipboard." };
    case "cancelled":
      return { ok: false, variant: "error", message: "The clipboard copy was cancelled." };
    case "timed-out":
      return { ok: false, variant: "error", message: "The clipboard copy timed out." };
    case "failed":
      return { ok: false, variant: "error", message: "Could not copy the session id to the clipboard." };
    case "no-backend":
    default:
      return { ok: false, variant: "error", message: "No clipboard is available to copy the session id." };
  }
}

// src/tui/format.ts
function formatCount(value) {
  if (value < 1000)
    return String(Math.round(value));
  const thousands = Math.round(value / 1000);
  if (thousands < 1000)
    return `${thousands}k`;
  const millions = (value / 1e6).toFixed(1);
  return `${millions.endsWith(".0") ? millions.slice(0, -2) : millions}M`;
}
function formatCost(value) {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}
function formatDuration(ms, style = "compact") {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const ss = String(seconds).padStart(2, "0");
  const join = style === "spaced" ? " " : "";
  if (hours > 0)
    return `${hours}h${join}${String(minutes).padStart(2, "0")}m${join}${ss}s`;
  return minutes > 0 ? `${minutes}m${join}${ss}s` : `${seconds}s`;
}
var DEFAULT_BAR_WIDTH = 10;
function fuelBar(ratio, width = DEFAULT_BAR_WIDTH) {
  const cells = Math.max(1, Math.floor(width));
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
  return `${"\u2588".repeat(filled)}${"\u2591".repeat(cells - filled)}`;
}
var SPARK_LEVELS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
function cellWidthOf(code) {
  if (code >= 4352 && code <= 4447 || code === 9001 || code === 9002 || code >= 11904 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65040 && code <= 65049 || code >= 65072 && code <= 65103 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 262141 || code >= 9728 && code <= 10175 || code >= 11008 && code <= 11263 || code >= 126976 && code <= 129791) {
    return 2;
  }
  return 1;
}
function cellWidth(text) {
  let width = 0;
  for (const char of text)
    width += cellWidthOf(char.codePointAt(0) ?? 0);
  return width;
}
function clip(text, max) {
  const ellipsis = String.fromCharCode(8230);
  if (cellWidth(text) <= max)
    return text;
  const budget = max - 1;
  let kept = "";
  let width = 0;
  for (const char of text) {
    const next = width + cellWidthOf(char.codePointAt(0) ?? 0);
    if (kept !== "" && next > budget)
      break;
    kept += char;
    width = next;
  }
  return `${kept}${ellipsis}`;
}
function sparkline(values) {
  if (values.length === 0)
    return "";
  const max = Math.max(...values);
  if (!Number.isFinite(max) || max <= 0)
    return SPARK_LEVELS[0].repeat(values.length);
  return values.map((value) => {
    const level = Math.floor(Math.max(0, value) / max * (SPARK_LEVELS.length - 1));
    return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, level)];
  }).join("");
}
// src/tui/coerce.ts
function asCount2(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function asText2(value) {
  if (typeof value !== "string")
    return;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

// src/tui/go-usage.ts
var WINDOW_ORDER = ["5h", "1w", "1m"];
function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function firstFinite(...candidates) {
  for (const candidate of candidates) {
    const value = asFiniteNumber(candidate);
    if (value !== undefined)
      return value;
  }
  return;
}
function asInstantMs(value) {
  const numeric = asFiniteNumber(value);
  if (numeric !== undefined)
    return numeric;
  const text = asText2(value);
  if (text === undefined)
    return;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function firstInstant(...candidates) {
  for (const candidate of candidates) {
    const value = asInstantMs(candidate);
    if (value !== undefined)
      return value;
  }
  return;
}
function ratioFromPercent(value) {
  const percent = asFiniteNumber(value);
  if (percent === undefined || percent < 0)
    return;
  return Math.min(1, percent / 100);
}
function windowIdFrom(value) {
  const text = asText2(value);
  if (text === undefined)
    return;
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key.startsWith("rolling") || key === "5h" || key === "5hour" || key === "session")
    return "5h";
  if (key.startsWith("weekly") || key === "1w" || key === "week" || key === "7d")
    return "1w";
  if (key.startsWith("monthly") || key === "1m" || key === "month" || key === "30d")
    return "1m";
  return;
}
function ratioOf(used, limit) {
  if (used === undefined || limit === undefined || limit <= 0)
    return;
  return used / limit;
}
function buildWindow(id, used, limit, resetAtMs, explicitRatio, status) {
  if (id === undefined)
    return;
  const ratio = explicitRatio ?? ratioOf(used, limit);
  if (used === undefined && limit === undefined && ratio === undefined)
    return;
  const result = { id };
  if (used !== undefined)
    result.used = used;
  if (limit !== undefined)
    result.limit = limit;
  if (ratio !== undefined)
    result.ratio = ratio;
  if (resetAtMs !== undefined)
    result.resetAtMs = resetAtMs;
  if (status !== undefined)
    result.status = status;
  return result;
}
function normalizeWindowValue(value, idHint) {
  if (typeof value === "number") {
    return buildWindow(idHint, asFiniteNumber(value), undefined, undefined);
  }
  const record = asRecord2(value);
  if (record === undefined)
    return;
  const id = idHint ?? windowIdFrom(record.window) ?? windowIdFrom(record.id) ?? windowIdFrom(record.name);
  const used = firstFinite(record.usage, record.used, record.value, record.current, record.count);
  const limit = firstFinite(record.limit, record.max, record.total, record.cap, record.quota);
  const resetAtMs = firstInstant(record.resetAtMs, record.resetsAt, record.resetAt);
  const ratio = ratioFromPercent(record.percent);
  const status = asText2(record.status);
  return buildWindow(id, used, limit, resetAtMs, ratio, status);
}
function normalizeFlatWindow(top, id, usedKey, limitKey, prefix) {
  const used = asFiniteNumber(top[usedKey]);
  const limit = asFiniteNumber(top[limitKey]);
  const resetAtMs = firstInstant(top[`${prefix}ResetAtMs`], top[`${prefix}ResetsAt`], top[`${prefix}ResetAt`]);
  return buildWindow(id, used, limit, resetAtMs);
}
function collectKeyed(record, push) {
  for (const [key, value] of Object.entries(record)) {
    const id = windowIdFrom(key);
    if (id === undefined)
      continue;
    push(normalizeWindowValue(value, id));
  }
}
function normalizeGoUsage(raw) {
  try {
    const windows = [];
    const seen = new Set;
    const push = (window) => {
      if (window === undefined || seen.has(window.id))
        return;
      seen.add(window.id);
      windows.push(window);
    };
    if (Array.isArray(raw)) {
      for (const entry of raw)
        push(normalizeWindowValue(entry));
    } else {
      const top = asRecord2(raw);
      if (top === undefined)
        return;
      push(normalizeFlatWindow(top, "5h", "rollingUsage", "rollingLimit", "rolling"));
      push(normalizeFlatWindow(top, "1w", "weeklyUsage", "weeklyLimit", "weekly"));
      push(normalizeFlatWindow(top, "1m", "monthlyUsage", "monthlyLimit", "monthly"));
      const usage = asRecord2(top.usage);
      if (usage !== undefined)
        collectKeyed(usage, push);
      const list = top.windows;
      if (Array.isArray(list)) {
        for (const entry of list)
          push(normalizeWindowValue(entry));
      } else {
        const keyed = asRecord2(list);
        if (keyed !== undefined)
          collectKeyed(keyed, push);
      }
      if (windows.length === 0)
        push(normalizeWindowValue(top));
    }
    if (windows.length === 0)
      return;
    windows.sort((a, b) => WINDOW_ORDER.indexOf(a.id) - WINDOW_ORDER.indexOf(b.id));
    return { windows };
  } catch {
    return;
  }
}
var GO_ERROR_RATIO = 0.9;
var GO_OK_STATUSES = ["ok"];
function goTone(window) {
  if (window.ratio !== undefined && window.ratio >= GO_ERROR_RATIO)
    return "error";
  const status = window.status;
  if (status !== undefined && status !== "" && !GO_OK_STATUSES.includes(status))
    return "error";
  return "normal";
}
function formatRemaining(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60)
    return `${minutes}m`;
  const hours = Math.ceil(ms / 3600000);
  if (hours < 24)
    return `${hours}h`;
  return `${Math.ceil(ms / 86400000)}d`;
}
function goResetSuffix(window, nowMs) {
  if (goTone(window) !== "error")
    return;
  const resetAtMs = window.resetAtMs;
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || !Number.isFinite(nowMs))
    return;
  const remaining = resetAtMs - nowMs;
  if (remaining <= 0)
    return;
  return ` \xB7 ${formatRemaining(remaining)}`;
}

// src/tui/guard-tokens.ts
function asGuardCount(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.floor(value);
  if (Array.isArray(value))
    return value.length;
  return;
}
function guardCountOrZero(...candidates) {
  for (const candidate of candidates) {
    const count = asGuardCount(candidate);
    if (count !== undefined)
      return count;
  }
  return 0;
}
function guardToken(value) {
  try {
    const top = asRecord2(value);
    if (top === undefined)
      return;
    const air = asRecord2(top.airworthiness);
    const war = asRecord2(top.warden);
    const plan = asRecord2(top.flightPlan);
    const airUsable = air !== undefined && (air.available === true || air.available === false);
    const warUsable = war !== undefined && (war.available === true || war.available === false);
    const planUsable = plan !== undefined && (plan.available === true || plan.available === false);
    if (!airUsable && !warUsable && !planUsable)
      return;
    if (airUsable && air.available === false || warUsable && war.available === false || planUsable && plan.available === false) {
      return "unknown";
    }
    const breaches = warUsable ? guardCountOrZero(war.breaches) : 0;
    const orphans = warUsable ? guardCountOrZero(war.orphans) : 0;
    const findings = airUsable ? guardCountOrZero(air.findings, air.counts) : 0;
    if (breaches > 0)
      return `${formatCount(breaches)} breach`;
    if (orphans > 0)
      return `${formatCount(orphans)} orphan`;
    if (findings > 0)
      return `${formatCount(findings)} finding`;
    return "ok";
  } catch {
    return;
  }
}

// src/tui/stat-fields.ts
var STAT_FIELDS = [
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
  "guard",
  "go",
  "ses"
];
var ANIMATED_FIELDS = ["caution", "status", "elapsed", "tps"];
function isStatField(value) {
  return value === "session" || STAT_FIELDS.some((field) => field === value);
}
function canonicalField(name) {
  return name === "session" ? "ses" : name;
}
function fieldLabel(field, labels) {
  const override = labels?.[canonicalField(field)];
  if (override !== undefined)
    return override;
  return field === "ses" ? "session" : field;
}
var DEFAULT_PLACEHOLDER = "\u2014";
var DEFAULT_LABEL_WIDTH = 10;
var DEFAULT_SPARK_WIDTH = 12;
function skeletonValue(field, layout) {
  switch (canonicalField(field)) {
    case "cost":
    case "total":
    case "project":
      return formatCost(0);
    case "tokens":
      return "0 in \xB7 0 out";
    case "cache":
      return "0 read";
    case "context":
      return `${fuelBar(0, layout.barWidth ?? DEFAULT_BAR_WIDTH)} ~0%`;
    case "perms":
      return "0 waiting";
    case "elapsed":
      return formatDuration(0, layout.durationStyle);
    case "tps":
      return layout.tpsDisplay === "both" ? "0 rt \xB7 0 avg" : "0 tok/s";
    case "spark":
      return "\u2581".repeat(Math.max(0, Math.floor(layout.sparkWidth ?? DEFAULT_SPARK_WIDTH)));
    case "reasoning":
      return formatCount(0);
    case "turns":
      return "0";
    case "go":
      return "\u25CB 0 \u25CB 0 \u25CB 0";
    case "status":
      return "\u25CB idle";
    case "agent":
    case "model":
    case "ses":
      return "none";
    case "branch":
      return "no branch";
    case "guard":
      return "unknown";
    default:
      return;
  }
}

// src/tui/rows.ts
var SPINNER = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var SES_PREVIEW_WIDTH = 18;
var CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
function plain(value) {
  return value.replace(CONTROL_CHARS, " ");
}
function formatRow(label, value, labelWidth) {
  return `${labelPrefix(label, labelWidth)}${plain(value)}`;
}
function labelPrefix(label, labelWidth) {
  return `${label.padEnd(labelWidth)}${label.length >= labelWidth ? " " : ""}`;
}
var GO_ORDER = ["5h", "1w", "1m"];
var DIAL_STEPS = [
  [13, "\u25CB"],
  [38, "\u25D4"],
  [63, "\u25D1"],
  [88, "\u25D5"],
  [101, "\u25CF"]
];
function dialGlyph(percent) {
  for (const [limit, glyph] of DIAL_STEPS) {
    if (percent < limit)
      return glyph;
  }
  return "\u25CF";
}
function asGoWindows(value) {
  const list = asRecord2(value)?.windows;
  if (!Array.isArray(list))
    return [];
  const windows = [];
  for (const entry of list) {
    const window = asRecord2(entry);
    if (window === undefined)
      continue;
    const id = asText2(window["id"]);
    if (id !== "5h" && id !== "1w" && id !== "1m")
      continue;
    const ratio = asCount2(window["ratio"]);
    if (ratio === undefined)
      continue;
    const result = { id, ratio: Math.min(1, ratio) };
    const resetAtMs = asCount2(window["resetAtMs"]);
    if (resetAtMs !== undefined)
      result.resetAtMs = resetAtMs;
    const status = asText2(window["status"]);
    if (status !== undefined)
      result.status = status;
    windows.push(result);
  }
  windows.sort((a, b) => GO_ORDER.indexOf(a.id) - GO_ORDER.indexOf(b.id));
  return windows;
}
function goValueSegments(source, layout) {
  const windows = asGoWindows(source.go);
  if (windows.length === 0)
    return;
  const nowMs = layout.nowMs ?? Date.now();
  let flagged = -1;
  let flaggedRatio = Number.NEGATIVE_INFINITY;
  for (const [index, window] of windows.entries()) {
    if (goTone(window) !== "error")
      continue;
    const ratio = window.ratio ?? 0;
    if (flagged < 0 || ratio > flaggedRatio) {
      flagged = index;
      flaggedRatio = ratio;
    }
  }
  const chunks = [];
  for (const [index, window] of windows.entries()) {
    const percent = Math.round((window.ratio ?? 0) * 100);
    const tone = goTone(window) === "error" ? "error" : undefined;
    const chunk = [{ text: `${dialGlyph(percent)} ${percent}`, tone }];
    const suffix = index === flagged ? goResetSuffix(window, nowMs) : undefined;
    if (suffix !== undefined)
      chunk.push({ text: suffix, tone });
    chunks.push(chunk);
  }
  const segments = [];
  chunks.forEach((chunk, index) => {
    if (index > 0)
      segments.push({ text: " " });
    segments.push(...chunk);
  });
  return segments;
}
function asCautionMark(value) {
  const record = asRecord2(value);
  if (record === undefined)
    return;
  const glyph = asText2(record["glyph"]);
  const text = asText2(record["text"]);
  const tone = record["tone"];
  if (glyph === undefined || text === undefined)
    return;
  if (tone !== "warning" && tone !== "error")
    return;
  return { glyph, tone, text };
}
function cautionValueSegments(source) {
  const mark = asCautionMark(source.caution);
  if (mark !== undefined) {
    const text = plain(mark.text);
    return [
      { text: text.slice(0, mark.glyph.length), tone: mark.tone },
      { text: text.slice(mark.glyph.length) }
    ];
  }
  const text = asText2(source.caution);
  return text === undefined ? undefined : [{ text: plain(text) }];
}
function statLine(field, source, layout = {}) {
  const labelWidth = layout.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const barWidth = layout.barWidth ?? DEFAULT_BAR_WIDTH;
  const sparkWidth = layout.sparkWidth ?? DEFAULT_SPARK_WIDTH;
  const row = (label, value) => formatRow(fieldLabel(label, layout.labels), value, labelWidth);
  switch (canonicalField(field)) {
    case "caution": {
      const value = cautionValueSegments(source);
      return value === undefined ? undefined : row("caution", value.map((segment) => segment.text).join(""));
    }
    case "status": {
      const status = asText2(source.status);
      if (status === undefined && source.busy === undefined)
        return;
      if (source.busy !== true && status !== "running")
        return row("status", "\u25CB idle");
      const frame = Math.floor(asCount2(source.frame) ?? 0);
      return row("status", `${SPINNER[frame % SPINNER.length]} running`);
    }
    case "agent": {
      const agent = asText2(source.agent);
      return agent === undefined ? undefined : row("agent", agent);
    }
    case "model": {
      const model = asRecord2(source.model);
      const id = asText2(model?.id);
      if (id === undefined)
        return;
      const variant = asText2(model?.variant);
      return row("model", variant === undefined ? id : `${id} \xB7 ${variant}`);
    }
    case "branch": {
      const branch = asText2(source.branch);
      return branch === undefined ? undefined : row("branch", branch);
    }
    case "cost": {
      const cost = asCount2(source.cost);
      const tree = asRecord2(source.tree);
      const treeCost = asCount2(tree?.cost);
      const count = asCount2(tree?.count);
      const family = count !== undefined && count > 0 ? count : 0;
      const merge = layout.hasTotalRow !== true && cost !== undefined && treeCost !== undefined && family > 0 && treeCost > cost;
      if (!merge) {
        const value = layout.hasTotalRow === true ? cost ?? treeCost : treeCost ?? cost;
        return value === undefined ? undefined : row("cost", formatCost(value));
      }
      const plural = family === 1 ? "subagent" : "subagents";
      return row("cost", `${formatCost(treeCost)} \xB7 ${family} ${plural}`);
    }
    case "total": {
      const tree = asRecord2(source.tree);
      if (tree === undefined)
        return;
      const cost = asCount2(tree.cost);
      if (cost === undefined)
        return;
      const count = asCount2(tree.count) ?? 0;
      const plural = count === 1 ? "subagent" : "subagents";
      return row("total", `${formatCost(cost)} \xB7 ${count} ${plural}`);
    }
    case "project": {
      const project = asRecord2(source.project);
      const cost = asCount2(project?.cost);
      if (cost === undefined)
        return;
      const count = asCount2(project?.count);
      return row("project", `${formatCost(cost)}${count !== undefined && count > 1 ? ` \xB7 ${count} sessions` : ""}`);
    }
    case "tokens": {
      const tokens = asRecord2(source.tokens);
      const input = asCount2(tokens?.input);
      const output = asCount2(tokens?.output);
      if (input === undefined && output === undefined)
        return;
      return row("tokens", `${formatCount(input ?? 0)} in \xB7 ${formatCount(output ?? 0)} out`);
    }
    case "cache": {
      const tokens = asRecord2(source.tokens);
      if (tokens === undefined)
        return;
      const cache = asRecord2(tokens.cache);
      const read = asCount2(cache?.read);
      if (read === undefined)
        return;
      const input = asCount2(tokens?.input);
      const total = input === undefined ? undefined : read + input;
      if (read === 0) {
        return total === undefined || total === 0 ? row("cache", `0 read`) : row("cache", `0% hit \xB7 0 read`);
      }
      const value = total === undefined || total === 0 ? `${formatCount(read)} read` : `${Math.round(read / total * 100)}% hit \xB7 ${formatCount(read)} read`;
      return row("cache", value);
    }
    case "context": {
      const context = asRecord2(source.context);
      const used = asCount2(context?.used);
      if (used === undefined || used === 0)
        return;
      const limit = asCount2(context?.limit);
      if (limit === undefined || limit === 0)
        return row("context", `~${formatCount(used)} used`);
      const ratio = used / limit;
      return row("context", `${fuelBar(ratio, barWidth)} ~${Math.round(Math.min(1, ratio) * 100)}%`);
    }
    case "perms": {
      const perms = asRecord2(source.perms);
      const count = asCount2(perms?.["count"]);
      if (count === undefined || count === 0)
        return;
      const action = asText2(perms?.["action"]);
      const resource = asText2(perms?.["resource"]);
      if (count > 1) {
        return row("perms", action === undefined ? `${count} waiting` : `${count} waiting \xB7 ${action}`);
      }
      if (action === undefined)
        return row("perms", "1 waiting");
      return row("perms", resource === undefined ? action : `${action} \xB7 ${clip(resource, 18)}`);
    }
    case "elapsed": {
      const ms = asCount2(source.elapsedMs);
      if (ms === undefined || ms <= 0)
        return;
      return row("elapsed", formatDuration(ms, layout.durationStyle));
    }
    case "tps": {
      const pair = asRecord2(source.tps);
      const rt = asCount2(pair?.["rt"]);
      const avg = asCount2(pair?.["avg"]);
      const ttft = asCount2(pair?.["ttft"]);
      const display = layout.tpsDisplay ?? "avg";
      if (display === "rt") {
        const rounded = rt === undefined ? undefined : Math.round(rt);
        if (rounded === undefined || rounded <= 0)
          return;
        return row("tps", `${rounded} tok/s`);
      }
      if (display === "both") {
        if (avg !== undefined) {
          if (Math.round(avg) <= 0)
            return;
          const head = `${rt === undefined ? 0 : Math.round(rt)} rt \xB7 ${Math.round(avg)} avg`;
          return ttft === undefined ? row("tps", head) : row("tps", `${head} \xB7 ${ttft.toFixed(1)}s ttft`);
        }
        if (rt !== undefined && Math.round(rt) > 0)
          return row("tps", `${Math.round(rt)} rt`);
        return;
      }
      if (avg === undefined || Math.round(avg) <= 0)
        return;
      return row("tps", `${Math.round(avg)} tok/s`);
    }
    case "spark": {
      const values = Array.isArray(source.spark) ? source.spark.map((value) => asCount2(value) ?? 0) : [];
      const windowed = values.slice(-Math.max(2, Math.floor(sparkWidth)));
      if (windowed.length < 2)
        return;
      return row("spark", sparkline(windowed));
    }
    case "reasoning": {
      const reasoning = asCount2(asRecord2(source.tokens)?.reasoning);
      if (reasoning === undefined || reasoning === 0)
        return;
      return row("reasoning", formatCount(reasoning));
    }
    case "turns": {
      const turns = asCount2(source.turns);
      if (turns === undefined || turns === 0)
        return;
      return row("turns", String(turns));
    }
    case "guard": {
      const token = guardToken(source.guard);
      return token === undefined ? undefined : row("guard", token);
    }
    case "ses": {
      const id = asText2(source.sessionId);
      const budget = Math.max(8, SES_PREVIEW_WIDTH - Math.max(0, labelPrefix(fieldLabel("ses", layout.labels), labelWidth).length - labelPrefix("ses", labelWidth).length));
      return id === undefined ? undefined : row("ses", clip(id, budget));
    }
    case "go": {
      const value = goValueSegments(source, layout);
      return value === undefined ? undefined : row("go", value.map((segment) => segment.text).join(""));
    }
    default:
      return;
  }
}
function statSegments(field, source, layout = {}) {
  const name = canonicalField(field);
  if (name === "caution") {
    const value = cautionValueSegments(source);
    if (value === undefined)
      return;
    return [
      { text: labelPrefix(fieldLabel("caution", layout.labels), layout.labelWidth ?? DEFAULT_LABEL_WIDTH) },
      ...value
    ];
  }
  if (name !== "go")
    return;
  const value = goValueSegments(source, layout);
  if (value === undefined)
    return;
  return [{ text: labelPrefix(fieldLabel("go", layout.labels), layout.labelWidth ?? DEFAULT_LABEL_WIDTH) }, ...value];
}
function statRows(fields, source, layout = {}) {
  const hint = { ...layout, hasTotalRow: fields.includes("total") };
  const persist = hint.persist === true;
  const placeholder = hint.placeholder ?? DEFAULT_PLACEHOLDER;
  const labelWidth = hint.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const rows = [];
  for (const field of fields) {
    const name = canonicalField(field);
    const line = statLine(name, source, hint);
    if (line !== undefined) {
      rows.push(line);
      continue;
    }
    if (!persist || !isStatField(name) || name === "caution")
      continue;
    rows.push(formatRow(fieldLabel(name, hint.labels), skeletonValue(name, hint) ?? placeholder, labelWidth));
  }
  return rows;
}
// src/tui/throughput.ts
function turnSpan(created, completed, streamed, nowMs) {
  const start = asCount2(created);
  if (start === undefined)
    return;
  const ended = asCount2(streamed) ?? asCount2(completed) ?? asCount2(nowMs);
  if (ended === undefined)
    return;
  return { start, end: Math.max(start, ended) };
}
function turnKey(id, created, completed, output, streamed) {
  const own = asText2(id);
  if (own !== undefined)
    return `id:${own}`;
  const stamp = `t:${asCount2(created) ?? "?"}:${asCount2(completed) ?? "?"}`;
  if (asCount2(completed) === undefined && asCount2(streamed) === undefined)
    return stamp;
  return `${stamp}:${asCount2(output) ?? "?"}`;
}
function mergedSpanMs(accepted) {
  accepted.sort((a, b) => a.start - b.start || a.end - b.end);
  const first = accepted[0];
  if (first === undefined)
    return 0;
  let unionMs = 0;
  let openStart = first.start;
  let openEnd = first.end;
  for (let index = 1;index < accepted.length; index += 1) {
    const next = accepted[index];
    if (next === undefined)
      continue;
    if (next.start <= openEnd) {
      if (next.end > openEnd)
        openEnd = next.end;
    } else {
      unionMs += openEnd - openStart;
      openStart = next.start;
      openEnd = next.end;
    }
  }
  unionMs += openEnd - openStart;
  return unionMs;
}
function unionSpanTotals(spans) {
  const seen = new Set;
  const accepted = [];
  let tokens = 0;
  for (const span of spans) {
    const key = asText2(span.key);
    if (key === undefined || seen.has(key))
      continue;
    const start = asCount2(span.start);
    const end = asCount2(span.end);
    if (start === undefined || end === undefined)
      continue;
    const output = asCount2(span.tokens);
    const reasoning = asCount2(span.reasoning);
    seen.add(key);
    accepted.push({ start, end: Math.max(start, end) });
    tokens += (output ?? 0) + (reasoning ?? 0);
  }
  return { tokens, unionMs: mergedSpanMs(accepted) };
}
function unionSpanMs(spans) {
  const seen = new Set;
  const accepted = [];
  for (const span of spans) {
    const key = asText2(span.key);
    if (key === undefined || seen.has(key))
      continue;
    const start = asCount2(span.start);
    const end = asCount2(span.end);
    if (start === undefined || end === undefined)
      continue;
    seen.add(key);
    accepted.push({ start, end: Math.max(start, end) });
  }
  return mergedSpanMs(accepted);
}
var TPS_EWMA_ALPHA = 0.3;
var TPS_REPAINT_ABS = 1;
var TPS_REPAINT_RATIO = 0.1;
function smoothTpsRate(previous, sample, alpha = TPS_EWMA_ALPHA) {
  if (previous === undefined || !Number.isFinite(previous))
    return sample;
  if (!Number.isFinite(sample))
    return previous;
  return previous + alpha * (sample - previous);
}
function tpsNeedsRepaint(displayed, smoothed) {
  if (displayed === undefined || !Number.isFinite(displayed))
    return true;
  if (!Number.isFinite(smoothed))
    return false;
  if (Math.abs(smoothed - displayed) >= TPS_REPAINT_ABS)
    return true;
  if (displayed === 0)
    return smoothed !== 0;
  return Math.abs(smoothed - displayed) / Math.abs(displayed) >= TPS_REPAINT_RATIO;
}
function settledAverageRate(spans) {
  const { tokens, unionMs } = unionSpanTotals(spans);
  if (unionMs <= 0)
    return;
  return tokens / (unionMs / 1000);
}
// src/tui/realtime-tps.ts
var RT_SAMPLE_WINDOW_MS = 5000;
var RT_STALE_MS = 1500;
var RT_MAX_SESSIONS = 50;
function estimateDeltaTokens(delta) {
  const bytes = Buffer.byteLength(delta, "utf8");
  return bytes > 0 ? Math.max(1, Math.ceil(bytes / 5)) : 0;
}
function createRealtimeTps(context, opts) {
  const now = opts?.now ?? Date.now;
  const samples = new Map;
  const shown = new Map;
  const pendingStarts = new Map;
  const ttftTotals = new Map;
  let disposed = false;
  let active = false;
  const releases = [];
  const remember = (sessionID, sample) => {
    const known = samples.get(sessionID);
    if (known !== undefined) {
      samples.delete(sessionID);
      known.push(sample);
      samples.set(sessionID, known);
      return;
    }
    if (samples.size >= RT_MAX_SESSIONS) {
      for (const oldest of samples.keys()) {
        samples.delete(oldest);
        break;
      }
    }
    samples.set(sessionID, [sample]);
  };
  const readDelta = (event) => {
    const record = asRecord2(event);
    const data = asRecord2(record?.["data"]);
    const sessionID = asText2(data?.["sessionID"]);
    const raw = data?.["delta"];
    const delta = typeof raw === "string" ? raw : undefined;
    if (sessionID === undefined || delta === undefined)
      return;
    const at = asCount2(record?.["created"]) ?? now();
    return { sessionID, delta, at };
  };
  const ingest = (event) => {
    if (disposed)
      return;
    const reading = readDelta(event);
    if (reading === undefined)
      return;
    remember(reading.sessionID, { at: reading.at, tokens: estimateDeltaTokens(reading.delta) });
    measureFirstToken(event, reading.at);
  };
  const measureFirstToken = (event, at) => {
    const messageID = asText2(asRecord2(asRecord2(event)?.["data"])?.["assistantMessageID"]);
    if (messageID === undefined)
      return;
    const pending = pendingStarts.get(messageID);
    if (pending === undefined)
      return;
    const step = Math.max(0, at - pending.started);
    const prev = pending.best;
    if (prev !== undefined && step >= prev)
      return;
    const adjust = prev === undefined ? step : step - prev;
    pending.best = step;
    const total = ttftTotals.get(pending.sessionID);
    if (total !== undefined) {
      ttftTotals.delete(pending.sessionID);
      ttftTotals.set(pending.sessionID, {
        totalMs: total.totalMs + adjust,
        count: total.count + (prev === undefined ? 1 : 0)
      });
      return;
    }
    if (ttftTotals.size >= RT_MAX_SESSIONS) {
      for (const oldest of ttftTotals.keys()) {
        ttftTotals.delete(oldest);
        break;
      }
    }
    ttftTotals.set(pending.sessionID, { totalMs: step, count: 1 });
  };
  const stepStarted = (event) => {
    if (disposed)
      return;
    const data = asRecord2(asRecord2(event)?.["data"]);
    const sessionID = asText2(data?.["sessionID"]);
    const messageID = asText2(data?.["assistantMessageID"]);
    const started = asCount2(data?.["started"]);
    if (sessionID === undefined || messageID === undefined || started === undefined)
      return;
    pendingStarts.delete(messageID);
    if (pendingStarts.size >= RT_MAX_SESSIONS) {
      for (const oldest of pendingStarts.keys()) {
        pendingStarts.delete(oldest);
        break;
      }
    }
    pendingStarts.set(messageID, { sessionID, started, best: undefined });
  };
  const stepSettled = (event) => {
    if (disposed)
      return;
    const messageID = asText2(asRecord2(asRecord2(event)?.["data"])?.["assistantMessageID"]);
    if (messageID === undefined)
      return;
    pendingStarts.delete(messageID);
  };
  try {
    const on = context.data?.on;
    if (typeof on === "function") {
      const subscribe = on;
      const track = (type, handler) => {
        try {
          releases.push(subscribe(type, handler));
        } catch {}
      };
      track("session.text.delta", ingest);
      track("session.reasoning.delta", ingest);
      track("session.step.started", stepStarted);
      track("session.step.ended", stepSettled);
      track("session.step.failed", stepSettled);
      active = releases.length > 0;
    }
  } catch {
    active = false;
  }
  const coverageMs = (ordered, at) => {
    const first = ordered[0];
    if (first === undefined)
      return 0;
    if (ordered.length === 1) {
      return Math.min(Math.max(at - first.at, 250), 1000);
    }
    let duration = 0;
    for (let index = 1;index < ordered.length; index += 1) {
      duration += Math.max(0, (ordered[index]?.at ?? 0) - (ordered[index - 1]?.at ?? 0));
    }
    duration += Math.max(0, at - (ordered[ordered.length - 1]?.at ?? at));
    return duration;
  };
  const shownOf = (displayedSessionID) => {
    const known = shown.get(displayedSessionID);
    if (known !== undefined) {
      shown.delete(displayedSessionID);
      shown.set(displayedSessionID, known);
      return known;
    }
    const fresh = { smoothed: undefined, displayed: undefined };
    if (shown.size >= RT_MAX_SESSIONS) {
      for (const oldest of shown.keys()) {
        shown.delete(oldest);
        break;
      }
    }
    shown.set(displayedSessionID, fresh);
    return fresh;
  };
  const rate = (displayedSessionID, ids) => {
    if (!active || disposed)
      return 0;
    const at = now();
    const seen = new Set;
    const windowed = [];
    let newest = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id))
        continue;
      seen.add(id);
      const ring = samples.get(id);
      if (ring === undefined)
        continue;
      const kept = ring.filter((sample) => at - sample.at <= RT_SAMPLE_WINDOW_MS);
      if (kept.length !== ring.length) {
        if (kept.length === 0)
          samples.delete(id);
        else
          samples.set(id, kept);
      }
      let idNewest = Number.NEGATIVE_INFINITY;
      for (const sample of kept) {
        if (sample.at > idNewest)
          idNewest = sample.at;
      }
      if (kept.length === 0 || at - idNewest > RT_STALE_MS)
        continue;
      for (const sample of kept) {
        windowed.push(sample);
        if (sample.at > newest)
          newest = sample.at;
      }
    }
    if (windowed.length === 0 || at - newest > RT_STALE_MS)
      return 0;
    windowed.sort((a, b) => a.at - b.at);
    const durationMs = coverageMs(windowed, at);
    if (!(durationMs > 0))
      return 0;
    const tokens = windowed.reduce((sum, sample) => sum + sample.tokens, 0);
    const instant = tokens / (durationMs / 1000);
    if (!Number.isFinite(instant) || instant <= 0)
      return 0;
    const state = shownOf(displayedSessionID);
    state.smoothed = smoothTpsRate(state.smoothed, instant, TPS_EWMA_ALPHA);
    if (tpsNeedsRepaint(state.displayed, state.smoothed))
      state.displayed = state.smoothed;
    return state.displayed ?? 0;
  };
  const ttft = (ids) => {
    if (!active || disposed)
      return;
    const seen = new Set;
    let totalMs = 0;
    let count = 0;
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id))
        continue;
      seen.add(id);
      const total = ttftTotals.get(id);
      if (total === undefined)
        continue;
      totalMs += total.totalMs;
      count += total.count;
    }
    if (count === 0)
      return;
    return totalMs / count / 1000;
  };
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    for (const release of releases) {
      try {
        release();
      } catch {}
    }
    releases.length = 0;
    samples.clear();
    shown.clear();
    pendingStarts.clear();
    ttftTotals.clear();
  };
  return { get active() {
    return active && !disposed;
  }, rate, ttft, dispose };
}
// src/tui/style.ts
var TextAttributes = {
  NONE: 0,
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  HIDDEN: 64,
  STRIKETHROUGH: 128
};
var STYLE_COLORS = ["default", "subdued", "warning", "error", "success", "info"];
var STYLE_ATTRIBUTES = [
  "bold",
  "dim",
  "italic",
  "underline",
  "blink",
  "inverse",
  "hidden",
  "strikethrough"
];
var DEFAULT_STYLE = {
  lines: { color: "default", attributes: [] },
  rows: { wildcard: { color: "subdued", attributes: [] }, overrides: {} }
};
function rowStyle(style, field) {
  return style.rows.overrides[field] ?? style.rows.wildcard;
}
function themeColor(color, theme) {
  const text = theme.text;
  if (text === undefined)
    return;
  switch (color) {
    case "default":
      return text.default ?? text.base;
    case "subdued":
      return text.subdued ?? text.muted;
    default: {
      const feedback = text.feedback?.[color];
      return feedback?.default ?? feedback?.base;
    }
  }
}
var ATTRIBUTE_BITS = {
  bold: TextAttributes.BOLD,
  dim: TextAttributes.DIM,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  blink: TextAttributes.BLINK,
  inverse: TextAttributes.INVERSE,
  hidden: TextAttributes.HIDDEN,
  strikethrough: TextAttributes.STRIKETHROUGH
};
function attributeMask(attributes) {
  let mask = 0;
  for (const attribute of attributes)
    mask |= ATTRIBUTE_BITS[attribute];
  return mask === 0 ? undefined : mask;
}

// src/tui/config.ts
var DEFAULT_GO_PANEL_LOOK = {
  header: false,
  barWidth: 10,
  labelWidth: 6,
  percent: true,
  reset: true,
  align: "right",
  sweep: false,
  labels: { rolling: "rolling", weekly: "weekly", monthly: "monthly" },
  blink: true,
  blinkMs: 700
};
var DEFAULT_TPS_SCOPE = "family";
var DEFAULT_TPS_DISPLAY = "avg";
function cautionThresholds(config) {
  return {
    toolWatchMs: config.toolWatchSeconds * 1000,
    toolCautionMs: config.toolCautionSeconds * 1000,
    turnWatchMs: config.turnWatchSeconds * 1000,
    turnCautionMs: config.turnCautionSeconds * 1000,
    repeatThreshold: config.repeatThreshold,
    exemptTools: config.exemptTools
  };
}
var DEFAULT_LAYOUT = {
  labelWidth: 10,
  barWidth: 10,
  sparkWidth: 12
};
var DEFAULT_FORMAT = { duration: "spaced" };
var DEFAULT_GLYPHS = {
  watch: "\u25B2",
  caution: "\u25CF",
  clear: "\u25CB"
};
var DEFAULT_NOTIFICATIONS = {
  enabled: true,
  config: true,
  copy: true,
  caution: true
};
var DEFAULT_CAUTION = {
  enabled: false,
  toolWatchSeconds: 180,
  toolCautionSeconds: 420,
  turnWatchSeconds: 600,
  turnCautionSeconds: 1200,
  repeatThreshold: 3,
  exemptTools: ["question", "task", "subagent", "agent", "delegate", "delegate_many", "delegate_task", "tools.delegate", "tools.delegate_many", "tools.subagent", "tools.task"],
  toast: false
};
var DEFAULT_SIDEBAR_LINES = [];
var DEFAULT_SIDEBAR_FOOTER_LINES = [];
var DEFAULT_SIDEBAR_ROWS = [
  "status",
  "agent",
  "model",
  "cost",
  "project",
  "tokens",
  "cache",
  "context",
  "perms",
  "elapsed",
  "tps"
];
var MAX_LINES = 24;
var DEFAULT_REFRESH_MS = 100;
var MAX_REFRESH_MS = 60000;
var MIN_REFRESH_MS = 16;
var DEFAULT_FOOTER_TEXT = "Flight Deck";
var DEFAULT_CONFIG = {
  sidebar: {
    enabled: true,
    lines: DEFAULT_SIDEBAR_LINES,
    footer: { lines: DEFAULT_SIDEBAR_FOOTER_LINES, go: false },
    rows: DEFAULT_SIDEBAR_ROWS,
    tps: { scope: DEFAULT_TPS_SCOPE, display: DEFAULT_TPS_DISPLAY },
    persist: true,
    placeholder: DEFAULT_PLACEHOLDER,
    maxLines: MAX_LINES
  },
  footer: { enabled: false, text: DEFAULT_FOOTER_TEXT },
  caution: DEFAULT_CAUTION,
  notifications: DEFAULT_NOTIFICATIONS,
  layout: DEFAULT_LAYOUT,
  format: DEFAULT_FORMAT,
  glyphs: DEFAULT_GLYPHS,
  style: DEFAULT_STYLE,
  refresh: DEFAULT_REFRESH_MS
};
var MAX_LINE_LENGTH = 120;
var CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;
var CONTROL_CHARS2 = /[\u0000-\u001F\u007F-\u009F]/g;
function normalizeText(value, path, issues) {
  if (!CONTROL_CHAR.test(value))
    return value.trim();
  issues.push(`${path} contained control characters; they were replaced with spaces`);
  return value.replace(CONTROL_CHARS2, " ").replace(/ {2,}/g, " ").trim();
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readBoolean(value, fallback, path, issues) {
  if (value === undefined)
    return fallback;
  if (typeof value === "boolean")
    return value;
  issues.push(`${path} must be true or false; using ${fallback}`);
  return fallback;
}
function readText(value, fallback, path, issues) {
  if (value === undefined)
    return fallback;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string; using the default`);
    return fallback;
  }
  const text = normalizeText(value, path, issues);
  if (text.length === 0) {
    issues.push(`${path} must not be empty; using the default`);
    return fallback;
  }
  if (text.length > MAX_LINE_LENGTH) {
    issues.push(`${path} was longer than ${MAX_LINE_LENGTH} characters; it was shortened`);
    return text.slice(0, MAX_LINE_LENGTH);
  }
  return text;
}
function readLineList(value, issues, maxLines, fallback, path) {
  if (value === undefined)
    return fallback;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of strings; using the default lines`);
    return fallback;
  }
  if (value.length === 0)
    return [];
  const lines = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (typeof entry !== "string") {
      issues.push(`${entryPath} must be a string; skipping it`);
      return;
    }
    const text = normalizeText(entry, entryPath, issues);
    if (text.length === 0) {
      issues.push(`${entryPath} is empty; skipping it`);
      return;
    }
    if (text.length > MAX_LINE_LENGTH) {
      issues.push(`${entryPath} was longer than ${MAX_LINE_LENGTH} characters; it was shortened`);
      lines.push(text.slice(0, MAX_LINE_LENGTH));
      return;
    }
    lines.push(text);
  });
  if (lines.length === 0) {
    issues.push(`${path} had no usable entries; using the default lines`);
    return fallback;
  }
  if (lines.length > maxLines) {
    issues.push(`${path} has ${lines.length} entries; keeping the first ${maxLines}`);
    return lines.slice(0, maxLines);
  }
  return lines;
}
function readLines(value, issues, maxLines) {
  return readLineList(value, issues, maxLines, DEFAULT_SIDEBAR_LINES, "sidebar.lines");
}
function readSidebarFooterLines(value, issues) {
  return readLineList(value, issues, MAX_LINES, DEFAULT_SIDEBAR_FOOTER_LINES, "sidebar.footer.lines");
}
var GO_LABEL_MAX_LENGTH = 24;
function readGoLabel(value, fallback, path, issues) {
  if (value === undefined)
    return fallback;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string; using the default`);
    return fallback;
  }
  const text = value.trim();
  if (text.length === 0) {
    issues.push(`${path} must not be empty; using the default`);
    return fallback;
  }
  if (text.length > GO_LABEL_MAX_LENGTH) {
    issues.push(`${path} was longer than ${GO_LABEL_MAX_LENGTH} characters; using the default`);
    return fallback;
  }
  return text;
}
function readGoLabels(value, issues) {
  if (value === undefined)
    return DEFAULT_GO_PANEL_LOOK.labels;
  if (!isRecord(value)) {
    issues.push("sidebar.footer.go.labels must be an object; using the defaults");
    return DEFAULT_GO_PANEL_LOOK.labels;
  }
  return {
    rolling: readGoLabel(value["rolling"], DEFAULT_GO_PANEL_LOOK.labels.rolling, "sidebar.footer.go.labels.rolling", issues),
    weekly: readGoLabel(value["weekly"], DEFAULT_GO_PANEL_LOOK.labels.weekly, "sidebar.footer.go.labels.weekly", issues),
    monthly: readGoLabel(value["monthly"], DEFAULT_GO_PANEL_LOOK.labels.monthly, "sidebar.footer.go.labels.monthly", issues)
  };
}
function readGoAlign(value, issues) {
  if (value === undefined)
    return DEFAULT_GO_PANEL_LOOK.align;
  if (value === "left" || value === "right" || value === "center")
    return value;
  issues.push('sidebar.footer.go.align must be "left", "right" or "center"; using "right"');
  return DEFAULT_GO_PANEL_LOOK.align;
}
function readFooterGo(value, issues) {
  if (value === undefined)
    return DEFAULT_CONFIG.sidebar.footer.go;
  if (typeof value === "boolean")
    return value;
  if (!isRecord(value)) {
    issues.push("sidebar.footer.go must be true, false or an object; using false");
    return false;
  }
  return {
    header: readBoolean(value["header"], DEFAULT_GO_PANEL_LOOK.header, "sidebar.footer.go.header", issues),
    barWidth: readNumber(value["barWidth"], DEFAULT_GO_PANEL_LOOK.barWidth, "sidebar.footer.go.barWidth", issues, 1, 40),
    labelWidth: readNumber(value["labelWidth"], DEFAULT_GO_PANEL_LOOK.labelWidth, "sidebar.footer.go.labelWidth", issues, 5, 24),
    percent: readBoolean(value["percent"], DEFAULT_GO_PANEL_LOOK.percent, "sidebar.footer.go.percent", issues),
    reset: readBoolean(value["reset"], DEFAULT_GO_PANEL_LOOK.reset, "sidebar.footer.go.reset", issues),
    align: readGoAlign(value["align"], issues),
    sweep: readBoolean(value["sweep"], DEFAULT_GO_PANEL_LOOK.sweep, "sidebar.footer.go.sweep", issues),
    labels: readGoLabels(value["labels"], issues),
    blink: readBoolean(value["blink"], DEFAULT_GO_PANEL_LOOK.blink, "sidebar.footer.go.blink", issues),
    blinkMs: readNumber(value["blinkMs"], DEFAULT_GO_PANEL_LOOK.blinkMs, "sidebar.footer.go.blinkMs", issues, 200, 5000)
  };
}
function readRows(value, issues, maxLines) {
  if (value === undefined)
    return DEFAULT_SIDEBAR_ROWS;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push("sidebar.rows must be a non-empty array of field names; using the default rows");
    return DEFAULT_SIDEBAR_ROWS;
  }
  const rows = [];
  value.forEach((entry, index) => {
    const path = `sidebar.rows[${index}]`;
    if (typeof entry !== "string") {
      issues.push(`${path} must be a string; skipping it`);
      return;
    }
    const name = normalizeText(entry, path, issues).toLowerCase();
    if (name.length === 0) {
      issues.push(`${path} is empty; skipping it`);
      return;
    }
    if (!isStatField(name)) {
      issues.push(`${path} is not a known field (${STAT_FIELDS.join(", ")}); skipping it`);
      return;
    }
    rows.push(canonicalField(name));
  });
  if (rows.length === 0) {
    issues.push("sidebar.rows had no usable entries; using the default rows");
    return DEFAULT_SIDEBAR_ROWS;
  }
  return rows.slice(0, maxLines);
}
function readTpsScope(value, issues) {
  if (value === undefined)
    return DEFAULT_TPS_SCOPE;
  if (value === "family" || value === "session")
    return value;
  issues.push(`sidebar.tps.scope must be "family" or "session"; using "${DEFAULT_TPS_SCOPE}"`);
  return DEFAULT_TPS_SCOPE;
}
function readTpsDisplay(value, issues) {
  if (value === undefined)
    return DEFAULT_TPS_DISPLAY;
  if (value === "avg" || value === "rt" || value === "both")
    return value;
  issues.push(`sidebar.tps.display must be "avg", "rt" or "both"; using "avg"`);
  return DEFAULT_TPS_DISPLAY;
}
function readTps(section, issues) {
  const raw = section["tps"];
  if (raw !== undefined && !isRecord(raw)) {
    issues.push("sidebar.tps must be an object; using defaults");
    return { scope: DEFAULT_TPS_SCOPE, display: DEFAULT_TPS_DISPLAY };
  }
  const tps = isRecord(raw) ? raw : {};
  return { scope: readTpsScope(tps["scope"], issues), display: readTpsDisplay(tps["display"], issues) };
}
function readMaxLines(value, issues) {
  return readNumber(value, MAX_LINES, "sidebar.maxLines", issues, 1, MAX_LINES);
}
function sectionOf(options, key) {
  const value = options[key];
  return isRecord(value) ? value : {};
}
function readRefresh(value, issues) {
  if (value === undefined)
    return DEFAULT_REFRESH_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    issues.push("refresh must be a number of milliseconds; using the default");
    return DEFAULT_REFRESH_MS;
  }
  if (value > MAX_REFRESH_MS) {
    issues.push(`refresh was longer than ${MAX_REFRESH_MS}ms; using ${MAX_REFRESH_MS}`);
    return MAX_REFRESH_MS;
  }
  if (value > 0 && value < MIN_REFRESH_MS) {
    issues.push(`refresh was faster than ${MIN_REFRESH_MS}ms; using ${MIN_REFRESH_MS}`);
    return MIN_REFRESH_MS;
  }
  return value;
}
function mergeSection(file, host, key) {
  const fileValue = file[key];
  const hostValue = host[key];
  if (hostValue !== undefined && !isRecord(hostValue))
    return hostValue;
  if (fileValue !== undefined && !isRecord(fileValue) && hostValue === undefined)
    return fileValue;
  const merged = { ...sectionOf(file, key), ...sectionOf(host, key) };
  if (key === "sidebar") {
    const fileSidebar = sectionOf(file, key);
    const hostSidebar = sectionOf(host, key);
    const fileFooter = fileSidebar["footer"];
    const hostFooter = hostSidebar["footer"];
    if (isRecord(fileFooter) && isRecord(hostFooter)) {
      merged["footer"] = { ...fileFooter, ...hostFooter };
    }
    const fileTps = fileSidebar["tps"];
    const hostTps = hostSidebar["tps"];
    if (isRecord(fileTps) && isRecord(hostTps)) {
      merged["tps"] = { ...fileTps, ...hostTps };
    }
  }
  return merged;
}
function mergeOptions(fileOptions, hostOptions) {
  const file = isRecord(fileOptions) ? fileOptions : {};
  const host = isRecord(hostOptions) ? hostOptions : {};
  return {
    ...file,
    ...host,
    sidebar: mergeSection(file, host, "sidebar"),
    footer: mergeSection(file, host, "footer"),
    caution: mergeSection(file, host, "caution"),
    notifications: mergeSection(file, host, "notifications"),
    layout: mergeSection(file, host, "layout"),
    format: mergeSection(file, host, "format"),
    glyphs: mergeSection(file, host, "glyphs"),
    style: mergeSection(file, host, "style")
  };
}
function readNumber(value, fallback, path, issues, min, max = Number.POSITIVE_INFINITY) {
  if (value === undefined)
    return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path} must be a number; using the default`);
    return fallback;
  }
  if (value < min || value > max) {
    const limit = max === Number.POSITIVE_INFINITY ? `at least ${min}` : `between ${min} and ${max}`;
    issues.push(`${path} must be ${limit}; using the default`);
    return fallback;
  }
  return Math.floor(value);
}
function readLabels(value, issues) {
  if (value === undefined)
    return;
  if (!isRecord(value)) {
    issues.push("layout.labels must be an object of row names to labels; using the default labels");
    return;
  }
  const labels = {};
  for (const [rawName, rawLabel] of Object.entries(value)) {
    const path = `layout.labels.${rawName}`;
    const key = normalizeText(rawName, path, issues).trim().toLowerCase();
    if (key.length === 0) {
      issues.push(`${path} is empty; using the default label`);
      continue;
    }
    if (!isStatField(key)) {
      issues.push(`${path} is not a known row (${STAT_FIELDS.join(", ")}); using the default label`);
      continue;
    }
    if (typeof rawLabel !== "string") {
      issues.push(`${path} must be a string; using the default label`);
      continue;
    }
    const label = normalizeText(rawLabel, path, issues).trim();
    if (label.length === 0) {
      issues.push(`${path} must not be empty; using the default label`);
      continue;
    }
    labels[canonicalField(key)] = label;
  }
  return Object.keys(labels).length === 0 ? undefined : labels;
}
function readLayout(section, issues) {
  return {
    labelWidth: readNumber(section["labelWidth"], DEFAULT_LAYOUT.labelWidth, "layout.labelWidth", issues, 6, 24),
    barWidth: readNumber(section["barWidth"], DEFAULT_LAYOUT.barWidth, "layout.barWidth", issues, 1, 40),
    sparkWidth: readNumber(section["sparkWidth"], DEFAULT_LAYOUT.sparkWidth, "layout.sparkWidth", issues, 2, 64),
    labels: readLabels(section["labels"], issues)
  };
}
function readDurationStyle(value, issues) {
  if (value === undefined)
    return DEFAULT_FORMAT.duration;
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "compact" || text === "spaced")
    return text;
  issues.push('format.duration must be "compact" or "spaced"; using the default');
  return DEFAULT_FORMAT.duration;
}
function readFormat(section, issues) {
  return { duration: readDurationStyle(section["duration"], issues) };
}
function readGlyph(value, fallback, path, issues) {
  if (value === undefined)
    return fallback;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string; using the default`);
    return fallback;
  }
  const text = value.trim();
  if (text.length === 0 || [...text].length > 2) {
    issues.push(`${path} must be one or two characters; using the default`);
    return fallback;
  }
  if (CONTROL_CHAR.test(text)) {
    issues.push(`${path} contained control characters; using the default`);
    return fallback;
  }
  return text;
}
function readGlyphs(section, issues) {
  return {
    watch: readGlyph(section["watch"], DEFAULT_GLYPHS.watch, "glyphs.watch", issues),
    caution: readGlyph(section["caution"], DEFAULT_GLYPHS.caution, "glyphs.caution", issues),
    clear: readGlyph(section["clear"], DEFAULT_GLYPHS.clear, "glyphs.clear", issues)
  };
}
function readStyleColor(value, fallback, path, issues) {
  if (value === undefined)
    return fallback;
  const text = typeof value === "string" ? value.trim() : "";
  if (STYLE_COLORS.includes(text))
    return text;
  issues.push(`${path} must be one of ${STYLE_COLORS.join(", ")}; using ${fallback}`);
  return fallback;
}
function readStyleAttributes(value, fallback, path, issues) {
  if (value === undefined)
    return fallback;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of attribute names; using the default`);
    return fallback;
  }
  const attributes = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (typeof entry !== "string") {
      issues.push(`${at} must be a string; skipping it`);
      return;
    }
    const name = entry.trim();
    if (!STYLE_ATTRIBUTES.includes(name)) {
      issues.push(`${at} is not a known attribute (${STYLE_ATTRIBUTES.join(", ")}); skipping it`);
      return;
    }
    attributes.push(name);
  });
  return attributes;
}
function readLineStyle(value, fallback, path, issues) {
  if (value === undefined)
    return fallback;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object with color and attributes; using the default`);
    return fallback;
  }
  return {
    color: readStyleColor(value["color"], fallback.color, `${path}.color`, issues),
    attributes: readStyleAttributes(value["attributes"], fallback.attributes, `${path}.attributes`, issues)
  };
}
function readStyle(section, issues) {
  const rawRows = section["rows"];
  if (rawRows !== undefined && !isRecord(rawRows)) {
    issues.push("style.rows must be an object of row names; using the default");
  }
  const rows = isRecord(rawRows) ? rawRows : {};
  const lines = readLineStyle(section["lines"], DEFAULT_STYLE.lines, "style.lines", issues);
  const wildcard = readLineStyle(rows["*"], DEFAULT_STYLE.rows.wildcard, "style.rows.*", issues);
  const overrides = {};
  for (const [key, entry] of Object.entries(rows)) {
    if (key === "*")
      continue;
    const path = `style.rows.${key}`;
    const name = normalizeText(key, path, issues).toLowerCase();
    if (name.length === 0) {
      issues.push(`${path} is empty; skipping it`);
      continue;
    }
    if (!isStatField(name)) {
      issues.push(`${path} is not a known field (${STAT_FIELDS.join(", ")}); skipping it`);
      continue;
    }
    overrides[canonicalField(name)] = readLineStyle(entry, wildcard, path, issues);
  }
  return { lines, rows: { wildcard, overrides } };
}
function readToolNames(value, issues) {
  if (value === undefined)
    return DEFAULT_CAUTION.exemptTools;
  if (!Array.isArray(value)) {
    issues.push("caution.exemptTools must be an array of tool names; using the default");
    return DEFAULT_CAUTION.exemptTools;
  }
  const names = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push("caution.exemptTools must contain only non-empty tool names; using the default");
      return DEFAULT_CAUTION.exemptTools;
    }
    names.push(entry.trim());
  }
  return names;
}
function readNotifications(section, issues) {
  return {
    enabled: readBoolean(section["enabled"], DEFAULT_NOTIFICATIONS.enabled, "notifications.enabled", issues),
    config: readBoolean(section["config"], DEFAULT_NOTIFICATIONS.config, "notifications.config", issues),
    copy: readBoolean(section["copy"], DEFAULT_NOTIFICATIONS.copy, "notifications.copy", issues),
    caution: readBoolean(section["caution"], DEFAULT_NOTIFICATIONS.caution, "notifications.caution", issues)
  };
}
function readCaution(section, issues) {
  const toolWatchSeconds = readNumber(section["toolWatchSeconds"], DEFAULT_CAUTION.toolWatchSeconds, "caution.toolWatchSeconds", issues, 0);
  const turnWatchSeconds = readNumber(section["turnWatchSeconds"], DEFAULT_CAUTION.turnWatchSeconds, "caution.turnWatchSeconds", issues, 0);
  let toolCautionSeconds = readNumber(section["toolCautionSeconds"], DEFAULT_CAUTION.toolCautionSeconds, "caution.toolCautionSeconds", issues, 0);
  let turnCautionSeconds = readNumber(section["turnCautionSeconds"], DEFAULT_CAUTION.turnCautionSeconds, "caution.turnCautionSeconds", issues, 0);
  if (toolCautionSeconds < toolWatchSeconds) {
    issues.push("caution.toolCautionSeconds is below caution.toolWatchSeconds; raised to match");
    toolCautionSeconds = toolWatchSeconds;
  }
  if (turnCautionSeconds < turnWatchSeconds) {
    issues.push("caution.turnCautionSeconds is below caution.turnWatchSeconds; raised to match");
    turnCautionSeconds = turnWatchSeconds;
  }
  return {
    enabled: readBoolean(section["enabled"], DEFAULT_CAUTION.enabled, "caution.enabled", issues),
    toolWatchSeconds,
    toolCautionSeconds,
    turnWatchSeconds,
    turnCautionSeconds,
    repeatThreshold: readNumber(section["repeatThreshold"], DEFAULT_CAUTION.repeatThreshold, "caution.repeatThreshold", issues, 2),
    exemptTools: readToolNames(section["exemptTools"], issues),
    toast: readBoolean(section["toast"], DEFAULT_CAUTION.toast, "caution.toast", issues)
  };
}
function resolveConfig(options) {
  const issues = [];
  if (options === undefined || options === null) {
    return { config: DEFAULT_CONFIG, issues };
  }
  if (!isRecord(options)) {
    issues.push("plugin options must be an object; using defaults");
    return { config: DEFAULT_CONFIG, issues };
  }
  const rawSidebar = options.sidebar;
  const rawFooter = options.footer;
  const rawCaution = options.caution;
  const rawNotifications = options.notifications;
  const rawFormat = options.format;
  const rawStyle = options.style;
  if (rawSidebar !== undefined && !isRecord(rawSidebar)) {
    issues.push("sidebar must be an object; using defaults");
  }
  if (rawFooter !== undefined && !isRecord(rawFooter)) {
    issues.push("footer must be an object; using defaults");
  }
  if (rawCaution !== undefined && !isRecord(rawCaution)) {
    issues.push("caution must be an object; using defaults");
  }
  if (rawNotifications !== undefined && !isRecord(rawNotifications)) {
    issues.push("notifications must be an object; using defaults");
  }
  if (rawFormat !== undefined && !isRecord(rawFormat)) {
    issues.push("format must be an object; using defaults");
  }
  if (rawStyle !== undefined && !isRecord(rawStyle)) {
    issues.push("style must be an object; using defaults");
  }
  const sidebar = isRecord(rawSidebar) ? rawSidebar : {};
  const footer = isRecord(rawFooter) ? rawFooter : {};
  const caution = isRecord(rawCaution) ? rawCaution : {};
  const notifications = isRecord(rawNotifications) ? rawNotifications : {};
  const layout = isRecord(options.layout) ? options.layout : {};
  const format = isRecord(rawFormat) ? rawFormat : {};
  const glyphs = isRecord(options.glyphs) ? options.glyphs : {};
  const style = isRecord(rawStyle) ? rawStyle : {};
  const footerConfigured = Object.keys(footer).length > 0;
  const maxLines = readMaxLines(sidebar.maxLines, issues);
  const rawSidebarFooter = sidebar.footer;
  if (rawSidebarFooter !== undefined && !isRecord(rawSidebarFooter)) {
    issues.push("sidebar.footer must be an object; using defaults");
  }
  const sidebarFooter = isRecord(rawSidebarFooter) ? rawSidebarFooter : {};
  const lines = readLines(sidebar.lines, issues, maxLines);
  const footerLines = readSidebarFooterLines(sidebarFooter.lines, issues);
  const rows = readRows(sidebar.rows, issues, maxLines);
  if (lines.length + rows.length > maxLines) {
    issues.push(`sidebar.lines and sidebar.rows total ${lines.length + rows.length} lines; the rail draws the first ${maxLines}`);
  }
  return {
    config: {
      sidebar: {
        enabled: readBoolean(sidebar.enabled, DEFAULT_CONFIG.sidebar.enabled, "sidebar.enabled", issues),
        lines,
        footer: {
          lines: footerLines,
          go: readFooterGo(sidebarFooter.go, issues)
        },
        rows,
        tps: readTps(sidebar, issues),
        persist: readBoolean(sidebar.persist, DEFAULT_CONFIG.sidebar.persist, "sidebar.persist", issues),
        placeholder: readText(sidebar.placeholder, DEFAULT_CONFIG.sidebar.placeholder, "sidebar.placeholder", issues),
        maxLines
      },
      footer: {
        enabled: readBoolean(footer.enabled, footerConfigured, "footer.enabled", issues),
        text: readText(footer.text, DEFAULT_CONFIG.footer.text, "footer.text", issues)
      },
      caution: readCaution(caution, issues),
      notifications: readNotifications(notifications, issues),
      layout: readLayout(layout, issues),
      format: readFormat(format, issues),
      glyphs: readGlyphs(glyphs, issues),
      style: readStyle(style, issues),
      refresh: readRefresh(options.refresh, issues)
    },
    issues
  };
}

// src/tui/notify.ts
function shouldNotify(config, kind) {
  return config.enabled && config[kind];
}

// src/tui/file-config.ts
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
var CONFIG_FILE_CANDIDATES = ["flight-deck.jsonc", "flight-deck.json"];
function globalConfigDirectory() {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  return xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
}
var MAX_CONFIG_BYTES = 64 * 1024;
function findConfigFile(directory = globalConfigDirectory()) {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = join(directory, candidate);
    if (existsSync(path))
      return path;
  }
  return;
}
function parseJsonc(text) {
  const jsonc = globalThis.Bun?.JSONC;
  if (typeof jsonc?.parse === "function")
    return jsonc.parse(text);
  return JSON.parse(text);
}
function loadConfigFile(directory = globalConfigDirectory()) {
  const source = findConfigFile(directory);
  if (source === undefined)
    return { options: undefined };
  try {
    const stats = statSync(source);
    if (!stats.isFile()) {
      return { options: undefined, source, issue: `${source} is not a regular file; using defaults` };
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      const limit = Math.floor(MAX_CONFIG_BYTES / 1024);
      return { options: undefined, source, issue: `${source} is larger than ${limit} KiB; using defaults` };
    }
    const text = readFileSync(source, "utf8");
    if (text.trim().length === 0) {
      return { options: undefined, source, issue: `${source} is empty; using defaults` };
    }
    const parsed = parseJsonc(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { options: undefined, source, issue: `${source} must contain a JSON object; using defaults` };
    }
    return { options: parsed, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { options: undefined, source, issue: `${source} could not be parsed (${message}); using defaults` };
  }
}

// src/tui/go-look.ts
import { existsSync as existsSync2, statSync as statSync2 } from "fs";
import { join as join2 } from "path";
function findCandidate(directory) {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = join2(directory, candidate);
    if (existsSync2(path))
      return path;
  }
  return;
}
function snapshotOf(path) {
  try {
    const stats = statSync2(path);
    if (!stats.isFile())
      return;
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return;
  }
}
function layoutOf(go) {
  return go === true ? undefined : typeof go === "object" && go !== null ? go : undefined;
}
function createGoLookReader(input) {
  const directory = input.directory ?? globalConfigDirectory();
  const hostOptions = input.hostOptions;
  let look = input.initial;
  let reads = 0;
  let seenPath = findCandidate(directory);
  let seen = seenPath === undefined ? undefined : snapshotOf(seenPath);
  const current = () => {
    try {
      const path = findCandidate(directory);
      if (path === undefined) {
        seenPath = undefined;
        seen = undefined;
        return look;
      }
      const snap = snapshotOf(path);
      if (snap === undefined) {
        seenPath = undefined;
        seen = undefined;
        return look;
      }
      if (seenPath === path && seen !== undefined && snap.mtimeMs === seen.mtimeMs && snap.size === seen.size) {
        return look;
      }
      const loaded = loadConfigFile(directory);
      reads += 1;
      seenPath = path;
      seen = snapshotOf(path) ?? snap;
      if (loaded.options === undefined)
        return look;
      const { config } = resolveConfig(mergeOptions(loaded.options, hostOptions));
      look = layoutOf(config.sidebar.footer.go);
      return look;
    } catch {
      return look;
    }
  };
  return { current, reads: () => reads };
}

// src/tui/presentation.ts
function railLines(config, source = {}) {
  if (!config.sidebar.enabled)
    return [];
  const layout = {
    ...config.layout,
    persist: config.sidebar.persist,
    placeholder: config.sidebar.placeholder,
    durationStyle: config.format.duration,
    tpsDisplay: config.sidebar.tps.display,
    hasTotalRow: config.sidebar.rows.includes("total")
  };
  const lines = config.sidebar.lines.map((text) => ({ text }));
  for (const field of config.sidebar.rows) {
    const segments = statSegments(field, source, layout);
    if (segments !== undefined) {
      lines.push({ field, text: segments.map((segment) => segment.text).join(""), segments });
      continue;
    }
    const text = statLine(field, source, layout) ?? statRows([field], source, layout)[0];
    if (text !== undefined)
      lines.push({ field, text });
  }
  return lines.slice(0, config.sidebar.maxLines);
}
function railLineStyle(style, line) {
  return line.field === undefined ? style.lines : rowStyle(style, line.field);
}
function railLineSpans(line, style) {
  if (line.segments === undefined)
    return [{ text: line.text, color: style.color }];
  return line.segments.map((segment) => ({
    text: segment.text,
    color: segment.tone ?? style.color
  }));
}
function footerLine(config) {
  return config.footer.enabled ? config.footer.text : undefined;
}

// src/tui/go-panel.ts
var PANEL_WINDOWS = ["5h", "1w", "1m"];
var PANEL_DEFAULT_LABELS = {
  rolling: "rolling",
  weekly: "weekly",
  monthly: "monthly"
};
function labelKeyFor(id) {
  if (id === "5h")
    return "rolling";
  if (id === "1w")
    return "weekly";
  return "monthly";
}
var HEADER_GLYPH = "\u25C8";
var MARK_REST = String.fromCharCode(9675);
var MARK_MID = String.fromCharCode(9678);
var MARK_LIVE = String.fromCharCode(9679);
var MARK_FRAMES = [MARK_REST, MARK_MID, MARK_LIVE, MARK_MID];
var MARK_WIDTH = 2;
var CELL = "\u2500";
var SWEEP_TONE = "info";
var GO_WARNING_RATIO = 0.6;
var PANEL_DEFAULT_BAR_WIDTH = 10;
var PANEL_DEFAULT_LABEL_WIDTH = 6;
var PANEL_DEFAULT_BLINK = true;
var PANEL_DEFAULT_BLINK_MS = 700;
var PANEL_MIN_BLINK_MS = 200;
var PANEL_MAX_BLINK_MS = 5000;
var PANEL_MAX_LABEL_LENGTH = 24;
var PANEL_DEFAULT_HEADER = false;
var PANEL_DEFAULT_PERCENT = true;
var PANEL_DEFAULT_RESET = true;
var PANEL_DEFAULT_ALIGN = "right";
var PANEL_DEFAULT_SWEEP = false;
var PANEL_PERCENT_WIDTH = 4;
var PANEL_RESET_WIDTH = 6;
var PANEL_SIDEBAR_BUDGET = 40;
var PANEL_MIN_LABEL_WIDTH = 5;
var PANEL_MAX_LABEL_WIDTH = 24;
var PANEL_MAX_NAMED_BAR_WIDTH = 40;
function readLookFlag(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function alignCell(value, width, align) {
  if (value.length >= width)
    return value;
  const padding = width - value.length;
  if (align === "left")
    return value + " ".repeat(padding);
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return " ".repeat(left) + value + " ".repeat(padding - left);
  }
  return " ".repeat(padding) + value;
}
function labelField(label, labelWidth) {
  return label.padEnd(labelWidth);
}
function readLabel(value, fallback) {
  if (typeof value !== "string")
    return fallback;
  const text = value.trim();
  if (text.length === 0 || text.length > PANEL_MAX_LABEL_LENGTH)
    return fallback;
  return text;
}
function readLabels2(layout) {
  const hint = asRecord2(asRecord2(layout)?.["labels"]) ?? {};
  return {
    rolling: readLabel(hint["rolling"], PANEL_DEFAULT_LABELS.rolling),
    weekly: readLabel(hint["weekly"], PANEL_DEFAULT_LABELS.weekly),
    monthly: readLabel(hint["monthly"], PANEL_DEFAULT_LABELS.monthly)
  };
}
function markIndex(nowMs, blinkMs) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(blinkMs) || blinkMs <= 0)
    return 0;
  const step = Math.floor(nowMs / blinkMs) % MARK_FRAMES.length;
  return (step % MARK_FRAMES.length + MARK_FRAMES.length) % MARK_FRAMES.length;
}
function markToneAt(index) {
  return index === 2 ? undefined : "subdued";
}
function readLook(layout) {
  const hint = asRecord2(layout) ?? {};
  const header = readLookFlag(hint["header"], PANEL_DEFAULT_HEADER);
  const showPercent = readLookFlag(hint["percent"], PANEL_DEFAULT_PERCENT);
  const showReset = readLookFlag(hint["reset"], PANEL_DEFAULT_RESET);
  const rawAlign = hint["align"];
  const align = rawAlign === "left" || rawAlign === "right" || rawAlign === "center" ? rawAlign : PANEL_DEFAULT_ALIGN;
  const sweep = readLookFlag(hint["sweep"], PANEL_DEFAULT_SWEEP);
  const rawLabel = hint["labelWidth"];
  const flooredLabel = rawLabel === undefined ? undefined : Math.floor(asCount2(rawLabel) ?? Number.NaN);
  const configuredLabelWidth = flooredLabel !== undefined && Number.isFinite(flooredLabel) && flooredLabel >= PANEL_MIN_LABEL_WIDTH && flooredLabel <= PANEL_MAX_LABEL_WIDTH ? flooredLabel : PANEL_DEFAULT_LABEL_WIDTH;
  const labels = readLabels2(layout);
  const longestLabel = Math.max(labels.rolling.length, labels.weekly.length, labels.monthly.length);
  const labelWidth = Math.max(configuredLabelWidth, longestLabel);
  const blink = readLookFlag(hint["blink"], PANEL_DEFAULT_BLINK);
  const rawBlinkMs = hint["blinkMs"];
  const flooredBlinkMs = rawBlinkMs === undefined ? undefined : Math.floor(asCount2(rawBlinkMs) ?? Number.NaN);
  const blinkMs = flooredBlinkMs !== undefined && Number.isFinite(flooredBlinkMs) && flooredBlinkMs >= PANEL_MIN_BLINK_MS && flooredBlinkMs <= PANEL_MAX_BLINK_MS ? flooredBlinkMs : PANEL_DEFAULT_BLINK_MS;
  const rawBar = hint["barWidth"];
  const flooredBar = rawBar === undefined ? undefined : Math.floor(asCount2(rawBar) ?? Number.NaN);
  const namedBar = flooredBar !== undefined && Number.isFinite(flooredBar) && flooredBar >= 1 ? Math.min(flooredBar, PANEL_MAX_NAMED_BAR_WIDTH) : PANEL_DEFAULT_BAR_WIDTH;
  const markWidth = blink ? MARK_WIDTH : 0;
  const fixed = markWidth + labelWidth + 1 + (showPercent ? 1 + PANEL_PERCENT_WIDTH : 0) + (showReset ? 1 + PANEL_RESET_WIDTH : 0);
  const maxBar = Math.max(1, PANEL_SIDEBAR_BUDGET - fixed);
  return { header, barWidth: Math.min(namedBar, maxBar), labelWidth, showPercent, showReset, align, sweep, labels, blink, blinkMs };
}
function windowById(usage) {
  const byId = new Map;
  const list = asRecord2(usage)?.["windows"];
  if (!Array.isArray(list))
    return byId;
  for (const entry of list) {
    const record = asRecord2(entry);
    if (record === undefined)
      continue;
    const id = record["id"];
    if (id !== "5h" && id !== "1w" && id !== "1m")
      continue;
    if (byId.has(id))
      continue;
    const window = { id };
    const ratio = asCount2(record["ratio"]);
    if (ratio !== undefined)
      window.ratio = Math.min(1, ratio);
    const resetAtMs = asCount2(record["resetAtMs"]);
    if (resetAtMs !== undefined)
      window.resetAtMs = resetAtMs;
    const status = record["status"];
    if (typeof status === "string" && status !== "")
      window.status = status;
    byId.set(id, window);
  }
  return byId;
}
function formatCompactRemaining(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60)
    return `${totalSeconds}s`;
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60)
    return `${totalMinutes}m`;
  const totalHours = Math.floor(ms / 3600000);
  if (totalHours < 24) {
    if (totalHours === 0)
      return `${totalMinutes}m`;
    const minutes = Math.floor((ms - totalHours * 3600000) / 60000);
    return minutes > 0 ? `${totalHours}h${minutes}m` : `${totalHours}h`;
  }
  const totalDays = Math.floor(ms / 86400000);
  const hours = Math.floor((ms - totalDays * 86400000) / 3600000);
  return hours > 0 ? `${totalDays}d${hours}h` : `${totalDays}d`;
}
function resetCountdown(window, nowMs) {
  const resetAtMs = window.resetAtMs;
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || !Number.isFinite(nowMs))
    return;
  const remaining = resetAtMs - nowMs;
  if (remaining <= 0)
    return;
  return formatCompactRemaining(remaining);
}
function panelTone(window) {
  if (goTone(window) === "error")
    return "error";
  const ratio = window.ratio;
  if (ratio !== undefined && ratio >= GO_WARNING_RATIO)
    return "warning";
  return;
}
function readFrame(frame) {
  return typeof frame === "number" && Number.isFinite(frame) && frame >= 0 ? Math.floor(frame) : undefined;
}
function sweepIndex(frame, filled, sweep) {
  if (!sweep || frame === undefined || filled <= 0)
    return -1;
  return frame % filled;
}
function appendRun(runs, text, tone) {
  if (text === "")
    return;
  const last = runs[runs.length - 1];
  if (last !== undefined && (last.tone ?? undefined) === tone) {
    runs[runs.length - 1] = tone === undefined ? { text: last.text + text } : { text: last.text + text, tone };
    return;
  }
  runs.push(tone === undefined ? { text } : { text, tone });
}
function readReason(reason) {
  return typeof reason === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(reason) ? reason : undefined;
}
function headerLine() {
  const text = ` ${HEADER_GLYPH} OPENCODE GO`;
  return { field: "go", text, segments: [{ text, tone: "subdued" }] };
}
function markField(look, nowMs, isFirst) {
  if (!look.blink)
    return;
  if (!isFirst)
    return { text: "  " };
  const index = markIndex(nowMs, look.blinkMs);
  const text = `${MARK_FRAMES[index] ?? MARK_REST} `;
  const tone = markToneAt(index);
  return tone === undefined ? { text } : { text, tone };
}
function restingLine(label, look, reason, nowMs, isFirst) {
  const cells = Math.max(1, Math.floor(look.barWidth));
  const segments = [];
  const mark = markField(look, nowMs, isFirst);
  if (mark !== undefined)
    segments.push(mark);
  segments.push({ text: `${labelField(label, look.labelWidth)} ` });
  let trackCells = cells;
  if (reason !== undefined) {
    segments.push({ text: `${reason} `, tone: "subdued" });
    trackCells = Math.max(0, cells - reason.length - 1);
  }
  const tail = CELL.repeat(trackCells) + (look.showPercent ? ` ${alignCell(DEFAULT_PLACEHOLDER, PANEL_PERCENT_WIDTH, look.align)}` : "");
  segments.push({ text: tail, tone: "subdued" });
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}
function valueLine(label, look, window, nowMs, frame, isFirst) {
  const tone = panelTone(window);
  const ratio = window.ratio;
  const cells = Math.max(1, Math.floor(look.barWidth));
  const filled = Math.max(0, Math.min(cells, Math.round((ratio ?? 0) * cells)));
  const sweep = sweepIndex(frame, filled, look.sweep);
  const fillTone = tone ?? "default";
  const runs = [];
  for (let index = 0;index < filled; index += 1) {
    appendRun(runs, CELL, index === sweep ? SWEEP_TONE : fillTone);
  }
  for (let index = filled;index < cells; index += 1) {
    appendRun(runs, CELL, "subdued");
  }
  if (look.showPercent) {
    const percent = ratio === undefined ? DEFAULT_PLACEHOLDER : `${Math.round(ratio * 100)}%`;
    appendRun(runs, ` ${alignCell(percent, PANEL_PERCENT_WIDTH, look.align)}`, tone);
  }
  const segments = [];
  const mark = markField(look, nowMs, isFirst);
  if (mark !== undefined)
    segments.push(mark);
  segments.push({ text: `${labelField(label, look.labelWidth)} ` }, ...runs);
  if (look.showReset) {
    const countdown = resetCountdown(window, nowMs);
    if (countdown !== undefined) {
      segments.push({ text: ` ${alignCell(countdown, PANEL_RESET_WIDTH, look.align)}`, tone: "subdued" });
    }
  }
  return { field: "go", text: segments.map((segment) => segment.text).join(""), segments };
}
function goPanelLines(usage, nowMs, layout, frame, reason) {
  try {
    const look = readLook(layout);
    const windows = windowById(usage);
    const tag = windows.size === 0 ? readReason(reason) : undefined;
    const sweepFrame = readFrame(frame);
    const rows = PANEL_WINDOWS.map((id, index) => {
      const label = look.labels[labelKeyFor(id)];
      const window = windows.get(id);
      return window === undefined ? restingLine(label, look, index === 0 ? tag : undefined, nowMs, index === 0) : valueLine(label, look, window, nowMs, sweepFrame, index === 0);
    });
    return look.header ? [headerLine(), ...rows] : rows;
  } catch {
    const fallback = readLook(undefined);
    return PANEL_WINDOWS.map((id, index) => restingLine(fallback.labels[labelKeyFor(id)], fallback, undefined, nowMs, index === 0));
  }
}

// src/tui/guard.ts
var GUARD_KEY = "flight-deck.guard";
var GUARD_POLL_MS = 1e4;
var GUARD_CONTRACT = {
  id: "harness-guard",
  methods: {
    status: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: { type: "object" }
    }
  },
  events: {}
};
function asRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function asCount3(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.floor(value);
  if (Array.isArray(value))
    return value.length;
  return;
}
function countOrZero(...candidates) {
  for (const candidate of candidates) {
    const count = asCount3(candidate);
    if (count !== undefined)
      return count;
  }
  return 0;
}
function normalizeAirworthiness(value) {
  const section = asRecord3(value);
  if (section === undefined)
    return;
  if (section.available !== true && section.available !== false)
    return;
  return {
    available: section.available === true,
    findings: countOrZero(section.findings, section.counts)
  };
}
function normalizeWarden(value) {
  const section = asRecord3(value);
  if (section === undefined)
    return;
  if (section.available !== true && section.available !== false)
    return;
  return {
    available: section.available === true,
    breaches: countOrZero(section.breaches),
    orphans: countOrZero(section.orphans)
  };
}
function normalizeFlightPlan(value) {
  const section = asRecord3(value);
  if (section === undefined)
    return;
  if (section.available !== true && section.available !== false)
    return;
  return { available: section.available === true };
}
function normalizeGuardStatus(value) {
  try {
    const top = asRecord3(value);
    if (top === undefined)
      return;
    const airworthiness = normalizeAirworthiness(top.airworthiness);
    const warden = normalizeWarden(top.warden);
    const flightPlan = normalizeFlightPlan(top.flightPlan);
    if (airworthiness === undefined && warden === undefined && flightPlan === undefined)
      return;
    const status = {};
    if (airworthiness !== undefined)
      status.airworthiness = airworthiness;
    if (warden !== undefined)
      status.warden = warden;
    if (flightPlan !== undefined)
      status.flightPlan = flightPlan;
    return status;
  } catch {
    return;
  }
}
function openStore(storage) {
  let opened;
  try {
    opened = storage.memory(GUARD_KEY, { initial: { value: null } });
  } catch {
    return;
  }
  if (!Array.isArray(opened) || opened.length < 2)
    return;
  const [store, update] = opened;
  if (store === null || typeof store !== "object")
    return;
  if (typeof update !== "function")
    return;
  return { store, update };
}
function readStatus(store) {
  try {
    const value = store?.value;
    if (value === null || value === undefined)
      return;
    return normalizeGuardStatus(value);
  } catch {
    return;
  }
}
function resolveStatusFn(host, deps) {
  if (deps !== undefined) {
    try {
      if (typeof deps.status === "function")
        return deps.status;
    } catch {
      return;
    }
    return;
  }
  try {
    const client = asRecord3(host.client);
    const rpc = client?.rpc;
    if (typeof rpc !== "function")
      return;
    const factory = rpc;
    const remote = factory(GUARD_CONTRACT);
    const status = remote.status;
    if (typeof status !== "function")
      return;
    return (input) => status(input);
  } catch {
    return;
  }
}
function writeValue(opened, value) {
  try {
    opened.update((draft) => {
      draft.value = value;
    });
    return true;
  } catch {
    return false;
  }
}
function startGuardBridge(host, deps, intervalMs = GUARD_POLL_MS) {
  const storage = host?.storage;
  if (host === undefined || storage === undefined || typeof storage.memory !== "function")
    return;
  const opened = openStore(storage);
  if (opened === undefined)
    return;
  const cadence = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : GUARD_POLL_MS;
  let currentSessionID;
  let timer;
  let generation = 0;
  let nextSeq = 0;
  let latestSeq = 0;
  let disposed = false;
  const stopTimer = () => {
    if (timer !== undefined)
      clearInterval(timer);
    timer = undefined;
  };
  const poll = async (sessionID) => {
    if (disposed)
      return;
    if (sessionID === undefined || sessionID.length === 0)
      return;
    const myGeneration = generation;
    const mySeq = ++nextSeq;
    latestSeq = mySeq;
    const stillCurrent = () => myGeneration === generation && mySeq === latestSeq && !disposed;
    let raw;
    try {
      const statusFn = resolveStatusFn(host, deps);
      if (statusFn === undefined) {
        if (!stillCurrent())
          return;
        if (currentSessionID !== sessionID)
          return;
        if (!writeValue(opened, null))
          stopTimer();
        return;
      }
      raw = await statusFn({ sessionID });
    } catch {
      if (!stillCurrent())
        return;
      if (currentSessionID !== sessionID)
        return;
      if (!writeValue(opened, null))
        stopTimer();
      return;
    }
    if (!stillCurrent())
      return;
    if (currentSessionID !== sessionID)
      return;
    let normalized;
    try {
      normalized = normalizeGuardStatus(raw) ?? null;
    } catch {
      normalized = null;
    }
    if (!writeValue(opened, normalized))
      stopTimer();
  };
  timer = setInterval(() => {
    const sessionID = currentSessionID;
    if (sessionID === undefined)
      return;
    poll(sessionID);
  }, cadence);
  return {
    get status() {
      return readStatus(opened.store);
    },
    follow(sessionID) {
      try {
        if (disposed)
          return;
        const next = typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined;
        if (next === currentSessionID)
          return;
        generation += 1;
        currentSessionID = next;
        if (next === undefined) {
          if (!writeValue(opened, null))
            stopTimer();
          return;
        }
        if (!writeValue(opened, null)) {
          stopTimer();
          return;
        }
        poll(next);
      } catch {}
    },
    dispose() {
      disposed = true;
      generation += 1;
      stopTimer();
    }
  };
}

// src/tui/go.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join as join3 } from "path";
var GO_KEY = "flight-deck.go";
var GO_POLL_MS = 60000;
var GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
var GO_INTEGRATION_ID = "opencode-go";
var GO_TIMEOUT_MS = 1e4;
var GO_CREDENTIAL_TIMEOUT_MS = 6000;
var GO_LOG_DIR = "opencode";
var GO_LOG_FILE = "flight-deck-go.log";
var GO_LOG_ENV = "FLIGHT_DECK_GO_LOG";
function goLogEnabled() {
  try {
    return process.env[GO_LOG_ENV] === "1";
  } catch {
    return false;
  }
}
var GO_LOG_MAX_LINES = 200;
async function defaultFetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`go usage: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function openStore2(storage) {
  let opened;
  try {
    opened = storage.memory(GO_KEY, { initial: { value: null, reason: null } });
  } catch {
    return;
  }
  if (!Array.isArray(opened) || opened.length < 2)
    return;
  const [store, update] = opened;
  if (store === null || typeof store !== "object")
    return;
  if (typeof update !== "function")
    return;
  return { store, update };
}
var GO_WINDOW_ORDER = ["5h", "1w", "1m"];
function asStoredNumber(value) {
  try {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return;
  }
}
function asStoredWindow(entry, seen) {
  try {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return;
    const record = entry;
    let id;
    let ratioRaw;
    let usedRaw;
    let limitRaw;
    let resetRaw;
    let statusRaw;
    try {
      id = record["id"];
    } catch {
      return;
    }
    if (id !== "5h" && id !== "1w" && id !== "1m")
      return;
    if (seen.has(id))
      return;
    try {
      ratioRaw = record["ratio"];
    } catch {
      return;
    }
    let ratio;
    if (ratioRaw !== undefined) {
      const finite = asStoredNumber(ratioRaw);
      if (finite === undefined)
        return;
      ratio = Math.min(1, Math.max(0, finite));
    }
    let used;
    let limit;
    let resetAtMs;
    let status;
    try {
      usedRaw = record["used"];
      limitRaw = record["limit"];
      resetRaw = record["resetAtMs"];
      statusRaw = record["status"];
    } catch {
      return;
    }
    used = asStoredNumber(usedRaw);
    limit = asStoredNumber(limitRaw);
    resetAtMs = asStoredNumber(resetRaw);
    try {
      if (typeof statusRaw === "string" && statusRaw.trim().length > 0)
        status = statusRaw.trim();
    } catch {
      status = undefined;
    }
    if (used === undefined && limit === undefined && ratio === undefined)
      return;
    seen.add(id);
    const result = { id };
    if (used !== undefined)
      result.used = used;
    if (limit !== undefined)
      result.limit = limit;
    if (ratio !== undefined)
      result.ratio = ratio;
    if (resetAtMs !== undefined)
      result.resetAtMs = resetAtMs;
    if (status !== undefined)
      result.status = status;
    return result;
  } catch {
    return;
  }
}
function readUsage(store) {
  try {
    const value = store?.value;
    if (value === null || value === undefined)
      return;
    if (typeof value !== "object" || Array.isArray(value))
      return;
    let windowsRaw;
    try {
      windowsRaw = value["windows"];
    } catch {
      return;
    }
    if (!Array.isArray(windowsRaw))
      return;
    const windows = [];
    const seen = new Set;
    for (const entry of windowsRaw) {
      const window = asStoredWindow(entry, seen);
      if (window !== undefined)
        windows.push(window);
    }
    if (windows.length === 0)
      return;
    windows.sort((a, b) => GO_WINDOW_ORDER.indexOf(a.id) - GO_WINDOW_ORDER.indexOf(b.id));
    return { windows };
  } catch {
    return;
  }
}
var GO_NO_DATA_REASONS = [
  "no-client",
  "no-key",
  "http",
  "parse",
  "timeout",
  "pending"
];
function readReason2(store) {
  try {
    const reason = store?.reason;
    if (typeof reason !== "string")
      return;
    return GO_NO_DATA_REASONS.includes(reason) ? reason : undefined;
  } catch {
    return;
  }
}
function writeValue2(opened, value, reason) {
  try {
    opened.update((draft) => {
      draft.value = value;
      draft.reason = value === null ? reason : null;
    });
    return true;
  } catch {
    return false;
  }
}
function resolveKeyFn(deps) {
  if (deps !== undefined) {
    try {
      if (typeof deps.key === "function")
        return deps.key;
    } catch {}
  }
  return;
}
function resolveAsyncKeyFn(deps) {
  if (deps !== undefined) {
    try {
      if (typeof deps.resolveKey === "function")
        return deps.resolveKey;
    } catch {}
  }
  return;
}
function keyOfValue(value) {
  if (value === null || typeof value !== "object")
    return;
  const record = value;
  if (record["type"] !== "key")
    return;
  const key = record["key"];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}
function safeGet(target, key) {
  try {
    if (target === null || typeof target !== "object" && typeof target !== "function")
      return;
    return target[key];
  } catch {
    return;
  }
}
function resolveCredentialTimeout(deps) {
  if (deps !== undefined) {
    try {
      const value = deps.credentialTimeoutMs;
      if (typeof value === "number" && Number.isFinite(value) && value > 0)
        return value;
    } catch {}
  }
  return GO_CREDENTIAL_TIMEOUT_MS;
}
function settleCall(call, ms) {
  let produced;
  try {
    produced = call();
  } catch {
    return Promise.resolve({ ok: false, timedOut: false });
  }
  const thenable = produced !== null && (typeof produced === "object" || typeof produced === "function") ? produced.then : undefined;
  if (typeof thenable !== "function")
    return Promise.resolve({ ok: true, value: produced });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    produced.then((value) => {
      clearTimeout(timer);
      resolve({ ok: true, value });
    }, () => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false });
    });
  });
}
function asList(value) {
  if (Array.isArray(value))
    return value;
  if (value === null || typeof value !== "object")
    return;
  const record = value;
  const data = record["data"];
  if (Array.isArray(data))
    return data;
  const output = record["output"];
  if (Array.isArray(output))
    return output;
  return;
}
function isActive(value) {
  return Boolean(value);
}
function goKeyFromEntries(entries) {
  let fallback;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object")
      continue;
    const record = entry;
    if (record["integrationID"] !== GO_INTEGRATION_ID)
      continue;
    const key = keyOfValue(record["value"]);
    if (key === undefined)
      continue;
    if (isActive(record["active"]))
      return key;
    if (fallback === undefined)
      fallback = key;
  }
  return fallback;
}
async function credentialAttempt(store, ms) {
  const list = safeGet(store, "list");
  if (typeof list !== "function")
    return { reason: "no-client", answered: false };
  const settled = await settleCall(() => list.call(store), ms);
  if (!settled.ok)
    return { reason: settled.timedOut ? "timeout" : "no-client", answered: false };
  const entries = asList(settled.value);
  if (entries === undefined)
    return { reason: "no-client", answered: false };
  const key = goKeyFromEntries(entries);
  return key === undefined ? { reason: "no-key", answered: true } : { key, answered: true };
}
function providerKeyOf(info) {
  if (info === null || typeof info !== "object")
    return;
  const record = info;
  if (record["id"] !== GO_INTEGRATION_ID && record["integrationID"] !== GO_INTEGRATION_ID)
    return;
  const settings = record["settings"];
  if (settings === null || typeof settings !== "object")
    return;
  const apiKey = settings["apiKey"];
  return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined;
}
function unwrapOne(value) {
  if (value === null || typeof value !== "object")
    return value;
  const data = value["data"];
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : value;
}
async function providerAttempt(provider, ms) {
  if (provider === null || typeof provider !== "object")
    return { reason: "no-client", answered: false };
  const collection = provider;
  const get = collection["get"];
  const list = collection["list"];
  if (typeof get === "function") {
    const settled = await settleCall(() => get.call(collection, GO_INTEGRATION_ID), ms);
    if (!settled.ok)
      return { reason: settled.timedOut ? "timeout" : "no-client", answered: false };
    if (settled.value === undefined || settled.value === null)
      return { reason: "no-key", answered: true };
    const key = providerKeyOf(unwrapOne(settled.value));
    return key === undefined ? { reason: "no-key", answered: true } : { key, answered: true };
  }
  if (typeof list === "function") {
    const settled = await settleCall(() => list.call(collection), ms);
    if (!settled.ok)
      return { reason: settled.timedOut ? "timeout" : "no-client", answered: false };
    const entries = asList(settled.value);
    if (entries === undefined)
      return { reason: "no-client", answered: false };
    let key;
    for (const entry of entries) {
      const candidate = providerKeyOf(entry);
      if (candidate !== undefined) {
        key = candidate;
        break;
      }
    }
    return key === undefined ? { reason: "no-key", answered: true } : { key, answered: true };
  }
  return { reason: "no-client", answered: false };
}
function resolveFetchJson(deps) {
  if (deps !== undefined) {
    try {
      if (typeof deps.fetchJson === "function")
        return deps.fetchJson;
    } catch {}
  }
  return defaultFetchJson;
}
function httpOf(error) {
  const status = error !== null && typeof error === "object" ? error.status : undefined;
  return typeof status === "number" && Number.isFinite(status) ? String(status) : "n/a";
}
function logPoll(entry) {
  if (!goLogEnabled())
    return;
  try {
    const directory = join3(tmpdir(), GO_LOG_DIR);
    const path = join3(directory, GO_LOG_FILE);
    const line = `ts=${new Date().toISOString()} src=${entry.src} key=${entry.key ? "yes" : "no"} http=${entry.http} parse=${entry.parse} reason=${entry.reason}
`;
    let prior = "";
    try {
      if (existsSync3(path))
        prior = readFileSync2(path, "utf8");
    } catch {
      prior = "";
    }
    const lines = prior.length === 0 ? 0 : prior.split(`
`).filter((row) => row.length > 0).length;
    mkdirSync(directory, { recursive: true });
    if (lines >= GO_LOG_MAX_LINES)
      writeFileSync(path, line);
    else
      appendFileSync(path, line);
  } catch {}
}
function startGoBridge(host, deps, intervalMs = GO_POLL_MS) {
  const storage = host?.storage;
  if (host === undefined || storage === undefined || typeof storage.memory !== "function")
    return;
  const opened = openStore2(storage);
  if (opened === undefined)
    return;
  const cadence = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : GO_POLL_MS;
  const keyFn = resolveKeyFn(deps);
  const asyncKeyFn = resolveAsyncKeyFn(deps);
  const fetchJson = resolveFetchJson(deps);
  const credentialTimeoutMs = resolveCredentialTimeout(deps);
  const client = host.client;
  const directStore = safeGet(client, "credential");
  const wrappedStore = safeGet(safeGet(client, "api"), "credential");
  const providerSource = safeGet(safeGet(safeGet(host, "data"), "location"), "provider");
  const readKey = async () => {
    if (keyFn !== undefined) {
      try {
        const key = keyFn();
        return typeof key === "string" && key.length > 0 ? { key, src: "credential" } : { src: "none", reason: "no-key" };
      } catch {
        return { src: "none", reason: "no-key" };
      }
    }
    if (asyncKeyFn !== undefined) {
      try {
        const key = await asyncKeyFn();
        return typeof key === "string" && key.length > 0 ? { key, src: "credential" } : { src: "none", reason: "no-key" };
      } catch {
        return { src: "none", reason: "no-key" };
      }
    }
    let answered = false;
    let timedOut = false;
    const direct = await credentialAttempt(directStore, credentialTimeoutMs);
    if (direct.key !== undefined)
      return { key: direct.key, src: "credential" };
    answered = answered || direct.answered;
    timedOut = timedOut || direct.reason === "timeout";
    const wrapped = await credentialAttempt(wrappedStore, credentialTimeoutMs);
    if (wrapped.key !== undefined)
      return { key: wrapped.key, src: "credential" };
    answered = answered || wrapped.answered;
    timedOut = timedOut || wrapped.reason === "timeout";
    const provider = await providerAttempt(providerSource, credentialTimeoutMs);
    if (provider.key !== undefined)
      return { key: provider.key, src: "provider" };
    answered = answered || provider.answered;
    timedOut = timedOut || provider.reason === "timeout";
    if (answered)
      return { src: "none", reason: "no-key" };
    return { src: "none", reason: timedOut ? "timeout" : "no-client" };
  };
  let timer;
  let generation = 0;
  let nextSeq = 0;
  let latestSeq = 0;
  let disposed = false;
  const stopTimer = () => {
    if (timer !== undefined)
      clearInterval(timer);
    timer = undefined;
  };
  const poll = async () => {
    if (disposed)
      return;
    const myGeneration = generation;
    const mySeq = ++nextSeq;
    latestSeq = mySeq;
    const stillCurrent = () => myGeneration === generation && mySeq === latestSeq && !disposed;
    let key;
    let keySrc = "none";
    let keyReason = "no-key";
    try {
      const resolved = await readKey();
      key = resolved.key;
      keySrc = resolved.src;
      if (resolved.reason !== undefined)
        keyReason = resolved.reason;
    } catch {
      key = undefined;
    }
    if (typeof key !== "string" || key.length === 0) {
      if (stillCurrent() && !writeValue2(opened, null, keyReason))
        stopTimer();
      logPoll({ src: keySrc, key: false, http: "n/a", parse: "n/a", reason: keyReason });
      return;
    }
    let raw;
    try {
      raw = await fetchJson(GO_USAGE_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(GO_TIMEOUT_MS)
      });
    } catch (error) {
      if (stillCurrent() && !writeValue2(opened, null, "http"))
        stopTimer();
      logPoll({ src: keySrc, key: true, http: httpOf(error), parse: "n/a", reason: "http" });
      return;
    }
    let normalized;
    try {
      normalized = normalizeGoUsage(raw) ?? null;
    } catch {
      normalized = null;
    }
    if (stillCurrent() && !writeValue2(opened, normalized, "parse"))
      stopTimer();
    logPoll({
      src: keySrc,
      key: true,
      http: "ok",
      parse: normalized === null ? "no" : "ok",
      reason: normalized === null ? "parse" : "none"
    });
  };
  timer = setInterval(() => {
    poll();
  }, cadence);
  poll();
  return {
    get usage() {
      return readUsage(opened.store);
    },
    get reason() {
      return readReason2(opened.store);
    },
    dispose() {
      disposed = true;
      generation += 1;
      stopTimer();
    }
  };
}

// src/tui/ticker.ts
var TICKER_KEY = "flight-deck.frame";
var IDLE_REFRESH_MS = 1000;
function readFrame2(store) {
  const value = store?.frame;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
function openStore3(storage) {
  let opened;
  try {
    opened = storage.memory(TICKER_KEY, { initial: { frame: 0 } });
  } catch {
    return;
  }
  if (!Array.isArray(opened) || opened.length < 2)
    return;
  const [store, update] = opened;
  if (store === null || typeof store !== "object")
    return;
  if (typeof update !== "function")
    return;
  return { store, update };
}
function startTicker(host, intervalMs, isBusy = () => true) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0)
    return;
  const storage = host?.storage;
  if (storage === undefined || typeof storage.memory !== "function")
    return;
  const opened = openStore3(storage);
  if (opened === undefined)
    return;
  const idleEvery = Math.max(1, Math.round(IDLE_REFRESH_MS / intervalMs));
  let ticks = 0;
  let timer = setInterval(() => {
    ticks += 1;
    let busy = true;
    try {
      busy = isBusy();
    } catch {
      busy = true;
    }
    if (!busy && ticks % idleEvery !== 0)
      return;
    try {
      opened.update((draft) => {
        draft.frame = readFrame2(draft) + 1;
      });
    } catch {
      if (timer !== undefined)
        clearInterval(timer);
      timer = undefined;
    }
  }, intervalMs);
  return {
    get frame() {
      return readFrame2(opened.store);
    },
    dispose() {
      if (timer !== undefined)
        clearInterval(timer);
      timer = undefined;
    }
  };
}

// src/tui/project-totals.ts
function createProjectTotals(context) {
  const PROJECT_CACHE_MS = 5000;
  let projectCache;
  const projectTotals = (sessionID) => {
    try {
      const projectID = asText2(asRecord2(context.data.session.get(sessionID))?.["projectID"]);
      const cached = projectCache;
      if (cached !== undefined && cached.projectID === projectID && Date.now() - cached.at < PROJECT_CACHE_MS) {
        return cached.value;
      }
      const sessions = context.data.session.list() ?? [];
      const scoped = projectID === undefined ? sessions : sessions.filter((entry) => asText2(asRecord2(entry)?.["projectID"]) === projectID);
      let cost = 0;
      for (const entry of scoped)
        cost += asCount2(asRecord2(entry)?.["cost"]) ?? 0;
      const value = { cost, count: scoped.length };
      projectCache = { projectID, at: Date.now(), value };
      return value;
    } catch {
      return;
    }
  };
  return { projectTotals };
}

// src/tui/session-elapsed.ts
function createActiveTime(reads, options) {
  const cacheMs = options?.cacheMs ?? 1000;
  const maxSessions = options?.maxSessions ?? 256;
  const entries = new Map;
  const sweepForgotten = () => {
    for (const id of entries.keys()) {
      let known = true;
      try {
        known = reads.knows?.(id) ?? true;
      } catch {
        known = true;
      }
      if (!known)
        entries.delete(id);
    }
  };
  return function activeTimeMs(sessionID, now) {
    let entry = entries.get(sessionID);
    const fresh = entry === undefined || Number.isFinite(now) && now - entry.at >= cacheMs;
    if (fresh && Number.isFinite(now)) {
      let union = 0;
      try {
        union = unionSpanMs(reads.spansOf(sessionID, now));
      } catch {
        union = 0;
      }
      if (!Number.isFinite(union) || union < 0)
        union = 0;
      const high = Math.max(entry?.high ?? 0, union);
      if (entry === undefined) {
        if (entries.size >= maxSessions)
          sweepForgotten();
        entry = { union, at: now, high };
        entries.set(sessionID, entry);
      } else {
        entry.union = union;
        entry.at = now;
        entry.high = high;
      }
    }
    const high = entry?.high ?? 0;
    return high <= 0 ? undefined : high;
  };
}

// src/tui/session-reads.ts
function locationOf(context) {
  try {
    return context.location ?? context.data.location.default();
  } catch {
    return context.location;
  }
}
function createSessionReads(context) {
  const RECENT_MESSAGES = 4;
  const messagesOf = (sessionID) => {
    try {
      return context.data.session.message.list(sessionID) ?? [];
    } catch {
      return [];
    }
  };
  const isFamilyRoot = (sessionID) => {
    try {
      return context.data.session.root(sessionID) === sessionID;
    } catch {
      return true;
    }
  };
  const treeTotals = (sessionID, ownCost) => {
    if (!isFamilyRoot(sessionID))
      return;
    let ids;
    try {
      ids = context.data.session.family(sessionID) ?? [sessionID];
    } catch {
      return;
    }
    let own;
    try {
      own = context.data.session.get(sessionID);
    } catch {
      own = undefined;
    }
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    const addTokens = (source) => {
      const record = asRecord2(source?.tokens);
      tokens.input += asCount2(record?.["input"]) ?? 0;
      tokens.output += asCount2(record?.["output"]) ?? 0;
      tokens.reasoning += asCount2(record?.["reasoning"]) ?? 0;
      const cache = asRecord2(record?.["cache"]);
      tokens.cache.read += asCount2(cache?.["read"]) ?? 0;
      tokens.cache.write += asCount2(cache?.["write"]) ?? 0;
    };
    addTokens(own);
    let cost = asCount2(ownCost) ?? 0;
    let count = 0;
    for (const id of ids) {
      if (id === sessionID)
        continue;
      let child;
      try {
        child = context.data.session.get(id);
      } catch {
        continue;
      }
      if (child === undefined)
        continue;
      count += 1;
      cost += asCount2(child.cost) ?? 0;
      addTokens(child);
    }
    if (ownCost === undefined && count === 0)
      return;
    return { cost, count, tokens };
  };
  const contextUsage = (sessionID, model) => {
    const messages = messagesOf(sessionID);
    for (let index = messages.length - 1;index >= 0; index -= 1) {
      const tokens = asRecord2(asRecord2(messages[index])?.tokens);
      const input = asCount2(tokens?.input);
      if (tokens === undefined || input === undefined)
        continue;
      const cache = asRecord2(tokens.cache);
      const used = input + (asCount2(cache?.read) ?? 0) + (asCount2(cache?.write) ?? 0);
      if (used === 0)
        return;
      return { used, limit: contextLimit(model) };
    }
    return;
  };
  const contextLimit = (model) => {
    const ref = asRecord2(model);
    const id = ref?.id;
    const providerID = ref?.providerID;
    if (typeof id !== "string")
      return;
    try {
      const location = context.location ?? context.data.location.default();
      for (const entry of context.data.location.model.list(location) ?? []) {
        const record = asRecord2(entry);
        if (record === undefined || record.id !== id)
          continue;
        if (typeof providerID === "string" && record.providerID !== providerID)
          continue;
        const limit = asRecord2(record.limit);
        return asCount2(limit?.context) ?? asCount2(record.context) ?? asCount2(record.contextWindow);
      }
    } catch {
      return;
    }
    return;
  };
  const statusOf = (sessionID) => {
    try {
      return context.data.session.status(sessionID);
    } catch {
      return;
    }
  };
  const recentParts = (sessionID) => {
    const parts = [];
    for (const entry of messagesOf(sessionID).slice(-RECENT_MESSAGES)) {
      const content = asRecord2(entry)?.["content"];
      if (Array.isArray(content))
        parts.push(...content);
    }
    return parts;
  };
  const shellsOf = (sessionID) => {
    try {
      const shells = context.data.shell.list(locationOf(context)) ?? [];
      return shells.filter((entry) => asText2(asRecord2(asRecord2(entry)?.["metadata"])?.["sessionID"]) === sessionID);
    } catch {
      return [];
    }
  };
  const lastActivity = (sessionID) => {
    const messages = messagesOf(sessionID);
    for (let index = messages.length - 1;index >= 0; index -= 1) {
      const time = asRecord2(asRecord2(messages[index])?.["time"]);
      const stamp = asCount2(time?.["completed"]) ?? asCount2(time?.["streamed"]) ?? asCount2(time?.["created"]);
      if (stamp !== undefined)
        return stamp;
    }
    return;
  };
  const permsOf = (sessionID) => {
    try {
      const requests = context.data.session.permission.list(sessionID);
      if (requests === undefined || requests.length === 0)
        return;
      const first = asRecord2(requests[0]);
      const action = typeof first?.["action"] === "string" ? first["action"] : undefined;
      const resources = Array.isArray(first?.["resources"]) ? first["resources"] : [];
      const resource = typeof resources[0] === "string" ? resources[0] : undefined;
      return { count: requests.length, action, resource };
    } catch {
      return;
    }
  };
  const busy = (sessionID) => {
    const status = statusOf(sessionID);
    if (status === "running")
      return true;
    try {
      for (const id of context.data.session.family(sessionID) ?? []) {
        if (id === sessionID)
          continue;
        try {
          if (context.data.session.status(id) === "running")
            return true;
        } catch {}
      }
    } catch {}
    try {
      if (shellsOf(sessionID).some((entry) => asRecord2(entry)?.["status"] === "running"))
        return true;
    } catch {}
    return status === undefined ? undefined : false;
  };
  const spansOf = (sessionID, now) => {
    try {
      let live = false;
      try {
        live = busy(sessionID) === true;
      } catch {
        live = false;
      }
      const ids = new Set([sessionID]);
      try {
        for (const id of context.data.session.family(sessionID) ?? [])
          ids.add(id);
      } catch {}
      const spans = [];
      for (const id of ids) {
        for (const entry of messagesOf(id)) {
          const message = asRecord2(entry);
          if (message?.["type"] !== "assistant")
            continue;
          const stamp = asRecord2(message["time"]);
          const created = asCount2(stamp?.["created"]);
          if (created === undefined)
            continue;
          const completed = asCount2(stamp?.["completed"]);
          const streamed = asCount2(stamp?.["streamed"]);
          const end = completed ?? (live ? now : streamed ?? created);
          if (!Number.isFinite(end))
            continue;
          const output = asRecord2(message["tokens"])?.["output"];
          spans.push({
            key: turnKey(message["id"], created, completed, output, streamed),
            start: created,
            end: Math.max(created, end)
          });
        }
      }
      return spans;
    } catch {
      return [];
    }
  };
  const knows = (sessionID) => {
    try {
      return context.data.session.get(sessionID) !== undefined;
    } catch {
      return false;
    }
  };
  const activeTime = createActiveTime({ spansOf, knows });
  const sessionElapsed = (sessionID, now = Date.now()) => activeTime(sessionID, now);
  return {
    messagesOf,
    treeTotals,
    contextUsage,
    sessionElapsed,
    statusOf,
    recentParts,
    shellsOf,
    lastActivity,
    permsOf,
    busy
  };
}

// src/tui/session-tps.ts
function createTpsReader(context, live, scope = DEFAULT_TPS_SCOPE, realtime) {
  const TPS_CACHE_MS = 1000;
  let hostStamps;
  let tpsCache;
  const tracker = realtime ?? createRealtimeTps(context);
  const scanMessages = (id, now) => {
    let messages;
    try {
      messages = context.data.session.message.list(id) ?? [];
    } catch {
      return { ok: false, assistant: 0, stamped: 0, settled: [] };
    }
    const settled = [];
    let assistant = 0;
    let stamped = 0;
    for (const entry of messages) {
      const message = asRecord2(entry);
      if (message?.["type"] !== "assistant")
        continue;
      assistant += 1;
      const stamp = asRecord2(message["time"]);
      const created = asCount2(stamp?.["created"]);
      const completed = asCount2(stamp?.["completed"]);
      const streamed = asCount2(stamp?.["streamed"]);
      if (created === undefined && completed === undefined && streamed === undefined)
        continue;
      stamped += 1;
      const span = turnSpan(created, completed, streamed, now);
      if (span === undefined)
        continue;
      const tokens = asRecord2(message["tokens"]);
      const output = tokens?.["output"];
      const reasoning = tokens?.["reasoning"];
      const settledTurn = completed !== undefined || streamed !== undefined;
      const key = turnKey(message["id"], created, completed, output, streamed);
      const turn = {
        key: settledTurn ? `${key}:${asCount2(reasoning) ?? "?"}` : key,
        tokens: output,
        reasoning,
        ...span
      };
      if (streamed !== undefined)
        settled.push(turn);
    }
    return { ok: true, assistant, stamped, settled };
  };
  const familyIds = (sessionID) => {
    const ids = [sessionID];
    try {
      for (const id of context.data.session.family(sessionID) ?? []) {
        if (id === sessionID || ids.includes(id))
          continue;
        ids.push(id);
      }
    } catch {}
    return ids;
  };
  const scanScope = (ids, now) => {
    let ok = true;
    let assistant = 0;
    let stamped = 0;
    const settled = [];
    for (const id of ids) {
      const scan = scanMessages(id, now);
      ok = ok && scan.ok;
      assistant += scan.assistant;
      stamped += scan.stamped;
      for (const span of scan.settled)
        settled.push({ ...span, key: `${id} ${String(span.key)}` });
    }
    return { ok, assistant, stamped, settled };
  };
  const recordGeneration = (session) => {
    const tokens = asRecord2(session?.tokens);
    return (asCount2(tokens?.["output"]) ?? 0) + (asCount2(tokens?.["reasoning"]) ?? 0);
  };
  const familyGeneration = (sessionID, session) => {
    let generation = recordGeneration(session);
    let ok = true;
    for (const id of familyIds(sessionID)) {
      if (id === sessionID)
        continue;
      try {
        generation += recordGeneration(context.data.session.get(id));
      } catch {
        ok = false;
      }
    }
    return { ok, generation };
  };
  const computeAvg = (sessionID, session) => {
    const time = asRecord2(session?.time);
    const created = asCount2(time?.["created"]);
    const now = Date.now();
    const scan = hostStamps === false ? { ok: true, assistant: 0, stamped: 0, settled: [] } : scope === "family" ? scanScope(familyIds(sessionID), now) : scanMessages(sessionID, now);
    if (hostStamps === undefined) {
      if (scan.stamped > 0)
        hostStamps = true;
      else if (scan.ok && scan.assistant > 0)
        hostStamps = false;
      else
        return;
    }
    if (hostStamps === true) {
      if (scope === "family" && scan.ok === false)
        return;
      return settledAverageRate(scan.settled);
    }
    const family = scope === "family" ? familyGeneration(sessionID, session) : undefined;
    if (family !== undefined && family.ok === false)
      return;
    const generation = family?.generation ?? recordGeneration(session);
    if (created === undefined && scope === "session") {
      return;
    }
    let genMs = 0;
    try {
      genMs = live?.elapsedMsOf?.(sessionID, now) ?? 0;
    } catch {
      genMs = 0;
    }
    return genMs > 0 ? generation / (genMs / 1000) : undefined;
  };
  const sessionTps = (sessionID, session) => {
    const ids = scope === "family" ? familyIds(sessionID) : [sessionID];
    let rt = 0;
    try {
      rt = tracker.rate(sessionID, ids);
    } catch {
      rt = 0;
    }
    let ttft;
    try {
      ttft = tracker.ttft(ids);
    } catch {
      ttft = undefined;
    }
    const cached = tpsCache;
    if (cached !== undefined && cached.sessionID === sessionID && Date.now() - cached.at < TPS_CACHE_MS) {
      return { rt, avg: cached.avg, ttft };
    }
    const avg = computeAvg(sessionID, session);
    tpsCache = { sessionID, at: Date.now(), avg };
    return { rt, avg, ttft };
  };
  return { sessionTps };
}

// src/tui/index.tsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var tui_default = Plugin.define({
  id: "flight-deck-tui",
  setup(context) {
    const file = loadConfigFile();
    const { config, issues } = resolveConfig(mergeOptions(file.options, context.options));
    const rows = config.sidebar.enabled ? new Set(config.sidebar.rows) : new Set;
    const wants = (name) => rows.has(name);
    if (file.issue !== undefined && file.source !== undefined) {
      console.warn(`[flight-deck] ${file.issue}`);
    }
    const problems = file.issue !== undefined ? [file.issue, ...issues] : issues;
    if (problems.length > 0 && shouldNotify(config.notifications, "config")) {
      const extra = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
      context.ui.toast.show({
        title: "Flight Deck",
        message: `Ignoring invalid config: ${problems[0]}${extra}`,
        variant: "warning"
      });
    }
    const footer = footerLine(config);
    const releases = [];
    const realtime = createRealtimeTps(context);
    const themedLine = (line, copyId) => {
      const style = railLineStyle(config.style, line);
      const lineFg = themeColor(style.color, context.theme);
      const text = /* @__PURE__ */ jsx("text", {
        fg: lineFg,
        attributes: attributeMask(style.attributes) ?? 0,
        wrapMode: line.field === "ses" ? "char" : undefined,
        children: railLineSpans(line, style).map((span) => /* @__PURE__ */ jsx("span", {
          style: { fg: themeColor(span.color, context.theme) },
          children: span.text
        }))
      });
      if (copyId === undefined)
        return text;
      return /* @__PURE__ */ jsx("box", {
        onMouseUp: () => {
          (async () => {
            try {
              const result = await copyToClipboard(context.renderer, copyId);
              const fb = copyFeedback(result, copyId);
              if (fb.ok)
                return;
              if (!shouldNotify(config.notifications, "copy"))
                return;
              context.ui.toast.show({
                title: "Flight Deck",
                message: fb.message,
                variant: fb.variant,
                duration: 1500
              });
            } catch {}
          })();
        },
        children: text
      });
    };
    const reads = createSessionReads(context);
    const {
      messagesOf,
      treeTotals,
      contextUsage,
      sessionElapsed,
      statusOf,
      recentParts,
      shellsOf,
      lastActivity,
      permsOf,
      busy
    } = reads;
    const { projectTotals } = createProjectTotals(context);
    const cautionThreshold = cautionThresholds(config.caution);
    const cautionsOf = (sessionID, now) => detectCautions({
      parts: recentParts(sessionID),
      shells: shellsOf(sessionID),
      now,
      sessionRunning: statusOf(sessionID) === "running",
      lastMessageAt: lastActivity(sessionID),
      thresholds: cautionThreshold
    });
    const { sessionTps } = createTpsReader(context, {
      elapsedMsOf: (id, now) => sessionElapsed(id, now)
    }, config.sidebar.tps.scope, realtime);
    const sparkValues = (sessionID) => {
      const sizes = [];
      for (const entry of messagesOf(sessionID)) {
        const message = asRecord2(entry);
        if (message?.type !== "assistant")
          continue;
        const output = asCount2(asRecord2(message.tokens)?.output);
        if (output === undefined)
          continue;
        sizes.push(output);
      }
      return sizes.slice(-config.layout.sparkWidth);
    };
    const goOption = config.sidebar.footer.go;
    const goPanelEnabled = goOption === true || typeof goOption === "object" && goOption !== null;
    const animated = config.sidebar.enabled && (goPanelEnabled || config.sidebar.rows.some((name) => ANIMATED_FIELDS.some((field) => field === name)));
    let spinnerNeeded = false;
    const ticker = startTicker(context, animated ? config.refresh : 0, () => spinnerNeeded);
    const wantGuard = config.sidebar.enabled && config.sidebar.rows.includes("guard");
    const bridge = wantGuard ? startGuardBridge(context) : undefined;
    const wantGo = config.sidebar.enabled && (config.sidebar.rows.includes("go") || goPanelEnabled);
    const goBridge = wantGo ? startGoBridge(context) : undefined;
    const goPanelLayout = goOption === true ? undefined : typeof goOption === "object" && goOption !== null ? goOption : undefined;
    const goLook = createGoLookReader({ hostOptions: context.options, initial: goPanelLayout });
    const announce = (sessionID) => {
      if (!config.caution.enabled)
        return;
      const top = worstCaution(cautionsOf(sessionID, Date.now()));
      return top === undefined ? undefined : cautionMark(top, config.glyphs);
    };
    const branchOf = (location) => {
      try {
        return context.data.location.vcs.info(location)?.branch?.current;
      } catch {
        return;
      }
    };
    const snapshot = (sessionID) => {
      const location = locationOf(context);
      const session = context.data.session.get(sessionID);
      const isBusy = busy(sessionID);
      spinnerNeeded = wants("status") && isBusy === true;
      const turns = wants("turns") ? messagesOf(sessionID).filter((entry) => asRecord2(entry)?.["type"] === "user").length : undefined;
      const tree = wants("cost") || wants("total") || wants("tokens") || wants("cache") || wants("reasoning") ? treeTotals(sessionID, session?.cost) : undefined;
      return {
        ...session,
        tokens: tree?.tokens ?? session?.tokens,
        caution: wants("caution") ? announce(sessionID) : undefined,
        branch: wants("branch") ? branchOf(location) : undefined,
        tree,
        context: wants("context") ? contextUsage(sessionID, session?.model) : undefined,
        project: wants("project") ? projectTotals(sessionID) : undefined,
        status: wants("status") ? statusOf(sessionID) : undefined,
        busy: isBusy,
        perms: wants("perms") ? permsOf(sessionID) : undefined,
        tps: wants("tps") ? sessionTps(sessionID, session) : undefined,
        spark: wants("spark") ? sparkValues(sessionID) : undefined,
        elapsedMs: wants("elapsed") ? sessionElapsed(sessionID) : undefined,
        turns,
        guard: bridge?.status,
        go: goBridge?.usage,
        sessionId: wants("ses") ? sessionID : undefined,
        frame: ticker?.frame ?? 0
      };
    };
    let watchedSession;
    let toastedKey;
    let watchTimer;
    const toastMs = Math.max(1000, config.refresh > 0 ? config.refresh : 1000);
    if (config.sidebar.enabled && config.caution.enabled && config.caution.toast && shouldNotify(config.notifications, "caution")) {
      watchTimer = setInterval(() => {
        const sessionID = watchedSession;
        if (sessionID === undefined)
          return;
        try {
          const top = worstCaution(cautionsOf(sessionID, Date.now()));
          if (top === undefined || top.severity !== "caution") {
            toastedKey = undefined;
            return;
          }
          if (top.key === toastedKey)
            return;
          toastedKey = top.key;
          context.ui.toast.show({
            title: "Flight Deck",
            message: cautionDetail(top),
            variant: "warning"
          });
        } catch {}
      }, toastMs);
    }
    if (config.sidebar.enabled) {
      releases.push(context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => {
          watchedSession = sessionID;
          bridge?.follow(sessionID);
          ticker?.frame;
          bridge?.status;
          goBridge?.usage;
          const source = snapshot(sessionID);
          const lines = railLines(config, source);
          if (lines.length === 0)
            return null;
          return /* @__PURE__ */ jsx("box", {
            flexDirection: "column",
            children: lines.map((line) => themedLine(line, line.field === "ses" ? sessionID : undefined))
          });
        }
      }));
    }
    if (config.sidebar.enabled && (config.sidebar.footer.lines.length > 0 || goPanelEnabled)) {
      releases.push(context.ui.slot({
        prepend: "sidebar.footer",
        render: () => {
          ticker?.frame;
          const goUsage = goBridge?.usage;
          const goReason = goBridge === undefined ? "no-bridge" : goBridge.reason ?? (goUsage === undefined ? "pending" : undefined);
          const panel = goPanelEnabled ? goPanelLines(goUsage, Date.now(), goLook.current(), ticker?.frame ?? 0, goReason) : [];
          return /* @__PURE__ */ jsxs("box", {
            flexDirection: "column",
            children: [
              config.sidebar.footer.lines.map((text) => themedLine({ text })),
              panel.map((line) => themedLine(line))
            ]
          });
        }
      }));
    }
    if (footer !== undefined) {
      releases.push(context.ui.slot({
        append: "prompt.footer.status",
        render: () => /* @__PURE__ */ jsx("text", {
          fg: themeColor("subdued", context.theme),
          children: footer
        })
      }));
    }
    return () => {
      if (watchTimer !== undefined)
        clearInterval(watchTimer);
      watchTimer = undefined;
      realtime.dispose();
      ticker?.dispose();
      bridge?.dispose();
      goBridge?.dispose();
      for (const release of releases)
        release();
    };
  }
});
export {
  tui_default as default
};
