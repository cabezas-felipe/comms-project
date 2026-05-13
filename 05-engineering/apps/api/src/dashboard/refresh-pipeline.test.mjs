import { test } from "node:test";
import assert from "node:assert/strict";

// Tests in this file predate the embedding-recall stage and don't inject
// embedFn.  Under the strict fail-closed contract for `hybrid_strict`, every
// such call would return an empty candidate set — making every assertion
// about story counts/cluster output a false negative.  Set the file-scoped
// default to `keyword` mode so legacy tests exercise the legacy recall path;
// tests that target the embedding stage opt back into `hybrid_strict` by
// passing `recallConfig: HYBRID_RECALL_CONFIG` explicitly.
//
// Safe to set at module top: `node --test` runs each test file in a child
// process, so this env mutation does not leak across files.
process.env.TEMPO_RECALL_MODE = "keyword";

import {
  selectSourcePool,
  apply24hFilter,
  applyRelevanceFilter,
  applyTopicKeywordFilter,
  runRefreshPipeline,
  primaryDropStage,
  formatFunnel,
  summarizeFunnel,
  constrainTagsToSettings,
  deriveStoryTags,
} from "./refresh-pipeline.mjs";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    clusterId: "cluster-1",
    title: "Test cluster",
    topic: "Diplomatic relations",
    geographies: ["US", "Colombia"],
    priority: "standard",
    takeaway: "Test takeaway",
    summary: "Test summary",
    whyItMatters: "Test why",
    whatChanged: "Test what changed",
    sourceId: "src-1",
    outlet: "Reuters",
    byline: "Test Author",
    kind: "traditional",
    weight: 75,
    url: "https://example.com",
    minutesAgo: 30,
    headline: "Test Headline",
    body: ["Test body."],
    ...overrides,
  };
}

const BASE_SETTINGS = {
  contractVersion: "2026-04-22-slice1",
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["OFAC", "sanctions"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["Reuters", "El Tiempo"],
  socialSources: [],
};

// ─── selectSourcePool ─────────────────────────────────────────────────────────

test("selectSourcePool: keeps items matching configured traditionalSources (case-insensitive)", () => {
  const items = [
    makeItem({ sourceId: "a", outlet: "Reuters" }),
    makeItem({ sourceId: "b", outlet: "BBC" }),
    makeItem({ sourceId: "c", outlet: "reuters" }),
  ];
  const result = selectSourcePool(items, BASE_SETTINGS);
  assert.deepEqual(
    result.map((i) => i.sourceId),
    ["a", "c"]
  );
});

test("selectSourcePool: includes items matching socialSources", () => {
  const settings = { ...BASE_SETTINGS, traditionalSources: [], socialSources: ["@latamwatcher"] };
  const items = [
    makeItem({ sourceId: "a", outlet: "@latamwatcher" }),
    makeItem({ sourceId: "b", outlet: "Reuters" }),
  ];
  const result = selectSourcePool(items, settings);
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, "a");
});

test("selectSourcePool: returns all items when both source lists are empty", () => {
  const settings = { ...BASE_SETTINGS, traditionalSources: [], socialSources: [] };
  const items = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  const result = selectSourcePool(items, settings);
  assert.equal(result.length, 2);
});

// ─── apply24hFilter ───────────────────────────────────────────────────────────

test("apply24hFilter: keeps items with minutesAgo <= 1440", () => {
  const items = [
    makeItem({ sourceId: "a", minutesAgo: 0 }),
    makeItem({ sourceId: "b", minutesAgo: 720 }),
    makeItem({ sourceId: "c", minutesAgo: 1440 }),
    makeItem({ sourceId: "d", minutesAgo: 1441 }),
  ];
  const result = apply24hFilter(items);
  assert.deepEqual(
    result.map((i) => i.sourceId),
    ["a", "b", "c"]
  );
});

test("apply24hFilter: returns empty array when all items are older than 24h", () => {
  const items = [makeItem({ minutesAgo: 2000 })];
  assert.equal(apply24hFilter(items).length, 0);
});

// ─── applyRelevanceFilter ─────────────────────────────────────────────────────

test("applyRelevanceFilter: keeps items matching topic", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Diplomatic relations" }),
    makeItem({ sourceId: "b", topic: "Economic policy" }),
  ];
  const result = applyRelevanceFilter(items, { ...BASE_SETTINGS, geographies: [], keywords: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, "a");
});

test("applyRelevanceFilter: keeps items matching geography", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Unknown topic", geographies: ["Colombia"] }),
    makeItem({ sourceId: "b", topic: "Unknown topic", geographies: ["France"] }),
  ];
  const result = applyRelevanceFilter(items, { ...BASE_SETTINGS, topics: [], keywords: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, "a");
});

test("applyRelevanceFilter: keeps items matching keyword in headline", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Unknown", geographies: ["France"], headline: "Treasury weighs OFAC expansion" }),
    makeItem({ sourceId: "b", topic: "Unknown", geographies: ["France"], headline: "Local news today" }),
  ];
  const result = applyRelevanceFilter(items, { ...BASE_SETTINGS, topics: [], geographies: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, "a");
});

test("applyRelevanceFilter: OR logic — item matching any filter is included", () => {
  const items = [
    // matches topic only
    makeItem({ sourceId: "a", topic: "Diplomatic relations", geographies: ["France"], headline: "No keywords here" }),
    // matches geography only
    makeItem({ sourceId: "b", topic: "Other", geographies: ["US"], headline: "No keywords here" }),
    // matches nothing
    makeItem({ sourceId: "c", topic: "Other", geographies: ["France"], headline: "No keywords here" }),
  ];
  const result = applyRelevanceFilter(items, { ...BASE_SETTINGS, keywords: [] });
  assert.deepEqual(result.map((i) => i.sourceId), ["a", "b"]);
});

test("applyRelevanceFilter: passes all items when all filters are empty", () => {
  const settings = { ...BASE_SETTINGS, topics: [], keywords: [], geographies: [] };
  const items = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  assert.equal(applyRelevanceFilter(items, settings).length, 2);
});

// ─── applyTopicKeywordFilter ──────────────────────────────────────────────────

test("applyTopicKeywordFilter: keeps items matching topic", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Diplomatic relations" }),
    makeItem({ sourceId: "b", topic: "Economic policy" }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, keywords: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, "a");
});

test("applyTopicKeywordFilter: keeps items matching keyword in headline", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Unknown", headline: "Treasury weighs OFAC expansion" }),
    makeItem({ sourceId: "b", topic: "Unknown", headline: "Local news today" }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, "a");
});

test("applyTopicKeywordFilter: passes all items when both topics and keywords are empty", () => {
  const settings = { ...BASE_SETTINGS, topics: [], keywords: [] };
  const items = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  assert.equal(applyTopicKeywordFilter(items, settings).length, 2);
});

test("applyTopicKeywordFilter: does NOT filter by geography (geo handled by applyGeoFilter)", () => {
  const items = [
    // has no matching topic or keyword, only a matching geography
    makeItem({ sourceId: "a", topic: "Unknown", geographies: ["US"], headline: "No keywords here" }),
  ];
  // With only geo configured (no topics/keywords), applyTopicKeywordFilter passes all
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: [] });
  assert.equal(result.length, 1, "no topics/keywords → all pass regardless of geo");
});

// ─── Source selection vs. relevance filtering separation ─────────────────────

test("source pool and relevance filters are independent — source-filtered items can still fail relevance", () => {
  const items = [
    // In pool (Reuters), passes relevance (Diplomatic relations)
    makeItem({ sourceId: "in-pool-relevant", outlet: "Reuters", topic: "Diplomatic relations" }),
    // In pool (Reuters), fails relevance (wrong topic and geo and no keyword)
    makeItem({ sourceId: "in-pool-irrelevant", outlet: "Reuters", topic: "Cooking", geographies: ["France"], headline: "Food news" }),
    // Not in pool (BBC), would pass relevance
    makeItem({ sourceId: "not-in-pool", outlet: "BBC", topic: "Diplomatic relations" }),
  ];
  const settings = { ...BASE_SETTINGS, keywords: [] };
  const pool = selectSourcePool(items, settings);
  assert.deepEqual(pool.map((i) => i.sourceId), ["in-pool-relevant", "in-pool-irrelevant"]);
  const relevant = applyRelevanceFilter(pool, settings);
  assert.deepEqual(relevant.map((i) => i.sourceId), ["in-pool-relevant"]);
});

// ─── runRefreshPipeline ───────────────────────────────────────────────────────

const MOCK_META_STORIES = [
  {
    meta_story_id: "diplomatic-relations-developments",
    title: "Diplomatic Relations Developments",
    subtitle: "Recent diplomatic updates.",
    source_item_ids: ["src-1"],
    summary: "Diplomatic relations updates tracked.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US", "Colombia"] },
  },
];

test("runRefreshPipeline: returns payload with stories from cluster output", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [rawItems[0]],
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.contractVersion, "2026-04-22-slice1");
  assert.equal(payload.stories.length, 1);
  assert.equal(payload.stories[0].id, "diplomatic-relations-developments");
  assert.equal(log.metaStoryCount, 1);
  assert.equal(log.usedFallbackClustering, false);
});

test("runRefreshPipeline: returns empty stories when relevant pool is empty", async () => {
  const rawItems = [makeItem({ sourceId: "src-out", outlet: "BBC", topic: "Cooking", geographies: ["France"], headline: "Food" })];
  let clusterCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => { clusterCalled = true; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(clusterCalled, false, "cluster should not be called when pool is empty");
});

test("runRefreshPipeline: uses graceful fallback when cluster throws", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => { throw new Error("model unavailable"); },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(log.usedFallbackClustering, true);
  assert.ok(payload.stories.length > 0, "fallback must produce at least one story");
});

test("runRefreshPipeline: applies 24h filter before clustering", async () => {
  const rawItems = [
    makeItem({ sourceId: "recent", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "old", outlet: "Reuters", minutesAgo: 2000 }),
  ];
  const seenIds = [];
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.ok(seenIds.includes("recent"), "recent item must reach cluster");
  assert.ok(!seenIds.includes("old"), "item older than 24h must not reach cluster");
});

// ─── Faithfulness gate ────────────────────────────────────────────────────────

test("runRefreshPipeline: rejects meta-story with fully hallucinated source IDs (no_valid_source_ids)", async () => {
  const rawItems = [makeItem({ sourceId: "real-id", outlet: "Reuters", minutesAgo: 30 })];
  const hallucinatedStory = {
    meta_story_id: "hallucinated",
    title: "Hallucinated Story",
    subtitle: "Does not exist.",
    source_item_ids: ["fake-id-1", "fake-id-2"],
    summary: "Fabricated content.",
    tags: { topics: [], keywords: [], geographies: [] },
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [hallucinatedStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0, "story with all hallucinated IDs must be discarded");
  assert.equal(log.groundingFailures, 1);
});

test("runRefreshPipeline: Phase 3 strict drop — partial_source_ids stories are dropped (no extractive fallback)", async () => {
  const rawItems = [makeItem({ sourceId: "real-id", outlet: "Reuters", minutesAgo: 30, headline: "Real headline" })];
  const partialStory = {
    meta_story_id: "partial",
    title: "Partial Story",
    subtitle: "Some real, some fake.",
    source_item_ids: ["real-id", "fake-id"],
    summary: "Summary referencing hallucinated source.",
    tags: { topics: [], keywords: [], geographies: [] },
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [partialStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0, "partial_source_ids must be dropped under strict grounding");
  assert.equal(log.groundingFailures, 1);
  assert.equal(log.droppedUngroundedStoryCount, 1);
  assert.equal(log.groundingDropReasons.partial_source_ids, 1);
});

// ─── Snapshot continuity ──────────────────────────────────────────────────────

// ─── Geo filter integration ───────────────────────────────────────────────────

test("runRefreshPipeline: geo held items are not included in stories", async () => {
  const heldItems = [];
  // Item with no geo (implicit_geo). Mock assessor returns 0.5 < 0.80 threshold → held.
  const rawItems = [makeItem({ sourceId: "src-implicit", outlet: "Reuters", minutesAgo: 30, geographies: [] })];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => {
      // Should not be called since item is held
      heldItems.push(...items);
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    geoAssessFn: async () => ({ confidence: 0.5 }),
    writeHeldFn: async (items) => { heldItems.push(...items); },
  });
  assert.equal(payload.stories.length, 0, "held items must not appear in stories");
  assert.equal(log.geoHeldCount, 1);
});

test("runRefreshPipeline: explicit_match items always included regardless of geoAssessFn", async () => {
  const seenIds = [];
  const rawItems = [
    makeItem({ sourceId: "src-match", outlet: "Reuters", minutesAgo: 30, geographies: ["US"] }),
  ];
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    geoAssessFn: async () => ({ confidence: 0.0 }),
  });
  assert.ok(seenIds.includes("src-match"), "explicit_match must reach cluster even when assessor returns 0");
});

