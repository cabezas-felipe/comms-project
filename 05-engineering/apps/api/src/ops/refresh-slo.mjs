// Lightweight, in-process SLO signals for the dashboard refresh path (Slice 3).
//
// No pager / external integration — this only emits grep-friendly
// `[refresh.slo] breach=...` log lines that a downstream log-based alert can
// key on.  Two balanced conditions:
//
//   A. pipeline_slow      — a single refresh whose end-to-end pipeline wall
//                           clock exceeds PIPELINE_SLOW_MS.
//   B. cluster_timeout_rate — sustained clustering timeouts: more than
//                           CLUSTER_TIMEOUT_RATE_THRESHOLD of the last
//                           CLUSTER_TIMEOUT_WINDOW refreshes THAT ATTEMPTED
//                           CLUSTERING on THIS instance failed with
//                           reason="timeout".  Refreshes that never attempted
//                           clustering (watermark short-circuit, zero
//                           candidates) are NOT sampled — otherwise a steady
//                           stream of no-op refreshes would dilute the rate
//                           and mask a real timeout cluster (false calm).
//                           Only evaluated once the attempt window is full so
//                           a single cold-start timeout can't trip it
//                           (balanced over noisy).
//
// State is a module-level rolling window, intentionally per-process (per API
// instance) and deterministic — `_resetSloState()` clears it for tests.

export const PIPELINE_SLOW_MS = 90_000;
export const CLUSTER_TIMEOUT_WINDOW = 10;
export const CLUSTER_TIMEOUT_RATE_THRESHOLD = 0.2;

// Rolling window of booleans, ONE PER CLUSTERING-ATTEMPTING REFRESH: did that
// refresh fail clustering with reason="timeout"?  No-attempt refreshes never
// push here, so the denominator is attempts only.  Oldest entries shift out
// once the window is full.
const _clusterTimeoutWindow = [];

/** Test-only: clear the rolling window so suites don't bleed into each other. */
export function _resetSloState() {
  _clusterTimeoutWindow.length = 0;
}

/**
 * Evaluate the SLO conditions for one completed refresh and emit any breach
 * lines.  Side effects are limited to the log writes and the rolling-window
 * push, so the function stays deterministic and unit-testable.
 *
 * @param {object} input
 * @param {number} [input.pipelineMs]              end-to-end pipeline wall clock
 * @param {string|null} [input.clusteringFailureReason] 'timeout' | 'error' | null
 * @param {number} [input.clusteringAttempts]      clustering attempts this run;
 *   0 means clustering never ran (no sample is added to the timeout window).
 * @param {{ warn: Function }} [logger]            injectable for tests (default console)
 * @returns {{ breaches: string[], clusterTimeoutRate: number, windowSize: number }}
 */
export function evaluateRefreshSlo(
  { pipelineMs, clusteringFailureReason, clusteringAttempts = 0 } = {},
  logger = console
) {
  const breaches = [];

  // Condition A — a single slow refresh.
  if (Number.isFinite(pipelineMs) && pipelineMs > PIPELINE_SLOW_MS) {
    logger.warn(`[refresh.slo] breach=pipeline_slow pipelineMs=${pipelineMs}`);
    breaches.push("pipeline_slow");
  }

  // Condition B — sustained clustering-timeout rate over an ATTEMPT-ONLY
  // window.  Only refreshes that actually attempted clustering contribute a
  // sample; no-attempt refreshes are skipped so they can't dilute the rate.
  //
  // TERMINAL-FAILURE GUARD (Slice 3): the failure signal here is the terminal
  // `clusteringFailureReason` ("timeout") ONLY.  We deliberately do NOT read
  // any Slice 3 repair diagnostic (`clusteringRepairRawFailureClass` /
  // `clusteringRepairSchemaErrorBucket`) — those are non-null on RECOVERED
  // (published) runs too, so counting them would overcount failures and raise
  // false breach alarms.  Recovered runs still sample the window as a
  // non-timeout (`false`), which correctly reflects "clustering attempted and
  // did not time out".
  if (clusteringAttempts > 0) {
    _clusterTimeoutWindow.push(clusteringFailureReason === "timeout");
    while (_clusterTimeoutWindow.length > CLUSTER_TIMEOUT_WINDOW) {
      _clusterTimeoutWindow.shift();
    }
  }
  const windowSize = _clusterTimeoutWindow.length;
  const timeoutCount = _clusterTimeoutWindow.filter(Boolean).length;
  const clusterTimeoutRate = windowSize > 0 ? timeoutCount / windowSize : 0;
  if (
    windowSize >= CLUSTER_TIMEOUT_WINDOW &&
    clusterTimeoutRate > CLUSTER_TIMEOUT_RATE_THRESHOLD
  ) {
    logger.warn(
      `[refresh.slo] breach=cluster_timeout_rate rate=${clusterTimeoutRate.toFixed(2)} window=${CLUSTER_TIMEOUT_WINDOW}`
    );
    breaches.push("cluster_timeout_rate");
  }

  return { breaches, clusterTimeoutRate, windowSize };
}
