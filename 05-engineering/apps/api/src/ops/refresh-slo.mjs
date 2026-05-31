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
//                           CLUSTER_TIMEOUT_WINDOW refreshes on THIS instance
//                           failed clustering with reason="timeout".  Only
//                           evaluated once the window is full so a single
//                           cold-start timeout can't trip it (balanced over
//                           noisy).
//
// State is a module-level rolling window, intentionally per-process (per API
// instance) and deterministic — `_resetSloState()` clears it for tests.

export const PIPELINE_SLOW_MS = 90_000;
export const CLUSTER_TIMEOUT_WINDOW = 10;
export const CLUSTER_TIMEOUT_RATE_THRESHOLD = 0.2;

// Rolling window of booleans: did this refresh fail clustering with
// reason="timeout"?  Oldest entries shift out once the window is full.
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
 * @param {{ warn: Function }} [logger]            injectable for tests (default console)
 * @returns {{ breaches: string[], clusterTimeoutRate: number, windowSize: number }}
 */
export function evaluateRefreshSlo(
  { pipelineMs, clusteringFailureReason } = {},
  logger = console
) {
  const breaches = [];

  // Condition A — a single slow refresh.
  if (Number.isFinite(pipelineMs) && pipelineMs > PIPELINE_SLOW_MS) {
    logger.warn(`[refresh.slo] breach=pipeline_slow pipelineMs=${pipelineMs}`);
    breaches.push("pipeline_slow");
  }

  // Condition B — sustained clustering-timeout rate across the rolling window.
  _clusterTimeoutWindow.push(clusteringFailureReason === "timeout");
  while (_clusterTimeoutWindow.length > CLUSTER_TIMEOUT_WINDOW) {
    _clusterTimeoutWindow.shift();
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
