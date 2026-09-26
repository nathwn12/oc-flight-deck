// The Go usage model for the `go` row.
//
// Everything here is pure: no I/O, no timers, no hidden `Date.now()`. The poll
// bridge in ./go.ts owns the clock and the network; this module only turns the
// Zen Go usage payload into the small fixed window model the row renders.
// Keeping it pure is what lets both documented response shapes be exercised
// without a server, and keeps the row renderer a renderer.
//
// The verified live shape, and the older shapes kept as defence in depth,
// because the endpoint is young enough that none is frozen:
//
//   (a) live     — `{ usage: { rolling, weekly, monthly } }`, each window
//                  `{ status, percent, resetsAt }` where `percent` is 0–100 of
//                  the window USED and `resetsAt` is an ISO-8601 string;
//   (b) flat     — rolling/weekly/monthly usage + limit columns, updated-at
//                  timestamps, all siblings at the top level;
//   (c) nested   — `{ usage: { rolling, weekly, monthly } }`, `{ windows: [...] }`,
//                  or a bare array of `{ window, usage, limit, resetAt }` rows.
//
// Values are opaque numbers (integer micro-cents or counts). We never unit-
// convert here: only the ratio is derived, and a ratio needs no unit. A missing
// or non-positive limit leaves `ratio` undefined rather than inventing a
// percentage, so a broken payload can never render as a confident 100%.

import { asRecord, asText } from "./coerce.js";

export interface GoWindow {
  readonly id: "5h" | "1w" | "1m";
  readonly used?: number;
  readonly limit?: number;
  readonly ratio?: number;
  readonly resetAtMs?: number;
  /**
   * Per-window health string. Additive: absent on the older shapes. Passed
   * through only when it is a non-empty string.
   */
  readonly status?: string;
}

export interface GoUsage {
  readonly windows: readonly GoWindow[];
}

