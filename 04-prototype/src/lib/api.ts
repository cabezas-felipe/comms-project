import {
  dashboardPayloadSchema,
  dashboardSelectionMetaSchema,
  type DashboardPayload,
  type DashboardSelectionMeta,
} from "@tempo/contracts";
import { supabase } from "./supabase";
import { getProtoSession } from "./auth";
import { isE2EIdentityOverrideEnabled } from "./e2e-identity";

export interface DashboardFetchResult {
  payload: DashboardPayload;
  selection: DashboardSelectionMeta | null;
  /**
   * ISO-8601 timestamp lifted from `_meta.refreshedAt`. `null` when the
   * backend omits it or supplies a value that does not parse as a Date.
   * Parsed defensively off the raw response — not part of the contract
   * schema — so older/forward responses can't break dashboard fetches.
   */
  refreshedAt: string | null;
  /**
   * ISO-8601 timestamp lifted from `_meta.lastCheckedAt`.  Distinct from
   * `refreshedAt`: this is the last time the server *checked* the user's
   * feeds (advances on every refresh attempt, including no-ops like
   * watermark short-circuits and in-flight skips).  `refreshedAt` only
   * advances when a new snapshot is written.  `null` when the response is
   * from an older API that doesn't carry the field — callers should fall
   * back to `refreshedAt` for display.
   */
  lastCheckedAt: string | null;
  /**
   * Clustering fail-closed diagnostics lifted from `_meta` (Slice 1 server
   * contract).  When `clusteringFailed` is true the refresh succeeded HTTP-wise
   * but clustering failed after its retry, so the backend published zero
   * meta-stories on purpose — the UI must distinguish this from a quiet beat.
   *
   * `clusteringFailed` is derived from `_meta.usedFallbackClustering === true`
   * (note: the server field name is retained for back-compat; its semantics are
   * "clustering failed → 0 stories", NOT "degraded buckets shipped").  Parsed
   * defensively off the raw `_meta` — never schema-validated — so older or
   * forward responses can't break dashboard fetches.
   */
  clusteringFailed: boolean;
  clusteringFailureReason: "timeout" | "error" | null;
  clusteringAttempts: number | null;
  /** Per-attempt clustering latency (ms). Optional for the UI; null when absent/malformed. */
  clusteringLatencyMs: number[] | null;
  /**
   * Funnel stage counts lifted from `_meta.funnel` (Slice 3, dev/manual-E2E
   * aid only). Lets the debug diagnostics panel show where a thin/empty
   * dashboard collapsed without reading server logs. `null` when absent.
   */
  funnel: DashboardFunnelMeta | null;
  /**
   * Recall summary lifted from `_meta.recall` (Slice 3, dev aid). `null` when
   * absent. Parsed defensively — never schema-validated.
   */
  recall: DashboardRecallMeta | null;
  /**
   * Slice 5: progressive `whyItMatters` enrichment state lifted from
   * `_meta.whyEnrichment`. On an interactive first paint this is
   * `{ deferred: true, pending: N, ... }` — the dashboard polls until
   * `pending === 0` and patches story cards in place. `null` when the backend
   * omits it (older API / non-deferred run) — callers treat null as
   * "nothing pending". Parsed defensively; never schema-validated.
   */
  whyEnrichment: DashboardWhyEnrichmentMeta | null;
  /**
   * C1: split-healer (A3) run diagnostics lifted from `_meta.clusterSplit`
   * (split/defer counts + reasons + bundling). Dev/debug aid only; `null` when
   * absent. Parsed defensively — never schema-validated, never gates behavior.
   */
  clusterSplit: DashboardClusterSplitMeta | null;
  /**
   * C1: overflow cap (A4) diagnostics lifted from `_meta.overflowCap` (whether
   * the post-healer max-5 cap trimmed stories + which were dropped). `null` when
   * absent. Defensive parse.
   */
  overflowCap: DashboardOverflowCapMeta | null;
  /**
   * Phase 1: cluster-INPUT cap diagnostics lifted from `_meta.clusterCap`
   * (deduped/kept/dropped counts, dropped IDs, and the enriched per-drop
   * `clusterDropped` scores). `null` when absent. Defensive parse.
   */
  clusterCap: DashboardClusterCapMeta | null;
  /**
   * C1: deferred re-cluster EXECUTION outcome (B2) lifted from
   * `_meta.reclusterExecution`. Present only after the deferred pass runs (a
   * subsequent GET read), so `null` on the immediate refresh response and on
   * older APIs. Defensive parse.
   */
  reclusterExecution: DashboardReclusterExecutionMeta | null;
  /**
   * C1: number of B1 deferred re-cluster candidates queued this run, lifted from
   * `_meta.reclusterQueueCount`. `null` when absent.
   */
  reclusterQueueCount: number | null;
  /**
   * Phase 4 · Step 3: refresh fail-safe status lifted from `_meta`
   * (`refreshStatus` / `refreshFailure` / `usedPriorSnapshot` — the Step 2 server
   * contract). Lets the UI tell a TRUE quiet/empty success apart from a refresh
   * FAILURE that also returns zero stories. On legacy payloads that omit these
   * fields this defaults to `refreshStatus: "ok"`, `refreshFailure: null`,
   * `usedPriorSnapshot: false` — pre-Step-3 behavior, never a false failure.
   * Parsed defensively off the raw `_meta`; never schema-validated.
   *
   * B6: `"degraded"` (B3) is the LLM-clustering-failed-but-deterministic-fallback-
   * published outcome — a real, bounded publish. The additive B3/B5 fields below
   * (`usedDeterministicClustering` / `clusteringLlmFailed` /
   * `deterministicClusteringDiagnostics` / `upgradeRefreshScheduled` /
   * `upgradeRefreshReason`) describe the rescue + the background LLM upgrade.
   */
  refreshStatus: RefreshStatus;
  refreshFailure: DashboardRefreshFailure | null;
  usedPriorSnapshot: boolean;
  usedDeterministicClustering: boolean;
  clusteringLlmFailed: boolean;
  deterministicClusteringDiagnostics: DashboardDeterministicClusteringDiagnostics | null;
  upgradeRefreshScheduled: boolean;
  upgradeRefreshReason: string | null;
}

