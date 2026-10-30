// Per-user in-flight refresh guard.
//
// Single-process Map<userId, Promise> tracking active refreshes.  When a
// concurrent POST /api/dashboard/refresh arrives for a userId already in the
// map, we skip starting a second pipeline run and return the current snapshot
// with `_meta.refreshSkippedReason = "in_flight"`.
//
// ─── Scope & known limitation ────────────────────────────────────────────────
// SCOPE: this guard is **process-local** — its state lives in the current
// Node.js process's heap and does NOT span multiple app instances.
//
// Sufficient for:
//   - Single-instance MVP / prototype deployments (current Tempo target).
//   - Local dev, single-Vercel-function-instance runs, single-container hosts.
//
// NOT sufficient for:
//   - Multi-instance / horizontally-scaled deployments.  Two replicas can each
//     start a refresh for the same user concurrently because their guard maps
//     are independent.  In that case the only guarantees we keep are:
//       (a) Phase 4 watermark short-circuit — the second run will short-circuit
//           if the first already updated the snapshot watermark.
//       (b) Rejection-log dedup key — duplicate writes collapse on
//           (user_id, dedup_key).
//     But the second clustering call may still run, costing money.
//
// Future hardening (out of scope for Phase 4):
//   - Distributed lock via Redis (`SET NX EX`) or Supabase advisory lock.
//   - Track via `tryAcquireRefreshLock(userId, ttl)` returning a release token.
//
// Telemetry surfaces this scope as `refreshGuardScope: "process_local"` so
// operators can spot multi-instance contention if/when it lands.

/** Telemetry/log marker for the current guard implementation. */
export const REFRESH_GUARD_SCOPE = "process_local";

const inFlight = new Map();

/**
 * Register the start of a refresh for `userId`.  Returns true if the slot
 * was free (caller should proceed); false if a refresh is already running.
 */
export function tryAcquire(userId) {
  if (!userId) return true; // unknown userId — don't block (defensive)
  if (inFlight.has(userId)) return false;
  inFlight.set(userId, true);
  return true;
}

/**
 * Mark the refresh for `userId` complete.  Always call from a `finally` so
 * the guard releases even if the route handler throws.
 */
export function release(userId) {
  if (!userId) return;
  inFlight.delete(userId);
}

/** Returns true when a refresh is currently in flight for `userId`. */
export function isInFlight(userId) {
  return !!userId && inFlight.has(userId);
}

/** Test-only: clear all in-flight markers.  Do not use in production code paths. */
export function _resetInFlight() {
  inFlight.clear();
}