test("runRefreshPipeline: all items included when configured geographies is empty (topic+keyword-only mode)", async () => {
  const seenIds = [];
  const settings = { ...BASE_SETTINGS, geographies: [] };
  const rawItems = [
    makeItem({ sourceId: "src-any", outlet: "Reuters", minutesAgo: 30, geographies: ["France"] }),
  ];
  await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    beatFitEnabled: false, // this test targets geo filter only; bypass relevance gate
  });
  assert.ok(seenIds.includes("src-any"), "no configured geos → all items pass geo filter");
});

// ─── Fabricated geography guard ───────────────────────────────────────────────

test("runRefreshPipeline: story geographies are never fabricated — empty when sources have none", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30, geographies: [] })];
  const metaStory = {
    meta_story_id: "no-geo-story",
    title: "No Geo Story",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "A story without geographies.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: [] },
  };
  const { payload } = await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, geographies: [] },
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    beatFitEnabled: false, // narrow test on geo-fabrication guard; bypass relevance gate
  });
  assert.equal(payload.stories.length, 1);
  assert.deepEqual(payload.stories[0].geographies, [], "geographies must be empty, not fabricated");
});

test("runRefreshPipeline: meta_story_id is stable across equal titles (hardcoded ID passthrough)", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const story1 = {
    meta_story_id: "diplomatic-relations-developments",
    title: "Diplomatic Relations Developments",
    subtitle: "Subtitle A",
    source_item_ids: ["src-1"],
    summary: "Summary A",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
  };
  const story2 = { ...story1, subtitle: "Subtitle B", summary: "Summary B" };

  const { payload: p1 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [story1],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const { payload: p2 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [story2],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });

  assert.equal(p1.stories[0].metaStoryId, p2.stories[0].metaStoryId, "metaStoryId must be stable for same title");
});

// ─── Issue 1: evidence-based ID stability ─────────────────────────────────────

test("runRefreshPipeline: meta_story_id derived from evidence — stable when title changes, same sources", async () => {
  const rawItems = [makeItem({ sourceId: "src-ev1", outlet: "Reuters", minutesAgo: 30 })];

  const makeResult = (title) => [{
    // No meta_story_id — let the pipeline derive it from evidence
    title,
    subtitle: `Subtitle for ${title}`,
    source_item_ids: ["src-ev1"],
    summary: "Summary.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US", "Colombia"] },
    factual_claims: ["Reuters reports: Test Headline"],
    claim_evidence_map: { "0": ["src-ev1"] },
  }];

  const { payload: p1 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => makeResult("Original Title"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });

  const { payload: p2 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => makeResult("Completely Different Title"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });

  assert.ok(typeof p1.stories[0].metaStoryId === "string" && p1.stories[0].metaStoryId.length > 0);
  assert.equal(
    p1.stories[0].metaStoryId,
    p2.stories[0].metaStoryId,
    "metaStoryId must be the same when same evidence, even if title changed"
  );
});

test("runRefreshPipeline: different evidence clusters produce different meta_story_ids", async () => {
  const rawItems = [
    makeItem({ sourceId: "src-A", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-B", outlet: "El Tiempo", minutesAgo: 30 }),
  ];

  const { payload: p1 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Story X",
      subtitle: "Sub.",
      source_item_ids: ["src-A"],
      summary: "Summary X.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Claim X."],
      claim_evidence_map: { "0": ["src-A"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });

  const { payload: p2 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Story X",  // same title, different sources
      subtitle: "Sub.",
      source_item_ids: ["src-B"],
      summary: "Summary X.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Claim X."],
      claim_evidence_map: { "0": ["src-B"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });

  assert.notEqual(
    p1.stories[0].metaStoryId,
    p2.stories[0].metaStoryId,
    "different evidence must produce different metaStoryIds"
  );
});

// ─── Issue 3: hold bucket lifecycle ──────────────────────────────────────────

test("runRefreshPipeline: previously held item is promoted when confidence rises above threshold", async () => {
  // Item was held at implicit_geo (geos=[]) with low confidence.
  // This refresh the assessor returns 0.90 ≥ 0.80 → item gets promoted.
  const heldItem = makeItem({ sourceId: "was-held", outlet: "Reuters", minutesAgo: 30, geographies: [] });
  const rawItems = [makeItem({ sourceId: "current", outlet: "Reuters", minutesAgo: 30 })];

  const promoted = [];
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { promoted.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readHeldFn: async () => [{ ...heldItem, geoCategory: "implicit_geo", geoConfidence: 0.5 }],
    geoAssessFn: async () => ({ confidence: 0.90 }),
    writeHeldFn: async () => {},
    beatFitEnabled: false, // hold-bucket promotion test; bypass relevance gate
  });

  assert.ok(promoted.includes("was-held"), "previously held item must reach cluster when confidence rises");
});

test("runRefreshPipeline: previously held item remains held when confidence stays low", async () => {
  const heldItem = makeItem({ sourceId: "still-held", outlet: "Reuters", minutesAgo: 30, geographies: [] });
  const rawItems = [makeItem({ sourceId: "current", outlet: "Reuters", minutesAgo: 30 })];

  const seenIds = [];
  let writtenHeld = null;
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readHeldFn: async () => [{ ...heldItem, geoCategory: "implicit_geo", geoConfidence: 0.3 }],
    geoAssessFn: async () => ({ confidence: 0.3 }),
    writeHeldFn: async (items) => { writtenHeld = items; },
  });

  assert.ok(!seenIds.includes("still-held"), "low-confidence item must not reach cluster");
  assert.ok(writtenHeld !== null && writtenHeld.some((i) => i.sourceId === "still-held"),
    "item must be written back to hold bucket");
});

// ─── Finding 1: lineage continuity via prior-snapshot keyed merge ────────────

test("runRefreshPipeline: metaStoryId reused from prior when source set evolves (+1 source)", async () => {
  const rawItems = [
    makeItem({ sourceId: "src-A", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-B", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-C", outlet: "Reuters", minutesAgo: 30 }),
  ];

  // Prior snapshot has the same narrative built from [A, B] only
  const priorSnapshot = {
    contractVersion: "2026-04-22-slice1",
    stories: [{
      id: "lineage-id-1",
      metaStoryId: "lineage-id-1",
      topic: "Diplomatic relations",
      title: "Original Locked Title",
      sources: [{ id: "src-A" }, { id: "src-B" }],
    }],
  };

  // New cluster adds src-C — Jaccard = 2/3 ≈ 0.67 ≥ 0.5 → match
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Different LLM Title",
      subtitle: "Sub.",
      source_item_ids: ["src-A", "src-B", "src-C"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US", "Colombia"] },
      factual_claims: ["Reuters reports."],
      claim_evidence_map: { "0": ["src-A"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readPriorSnapshotFn: async () => priorSnapshot,
  });

  assert.equal(
    payload.stories[0].metaStoryId,
    "lineage-id-1",
    "metaStoryId must be inherited from prior snapshot when narrative evolves"
  );
});

test("runRefreshPipeline: metaStoryId reused from prior when a source ages out (-1 source)", async () => {
  const rawItems = [makeItem({ sourceId: "src-A", outlet: "Reuters", minutesAgo: 30 })];
  // Prior had [A, B]; new cluster has [A] only — Jaccard = 1/2 = 0.5 → match
  const priorSnapshot = {
    contractVersion: "2026-04-22-slice1",
    stories: [{
      id: "lineage-id-2",
      metaStoryId: "lineage-id-2",
      topic: "Diplomatic relations",
      title: "Locked Title",
      sources: [{ id: "src-A" }, { id: "src-B" }],
    }],
  };

  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Different Title",
      subtitle: "Sub.",
      source_item_ids: ["src-A"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Claim."],
      claim_evidence_map: { "0": ["src-A"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readPriorSnapshotFn: async () => priorSnapshot,
  });

  assert.equal(payload.stories[0].metaStoryId, "lineage-id-2");
});

test("runRefreshPipeline: distinct narratives with overlapping sources get DIFFERENT metaStoryIds", async () => {
  const rawItems = [
    makeItem({ sourceId: "src-A", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-B", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-C", outlet: "Reuters", minutesAgo: 30 }),
  ];

  // Prior story: Diplomatic with [A, B, C]
  const priorSnapshot = {
    contractVersion: "2026-04-22-slice1",
    stories: [{
      id: "diplomatic-id",
      metaStoryId: "diplomatic-id",
      topic: "Diplomatic relations",
      title: "Diplomatic Story",
      sources: [{ id: "src-A" }, { id: "src-B" }, { id: "src-C" }],
    }],
  };

  // New cluster has same sources but different topic — Jaccard would be 1.0
  // but topic mismatch ⇒ different narrative ⇒ no merge
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Migration Story",
      subtitle: "Sub.",
      source_item_ids: ["src-A", "src-B", "src-C"],
      summary: "Summary.",
      tags: { topics: ["Migration policy"], keywords: [], geographies: ["US"] },
      factual_claims: ["Claim."],
      claim_evidence_map: { "0": ["src-A"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readPriorSnapshotFn: async () => priorSnapshot,
  });

  assert.notEqual(
    payload.stories[0].metaStoryId,
    "diplomatic-id",
    "different topic must NOT collapse onto prior metaStoryId"
  );
});

test("runRefreshPipeline: low-overlap source sets get fresh metaStoryId (no false merge)", async () => {
  const rawItems = [
    makeItem({ sourceId: "src-X", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-Y", outlet: "Reuters", minutesAgo: 30 }),
  ];
  // Prior had [A, B, C]; new has [X, Y] — Jaccard = 0/5 = 0 → no match
  const priorSnapshot = {
    contractVersion: "2026-04-22-slice1",
    stories: [{
      id: "old-id",
      metaStoryId: "old-id",
      topic: "Diplomatic relations",
      title: "Old Story",
      sources: [{ id: "src-A" }, { id: "src-B" }, { id: "src-C" }],
    }],
  };

  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "New Story",
      subtitle: "Sub.",
      source_item_ids: ["src-X", "src-Y"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Claim."],
      claim_evidence_map: { "0": ["src-X"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readPriorSnapshotFn: async () => priorSnapshot,
  });

  assert.notEqual(payload.stories[0].metaStoryId, "old-id");
});

test("runRefreshPipeline: reused metaStoryId from prior snapshot enables title-lock continuity", async () => {
  // This test simulates the publish path: prior snapshot has a metaStoryId
  // with locked title; a new refresh produces a different LLM title but the
  // pipeline must reuse the metaStoryId so the lock can still attach.
  const rawItems = [
    makeItem({ sourceId: "src-A", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-B", outlet: "Reuters", minutesAgo: 30 }),
  ];
  const priorSnapshot = {
    contractVersion: "2026-04-22-slice1",
    stories: [{
      id: "stable-lineage",
      metaStoryId: "stable-lineage",
      topic: "Diplomatic relations",
      title: "Original Title",
      sources: [{ id: "src-A" }, { id: "src-B" }],
    }],
  };

  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Wildly Different LLM Title",
      subtitle: "Sub.",
      source_item_ids: ["src-A", "src-B"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Claim."],
      claim_evidence_map: { "0": ["src-A"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readPriorSnapshotFn: async () => priorSnapshot,
  });

  // metaStoryId persists, even though the LLM produced a different title —
  // a title lock keyed on "stable-lineage" would still attach in the route
  // handler when applying _snapshotRepo.getLocks(userId, [metaStoryIds]).
  assert.equal(payload.stories[0].metaStoryId, "stable-lineage");
});

// ─── Finding 2 (re-asserted under Phase 3 strict grounding) ──────────────────
// Under Phase 3, partial_source_ids stories are dropped entirely — there is no
// publish path that could leak ungrounded subtitle/summary text.

test("runRefreshPipeline: poison subtitle on partial_source_ids cannot reach output (strict drop)", async () => {
  const rawItems = [
    makeItem({ sourceId: "real-id", outlet: "Reuters", minutesAgo: 30, headline: "Real grounded headline" }),
  ];
  const partialStory = {
    title: "Partial Story",
    subtitle: "POISON: ungrounded assertion that the model invented out of thin air.",
    source_item_ids: ["real-id", "fake-id"],
    summary: "Model-written summary referencing a hallucinated source.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
  };

  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [partialStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });

  assert.equal(payload.stories.length, 0, "strict grounding drops the story entirely");
  assert.equal(log.groundingFailures, 1);
  assert.equal(log.droppedUngroundedStoryCount, 1);
  assert.equal(
    log.groundingDropReasons.partial_source_ids,
    1,
    "poison subtitle path must be dropped — never reaches publish"
  );
});

test("runRefreshPipeline: dedup prevents duplicate processing of current-pool + held-bucket items", async () => {
  // Same sourceId in both current pool and hold bucket.
  // Without dedup, item would appear twice in candidateItems → twice in clusterFn input.
  // With dedup, held version is dropped when sourceId is already in current pool.
  const sharedItem = makeItem({ sourceId: "shared", outlet: "Reuters", minutesAgo: 30 });
  const rawItems = [sharedItem];

  const seenIds = [];
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    readHeldFn: async () => [{ ...sharedItem, geoCategory: "explicit_match", geoConfidence: 1.0 }],
    writeHeldFn: async () => {},
  });

  assert.equal(
    seenIds.filter((id) => id === "shared").length,
    1,
    "shared sourceId must appear exactly once in cluster input (dedup prevented duplicate from hold bucket)"
  );
});

// ─── Phase 2: keyword whole-word matching ────────────────────────────────────

test("applyTopicKeywordFilter: keyword matches as whole word, not substring", () => {
  const items = [
    makeItem({ sourceId: "kw-hit", topic: "Other", headline: "Treasury weighs OFAC expansion" }),
    makeItem({ sourceId: "kw-substr", topic: "Other", headline: "ofacility opens new wing" }), // contains 'ofac' substring only
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: ["OFAC"] });
  assert.deepEqual(result.map((i) => i.sourceId), ["kw-hit"]);
});

test("applyTopicKeywordFilter: keyword matching is case-insensitive", () => {
  const items = [
    makeItem({ sourceId: "lower", topic: "Other", headline: "ofac update today" }),
    makeItem({ sourceId: "upper", topic: "Other", headline: "OFAC UPDATE" }),
    makeItem({ sourceId: "mixed", topic: "Other", headline: "Ofac Update" }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: ["OFAC"] });
  assert.equal(result.length, 3);
});

test("applyTopicKeywordFilter: multi-word keyword matches as a contiguous phrase token", () => {
  const items = [
    makeItem({ sourceId: "phrase-hit", topic: "Other", headline: "Border policy debate intensifies" }),
    makeItem({ sourceId: "phrase-miss", topic: "Other", headline: "Border tightening; new policy unveiled" }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: ["border policy"] });
  assert.deepEqual(result.map((i) => i.sourceId), ["phrase-hit"]);
});

test("applyTopicKeywordFilter: topic OR keyword (item passes either)", () => {
  const items = [
    makeItem({ sourceId: "topic-only", topic: "Diplomatic relations", headline: "no keywords" }),
    makeItem({ sourceId: "kw-only", topic: "Other", headline: "OFAC ruling" }),
    makeItem({ sourceId: "neither", topic: "Other", headline: "unrelated" }),
  ];
  const result = applyTopicKeywordFilter(items, {
    ...BASE_SETTINGS,
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
  });
  assert.deepEqual(result.map((i) => i.sourceId).sort(), ["kw-only", "topic-only"]);
});

test("applyTopicKeywordFilter: zero matches returns strict empty (no relevance fallback)", () => {
  const items = [makeItem({ sourceId: "x", topic: "Other", headline: "totally unrelated" })];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: ["Diplomatic relations"], keywords: ["OFAC"] });
  assert.deepEqual(result, []);
});

// ─── Phase 2: time window runs FIRST (before source selection) ───────────────

test("runRefreshPipeline: time window runs before source selection (24h drops stale items pre-matcher)", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [
    makeItem({ sourceId: "fresh", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "stale", outlet: "Reuters", minutesAgo: 2000 }), // > 24h
  ];
  const seenIds = [];
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    manifestFeeds,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.ok(seenIds.includes("fresh"));
  assert.ok(!seenIds.includes("stale"), "items older than 24h must be filtered before source matching");
});

// ─── Phase 2: source selection metadata in pipeline log ──────────────────────

test("runRefreshPipeline: strict mode populates selection metadata when manifestFeeds provided", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { log } = await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["Reuters"], socialSources: [] },
    rawItems,
    manifestFeeds,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(log.selection.sourceSelectionMode, "strict");
  assert.equal(log.selection.sourceFallbackUsed, false);
  assert.equal(log.selection.sourceFallbackReason, null);
  assert.equal(log.selection.matchedSourceCount, 1);
  assert.equal(log.selection.selectedSourceCount, 1);
  assert.deepEqual(log.selection.unmatchedSelectedSources, []);
  assert.equal(log.selection.unavailableConnectorCount, 0);
});

