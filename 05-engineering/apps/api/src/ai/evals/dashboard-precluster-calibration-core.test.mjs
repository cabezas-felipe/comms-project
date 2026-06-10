// Pre-cluster weight calibration harness — self-check (node:test). Decision 10D.
//
// Locks the harness's own correctness: deterministic output, faithful baseline
// (its ranking equals the production scorer), the documented metric shape, and
// the guardrail semantics (baseline holds all invariants → no hardFail; a
// degenerate preset violates an invariant → not recommended, but NEVER fails the
// run). It does NOT assert a product weight default — it guards the tuning tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PRECLUSTER_PRESETS,
  PRECLUSTER_FIXTURE,
  PRECLUSTER_CAP,
  PRECLUSTER_TIE_PAIR,
  PRECLUSTER_CALIBRATION_HARNESS,
  PRECLUSTER_CALIBRATION_VERSION,
  runPreclusterCalibration,
  buildPreclusterCalibrationArtifact,
} from "./dashboard-precluster-calibration-core.mjs";
import {
  writePreclusterCalibrationArtifact,
  parsePreclusterJsonOut,
  DEFAULT_PRECLUSTER_ARTIFACT,
} from "./run-dashboard-precluster-calibration.mjs";

test("sweeps every defined preset and includes a baseline", async () => {
  const result = await runPreclusterCalibration();
  assert.equal(result.results.length, PRECLUSTER_PRESETS.length);
  assert.deepEqual(
    result.results.map((r) => r.preset),
    PRECLUSTER_PRESETS.map((p) => p.name)
  );
  assert.ok(result.results.some((r) => r.preset === "baseline"), "must sweep a baseline preset");
  assert.equal(result.cap, PRECLUSTER_CAP);
});

test("baseline is faithful (its ranking equals the production scorer) and passes", async () => {
  const result = await runPreclusterCalibration();
  assert.equal(result.baselineFaithful, true, "baseline ranking must equal production order");
  const baseline = result.results.find((r) => r.preset === "baseline");
  assert.equal(baseline.metrics.matchesProductionOrder, true);
  assert.equal(baseline.passesInvariants, true, `baseline violated an invariant: ${JSON.stringify(baseline.invariants)}`);
  assert.equal(baseline.recommended, true);
  // The production order itself must keep the on-beat election ahead of geo-noise.
  assert.equal(result.productionRankedSourceIds[0], "pc-el-cfg");
  assert.equal(result.hardFail, false);
});

test("deterministic: same fixtures → byte-identical artifact (timestamp injected)", async () => {
  const a = await runPreclusterCalibration();
  const b = await runPreclusterCalibration();
  const ts = "2026-06-09T00:00:00.000Z";
  const artA = buildPreclusterCalibrationArtifact(a, { timestamp: ts });
  const artB = buildPreclusterCalibrationArtifact(b, { timestamp: ts });
  assert.equal(JSON.stringify(artA), JSON.stringify(artB), "calibration output is not deterministic");
});

test("metric shape and ranges are well-formed for every preset", async () => {
  const { results } = await runPreclusterCalibration();
  const METRIC_KEYS = [
    "electionSurvivesCap",
    "electionItemsInCap",
    "geoNoiseInCap",
    "configuredElectionRank",
    "crossCountryRank",
    "geoNoiseLeakedAboveConfiguredElection",
    "geoNoiseLeakedAboveCrossCountry",
    "configuredGeoBeatsCrossCountry",
    "tieStable",
    "matchesProductionOrder",
  ];
  const geoNoiseCount = PRECLUSTER_FIXTURE.filter((e) => e.role === "geoNoise").length;
  for (const r of results) {
    for (const k of METRIC_KEYS) assert.ok(k in r.metrics, `${r.preset} missing metric ${k}`);
    // Ranked order is a permutation of the fixture (no drops, no dupes).
    assert.equal(r.rankedSourceIds.length, PRECLUSTER_FIXTURE.length);
    assert.equal(new Set(r.rankedSourceIds).size, PRECLUSTER_FIXTURE.length);
    assert.equal(r.survivorsAtCap.length, PRECLUSTER_CAP);
    assert.equal(typeof r.metrics.electionSurvivesCap, "boolean");
    assert.ok(r.metrics.electionItemsInCap >= 0 && r.metrics.electionItemsInCap <= PRECLUSTER_CAP);
    assert.ok(r.metrics.geoNoiseInCap >= 0 && r.metrics.geoNoiseInCap <= PRECLUSTER_CAP);
    assert.ok(r.metrics.geoNoiseLeakedAboveConfiguredElection <= geoNoiseCount);
    assert.ok(r.metrics.geoNoiseLeakedAboveCrossCountry <= geoNoiseCount);
    assert.equal(typeof r.passesInvariants, "boolean");
    assert.equal(r.recommended, r.passesInvariants, "recommended must track passesInvariants");
    // tie stability holds for every preset (the comparator is a total order).
    assert.equal(r.metrics.tieStable, true, `${r.preset} broke tie stability`);
  }
});

