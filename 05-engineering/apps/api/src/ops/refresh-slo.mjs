// Lightweight, in-process SLO signals for the dashboard refresh path
// (Slice 3, extended Slice 7).
//
// No pager / external integration — this emits grep-friendly log lines that a
// downstream log-based alert keys on, plus an additive `_meta.slo` surface for
// dashboards.  Two line shapes:
//
//   • Per-breach (back-compat, Slice 3):  `[refresh.slo] breach=<id> ...`
//   • Per-settle gate snapshot (Slice 7): `[refresh.slo.gate] {json}` — one
//     machine-readable object every refresh with the fields needed to GATE:
//     latency, attempt-only timeout/failure rates, empty-result health,
//     enrichment state, active profile, and the breach id list.
//
// Operator runbook: `05-engineering/docs/runbook-refresh-slo.md`.
//
// SLO conditions:
//   A. pipeline_slow        — a single refresh whose end-to-end pipeline wall
//                             clock exceeds PIPELINE_SLOW_MS.
//   B. cluster_timeout_rate — sustained clustering TIMEOUTS: more than
//                             CLUSTER_TIMEOUT_RATE_THRESHOLD of the last
//                             CLUSTER_TIMEOUT_WINDOW refreshes THAT ATTEMPTED
//                             CLUSTERING timed out.  No-attempt refreshes
//                             (watermark short-circuit, zero candidates) are NOT
//                             sampled, so a stream of no-ops can't dilute the
//                             rate (no false calm).  Only fires once the attempt
//                             window is full (balanced over noisy).
//   C. cluster_failure_rate — (Slice 7) sustained clustering FAIL-CLOSED runs
//                             (timeout OR error → fallback to 0 stories) over
//                             the same attempt-only window, looser threshold
//                             than timeouts.  Timeouts are a subset of failures,
//                             so this catches schema/auth/error storms that the
//                             timeout-only gate misses.
//   D. geo_budget_pressure  — (Slice 7) a single refresh that hit the geo-stage
//                             wall-clock budget AND deferred Lane 2 candidates
//                             to the hold path.  Deferred items are never
//                             dropped (Slice 6), so this is a latency/throughput
//                             signal, not a correctness one.
//
// TERMINAL-FAILURE GUARD (Slice 3, preserved): clustering failure is classified
// ONLY from the terminal fields — `clusteringFailureReason` ("timeout"|"error")
// and `usedFallbackClustering === true`.  Slice 3 repair diagnostics
// (`clusteringRepairRawFailureClass` / `clusteringRepairSchemaErrorBucket`) are
// NON-NULL on RECOVERED (published) runs too, so they are deliberately NOT read
// here — counting them would overcount failures and raise false breach alarms.
// A recovered parse-repair run samples the window as a non-timeout, non-failure.
//
// State is a module-level rolling window, intentionally per-process (per API
// instance) and deterministic — `_resetSloState()` clears it for tests.

export const PIPELINE_SLOW_MS = 90_000;
export const CLUSTER_TIMEOUT_WINDOW = 10;
export const CLUSTER_TIMEOUT_RATE_THRESHOLD = 0.2;
// Slice 7: general clustering fail-closed rate over the same attempt-only
// window. Looser than the timeout bar because timeouts ⊆ failures and the
// timeout gate already covers the urgent provider-latency case at 0.2.
export const CLUSTER_FAILURE_RATE_THRESHOLD = 0.5;

/**
 * Stable breach registry (Slice 7).  Each id maps to a concise, operationally
 * useful `actionHint` (NOT generic) and a one-line `meaning`.  The id is the
 * grep key (`breach=<id>`); the action hint tells the on-call what lever to
 * reach for first.  See the runbook for full triage steps.
 */
export const SLO_BREACHES = Object.freeze({
  pipeline_slow: {
    actionHint: "check_provider_latency_then_consider_profile_tuning",
    meaning: "One refresh exceeded the end-to-end pipeline wall-clock ceiling.",
  },
  cluster_timeout_rate: {
    actionHint: "clustering_provider_latency_raise_cluster_timeout_or_rollback_profile",
    meaning: "Sustained clustering timeouts across the attempt-only window.",
  },
  cluster_failure_rate: {
    actionHint: "investigate_clustering_provider_or_output_schema_not_a_timeout",
    meaning: "Sustained clustering fail-closed (timeout OR error) across the window.",
  },
  geo_budget_pressure: {
    actionHint: "geo_budget_pressure_raise_geoStageBudgetMs_or_check_geo_provider_latency",
    meaning: "Geo stage hit its budget and deferred Lane 2 work to the hold path.",
  },
});

