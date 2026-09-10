export interface UiSession {
  readonly sessionId?: string;
  readonly status?: string;
  readonly tps?: number | null;
  readonly ttftMs?: number | null;
  readonly costUsd?: number | null;
}

export interface UiTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
}

export interface UiStatus {
  readonly location?: string;
  readonly activeWorkers?: number;
  readonly blockedWorkers?: number;
  readonly queuedTasks?: number;
  readonly activeTasks?: number;
  readonly aggregateTps?: number | null;
  readonly costUsd?: number | null;
  readonly persistFailures?: number;
  readonly autopilot?: boolean;
  readonly paused?: boolean;
  readonly sessions?: readonly UiSession[];
  readonly tasks?: readonly UiTask[];
}

export interface UiVisibility {
  readonly enabled?: boolean;
  readonly tps: boolean;
  readonly ttft: boolean;
  readonly cost: boolean;
  readonly context: boolean;
  readonly compact: boolean;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatTps(value: number | null | undefined): string {
  const actual = number(value);
  return actual === null ? "-- tok/s" : `${actual < 100 ? actual.toFixed(1) : Math.round(actual)} tok/s`;
}

export function formatTtft(value: number | null | undefined): string {
  const actual = number(value);
  return actual === null ? "-- TTFT" : `${actual >= 1000 ? `${(actual / 1000).toFixed(1)}s` : `${Math.round(actual)}ms`} TTFT`;
}

export function contextPercent(used: number | null | undefined, limit: number | null | undefined): number | null {
  const actualUsed = number(used);
  const actualLimit = number(limit);
  if (actualUsed === null || actualLimit === null || actualUsed < 0 || actualLimit <= 0) return null;
  return Math.min(100, (actualUsed / actualLimit) * 100);
}

export function formatFooter(session: UiSession | undefined, visibility: UiVisibility, contextPercent?: number | null): string {
  if (!session) return "Flight Deck: waiting";
  const parts: string[] = [];
  if (visibility.tps) parts.push(`⚡ ${formatTps(session.tps).replace(" tok/s", "")}`);
  if (visibility.ttft) parts.push(formatTtft(session.ttftMs));
  if (visibility.cost) parts.push(`$${number(session.costUsd) === null ? "--" : (number(session.costUsd) as number).toFixed(3)}`);
  if (visibility.context) parts.push(`ctx ${number(contextPercent) === null ? "--" : `${Math.round(contextPercent!)}%`}`);
  return parts.join(" · ");
}

export function sidebarVisible(status: UiStatus | null, mode: "always" | "auto" | "hidden"): boolean {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  return status !== null && ((status.activeWorkers ?? 0) > 0 || (status.blockedWorkers ?? 0) > 0 || (status.queuedTasks ?? 0) > 0 || (status.activeTasks ?? 0) > 0);
}

export function formatSidebar(status: UiStatus | null, compact: boolean): string[] {
  if (!status) return ["FLIGHT DECK", "connecting…"];
  const lines = [
    "FLIGHT DECK",
    `● ${status.activeWorkers ?? 0} active   ${status.blockedWorkers ?? 0} blocked`,
    `⚡ ${formatTps(status.aggregateTps).replace(" tok/s", "")} aggregate`,
  ];
  const persistFailures = number(status.persistFailures);
  if (persistFailures !== null && persistFailures > 0) lines.push(`⚠ ${persistFailures} persistence failures`);
  if (!compact) {
    lines.push(`▣ ${status.queuedTasks ?? 0} queued   ${status.activeTasks ?? 0} working`);
    lines.push(`$${number(status.costUsd) === null ? "--" : (number(status.costUsd) as number).toFixed(3)} observed`);
    lines.push(status.paused ? "Fleet: paused" : status.autopilot ? "Autopilot: ON" : "Autopilot: off");
  }
  return lines;
}

export function formatTasks(tasks: readonly UiTask[] | undefined): string[] {
  return (tasks ?? []).slice(0, 12).map((task) => `${task.state.padEnd(9)} ${task.id.slice(0, 8)} ${task.title}`);
}