/** Canonical order, so the row always renders 5h then 1w then 1m. */
const WINDOW_ORDER: readonly GoWindow["id"][] = ["5h", "1w", "1m"];

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstFinite(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    const value = asFiniteNumber(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Read an absolute instant in milliseconds from either an epoch number or an
 * ISO-8601 string.
 *
 * The verified live payload carries `resetsAt` as an ISO-8601 string, while the
 * older defensive shapes used an epoch number. A string that `Date.parse` cannot
 * read (or that is not a string at all) yields `undefined` rather than a
 * fabricated instant, so a malformed reset never becomes a confident hint.
 */
function asInstantMs(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  if (numeric !== undefined) return numeric;
  const text = asText(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The first candidate that reads as an absolute instant, or `undefined`. */
function firstInstant(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    const value = asInstantMs(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The verified live shape reports usage as `percent`, a number 0–100 of the
 * window already used, rather than a `used`/`limit` pair. `0` is a real fresh
 * window (ratio 0), not a missing value; a non-number such as the string `"79"`
 * is dropped rather than coerced, so a mistyped payload cannot read as usage.
 *
 * A percent above 100 is CLAMPED to a ratio of 1, never rejected. Over-the-limit
 * is precisely the state this row exists to reveal, so dropping the window would
 * hide the worst case; a full dial plus the error tone is the honest read. The
 * ratio is clamped into `[0, 1]` here so no caller has to wonder how full "150%"
 * is, while a negative or non-finite percent is still dropped as garbage.
 */
function ratioFromPercent(value: unknown): number | undefined {
  const percent = asFiniteNumber(value);
  if (percent === undefined || percent < 0) return undefined;
  return Math.min(1, percent / 100);
}

/**
 * Map a window name to one of the three known ids.
 *
 * Names are lowercased and stripped of separators so `5-hour`, `5h`, and
 * `5h_rolling` all land on the same id; an unknown name is dropped so a new
 * server-side window cannot silently masquerade as one the row understands.
 */
function windowIdFrom(value: unknown): GoWindow["id"] | undefined {
  const text = asText(value);
  if (text === undefined) return undefined;
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key.startsWith("rolling") || key === "5h" || key === "5hour" || key === "session") return "5h";
  if (key.startsWith("weekly") || key === "1w" || key === "week" || key === "7d") return "1w";
  if (key.startsWith("monthly") || key === "1m" || key === "month" || key === "30d") return "1m";
  return undefined;
}

/** `used / limit` only when both are known and the limit is strictly positive. */
function ratioOf(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return used / limit;
}

/**
 * Assemble a window from already-extracted parts, omitting rather than
 * fabricating what is unknown. Returns `undefined` when the id is unknown or
 * neither a use nor a limit was readable — a bare timestamp is not a window.
 */
function buildWindow(
  id: GoWindow["id"] | undefined,
  used: number | undefined,
  limit: number | undefined,
  resetAtMs: number | undefined,
  explicitRatio?: number,
  status?: string,
): GoWindow | undefined {
  if (id === undefined) return undefined;
  // An explicit ratio (from `percent`) wins over `used / limit`; `??` keeps a
  // legitimate explicit zero. A window with no use, no limit and no ratio is
  // not a window: a bare timestamp, name or status must not render as one.
  const ratio = explicitRatio ?? ratioOf(used, limit);
  if (used === undefined && limit === undefined && ratio === undefined) return undefined;
  const result: {
    -readonly [K in keyof GoWindow]: GoWindow[K];
  } = { id };
  if (used !== undefined) result.used = used;
  if (limit !== undefined) result.limit = limit;
  if (ratio !== undefined) result.ratio = ratio;
  if (resetAtMs !== undefined) result.resetAtMs = resetAtMs;
  if (status !== undefined) result.status = status;
  return result;
}

/**
 * Normalize one window value: a bare number (count, no known limit) or an
 * object carrying the use/limit/reset columns under any documented name.
 */
function normalizeWindowValue(value: unknown, idHint?: GoWindow["id"]): GoWindow | undefined {
  if (typeof value === "number") {
    // A keyed map may map a window straight to its count. No limit is known,
    // so no ratio — buildWindow leaves it undefined.
    return buildWindow(idHint, asFiniteNumber(value), undefined, undefined);
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = idHint ?? windowIdFrom(record.window) ?? windowIdFrom(record.id) ?? windowIdFrom(record.name);
  const used = firstFinite(record.usage, record.used, record.value, record.current, record.count);
  const limit = firstFinite(record.limit, record.max, record.total, record.cap, record.quota);
  // Only an explicit absolute timestamp becomes `resetAtMs`. `resetInSec` and
  // `resetIn` are relative, and Stage 1 leaves them unhandled on purpose: a
  // relative field read against an unknown clock is worse than no reset hint.
  // An ISO-8601 `resetsAt` (the verified live shape) is accepted alongside the
  // older epoch number.
  const resetAtMs = firstInstant(record.resetAtMs, record.resetsAt, record.resetAt);
  // The verified live shape's `percent` is a usage fraction with no limit pair.
  const ratio = ratioFromPercent(record.percent);
  const status = asText(record.status);
  return buildWindow(id, used, limit, resetAtMs, ratio, status);
}

/**
 * The flat shape's rolling/weekly/monthly columns. The synthetic window id is
 * supplied because the flat payload has no per-window name. Reset columns are
 * not documented for this shape, so only a defensively-named absolute one is
 * read; the `time*Updated` columns are "last updated", not "resets", and are
 * deliberately ignored.
 */
function normalizeFlatWindow(
  top: Record<string, unknown>,
  id: GoWindow["id"],
  usedKey: string,
  limitKey: string,
  prefix: string,
): GoWindow | undefined {
  const used = asFiniteNumber(top[usedKey]);
  const limit = asFiniteNumber(top[limitKey]);
  const resetAtMs = firstInstant(top[`${prefix}ResetAtMs`], top[`${prefix}ResetsAt`], top[`${prefix}ResetAt`]);
  return buildWindow(id, used, limit, resetAtMs);
}

/** Collect windows out of a name-keyed map, e.g. `{ rolling: {...} }`. */
function collectKeyed(record: Record<string, unknown>, push: (window: GoWindow | undefined) => void): void {
  for (const [key, value] of Object.entries(record)) {
    const id = windowIdFrom(key);
    if (id === undefined) continue;
    push(normalizeWindowValue(value, id));
  }
}

/**
 * Normalize untrusted Go usage output, or `undefined` when there is no usable
 * data. Never throws: every field is coerced and everything unrecognized is
 * dropped, so drift degrades to the placeholder instead of the render.
 */
export function normalizeGoUsage(raw: unknown): GoUsage | undefined {
  try {
    const windows: GoWindow[] = [];
    const seen = new Set<GoWindow["id"]>();
    const push = (window: GoWindow | undefined): void => {
      if (window === undefined || seen.has(window.id)) return;
      seen.add(window.id);
      windows.push(window);
    };

    if (Array.isArray(raw)) {
      for (const entry of raw) push(normalizeWindowValue(entry));
    } else {
      const top = asRecord(raw);
      if (top === undefined) return undefined;

      push(normalizeFlatWindow(top, "5h", "rollingUsage", "rollingLimit", "rolling"));
      push(normalizeFlatWindow(top, "1w", "weeklyUsage", "weeklyLimit", "weekly"));
      push(normalizeFlatWindow(top, "1m", "monthlyUsage", "monthlyLimit", "monthly"));

      const usage = asRecord(top.usage);
      if (usage !== undefined) collectKeyed(usage, push);

      const list = top.windows;
      if (Array.isArray(list)) {
        for (const entry of list) push(normalizeWindowValue(entry));
      } else {
        const keyed = asRecord(list);
        if (keyed !== undefined) collectKeyed(keyed, push);
      }

      // A payload that is itself a single unnamed window object.
      if (windows.length === 0) push(normalizeWindowValue(top));
    }

    if (windows.length === 0) return undefined;
    windows.sort((a, b) => WINDOW_ORDER.indexOf(a.id) - WINDOW_ORDER.indexOf(b.id));
    return { windows };
  } catch {
    return undefined;
  }
}

/**
 * Fraction of a window's limit at which the row switches to its error tone.
 *
 * Chosen below 1 so the row warns while there is still headroom to act (an
 * account-wide limit cannot be topped up mid-run), and above the 0.5 midpoint
 * so ordinary use does not read as distress.
 */
export const GO_ERROR_RATIO = 0.9;

/**
 * The per-window status values treated as benign.
 *
 * NOTE: the semantics of `status` are UNVERIFIED — only `"ok"` has been observed
 * live on `GET /zen/go/v1/usage`. An unknown non-empty status is deliberately
 * NOT in this set, so it renders as offending: a quota window that is not
 * reporting `ok` is worth a red dial rather than a silent pass.
 */
export const GO_OK_STATUSES: readonly string[] = ["ok"];

/**
 * The row tone: `error` at or above {@link GO_ERROR_RATIO}, or when a window
 * carries a non-benign status, else `normal`.
 */
export function goTone(window: GoWindow): "error" | "normal" {
  if (window.ratio !== undefined && window.ratio >= GO_ERROR_RATIO) return "error";
  const status = window.status;
  if (status !== undefined && status !== "" && !GO_OK_STATUSES.includes(status)) return "error";
  return "normal";
}

function formatRemaining(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(ms / 86_400_000)}d`;
}

/**
 * A short "time until reset" suffix for the error tone, or `undefined`.
 *
 * Only shown when the window is actually in error and the reset time is a
 * known future instant — a reset hint beside a calm bar is noise, and one in
 * the past would read as a promise already broken.
 */
export function goResetSuffix(window: GoWindow, nowMs: number): string | undefined {
  if (goTone(window) !== "error") return undefined;
  const resetAtMs = window.resetAtMs;
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return undefined;
  const remaining = resetAtMs - nowMs;
  if (remaining <= 0) return undefined;
  return ` · ${formatRemaining(remaining)}`;
}
