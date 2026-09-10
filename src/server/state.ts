import { createHash, randomUUID } from "node:crypto";
import { heartbeat as renewLease, isExpired, tryAcquire, type Lease } from "../core/leases.js";
import { recommendLane } from "../core/lanes.js";
import { createStreamMeter, ttftMs, type StreamMeter } from "../core/metrics.js";
import { isTerminal, transition, type TaskEvent, type TaskRecord, type TaskState } from "../core/tasks.js";
import { createRollingWindow, summarize, type ValueSummary } from "../core/summary.js";
import { patchFlightDeckConfigFile } from "../config/patch.js";
import type { FlightDeckConfig } from "../config/schema.js";

export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>;
}

export interface UsageEvent {
  readonly sessionId: string;
  readonly at: number;
  readonly outputTokens: number;
  readonly inputTokens?: number;
  readonly costUsd?: number;
}

export interface StepStart {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly at: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface SessionMetric {
  readonly sessionId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly status: "idle" | "busy" | "retry" | "unknown";
  readonly outputTokens: number;
  readonly inputTokens: number;
  readonly costUsd: number | null;
  readonly tps: number | null;
  readonly ttftMs: number | null;
  readonly updatedAt: number;
  readonly retries: number;
}

export interface ModelMetric {
  readonly key: string;
  readonly tps: ValueSummary;
  readonly ttftMs: ValueSummary;
  readonly steps: number;
  readonly errors: number;
  readonly costUsd: number;
}

export interface FlightDeckStatus {
  readonly location: string;
  readonly paused: boolean;
  readonly autopilot: boolean;
  readonly telemetry: boolean;
  readonly activeWorkers: number;
  readonly blockedWorkers: number;
  readonly queuedTasks: number;
  readonly activeTasks: number;
  readonly aggregateTps: number | null;
  readonly costUsd: number | null;
  readonly persistFailures: number;
  readonly sessions: readonly SessionMetric[];
  readonly models: readonly ModelMetric[];
  readonly tasks: readonly TaskRecord[];
  readonly recommendations: readonly { taskId: string; lane: string; reasons: readonly string[] }[];
}

interface SessionRuntime {
  readonly meter: StreamMeter;
  session: SessionMetric;
  startedAt?: number;
  firstTokenAt?: number;
  ttftRecordedFor?: number;
  messageId?: string;
}

interface ModelRuntime {
  readonly tps: ReturnType<typeof createRollingWindow<number>>;
  readonly ttft: ReturnType<typeof createRollingWindow<number>>;
  steps: number;
  errors: number;
  costUsd: number;
  /** Cumulative cost contributed by each session; the aggregate is their sum. */
  readonly costs: Map<string, number>;
}

interface StateOptions {
  readonly storage: StorageLike;
  readonly config: FlightDeckConfig;
  readonly location: string;
  readonly configPath?: string;
  readonly now?: () => number;
  readonly onUpdate?: (event: { event: string; taskId?: string; sessionId?: string }) => void;
}

/**
 * Storage keys are qualified by a deterministic hash of the location so two
 * Flight Deck instances sharing one storage backend (or reading another
 * project's leftovers) cannot collide on tasks, leases, telemetry, or control
 * state. A truncated SHA-256 keeps the namespace short while making practical
 * collisions negligible.
 */
function locationHash(location: string): string {
  return createHash("sha256").update(location, "utf8").digest("hex").slice(0, 16);
}

/** Deterministic per-location prefix under which this location stores everything, control state included. */
export function storageKeyPrefix(location: string): string {
  return `fd:${locationHash(location)}:`;
}

function taskValue(value: unknown): value is TaskRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TaskRecord>;
  return typeof candidate.id === "string" && typeof candidate.title === "string" && typeof candidate.state === "string" && typeof candidate.updatedAt === "number";
}