/**
 * Refresh status wire vocabulary (Phase 4 Step 3 + B3). `"degraded"` was added
 * by B3: the LLM clustering path failed but the deterministic relevance-gated
 * fallback published bounded stories — a real publish, NOT a hard failure.
 */
export type RefreshStatus = "ok" | "degraded" | "failed";

/** Phase 4 · Step 2/3 wire vocabulary for a classified refresh failure. */
export type RefreshFailureSubtype = "parse" | "timeout" | "provider_request" | "unknown";

/**
 * B6 (B3): deterministic relevance-gated fallback diagnostics lifted from
 * `_meta.deterministicClusteringDiagnostics` (counts only). All fields parsed
 * defensively — a missing/garbled object lifts to `null`; missing/mistyped
 * counts degrade to `null`; `excludedReasons` to `{}`. Debug aid only.
 */
export interface DashboardDeterministicClusteringDiagnostics {
  inputCount: number | null;
  eligibleCount: number | null;
  outputCount: number | null;
  excludedReasons: Record<string, number>;
}

/**
 * Structured refresh failure lifted from `_meta.refreshFailure`. All fields are
 * nullable except `subtype` (which falls back to `"unknown"`) so a partial or
 * forward-compatible payload never throws. `reason` is a free string from the
 * server (e.g. `"clustering_failure"`, `"pipeline_exception"`).
 */
export interface DashboardRefreshFailure {
  reason: string | null;
  subtype: RefreshFailureSubtype;
  attempts: number | null;
  retryable: boolean | null;
  /** Optional retry-timing hints; null when the server omits them. */
  retryAfterMs: number | null;
  nextRetryAt: string | null;
}

/** Phase 4 · Step 3 + B6: parsed fail-safe status surface (subset spread into the result). */
export interface DashboardRefreshFailsafeMeta {
  refreshStatus: RefreshStatus;
  refreshFailure: DashboardRefreshFailure | null;
  usedPriorSnapshot: boolean;
  /**
   * B3 attribution flag: the deterministic fallback path produced builder output.
   * Diagnostic only — final shipped verdict is `refreshStatus`.
   */
  usedDeterministicClustering: boolean;
  /** B3: the LLM clustering path failed terminally (attribution). */
  clusteringLlmFailed: boolean;
  /** B3: deterministic fallback diagnostics (counts); null when it never ran. */
  deterministicClusteringDiagnostics: DashboardDeterministicClusteringDiagnostics | null;
  /** B5: a background default-profile LLM upgrade was scheduled for this run. */
  upgradeRefreshScheduled: boolean;
  /** B5: reason string for the scheduled upgrade; null when none. */
  upgradeRefreshReason: string | null;
}

/** Subset of the server progressive-enrichment state surfaced for the client poll loop. */
export interface DashboardWhyEnrichmentMeta {
  deferred: boolean;
  pending: number;
  completed: number;
  total: number;
  upgradeLatencyMs: number | null;
  /**
   * Client-only marker (Slice 6 follow-through): set when bounded polling stops
   * at the budget with items still pending. The card keeps its current
   * (source-grounded or template) fallback copy — NOT a permanent lock: a later
   * background refresh (heartbeat / next interactive entry) re-attempts the
   * upgrade and overlays the richer copy in place. Never sent by the server.
   */
  pollExhausted?: boolean;
}

