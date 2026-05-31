/**
 * D1 — ingestion-cache benefit window (measurement + guardrails only)
 *
 * Pure, deterministic computation of the cache-benefit advisory from a stream
 * of refresh runs classified by ingestion source. Shared by the runtime
 * observability surface (`server.mjs` → `emitRefreshObservability`) and the
 * standalone advisory eval so both compute the verdict identically.
 *
 * IMPORTANT: this module changes NO runtime policy. It does not read or write
 * the cache, does not influence TTL / cadence / warmer scheduling, and never
 * throws into the refresh path. It only observes `pipelineMs` per run and
 * reports whether the locked D1 success criteria are met:
 *
 *   1. cache-hit refresh p50 must be >= 20% faster than live-scoped p50
 *      improvement% = (live_p50 - cache_p50) / live_p50  >= 0.20
 *   2. cache-hit rate in the measured window must be >= 60%
 *   3. enough samples on BOTH sides of a 5-run-per-mode window
 *
 * Enforcement is advisory by intent (hybrid: advisory now, path to blocking
 * later). The eval exits non-zero on unmet criteria; the runtime only logs.
 *
 * Comparison window (locked decision #4): median of the last 5 runs per mode
 * (cache_hit vs live_scoped). The hit-rate window (locked decision #7) is the
 * most recent `2 * medianWindow` comparable runs, so it reflects the real
 * arrival mix rather than the artificially balanced per-mode medians.
 */

/** Locked D1 thresholds (success criteria + extra guardrail). */
export const CACHE_BENEFIT_DEFAULTS = Object.freeze({
  medianWindow: 5,
  minImprovementPct: 0.2,
  minHitRate: 0.6,
});

/** Stable reason codes emitted in the advisory verdict (machine-parseable). */
export const CACHE_BENEFIT_REASON = Object.freeze({
  INSUFFICIENT_SAMPLE: "insufficient_sample",
  IMPROVEMENT_BELOW_THRESHOLD: "improvement_below_threshold",
  IMPROVEMENT_UNMEASURABLE: "improvement_unmeasurable",
  HIT_RATE_BELOW_THRESHOLD: "hit_rate_below_threshold",
});

// Bounded in-memory ring buffer for the runtime window. Per-process only —
// observability state, never persisted, never authoritative.
const MAX_RUNTIME_WINDOW = 50;
const _runtimeWindow = [];

/**
 * Map the server-resolved ingestion source onto the two comparison modes.
 * Full-manifest "live" fetches are intentionally NOT comparable to scoped
 * cache hits, so they classify as "other" and are excluded from the window.
 */
export function classifyRunMode(ingestionSource) {
  if (ingestionSource === "cache") return "cache_hit";
  if (ingestionSource === "live_scoped") return "live_scoped";
  return "other";
}

