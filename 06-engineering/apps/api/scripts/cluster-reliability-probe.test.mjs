import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the script must not connect to anything (the entry-point guard keeps
// dotenv / Supabase / fetch out of the import path). These tests cover only the
// pure helpers: arg validation, median/p95, summary, and the gate decision.
const {
  parseArgs,
  median,
  percentile,
  countBy,
  summarize,
  evaluateGate,
  GATE,
  PROBE_MODE,
  LATENCY_SCOPE,
  isRecomputeRun,
  RECOMPUTE_ATTEMPT_MULTIPLIER,
  resolveSamplingPlan,
  shouldStopSampling,
  recomputeTargetMet,
  evaluateProbeDecision,
  extractClusteringFailureSubtype,
} = await import("./cluster-reliability-probe.mjs");

// ─── parseArgs ───────────────────────────────────────────────────────────────

test("parseArgs: requires --email or --user-id", () => {
  const r = parseArgs([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /--email|--user-id/);
});

test("parseArgs: rejects both --email and --user-id", () => {
  const r = parseArgs(["--email", "a@b.com", "--user-id", "u1"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /only one/i);
});

test("parseArgs: --email applies defaults", () => {
  const r = parseArgs(["--email", "a@b.com"]);
  assert.equal(r.ok, true);
  assert.equal(r.email, "a@b.com");
  assert.equal(r.userId, null);
  assert.equal(r.runs, GATE.defaultRuns);
  assert.equal(r.cooldownMs, GATE.defaultCooldownMs);
  assert.equal(r.baseUrl, GATE.defaultBaseUrl);
});

test("parseArgs: --user-id with overrides", () => {
  const r = parseArgs([
    "--user-id", "uuid-1",
    "--runs", "5",
    "--cooldown-ms", "0",
    "--base-url", "http://localhost:9999",
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.userId, "uuid-1");
  assert.equal(r.runs, 5);
  assert.equal(r.cooldownMs, 0);
  assert.equal(r.baseUrl, "http://localhost:9999");
});

test("parseArgs: rejects non-positive / non-numeric / non-integer --runs", () => {
  assert.equal(parseArgs(["--user-id", "u", "--runs", "0"]).ok, false);
  assert.equal(parseArgs(["--user-id", "u", "--runs", "-3"]).ok, false);
  assert.equal(parseArgs(["--user-id", "u", "--runs", "x"]).ok, false);
  assert.equal(parseArgs(["--user-id", "u", "--runs", "2.5"]).ok, false);
});

test("parseArgs: rejects negative --cooldown-ms", () => {
  assert.equal(parseArgs(["--user-id", "u", "--cooldown-ms", "-1"]).ok, false);
});

test("parseArgs: rejects unknown argument", () => {
  const r = parseArgs(["--user-id", "u", "--bogus"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown/i);
});

test("parseArgs: --mode defaults to 'default' (backward-compatible)", () => {
  const r = parseArgs(["--email", "a@b.com"]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, PROBE_MODE.DEFAULT);
  assert.equal(r.mode, "default");
});

test("parseArgs: --mode accepts 'cold-start'", () => {
  const r = parseArgs(["--email", "a@b.com", "--mode", "cold-start"]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, PROBE_MODE.COLD_START);
});

test("parseArgs: --mode rejects an unknown value", () => {
  const r = parseArgs(["--email", "a@b.com", "--mode", "warm"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /--mode/);
});

test("parseArgs: --require-recompute defaults false, sets true when present", () => {
  assert.equal(parseArgs(["--email", "a@b.com"]).requireRecompute, false);
  const r = parseArgs(["--email", "a@b.com", "--require-recompute"]);
  assert.equal(r.ok, true);
  assert.equal(r.requireRecompute, true);
});

// ─── recompute-enforced sampling plan (Prompt 2b) ────────────────────────────

test("resolveSamplingPlan: default (no enforcement) → fixed-N loop", () => {
  const plan = resolveSamplingPlan({ runs: 20, requireRecompute: false });
  assert.equal(plan.requireRecompute, false);
  assert.equal(plan.targetRecomputeRuns, null);
  assert.equal(plan.maxAttempts, 20);
});

test("resolveSamplingPlan: enforced → target N recompute runs, attempt cap = N×multiplier", () => {
  const plan = resolveSamplingPlan({ runs: 20, requireRecompute: true });
  assert.equal(plan.requireRecompute, true);
  assert.equal(plan.targetRecomputeRuns, 20);
  assert.equal(plan.maxAttempts, 20 * RECOMPUTE_ATTEMPT_MULTIPLIER);
});

test("shouldStopSampling: fixed-N loop stops at the attempt cap only", () => {
  const plan = resolveSamplingPlan({ runs: 3, requireRecompute: false });
  assert.equal(shouldStopSampling({ attempts: 2, recomputeRuns: 0, plan }), false);
  assert.equal(shouldStopSampling({ attempts: 3, recomputeRuns: 0, plan }), true);
  // recompute count is irrelevant in fixed mode.
  assert.equal(shouldStopSampling({ attempts: 2, recomputeRuns: 99, plan }), false);
});

test("shouldStopSampling: enforced loop stops when recompute target reached", () => {
  const plan = resolveSamplingPlan({ runs: 3, requireRecompute: true }); // cap 15
  assert.equal(shouldStopSampling({ attempts: 5, recomputeRuns: 2, plan }), false);
  assert.equal(shouldStopSampling({ attempts: 5, recomputeRuns: 3, plan }), true);
});

test("shouldStopSampling: enforced loop also stops at the attempt cap (server keeps skipping)", () => {
  const plan = resolveSamplingPlan({ runs: 3, requireRecompute: true }); // cap 15
  assert.equal(shouldStopSampling({ attempts: 14, recomputeRuns: 1, plan }), false);
  assert.equal(shouldStopSampling({ attempts: 15, recomputeRuns: 1, plan }), true);
});

test("recomputeTargetMet: trivially true without enforcement; reflects count when enforced", () => {
  const fixed = resolveSamplingPlan({ runs: 20, requireRecompute: false });
  assert.equal(recomputeTargetMet({ plan: fixed, recomputeRuns: 0 }), true);
  const enforced = resolveSamplingPlan({ runs: 20, requireRecompute: true });
  assert.equal(recomputeTargetMet({ plan: enforced, recomputeRuns: 19 }), false);
  assert.equal(recomputeTargetMet({ plan: enforced, recomputeRuns: 20 }), true);
});

// ─── evaluateProbeDecision (strict sample-quality gate, Prompt 2b gap fix) ────

const PASS_GATE = { pass: true, reasons: [] };
const FAIL_GATE = { pass: false, reasons: ["successRate 0.900 < 0.95"] };

test("evaluateProbeDecision: default mode is backward-compatible (pass === gate.pass)", () => {
  const plan = resolveSamplingPlan({ runs: 20, requireRecompute: false });
  const passed = evaluateProbeDecision({ gate: PASS_GATE, plan, recomputeRuns: 0 });
  assert.equal(passed.pass, true);
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.sampleQualityOk, true);
  const failed = evaluateProbeDecision({ gate: FAIL_GATE, plan, recomputeRuns: 0 });
  assert.equal(failed.pass, false);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.sampleQualityOk, true, "no sample-quality gate in default mode");
});

test("evaluateProbeDecision: require-recompute + target MET → success path allowed", () => {
  const plan = resolveSamplingPlan({ runs: 20, requireRecompute: true });
  const d = evaluateProbeDecision({ gate: PASS_GATE, plan, recomputeRuns: 20 });
  assert.equal(d.sampleQualityOk, true);
  assert.equal(d.pass, true);
  assert.equal(d.exitCode, 0);
});

test("evaluateProbeDecision: require-recompute + target NOT met → fails non-zero even when reliability gate passes", () => {
  const plan = resolveSamplingPlan({ runs: 20, requireRecompute: true });
  const d = evaluateProbeDecision({ gate: PASS_GATE, plan, recomputeRuns: 1 });
  assert.equal(d.gatePass, true, "reliability gate independently passed");
  assert.equal(d.sampleQualityOk, false);
  assert.equal(d.pass, false, "but the run fails on sample quality");
  assert.equal(d.exitCode, 1);
  assert.match(d.reasons.join(" "), /recompute sample insufficient/);
});

test("evaluateProbeDecision: require-recompute + target NOT met AND gate fails → both reasons surfaced, non-zero", () => {
  const plan = resolveSamplingPlan({ runs: 20, requireRecompute: true });
  const d = evaluateProbeDecision({ gate: FAIL_GATE, plan, recomputeRuns: 1 });
  assert.equal(d.pass, false);
  assert.equal(d.exitCode, 1);
  assert.equal(d.gatePass, false);
  assert.equal(d.sampleQualityOk, false);
  assert.match(d.reasons.join(" "), /successRate/);
  assert.match(d.reasons.join(" "), /recompute sample insufficient/);
});

test("evaluateProbeDecision: sample-quality gate is independent of successRate/medianStories", () => {
  // Same insufficient recompute sample → fails regardless of how strong the
  // reliability metrics are.
  const plan = resolveSamplingPlan({ runs: 10, requireRecompute: true });
  const strongGate = { pass: true, reasons: [] };
  const d = evaluateProbeDecision({ gate: strongGate, plan, recomputeRuns: 3 });
  assert.equal(d.pass, false);
  assert.equal(d.exitCode, 1);
});

// ─── isRecomputeRun ───────────────────────────────────────────────────────────

test("isRecomputeRun: null/absent refreshSkippedReason → recompute", () => {
  assert.equal(isRecomputeRun({ refreshSkippedReason: null }), true);
  assert.equal(isRecomputeRun({}), true);
});

test("isRecomputeRun: any skip reason → not a recompute", () => {
  assert.equal(isRecomputeRun({ refreshSkippedReason: "unchanged_watermark" }), false);
  assert.equal(
    isRecomputeRun({ refreshSkippedReason: "clustering_failed_snapshot_preserved" }),
    false
  );
});

// ─── median ──────────────────────────────────────────────────────────────────

test("median: empty array → 0", () => {
  assert.equal(median([]), 0);
});

test("median: odd length", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median: even length averages the middle two", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("median: does not mutate input", () => {
  const input = [5, 1, 3];
  median(input);
  assert.deepEqual(input, [5, 1, 3]);
});

// ─── percentile / p95 ────────────────────────────────────────────────────────

test("percentile: empty array → 0", () => {
  assert.equal(percentile([], 0.95), 0);
});

test("percentile: single value", () => {
  assert.equal(percentile([42], 0.95), 42);
});

test("percentile: p95 nearest-rank over 20 values", () => {
  const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
  // ceil(0.95 * 20) = 19 → index 18 → 1900
  assert.equal(percentile(values, 0.95), 1900);
});

test("percentile: p50 equals lower-mid for even N (nearest-rank)", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
});

// ─── countBy ─────────────────────────────────────────────────────────────────

test("countBy: tallies keys and skips null/undefined", () => {
  const items = [
    { r: "timeout" },
    { r: "timeout" },
    { r: "error" },
    { r: null },
    { r: undefined },
  ];
  assert.deepEqual(countBy(items, (x) => x.r), { timeout: 2, error: 1 });
});

// ─── summarize ───────────────────────────────────────────────────────────────

function rec(over = {}) {
  return {
    stories: 2,
    usedFallbackClustering: false,
    clusteringFailureReason: null,
    refreshSkippedReason: null,
    pipelineMs: 1000,
    ...over,
  };
}

test("summarize: all-success run", () => {
  const s = summarize([rec(), rec(), rec()]);
  assert.equal(s.runs, 3);
  assert.equal(s.successRate, 1);
  assert.equal(s.medianStories, 2);
  assert.equal(s.p95PipelineMs, 1000);
  assert.deepEqual(s.clusteringFailureReasons, {});
  assert.deepEqual(s.refreshSkippedReasons, {});
});

test("summarize: mixed success/fallback computes rate + reason counts", () => {
  const records = [
    rec({ stories: 3 }),
    rec({ stories: 2 }),
    rec({
      stories: 0,
      usedFallbackClustering: true,
      clusteringFailureReason: "timeout",
      pipelineMs: 5000,
    }),
    rec({
      stories: 0,
      usedFallbackClustering: true,
      clusteringFailureReason: "error",
      refreshSkippedReason: "clustering_failed_snapshot_preserved",
      pipelineMs: 4000,
    }),
  ];
  const s = summarize(records);
  assert.equal(s.runs, 4);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.medianStories, 1); // [0,0,2,3] → (0+2)/2
  assert.deepEqual(s.clusteringFailureReasons, { timeout: 1, error: 1 });
  assert.deepEqual(s.refreshSkippedReasons, {
    clustering_failed_snapshot_preserved: 1,
  });
});

test("summarize: Prompt 1 subtype histogram splits the coarse error bucket", () => {
  // Same coarse reason ("error") on two runs, distinct subtypes — the subtype
  // histogram must separate them so a NO-GO can be attributed. Visibility only:
  // successRate / medianStories are unaffected.
  const records = [
    rec({ stories: 3 }),
    rec({
      stories: 0,
      usedFallbackClustering: true,
      clusteringFailureReason: "error",
      clusteringFailureSubtype: "parse",
    }),
    rec({
      stories: 0,
      usedFallbackClustering: true,
      clusteringFailureReason: "error",
      clusteringFailureSubtype: "provider_request",
    }),
    rec({
      stories: 0,
      usedFallbackClustering: true,
      clusteringFailureReason: "timeout",
      clusteringFailureSubtype: "timeout_budget",
    }),
  ];
  const s = summarize(records);
  assert.deepEqual(s.clusteringFailureReasons, { error: 2, timeout: 1 });
  assert.deepEqual(s.clusteringFailureSubtypes, {
    parse: 1,
    provider_request: 1,
    timeout_budget: 1,
  });
});

// ─── Prompt 1.1: subtype extraction from _meta (top-level + outcomes fallback) ─

test("extractClusteringFailureSubtype: reads top-level _meta.clusteringFailureSubtype", () => {
  assert.equal(
    extractClusteringFailureSubtype({ clusteringFailureSubtype: "parse" }),
    "parse"
  );
});

test("extractClusteringFailureSubtype: falls back to _meta.outcomes when top-level absent", () => {
  assert.equal(
    extractClusteringFailureSubtype({ outcomes: { clusteringFailureSubtype: "provider_request" } }),
    "provider_request"
  );
});

test("extractClusteringFailureSubtype: top-level wins over outcomes; null when neither present", () => {
  assert.equal(
    extractClusteringFailureSubtype({
      clusteringFailureSubtype: "timeout_budget",
      outcomes: { clusteringFailureSubtype: "parse" },
    }),
    "timeout_budget"
  );
  assert.equal(extractClusteringFailureSubtype({}), null);
  assert.equal(extractClusteringFailureSubtype(null), null);
  assert.equal(extractClusteringFailureSubtype({ outcomes: {} }), null);
});

test("summarize: subtype histogram works end-to-end from the outcomes-only _meta shape", () => {
  // Simulate the records a probe builds against a server that exposes the subtype
  // ONLY under `_meta.outcomes` (the gap Prompt 1.1 closes). Extraction must
  // recover it so the histogram is populated, not empty.
  const metas = [
    { clusteringFailureReason: null }, // success run, no failure
    { clusteringFailureReason: "error", outcomes: { clusteringFailureSubtype: "parse" } },
    { clusteringFailureReason: "error", outcomes: { clusteringFailureSubtype: "provider_request" } },
    // Mixed: a newer server exposing the top-level key alongside outcomes.
    { clusteringFailureReason: "timeout", clusteringFailureSubtype: "timeout_budget", outcomes: { clusteringFailureSubtype: "timeout_budget" } },
  ];
  const records = metas.map((meta, i) => ({
    stories: i === 0 ? 3 : 0,
    usedFallbackClustering: meta.clusteringFailureReason != null,
    clusteringFailureReason: meta.clusteringFailureReason ?? null,
    clusteringFailureSubtype: extractClusteringFailureSubtype(meta),
    refreshSkippedReason: null,
    pipelineMs: 1000,
  }));
  const s = summarize(records);
  assert.deepEqual(s.clusteringFailureSubtypes, {
    parse: 1,
    provider_request: 1,
    timeout_budget: 1,
  });
  // Gate math is unaffected by the additive subtype field.
  assert.equal(s.runs, 4);
  assert.equal(s.successRate, 0.25);
  assert.equal(s.medianStories, 0);
});

test("summarize: ignores non-numeric pipelineMs in p95", () => {
  const s = summarize([rec({ pipelineMs: null }), rec({ pipelineMs: 200 })]);
  assert.equal(s.p95PipelineMs, 200);
});

// ─── summarize: cold-start latency scope (Step 4.1) ──────────────────────────

test("summarize: default scope is backward-compatible and reports scope metadata", () => {
  // Two recompute runs + one watermark-skip run. Default scope spans ALL runs,
  // so the slow skip run's pipelineMs still counts toward p95 (unchanged).
  const records = [
    rec({ pipelineMs: 1000 }),
    rec({ pipelineMs: 2000 }),
    rec({ pipelineMs: 9000, refreshSkippedReason: "unchanged_watermark" }),
  ];
  const s = summarize(records);
  assert.equal(s.latencyScope, LATENCY_SCOPE.ALL);
  assert.equal(s.p95PipelineMs, 9000, "default scope includes the skip run's latency");
  assert.equal(s.recomputeRuns, 2);
  assert.equal(s.skippedRuns, 1);
  assert.equal(s.latencyRunsCounted, 3);
});

test("summarize: cold-start scope excludes watermark-skip runs from p95", () => {
  // Same records; cold-start scope drops the 9000ms skip run so p95 reflects
  // only the recompute runs (real clustering work).
  const records = [
    rec({ pipelineMs: 1000 }),
    rec({ pipelineMs: 2000 }),
    rec({ pipelineMs: 9000, refreshSkippedReason: "unchanged_watermark" }),
  ];
  const s = summarize(records, { latencyScope: LATENCY_SCOPE.RECOMPUTE });
  assert.equal(s.latencyScope, LATENCY_SCOPE.RECOMPUTE);
  assert.equal(s.p95PipelineMs, 2000, "cold-start scope excludes the skip run from latency");
  assert.equal(s.recomputeRuns, 2);
  assert.equal(s.skippedRuns, 1);
  assert.equal(s.latencyRunsCounted, 2);
});

test("summarize: gate fields (successRate, medianStories) are identical across scopes", () => {
  // Gate semantics MUST NOT depend on --mode. A skip run that succeeded counts
  // toward successRate/medianStories in both scopes; only latency scoping moves.
  const records = [
    rec({ stories: 3, pipelineMs: 1000 }),
    rec({ stories: 0, usedFallbackClustering: true, clusteringFailureReason: "timeout", pipelineMs: 8000 }),
    rec({ stories: 2, pipelineMs: 9000, refreshSkippedReason: "unchanged_watermark" }),
  ];
  const all = summarize(records, { latencyScope: LATENCY_SCOPE.ALL });
  const cold = summarize(records, { latencyScope: LATENCY_SCOPE.RECOMPUTE });
  assert.equal(all.successRate, cold.successRate, "successRate independent of scope");
  assert.equal(all.medianStories, cold.medianStories, "medianStories independent of scope");
  assert.deepEqual(all.clusteringFailureReasons, cold.clusteringFailureReasons);
  // Latency differs: ALL includes the 9000 skip, RECOMPUTE excludes it.
  assert.equal(all.p95PipelineMs, 9000);
  assert.equal(cold.p95PipelineMs, 8000);
});

test("summarize: cold-start scope with all runs skipped → 0 latency, gate still over all runs", () => {
  const records = [
    rec({ stories: 2, refreshSkippedReason: "unchanged_watermark", pipelineMs: 500 }),
    rec({ stories: 3, refreshSkippedReason: "unchanged_watermark", pipelineMs: 600 }),
  ];
  const s = summarize(records, { latencyScope: LATENCY_SCOPE.RECOMPUTE });
  assert.equal(s.recomputeRuns, 0);
  assert.equal(s.skippedRuns, 2);
  assert.equal(s.latencyRunsCounted, 0);
  assert.equal(s.p95PipelineMs, 0, "no recompute runs → empty latency sample → 0");
  // Gate inputs unaffected: both runs succeeded → successRate 1, median 2.5.
  assert.equal(s.successRate, 1);
  assert.equal(s.medianStories, 2.5);
});

// ─── evaluateGate ────────────────────────────────────────────────────────────

test("evaluateGate: passes when both thresholds met", () => {
  const g = evaluateGate({ successRate: 0.95, medianStories: 2 });
  assert.equal(g.pass, true);
  assert.deepEqual(g.reasons, []);
});

test("evaluateGate: fails on low successRate", () => {
  const g = evaluateGate({ successRate: 0.9, medianStories: 3 });
  assert.equal(g.pass, false);
  assert.equal(g.reasons.length, 1);
  assert.match(g.reasons[0], /successRate/);
});

test("evaluateGate: fails on low medianStories", () => {
  const g = evaluateGate({ successRate: 1, medianStories: 1 });
  assert.equal(g.pass, false);
  assert.match(g.reasons[0], /medianStories/);
});

test("evaluateGate: reports both failures", () => {
  const g = evaluateGate({ successRate: 0.5, medianStories: 0 });
  assert.equal(g.pass, false);
  assert.equal(g.reasons.length, 2);
});

test("evaluateGate: exact boundary (0.95 / 2) passes", () => {
  assert.equal(
    evaluateGate({ successRate: GATE.minSuccessRate, medianStories: GATE.minMedianStories }).pass,
    true
  );
});