test("tie pair always resolves sourceId-ascending across presets", async () => {
  const { results } = await runPreclusterCalibration();
  const [tieA, tieZ] = PRECLUSTER_TIE_PAIR;
  for (const r of results) {
    assert.ok(
      r.rankedSourceIds.indexOf(tieA) < r.rankedSourceIds.indexOf(tieZ),
      `${r.preset} did not resolve the tie deterministically (${tieA} before ${tieZ})`
    );
  }
});

test("guardrail: a degenerate preset violates a hard invariant and is not recommended", async () => {
  const { results } = await runPreclusterCalibration();
  const offenders = results.filter((r) => !r.passesInvariants);
  assert.ok(offenders.length >= 1, "expected ≥1 degenerate preset to violate an invariant");
  for (const o of offenders) {
    assert.equal(o.recommended, false, `${o.preset} violated an invariant but was still recommended`);
  }
  // The geography-dominant preset must leak geo-noise above an election.
  const geoHeavy = results.find((r) => r.preset === "geo_heavy");
  assert.equal(geoHeavy.invariants.geoNoiseSuppressed, false, "geo_heavy should leak geo-noise above an election");
  // The recency-dominant preset must drop the on-beat election out of the cap.
  const freshHeavy = results.find((r) => r.preset === "freshness_heavy");
  assert.equal(freshHeavy.invariants.electionSurvivesCap, false, "freshness_heavy should sink the old on-beat election");
});

test("guardrail does NOT hardFail merely because some variant is worse", async () => {
  const result = await runPreclusterCalibration();
  // Despite geo_heavy / freshness_heavy failing invariants, the run is green
  // because the BASELINE is faithful and holds every invariant.
  assert.ok(result.results.some((r) => !r.passesInvariants), "fixture should include a failing variant");
  assert.equal(result.hardFail, false, "non-baseline failures must not fail the run");
});

test("hardFail fires when the baseline preset violates an invariant", async () => {
  // Inject a 'baseline' whose weights are degenerate (recency-dominant) so the
  // baseline itself violates an invariant → hardFail true.
  const broken = [
    {
      name: "baseline",
      description: "intentionally broken baseline for the fail-path test",
      weights: { topic: 0, keyword: 0, entity: 0, geo: 0, corroboration: 0, beatFit: 0, freshness: 50 },
      electionGeoBoost: 0,
      electionGeoPenalty: 0,
    },
  ];
  const result = await runPreclusterCalibration({ presets: broken });
  const baseline = result.results.find((r) => r.preset === "baseline");
  assert.equal(baseline.passesInvariants, false);
  // baselineFaithful is also false (its order won't match production) — either
  // condition is a true guardrail failure.
  assert.equal(result.hardFail, true, "a broken baseline must hardFail the run");
});

test("buildPreclusterCalibrationArtifact produces a stable machine-readable shape", async () => {
  const result = await runPreclusterCalibration();
  const ts = "2026-06-09T12:34:56.000Z";
  const artifact = buildPreclusterCalibrationArtifact(result, { timestamp: ts });

  assert.equal(artifact.harness, PRECLUSTER_CALIBRATION_HARNESS);
  assert.equal(artifact.version, PRECLUSTER_CALIBRATION_VERSION);
  assert.equal(artifact.timestamp, ts, "timestamp is injected (pure — no Date inside core)");
  assert.equal(artifact.cap, PRECLUSTER_CAP);
  assert.equal(artifact.overall.pass, true);
  assert.equal(artifact.overall.hardFail, false);
  assert.equal(artifact.baselineFaithful, true);
  assert.ok(Array.isArray(artifact.productionRankedSourceIds));
  assert.ok(Array.isArray(artifact.fixtureRoles));
  assert.equal(artifact.presets.length, PRECLUSTER_PRESETS.length);
  for (const p of artifact.presets) {
    for (const k of ["preset", "weights", "rankedSourceIds", "survivorsAtCap", "metrics", "invariants", "recommended"]) {
      assert.ok(k in p, `artifact preset missing ${k}`);
    }
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(artifact)));
});

test("writePreclusterCalibrationArtifact writes a parseable file to the given path", async () => {
  const result = await runPreclusterCalibration();
  const dir = mkdtempSync(path.join(tmpdir(), "precluster-cal-"));
  const out = path.join(dir, "nested", "artifact.json");
  try {
    const resolved = writePreclusterCalibrationArtifact(result, out, "2026-06-09T00:00:00.000Z");
    assert.equal(resolved, path.resolve(out));
    const parsed = JSON.parse(readFileSync(resolved, "utf8"));
    assert.equal(parsed.harness, PRECLUSTER_CALIBRATION_HARNESS);
    assert.equal(parsed.presets.length, PRECLUSTER_PRESETS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePreclusterJsonOut: --json-out override and default", () => {
  assert.equal(parsePreclusterJsonOut(["--json-out", "/tmp/x.json"]), "/tmp/x.json");
  assert.equal(parsePreclusterJsonOut(["--json-out=/tmp/y.json"]), "/tmp/y.json");
  assert.equal(parsePreclusterJsonOut([]), DEFAULT_PRECLUSTER_ARTIFACT);
  assert.equal(parsePreclusterJsonOut(["--other"], "/fallback.json"), "/fallback.json");
});