interface DashboardClusteringMeta {
  clusteringFailed: boolean;
  clusteringFailureReason: "timeout" | "error" | null;
  clusteringAttempts: number | null;
  clusteringLatencyMs: number[] | null;
}

/** Subset of the server funnel object surfaced for the debug diagnostics panel. */
export interface DashboardFunnelMeta {
  totalNormalized: number | null;
  afterTimeWindow: number | null;
  afterSourceSelection: number | null;
  afterGeoFilter: number | null;
  afterTopicKeyword: number | null;
  afterBeatFit: number | null;
  afterDedupe: number | null;
  finalStories: number | null;
  primaryDropStage: string | null;
  executionMode: string | null;
}

/** Subset of the server recall diagnostics surfaced for the debug panel. */
export interface DashboardRecallMeta {
  mode: string | null;
  keywordRecallCount: number | null;
  finalRelevant: number | null;
  similarityRejected: number | null;
  minSimilarityThreshold: number | null;
}

/** C1: split-healer (A3) run diagnostics for the debug panel. */
export interface DashboardClusterSplitMeta {
  enabled: boolean | null;
  inputCount: number | null;
  outputCount: number | null;
  splitCount: number | null;
  deferredCount: number | null;
  bundledStoryCount: number | null;
  reclusterCandidateIds: string[];
  splitReasons: Record<string, number>;
  deferReasons: Record<string, number>;
}

/** C1: overflow cap (A4) diagnostics for the debug panel. */
export interface DashboardOverflowCapMeta {
  overflowCapApplied: boolean;
  overflowInputCount: number | null;
  overflowOutputCount: number | null;
  overflowDroppedCount: number | null;
  overflowDroppedMetaStoryIds: string[];
}

/**
 * Phase 1.4: one explained cluster-input-cap drop (subset surfaced for the debug
 * row). Mirrors the backend `_meta.clusterCap.clusterDropped[]` entry but keeps
 * only the fields the bounded row renders; parsed defensively (all nullable).
 */
export interface DashboardClusterDroppedEntry {
  sourceId: string | null;
  preClusterScore: number | null;
  rank: number | null;
  electionGeoClass: string | null;
}

/**
 * C1 / Phase 1: cluster-INPUT cap diagnostics lifted from `_meta.clusterCap`.
 * Counts + dropped IDs are the stable legacy surface; `clusterDropped` (enriched
 * per-drop scores, Step 1.4) and `clusterInputCapEffective` (Slice 3) are
 * additive and may be absent on older payloads — `clusterDropped` then parses to
 * `[]`. Debug-panel aid only; never gates behavior, never schema-validated.
 */
export interface DashboardClusterCapMeta {
  dedupedCount: number | null;
  clusterInputCount: number | null;
  clusterDroppedCount: number | null;
  clusterDroppedSourceIds: string[];
  clusterDropped: DashboardClusterDroppedEntry[];
  clusterInputCapEffective: number | null;
}

/** C1: deferred re-cluster execution (B2) outcome for the debug panel. */
export interface DashboardReclusterExecutionMeta {
  status: string | null;
  totalQueued: number | null;
  attempted: number | null;
  succeeded: number | null;
  failed: number | null;
  timedOut: number | null;
  candidates: Array<{ metaStoryId: string | null; outcome: string | null }>;
}

export interface DashboardBootstrapResult extends DashboardFetchResult {
  /**
   * Backend's decision about how to satisfy the bootstrap request.
   * `null` only when the response was a contract-validated payload but the
   * server omitted the field (older API).
   */
  decision: DashboardBootstrapDecision | null;
}

/**
 * Error thrown when the dashboard endpoint fails after retries are exhausted.
 * Wraps the last underlying cause so the UI can surface a precise message and
 * the caller can branch on `kind` for empty/error rendering.
 */
