// Dashboard Elections — Colombia — Q6B acceptance test (node:test).
//
// Wired as `npm run eval:dashboard-elections-colombia`. Hermetic: in-code
// RSS-shaped fixtures + an injected deterministic clusterFn, recall in keyword
// (lexical) mode — no provider keys, no network. This is the primary acceptance
// test for the relevance strategy: a single Colombia-presidential-election news
// mix must surface the election beat over wrong-geo / wrong-beat noise, ship at
// most 5 meta-stories, and keep the election stories when the cap fires.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ELECTIONS_COLOMBIA_PERSONA,
  ELECTIONS_COLOMBIA_RAW_ITEMS,
  ELECTION_IDS,
  SPANISH_ELECTION_IDS,
  HARD_FAIL_IDS,
  NEGATIVE_IDS,
  TOTAL_FIXTURES,
  CAP_PRESSURE_RAW_ITEMS,
  CROSS_COUNTRY_ELECTION_IDS,
  CAP_PRESSURE_NOISE_IDS,
  CAP_PRESSURE_SURVIVING_COUNT,
  runElectionsColombiaPipeline,
  runElectionsColombiaCapPressure,
  runDashboardElectionsColombia,
  runElectionsColombiaSameEventBundle,
} from "./dashboard-elections-colombia-core.mjs";

test("fixture set: 14 items — 8 Colombia election positives + 6 negatives, mixed ES/EN", () => {
  assert.equal(ELECTIONS_COLOMBIA_RAW_ITEMS.length, 14, "exactly 14 fixtures");
  assert.equal(TOTAL_FIXTURES, 14);
  assert.equal(ELECTION_IDS.length, 8, "8 election positives");
  assert.equal(NEGATIVE_IDS.length, 6, "6 negatives");
  assert.ok(SPANISH_ELECTION_IDS.length >= 3, "several Spanish-language election positives");
  assert.deepEqual(ELECTIONS_COLOMBIA_PERSONA.topics, ["Elections"]);
  assert.ok(ELECTIONS_COLOMBIA_PERSONA.geographies.includes("Colombia"));
});

test("all acceptance checks pass (aggregate runner used by the quality gate)", async () => {
  const { results, summary } = await runDashboardElectionsColombia();
  assert.equal(
    summary.passed,
    summary.total,
    `failing checks: ${JSON.stringify(results.filter((r) => !r.ok), null, 2)}`
  );
  assert.equal(summary.hardFail, false);
  assert.ok(summary.total >= 8, "covers the full acceptance matrix");
});

test("Phase 4.1: same-event election coverage fragmented across clusters bundles into one story", async () => {
  const { payload, log } = await runElectionsColombiaSameEventBundle();

  // The two same-event debate clusters (EN + ES) merge; the distinct vote-count
  // story stays separate → 2 published stories, one of them a 2-source bundle.
  assert.equal(log.electionBundle.enabled, true);
  assert.equal(log.electionBundle.mergedGroupCount, 1, "exactly one same-event bundle formed");
  assert.equal(log.electionBundle.mergedStoryCount, 2, "two clusters absorbed into the bundle");
  assert.equal(payload.stories.length, 2, "debate bundle + distinct vote-count story");

  const bundle = payload.stories.find((s) => (s.sources ?? []).length === 2);
  assert.ok(bundle, "the same-event debate coverage is one 2-source story");
  assert.deepEqual(
    bundle.sources.map((s) => s.id).sort(),
    ["se-debate-en", "se-debate-es"],
    "both debate wires share one meta-story"
  );
});

test("Q2 recall: all 14 fixtures reach the candidate stage", async () => {
  const { log } = await runElectionsColombiaPipeline();
  assert.equal(
    log.decisionTrace.stageCounts.afterSourceSelection,
    14,
    "every fixture clears source selection into the candidate pool"
  );
});

test("geo precision: explicit wrong-geo controls (Senegal, Argentina) are hard-failed pre-cluster", async () => {
  const { payload, log } = await runElectionsColombiaPipeline();
  assert.equal(log.geo.geoHardFailDroppedCount, 2, "two explicit wrong-geo controls hard-fail");
  const shipped = new Set(payload.stories.flatMap((s) => s.sources.map((src) => src.id)));
  for (const id of HARD_FAIL_IDS) {
    assert.ok(!shipped.has(id), `wrong-geo control ${id} must not ship`);
  }
});

test("Q3: dashboard ships at most 5 meta-stories and the overflow cap drops the geo-noise story", async () => {
  const { payload, log } = await runElectionsColombiaPipeline();
  assert.ok(payload.stories.length <= 5, `ships <= 5 (got ${payload.stories.length})`);
  assert.equal(log.metaStoryCount, payload.stories.length);
  // The clustered set overflowed (6 stories) and the cap trimmed the generic
  // same-geography noise story — relevance survival keeps the election beat.
  assert.equal(log.overflowCap.overflowCapApplied, true, "overflow cap fired");
  assert.ok(
    log.overflowCap.overflowDroppedMetaStoryIds.includes("ms-noise-tremor"),
    `the geo-noise story must be the drop, got ${JSON.stringify(log.overflowCap.overflowDroppedMetaStoryIds)}`
  );
});

test("election relevance survives: every shipped story is an election story, >=1 multi-source", async () => {
  const { payload } = await runElectionsColombiaPipeline();
  const stories = payload.stories;
  assert.ok(stories.length >= 1, "at least one election story ships");
  const electionSet = new Set(ELECTION_IDS);
  for (const s of stories) {
    for (const src of s.sources) {
      assert.ok(electionSet.has(src.id), `shipped story ${s.metaStoryId} carries non-election source ${src.id}`);
    }
  }
  // Q3B corroboration / bundling: at least one shipped election story is multi-source.
  assert.ok(
    stories.some((s) => s.sources.length >= 2),
    "at least one shipped election meta-story must be multi-source"
  );
});

