import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRefreshSlo,
  _resetSloState,
  PIPELINE_SLOW_MS,
  CLUSTER_TIMEOUT_WINDOW,
  CLUSTER_TIMEOUT_RATE_THRESHOLD,
  CLUSTER_FAILURE_RATE_THRESHOLD,
  SLO_BREACHES,
} from "./refresh-slo.mjs";

// Capture both streams: breaches go to `.warn` (back-compat), the per-settle
// machine-readable gate snapshot goes to `.log` only.
function makeLogger() {
  const warn = [];
  const log = [];
  return { logger: { warn: (m) => warn.push(m), log: (m) => log.push(m) }, warn, log };
}

function lastGate(log) {
  const line = log.filter((l) => l.startsWith("[refresh.slo.gate] ")).at(-1);
  return line ? JSON.parse(line.slice("[refresh.slo.gate] ".length)) : null;
}

// ─── breach registry / action hints ─────────────────────────────────────────

test("SLO_BREACHES: every id carries a non-generic, operationally useful action hint", () => {
  for (const [id, def] of Object.entries(SLO_BREACHES)) {
    assert.equal(typeof def.actionHint, "string");
    assert.ok(def.actionHint.length > 0, `${id} must have an action hint`);
    assert.notEqual(def.actionHint, "investigate", `${id} hint must not be the generic fallback`);
    assert.equal(typeof def.meaning, "string");
  }
});

// ─── A. pipeline_slow ────────────────────────────────────────────────────────

test("pipeline_slow: breaches above the ceiling with a stable id, action hint, and gate field", () => {
  _resetSloState();
  const { logger, warn, log } = makeLogger();
  const res = evaluateRefreshSlo({ pipelineMs: PIPELINE_SLOW_MS + 1 }, logger);
  assert.ok(res.breaches.includes("pipeline_slow"));
  const detail = res.breachDetails.find((d) => d.id === "pipeline_slow");
  assert.equal(detail.actionHint, SLO_BREACHES.pipeline_slow.actionHint);
  assert.equal(detail.observed.thresholdMs, PIPELINE_SLOW_MS);
  assert.ok(warn.includes(`[refresh.slo] breach=pipeline_slow pipelineMs=${PIPELINE_SLOW_MS + 1}`));
  // Gate snapshot is emitted to .log (never .warn) and carries the breach id.
  const gate = lastGate(log);
  assert.equal(gate.pipelineMs, PIPELINE_SLOW_MS + 1);
  assert.ok(gate.breaches.includes("pipeline_slow"));
});

test("pipeline_slow: exactly at the ceiling does NOT breach (strict >)", () => {
  _resetSloState();
  const { logger, warn } = makeLogger();
  const res = evaluateRefreshSlo({ pipelineMs: PIPELINE_SLOW_MS }, logger);
  assert.ok(!res.breaches.includes("pipeline_slow"));
  assert.equal(warn.length, 0, "no breach → no .warn line");
});

// ─── window sample/skip rules ────────────────────────────────────────────────

test("window: no-attempt refreshes (clusteringAttempts=0) never sample the window", () => {
  _resetSloState();
  const { logger } = makeLogger();
  let res;
  for (let i = 0; i < 12; i++) {
    res = evaluateRefreshSlo({ pipelineMs: 10, clusteringAttempts: 0, clusteringFailureReason: "timeout" }, logger);
    assert.equal(res.windowSize, 0, `no-attempt refresh ${i} must not be sampled`);
  }
  assert.equal(res.clusterTimeoutRate, 0);
  assert.equal(res.clusterFailureRate, 0);
});

test("window: only attempting refreshes are sampled, capped at CLUSTER_TIMEOUT_WINDOW", () => {
  _resetSloState();
  const { logger } = makeLogger();
  let res;
  for (let i = 0; i < CLUSTER_TIMEOUT_WINDOW + 5; i++) {
    res = evaluateRefreshSlo({ pipelineMs: 10, clusteringAttempts: 1, clusteringFailureReason: null }, logger);
  }
  assert.equal(res.windowSize, CLUSTER_TIMEOUT_WINDOW, "window is bounded");
});

// ─── terminal-failure guard (Slice 3 semantics preserved) ────────────────────

test("terminal guard: recovered parse-repair runs are NOT counted as timeouts or failures", () => {
  _resetSloState();
  const { logger, warn } = makeLogger();
  // A recovered run: clustering attempted, the parse-repair pass succeeded, so
  // stories published with NO terminal failure.  We ALSO pass Slice 3 repair
  // diagnostics (rawFailureClass / schemaErrorBucket are non-null on recovered
  // runs) as extra input fields to prove the gate IGNORES them — failure
  // classification reads the terminal fields only.
  let res;
  for (let i = 0; i < CLUSTER_TIMEOUT_WINDOW; i++) {
    res = evaluateRefreshSlo(
      {
        pipelineMs: 10,
        clusteringAttempts: 2, // attempted (initial + retry)
        clusteringFailureReason: null, // terminal: did NOT fail
        usedFallbackClustering: false, // terminal: did NOT fall back
        storiesPublished: 3,
        // Non-terminal repair signals that MUST NOT be counted as failures:
        clusteringRepairRawFailureClass: "json_parse_error",
        clusteringRepairSchemaErrorBucket: "missing_field",
      },
      logger
    );
  }
  assert.equal(res.windowSize, CLUSTER_TIMEOUT_WINDOW, "recovered runs DO sample the window");
  assert.equal(res.clusterTimeoutRate, 0, "recovered run is not a timeout");
  assert.equal(res.clusterFailureRate, 0, "recovered run is not a failure (no overcount)");
  assert.deepEqual(res.breaches, [], "no breach from recovered runs");
  assert.equal(warn.length, 0);
});