export class DashboardFetchError extends Error {
  readonly kind: "http" | "network" | "contract" | "abort";
  readonly status?: number;
  constructor(kind: "http" | "network" | "contract" | "abort", message: string, status?: number) {
    super(message);
    this.name = "DashboardFetchError";
    this.kind = kind;
    this.status = status;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DEFAULT_ENDPOINT = "/api/dashboard";
const DEFAULT_BOOTSTRAP_ENDPOINT = "/api/dashboard/bootstrap";
const DEFAULT_REFRESH_ENDPOINT = "/api/dashboard/refresh";
const DEFAULT_RETRIES = 2;
const RETRY_BACKOFF_MS = 200;

interface FetchDashboardOptions {
  endpoint?: string;
  retries?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type DashboardBootstrapDecision =
  | "served_fresh_snapshot"
  | "ran_refresh"
  | "no_snapshot";

/**
 * Coerce any non-Abort error caught in a fetch loop to a `DashboardFetchError`
 * with a stable `kind`. Pass-through when the error is already a typed
 * `DashboardFetchError` (e.g. an HTTP non-2xx thrown from inside the try
 * block), otherwise classify Zod parse failures as "contract" and everything
 * else as "network". Callers must handle AbortError before invoking this.
 */
function normalizeFetchError(error: unknown, fallbackMessage: string): DashboardFetchError {
  if (error instanceof DashboardFetchError) return error;
  const isContract = error instanceof Error && error.name === "ZodError";
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new DashboardFetchError(isContract ? "contract" : "network", message);
}

function parseSelectionMetaSafe(raw: unknown): DashboardSelectionMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const result = dashboardSelectionMetaSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function parseIsoTimestampSafe(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? raw : null;
}

const CLUSTERING_META_EMPTY: DashboardClusteringMeta = {
  clusteringFailed: false,
  clusteringFailureReason: null,
  clusteringAttempts: null,
  clusteringLatencyMs: null,
};

/**
 * Lift clustering fail-closed diagnostics off the raw `_meta`.  Tolerant of any
 * shape: a missing/garbled `_meta`, missing keys, or wrong types all degrade to
 * `clusteringFailed: false` with nulls elsewhere (a malformed response must
 * never read as "clustering failed").  Mirrors the defensive `_meta.selection`
 * pattern — never throws.
 */
function parseClusteringMetaSafe(meta: unknown): DashboardClusteringMeta {
  if (!meta || typeof meta !== "object") return CLUSTERING_META_EMPTY;
  const m = meta as Record<string, unknown>;
  const reason = m.clusteringFailureReason;
  const attempts = m.clusteringAttempts;
  const latency = m.clusteringLatencyMs;
  return {
    clusteringFailed: m.usedFallbackClustering === true,
    clusteringFailureReason:
      reason === "timeout" || reason === "error" ? reason : null,
    clusteringAttempts:
      typeof attempts === "number" && Number.isFinite(attempts) ? attempts : null,
    clusteringLatencyMs:
      Array.isArray(latency) &&
      latency.every((n) => typeof n === "number" && Number.isFinite(n))
        ? (latency as number[])
        : null,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const REFRESH_FAILSAFE_META_DEFAULT: DashboardRefreshFailsafeMeta = {
  refreshStatus: "ok",
  refreshFailure: null,
  usedPriorSnapshot: false,
  usedDeterministicClustering: false,
  clusteringLlmFailed: false,
  deterministicClusteringDiagnostics: null,
  upgradeRefreshScheduled: false,
  upgradeRefreshReason: null,
};

/**
 * Lift B3 deterministic-fallback diagnostics off `_meta`. Tolerant of any shape:
 * a missing/garbled object returns `null`; missing/mistyped counts degrade to
 * `null`; a non-object `excludedReasons` degrades to `{}`. Never throws.
 */
function parseDeterministicDiagnosticsSafe(
  raw: unknown
): DashboardDeterministicClusteringDiagnostics | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const excludedReasons: Record<string, number> = {};
  if (d.excludedReasons && typeof d.excludedReasons === "object") {
    for (const [k, v] of Object.entries(d.excludedReasons as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) excludedReasons[k] = v;
    }
  }
  return {
    inputCount: numOrNull(d.inputCount),
    eligibleCount: numOrNull(d.eligibleCount),
    outputCount: numOrNull(d.outputCount),
    excludedReasons,
  };
}

const REFRESH_FAILURE_SUBTYPES: readonly RefreshFailureSubtype[] = [
  "parse",
  "timeout",
  "provider_request",
  "unknown",
];

/**
 * Lift the Phase 4 Step 2 refresh fail-safe status off the raw `_meta`. Tolerant
 * of any shape: a missing/garbled `_meta`, missing keys, or wrong types all
 * degrade to `refreshStatus: "ok"` with a null failure — a malformed or legacy
 * response must NEVER read as a failure. Only an explicit `refreshStatus ===
 * "failed"` flips the status. Mirrors `parseClusteringMetaSafe`; never throws.
 */
function parseRefreshFailsafeMetaSafe(meta: unknown): DashboardRefreshFailsafeMeta {
  if (!meta || typeof meta !== "object") return REFRESH_FAILSAFE_META_DEFAULT;
  const m = meta as Record<string, unknown>;
  const usedPriorSnapshot = m.usedPriorSnapshot === true;
  // B6: additive B3/B5 deterministic-fallback + upgrade signals — parsed
  // defensively and ALWAYS present in the result (false/null when absent) so a
  // legacy/malformed payload reads as a clean non-degraded run.
  const common = {
    usedPriorSnapshot,
    usedDeterministicClustering: m.usedDeterministicClustering === true,
    clusteringLlmFailed: m.clusteringLlmFailed === true,
    deterministicClusteringDiagnostics: parseDeterministicDiagnosticsSafe(
      m.deterministicClusteringDiagnostics
    ),
    upgradeRefreshScheduled: m.upgradeRefreshScheduled === true,
    upgradeRefreshReason: strOrNull(m.upgradeRefreshReason),
  };
  // Only an explicit "failed"/"degraded" flips the status; anything else
  // (including a missing or unknown value) safely reads as "ok".
  const status = m.refreshStatus;
  if (status !== "failed" && status !== "degraded") {
    return { refreshStatus: "ok", refreshFailure: null, ...common };
  }
  // Both "failed" and "degraded" carry the structured failure (degraded retains
  // the LLM-failure metadata for attribution).
  const rawFailure =
    m.refreshFailure && typeof m.refreshFailure === "object"
      ? (m.refreshFailure as Record<string, unknown>)
      : {};
  const subtype = rawFailure.subtype;
  const retryable = rawFailure.retryable;
  return {
    refreshStatus: status,
    refreshFailure: {
      reason: strOrNull(rawFailure.reason),
      subtype: REFRESH_FAILURE_SUBTYPES.includes(subtype as RefreshFailureSubtype)
        ? (subtype as RefreshFailureSubtype)
        : "unknown",
      attempts: numOrNull(rawFailure.attempts),
      retryable: typeof retryable === "boolean" ? retryable : null,
      retryAfterMs: numOrNull(rawFailure.retryAfterMs),
      nextRetryAt: parseIsoTimestampSafe(rawFailure.nextRetryAt),
    },
    ...common,
  };
}

/**
 * Lift the funnel stage counts off `_meta.funnel`. Tolerant of any shape: a
 * missing/garbled funnel returns `null`; individual missing/mistyped fields
 * degrade to `null`. Dev-only diagnostics — never gates behavior, never throws.
 */
function parseFunnelMetaSafe(raw: unknown): DashboardFunnelMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  return {
    totalNormalized: numOrNull(f.totalNormalized),
    afterTimeWindow: numOrNull(f.afterTimeWindow),
    afterSourceSelection: numOrNull(f.afterSourceSelection),
    afterGeoFilter: numOrNull(f.afterGeoFilter),
    afterTopicKeyword: numOrNull(f.afterTopicKeyword),
    afterBeatFit: numOrNull(f.afterBeatFit),
    afterDedupe: numOrNull(f.afterDedupe),
    finalStories: numOrNull(f.finalStories),
    primaryDropStage: strOrNull(f.primaryDropStage),
    executionMode: strOrNull(f.executionMode),
  };
}

/**
 * Lift the progressive-enrichment state off `_meta.whyEnrichment` (Slice 5).
 * Tolerant of any shape: a missing/garbled object returns `null` (→ "nothing
 * pending"); individual missing/mistyped numeric fields degrade to 0 and
 * `deferred` to false. Never throws — a malformed `_meta` must never read as
 * "pending forever".
 */
function parseWhyEnrichmentMetaSafe(raw: unknown): DashboardWhyEnrichmentMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    deferred: w.deferred === true,
    pending: num(w.pending),
    completed: num(w.completed),
    total: num(w.total),
    upgradeLatencyMs:
      typeof w.upgradeLatencyMs === "number" && Number.isFinite(w.upgradeLatencyMs)
        ? w.upgradeLatencyMs
        : null,
  };
}

/**
 * Lift the recall summary off `_meta.recall`. Same defensive posture as
 * `parseFunnelMetaSafe`. Dev-only — never gates behavior, never throws.
 */
function parseRecallMetaSafe(raw: unknown): DashboardRecallMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    mode: strOrNull(r.mode),
    keywordRecallCount: numOrNull(r.keywordRecallCount),
    finalRelevant: numOrNull(r.finalRelevant),
    similarityRejected: numOrNull(r.similarityRejected),
    minSimilarityThreshold: numOrNull(r.minSimilarityThreshold),
  };
}

