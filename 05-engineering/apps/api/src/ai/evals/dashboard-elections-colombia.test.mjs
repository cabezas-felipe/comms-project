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
  runElectionsColombiaPipeline,
  runDashboardElectionsColombia,
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