// Rolling window, ONE ENTRY PER CLUSTERING-ATTEMPTING REFRESH:
//   { timeout: did it time out?, failed: did it fail closed (any reason)? }
// No-attempt refreshes never push here, so the denominator is attempts only.
// Oldest entries shift out once the window is full.
const _clusterAttemptWindow = [];

/** Test-only: clear the rolling window so suites don't bleed into each other. */
export function _resetSloState() {
  _clusterAttemptWindow.length = 0;
}

/**
 * Classify an empty (0-story) result so dashboards distinguish a healthy quiet
 * beat from a clustering fail-closed.  Uses the terminal `usedFallbackClustering`
 * flag only (Slice 1/3 semantics) — never repair diagnostics.
 */
function classifyEmptyResult({ storiesPublished, usedFallbackClustering }) {
  if (typeof storiesPublished === "number" && storiesPublished > 0) return "has_stories";
  if (usedFallbackClustering === true) return "clustering_failed";
  return "legitimate_empty";
}

/**
 * Evaluate the SLO conditions for one completed refresh, emit any breach lines
 * + the machine-readable gate snapshot, and return both the back-compat fields
 * and the Slice 7 additions.  Side effects are limited to log writes and the
 * rolling-window push, so the function stays deterministic and unit-testable.
 *
 * @param {object} input
 * @param {number} [input.pipelineMs]               end-to-end pipeline wall clock
 * @param {string|null} [input.clusteringFailureReason] 'timeout' | 'error' | null (terminal)
 * @param {number} [input.clusteringAttempts]       clustering attempts this run;
 *   0 means clustering never ran (no sample added to the attempt window).
 * @param {boolean} [input.usedFallbackClustering]  terminal fail-closed flag (Slice 1/3)
 * @param {number|null} [input.storiesPublished]    published story count (empty-health)
 * @param {boolean} [input.geoBudgetHit]            geo stage hit its wall-clock budget
 * @param {number} [input.geoLane2Deferred]         Lane 2 candidates deferred to hold
 * @param {number|null} [input.geoBudgetMsConfigured]
 * @param {number|null} [input.geoBudgetMsUsed]
 * @param {{name?:string}|null} [input.profile]     active latency profile (Slice 4)
 * @param {{deferred?:boolean,pending?:number,completed?:number,total?:number}|null} [input.enrichment]
 *   progressive whyItMatters enrichment state (Slice 5/6) — health only, never a breach.
 * @param {{ warn: Function, log?: Function }} [logger]  injectable for tests (default console)
 * @returns {{ breaches: string[], breachDetails: Array<{id:string,actionHint:string,observed:object}>,
 *   clusterTimeoutRate: number, clusterFailureRate: number, windowSize: number, gate: object }}
 */
