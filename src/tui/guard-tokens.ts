// Guard-token rendering for the `guard` row.
//
// The harness-guard RPC payload is untrusted: these helpers turn it into one
// short ASCII token, or `undefined` when there is nothing usable to show. They
// live here rather than in ./rows.js so the row renderer stays rendering.

import { asRecord } from "./coerce.js";
import { formatCount } from "./format.js";

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
export function guardToken(value: unknown): string | undefined {
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