// Coerce an object of numeric counters (e.g. splitReasons) defensively.
function numRecordSafe(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

// Coerce a string-array defensively (drop non-string entries).
function strArrSafe(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Lift the split-healer (A3) diagnostics off `_meta.clusterSplit` (C1). Same
 * defensive posture as `parseFunnelMetaSafe`: missing/garbled → `null`,
 * individual fields degrade. Dev-only — never gates behavior, never throws.
 */
function parseClusterSplitMetaSafe(raw: unknown): DashboardClusterSplitMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  return {
    enabled: typeof c.enabled === "boolean" ? c.enabled : null,
    inputCount: numOrNull(c.inputCount),
    outputCount: numOrNull(c.outputCount),
    splitCount: numOrNull(c.splitCount),
    deferredCount: numOrNull(c.deferredCount),
    bundledStoryCount: numOrNull(c.bundledStoryCount),
    reclusterCandidateIds: strArrSafe(c.reclusterCandidateIds),
    splitReasons: numRecordSafe(c.splitReasons),
    deferReasons: numRecordSafe(c.deferReasons),
  };
}

/** Lift the overflow cap (A4) diagnostics off `_meta.overflowCap` (C1). */
function parseOverflowCapMetaSafe(raw: unknown): DashboardOverflowCapMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    overflowCapApplied: o.overflowCapApplied === true,
    overflowInputCount: numOrNull(o.overflowInputCount),
    overflowOutputCount: numOrNull(o.overflowOutputCount),
    overflowDroppedCount: numOrNull(o.overflowDroppedCount),
    overflowDroppedMetaStoryIds: strArrSafe(o.overflowDroppedMetaStoryIds),
  };
}

