// Process-local refresh job registry (Slice 5).
//
// A tiny, deterministic, in-memory progress tracker for the cold-start refresh
// flow.  The onboarding handoff (later slices) starts a job, advances its phase
// as the pipeline moves through ingestion → matching → clustering, and marks it
// terminal so a polling client can render progress.  This slice ships the
// registry + tests ONLY — no route wiring yet.
//
// Locked contract for this slice:
//   - jobId strategy: `jobId === userId` (one in-flight-or-latest job per user).
//   - retention: keep the latest state until the SAME user's next `createJob`
//     overwrites it — no TTL, no timers, no eviction.
//   - status: `running | done | failed`
//   - phase:  `ingesting | matching | clustering | done`
//
// Storage is a single module-scoped Map (process-local, not shared across
// instances) and deterministic — `_resetRefreshJobs()` clears it for tests.

export const JOB_STATUS = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
});

export const JOB_PHASE = Object.freeze({
  INGESTING: "ingesting",
  MATCHING: "matching",
  CLUSTERING: "clustering",
  DONE: "done",
});

// Phases a job may move through WHILE running (the terminal `done` phase is set
// only by `completeJob`, never via `setPhase`).
const RUNNING_PHASES = new Set([
  JOB_PHASE.INGESTING,
  JOB_PHASE.MATCHING,
  JOB_PHASE.CLUSTERING,
]);

/** @type {Map<string, object>} normalized userId → job */
const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalize a userId/jobId map key: require a non-empty string and trim it so
 * `" user-1 "` and `"user-1"` address the same job.  Throws otherwise.  `label`
 * names the caller for a clear error message.
 */
function normalizeKey(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}: a non-empty userId/jobId is required`);
  }
  return value.trim();
}

// Return a defensive shallow copy so callers can't mutate registry internals.
function cloneJob(job) {
  return { ...job };
}

/**
 * Start (or overwrite) the refresh job for `userId`.  Throws on a missing/empty
 * userId so we never register an unkeyed job.  Always returns a fresh `running`
 * job at the initial `ingesting` phase, replacing any prior (including terminal)
 * state for that user.
 */
export function createJob(userId) {
  const key = normalizeKey(userId, "createJob");
  const ts = nowIso();
  const job = {
    jobId: key,
    userId: key,
    status: JOB_STATUS.RUNNING,
    phase: JOB_PHASE.INGESTING,
    storyCount: null,
    failureReason: null,
    startedAt: ts,
    updatedAt: ts,
    finishedAt: null,
  };
  jobs.set(key, job);
  return cloneJob(job);
}

/**
 * Return a defensive copy of the stored job for `jobId` (=== userId) or `null`.
 * Null-safe read: a missing/non-string/blank id (or an unknown job) yields
 * `null` rather than throwing — only the mutating APIs validate strictly.
 */
export function getJob(jobId) {
  if (typeof jobId !== "string" || jobId.trim() === "") return null;
  const job = jobs.get(jobId.trim());
  return job ? cloneJob(job) : null;
}

/**
 * Advance a RUNNING job to one of the running phases (`ingesting | matching |
 * clustering`).  Throws when the job is missing, already terminal, or the phase
 * is not a valid running phase — fail-fast so a caller can't silently desync a
 * progress display from the pipeline.
 */
export function setPhase(jobId, phase) {
  const key = normalizeKey(jobId, "setPhase");
  const job = jobs.get(key);
  if (!job) {
    throw new Error(`setPhase: no job for jobId "${key}"`);
  }
  if (job.status !== JOB_STATUS.RUNNING) {
    throw new Error(`setPhase: job "${key}" is not running (status=${job.status})`);
  }
  if (!RUNNING_PHASES.has(phase)) {
    throw new Error(`setPhase: invalid running phase "${phase}"`);
  }
  job.phase = phase;
  job.updatedAt = nowIso();
  return cloneJob(job);
}

/**
 * Mark a job terminal.  `ok=true` → `done` (optional `storyCount`); `ok=false`
 * → `failed` with `failureReason`.  Either way the phase is set to the terminal
 * `done` for uniformity and `finishedAt` is stamped.  Throws when the job is
 * missing.
 */
export function completeJob(jobId, { ok, storyCount = null, failureReason = null } = {}) {
  const key = normalizeKey(jobId, "completeJob");
  // Contract tightening: `ok` is the terminal verdict and must be an explicit
  // boolean — a missing/non-boolean value would silently mark a job done.
  if (typeof ok !== "boolean") {
    throw new Error("completeJob: `ok` must be a boolean");
  }
  const job = jobs.get(key);
  if (!job) {
    throw new Error(`completeJob: no job for jobId "${key}"`);
  }
  const ts = nowIso();
  job.status = ok ? JOB_STATUS.DONE : JOB_STATUS.FAILED;
  // Terminal uniformity: both done and failed land on the `done` phase so a
  // poller can treat "phase === done" as "stop polling".
  job.phase = JOB_PHASE.DONE;
  job.storyCount = ok ? storyCount : null;
  job.failureReason = ok ? null : failureReason;
  job.updatedAt = ts;
  job.finishedAt = ts;
  return cloneJob(job);
}

/**
 * Test-only: clear the in-memory registry so suites stay isolated.
 */
export function _resetRefreshJobs() {
  jobs.clear();
}
