// Live session readouts for the Flight Deck rail.
//
// Everything here is derived from state the host already holds in memory and
// hands to the plugin. There is no network call, no server, and no storage
// write: this module turns a session snapshot into strings.
//
// The implementation is split by responsibility: ./stat-fields.js holds the
// vocabulary, ./coerce.js the coercion guards, ./format.js the short strings
// and glyph strips, ./guard-tokens.js the guard token, ./throughput.js the
// rates, and ./rows.js the row rendering. This module re-exports the same
// public surface it has always had.

export { clip, formatCost, formatCount, formatDuration, fuelBar, sparkline } from "./format.js";
export { statLine, statRows, statSegments } from "./rows.js";
export type { StatSegment } from "./rows.js";
export { ANIMATED_FIELDS, DEFAULT_PLACEHOLDER, STAT_FIELDS, isStatField } from "./stat-fields.js";
export type { StatSource } from "./stat-fields.js";
export {
  createInstantTps,
  instantTpsRate,
  sessionThroughput,
  smoothTpsRate,
  TPS_EWMA_ALPHA,
  TPS_MIN_GEN_MS,
  TPS_MIN_TOKENS,
  TPS_REPAINT_ABS,
  TPS_REPAINT_RATIO,
  tpsNeedsRepaint,
  turnKey,
  turnSpan,
  unionOutputTotals,
  unionSpanMs,
  unionSpanThroughput,
  unionSpanTotals,
} from "./throughput.js";
export type { SpanEndPreference, SpanTotals, ThroughputSpan } from "./throughput.js";