// ─── B. cluster_timeout_rate: trigger + clear across window boundaries ───────

test("cluster_timeout_rate: only fires once the window is full, then CLEARS as timeouts age out", () => {
  _resetSloState();
  const { logger, warn } = makeLogger();
  // 3 timeouts / 10 = 0.30 > 0.20. Must not fire before the window fills.
  const reasons = ["timeout", "timeout", "timeout", null, null, null, null, null, null, null];
  let res;
  reasons.forEach((r, i) => {
    res = evaluateRefreshSlo({ pipelineMs: 10, clusteringAttempts: 1, clusteringFailureReason: r, usedFallbackClustering: r != null }, logger);
    if (i < CLUSTER_TIMEOUT_WINDOW - 1) {
      assert.ok(!res.breaches.includes("cluster_timeout_rate"), `no breach before full (call ${i})`);
    }
  });
  assert.ok(res.breaches.includes("cluster_timeout_rate"));
  assert.equal(res.windowSize, CLUSTER_TIMEOUT_WINDOW);
  assert.ok(warn.includes(`[refresh.slo] breach=cluster_timeout_rate rate=0.30 window=${CLUSTER_TIMEOUT_WINDOW}`));
  // Drive a clean window — timeouts shift out → breach CLEARS.
  for (let i = 0; i < CLUSTER_TIMEOUT_WINDOW; i++) {
    res = evaluateRefreshSlo({ pipelineMs: 10, clusteringAttempts: 1, clusteringFailureReason: null, usedFallbackClustering: false }, logger);
  }
  assert.equal(res.clusterTimeoutRate, 0);
  assert.ok(!res.breaches.includes("cluster_timeout_rate"), "breach clears after timeouts age out");
});

test("cluster_timeout_rate: exactly at the 0.2 threshold does NOT breach (strict >)", () => {
  _resetSloState();
  const { logger } = makeLogger();
  const reasons = ["timeout", "timeout", null, null, null, null, null, null, null, null]; // 0.20
  let res;
  reasons.forEach((r) => {
    res = evaluateRefreshSlo({ pipelineMs: 10, clusteringAttempts: 1, clusteringFailureReason: r, usedFallbackClustering: r != null }, logger);
  });
  assert.equal(res.clusterTimeoutRate, CLUSTER_TIMEOUT_RATE_THRESHOLD);
  assert.ok(!res.breaches.includes("cluster_timeout_rate"));
});

// ─── C. cluster_failure_rate: sustained errors (distinct from timeouts) ──────

test("cluster_failure_rate: sustained fail-closed ERRORS breach failure-rate but not timeout-rate", () => {
  _resetSloState();
  const { logger, warn, log } = makeLogger();
  // 6 error fail-closed / 10 = 0.60 > 0.50 failure threshold; 0 timeouts.
  const reasons = ["error", "error", "error", "error", "error", "error", null, null, null, null];
  let res;
  reasons.forEach((r) => {
    res = evaluateRefreshSlo({ pipelineMs: 10, clusteringAttempts: 2, clusteringFailureReason: r, usedFallbackClustering: r != null }, logger);
  });
  assert.equal(res.clusterTimeoutRate, 0, "errors are not timeouts");
  assert.equal(res.clusterFailureRate, 0.6);
  assert.ok(res.breaches.includes("cluster_failure_rate"));
  assert.ok(!res.breaches.includes("cluster_timeout_rate"), "timeout gate stays quiet on pure errors");
  const detail = res.breachDetails.find((d) => d.id === "cluster_failure_rate");
  assert.equal(detail.id, "cluster_failure_rate");
  assert.equal(detail.actionHint, SLO_BREACHES.cluster_failure_rate.actionHint);
  assert.equal(detail.observed.window, CLUSTER_TIMEOUT_WINDOW);
  assert.equal(detail.observed.threshold, CLUSTER_FAILURE_RATE_THRESHOLD);
  assert.ok(warn.some((l) => l.startsWith("[refresh.slo] breach=cluster_failure_rate rate=0.60")));
  // The breach id is mirrored into the machine-readable gate snapshot too.
  assert.ok(lastGate(log).breaches.includes("cluster_failure_rate"), "gate.breaches carries the breach id");
});

