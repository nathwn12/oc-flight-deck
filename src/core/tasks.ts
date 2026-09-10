export const TASK_STATES = ["queued", "claimed", "running", "review", "blocked", "paused", "done", "failed", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_EVENTS = ["claim", "start", "review", "block", "pause", "resume", "complete", "fail", "cancel", "release", "expire"] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["claimed", "cancelled"],
  claimed: ["running", "queued", "cancelled"],
  running: ["review", "blocked", "paused", "done", "failed", "cancelled", "queued"],
  review: ["running", "done", "blocked", "cancelled"],
  blocked: ["queued", "cancelled"],
  paused: ["running", "queued", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

const TARGET: Record<TaskEvent, TaskState> = {
  claim: "claimed",
  start: "running",
  review: "review",
  block: "blocked",
  pause: "paused",
  resume: "running",
  complete: "done",
  fail: "failed",
  cancel: "cancelled",
  release: "queued",
  expire: "queued",
};

export interface TaskRecord {
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  readonly owner?: string;
  readonly artifact?: string;
  readonly priority: "low" | "normal" | "high";
  readonly contextTokens?: number;
  readonly note?: string;
  readonly updatedAt: number;
}

export type TransitionResult =
  | { readonly ok: true; readonly from: TaskState; readonly to: TaskState; readonly at: number }
  | { readonly ok: false; readonly from: TaskState; readonly to: TaskState; readonly reason: "illegal-transition" | "unknown-state" };

export function canTransition(from: TaskState, to: TaskState): boolean {
  return from in TRANSITIONS && TRANSITIONS[from].includes(to);
}

export function transition(from: TaskState, to: TaskState, at = 0): TransitionResult {
  if (!(from in TRANSITIONS) || !(to in TRANSITIONS)) return { ok: false, from, to, reason: "unknown-state" };
  if (!canTransition(from, to)) return { ok: false, from, to, reason: "illegal-transition" };
  return { ok: true, from, to, at };
}

export function transitionOnEvent(state: TaskState, event: TaskEvent, at = 0): TransitionResult {
  return transition(state, TARGET[event], at);
}

export function isTerminal(state: TaskState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}