test("wrong-region and wrong-beat controls are absent from shipped stories", async () => {
  const { payload } = await runElectionsColombiaPipeline();
  const shipped = new Set(payload.stories.flatMap((s) => s.sources.map((src) => src.id)));
  for (const id of NEGATIVE_IDS) {
    assert.ok(!shipped.has(id), `control ${id} must not appear in any shipped story`);
  }
});

test("Q2 translation-first: Spanish-language election coverage is admitted and ships", async () => {
  const { payload } = await runElectionsColombiaPipeline();
  const shipped = new Set(payload.stories.flatMap((s) => s.sources.map((src) => src.id)));
  const spanishShipped = SPANISH_ELECTION_IDS.filter((id) => shipped.has(id));
  assert.ok(
    spanishShipped.length >= 1,
    `Spanish election coverage must reach the dashboard via the geo lexical gate; shipped ${JSON.stringify(spanishShipped)}`
  );
});

// ─── Step 1.8: cap-pressure — election survival INTO cluster input ───────────

test("cap-pressure fixture: surviving candidate pool exceeds the C1 cap (15)", () => {
  // 8 Colombia elections + 3 cross-country + 9 noise + 2 hard-fail controls.
  assert.equal(CAP_PRESSURE_RAW_ITEMS.length, 22, "22 raw fixtures");
  assert.equal(CAP_PRESSURE_SURVIVING_COUNT, 20, "20 survive hard-fail → over the 15 cap");
  assert.equal(CROSS_COUNTRY_ELECTION_IDS.length, 3);
  assert.equal(CAP_PRESSURE_NOISE_IDS.length, 9);
});

test("cap-pressure: C1 cap bites and clusterInput holds exactly 15 candidates", async () => {
  const { log, clusterInput } = await runElectionsColombiaCapPressure();
  assert.ok(log.clusterCap.dedupedCount > 15, `pool exceeds cap (got ${log.clusterCap.dedupedCount})`);
  assert.equal(clusterInput.length, 15, "clusterInput is capped at 15");
  assert.equal(log.clusterCap.clusterInputCount, 15);
});

test("cap-pressure: Colombia election positives survive into cluster input, noise does not dominate", async () => {
  const { clusterInput } = await runElectionsColombiaCapPressure();
  const ids = new Set(clusterInput.map((i) => i.sourceId));
  const electionIn = ELECTION_IDS.filter((id) => ids.has(id)).length;
  const noiseIn = CAP_PRESSURE_NOISE_IDS.filter((id) => ids.has(id)).length;
  assert.ok(electionIn >= 6, `>=6 Colombia elections in clusterInput (got ${electionIn})`);
  assert.ok(electionIn > noiseIn, `elections (${electionIn}) must outnumber noise (${noiseIn}) in clusterInput`);
});

test("cap-pressure (Decision 5C): configured-geo elections outrank cross-country in clusterInput", async () => {
  const { clusterInput } = await runElectionsColombiaCapPressure();
  const ids = clusterInput.map((i) => i.sourceId);
  const crossIn = CROSS_COUNTRY_ELECTION_IDS.filter((id) => ids.includes(id)).length;
  const colombiaIn = ELECTION_IDS.filter((id) => ids.includes(id)).length;
  assert.ok(crossIn >= 1, "at least one cross-country election still survives the cap");
  // Configured-geo presence stays stronger than cross-country.
  assert.ok(colombiaIn > crossIn, `configured-geo (${colombiaIn}) > cross-country (${crossIn})`);
  // Configured-geo elections outrank cross-country peers ON AVERAGE (mean rank;
  // robust to a weak-signal Colombia item legitimately sitting below an
  // explicit "Mexico election ballot" cross-country item).
  const meanRank = (groupIds) => {
    const ranks = groupIds.map((id) => ids.indexOf(id)).filter((r) => r >= 0);
    return ranks.reduce((a, b) => a + b, 0) / ranks.length;
  };
  assert.ok(
    meanRank(ELECTION_IDS) < meanRank(CROSS_COUNTRY_ELECTION_IDS),
    `Colombia mean rank ${meanRank(ELECTION_IDS).toFixed(2)} < cross-country ${meanRank(CROSS_COUNTRY_ELECTION_IDS).toFixed(2)}`
  );
});

test("cap-pressure diagnostics: dropped detail aligns with IDs and is noise-dominated", async () => {
  const { log } = await runElectionsColombiaCapPressure();
  const cap = log.clusterCap;
  const droppedIds = cap.clusterDroppedSourceIds;
  assert.ok(droppedIds.length === cap.dedupedCount - 15, "drop count = pool - cap");

  // No election (Colombia or cross-country) is among the dropped IDs.
  const droppedElections = droppedIds.filter(
    (id) => ELECTION_IDS.includes(id) || CROSS_COUNTRY_ELECTION_IDS.includes(id)
  );
  assert.deepEqual(droppedElections, [], "no election item is dropped at the cap");

  // clusterDropped prefix aligns with clusterDroppedSourceIds and carries scoring.
  assert.deepEqual(
    cap.clusterDropped.map((d) => d.sourceId),
    droppedIds.slice(0, cap.clusterDropped.length)
  );
  const first = cap.clusterDropped[0];
  assert.equal(typeof first.preClusterScore, "number");
  assert.ok("electionGeoBoost" in first.components);
  assert.ok(["nonElection", "crossCountryElection", "configuredGeoElection"].includes(first.electionGeoClass));
});