test("cluster_failure_rate: below the threshold across a full window does NOT breach (control)", () => {
  _resetSloState();
  const { logger, warn } = makeLogger();
  // 4 error fail-closed / 10 = 0.40, NOT > 0.50 → no failure breach (and no
  // timeout breach: 0 timeouts). A full window proves it's the rate, not the
  // "window not full yet" guard, keeping it quiet.
  const reasons = ["error", "error", "error", "error", null, null, null, null, null, null];
  let res;
  reasons.forEach((r) => {
    res = evaluateRefreshSlo({ pipelineMs: 10, clusteringAttempts: 2, clusteringFailureReason: r, usedFallbackClustering: r != null }, logger);
  });
  assert.equal(res.windowSize, CLUSTER_TIMEOUT_WINDOW, "window is full");
  assert.equal(res.clusterFailureRate, 0.4);
  assert.ok(!res.breaches.includes("cluster_failure_rate"), "0.40 ≤ 0.50 threshold → no breach");
  assert.ok(!warn.some((l) => l.includes("breach=cluster_failure_rate")), "no failure-rate breach line");
});

// ─── D. geo_budget_pressure (single-run) ─────────────────────────────────────

test("geo_budget_pressure: breaches only when the budget is hit AND Lane 2 was deferred", () => {
  _resetSloState();
  const { logger, warn } = makeLogger();
  // Hit + deferred → breach.
  let res = evaluateRefreshSlo(
    { pipelineMs: 10, geoBudgetHit: true, geoLane2Deferred: 4, geoBudgetMsConfigured: 12000, geoBudgetMsUsed: 12010, profile: { name: "interactive" } },
    logger
  );
  assert.ok(res.breaches.includes("geo_budget_pressure"));
  const detail = res.breachDetails.find((d) => d.id === "geo_budget_pressure");
  assert.equal(detail.actionHint, SLO_BREACHES.geo_budget_pressure.actionHint);
  assert.equal(detail.observed.lane2Deferred, 4);
  assert.equal(detail.observed.profile, "interactive");
  assert.ok(warn.some((l) => l.startsWith("[refresh.slo] breach=geo_budget_pressure deferred=4 budget_ms=12000 used_ms=12010")));
  // Budget hit but nothing deferred → NOT a breach (clean stop at a wave boundary).
  res = evaluateRefreshSlo({ pipelineMs: 10, geoBudgetHit: true, geoLane2Deferred: 0 }, logger);
  assert.ok(!res.breaches.includes("geo_budget_pressure"));
  // Deferred but budget not hit (shouldn't happen, but guard) → NOT a breach.
  res = evaluateRefreshSlo({ pipelineMs: 10, geoBudgetHit: false, geoLane2Deferred: 5 }, logger);
  assert.ok(!res.breaches.includes("geo_budget_pressure"));
});

// ─── empty-result health classification ──────────────────────────────────────

test("gate.emptyKind: distinguishes has_stories / clustering_failed / legitimate_empty", () => {
  _resetSloState();
  const { logger, log } = makeLogger();
  evaluateRefreshSlo({ pipelineMs: 10, storiesPublished: 2, usedFallbackClustering: false }, logger);
  assert.equal(lastGate(log).emptyKind, "has_stories");
  evaluateRefreshSlo({ pipelineMs: 10, storiesPublished: 0, usedFallbackClustering: true, clusteringAttempts: 2, clusteringFailureReason: "error" }, logger);
  assert.equal(lastGate(log).emptyKind, "clustering_failed");
  evaluateRefreshSlo({ pipelineMs: 10, storiesPublished: 0, usedFallbackClustering: false }, logger);
  assert.equal(lastGate(log).emptyKind, "legitimate_empty");
});

// ─── gate snapshot shape + routing ───────────────────────────────────────────

test("gate snapshot: emitted to .log (not .warn), grep-friendly, carries all gate fields", () => {
  _resetSloState();
  const { logger, warn, log } = makeLogger();
  const res = evaluateRefreshSlo(
    {
      pipelineMs: 1234,
      clusteringAttempts: 1,
      clusteringFailureReason: null,
      usedFallbackClustering: false,
      storiesPublished: 5,
      profile: { name: "interactive" },
      enrichment: { deferred: true, pending: 5, completed: 0, total: 5 },
    },
    logger
  );
  assert.equal(warn.length, 0, "healthy run emits no breach lines");
  const gate = lastGate(log);
  assert.ok(gate, "exactly one grep-friendly [refresh.slo.gate] line");
  // Required gate fields for downstream alerting/dashboards.
  for (const k of ["pipelineMs", "clusterTimeoutRate", "clusterFailureRate", "windowSize", "storiesPublished", "emptyKind", "profile", "geoBudgetHit", "geoLane2Deferred", "enrichment", "breaches"]) {
    assert.ok(k in gate, `gate must carry "${k}"`);
  }
  assert.equal(gate.profile, "interactive");
  assert.deepEqual(gate.enrichment, { deferred: true, pending: 5, completed: 0, total: 5 });
  assert.deepEqual(gate.breaches, []);
  // Return shape stays back-compat (Slice 3) plus additive fields.
  assert.ok(Array.isArray(res.breaches));
  assert.ok(Array.isArray(res.breachDetails));
  assert.equal(typeof res.clusterTimeoutRate, "number");
  assert.equal(typeof res.clusterFailureRate, "number");
  assert.equal(typeof res.windowSize, "number");
});