test("runRefreshPipeline: fallback mode kicks in when all selected sources unmatched, returns metadata", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { log } = await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["Made-Up Outlet"], socialSources: [] },
    rawItems,
    manifestFeeds,
    fallbackFeedIds: ["reuters-world"],
    fallbackEnabled: true,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(log.selection.sourceSelectionMode, "fallback");
  assert.equal(log.selection.sourceFallbackUsed, true);
  assert.equal(log.selection.sourceFallbackReason, "all_unmatched");
  assert.deepEqual(log.selection.unmatchedSelectedSources, ["Made-Up Outlet"]);
});

test("runRefreshPipeline: empty matched feeds + fallback disabled → strict empty (no items reach cluster)", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let clusterCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["No-Such-Outlet"], socialSources: [] },
    rawItems,
    manifestFeeds,
    fallbackEnabled: false,
    clusterFn: async () => { clusterCalled = true; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(clusterCalled, false);
  assert.equal(log.selection.sourceFallbackUsed, false);
  assert.equal(log.selection.sourceFallbackReason, "fallback_disabled");
});

test("runRefreshPipeline: relevantItemCount surfaced in selection metadata (zero relevant → strict empty)", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [
    // Item is in pool (Reuters), passes 24h, but topic+keyword don't match.
    makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30, topic: "Other", headline: "unrelated" }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: {
      ...BASE_SETTINGS,
      traditionalSources: ["Reuters"],
      socialSources: [],
      topics: ["Migration policy"],
      keywords: ["sanctions"],
    },
    rawItems,
    manifestFeeds,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(log.selection.relevantItemCount, 0);
  assert.equal(payload.stories.length, 0);
});

// ─── Phase 3: strict grounding drop + rejection persistence + telemetry ──────

test("runRefreshPipeline: ungrounded_claims drops the story (strict trust posture)", async () => {
  const rawItems = [makeItem({ sourceId: "real-id", outlet: "Reuters", minutesAgo: 30, headline: "Real headline" })];
  // Source IDs all valid, but a factual claim points only at hallucinated evidence.
  const story = {
    meta_story_id: "x",
    title: "Has Real Sources But Bad Claim Evidence",
    subtitle: "Sub.",
    source_item_ids: ["real-id"],
    summary: "Summary.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    factual_claims: ["This claim cites no real source."],
    claim_evidence_map: { "0": ["fake-id-only"] },
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [story],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0, "ungrounded_claims must drop story under strict policy");
  assert.equal(log.droppedUngroundedStoryCount, 1);
  assert.equal(log.groundingDropReasons.ungrounded_claims, 1);
});