/**
 * Lift the cluster-INPUT cap diagnostics off `_meta.clusterCap` (Phase 1).
 * Tolerant: a missing/garbled object → `null`; a legacy payload without
 * `clusterDropped` / `clusterInputCapEffective` parses fine (`clusterDropped`
 * → `[]`, cap → `null`). Each enriched entry is reduced to the fields the bounded
 * debug row needs.
 */
function parseClusterCapMetaSafe(raw: unknown): DashboardClusterCapMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const clusterDropped = Array.isArray(c.clusterDropped)
    ? c.clusterDropped
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({
          sourceId: strOrNull(e.sourceId),
          preClusterScore: numOrNull(e.preClusterScore),
          rank: numOrNull(e.rank),
          electionGeoClass: strOrNull(e.electionGeoClass),
        }))
    : [];
  return {
    dedupedCount: numOrNull(c.dedupedCount),
    clusterInputCount: numOrNull(c.clusterInputCount),
    clusterDroppedCount: numOrNull(c.clusterDroppedCount),
    clusterDroppedSourceIds: strArrSafe(c.clusterDroppedSourceIds),
    clusterDropped,
    clusterInputCapEffective: numOrNull(c.clusterInputCapEffective),
  };
}

/** Lift the deferred re-cluster execution (B2) outcome off `_meta.reclusterExecution` (C1). */
function parseReclusterExecutionMetaSafe(raw: unknown): DashboardReclusterExecutionMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const candidates = Array.isArray(r.candidates)
    ? r.candidates
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({ metaStoryId: strOrNull(c.metaStoryId), outcome: strOrNull(c.outcome) }))
    : [];
  return {
    status: strOrNull(r.status),
    totalQueued: numOrNull(r.totalQueued),
    attempted: numOrNull(r.attempted),
    succeeded: numOrNull(r.succeeded),
    failed: numOrNull(r.failed),
    timedOut: numOrNull(r.timedOut),
    candidates,
  };
}

// Identity precedence (default = production-safe): a valid Bearer session wins;
// the prototype `x-recognized-email` header is only a fallback when Bearer is
// absent/unusable. The recognized-email-over-Bearer ordering is gated behind the
// E2E-only `VITE_E2E_IDENTITY_PRECEDENCE=recognized_email` override (see
// `isE2EIdentityOverrideEnabled`) so a stale persisted Supabase token can't
// shadow a recognized-user e2e run. Email path is prototype identity only.
async function buildIdentityHeaders(): Promise<Record<string, string>> {
  const proto = getProtoSession();
  // E2E-only override: recognized-email beats Bearer.
  if (proto && isE2EIdentityOverrideEnabled()) {
    return { "x-recognized-email": proto.email };
  }
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      // Guard against stale persisted sessions in dev: only send Bearer when
      // Supabase still recognizes the token as a valid user session.
      if (typeof supabase.auth.getUser === "function") {
        const { data: userData, error } = await supabase.auth.getUser(token);
        if (!error && userData?.user) {
          return { Authorization: `Bearer ${token}` };
        }
      } else {
        // Fallback for auth stubs/older clients where getUser is unavailable.
        return { Authorization: `Bearer ${token}` };
      }
    }
  } catch { /* supabase not configured */ }
  // Bearer absent/unusable → fall back to the prototype recognized identity.
  if (proto) return { "x-recognized-email": proto.email };
  return {};
}

/**
 * Shared retry/backoff loop used by every dashboard endpoint helper.  Each
 * caller differs only by HTTP method, endpoint, label (for error messages),
 * and whether they need to lift extra fields off `_meta` (e.g. bootstrap's
 * `decision`).  `parseExtras` runs after contract validation succeeds and is
 * spread into the returned object.
 */
