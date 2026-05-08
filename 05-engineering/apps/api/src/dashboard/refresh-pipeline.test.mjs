import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectSourcePool,
  apply24hFilter,
  applyRelevanceFilter,
  applyTopicKeywordFilter,
  runRefreshPipeline,
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