test("runRefreshPipeline: mixed batch — valid stories survive, failed stories are dropped", async () => {
  const rawItems = [
    makeItem({ sourceId: "good-1", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "good-2", outlet: "Reuters", minutesAgo: 30 }),
  ];
  const stories = [
    {
      meta_story_id: "valid",
      title: "Valid Story",
      subtitle: "Sub.",
      source_item_ids: ["good-1"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Real claim."],
      claim_evidence_map: { "0": ["good-1"] },
    },
    {
      meta_story_id: "halluc",
      title: "Fully Hallucinated",
      subtitle: "Sub.",
      source_item_ids: ["fake-only"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    },
    {
      meta_story_id: "partial",
      title: "Partial Hallucination",
      subtitle: "Sub.",
      source_item_ids: ["good-2", "fake-side"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    },
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => stories,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 1, "only the valid story survives");
  assert.equal(payload.stories[0].metaStoryId, "valid");
  assert.equal(log.droppedUngroundedStoryCount, 2);
  assert.equal(log.groundingDropReasons.no_valid_source_ids, 1);
  assert.equal(log.groundingDropReasons.partial_source_ids, 1);
});

test("runRefreshPipeline: dropped stories are written to rejection log via writeRejectionsFn", async () => {
  const rawItems = [makeItem({ sourceId: "real-id", outlet: "Reuters", minutesAgo: 30 })];
  const stories = [
    {
      meta_story_id: "halluc",
      title: "Fully Hallucinated",
      subtitle: "Sub.",
      source_item_ids: ["fake-only"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    },
    {
      meta_story_id: "partial",
      title: "Partial",
      subtitle: "Sub.",
      source_item_ids: ["real-id", "fake-side"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    },
  ];
  let captured = null;
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => stories,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    writeRejectionsFn: async (recs) => { captured = recs; },
  });
  assert.ok(Array.isArray(captured), "writeRejectionsFn must be called with rejection records");
  assert.equal(captured.length, 2);
  const reasons = captured.map((r) => r.reason_code).sort();
  assert.deepEqual(reasons, ["no_valid_source_ids", "partial_source_ids"]);
  // Each record carries reason + meta_story_id + source_item_ids + debug payload + timestamp
  for (const r of captured) {
    assert.ok(typeof r.reason_code === "string");
    assert.ok(Array.isArray(r.source_item_ids));
    assert.ok(typeof r.created_at === "string");
    assert.ok(r.debug_payload && typeof r.debug_payload === "object");
  }
});

test("runRefreshPipeline: writeRejectionsFn not invoked when there are zero failures", async () => {
  const rawItems = [makeItem({ sourceId: "good", outlet: "Reuters", minutesAgo: 30 })];
  const story = {
    meta_story_id: "ok",
    title: "Valid",
    subtitle: "Sub.",
    source_item_ids: ["good"],
    summary: "Summary.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
  };
  let calls = 0;
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [story],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    writeRejectionsFn: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
});

test("runRefreshPipeline: writeRejectionsFn errors are non-fatal (refresh still succeeds)", async () => {
  const rawItems = [makeItem({ sourceId: "real", outlet: "Reuters", minutesAgo: 30 })];
  const story = {
    meta_story_id: "halluc",
    title: "All hallucinated",
    subtitle: "Sub.",
    source_item_ids: ["fake-only"],
    summary: "Summary.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [story],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    writeRejectionsFn: async () => { throw new Error("DB down"); },
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(log.droppedUngroundedStoryCount, 1, "drop count still tracked even when log write fails");
});

test("runRefreshPipeline: rejection records never appear in payload.stories (no contract leak)", async () => {
  const rawItems = [makeItem({ sourceId: "real", outlet: "Reuters", minutesAgo: 30 })];
  const stories = [
    {
      meta_story_id: "halluc",
      title: "All hallucinated",
      subtitle: "Sub.",
      source_item_ids: ["fake-only"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    },
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => stories,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.deepEqual(payload.stories, [], "no rejected story may leak into stories array");
  assert.ok(Array.isArray(log.rejectionRecords));
  assert.equal(log.rejectionRecords.length, 1);
  // rejection record carries the meta_story_id + reason but is NOT a published story shape
  assert.equal(log.rejectionRecords[0].reason_code, "no_valid_source_ids");
  assert.equal(log.rejectionRecords[0].meta_story_id, "halluc");
});

// ─── Phase 4: watermark + short-circuit + dedup-stamping ─────────────────────

test("runRefreshPipeline: full run emits a watermark in log + candidateCount + selectedFeedCount", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { log } = await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["Reuters"], socialSources: [] },
    rawItems,
    manifestFeeds,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(log.unchanged, false);
  assert.equal(log.refreshSkippedReason, null);
  assert.ok(/^[0-9a-f]{16}$/.test(log.watermark), `expected 16-hex watermark, got ${log.watermark}`);
  assert.equal(log.candidateCount, 1);
  assert.equal(log.selectedFeedCount, 1);
});

test("runRefreshPipeline: priorWatermark match → short-circuit, payload null, no clusterFn invocation", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];

  // First run computes the watermark.
  let clusterCalls = 0;
  const settings = { ...BASE_SETTINGS, traditionalSources: ["Reuters"], socialSources: [] };
  const first = await runRefreshPipeline({
    settings,
    rawItems,
    manifestFeeds,
    clusterFn: async () => { clusterCalls++; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const wm = first.log.watermark;
  assert.equal(clusterCalls, 1);

  // Second run with the SAME inputs + priorWatermark === watermark → short-circuit.
  const second = await runRefreshPipeline({
    settings,
    rawItems,
    manifestFeeds,
    clusterFn: async () => { clusterCalls++; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    priorWatermark: wm,
  });
  assert.equal(second.payload, null, "short-circuit returns payload=null");
  assert.equal(second.log.unchanged, true);
  assert.equal(second.log.refreshSkippedReason, "unchanged_watermark");
  assert.equal(second.log.watermark, wm);
  assert.equal(clusterCalls, 1, "clusterFn must NOT be invoked under short-circuit");
});

test("runRefreshPipeline: priorWatermark mismatch → full run executes (cluster invoked)", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let calls = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["Reuters"], socialSources: [] },
    rawItems,
    manifestFeeds,
    clusterFn: async () => { calls++; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    priorWatermark: "stale-watermark-from-yesterday",
  });
  assert.notEqual(payload, null);
  assert.equal(log.unchanged, false);
  assert.equal(calls, 1);
});

test("runRefreshPipeline: priorWatermark match + writeRejectionsFn → no rejection writes (idempotency)", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];

  // First run: no failures, just to capture the watermark.
  const settings = { ...BASE_SETTINGS, traditionalSources: ["Reuters"], socialSources: [] };
  const first = await runRefreshPipeline({
    settings,
    rawItems,
    manifestFeeds,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const wm = first.log.watermark;

  // Second run under unchanged watermark.  A clusterFn that would have failed
  // grounding is provided — but it must NOT be invoked because we short-circuit
  // before clustering, so writeRejectionsFn must NOT be called either.
  let rejectionWrites = 0;
  await runRefreshPipeline({
    settings,
    rawItems,
    manifestFeeds,
    clusterFn: async () => [{
      meta_story_id: "halluc",
      title: "Bad",
      subtitle: "Sub.",
      source_item_ids: ["fake-only"],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    priorWatermark: wm,
    writeRejectionsFn: async () => { rejectionWrites++; },
  });
  assert.equal(rejectionWrites, 0, "rejection writes must not occur when watermark short-circuits");
});

test("runRefreshPipeline: rejection records carry watermark stamp for dedup", async () => {
  const manifestFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://x", weight: 88, active: true },
  ];
  const rawItems = [makeItem({ sourceId: "real-src", outlet: "Reuters", minutesAgo: 30 })];
  const story = {
    meta_story_id: "halluc",
    title: "Hallucinated",
    subtitle: "Sub.",
    source_item_ids: ["fake-only"],
    summary: "Summary.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
  };
  let captured = null;
  await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["Reuters"], socialSources: [] },
    rawItems,
    manifestFeeds,
    clusterFn: async () => [story],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    writeRejectionsFn: async (recs) => { captured = recs; },
  });
  assert.ok(Array.isArray(captured) && captured.length === 1);
  assert.ok(/^[0-9a-f]{16}$/.test(captured[0].watermark), "rejection record must carry watermark stamp");
});

// ─── Phase 1 relevance Stage 2 integration (beat-fit + strict-empty) ─────────
//
// These tests drive the full pipeline with the locked product pair from spec D1
// and assert that the beat-fit gate + strict-empty policy are honored end to
// end. Settings reflect the real post-extraction shape for our pilot user.

const PHASE1_SETTINGS = {
  contractVersion: "2026-04-22-slice1",
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["migration", "sanctions"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["The Washington Post — World"],
  socialSources: [],
};

test("Phase 1 pairwise: include candidate clears the beat-fit gate", async () => {
  const include = makeItem({
    sourceId: "include",
    outlet: "The Washington Post — World",
    geographies: ["US"],
    topic: "Diplomatic relations",
    headline: "U.S. strikes two Iranian-flagged tankers as tensions continue amid ceasefire",
    body: ["WASHINGTON — The Pentagon confirmed two strikes on tankers in the Gulf of Oman."],
    minutesAgo: 30,
  });
  const { payload, log } = await runRefreshPipeline({
    settings: PHASE1_SETTINGS,
    rawItems: [include],
    clusterFn: async (items) => [
      {
        title: "U.S. action",
        subtitle: "Strikes update",
        source_item_ids: [items[0].sourceId],
        summary: "U.S. strikes two tankers.",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["The Pentagon confirmed two strikes."],
        claim_evidence_map: { "0": [items[0].sourceId] },
      },
    ],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 1, "include candidate must reach a story");
  assert.equal(log.beatFit.includedCount, 1);
  assert.equal(log.beatFit.excludedCount, 0);
});

test("Phase 1 pairwise: exclude candidate is filtered before clustering", async () => {
  const exclude = makeItem({
    sourceId: "exclude",
    outlet: "The Washington Post — World",
    geographies: [],
    topic: "",
    headline: "Iran war is crushing Asia's farmers, threatening global food supply",
    body: ["Wheat and grain prices have surged across Asia, hammering smallholder farmers."],
    minutesAgo: 30,
  });
  let clusterCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: PHASE1_SETTINGS,
    rawItems: [exclude],
    clusterFn: async () => {
      clusterCalled = true;
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0, "off-beat candidate must not become a story");
  // Note: the exclude candidate carries no configured topic/keyword either, so
  // the recall stage (applyTopicKeywordFilter) drops it before beat-fit even
  // sees it. That's the correct, conservative outcome — strict-empty either
  // way. The key contract is `payload.stories.length === 0`.
  assert.equal(clusterCalled, false, "cluster must not run when no candidate clears");
  assert.ok(log.beatFit, "beat-fit log block must be present");
});

test("Phase 1 strict-empty: pairwise mixed run produces only the include story", async () => {
  // Both items reach recall (one via topic+geo, one via keyword) so beat-fit
  // is the gate. The exclude candidate must be dropped at scoring; only the
  // include story should be clustered.
  const include = makeItem({
    sourceId: "include",
    outlet: "The Washington Post — World",
    geographies: ["US"],
    topic: "Diplomatic relations",
    headline: "U.S. strikes two Iranian-flagged tankers as tensions continue amid ceasefire",
    body: ["WASHINGTON — The Pentagon confirmed two strikes on tankers in the Gulf of Oman."],
    minutesAgo: 30,
  });
  const exclude = makeItem({
    sourceId: "exclude",
    outlet: "The Washington Post — World",
    geographies: ["US"],                  // forces past geo filter
    topic: "Migration policy",            // forces past topic+keyword recall
    headline: "Iran war is crushing Asia's farmers, threatening global food supply",
    body: ["Wheat and grain prices have surged across Asia, hammering smallholder farmers."],
    minutesAgo: 30,
  });
  const seenIds = [];
  const { payload, log } = await runRefreshPipeline({
    settings: PHASE1_SETTINGS,
    rawItems: [include, exclude],
    clusterFn: async (items) => {
      seenIds.push(...items.map((i) => i.sourceId));
      return items.map((i) => ({
        title: "Test",
        subtitle: "Sub",
        source_item_ids: [i.sourceId],
        summary: "Summary.",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["A claim."],
        claim_evidence_map: { "0": [i.sourceId] },
      }));
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.deepEqual(seenIds.sort(), ["include"], "only the include candidate should reach clustering");
  assert.equal(payload.stories.length, 1);
  assert.equal(log.beatFit.includedCount, 1);
  assert.equal(log.beatFit.excludedCount, 1);
  assert.ok(
    log.beatFit.excludeReasonHistogram.excluded_offbeat_geo >= 1 ||
      log.beatFit.excludeReasonHistogram.excluded_commodity_framing >= 1,
    "exclude histogram must record either offbeat-geo or commodity-framing"
  );
});

test("Phase 1 strict-empty: when nothing clears beat-fit, payload.stories is []", async () => {
  // Single off-beat item that passes recall but fails beat-fit.
  const offbeat = makeItem({
    sourceId: "x",
    outlet: "The Washington Post — World",
    geographies: ["US"],
    topic: "Diplomatic relations",
    headline: "Asian commodity markets brace for fertilizer crunch",
    body: ["Farmers across Asia face commodity stress; harvest season looms."],
    minutesAgo: 30,
  });
  let clusterCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: PHASE1_SETTINGS,
    rawItems: [offbeat],
    clusterFn: async () => {
      clusterCalled = true;
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0, "strict-empty must NOT fall back to a weak top story");
  assert.equal(clusterCalled, false, "no clustering when zero candidates clear beat-fit");
  assert.equal(log.beatFit.includedCount, 0);
  assert.ok(log.beatFit.excludedCount >= 1);
});

// ─── Funnel diagnostics (strict-empty observability) ─────────────────────────

test("primaryDropStage: identifies the stage with the largest absolute drop", () => {
  const funnel = {
    totalNormalized: 100,
    afterTimeWindow: 80,         // -20 time_window_24h
    afterSourceSelection: 30,    // -50 source_selection  ← biggest drop
    afterGeoFilter: 28,          // -2  geo_filter
    afterTopicKeyword: 5,        // -23 topic_keyword_recall
    afterBeatFit: 5,             // -0  beat_fit_precision
    finalStories: 3,             // -2  clustering_and_grounding
  };
  assert.equal(primaryDropStage(funnel), "source_selection");
});

test("primaryDropStage: returns 'none' when no stage drops items", () => {
  const funnel = {
    totalNormalized: 5,
    afterTimeWindow: 5,
    afterSourceSelection: 5,
    afterGeoFilter: 5,
    afterTopicKeyword: 5,
    afterBeatFit: 5,
    finalStories: 5,
  };
  assert.equal(primaryDropStage(funnel), "none");
});

test("primaryDropStage: tolerates missing fields (treated as 0)", () => {
  // Stages with undefined inputs/outputs must not throw or pick a phantom stage.
  const funnel = { totalNormalized: 10, afterTimeWindow: 8 };
  // 8 → 0 (afterSourceSelection missing) is the largest drop.
  assert.equal(primaryDropStage(funnel), "source_selection");
});

test("formatFunnel: renders stages in pipeline order with ' → ' separators", () => {
  const funnel = {
    totalNormalized: 100,
    afterTimeWindow: 80,
    afterSourceSelection: 30,
    afterGeoFilter: 28,
    afterTopicKeyword: 5,
    afterBeatFit: 5,
    finalStories: 3,
  };
  const s = formatFunnel(funnel);
  assert.match(s, /^normalize=100 → time_window_24h=80 → source_selection=30 → geo_filter=28 → topic_keyword_recall=5 → beat_fit_precision=5 → clustering_and_grounding=3$/);
});

test("summarizeFunnel: flags topicKeywordRecallIsNoop when settings have neither topics nor keywords", () => {
  const funnel = {
    totalNormalized: 10, afterTimeWindow: 10, afterSourceSelection: 10,
    afterGeoFilter: 10, afterTopicKeyword: 10, afterBeatFit: 10, finalStories: 0,
  };
  const summary = summarizeFunnel(funnel, { topics: [], keywords: [] });
  assert.equal(summary.topicKeywordRecallIsNoop, true);
  assert.equal(summary.primaryDropStage, "clustering_and_grounding");
});

test("summarizeFunnel: topicKeywordRecallIsNoop is false when either topics or keywords are configured", () => {
  const funnel = {
    totalNormalized: 5, afterTimeWindow: 5, afterSourceSelection: 5,
    afterGeoFilter: 5, afterTopicKeyword: 5, afterBeatFit: 5, finalStories: 5,
  };
  assert.equal(summarizeFunnel(funnel, { topics: ["X"], keywords: [] }).topicKeywordRecallIsNoop, false);
  assert.equal(summarizeFunnel(funnel, { topics: [], keywords: ["x"] }).topicKeywordRecallIsNoop, false);
});

test("runRefreshPipeline: log.funnel populated on full-run path with all per-stage counts", async () => {
  const include = makeItem({
    sourceId: "in",
    outlet: "Reuters",
    geographies: ["US"],
    topic: "Diplomatic relations",
    headline: "U.S. policy update on bilateral relations",
    body: ["The State Department issued a statement."],
    minutesAgo: 30,
  });
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [include],
    clusterFn: async (items) => [
      {
        title: "Update",
        subtitle: "Sub",
        source_item_ids: [items[0].sourceId],
        summary: "Summary.",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["A claim."],
        claim_evidence_map: { "0": [items[0].sourceId] },
      },
    ],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.ok(log.funnel, "log.funnel must be present on every refresh");
  for (const field of [
    "totalNormalized",
    "afterTimeWindow",
    "afterSourceSelection",
    "afterGeoFilter",
    "afterTopicKeyword",
    "afterBeatFit",
    "finalStories",
    "primaryDropStage",
    "topicKeywordRecallIsNoop",
  ]) {
    assert.ok(field in log.funnel, `log.funnel.${field} must be present`);
  }
  assert.equal(log.funnel.totalNormalized, 1);
  assert.equal(log.funnel.finalStories, 1);
  assert.equal(log.funnel.primaryDropStage, "none");
});

test("runRefreshPipeline: log.funnel.primaryDropStage flags the source_selection cliff in strict-empty runs", async () => {
  // BASE_SETTINGS picks "Reuters"/"El Tiempo" outlets; this BBC item is dropped
  // at the source-selection stage. Result: stories=0 with primary_drop pointing
  // at source_selection.
  const items = [
    makeItem({ sourceId: "x1", outlet: "BBC", topic: "Diplomatic relations", geographies: ["US"], minutesAgo: 30 }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(log.funnel.afterSourceSelection, 0);
  assert.equal(log.funnel.primaryDropStage, "source_selection");
});

test("runRefreshPipeline: log.funnel.primaryDropStage is beat_fit_precision when recall has items but beat-fit drops them", async () => {
  // Item passes recall (topic match on "Diplomatic relations" + keyword
  // match on "sanctions") but beat-fit drops it: no explicit geo overlap
  // and no policy actor in the text, so the off-beat-geo + commodity-framing
  // penalties pull the score below 0.40.
  const items = [
    makeItem({
      sourceId: "x1",
      outlet: "Reuters",
      topic: "Diplomatic relations",
      geographies: [],
      headline: "Asian farmers brace for new commodity sanctions",
      body: ["Wheat and grain commodity markets across Asia ripple."],
      minutesAgo: 30,
    }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(log.funnel.afterTopicKeyword, 1);
  assert.equal(log.funnel.afterBeatFit, 0);
  assert.equal(log.funnel.primaryDropStage, "beat_fit_precision");
});

test("runRefreshPipeline: log.funnel present on watermark-skip branch too", async () => {
  // First run computes a watermark and persists; second run with the same
  // priorWatermark short-circuits and must still surface log.funnel.
  const items = [
    makeItem({
      sourceId: "in",
      outlet: "Reuters",
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "U.S. policy update",
      minutesAgo: 30,
    }),
  ];
  const first = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    beatFitEnabled: false, // keep this test focused on watermark+funnel, not beat-fit
  });
  assert.ok(first.log.watermark);
  const second = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    beatFitEnabled: false,
    priorWatermark: first.log.watermark,
  });
  assert.equal(second.payload, null, "watermark-skip returns payload=null to caller");
  assert.equal(second.log.unchanged, true);
  assert.ok(second.log.funnel, "log.funnel must be populated even on the watermark-skip branch");
  assert.equal(second.log.funnel.totalNormalized, 1);
  // Skip-branch semantics: clustering/grounding never ran. The funnel must
  // honestly say so rather than reporting a fake "0 stories" cliff.
  assert.equal(second.log.funnel.executionMode, "watermark_skip");
  assert.equal(second.log.funnel.finalStories, null, "finalStories must be null (not 0) on skip path");
  assert.equal(
    second.log.funnel.primaryDropStage,
    "not_executed",
    "primaryDropStage must not blame clustering when clustering didn't run"
  );
  // Sanity: the full-run branch (first call) keeps the old contract.
  assert.equal(first.log.funnel.executionMode, "full_run");
  assert.equal(typeof first.log.funnel.finalStories, "number");
  assert.notEqual(first.log.funnel.primaryDropStage, "not_executed");
});

// ─── Funnel skip-mode unit tests (Fix 2) ─────────────────────────────────────

test("summarizeFunnel: executionMode defaults to 'full_run' when not specified (back-compat)", () => {
  const funnel = {
    totalNormalized: 5, afterTimeWindow: 5, afterSourceSelection: 5,
    afterGeoFilter: 5, afterTopicKeyword: 5, afterBeatFit: 5, finalStories: 5,
  };
  const summary = summarizeFunnel(funnel, {});
  assert.equal(summary.executionMode, "full_run");
});

test("summarizeFunnel: executionMode='watermark_skip' forces primaryDropStage='not_executed'", () => {
  // Even if the inputs would otherwise diagnose a cliff, skip mode must
  // override — clustering never ran, so we cannot honestly attribute a drop.
  const funnel = {
    totalNormalized: 100, afterTimeWindow: 80, afterSourceSelection: 30,
    afterGeoFilter: 28, afterTopicKeyword: 5, afterBeatFit: 5, finalStories: null,
  };
  const summary = summarizeFunnel(funnel, {}, { executionMode: "watermark_skip" });
  assert.equal(summary.executionMode, "watermark_skip");
  assert.equal(summary.primaryDropStage, "not_executed");
  assert.equal(summary.finalStories, null);
});

test("primaryDropStage: ignores stages with null counts (treats them as 'not computed', not '0')", () => {
  // The skip path sets finalStories=null. The classifier MUST NOT pick
  // clustering_and_grounding as the largest drop just because null coerces to 0.
  const funnel = {
    totalNormalized: 10, afterTimeWindow: 10, afterSourceSelection: 10,
    afterGeoFilter: 10, afterTopicKeyword: 10, afterBeatFit: 10, finalStories: null,
  };
  assert.equal(primaryDropStage(funnel), "none");
});

test("formatFunnel: renders null stage counts as 'n/a' so skip mode reads correctly", () => {
  const funnel = {
    totalNormalized: 33, afterTimeWindow: 17, afterSourceSelection: 17,
    afterGeoFilter: 17, afterTopicKeyword: 0, afterBeatFit: 0, finalStories: null,
  };
  const s = formatFunnel(funnel);
  assert.match(s, /clustering_and_grounding=n\/a/);
});

// ─── Embedding-aware recall (hybrid_strict) ──────────────────────────────────
//
// These tests pin the contract for the recall stage at the pipeline level:
//   1. Recall widening — a relevant item without an exact keyword still
//      reaches clustering when the embedder ranks it highly enough.
//   2. Fail-closed — embedding error/timeout returns empty stories with an
//      explicit `degraded_reason`, never a keyword-only fallback.
//   3. Mode toggle — `keyword` mode bypasses the embedder entirely; the
//      injected embedFn must never be called.
//   4. Source safety — inactive manifest rows do not surface even when their
//      items would otherwise be the strongest semantic match.
//   5. No fabrication — every published story's sources map back to a real
//      ingested item with sourceId + url.

const HYBRID_RECALL_CONFIG = Object.freeze({
  mode: "hybrid_strict",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

const KEYWORD_RECALL_CONFIG = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

// Stub embedder: returns a 2-d vector encoding (signal-token count, length).
// Items containing "us"/"colombia"/"ofac"/"diplomatic" rank above non-matches.
function stubEmbedFn(throwError = null) {
  const TOKENS = ["us", "colombia", "ofac", "diplomatic", "petro"];
  return async (texts) => {
    if (throwError) throw throwError;
    return texts.map((t) => {
      const lower = String(t).toLowerCase();
      const matches = TOKENS.filter((tok) => lower.includes(tok)).length;
      return [matches, Math.min(lower.length, 1000) / 1000];
    });
  };
}

test("runRefreshPipeline: hybrid_strict widens recall — item without exact keyword still reaches clustering", async () => {
  // Item carries no configured topic and no configured keyword. Under
  // keyword-only recall it would be dropped.  In hybrid_strict the embedder
  // ranks it high (geo signal in headline) and it survives to clustering.
  const semanticOnly = makeItem({
    sourceId: "semantic-only",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Other",
    geographies: ["US"],
    headline: "Petro and U.S. envoy hold call on bilateral coordination",
    body: ["The presidents discussed bilateral coordination."],
  });
  const seenIds = [];
  await runRefreshPipeline({
    settings: {
      ...BASE_SETTINGS,
      // Strip keywords/topics so legacy recall would NOT pick this up.
      keywords: ["sanctions"],
      topics: ["Migration policy"],
    },
    rawItems: [semanticOnly],
    clusterFn: async (items) => {
      seenIds.push(...items.map((i) => i.sourceId));
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    beatFitEnabled: false, // recall-stage test; precision filters bypassed for narrowness
  });
  assert.ok(
    seenIds.includes("semantic-only"),
    "semantic-only candidate must reach clustering under hybrid_strict"
  );
});

test("runRefreshPipeline: hybrid_strict embedding timeout WITH no lexical hits → strict-empty", async () => {
  // No topic/keyword match → lexical fallback has nothing to surface →
  // run is strict-empty.  Pins the original safety invariant for the case
  // where embeddings are the only widening signal.
  const item = makeItem({
    sourceId: "no-lexical-hit",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Other",
    headline: "Local market roundup", // no OFAC, no sanctions
    body: ["Unrelated commentary."],
  });
  let clusterCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => { clusterCalled = true; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(new Error("request timed out after 8000ms")),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 0, "no lexical fallback target → strict-empty");
  assert.equal(clusterCalled, false);
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "embedding_timeout_fail_closed");
  assert.notEqual(log.recall.keywordFallbackAfterEmbeddingFailure, true);
});

test("runRefreshPipeline: hybrid_strict embedding error WITH no lexical hits → strict-empty", async () => {
  const item = makeItem({
    sourceId: "no-hit",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Other",
    headline: "Wholly unrelated",
    body: ["nothing."],
  });
  const { log, payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(new Error("provider 503 service unavailable")),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "embedding_error_fail_closed");
});

test("runRefreshPipeline: hybrid_strict embedding timeout WITH lexical hits → lexical fallback (degraded)", async () => {
  // The dashboard-false-empty regression we are guarding against: an
  // embedding timeout with obvious lexical hits MUST NOT collapse the run
  // to zero.  The lexical-fallback path surfaces the items, flagged as
  // `keywordFallbackAfterEmbeddingFailure: true` so the cliff is visible.
  const item = makeItem({
    sourceId: "kw-match",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Diplomatic relations",
    headline: "Treasury sanctions package widens",
    body: ["Sanctions update."],
    geographies: ["US"],
  });
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async (items) => items.map((i) => ({
      meta_story_id: "ms-1",
      title: "Sanctions",
      subtitle: "Sub",
      source_item_ids: [i.sourceId],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["a claim"],
      claim_evidence_map: { "0": [i.sourceId] },
    })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(new Error("request timed out after 8000ms")),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 1, "lexical fallback surfaces the item; clustering produces a story");
  assert.equal(payload.stories[0].sources[0].id, "kw-match");
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "embedding_timeout_fail_closed");
  assert.equal(log.recall.keywordFallbackAfterEmbeddingFailure, true);
});

test("runRefreshPipeline: keyword mode bypasses embedFn entirely (legacy preserved)", async () => {
  let embedCalls = 0;
  const item = makeItem({
    sourceId: "kw-hit",
    outlet: "Reuters",
    minutesAgo: 30,
    headline: "OFAC update issued today",
  });
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async (items) => items.map((i) => ({
      meta_story_id: "ms-1",
      title: "Test",
      subtitle: "Sub",
      source_item_ids: [i.sourceId],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["A claim."],
      claim_evidence_map: { "0": [i.sourceId] },
    })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: async () => { embedCalls++; return []; },
    recallConfig: KEYWORD_RECALL_CONFIG,
  });
  assert.equal(embedCalls, 0, "embedFn must NOT be invoked under explicit keyword mode");
  assert.equal(payload.stories.length, 1, "legacy keyword recall still produces stories");
  assert.equal(log.recall.mode, "keyword");
});

test("runRefreshPipeline: source safety — inactive manifest feeds never surface even when semantically strongest", async () => {
  const manifestFeeds = [
    { id: "wapo", name: "The Washington Post — World", kind: "rss", url: "https://x", weight: 88, active: true },
    // Inactive feed: even if items from this outlet were in rawItems, source
    // selection drops them BEFORE the embedding stage runs.
    { id: "blacklisted", name: "Blacklisted Outlet", kind: "rss", url: "https://y", weight: 10, active: false },
  ];
  const rawItems = [
    makeItem({
      sourceId: "wapo-item",
      outlet: "The Washington Post — World",
      minutesAgo: 30,
      headline: "U.S. and Colombia coordinate diplomatic call",
    }),
    makeItem({
      sourceId: "blacklisted-item",
      outlet: "Blacklisted Outlet",
      minutesAgo: 30,
      headline: "U.S. Colombia Petro OFAC diplomatic call (semantically strongest)",
    }),
  ];
  const seenIds = [];
  await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["The Washington Post"], socialSources: [] },
    rawItems,
    manifestFeeds,
    clusterFn: async (items) => {
      seenIds.push(...items.map((i) => i.sourceId));
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    beatFitEnabled: false,
  });
  assert.ok(!seenIds.includes("blacklisted-item"), "items from inactive feeds must never reach clustering");
});

test("runRefreshPipeline: no fabrication — every published story source has a real ingested sourceId + url", async () => {
  const realItem = makeItem({
    sourceId: "real-1",
    outlet: "Reuters",
    minutesAgo: 30,
    url: "https://reuters.example/real-1",
    headline: "U.S. and Colombia diplomatic update",
  });
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [realItem],
    clusterFn: async (items) => [{
      meta_story_id: "ms-real",
      title: "Real Story",
      subtitle: "Sub",
      source_item_ids: items.map((i) => i.sourceId),
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["A claim."],
      claim_evidence_map: { "0": items.map((i) => i.sourceId) },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 1);
  for (const story of payload.stories) {
    for (const src of story.sources) {
      assert.ok(src.id && typeof src.id === "string", "every source must carry a real id");
      assert.ok(src.url && typeof src.url === "string", "every source must carry a real url");
      // The id must equal an ingested raw item's sourceId — no fabricated entries.
      assert.equal(src.id, "real-1");
    }
  }
});

test("runRefreshPipeline: log.recall populated on full-run path with mode + counts + degraded flag", async () => {
  const item = makeItem({
    sourceId: "x",
    outlet: "Reuters",
    minutesAgo: 30,
    headline: "OFAC update on US Colombia",
    topic: "Diplomatic relations",
    geographies: ["US"],
  });
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.ok(log.recall, "log.recall must be present on every refresh");
  for (const f of [
    "mode",
    "embeddedCount",
    "similarityKept",
    "keywordRecallCount",
    "unionCount",
    "finalRelevant",
    "degraded",
    "degraded_reason",
  ]) {
    assert.ok(f in log.recall, `log.recall.${f} must be present`);
  }
  assert.equal(log.recall.mode, "hybrid_strict");
  assert.equal(log.recall.degraded, false);
  assert.equal(log.recall.degraded_reason, null);
});

test("runRefreshPipeline: hybrid_strict + missing embedFn WITH lexical hits → lexical fallback (degraded, not strict-empty)", async () => {
  // Updated policy: when lexical recall has items, the absence of an embedFn
  // surfaces them with `keywordFallbackAfterEmbeddingFailure: true` so the
  // dashboard isn't trapped at zero on a degraded run.
  const item = makeItem({
    sourceId: "kw-hit-fallback",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Diplomatic relations",
    headline: "OFAC ruling expands sanctions",
    body: ["A real headline."],
    geographies: ["US"],
  });
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async (items) => items.map((i) => ({
      meta_story_id: "ms-fallback",
      title: "Sanctions",
      subtitle: "Sub",
      source_item_ids: [i.sourceId],
      summary: "Summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["a claim"],
      claim_evidence_map: { "0": [i.sourceId] },
    })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID_RECALL_CONFIG,
    // no embedFn → lexical fallback with degraded flag
  });
  assert.equal(payload.stories.length, 1, "lexical fallback surfaces the item under hybrid_strict");
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "embedding_unavailable_fail_closed");
  assert.equal(log.recall.keywordFallbackAfterEmbeddingFailure, true);
});

test("runRefreshPipeline: hybrid_strict + missing embedFn WITH no lexical hits → strict-empty", async () => {
  const item = makeItem({
    sourceId: "no-hit",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Other",
    headline: "Wholly unrelated",
    body: ["nothing"],
  });
  let clusterCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => { clusterCalled = true; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(clusterCalled, false);
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "embedding_unavailable_fail_closed");
  assert.notEqual(log.recall.keywordFallbackAfterEmbeddingFailure, true);
});

test("runRefreshPipeline: hybrid_strict + empty profile text → strict fail-closed (no keyword pass-through)", async () => {
  // A user with no topics/keywords/geos/sources/narrative produces an empty
  // profile.  Under strict policy this is treated as an operational gap, not
  // a soft fallback.  Empty + diagnostic prevents recommending items the
  // user never expressed a beat for.
  const item = makeItem({
    sourceId: "kw-only",
    outlet: "Reuters",
    minutesAgo: 30,
    headline: "OFAC ruling",
  });
  const settingsNoProfile = {
    contractVersion: "2026-04-22-slice1",
    topics: [],
    keywords: [],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
  };
  let embedCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: settingsNoProfile,
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: async () => { embedCalled = true; return []; },
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(embedCalled, false, "embedFn must not be invoked when profile is empty");
  assert.equal(payload.stories.length, 0);
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "empty_profile_text_fail_closed");
});

// ─── Topic/keyword stage breakdown (false-empty diagnostics) ────────────────

test("analyzeTopicKeywordStage: pins the four mutually-exclusive partition counts", async () => {
  const { analyzeTopicKeywordStage } = await import("./refresh-pipeline.mjs");
  const settings = { topics: ["Diplomatic relations"], keywords: ["sanctions"] };
  const items = [
    { topic: "Diplomatic relations", headline: "no kw here", body: [] },          // topicOnly
    { topic: "Other", headline: "Treasury sanctions update", body: [] },         // keywordOnly
    { topic: "Diplomatic relations", headline: "sanctions", body: [] },           // both
    { topic: "Other", headline: "Local sports", body: [] },                       // neither
  ];
  const b = analyzeTopicKeywordStage(items, settings);
  assert.equal(b.inputCount, 4);
  assert.equal(b.topicOnly, 1);
  assert.equal(b.keywordOnly, 1);
  assert.equal(b.both, 1);
  assert.equal(b.neither, 1);
  assert.equal(b.passCount, 3);
  assert.equal(b.primaryDropCause, null, "at least one item passed");
});

test("analyzeTopicKeywordStage: primaryDropCause distinguishes 'no_topic_match' vs 'no_keyword_match' vs 'no_topic_no_keyword'", async () => {
  const { analyzeTopicKeywordStage } = await import("./refresh-pipeline.mjs");
  const items = [{ topic: "Other", headline: "unrelated", body: [] }];
  // both topics + keywords configured, neither matched
  let b = analyzeTopicKeywordStage(items, { topics: ["X"], keywords: ["y"] });
  assert.equal(b.primaryDropCause, "no_topic_no_keyword");
  // only topics configured, no match
  b = analyzeTopicKeywordStage(items, { topics: ["X"], keywords: [] });
  assert.equal(b.primaryDropCause, "no_topic_match");
  // only keywords configured, no match
  b = analyzeTopicKeywordStage(items, { topics: [], keywords: ["y"] });
  assert.equal(b.primaryDropCause, "no_keyword_match");
});

test("analyzeTopicKeywordStage: passNoConfig accounts for no-op pass-through (settings have neither)", async () => {
  const { analyzeTopicKeywordStage } = await import("./refresh-pipeline.mjs");
  const items = [{ topic: "x", headline: "y", body: [] }];
  const b = analyzeTopicKeywordStage(items, { topics: [], keywords: [] });
  assert.equal(b.passNoConfig, 1);
  assert.equal(b.passCount, 1);
  assert.equal(b.primaryDropCause, null);
});

test("analyzeTopicKeywordStage: empty input → primaryDropCause='no_input' regardless of settings shape", async () => {
  // Pins the fourth partition cause: when zero items reach the topic-keyword
  // stage, the diagnostic must blame upstream stages ("no_input") rather than
  // the topic/keyword gates themselves — operators reading `_meta.recall.
  // topicKeywordBreakdown.primaryDropCause = 'no_input'` know to look at
  // source-selection / time-window / geo-filter, not at their topic enum.
  const { analyzeTopicKeywordStage } = await import("./refresh-pipeline.mjs");

  // With both gates configured.
  let b = analyzeTopicKeywordStage([], { topics: ["X"], keywords: ["y"] });
  assert.equal(b.inputCount, 0);
  assert.equal(b.passCount, 0);
  assert.equal(b.primaryDropCause, "no_input");

  // With only topics configured.
  b = analyzeTopicKeywordStage([], { topics: ["X"], keywords: [] });
  assert.equal(b.primaryDropCause, "no_input");

  // With only keywords configured.
  b = analyzeTopicKeywordStage([], { topics: [], keywords: ["y"] });
  assert.equal(b.primaryDropCause, "no_input");

  // No-config no-op: empty input still reads as no_input rather than masquerading
  // as "everything passed because nothing was checked".
  b = analyzeTopicKeywordStage([], { topics: [], keywords: [] });
  assert.equal(b.primaryDropCause, "no_input");
  assert.equal(b.passNoConfig, 0);
  assert.equal(b.passCount, 0);
});

test("runRefreshPipeline: log.recall.topicKeywordBreakdown surfaces stage diagnostics", async () => {
  // Mixed item set: one keyword-only hit, one topic-only hit, one neither.
  const items = [
    makeItem({ sourceId: "kw", outlet: "Reuters", minutesAgo: 30, topic: "Other", headline: "OFAC update", geographies: ["US"] }),
    makeItem({ sourceId: "topic", outlet: "Reuters", minutesAgo: 30, topic: "Diplomatic relations", headline: "no keyword", geographies: ["US"] }),
    makeItem({ sourceId: "miss", outlet: "Reuters", minutesAgo: 30, topic: "Other", headline: "unrelated", geographies: ["US"] }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: KEYWORD_RECALL_CONFIG,
  });
  const b = log.recall.topicKeywordBreakdown;
  assert.ok(b, "topicKeywordBreakdown must be present on log.recall");
  assert.equal(b.inputCount, 3);
  assert.equal(b.topicOnly, 1);
  assert.equal(b.keywordOnly, 1);
  assert.equal(b.neither, 1);
  assert.equal(b.passCount, 2);
});

// ─── Watermark trap guard ────────────────────────────────────────────────────

test("runRefreshPipeline: priorWatermark match + priorStoryCount=0 + items present → suppress short-circuit", async () => {
  // The trap: a prior degraded run wrote an empty snapshot AND a watermark.
  // On the next refresh with the same lexical input, the watermark matches —
  // but we MUST NOT skip clustering, otherwise we keep serving zero stories
  // forever.  The guard re-runs clustering when priorStoryCount === 0.
  const item = makeItem({
    sourceId: "fresh-cluster",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Diplomatic relations",
    headline: "Treasury sanctions package",
    body: ["sanctions update"],
    geographies: ["US"],
  });
  let clusterCalls = 0;
  // First run captures the watermark.
  const first = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => { clusterCalls++; return []; }, // produces 0 stories deliberately
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: KEYWORD_RECALL_CONFIG,
  });
  assert.equal(clusterCalls, 1);
  assert.equal(first.payload.stories.length, 0);

  // Second run: identical input → identical watermark.  Without the guard
  // this would short-circuit (payload=null).  With priorStoryCount=0 it
  // suppresses the skip and re-runs clustering.
  const second = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async (items) => {
      clusterCalls++;
      return items.map((i) => ({
        meta_story_id: "now-yields",
        title: "Sanctions",
        subtitle: "Sub",
        source_item_ids: [i.sourceId],
        summary: "Summary.",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["a claim"],
        claim_evidence_map: { "0": [i.sourceId] },
      }));
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: KEYWORD_RECALL_CONFIG,
    priorWatermark: first.log.watermark,
    priorStoryCount: 0,
  });
  assert.equal(clusterCalls, 2, "clustering must re-run when prior snapshot was empty");
  assert.notEqual(second.payload, null, "guard must suppress the short-circuit");
  assert.equal(second.payload.stories.length, 1, "fresh clustering attempt produced a story");
});

