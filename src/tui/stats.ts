// Live session readouts for the Flight Deck rail.
//
// Everything here is derived from state the host already holds in memory and
// hands to the plugin. This module itself makes no network call, no server,
// and no storage write: it turns a session snapshot into strings. The opt-in
// `go` row and `sidebar.footer.go` panel live outside this module (./go.ts):
// enabling either polls https://opencode.ai/zen/go/v1/usage every 60 seconds,
// and only with FLIGHT_DECK_GO_LOG=1 appends one observation line per poll to
// tmpdir()/opencode/flight-deck-go.log (never the key).
//
// The implementation is split by responsibility: ./stat-fields.js holds the
// vocabulary, ./coerce.js the coercion guards, ./format.js the short strings
// and glyph strips, ./guard-tokens.js the guard token, ./throughput.js the
// rates, and ./rows.js the row rendering. This module re-exports the same
// public surface it has always had.

export { clip, formatCost, formatCount, formatDuration, fuelBar, sparkline } from "./format.js";
export { statLine, statRows, statSegments } from "./rows.js";
export type { StatSegment } from "./rows.js";
export { ANIMATED_FIELDS, DEFAULT_PLACEHOLDER, STAT_FIELDS, canonicalField, fieldLabel, isStatField, skeletonValue } from "./stat-fields.js";
export type { StatSource } from "./stat-fields.js";
export {
  settledAverageRate,
  smoothTpsRate,
  TPS_EWMA_ALPHA,
  TPS_REPAINT_ABS,
  TPS_REPAINT_RATIO,
  tpsNeedsRepaint,
  turnKey,
  turnSpan,
  unionSpanMs,
  unionSpanTotals,
} from "./throughput.js";
export type { SpanTotals, ThroughputSpan } from "./throughput.js";
export {
  createRealtimeTps,
  estimateDeltaTokens,
  RT_MAX_SESSIONS,
  RT_SAMPLE_WINDOW_MS,
  RT_STALE_MS,
} from "./realtime-tps.js";
export type { RealtimeTps } from "./realtime-tps.js";
