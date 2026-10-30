// Server-side due-user refresh orchestrator.
//
// Lets server-side cadence run when no browser is open by iterating users whose
// last refresh attempt is older than `REFRESH_INTERVAL_MS` and triggering the
// same `executeRefreshFlow` path the interactive `POST /api/dashboard/refresh`
// uses.  The orchestrator is purely internal — no public endpoint; it is
// invoked from the scheduled cadence-tick entrypoint
// (`apps/api/src/ops/cadence-tick.mjs`, wired to
// `.github/workflows/cadence-tick.yml`).
//
// Anchor:
//   - The "last refresh attempt" anchor is the existing `_lastCheckedAt`
//     timestamp on the persisted snapshot payload.  It is set at the start of
//     every `executeRefreshFlow` call and persisted on every branch (ran /
//     unchanged / in_flight / error_fallback), so it already matches the
//     "elapsed interval from last attempt" semantics the client heartbeat uses.
//     Reusing it avoids a parallel field with identical write semantics and
//     keeps both interactive and orchestrator refreshes converging on one
//     durable marker.
//   - Legacy snapshots written before `_lastCheckedAt` existed fall back to
//     the row-level `refreshed_at` column so an orchestrator pass still kicks
//     them when they age past the interval.
//
// Enumeration:
//   - The user set is "every row in `dashboard_snapshots`".  Users without a
//     snapshot have no baseline to refresh against — they bootstrap via the
//     interactive dashboard route.  This avoids needing the Supabase admin
//     `listUsers` API for orchestrator runs.

import { REFRESH_INTERVAL_MS } from "../contracts-runtime/index.mjs";

const ORCHESTRATOR_IDENTITY_SOURCE = "orchestrator";
const DASHBOARD_SNAPSHOTS_TABLE = "dashboard_snapshots";

/**
 * Pure due-selection logic.  Takes anchor data per user and returns the user
 * IDs whose elapsed interval has reached `intervalMs`.
 *
 * @param {object} args
 * @param {Array<{ userId: string, lastRefreshAttemptAt: string|null }>} args.users
 * @param {number} [args.now]
 * @param {number} [args.intervalMs]
 * @returns {string[]} due user IDs, preserving input order
 */
export function selectDueUsers({ users, now = Date.now(), intervalMs = REFRESH_INTERVAL_MS } = {}) {
  if (!Array.isArray(users) || users.length === 0) return [];
  const due = [];
  for (const u of users) {
    if (!u || typeof u.userId !== "string" || u.userId.length === 0) continue;
    const ts = typeof u.lastRefreshAttemptAt === "string" ? Date.parse(u.lastRefreshAttemptAt) : NaN;
    // Null/missing/unparseable anchors fall through to "due" so users whose
    // snapshot pre-dates `_lastCheckedAt` still get picked up by the first
    // orchestrator pass after rollout.
    if (!Number.isFinite(ts)) {
      due.push(u.userId);
      continue;
    }
    if (now - ts >= intervalMs) due.push(u.userId);
  }
  return due;
}

/**
 * Extract the per-user anchor rows from `dashboard_snapshots`.  Uses the
 * payload's `_lastCheckedAt` when present, otherwise the row-level
 * `refreshed_at` column (legacy snapshots written before `_lastCheckedAt`
 * existed).
 *
 * Exposed for tests so the anchor-derivation contract can be asserted without
 * mocking the orchestrator end-to-end.
 *
 * @param {object} args
 * @param {object} args.supabase
 * @returns {Promise<{ rows: Array<{ userId: string, lastRefreshAttemptAt: string|null }>, error: object|null }>}
 */
export async function listSnapshotAnchors({ supabase }) {
  const { data, error } = await supabase
    .from(DASHBOARD_SNAPSHOTS_TABLE)
    .select("user_id, payload, refreshed_at");
  if (error) return { rows: [], error };
  const rows = [];
  for (const row of data ?? []) {
    if (!row || typeof row.user_id !== "string" || row.user_id.length === 0) continue;
    const fromPayload = row.payload && typeof row.payload === "object"
      ? row.payload._lastCheckedAt
      : null;
    const fromRefreshedAt = typeof row.refreshed_at === "string" ? row.refreshed_at : null;
    const anchor = typeof fromPayload === "string" && fromPayload.length > 0
      ? fromPayload
      : fromRefreshedAt;
    rows.push({ userId: row.user_id, lastRefreshAttemptAt: anchor });
  }
  return { rows, error: null };
}

/**
 * Server-side orchestrator entrypoint.  Iterates due users and invokes the
 * shared refresh flow per user.  Called from the scheduled cadence-tick
 * entrypoint; this module exposes no HTTP surface of its own.
 *
 * Returns a summary describing the run:
 *   - `candidates` — total snapshot rows inspected
 *   - `due`        — user count that passed the due rule
 *   - `ran`        — refresh invocations that completed (any terminal kind)
 *   - `errors`     — refresh invocations that threw before returning a kind
 *   - `kinds`      — count of each terminal kind ("ran", "unchanged", …)
 *   - `skippedReason` — `"none"` (full run) or a string when the run aborted
 *
 * @param {object} args
 * @param {() => Promise<{ rows: Array<{ userId: string, lastRefreshAttemptAt: string|null }>, error: object|null }>} args.listAnchorsFn
 * @param {(identity: { userId: string, source: string }) => Promise<{ kind: string }>} args.executeRefreshFlowFn
 * @param {number} [args.now]
 * @param {number} [args.intervalMs]
 * @param {string} [args.identitySource] — telemetry tag stamped on each invocation
 */
export async function runDueRefreshes({
  listAnchorsFn,
  executeRefreshFlowFn,
  now = Date.now(),
  intervalMs = REFRESH_INTERVAL_MS,
  identitySource = ORCHESTRATOR_IDENTITY_SOURCE,
} = {}) {
  if (typeof listAnchorsFn !== "function" || typeof executeRefreshFlowFn !== "function") {
    throw new TypeError(
      "[orchestrator] runDueRefreshes requires listAnchorsFn and executeRefreshFlowFn"
    );
  }
  const summary = {
    candidates: 0,
    due: 0,
    ran: 0,
    errors: 0,
    kinds: {},
    skippedReason: "none",
    intervalMs,
    now: new Date(now).toISOString(),
  };

  let listResult;
  try {
    listResult = await listAnchorsFn();
  } catch (err) {
    summary.skippedReason = "list_threw";
    summary.error = err instanceof Error ? err.message : String(err);
    return summary;
  }
  if (listResult?.error) {
    summary.skippedReason = "list_error";
    summary.error = listResult.error?.message ?? String(listResult.error);
    return summary;
  }

  const anchors = Array.isArray(listResult?.rows) ? listResult.rows : [];
  summary.candidates = anchors.length;

  const dueIds = selectDueUsers({ users: anchors, now, intervalMs });
  summary.due = dueIds.length;

  for (const userId of dueIds) {
    try {
      const result = await executeRefreshFlowFn({ userId, source: identitySource });
      summary.ran += 1;
      const kind = typeof result?.kind === "string" ? result.kind : "unknown";
      summary.kinds[kind] = (summary.kinds[kind] ?? 0) + 1;
    } catch {
      summary.errors += 1;
    }
  }

  return summary;
}

export const _internal = {
  DASHBOARD_SNAPSHOTS_TABLE,
  ORCHESTRATOR_IDENTITY_SOURCE,
};
