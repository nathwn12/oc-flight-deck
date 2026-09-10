import { randomUUID } from "node:crypto";
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

interface StateOptions {
  readonly storage: StorageLike;
  readonly config: FlightDeckConfig;
  readonly location: string;
  readonly configPath?: string;
  readonly now?: () => number;
  readonly onUpdate?: (event: { event: string; taskId?: string; sessionId?: string }) => void;
}

const TASK_PREFIX = "fd:task:";
const LEASE_PREFIX = "fd:lease:";
const SESSION_PREFIX = "fd:session:";
const MODEL_PREFIX = "fd:model:";
const CONTROL_KEY = "fd:control";

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

function modelValue(value: unknown): value is { key: string; tps: readonly number[]; ttft: readonly number[]; steps: number; errors: number; costUsd: number } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<{ key: string; tps: readonly number[]; ttft: readonly number[]; steps: number; errors: number; costUsd: number }>;
  return typeof candidate.key === "string" && Array.isArray(candidate.tps) && Array.isArray(candidate.ttft) && typeof candidate.steps === "number" && typeof candidate.errors === "number" && typeof candidate.costUsd === "number";
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
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly leases = new Map<string, Lease>();
  private readonly models = new Map<string, { tps: ReturnType<typeof createRollingWindow<number>>; ttft: ReturnType<typeof createRollingWindow<number>>; steps: number; errors: number; costUsd: number }>();
  private readonly cooldowns = new Map<string, number>();
  private readonly notify?: StateOptions["onUpdate"];
  private paused = false;
  private autopilot: boolean;
  private serial: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(options: StateOptions) {
    this.storage = options.storage;
    this.configPath = options.configPath;
    this.now = options.now ?? Date.now;
    this.location = options.location;
    this.notify = options.onUpdate;
    this.autopilot = options.config.autopilot.enabled;
    this.config = options.config;
  }

  readonly config: FlightDeckConfig;

  async hydrate(): Promise<void> {
    const [tasks, leases, sessions, models, control] = await Promise.all([
      this.scan(TASK_PREFIX),
      this.scan(LEASE_PREFIX),
      this.scan(SESSION_PREFIX),
      this.scan(MODEL_PREFIX),
      this.storage.get(CONTROL_KEY),
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
  }

  async status(): Promise<FlightDeckStatus> {
    await this.flush();
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
      sessions,
      models,
      tasks,
      recommendations,
    };
  }

  async createTask(input: { id?: string; title: string; artifact?: string; priority?: "low" | "normal" | "high"; contextTokens?: number }): Promise<TaskRecord> {
    return this.exclusive(async () => {
      const id = text(input.id) ?? randomUUID();
      if (!text(input.title)) throw new Error("task title is required");
      if (this.tasks.has(id)) throw new Error("task id already exists");
      const artifact = text(input.artifact);
      const contextTokens = integer(input.contextTokens);
      const task: TaskRecord = { id, title: input.title.slice(0, 400), state: "queued", priority: input.priority ?? "normal", updatedAt: this.now(), ...(artifact ? { artifact } : {}), ...(contextTokens !== undefined ? { contextTokens } : {}) };
      this.tasks.set(id, task);
      await this.storage.set(`${TASK_PREFIX}${id}`, task);
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
      this.leases.set(taskId, result.lease);
      this.tasks.set(taskId, next);
      await this.storage.set(`${LEASE_PREFIX}${taskId}`, result.lease);
      await this.storage.set(`${TASK_PREFIX}${taskId}`, next);
      this.emit("task.claimed", taskId, holder);
      return { ok: true, task: next, lease: result.lease };
    });
  }

  async heartbeat(taskId: string, holder: string): Promise<{ ok: boolean; lease?: Lease; reason?: string }> {
    return this.exclusive(async () => {
      const existing = this.leases.get(taskId);
      if (!existing) return { ok: false, reason: "lease-not-found" };
      const result = renewLease(existing, holder, this.now(), this.config.coordination.leaseTtlMs);
      if (!result.ok) return { ok: false, reason: result.reason };
      this.leases.set(taskId, result.lease);
      await this.storage.set(`${LEASE_PREFIX}${taskId}`, result.lease);
      this.emit("task.heartbeat", taskId, holder);
      return { ok: true, lease: result.lease };
    });
  }

  async report(taskId: string, holder: string, outcome: Extract<TaskEvent, "start" | "review" | "block" | "pause" | "resume" | "complete" | "fail" | "release">, note?: string): Promise<{ ok: boolean; task?: TaskRecord; reason?: string }> {
    return this.exclusive(async () => {
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
      await this.storage.set(`${TASK_PREFIX}${taskId}`, next);
      if (result.to === "queued" || isTerminal(result.to)) {
        this.leases.delete(taskId);
        await this.storage.remove(`${LEASE_PREFIX}${taskId}`);
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
    const key = `${runtime.session.provider ?? "unknown"}/${runtime.session.model ?? "unknown"}`;
    const model = this.models.get(key) ?? { tps: createRollingWindow<number>(this.config.history.maxItems), ttft: createRollingWindow<number>(this.config.history.maxItems), steps: 0, errors: 0, costUsd: 0 };
    if (tps !== null) model.tps.push(tps);
    if (runtime.session.costUsd !== null) model.costUsd = Math.max(model.costUsd, runtime.session.costUsd);
    this.models.set(key, model);
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
    if (!this.autopilot || !this.config.autopilot.requeue) return [];
    return this.exclusive(async () => {
      const expired: string[] = [];
      for (const [taskId, lease] of this.leases) {
        if (!isExpired(lease, this.now())) continue;
        const task = this.tasks.get(taskId);
        this.leases.delete(taskId);
        await this.storage.remove(`${LEASE_PREFIX}${taskId}`);
        if (task && !isTerminal(task.state)) {
          const { owner: _owner, ...withoutOwner } = task;
          const next: TaskRecord = { ...withoutOwner, state: "queued", note: "lease expired; requeued", updatedAt: this.now() };
          this.tasks.set(taskId, next);
          await this.storage.set(`${TASK_PREFIX}${taskId}`, next);
          expired.push(taskId);
          this.emit("task.requeued", taskId);
        }
      }
      return expired;
    });
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

  private restoreModel(metric: { key: string; tps: readonly number[]; ttft: readonly number[]; steps: number; errors: number; costUsd: number }): void {
    const model = { tps: createRollingWindow<number>(this.config.history.maxItems), ttft: createRollingWindow<number>(this.config.history.maxItems), steps: metric.steps, errors: metric.errors, costUsd: metric.costUsd };
    for (const value of metric.tps) model.tps.push(value);
    for (const value of metric.ttft) model.ttft.push(value);
    this.models.set(metric.key, model);
  }

  private modelRuntime(session: SessionMetric) {
    const key = `${session.provider ?? "unknown"}/${session.model ?? "unknown"}`;
    const model = this.models.get(key) ?? { tps: createRollingWindow<number>(this.config.history.maxItems), ttft: createRollingWindow<number>(this.config.history.maxItems), steps: 0, errors: 0, costUsd: 0 };
    this.models.set(key, model);
    return model;
  }

  private updatedTask(task: TaskRecord, event: TaskEvent, owner: string): TaskRecord {
    const target: Record<TaskEvent, TaskState> = { claim: "claimed", start: "running", review: "review", block: "blocked", pause: "paused", resume: "running", complete: "done", fail: "failed", cancel: "cancelled", release: "queued", expire: "queued" };
    const result = transition(task.state, target[event], this.now());
    if (!result.ok) throw new Error(result.reason);
    return { ...task, state: result.to, owner, updatedAt: this.now() };
  }

  private artifactIsHeld(taskId: string, artifact: string): boolean {
    const now = this.now();
    return [...this.tasks.values()].some((task) => {
      if (task.id === taskId || task.artifact !== artifact || isTerminal(task.state)) return false;
      const lease = this.leases.get(task.id);
      return lease !== undefined && !isExpired(lease, now);
    });
  }

  private async persistSession(runtime: SessionRuntime): Promise<void> {
    this.queuePersist(`${SESSION_PREFIX}${runtime.session.sessionId}`, runtime.session);
  }

  private async persistModel(session: SessionMetric, model: { tps: ReturnType<typeof createRollingWindow<number>>; ttft: ReturnType<typeof createRollingWindow<number>>; steps: number; errors: number; costUsd: number }): Promise<void> {
    const key = `${session.provider ?? "unknown"}/${session.model ?? "unknown"}`;
    this.queuePersist(`${MODEL_PREFIX}${key}`, { key, tps: model.tps.values(), ttft: model.ttft.values(), steps: model.steps, errors: model.errors, costUsd: model.costUsd });
  }

  private queuePersist(key: string, value: unknown): void {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.storage.set(key, value)).catch(() => undefined);
    this.pendingWrites.set(key, next);
    void next.then(() => {
      if (this.pendingWrites.get(key) === next) this.pendingWrites.delete(key);
    });
  }

  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites.values());
  }

  private async persistControl(): Promise<void> {
    await this.storage.set(CONTROL_KEY, { paused: this.paused, autopilot: this.autopilot });
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