/** Median of a numeric array; null on empty input. Even counts average the two middles. */
export function median(values) {
  const nums = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fmtPct(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/**
 * Compute the cache-benefit advisory verdict from a chronological run list.
 *
 * @param {Array<{mode: string, pipelineMs: number}>} runs - oldest → newest.
 * @param {object} [opts] - threshold overrides (defaults: CACHE_BENEFIT_DEFAULTS).
 * @returns advisory verdict { ok, reasons, reasonCodes, cacheP50, liveP50,
 *   improvementPct, hitRate, sampleCounts, medianWindow, thresholds }.
 */
export function computeCacheBenefit(runs, opts = {}) {
  const { medianWindow, minImprovementPct, minHitRate } = { ...CACHE_BENEFIT_DEFAULTS, ...opts };

  const comparable = (Array.isArray(runs) ? runs : []).filter(
    (r) =>
      r &&
      (r.mode === "cache_hit" || r.mode === "live_scoped") &&
      Number.isFinite(r.pipelineMs)
  );
  const cacheRuns = comparable.filter((r) => r.mode === "cache_hit");
  const liveRuns = comparable.filter((r) => r.mode === "live_scoped");

  // Medians: last `medianWindow` runs per mode (locked decision #4).
  const cacheWindow = cacheRuns.slice(-medianWindow);
  const liveWindow = liveRuns.slice(-medianWindow);
  const cacheP50 = median(cacheWindow.map((r) => r.pipelineMs));
  const liveP50 = median(liveWindow.map((r) => r.pipelineMs));
  const improvementPct =
    cacheP50 != null && liveP50 != null && liveP50 > 0
      ? (liveP50 - cacheP50) / liveP50
      : null;

  // Hit-rate: most recent `2 * medianWindow` comparable runs (locked decision #7).
  const hitWindow = comparable.slice(-(medianWindow * 2));
  const hitCount = hitWindow.filter((r) => r.mode === "cache_hit").length;
  const hitRate = hitWindow.length > 0 ? hitCount / hitWindow.length : null;

  const reasons = [];
  const reasonCodes = [];
  const insufficient = cacheWindow.length < medianWindow || liveWindow.length < medianWindow;

  if (insufficient) {
    reasonCodes.push(CACHE_BENEFIT_REASON.INSUFFICIENT_SAMPLE);
    reasons.push(
      `${CACHE_BENEFIT_REASON.INSUFFICIENT_SAMPLE}: cache_hit=${cacheWindow.length}/${medianWindow} live_scoped=${liveWindow.length}/${medianWindow}`
    );
  } else if (improvementPct == null) {
    // Both windows full but live_p50 is 0 (or non-finite) — cannot measure.
    reasonCodes.push(CACHE_BENEFIT_REASON.IMPROVEMENT_UNMEASURABLE);
    reasons.push(`${CACHE_BENEFIT_REASON.IMPROVEMENT_UNMEASURABLE}: live_p50=${liveP50}`);
  } else if (improvementPct < minImprovementPct) {
    reasonCodes.push(CACHE_BENEFIT_REASON.IMPROVEMENT_BELOW_THRESHOLD);
    reasons.push(
      `${CACHE_BENEFIT_REASON.IMPROVEMENT_BELOW_THRESHOLD}: ${fmtPct(improvementPct)} < ${fmtPct(minImprovementPct)}`
    );
  }

  if (hitRate != null && hitRate < minHitRate) {
    reasonCodes.push(CACHE_BENEFIT_REASON.HIT_RATE_BELOW_THRESHOLD);
    reasons.push(
      `${CACHE_BENEFIT_REASON.HIT_RATE_BELOW_THRESHOLD}: ${fmtPct(hitRate)} < ${fmtPct(minHitRate)}`
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    reasonCodes,
    cacheP50,
    liveP50,
    improvementPct,
    hitRate,
    sampleCounts: {
      cacheHit: cacheWindow.length,
      liveScoped: liveWindow.length,
      hitWindow: hitWindow.length,
      comparable: comparable.length,
    },
    medianWindow,
    thresholds: { minImprovementPct, minHitRate },
  };
}

/**
 * Runtime recorder: append one classified run to the in-memory window.
 * Only the two comparable modes are retained; "other"/unknown and runs
 * without a finite pipelineMs are ignored. Never throws.
 */
export function recordCacheBenefitRun({ mode, pipelineMs } = {}) {
  if (mode !== "cache_hit" && mode !== "live_scoped") return;
  if (!Number.isFinite(pipelineMs)) return;
  _runtimeWindow.push({ mode, pipelineMs });
  if (_runtimeWindow.length > MAX_RUNTIME_WINDOW) _runtimeWindow.shift();
}

/** Compute the advisory verdict over the current runtime window. */
export function summarizeCacheBenefitWindow(opts = {}) {
  return computeCacheBenefit(_runtimeWindow, opts);
}

/** Snapshot copy of the runtime window (for diagnostics / tests). */
export function getCacheBenefitWindow() {
  return _runtimeWindow.map((r) => ({ ...r }));
}

/** Clear the runtime window (test isolation only). */
export function resetCacheBenefitWindow() {
  _runtimeWindow.length = 0;
}
