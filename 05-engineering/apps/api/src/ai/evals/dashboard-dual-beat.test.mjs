// Dashboard Dual-Beat — regression test (node:test).
//
// Wired as `npm run eval:dashboard-dual-beat`. Hermetic: the core stubs
// clustering and runs recall in keyword (lexical) mode, so no provider keys /
// network are needed. Guards that a single onboarding profile spanning two
// beats (Colombia elections + Kenya Ebola) surfaces BOTH as distinct
// meta-stories in one refresh — the recall-widening contract from Slices 1–3.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DUAL_BEAT_PERSONA,
  COLOMBIA_ITEMS,
  KENYA_ITEMS,
  DECOY_ITEM,
  runDashboardDualBeat,
} from "./dashboard-dual-beat-core.mjs";

const COLOMBIA_IDS = COLOMBIA_ITEMS.map((i) => i.sourceId);
const KENYA_IDS = KENYA_ITEMS.map((i) => i.sourceId);

function storyForBeat(stories, beatIds) {
  return stories.find((s) =>
    (s.sources ?? []).some((src) => beatIds.includes(src.id))
  );
}

test("dual-beat persona spans Colombia + Kenya with elections/Ebola vocabulary", () => {
  assert.ok(DUAL_BEAT_PERSONA.geographies.includes("Colombia"), "Colombia configured");
  assert.ok(DUAL_BEAT_PERSONA.geographies.includes("Kenya"), "Kenya configured");
  assert.ok(DUAL_BEAT_PERSONA.keywords.includes("election"), "elections keyword present");
  assert.ok(DUAL_BEAT_PERSONA.keywords.includes("Ebola"), "Ebola keyword present");
});

test("single refresh yields TWO distinct beats — Colombia elections AND Kenya Ebola", async () => {
  const { payload } = await runDashboardDualBeat();
  const stories = payload?.stories ?? [];

  // 1) At least two stories shipped.
  assert.ok(stories.length >= 2, `expected >= 2 stories, got ${stories.length}`);

  // 2) One story maps to the Colombia-election beat, one to the Kenya-Ebola beat.
  const colombiaStory = storyForBeat(stories, COLOMBIA_IDS);
  const kenyaStory = storyForBeat(stories, KENYA_IDS);
  assert.ok(colombiaStory, "a story must carry Colombia-election source items");
  assert.ok(kenyaStory, "a story must carry Kenya-Ebola source items");

  // 3) They are DISTINCT meta-stories (not merged into one).
  assert.notEqual(
    colombiaStory.metaStoryId,
    kenyaStory.metaStoryId,
    "Colombia and Kenya beats must be distinct meta-stories, not merged"
  );

  // 4) Source sets are disjoint and each beat's sources stayed within that beat
  //    (no cross-contamination → genuinely separate stories).
  const colombiaSrcIds = colombiaStory.sources.map((s) => s.id).sort();
  const kenyaSrcIds = kenyaStory.sources.map((s) => s.id).sort();
  assert.deepEqual(colombiaSrcIds, [...COLOMBIA_IDS].sort(), "Colombia story owns exactly the Colombia items");
  assert.deepEqual(kenyaSrcIds, [...KENYA_IDS].sort(), "Kenya story owns exactly the Kenya items");

  // 5) Titles read as the two intended beats.
  assert.match(colombiaStory.title, /colombia/i);
  assert.match(kenyaStory.title, /kenya/i);

  // 6) The off-beat decoy never surfaced in either story.
  const allShippedIds = stories.flatMap((s) => s.sources.map((src) => src.id));
  assert.ok(
    !allShippedIds.includes(DECOY_ITEM.sourceId),
    "off-beat decoy must be filtered out of the dashboard"
  );
});

test("recall diagnostics are present and credit the geo lexical gate", async () => {
  const { log } = await runDashboardDualBeat();

  // Recall stage diagnostics exist and are sensible.
  assert.ok(log?.recall, "log.recall present");
  const b = log.recall.topicKeywordBreakdown;
  assert.ok(b, "recall.topicKeywordBreakdown present");
  assert.equal(b.hasGeographies, true, "geographies configured → geo gate active");

  // The four beat items all passed the lexical recall gate; the decoy did not.
  assert.equal(b.passCount, 4, `expected 4 items to pass recall, got ${b.passCount}`);
  assert.ok(b.neither >= 1, "the off-beat decoy is counted as a recall miss (neither)");

  // The two geo-only items (one per beat) were admitted purely via the Slice 2
  // geo lexical gate — this is the recall-widening signal the harness protects.
  assert.ok(
    b.geoLexicalOnly >= 2,
    `expected >= 2 geo-only lexical admissions, got ${b.geoLexicalOnly}`
  );

  // Clustering succeeded for real (no fail-closed fallback).
  assert.notEqual(log?.usedFallbackClustering, true, "clustering must not fall closed");
});