test("runRefreshPipeline: priorWatermark match + priorStoryCount > 0 → short-circuit preserved (optimization intact)", async () => {
  const item = makeItem({
    sourceId: "stable",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Diplomatic relations",
    headline: "OFAC ruling",
    geographies: ["US"],
  });
  let clusterCalls = 0;
  const first = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async (items) => {
      clusterCalls++;
      return items.map((i) => ({
        meta_story_id: "ms-stable",
        title: "T",
        subtitle: "S",
        source_item_ids: [i.sourceId],
        summary: "Summary.",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["a claim"],
        claim_evidence_map: { "0": [i.sourceId] },
      }));
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: KEYWORD_RECALL_CONFIG,
  });

  const second = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => { clusterCalls++; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: KEYWORD_RECALL_CONFIG,
    priorWatermark: first.log.watermark,
    priorStoryCount: first.payload.stories.length, // > 0
  });
  assert.equal(clusterCalls, 1, "clustering must NOT re-run when prior had stories AND watermark matches");
  assert.equal(second.payload, null, "short-circuit must engage (payload=null, route serves prior snapshot)");
  assert.equal(second.log.unchanged, true);
});

// ─── WaPo Iran/oil regression at the pipeline level ──────────────────────────

test("WaPo Iran/oil regression: pipeline does not collapse to zero when lexical matches present and embedding fails", async () => {
  // Real false-empty observed: the WaPo Iran/oil story matched no canonical
  // topic enum (item.topic empty), so only the keyword regex carried it.
  // Settings here mirror the production fixture in the spec.
  // Settings mirror the production fixture in the spec; outlet uses the full
  // section-level name so the legacy outlet-set source pool (used here without
  // manifestFeeds) matches exactly.  Production resolves "Washington Post" →
  // section feeds via the source-matcher; that path is exercised separately.
  const wapoSettings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Diplomatic relations", "Trade policy", "Energy trade", "Agricultural trade"],
    keywords: ["oil", "petroleum", "agriculture", "sanctions", "trade"],
    geographies: ["US", "Iran"],
    traditionalSources: ["The Washington Post — World"],
    socialSources: [],
  };
  const item = makeItem({
    sourceId: "wapo-iran-oil",
    outlet: "The Washington Post — World",
    minutesAgo: 30,
    topic: "", // RSS items don't carry a Tempo topic
    geographies: [],
    headline: "Gulf nations hoped to move beyond oil. The Iran war made that much harder.",
    body: [
      "Sanctions and military strikes have rerouted petroleum trade across the Gulf, " +
      "with U.S. allies recalibrating their long-term energy posture.",
    ],
    url: "https://www.washingtonpost.com/world/2026/01/01/gulf-iran-oil",
    weight: 88,
  });
  const { payload, log } = await runRefreshPipeline({
    settings: wapoSettings,
    rawItems: [item],
    clusterFn: async (items) => items.map((i) => ({
      meta_story_id: "ms-wapo-iran",
      title: "Gulf reroutes oil trade",
      subtitle: "Iran war complicates diversification.",
      source_item_ids: [i.sourceId],
      summary: "Coverage of Gulf petroleum trade after Iran war.",
      tags: { topics: ["Diplomatic relations"], keywords: ["oil", "sanctions"], geographies: ["US"] },
      factual_claims: ["Sanctions rerouted petroleum trade across the Gulf."],
      claim_evidence_map: { "0": [i.sourceId] },
    })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    embedFn: stubEmbedFn(new Error("embeddings provider 503")),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 1, "embedding failure with obvious lexical hits must NOT collapse to empty");
  assert.equal(payload.stories[0].sources[0].id, "wapo-iran-oil");
  assert.equal(payload.stories[0].sources[0].url, item.url, "no fabricated url — original ingested url preserved");
  // Diagnostics must surface the degraded fallback for ops visibility.
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "embedding_error_fail_closed");
  assert.equal(log.recall.keywordFallbackAfterEmbeddingFailure, true);
  // Topic/keyword breakdown must record this as a keyword-only hit (no
  // canonical topic on the RSS item).
  assert.equal(log.recall.topicKeywordBreakdown.keywordOnly, 1);
  assert.equal(log.recall.topicKeywordBreakdown.passCount, 1);
});