export function evaluateRefreshSlo(
  {
    pipelineMs,
    clusteringFailureReason = null,
    clusteringAttempts = 0,
    usedFallbackClustering = false,
    storiesPublished = null,
    geoBudgetHit = false,
    geoLane2Deferred = 0,
    geoBudgetMsConfigured = null,
    geoBudgetMsUsed = null,
    profile = null,
    enrichment = null,
  } = {},
  logger = console
) {
  const breaches = [];
  const breachDetails = [];
  const addBreach = (id, observed) => {
    breaches.push(id);
    breachDetails.push({
      id,
      actionHint: SLO_BREACHES[id]?.actionHint ?? "investigate",
      observed,
    });
  };

  // Condition A — a single slow refresh.
  if (Number.isFinite(pipelineMs) && pipelineMs > PIPELINE_SLOW_MS) {
    logger.warn(`[refresh.slo] breach=pipeline_slow pipelineMs=${pipelineMs}`);
    addBreach("pipeline_slow", { pipelineMs, thresholdMs: PIPELINE_SLOW_MS });
  }

  // Sample the attempt-only window (terminal-field guard — see header note).
  if (clusteringAttempts > 0) {
    const timeout = clusteringFailureReason === "timeout";
    const failed = usedFallbackClustering === true || clusteringFailureReason != null;
    _clusterAttemptWindow.push({ timeout, failed });
    while (_clusterAttemptWindow.length > CLUSTER_TIMEOUT_WINDOW) {
      _clusterAttemptWindow.shift();
    }
  }
  const windowSize = _clusterAttemptWindow.length;
  const timeoutCount = _clusterAttemptWindow.filter((e) => e.timeout).length;
  const failureCount = _clusterAttemptWindow.filter((e) => e.failed).length;
  const clusterTimeoutRate = windowSize > 0 ? timeoutCount / windowSize : 0;
  const clusterFailureRate = windowSize > 0 ? failureCount / windowSize : 0;

  // Condition B — sustained clustering-timeout rate (full window only).
  if (windowSize >= CLUSTER_TIMEOUT_WINDOW && clusterTimeoutRate > CLUSTER_TIMEOUT_RATE_THRESHOLD) {
    logger.warn(
      `[refresh.slo] breach=cluster_timeout_rate rate=${clusterTimeoutRate.toFixed(2)} window=${CLUSTER_TIMEOUT_WINDOW}`
    );
    addBreach("cluster_timeout_rate", {
      rate: clusterTimeoutRate,
      window: CLUSTER_TIMEOUT_WINDOW,
      threshold: CLUSTER_TIMEOUT_RATE_THRESHOLD,
    });
  }

  // Condition C — sustained clustering fail-closed rate (full window only).
  if (windowSize >= CLUSTER_TIMEOUT_WINDOW && clusterFailureRate > CLUSTER_FAILURE_RATE_THRESHOLD) {
    logger.warn(
      `[refresh.slo] breach=cluster_failure_rate rate=${clusterFailureRate.toFixed(2)} window=${CLUSTER_TIMEOUT_WINDOW}`
    );
    addBreach("cluster_failure_rate", {
      rate: clusterFailureRate,
      window: CLUSTER_TIMEOUT_WINDOW,
      threshold: CLUSTER_FAILURE_RATE_THRESHOLD,
    });
  }

  // Condition D — geo budget pressure (single-run; deferred ≠ dropped).
  if (geoBudgetHit === true && (geoLane2Deferred ?? 0) > 0) {
    logger.warn(
      `[refresh.slo] breach=geo_budget_pressure deferred=${geoLane2Deferred}` +
        ` budget_ms=${geoBudgetMsConfigured ?? "?"} used_ms=${geoBudgetMsUsed ?? "?"}`
    );
    addBreach("geo_budget_pressure", {
      lane2Deferred: geoLane2Deferred,
      geoBudgetMsConfigured,
      geoBudgetMsUsed,
      profile: profile?.name ?? null,
    });
  }

  // Machine-readable, grep-friendly gate snapshot — one per settle.  Routed to
  // `logger.log` (production `console.log`) ONLY, never `.warn`, so breach-only
  // log scrapers and the existing per-breach assertions stay clean.
  const gate = {
    pipelineMs: Number.isFinite(pipelineMs) ? pipelineMs : null,
    clusterTimeoutRate: Number(clusterTimeoutRate.toFixed(4)),
    clusterFailureRate: Number(clusterFailureRate.toFixed(4)),
    windowSize,
    storiesPublished: typeof storiesPublished === "number" ? storiesPublished : null,
    emptyKind: classifyEmptyResult({ storiesPublished, usedFallbackClustering }),
    profile: profile?.name ?? null,
    geoBudgetHit: geoBudgetHit === true,
    geoLane2Deferred: geoLane2Deferred ?? 0,
    enrichment: enrichment
      ? {
          deferred: enrichment.deferred === true,
          pending: enrichment.pending ?? 0,
          completed: enrichment.completed ?? 0,
          total: enrichment.total ?? 0,
        }
      : null,
    breaches: [...breaches],
  };
  if (typeof logger.log === "function") {
    logger.log(`[refresh.slo.gate] ${JSON.stringify(gate)}`);
  }

  return { breaches, breachDetails, clusterTimeoutRate, clusterFailureRate, windowSize, gate };
}