async function requestDashboard<TExtras extends object>({
  method,
  options,
  label,
  defaultEndpoint,
  parseExtras,
}: {
  method: "GET" | "POST";
  options: FetchDashboardOptions;
  label: string;
  defaultEndpoint: string;
  parseExtras?: (raw: { _meta?: Record<string, unknown> }) => TExtras;
}): Promise<DashboardFetchResult & TExtras> {
  const endpoint = options.endpoint ?? defaultEndpoint;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? wait;

  const identityHeaders = await buildIdentityHeaders();

  let lastError: DashboardFetchError | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method,
        headers: {
          Accept: "application/json",
          ...identityHeaders,
        },
      });
      if (!response.ok) {
        throw new DashboardFetchError(
          "http",
          `${label} API returned HTTP ${response.status}`,
          response.status
        );
      }
      const raw = (await response.json()) as { _meta?: Record<string, unknown> };
      const payload = dashboardPayloadSchema.parse(raw);
      const meta = raw?._meta;
      const selection = parseSelectionMetaSafe(meta?.selection);
      const refreshedAt = parseIsoTimestampSafe(meta?.refreshedAt);
      const lastCheckedAt = parseIsoTimestampSafe(meta?.lastCheckedAt);
      const clustering = parseClusteringMetaSafe(meta);
      const funnel = parseFunnelMetaSafe(meta?.funnel);
      const recall = parseRecallMetaSafe(meta?.recall);
      const whyEnrichment = parseWhyEnrichmentMetaSafe(meta?.whyEnrichment);
      const clusterSplit = parseClusterSplitMetaSafe(meta?.clusterSplit);
      const overflowCap = parseOverflowCapMetaSafe(meta?.overflowCap);
      const clusterCap = parseClusterCapMetaSafe(meta?.clusterCap);
      const reclusterExecution = parseReclusterExecutionMetaSafe(meta?.reclusterExecution);
      const reclusterQueueCount = numOrNull(meta?.reclusterQueueCount);
      const refreshFailsafe = parseRefreshFailsafeMetaSafe(meta);
      const extras = parseExtras ? parseExtras(raw) : ({} as TExtras);
      return {
        payload, selection, refreshedAt, lastCheckedAt, ...clustering, funnel, recall, whyEnrichment,
        clusterSplit, overflowCap, clusterCap, reclusterExecution, reclusterQueueCount,
        ...refreshFailsafe, ...extras,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const dfe = normalizeFetchError(error, `Unknown ${label.toLowerCase()} error`);
      lastError = dfe;
      if (attempt === retries) throw dfe;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  // unreachable — the loop either returns or throws on the final attempt
  throw lastError ?? new DashboardFetchError("network", `${label} fetch failed`);
}

export async function fetchDashboardPayload(
  options: FetchDashboardOptions = {}
): Promise<DashboardPayload> {
  const result = await fetchDashboardWithMeta(options);
  return result.payload;
}

/**
 * Phase 2: returns both the parsed payload AND `_meta.selection` so the
 * dashboard can render small status cues (fallback used / unmatched names /
 * strict-empty).  `_meta` is read off the raw response — the payload itself
 * is still validated against `dashboardPayloadSchema`.
 */
export async function fetchDashboardWithMeta(
  options: FetchDashboardOptions = {}
): Promise<DashboardFetchResult> {
  return requestDashboard({
    method: "GET",
    options,
    label: "Dashboard",
    defaultEndpoint: DEFAULT_ENDPOINT,
  });
}

const VALID_BOOTSTRAP_DECISIONS: ReadonlySet<DashboardBootstrapDecision> = new Set([
  "served_fresh_snapshot",
  "ran_refresh",
  "no_snapshot",
]);

function parseBootstrapDecision(raw: unknown): DashboardBootstrapDecision | null {
  if (typeof raw !== "string") return null;
  return VALID_BOOTSTRAP_DECISIONS.has(raw as DashboardBootstrapDecision)
    ? (raw as DashboardBootstrapDecision)
    : null;
}

/**
 * Phase 5 dashboard bootstrap.
 *
 * POSTs to `/api/dashboard/bootstrap` so the backend can decide whether the
 * persisted snapshot is fresh enough (≤ 60 min) to serve as-is, or whether
 * it needs to run the refresh pipeline before responding.  Should ONLY be
 * called on the dedicated entry surfaces (Landing → Dashboard for recognized
 * users, and Onboarding → Dashboard post-submit).  Other in-app navigations
 * use `fetchDashboardPayload` / `fetchDashboardWithMeta` (GET) so we don't
 * thrash the pipeline on every link click.
 */
export async function bootstrapDashboard(
  options: FetchDashboardOptions = {}
): Promise<DashboardBootstrapResult> {
  return requestDashboard<{ decision: DashboardBootstrapDecision | null }>({
    method: "POST",
    options,
    label: "Bootstrap",
    defaultEndpoint: DEFAULT_BOOTSTRAP_ENDPOINT,
    parseExtras: (raw) => ({
      decision: parseBootstrapDecision(raw?._meta?.bootstrapDecision),
    }),
  });
}