// ─── Regression: live WaPo source-selection (user e06d512d funnel collapse) ──

test("runRefreshPipeline regression: live WaPo items pass source-selection via feedId even when outlet name diverges from manifest canonical name", async () => {
  // Reproduces the funnel collapse observed for user e06d512d:
  //   totalNormalized=5, afterTimeWindow=5, afterSourceSelection=0,
  //   primaryDropStage=source_selection, matchedFeedIds includes the 5
  //   wapo-* feeds.
  //
  // Modeled cause: items emitted by the live feed-reader carry a publisher-
  // canonical outlet ("The Washington Post" or similar) that does not
  // bidirectionally substring-match the matcher's section-level outlet
  // strings ("The Washington Post — Politics", ...) — but every item also
  // carries `feedId` from the manifest row, which exact-matches one of
  // `selection.matchedFeedIds`.  Pre-fix the pipeline only tried outlet
  // matching, so all 5 items got dropped.  Post-fix the feedId index
  // catches them.
  const manifestFeeds = [
    { id: "wapo-politics",   name: "The Washington Post — Politics",   kind: "rss", url: "https://wapo/p", weight: 95, active: true },
    { id: "wapo-world",      name: "The Washington Post — World",      kind: "rss", url: "https://wapo/w", weight: 92, active: true },
    { id: "wapo-national",   name: "The Washington Post — National",   kind: "rss", url: "https://wapo/n", weight: 90, active: true },
    { id: "wapo-business",   name: "The Washington Post — Business",   kind: "rss", url: "https://wapo/b", weight: 88, active: true },
    { id: "wapo-technology", name: "The Washington Post — Technology", kind: "rss", url: "https://wapo/t", weight: 86, active: true },
  ];
  // Five live items — one per WaPo feed.  Outlet uses the publisher-only
  // canonical form (no section suffix) AND a divergent punctuation shape
  // ("WashingtonPost.com") so neither equality nor bidirectional substring
  // against the section-level matched outlet set would catch them.
  const rawItems = manifestFeeds.map((f, i) =>
    makeItem({
      sourceId: `live-wapo-${i}`,
      feedId: f.id,
      outlet: "WashingtonPost.com",
      minutesAgo: 30,
      headline: "U.S. Colombia diplomatic call coordinates response",
    })
  );
  const seenIds = [];
  const { log } = await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["Washington Post"], socialSources: [] },
    rawItems,
    manifestFeeds,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  // Funnel must NOT collapse at source_selection.
  assert.equal(log.funnel.totalNormalized, 5);
  assert.equal(log.funnel.afterTimeWindow, 5);
  assert.equal(log.funnel.afterSourceSelection, 5, "all 5 live WaPo items must survive source-selection via feedId match");
  // Selection metadata still reports the matched WaPo feeds.
  assert.deepEqual(
    log.selection.matchedFeedIds.sort(),
    ["wapo-business", "wapo-national", "wapo-politics", "wapo-technology", "wapo-world"]
  );
  assert.equal(log.selection.sourceSelectionMode, "strict");
  assert.equal(log.selection.sourceFallbackUsed, false);
});

