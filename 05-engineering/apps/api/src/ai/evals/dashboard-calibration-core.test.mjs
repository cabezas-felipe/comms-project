// Embed-floor calibration harness — self-check (node:test).
//
// Locks the calibration harness's own correctness: guardrails hold at every
// floor, and the floor sweep produces the expected monotonic signal
// (similarityRejected rises, finalStories falls as the floor rises). This does
// NOT assert a product default — it guards the measurement tool itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CALIBRATION_FLOORS,
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
