// Embed-floor calibration harness — self-check (node:test).
//
// Locks the calibration harness's own correctness: guardrails hold at every
// floor, and the floor sweep produces the expected monotonic signal
// (similarityRejected rises, finalStories falls as the floor rises). This does
// NOT assert a product default — it guards the measurement tool itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATION_ARTIFACT_HARNESS,
  CALIBRATION_ARTIFACT_VERSION,
  DEFAULT_CALIBRATION_FLOORS,
  buildCalibrationArtifact,
  runDashboardCalibration,
} from "./dashboard-calibration-core.mjs";

test("default floor sweep is [0, 0.35, 0.40, 0.45]", () => {
  assert.deepEqual(Array.from(DEFAULT_CALIBRATION_FLOORS), [0, 0.35, 0.4, 0.45]);
});

test("calibration runs hermetically: 4 rows, no hard-guardrail failures", async () => {
  const { rows, hardFail } = await runDashboardCalibration();
  assert.equal(rows.length, 4);
  assert.equal(hardFail, false, `unexpected guardrail failures: ${JSON.stringify(rows.flatMap((r) => r.failures))}`);
  for (const r of rows) {
    assert.equal(r.usedFallbackClustering, false, `floor ${r.floor} fell closed`);
    assert.ok(r.reutersCount >= 1, `floor ${r.floor} lost Reuters presence`);
    assert.ok(r.liveblogCollapsed >= 3, `floor ${r.floor} liveblog dedupe regressed`);
    assert.equal(r.failures.length, 0, `floor ${r.floor} guardrail: ${r.failures.join("; ")}`);
  }
});

test("similarityRejected rises monotonically with the floor (0→1→2→3)", async () => {
  const { rows } = await runDashboardCalibration();
  // Probe bands 0.33/0.38/0.43/0.48 → exact reject counts per floor.
  assert.deepEqual(
    rows.map((r) => r.similarityRejected),
    [0, 1, 2, 3]
  );
  // minSimilarityThreshold echoes the injected floor.
  assert.deepEqual(
    rows.map((r) => r.minSimilarityThreshold),
    [0, 0.35, 0.4, 0.45]
  );
});

test("finalStories falls monotonically as the floor rises (more trimming)", async () => {
  const { rows } = await runDashboardCalibration();
  const counts = rows.map((r) => r.finalStories);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `finalStories not non-increasing: ${counts.join(",")}`);
  }
  assert.ok(counts[0] > counts[counts.length - 1], "floor=0 must admit strictly more stories than the highest floor");
});

test("each row carries the documented diagnostic fields", async () => {
  const { rows } = await runDashboardCalibration();
  for (const r of rows) {
    for (const k of [
      "floor",
      "finalStories",
      "usedFallbackClustering",
      "clusteringFailureReason",
      "keywordRecallCount",
      "finalRelevant",
      "similarityRejected",
      "minSimilarityThreshold",
      "reutersCount",
      "liveblogCollapsed",
      "failures",
    ]) {
      assert.ok(k in r, `row missing field ${k}`);
    }
  }
});

test("buildCalibrationArtifact produces a stable machine-readable shape", async () => {
  const result = await runDashboardCalibration();
  const ts = "2026-05-29T00:00:00.000Z";
  const artifact = buildCalibrationArtifact(result, { timestamp: ts });

  assert.equal(artifact.harness, CALIBRATION_ARTIFACT_HARNESS);
  assert.equal(artifact.version, CALIBRATION_ARTIFACT_VERSION);
  assert.equal(artifact.timestamp, ts, "timestamp is injected (pure — no Date inside)");
  assert.equal(artifact.productionDefaultFloor, 0.35);
  assert.deepEqual(artifact.floors, [0, 0.35, 0.4, 0.45]);
  assert.equal(artifact.overall.pass, true);
  assert.equal(artifact.overall.hardFail, false);
  assert.equal(artifact.rows.length, 4);

  // Each row renames `failures` → stable `guardrail: { pass, reasons }`.
  for (const row of artifact.rows) {
    assert.ok(!("failures" in row), "artifact rows must not leak internal `failures` key");
    assert.equal(typeof row.guardrail.pass, "boolean");
    assert.ok(Array.isArray(row.guardrail.reasons));
    for (const k of [
      "floor",
      "finalStories",
      "usedFallbackClustering",
      "clusteringFailureReason",
      "keywordRecallCount",
      "finalRelevant",
      "similarityRejected",
      "minSimilarityThreshold",
      "reutersCount",
      "liveblogCollapsed",
    ]) {
      assert.ok(k in row, `artifact row missing field ${k}`);
    }
  }
  // Round-trips through JSON.stringify (artifact must be serializable).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(artifact)));
});
