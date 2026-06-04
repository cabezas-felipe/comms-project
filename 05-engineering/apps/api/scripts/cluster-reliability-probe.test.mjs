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

test("parseArgs: rejects non-positive / non-numeric --runs", () => {
  assert.equal(parseArgs(["--user-id", "u", "--runs", "0"]).ok, false);
  assert.equal(parseArgs(["--user-id", "u", "--runs", "-3"]).ok, false);
  assert.equal(parseArgs(["--user-id", "u", "--runs", "x"]).ok, false);
});

test("parseArgs: rejects negative --cooldown-ms", () => {
  assert.equal(parseArgs(["--user-id", "u", "--cooldown-ms", "-1"]).ok, false);
});

test("parseArgs: rejects unknown argument", () => {
  const r = parseArgs(["--user-id", "u", "--bogus"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown/i);
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

test("summarize: ignores non-numeric pipelineMs in p95", () => {
  const s = summarize([rec({ pipelineMs: null }), rec({ pipelineMs: 200 })]);
  assert.equal(s.p95PipelineMs, 200);
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
