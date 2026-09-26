// The rail's stat vocabulary.
//
// `StatSource` is the subset of a session snapshot the rail reads; `STAT_FIELDS`
// is the set a user may name in `sidebar.rows`; `ANIMATED_FIELDS` drives the
// ticker; `LayoutHint` carries per-call row geometry. Untrusted values are read
// through ./coerce.js rather than re-checked here.

import type { DurationStyle } from "./format.js";

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
  /**
   * Session throughput. On a host that stamps its messages this is an
   * active-work average: output tokens divided by the union of the assistant
   * turns' own spans, subagents summed in, so idle between turns is not
   * counted and the figure freezes when work stops. On a host without message
   * timestamps it falls back to the lifetime average, which can still sag.
   * Either way it is derived from state the host already holds.
   */
  readonly tps?: unknown;
  readonly elapsedMs?: unknown;
  readonly turns?: unknown;
  /** Recent per-turn output sizes, oldest first, for the sparkline. */
  readonly spark?: unknown;
  /** Animation frame counter, advanced by the ticker. */
  readonly frame?: unknown;
  /** Harness status from oc-harness-guard's RPC, via the guard bridge. Untrusted. */
  readonly guard?: unknown;
  /**
   * Zen Go account usage, read from the go bridge's host store. Untrusted on
   * principle: the row re-validates the window shape rather than trusting the
   * type across the module boundary.
   */
  readonly go?: unknown;
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
  "guard",
  "go",
] as const;

type StatField = (typeof STAT_FIELDS)[number];

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
  return STAT_FIELDS.some((field) => field === value);
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
   * How the `elapsed` row joins its duration segments. The rail supplies this
   * from `format.duration` (default `"spaced"`); when the hint is absent the
   * formatter's own default, `"compact"`, applies.
   */
  readonly durationStyle?: DurationStyle;
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
  /**
   * The clock the `go` row reads its relative reset hint against.
   *
   * An explicit instant rather than a hidden `Date.now()` inside the renderer,
   * so a flagged window's "resets in 41m" is a pure function of its inputs and
   * the row stays testable without freezing time. Absent means `Date.now()`.
   */
  readonly nowMs?: number;
}

/** Placeholder value for a persistent row with no data yet. */
export const DEFAULT_PLACEHOLDER = "—";

export const DEFAULT_LABEL_WIDTH = 10;
export const DEFAULT_SPARK_WIDTH = 12;

