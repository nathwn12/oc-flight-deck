export interface Lease {
  readonly taskId: string;
  readonly holder: string;
  readonly expiresAt: number;
  readonly epoch: number;
}

export type LeaseResult =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly reason: "held" | "expired" | "not-holder" | "invalid-ttl" | "invalid-input" };

export function isExpired(lease: Lease, now: number): boolean {
  return now >= lease.expiresAt;
}

export function tryAcquire(existing: Lease | null, taskId: string, holder: string, now: number, ttlMs: number): LeaseResult {
  if (!taskId || !holder || !Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return { ok: false, reason: "invalid-input" };
  if (existing && existing.taskId !== taskId) return { ok: false, reason: "invalid-input" };
  if (existing && !isExpired(existing, now)) return { ok: false, reason: "held" };
  return { ok: true, lease: { taskId, holder, expiresAt: now + ttlMs, epoch: (existing?.epoch ?? 0) + 1 } };
}

export function heartbeat(lease: Lease, holder: string, now: number, ttlMs: number): LeaseResult {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return { ok: false, reason: "invalid-ttl" };
  if (lease.holder !== holder) return { ok: false, reason: "not-holder" };
  if (isExpired(lease, now)) return { ok: false, reason: "expired" };
  return { ok: true, lease: { ...lease, expiresAt: now + ttlMs, epoch: lease.epoch + 1 } };
}
