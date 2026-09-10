export const LANES = ["fast", "balanced", "careful"] as const;
export type Lane = (typeof LANES)[number];

export interface LaneInputs {
  readonly tps?: number | null;
  readonly ttftMs?: number | null;
  readonly taskPriority?: "low" | "normal" | "high";
  readonly contextTokens?: number | null;
  readonly errorRate?: number | null;
  readonly retries?: number | null;
}

export type LaneRecommendation =
  | { readonly ok: true; readonly lane: Lane; readonly reasons: readonly string[]; readonly evidenceUsed: readonly string[] }
  | { readonly ok: false; readonly reason: "insufficient-evidence" };

export function recommendLane(inputs: LaneInputs): LaneRecommendation {
  const evidenceUsed = (["taskPriority", "contextTokens", "errorRate", "retries"] as const).filter((key) => inputs[key] !== undefined && inputs[key] !== null);
  if (evidenceUsed.length === 0) return { ok: false, reason: "insufficient-evidence" };
  const reasons: string[] = [];
  let lane: Lane = "balanced";
  const errorRate = typeof inputs.errorRate === "number" && inputs.errorRate >= 0 && inputs.errorRate <= 1 ? inputs.errorRate : null;
  const retries = typeof inputs.retries === "number" && inputs.retries >= 0 ? inputs.retries : null;
  if (errorRate !== null && errorRate > 0.2) { lane = "careful"; reasons.push(`error rate ${errorRate.toFixed(2)}`); }
  if (retries !== null && retries >= 2) { lane = "careful"; reasons.push(`${retries} retries`); }
  if (typeof inputs.contextTokens === "number" && inputs.contextTokens > 100_000 && lane !== "careful") { lane = "careful"; reasons.push("large context"); }
  if (inputs.taskPriority === "high" && lane !== "careful") { lane = "fast"; reasons.push("high priority"); }
  if (inputs.taskPriority === "low") reasons.push("low priority");
  if (typeof inputs.tps === "number" && Number.isFinite(inputs.tps)) reasons.push(`throughput ${inputs.tps.toFixed(1)} tok/s (context only)`);
  if (typeof inputs.ttftMs === "number" && Number.isFinite(inputs.ttftMs)) reasons.push(`TTFT ${inputs.ttftMs.toFixed(0)} ms (context only)`);
  if (reasons.length === 0) reasons.push("balanced default");
  return { ok: true, lane, reasons, evidenceUsed };
}