test("runRefreshPipeline regression: strict-empty preserved — items with no matching feedId AND no outlet match still drop", async () => {
  // Counterpart to the regression above: ensure the new feedId index does
  // not silently broaden matching.  Items whose feedId is outside
  // `selection.matchedFeedIds` AND whose outlet does not substring-match
  // any matched outlet must still be filtered out — strict-empty semantics
  // hold and we have not turned source-selection into a no-op.
  const manifestFeeds = [
    { id: "wapo-politics", name: "The Washington Post — Politics", kind: "rss", url: "https://wapo/p", weight: 95, active: true },
  ];
  const rawItems = [
    makeItem({ sourceId: "wapo-real",  feedId: "wapo-politics", outlet: "The Washington Post — Politics", minutesAgo: 30 }),
    makeItem({ sourceId: "bbc-strange", feedId: "bbc-world",     outlet: "BBC",                              minutesAgo: 30 }),
  ];
  const seenIds = [];
  await runRefreshPipeline({
    settings: { ...BASE_SETTINGS, traditionalSources: ["Washington Post"], socialSources: [] },
    rawItems,
    manifestFeeds,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.ok(seenIds.includes("wapo-real"), "matched-id item must reach clustering");
  assert.ok(!seenIds.includes("bbc-strange"), "non-matched-id item with non-matching outlet must NOT survive source-selection");
});

// ─── Settings-only tag governance ────────────────────────────────────────────
//
// Settings is the controlled vocabulary.  Refresh/classification must NOT
// invent new taxonomy values; story.tags axes must each be a subset of the
// matching settings list.  These tests guard the contract from the unit
// helper up through the pipeline so an out-of-settings value like "General"
// cannot leak onto the dashboard.

test("constrainTagsToSettings: drops topics not in settings (e.g. 'General')", () => {
  const tags = {
    topics: ["Diplomatic relations", "General"],
    keywords: [],
    geographies: [],
  };
  const out = constrainTagsToSettings(tags, BASE_SETTINGS);
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
});

test("constrainTagsToSettings: drops keywords not in settings", () => {
  const tags = {
    topics: [],
    keywords: ["OFAC", "tariffs", "sanctions"],
    geographies: [],
  };
  const out = constrainTagsToSettings(tags, BASE_SETTINGS);
  assert.deepEqual(out.keywords.sort(), ["OFAC", "sanctions"]);
});

test("constrainTagsToSettings: drops geographies not in settings", () => {
  const tags = { topics: [], keywords: [], geographies: ["US", "France", "Colombia"] };
  const out = constrainTagsToSettings(tags, BASE_SETTINGS);
  assert.deepEqual(out.geographies.sort(), ["Colombia", "US"]);
});

test("constrainTagsToSettings: empty when no settings axis configured (never fabricates)", () => {
  const tags = {
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
  };
  const out = constrainTagsToSettings(tags, {
    topics: [],
    keywords: [],
    geographies: [],
  });
  assert.deepEqual(out, { topics: [], keywords: [], geographies: [] });
});

test("constrainTagsToSettings: case-insensitive keyword/geography match preserves settings casing", () => {
  const tags = {
    topics: [],
    keywords: ["ofac", "Sanctions"],
    geographies: ["us", "colombia"],
  };
  const out = constrainTagsToSettings(tags, BASE_SETTINGS);
  // Output values come from settings (settings is authoritative for spelling).
  assert.deepEqual(out.keywords.sort(), ["OFAC", "sanctions"]);
  assert.deepEqual(out.geographies.sort(), ["Colombia", "US"]);
});

test("constrainTagsToSettings: topic synonyms resolve to the matching settings entry", () => {
  // BASE_SETTINGS.topics includes "Diplomatic relations"; the model often
  // emits "bilateral relations" which normalizes to "Diplomatic relations".
  // Governance should accept the synonym and emit the settings-cased value.
  const tags = { topics: ["bilateral relations"], keywords: [], geographies: [] };
  const out = constrainTagsToSettings(tags, BASE_SETTINGS);
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
});

test("constrainTagsToSettings: deduplicates repeated model values", () => {
  const tags = {
    topics: ["Diplomatic relations", "Diplomatic relations"],
    keywords: ["OFAC", "ofac"],
    geographies: ["US", "us", "US"],
  };
  const out = constrainTagsToSettings(tags, BASE_SETTINGS);
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
  assert.deepEqual(out.keywords, ["OFAC"]);
  assert.deepEqual(out.geographies, ["US"]);
});

test("constrainTagsToSettings: does not mutate settings or input tags", () => {
  const settings = {
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
  };
  const settingsSnapshot = JSON.parse(JSON.stringify(settings));
  const tags = {
    topics: ["Diplomatic relations", "General"],
    keywords: ["OFAC", "tariffs"],
    geographies: ["US", "France"],
  };
  const tagsSnapshot = JSON.parse(JSON.stringify(tags));
  constrainTagsToSettings(tags, settings);
  assert.deepEqual(settings, settingsSnapshot, "settings must not be mutated");
  assert.deepEqual(tags, tagsSnapshot, "input tags must not be mutated");
});

test("runRefreshPipeline: model-provided 'General' topic is excluded from story tags when absent from settings", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const metaStory = {
    meta_story_id: "general-leak",
    title: "General Story",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Summary.",
    tags: {
      topics: ["General", "Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
    },
    factual_claims: ["Reuters reports: Test Headline"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(
    !payload.stories[0].tags.topics.includes("General"),
    "'General' must be excluded — it is not in settings.topics"
  );
  assert.deepEqual(payload.stories[0].tags.topics, ["Diplomatic relations"]);
});

test("runRefreshPipeline: every story tag axis is a subset of settings", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const metaStory = {
    meta_story_id: "broad-tag-story",
    title: "Story With Broad Tags",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Summary.",
    tags: {
      // Mix of in-settings and out-of-settings values across all axes.
      topics: ["Diplomatic relations", "Energy policy", "General"],
      keywords: ["OFAC", "tariffs", "sanctions", "espionage"],
      geographies: ["US", "France", "Colombia", "Spain"],
    },
    factual_claims: ["Reuters reports: Test Headline"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const tags = payload.stories[0].tags;
  const settingsTopics = new Set(BASE_SETTINGS.topics);
  const settingsKeywords = new Set(BASE_SETTINGS.keywords);
  const settingsGeos = new Set(BASE_SETTINGS.geographies);
  for (const t of tags.topics) {
    assert.ok(settingsTopics.has(t), `topic '${t}' must be in settings.topics`);
  }
  for (const k of tags.keywords) {
    assert.ok(settingsKeywords.has(k), `keyword '${k}' must be in settings.keywords`);
  }
  for (const g of tags.geographies) {
    assert.ok(settingsGeos.has(g), `geography '${g}' must be in settings.geographies`);
  }
});

test("runRefreshPipeline: story.tags.geographies is never fabricated even when source carries non-settings geo", async () => {
  // Source item has "France" geo but France isn't in settings; the model
  // also echoes it into the story tags.  Governance must drop it.
  const rawItems = [
    makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30, geographies: ["US", "France"] }),
  ];
  const metaStory = {
    meta_story_id: "geo-leak",
    title: "Geo Leak Story",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Summary.",
    tags: {
      topics: ["Diplomatic relations"],
      keywords: [],
      geographies: ["US", "France"],
    },
    factual_claims: ["Reuters reports: Test Headline"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  assert.deepEqual(payload.stories[0].tags.geographies, ["US"], "France must not appear — not in settings.geographies");
});

// ─── Evidence-backed tag derivation (settings ∩ source evidence) ────────────
//
// buildStory derives final tags from `settings ∩ source-evidence` — model
// tags are NOT authoritative.  Two failure modes these tests guard against:
//   (a) model "leak": model echoes an in-settings tag the sources don't
//       support → must be DROPPED.
//   (b) model "miss": model omits a tag but source evidence supports a
//       settings value → must be ADDED back.

test("deriveStoryTags: topics drawn from source.topic, intersected with settings", () => {
  const sourceItems = [
    makeItem({ topic: "Diplomatic relations" }),
    makeItem({ topic: "Energy policy" }), // not in BASE_SETTINGS.topics
  ];
  const out = deriveStoryTags(sourceItems, BASE_SETTINGS);
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
});

test("deriveStoryTags: topic synonym in source resolves to the settings entry", () => {
  // BASE_SETTINGS.topics includes "Diplomatic relations"; source carries
  // "bilateral relations" which normalizes to it.
  const sourceItems = [makeItem({ topic: "bilateral relations" })];
  const out = deriveStoryTags(sourceItems, BASE_SETTINGS);
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
});

test("deriveStoryTags: geographies drawn from source.geographies, intersected with settings", () => {
  const sourceItems = [
    makeItem({ geographies: ["US", "France"] }),
    makeItem({ geographies: ["Colombia"] }),
  ];
  const out = deriveStoryTags(sourceItems, BASE_SETTINGS);
  // France dropped (not in settings); US + Colombia preserved.
  assert.deepEqual(out.geographies.sort(), ["Colombia", "US"]);
});

test("deriveStoryTags: keywords require whole-word evidence in source headline/body", () => {
  const sourceItems = [
    makeItem({
      headline: "Treasury weighs OFAC expansion",
      body: ["No other relevant terms here."],
    }),
  ];
  const out = deriveStoryTags(sourceItems, BASE_SETTINGS);
  // BASE_SETTINGS.keywords = ["OFAC", "sanctions"]. Only OFAC appears.
  assert.deepEqual(out.keywords, ["OFAC"]);
});

test("deriveStoryTags: substring inside a larger word does NOT satisfy keyword evidence", () => {
  const sourceItems = [
    makeItem({ headline: "ofacility opens new wing", body: ["unrelated"] }),
  ];
  const out = deriveStoryTags(sourceItems, BASE_SETTINGS);
  assert.deepEqual(out.keywords, [], "'ofacility' must not satisfy 'OFAC' keyword evidence");
});

test("deriveStoryTags: returns empty axis when a settings list is empty (never fabricates)", () => {
  const sourceItems = [makeItem({ topic: "Diplomatic relations", geographies: ["US"] })];
  const out = deriveStoryTags(sourceItems, {
    topics: [],
    keywords: [],
    geographies: [],
  });
  assert.deepEqual(out, { topics: [], keywords: [], geographies: [] });
});

test("deriveStoryTags: does not consult model tags at all", () => {
  // Model would claim Migration policy + sanctions + Colombia, but sources
  // support none of those.  Output must be derived only from sources.
  const sourceItems = [
    makeItem({
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Routine diplomatic update",
      body: ["A quiet briefing with no triggering terms."],
    }),
  ];
  const out = deriveStoryTags(sourceItems, BASE_SETTINGS);
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
  assert.deepEqual(out.keywords, []);
  assert.deepEqual(out.geographies, ["US"]);
});

test("runRefreshPipeline: in-settings model tag without source evidence is dropped (leak guard)", async () => {
  // Source supports "Diplomatic relations" + US.  Model also claims
  // "Migration policy" (in settings but no source evidence), "sanctions"
  // (in settings but absent from text), and "Colombia" (in settings but
  // no source has it).  All three must be dropped.
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Diplomatic update",
      body: ["A quiet briefing with no triggering terms."],
    }),
  ];
  const metaStory = {
    meta_story_id: "leak-guard",
    title: "Leak Guard Story",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Summary.",
    tags: {
      topics: ["Diplomatic relations", "Migration policy"], // Migration unsupported
      keywords: ["sanctions"], // unsupported (no whole-word match)
      geographies: ["US", "Colombia"], // Colombia unsupported
    },
    factual_claims: ["Reuters reports: Diplomatic update"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const tags = payload.stories[0].tags;
  assert.deepEqual(tags.topics, ["Diplomatic relations"], "Migration policy must be dropped — no source evidence");
  assert.deepEqual(tags.keywords, [], "'sanctions' must be dropped — not in any source text");
  assert.deepEqual(tags.geographies, ["US"], "Colombia must be dropped — no source carries it");
});

test("runRefreshPipeline: model omits tags but source evidence supports them — tags re-added", async () => {
  // Model returns empty tag axes; the pipeline must still emit the settings
  // values the sources support.
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US", "Colombia"],
      headline: "OFAC update reverberates",
      body: ["New sanctions package announced."],
    }),
  ];
  const metaStory = {
    meta_story_id: "rescue",
    title: "Rescue Tags From Evidence",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Summary.",
    tags: { topics: [], keywords: [], geographies: [] }, // model omitted everything
    factual_claims: ["Reuters reports: OFAC update reverberates"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const tags = payload.stories[0].tags;
  assert.deepEqual(tags.topics, ["Diplomatic relations"], "topic must be recovered from source.topic");
  assert.deepEqual(tags.keywords.sort(), ["OFAC", "sanctions"], "both settings keywords appear in text");
  assert.deepEqual(tags.geographies.sort(), ["Colombia", "US"], "both source geos are settings-backed");
});

test("runRefreshPipeline: multi-source story aggregates evidence across all sources", async () => {
  // src-A contributes US + OFAC mention; src-B contributes Colombia + sanctions mention.
  const rawItems = [
    makeItem({
      sourceId: "src-A",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "OFAC weighs new tools",
      body: ["No other terms."],
    }),
    makeItem({
      sourceId: "src-B",
      outlet: "El Tiempo",
      minutesAgo: 45,
      topic: "Diplomatic relations",
      geographies: ["Colombia"],
      headline: "Bogota briefed",
      body: ["Sanctions framework under discussion."],
    }),
  ];
  const metaStory = {
    meta_story_id: "multi-source",
    title: "Multi Source",
    subtitle: "Sub.",
    source_item_ids: ["src-A", "src-B"],
    summary: "Summary.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: OFAC weighs new tools"],
    claim_evidence_map: { "0": ["src-A"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const tags = payload.stories[0].tags;
  assert.deepEqual(tags.topics, ["Diplomatic relations"]);
  assert.deepEqual(tags.keywords.sort(), ["OFAC", "sanctions"]);
  assert.deepEqual(tags.geographies.sort(), ["Colombia", "US"]);
});

test("runRefreshPipeline: repeated out-of-settings entities in story text do not auto-add taxonomy", async () => {
  // The story headline/body repeatedly mention "Brazil" and "espionage" —
  // values that are NOT in settings.  Even though the model dutifully
  // echoes them into tags, they must never reach the output.  This also
  // verifies that settings itself is never expanded.
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const settingsBefore = JSON.parse(JSON.stringify(settings));
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      headline: "Brazil espionage probe widens; Brazil officials brief OFAC",
      body: ["Brazil. Brazil. Brazil. Espionage. Espionage. OFAC."],
    }),
  ];
  const metaStory = {
    meta_story_id: "brazil-espionage",
    title: "Brazil Espionage Probe",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Brazil espionage investigation broadens.",
    tags: {
      topics: ["Diplomatic relations", "Brazil intelligence affairs"],
      keywords: ["OFAC", "espionage", "Brazil"],
      geographies: ["US", "Brazil"],
    },
    factual_claims: ["Reuters reports: Brazil espionage probe widens; Brazil officials brief OFAC"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const tags = payload.stories[0].tags;
  assert.deepEqual(tags.topics, ["Diplomatic relations"], "no new topic should appear");
  assert.deepEqual(tags.keywords, ["OFAC"], "espionage/Brazil keywords must not leak");
  assert.deepEqual(tags.geographies, ["US"], "Brazil must not leak");
  assert.deepEqual(settings, settingsBefore, "settings must not be auto-expanded");
});

// ─── outletCount = unique source identities ─────────────────────────────────
//
// Story-card collapsed chip displays unique outlets/handles, not row count.
// `outletCount` is the contract field that powers that chip, so the pipeline
// must emit `|distinct outlets|` rather than `sources.length`.

test("runRefreshPipeline: outletCount reflects unique outlet identities, not row count", async () => {
  const rawItems = [
    makeItem({
      sourceId: "src-a",
      outlet: "Reuters",
      minutesAgo: 10,
      headline: "OFAC weighs new tools",
      body: ["Body A."],
    }),
    makeItem({
      sourceId: "src-b",
      outlet: "Reuters", // duplicate outlet, distinct piece
      minutesAgo: 20,
      headline: "OFAC follow-up filing",
      body: ["Body B."],
    }),
    makeItem({
      sourceId: "src-c",
      outlet: "El Tiempo",
      minutesAgo: 30,
      headline: "OFAC update echoes regionally",
      body: ["Body C."],
    }),
  ];
  const metaStory = {
    meta_story_id: "ofac-dup",
    title: "OFAC coverage",
    subtitle: "Sub.",
    source_item_ids: ["src-a", "src-b", "src-c"],
    summary: "Summary.",
    tags: {
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
    },
    factual_claims: [
      "Reuters reports: OFAC weighs new tools",
      "Reuters reports: OFAC follow-up filing",
      "El Tiempo reports: OFAC update echoes regionally",
    ],
    claim_evidence_map: { "0": ["src-a"], "1": ["src-b"], "2": ["src-c"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const story = payload.stories[0];
  assert.equal(story.sources.length, 3, "all 3 source pieces remain on the story");
  assert.equal(story.outletCount, 2, "outletCount must count unique outlets, not rows");
});

test("runRefreshPipeline: outletCount collapses casing/whitespace variants of the same outlet", async () => {
  // Same outlet emitted three ways ("Reuters", "reuters ", "REUTERS") plus one
  // legitimately distinct outlet — pipeline should report outletCount=2.
  //
  // `traditionalSources: []` is used so `selectSourcePool` doesn't drop the
  // whitespace/case variants on the way in — this test is about the unique
  // count emitted by buildStory, not about source-selection matching.
  const settings = { ...BASE_SETTINGS, traditionalSources: [], socialSources: [] };
  const rawItems = [
    makeItem({
      sourceId: "src-a",
      outlet: "Reuters",
      minutesAgo: 10,
      headline: "OFAC weighs new tools",
      body: ["Body A."],
    }),
    makeItem({
      sourceId: "src-b",
      outlet: "reuters ",
      minutesAgo: 20,
      headline: "OFAC follow-up filing",
      body: ["Body B."],
    }),
    makeItem({
      sourceId: "src-c",
      outlet: "REUTERS",
      minutesAgo: 30,
      headline: "OFAC briefing aside",
      body: ["Body C."],
    }),
    makeItem({
      sourceId: "src-d",
      outlet: "El Tiempo",
      minutesAgo: 40,
      headline: "OFAC update echoes regionally",
      body: ["Body D."],
    }),
  ];
  const metaStory = {
    meta_story_id: "ofac-fmt",
    title: "OFAC coverage",
    subtitle: "Sub.",
    source_item_ids: ["src-a", "src-b", "src-c", "src-d"],
    summary: "Summary.",
    tags: {
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
    },
    factual_claims: [
      "Reuters reports: OFAC weighs new tools",
      "reuters reports: OFAC follow-up filing",
      "REUTERS reports: OFAC briefing aside",
      "El Tiempo reports: OFAC update echoes regionally",
    ],
    claim_evidence_map: {
      "0": ["src-a"],
      "1": ["src-b"],
      "2": ["src-c"],
      "3": ["src-d"],
    },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const story = payload.stories[0];
  assert.equal(story.sources.length, 4, "all 4 source pieces remain on the story");
  assert.equal(
    story.outletCount,
    2,
    "outletCount must treat case/whitespace variants of the same outlet as one"
  );
  // Display labels must NOT be normalized — frontend shows the original casing.
  const outletsAsRendered = story.sources.map((s) => s.outlet);
  assert.deepEqual(outletsAsRendered, ["Reuters", "reuters ", "REUTERS", "El Tiempo"]);
});

test("runRefreshPipeline: outletCount excludes blank/whitespace-only outlets", async () => {
  // Defensive hardening: if upstream emits a row with an empty or whitespace-
  // only outlet, the normalized identity is "" — that must NOT count as a
  // source identity (otherwise missing-data rows would inflate the chip count).
  const settings = { ...BASE_SETTINGS, traditionalSources: [], socialSources: [] };
  const rawItems = [
    makeItem({
      sourceId: "src-a",
      outlet: "Reuters",
      minutesAgo: 10,
      headline: "OFAC weighs new tools",
      body: ["Body A."],
    }),
    makeItem({
      sourceId: "src-b",
      outlet: "",
      minutesAgo: 20,
      headline: "OFAC follow-up filing",
      body: ["Body B."],
    }),
    makeItem({
      sourceId: "src-c",
      outlet: "   ",
      minutesAgo: 30,
      headline: "OFAC briefing aside",
      body: ["Body C."],
    }),
    makeItem({
      sourceId: "src-d",
      outlet: "El Tiempo",
      minutesAgo: 40,
      headline: "OFAC update echoes regionally",
      body: ["Body D."],
    }),
  ];
  const metaStory = {
    meta_story_id: "ofac-blank",
    title: "OFAC coverage",
    subtitle: "Sub.",
    source_item_ids: ["src-a", "src-b", "src-c", "src-d"],
    summary: "Summary.",
    tags: {
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
    },
    factual_claims: [
      "Reuters reports: OFAC weighs new tools",
      "Unknown reports: OFAC follow-up filing",
      "Unknown reports: OFAC briefing aside",
      "El Tiempo reports: OFAC update echoes regionally",
    ],
    claim_evidence_map: {
      "0": ["src-a"],
      "1": ["src-b"],
      "2": ["src-c"],
      "3": ["src-d"],
    },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const story = payload.stories[0];
  assert.equal(story.sources.length, 4, "all 4 source pieces remain on the story");
  assert.equal(
    story.outletCount,
    2,
    "outletCount must skip blank/whitespace-only outlets (only Reuters + El Tiempo count)"
  );
});

test("runRefreshPipeline: outletCount is 0 when every outlet is blank", async () => {
  // Edge case: a meta-story whose source items all lack outlet data should
  // emit outletCount=0 rather than 1 (one "" key).  Sources list is preserved
  // so the expanded view can still render rows with empty outlet strings.
  const settings = { ...BASE_SETTINGS, traditionalSources: [], socialSources: [] };
  const rawItems = [
    makeItem({
      sourceId: "src-a",
      outlet: "",
      minutesAgo: 10,
      headline: "OFAC weighs new tools",
      body: ["Body A."],
    }),
    makeItem({
      sourceId: "src-b",
      outlet: "   ",
      minutesAgo: 20,
      headline: "OFAC follow-up filing",
      body: ["Body B."],
    }),
  ];
  const metaStory = {
    meta_story_id: "ofac-blank-only",
    title: "OFAC coverage",
    subtitle: "Sub.",
    source_item_ids: ["src-a", "src-b"],
    summary: "Summary.",
    tags: {
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
    },
    factual_claims: [
      "Unknown reports: OFAC weighs new tools",
      "Unknown reports: OFAC follow-up filing",
    ],
    claim_evidence_map: { "0": ["src-a"], "1": ["src-b"] },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
  });
  const story = payload.stories[0];
  assert.equal(story.sources.length, 2);
  assert.equal(
    story.outletCount,
    0,
    "outletCount must be 0 when no source has a non-blank outlet"
  );
});