/**
 * Hourly background refresh from the mounted dashboard.
 *
 * Same shape as `fetchDashboardWithMeta` but POSTs to `/api/dashboard/refresh`
 * so the backend re-runs the pipeline (vs the GET path that returns the
 * persisted snapshot).  Identity headers, retry/backoff, and contract
 * validation match the other dashboard helpers so callers can treat the
 * result interchangeably.
 */
export async function refreshDashboard(
  options: FetchDashboardOptions = {}
): Promise<DashboardFetchResult> {
  return requestDashboard({
    method: "POST",
    options,
    label: "Refresh",
    defaultEndpoint: DEFAULT_REFRESH_ENDPOINT,
  });
}

/**
 * Slice 2: best-effort GET recovery for a failed POST loader.
 *
 * When a POST loader (`bootstrapDashboard` / `refreshDashboard`) fails after
 * its own retries are exhausted, the dashboard can still recover by serving
 * the persisted snapshot via a plain GET.  This wraps `fetchDashboardWithMeta`
 * and — unlike it — NEVER throws: it resolves to the GET result on success, or
 * to `null` when the GET also fails (or aborts).  Callers treat `null` as
 * "stay on the original POST error" and a non-null result as a silent recovery
 * (render the recovered snapshot, no error UI).  The recovery GET is a single
 * best-effort pass by default (`retries: 0`) so a failing backend doesn't
 * stack a second multi-retry storm on top of the POST loader's.
 */
export async function recoverDashboardViaGet(
  options: FetchDashboardOptions = {}
): Promise<DashboardFetchResult | null> {
  try {
    return await fetchDashboardWithMeta({ retries: 0, ...options });
  } catch {
    return null;
  }
}

// ─── Slice 9: cold-start refresh-status polling ──────────────────────────────

const DEFAULT_REFRESH_STATUS_ENDPOINT = "/api/dashboard/refresh-status";

/** Minimal refresh-status contract (Slice 7 server endpoint). */
export interface RefreshStatusResult {
  jobId: string;
  status: "running" | "done" | "failed";
  phase: string | null;
  storyCount: number | null;
  failureReason: string | null;
}

const VALID_REFRESH_STATUSES: ReadonlySet<RefreshStatusResult["status"]> = new Set([
  "running",
  "done",
  "failed",
]);

/**
 * Defensive parse of a refresh-status response.  Returns `null` when the shape
 * is unusable — a missing/blank `jobId` or a `status` outside the known enum —
 * so a malformed body can never read as a valid (e.g. terminal) state.  `phase`,
 * `storyCount`, and `failureReason` degrade individually to `null` when absent
 * or mistyped.
 */
function parseRefreshStatusSafe(raw: unknown): RefreshStatusResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== "string" || r.jobId.length === 0) return null;
  if (
    typeof r.status !== "string" ||
    !VALID_REFRESH_STATUSES.has(r.status as RefreshStatusResult["status"])
  ) {
    return null;
  }
  return {
    jobId: r.jobId,
    status: r.status as RefreshStatusResult["status"],
    phase: typeof r.phase === "string" && r.phase.length > 0 ? r.phase : null,
    storyCount:
      typeof r.storyCount === "number" && Number.isFinite(r.storyCount)
        ? r.storyCount
        : null,
    failureReason:
      typeof r.failureReason === "string" && r.failureReason.length > 0
        ? r.failureReason
        : null,
  };
}

/**
 * Poll the cold-start prefetch job status (Slice 7 endpoint).  Single-shot (no
 * retry loop — the caller drives the poll cadence/deadline).  Throws a
 * `DashboardFetchError` on transport failure, non-2xx, non-JSON, or a payload
 * that fails defensive validation, mirroring the other dashboard helpers' error
 * style so callers never silently consume a bad state.
 */
export async function fetchRefreshStatus(
  jobId: string,
  options: { endpoint?: string; fetcher?: typeof fetch } = {}
): Promise<RefreshStatusResult> {
  const base = options.endpoint ?? DEFAULT_REFRESH_STATUS_ENDPOINT;
  const fetcher = options.fetcher ?? fetch;
  const identityHeaders = await buildIdentityHeaders();
  const endpoint = `${base}/${encodeURIComponent(jobId)}`;

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      headers: { Accept: "application/json", ...identityHeaders },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown refresh-status error";
    throw new DashboardFetchError("network", message);
  }

  if (!response.ok) {
    throw new DashboardFetchError(
      "http",
      `Refresh status API returned HTTP ${response.status}`,
      response.status
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new DashboardFetchError("contract", "Refresh status response was not valid JSON.");
  }

  const parsed = parseRefreshStatusSafe(raw);
  if (!parsed) {
    throw new DashboardFetchError("contract", "Refresh status response failed validation.");
  }
  return parsed;
}