function leaseValue(value: unknown): value is Lease {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Lease>;
  return typeof candidate.taskId === "string" && typeof candidate.holder === "string" && typeof candidate.expiresAt === "number" && typeof candidate.epoch === "number";
}

function metricValue(value: unknown): value is SessionMetric {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SessionMetric>;
  return typeof candidate.sessionId === "string" && typeof candidate.status === "string" && typeof candidate.updatedAt === "number";
}

function modelValue(value: unknown): value is { key: string; tps: readonly number[]; ttft: readonly number[]; steps: number; errors: number; costUsd: number; costs?: Record<string, number> } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<{ key: string; tps: readonly number[]; ttft: readonly number[]; steps: number; errors: number; costUsd: number; costs?: Record<string, number> }>;
  return typeof candidate.key === "string" && Array.isArray(candidate.tps) && Array.isArray(candidate.ttft) && typeof candidate.steps === "number" && typeof candidate.errors === "number" && typeof candidate.costUsd === "number" && (candidate.costs === undefined || (typeof candidate.costs === "object" && candidate.costs !== null && !Array.isArray(candidate.costs)));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class FlightDeckState {
  private readonly storage: StorageLike;
  private readonly configPath?: string;
  private readonly now: () => number;
  private readonly location: string;
  private readonly prefix: string;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly leases = new Map<string, Lease>();
  private readonly models = new Map<string, ModelRuntime>();
  private readonly cooldowns = new Map<string, number>();
  private readonly notify?: StateOptions["onUpdate"];
  private paused = false;
  private autopilot: boolean;
  private serial: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private persistFailures = 0;

  constructor(options: StateOptions) {
    this.storage = options.storage;
    this.configPath = options.configPath;
    this.now = options.now ?? Date.now;
    this.location = options.location;
    this.prefix = storageKeyPrefix(options.location);
    this.notify = options.onUpdate;
    this.autopilot = options.config.autopilot.enabled;
    this.config = options.config;
  }

  readonly config: FlightDeckConfig;

  async hydrate(): Promise<void> {
    const [tasks, leases, sessions, models, control] = await Promise.all([
      this.scan(`${this.prefix}task:`),
      this.scan(`${this.prefix}lease:`),
      this.scan(`${this.prefix}session:`),
      this.scan(`${this.prefix}model:`),
      this.storage.get(`${this.prefix}control`),
    ]);
    for (const entry of tasks) if (taskValue(entry.value)) this.tasks.set(entry.value.id, entry.value);
    for (const entry of leases) if (leaseValue(entry.value)) this.leases.set(entry.value.taskId, entry.value);
    for (const entry of sessions) if (metricValue(entry.value)) this.restoreSession(entry.value);
    for (const entry of models) if (modelValue(entry.value)) this.restoreModel(entry.value);
    if (typeof control === "object" && control !== null) {
      const value = control as { paused?: unknown; autopilot?: unknown };
      if (typeof value.paused === "boolean") this.paused = value.paused;
      if (typeof value.autopilot === "boolean") this.autopilot = value.autopilot;
    }
    await this.recoverInterruptedClaims();
  }

  async status(): Promise<FlightDeckStatus> {
    await this.flush();
    await this.pruneHistory();
    const sessions = [...this.sessions.values()].map((runtime) => runtime.session);
    const tasks = [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const activeWorkers = sessions.filter((session) => session.status === "busy" || session.status === "retry").length;
    const aggregate = sessions.map((session) => session.tps).filter((value): value is number => value !== null);
    const recommendations = this.autopilot && this.config.autopilot.recommendations ? tasks.filter((task) => task.state === "queued").map((task) => {
      const recommendation = recommendLane({ taskPriority: task.priority, contextTokens: task.contextTokens });
      return recommendation.ok ? { taskId: task.id, lane: recommendation.lane, reasons: recommendation.reasons } : { taskId: task.id, lane: "balanced", reasons: [recommendation.reason] };
    }) : [];
    const models = [...this.models.entries()].map(([key, value]) => ({ key, tps: summarize(value.tps.values()), ttftMs: summarize(value.ttft.values()), steps: value.steps, errors: value.errors, costUsd: value.costUsd }));
    return {
      location: this.location,
      paused: this.paused,
      autopilot: this.autopilot,
      telemetry: this.config.telemetry.enabled,
      activeWorkers,
      blockedWorkers: tasks.filter((task) => task.state === "blocked").length,
      queuedTasks: tasks.filter((task) => task.state === "queued").length,
      activeTasks: tasks.filter((task) => ["claimed", "running", "review", "paused"].includes(task.state)).length,
      aggregateTps: aggregate.length ? aggregate.reduce((sum, value) => sum + value, 0) : null,
      costUsd: sessions.some((session) => session.costUsd !== null) ? sessions.reduce((sum, session) => sum + (session.costUsd ?? 0), 0) : null,
      persistFailures: this.persistFailures,
      sessions,
      models,
      tasks,
      recommendations,
    };
  }

  async createTask(input: { id?: string; title: string; artifact?: string; priority?: "low" | "normal" | "high"; contextTokens?: number }): Promise<TaskRecord> {
    return this.exclusive(async () => {
      if (!this.config.coordination.enabled) throw new Error("coordination is disabled");
      const id = text(input.id) ?? randomUUID();
      if (!text(input.title)) throw new Error("task title is required");
      if (this.tasks.has(id)) throw new Error("task id already exists");
      const artifact = text(input.artifact);
      const contextTokens = integer(input.contextTokens);
      const task: TaskRecord = { id, title: input.title.slice(0, 400), state: "queued", priority: input.priority ?? "normal", updatedAt: this.now(), ...(artifact ? { artifact } : {}), ...(contextTokens !== undefined ? { contextTokens } : {}) };
      this.tasks.set(id, task);
      await this.storage.set(`${this.prefix}task:${id}`, task);
      this.emit("task.created", id);
      return task;
    });
  }

  async claim(taskId: string, holder: string): Promise<{ ok: boolean; task?: TaskRecord; lease?: Lease; reason?: string }> {
    return this.exclusive(async () => {
      if (!this.config.coordination.enabled) return { ok: false, reason: "coordination-disabled" };
      if (this.paused) return { ok: false, reason: "paused" };
      const task = this.tasks.get(taskId);
      if (!task) return { ok: false, reason: "task-not-found" };
      const existing = this.leases.get(taskId) ?? null;
      if (existing?.holder === holder && !isExpired(existing, this.now())) return { ok: true, task, lease: existing };
      if (task.state !== "queued") return { ok: false, reason: `task-${task.state}` };
      if (task.artifact && this.artifactIsHeld(task.id, task.artifact)) return { ok: false, reason: "artifact-held" };
      const result = tryAcquire(existing, taskId, holder, this.now(), this.config.coordination.leaseTtlMs);
      if (!result.ok) return { ok: false, reason: result.reason };
      const next = this.updatedTask(task, "claim", holder);
      // Persist the task before the lease: a crash in between leaves a requeued
      // task, which hydrate can repair, instead of a lease with no owner.
      this.tasks.set(taskId, next);
      this.leases.set(taskId, result.lease);
      await this.storage.set(`${this.prefix}task:${taskId}`, next);
      await this.storage.set(`${this.prefix}lease:${taskId}`, result.lease);
      this.emit("task.claimed", taskId, holder);
      return { ok: true, task: next, lease: result.lease };
    });
  }

  async heartbeat(taskId: string, holder: string): Promise<{ ok: boolean; lease?: Lease; reason?: string }> {
    return this.exclusive(async () => {
      if (!this.config.coordination.enabled) return { ok: false, reason: "coordination-disabled" };
      const existing = this.leases.get(taskId);
      if (!existing) return { ok: false, reason: "lease-not-found" };
      const result = renewLease(existing, holder, this.now(), this.config.coordination.leaseTtlMs);
      if (!result.ok) return { ok: false, reason: result.reason };
      this.leases.set(taskId, result.lease);
      await this.storage.set(`${this.prefix}lease:${taskId}`, result.lease);
      this.emit("task.heartbeat", taskId, holder);
      return { ok: true, lease: result.lease };
    });
  }

  async report(taskId: string, holder: string, outcome: Extract<TaskEvent, "start" | "review" | "block" | "pause" | "resume" | "complete" | "fail" | "release">, note?: string): Promise<{ ok: boolean; task?: TaskRecord; reason?: string }> {
    return this.exclusive(async () => {
      if (!this.config.coordination.enabled) return { ok: false, reason: "coordination-disabled" };
      const task = this.tasks.get(taskId);
      const lease = this.leases.get(taskId);
      if (!task) return { ok: false, reason: "task-not-found" };
      if (!lease || lease.holder !== holder || isExpired(lease, this.now())) return { ok: false, reason: "not-owner" };
      const result = transition(task.state, outcome === "start" ? "running" : outcome === "review" ? "review" : outcome === "block" ? "blocked" : outcome === "pause" ? "paused" : outcome === "resume" ? "running" : outcome === "complete" ? "done" : outcome === "fail" ? "failed" : "queued", this.now());
      if (!result.ok) return { ok: false, reason: result.reason };
      const owner = result.to === "queued" || isTerminal(result.to) ? undefined : holder;
      const nextNote = text(note) ?? task.note;
      const { owner: _owner, note: _note, ...withoutOptionalState } = task;
      const next: TaskRecord = { ...withoutOptionalState, state: result.to, updatedAt: this.now(), ...(owner ? { owner } : {}), ...(nextNote ? { note: nextNote } : {}) };
      this.tasks.set(taskId, next);
      await this.storage.set(`${this.prefix}task:${taskId}`, next);
      if (result.to === "queued" || isTerminal(result.to)) {
        this.leases.delete(taskId);
        await this.storage.remove(`${this.prefix}lease:${taskId}`);
      }
      this.emit(`task.${outcome}`, taskId, holder);
      return { ok: true, task: next };
    });
  }

  async setPaused(paused: boolean): Promise<FlightDeckStatus> {
    return this.exclusive(async () => {
      this.paused = paused;
      await this.persistControl();
      this.emit(paused ? "fleet.paused" : "fleet.resumed");
      return this.status();
    });
  }

  async setAutopilot(enabled: boolean): Promise<FlightDeckStatus> {
    return this.exclusive(async () => {
      if (this.configPath) await patchFlightDeckConfigFile(this.configPath, ["autopilot", "enabled"], enabled);
      this.autopilot = enabled;
      await this.persistControl();
      this.emit(enabled ? "autopilot.enabled" : "autopilot.disabled");
      return this.status();
    });
  }

  recordStepStart(step: StepStart): void {
    if (!this.config.telemetry.enabled) return;
    const runtime = this.runtime(step.sessionId);
    runtime.startedAt = step.at;
    runtime.firstTokenAt = undefined;
    runtime.ttftRecordedFor = undefined;
    runtime.messageId = step.messageId;
    const { provider: _provider, model: _model, ...withoutModel } = runtime.session;
    runtime.session = { ...withoutModel, ...(step.provider ? { provider: step.provider } : {}), ...(step.model ? { model: step.model } : {}), status: "busy", updatedAt: step.at };
    const model = this.modelRuntime(runtime.session);
    model.steps++;
    void this.persistModel(runtime.session, model);
    void this.persistSession(runtime);
  }

  recordTextDelta(sessionId: string, at: number, messageId?: string): void {
    if (!this.config.telemetry.enabled || !this.config.metrics.ttft) return;
    const runtime = this.runtime(sessionId);
    const firstToken = runtime.firstTokenAt === undefined && (!messageId || !runtime.messageId || messageId === runtime.messageId);
    if (firstToken) runtime.firstTokenAt = at;
    if (firstToken && runtime.startedAt !== undefined) {
      const measured = ttftMs(runtime.firstTokenAt, runtime.startedAt);
      runtime.session = { ...runtime.session, ttftMs: measured, updatedAt: at };
      if (measured !== null && runtime.ttftRecordedFor !== runtime.startedAt) {
        runtime.ttftRecordedFor = runtime.startedAt;
        const model = this.modelRuntime(runtime.session);
        model.ttft.push(measured);
        void this.persistModel(runtime.session, model);
      }
      void this.persistSession(runtime);
    }
  }

  recordUsage(event: UsageEvent): void {
    if (!this.config.telemetry.enabled) return;
    const runtime = this.runtime(event.sessionId);
    const tps = this.config.metrics.tps ? runtime.meter.observe({ outputTokens: event.outputTokens, at: event.at }) : null;
    const costUsd = this.config.metrics.cost && event.costUsd !== undefined ? event.costUsd : runtime.session.costUsd;
    const inputTokens = this.config.metrics.context && event.inputTokens !== undefined ? event.inputTokens : runtime.session.inputTokens;
    runtime.session = { ...runtime.session, outputTokens: event.outputTokens, inputTokens, costUsd, tps: this.config.metrics.tps ? runtime.meter.snapshot().ewmaTps : null, updatedAt: event.at };
    const model = this.modelRuntime(runtime.session);
    if (tps !== null) model.tps.push(tps);
    // Aggregate across sessions: track each session's cumulative cost and add
    // only its delta, so two sessions on one model sum instead of collapsing
    // to the larger one.
    if (runtime.session.costUsd !== null) {
      const previous = model.costs.get(event.sessionId) ?? 0;
      model.costs.set(event.sessionId, runtime.session.costUsd);
      model.costUsd += Math.max(0, runtime.session.costUsd - previous);
    }
    void this.persistModel(runtime.session, model);
    void this.persistSession(runtime);
  }

  recordStatus(sessionId: string, status: SessionMetric["status"], at: number, retries = 0): void {
    if (!this.config.telemetry.enabled) return;
    const runtime = this.runtime(sessionId);
    runtime.session = { ...runtime.session, status, retries: Math.max(runtime.session.retries, retries), updatedAt: at };
    void this.persistSession(runtime);
  }

  recordFailure(sessionId: string, at: number): void {
    if (!this.config.telemetry.enabled) return;
    const runtime = this.runtime(sessionId);
    runtime.session = { ...runtime.session, status: "idle", updatedAt: at };
    const model = this.modelRuntime(runtime.session);
    model.errors++;
    void this.persistModel(runtime.session, model);
    void this.persistSession(runtime);
  }

  onRetry(provider: string, proposedDelay: number, status?: number): number {
    if (!this.autopilot || !this.config.autopilot.backoff || !provider) return proposedDelay;
    const now = this.now();
    if (status === 429 || status === 529 || status === 503) this.cooldowns.set(provider, now + Math.max(1_000, proposedDelay));
    const until = this.cooldowns.get(provider) ?? 0;
    return Math.max(proposedDelay, until > now ? until - now : 0);
  }

  async expireLeases(): Promise<readonly string[]> {
    if (!this.config.coordination.enabled || !this.autopilot || !this.config.autopilot.requeue) return [];
    return this.exclusive(async () => {
      const expired: string[] = [];
      for (const [taskId, lease] of this.leases) {
        if (!isExpired(lease, this.now())) continue;
        const task = this.tasks.get(taskId);
        this.leases.delete(taskId);
        await this.storage.remove(`${this.prefix}lease:${taskId}`);
        if (task && !isTerminal(task.state)) {
          const { owner: _owner, ...withoutOwner } = task;
          const next: TaskRecord = { ...withoutOwner, state: "queued", note: "lease expired; requeued", updatedAt: this.now() };
          this.tasks.set(taskId, next);
          await this.storage.set(`${this.prefix}task:${taskId}`, next);
          expired.push(taskId);
          this.emit("task.requeued", taskId);
        }
      }
      return expired;
    });
  }

  private artifactIsHeld(taskId: string, artifact: string): boolean {
    const now = this.now();
    return [...this.tasks.values()].some((task) => {
      if (task.id === taskId || task.artifact !== artifact || isTerminal(task.state)) return false;
      const lease = this.leases.get(task.id);
      return lease !== undefined && !isExpired(lease, now);
    });
  }

  private updatedTask(task: TaskRecord, event: TaskEvent, owner: string): TaskRecord {
    const target: Record<TaskEvent, TaskState> = { claim: "claimed", start: "running", review: "review", block: "blocked", pause: "paused", resume: "running", complete: "done", fail: "failed", cancel: "cancelled", release: "queued", expire: "queued" };
    const result = transition(task.state, target[event], this.now());
    if (!result.ok) throw new Error(result.reason);
    return { ...task, state: result.to, owner, updatedAt: this.now() };
  }

  private runtime(sessionId: string): SessionRuntime {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionRuntime = {
      meter: createStreamMeter(),
      session: { sessionId, status: "unknown", outputTokens: 0, inputTokens: 0, costUsd: null, tps: null, ttftMs: null, updatedAt: this.now(), retries: 0 },
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private restoreSession(metric: SessionMetric): void {
    const runtime = this.runtime(metric.sessionId);
    runtime.session = metric;
  }

  private restoreModel(metric: { key: string; tps: readonly number[]; ttft: readonly number[]; steps: number; errors: number; costUsd: number; costs?: Record<string, number> }): void {
    const model = this.createModelRuntime();
    model.steps = metric.steps;
    model.errors = metric.errors;
    model.costUsd = metric.costUsd;
    if (metric.costs) for (const [sessionId, cost] of Object.entries(metric.costs)) if (typeof cost === "number") model.costs.set(sessionId, cost);
    for (const value of metric.tps) model.tps.push(value);
    for (const value of metric.ttft) model.ttft.push(value);
    this.models.set(metric.key, model);
  }

  private createModelRuntime(): ModelRuntime {
    return { tps: createRollingWindow<number>(this.config.history.maxItems), ttft: createRollingWindow<number>(this.config.history.maxItems), steps: 0, errors: 0, costUsd: 0, costs: new Map() };
  }

  private modelRuntime(session: SessionMetric): ModelRuntime {
    const key = `${session.provider ?? "unknown"}/${session.model ?? "unknown"}`;
    const model = this.models.get(key) ?? this.createModelRuntime();
    this.models.set(key, model);
    return model;
  }

  /**
   * A crash between the task and lease writes of a claim can leave a task
   * wedged in a held state with no live owner. Repair on hydrate: drop orphaned
   * or inconsistent leases and requeue nonterminal tasks whose lease is
   * missing. Ordinary expired-lease requeue remains opt-in autopilot behavior.
   */
  private async recoverInterruptedClaims(): Promise<void> {
    const now = this.now();
    const requeueExpired = this.autopilot && this.config.autopilot.requeue;
    for (const [taskId, lease] of [...this.leases]) {
      const task = this.tasks.get(taskId);
      const expired = isExpired(lease, now);
      // An expired lease is ordinary stale-work handling and remains opt-in.
      // Inconsistent live state, however, is always repaired so a crash cannot
      // leave a task owned by nobody.
      const stale = !task || task.state === "queued" || isTerminal(task.state) || (!expired && task.owner !== lease.holder) || (expired && requeueExpired);
      if (!stale) continue;
      this.leases.delete(taskId);
      await this.storage.remove(`${this.prefix}lease:${taskId}`);
    }
    for (const task of [...this.tasks.values()]) {
      if (task.state === "queued" || isTerminal(task.state)) continue;
      const lease = this.leases.get(task.id);
      if (lease && (!isExpired(lease, now) || !requeueExpired)) continue;
      const { owner: _owner, ...withoutOwner } = task;
      const next: TaskRecord = { ...withoutOwner, state: "queued", note: "recovered from interrupted claim", updatedAt: now };
      this.tasks.set(task.id, next);
      await this.storage.set(`${this.prefix}task:${task.id}`, next);
    }
  }

  /**
   * Bound retained history: once terminal tasks (or idle/unknown sessions)
   * exceed history.maxItems, drop the oldest — from memory and storage.
   * Active tasks and busy/retry sessions are always preserved. Selection uses
   * in-memory state only, so no storage scan runs unless the cap is exceeded.
   */
  private async pruneHistory(): Promise<void> {
    const cap = this.config.history.maxItems;
    const terminalTasks = [...this.tasks.values()].filter((task) => isTerminal(task.state)).sort((a, b) => a.updatedAt - b.updatedAt);
    const taskVictims = terminalTasks.length > cap ? terminalTasks.slice(0, terminalTasks.length - cap) : [];
    const dormantSessions = [...this.sessions.values()].map((runtime) => runtime.session).filter((session) => session.status === "idle" || session.status === "unknown").sort((a, b) => a.updatedAt - b.updatedAt);
    const sessionVictims = dormantSessions.length > cap ? dormantSessions.slice(0, dormantSessions.length - cap) : [];
    if (!taskVictims.length && !sessionVictims.length) return;
    const removals: Promise<void>[] = [];
    for (const victim of taskVictims) {
      const current = this.tasks.get(victim.id);
      if (!current || current.state !== victim.state || current.updatedAt !== victim.updatedAt) continue;
      this.tasks.delete(victim.id);
      removals.push(this.storage.remove(`${this.prefix}task:${victim.id}`));
    }
    for (const victim of sessionVictims) {
      const current = this.sessions.get(victim.sessionId)?.session;
      if (!current || (current.status !== "idle" && current.status !== "unknown") || current.updatedAt !== victim.updatedAt) continue;
      this.sessions.delete(victim.sessionId);
      removals.push(this.storage.remove(`${this.prefix}session:${victim.sessionId}`));
    }
    await Promise.all(removals);
  }

  private async persistSession(runtime: SessionRuntime): Promise<void> {
    this.queuePersist(`${this.prefix}session:${runtime.session.sessionId}`, runtime.session);
  }

  private async persistModel(session: SessionMetric, model: ModelRuntime): Promise<void> {
    const key = `${session.provider ?? "unknown"}/${session.model ?? "unknown"}`;
    this.queuePersist(`${this.prefix}model:${key}`, { key, tps: model.tps.values(), ttft: model.ttft.values(), steps: model.steps, errors: model.errors, costUsd: model.costUsd, costs: Object.fromEntries(model.costs) });
  }

  private queuePersist(key: string, value: unknown): void {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.storage.set(key, value)).catch(() => {
      this.persistFailures++;
    });
    this.pendingWrites.set(key, next);
    void next.then(() => {
      if (this.pendingWrites.get(key) === next) this.pendingWrites.delete(key);
    });
  }

  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites.values());
  }

  private async persistControl(): Promise<void> {
    await this.storage.set(`${this.prefix}control`, { paused: this.paused, autopilot: this.autopilot });
  }

  private async scan(prefix: string): Promise<readonly { key: string; value: unknown }[]> {
    const entries: { key: string; value: unknown }[] = [];
    let after: string | undefined;
    do {
      const page = await this.storage.scan({ prefix, after, limit: 256 });
      entries.push(...page.entries);
      after = page.next;
    } while (after);
    return entries;
  }

  private emit(event: string, taskId?: string, sessionId?: string): void {
    this.notify?.({ event, taskId, sessionId });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
