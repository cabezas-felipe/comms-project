import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";

// This file pins three env-tunable pipeline knobs to legacy values so its
// fixtures keep testing the contract they were written for:
//   - TEMPO_RECALL_MODE="keyword": tests predate the embedding-recall stage and
//     don't inject embedFn; hybrid_strict would fail-closed to empty candidates.
//     Tests targeting the embedding stage opt back in via `recallConfig`.
//   - TEMPO_SEMANTIC_BEAT_FIT_ENABLED="false": legacy tests don't inject a
//     `semanticBeatFitEmbedFn`; the dedicated semantic tests opt in explicitly.
//   - TEMPO_BEAT_FIT_THRESHOLD="0.40": the MVP default dropped to 0.20
//     (recall-first); these fixtures were tuned against the 0.40 precision gate.
//
// These knobs are read from process.env at *call time* by the pipeline.  Under
// per-file process isolation (`node --test` default) setting them at module top
// was safe, but in a single-process full-suite run every module body executes
// before any test, so a module-top mutation leaks into sibling files (e.g. the
// relevance-precision eval, which reads the same knobs).  Capture the originals
// here and apply/restore the file-scoped values via describe-scoped
// beforeEach/afterEach so they never escape this file's own tests.
const _PREV_RECALL_MODE = process.env.TEMPO_RECALL_MODE;
const _PREV_SEMANTIC_BEAT_FIT_ENABLED = process.env.TEMPO_SEMANTIC_BEAT_FIT_ENABLED;
const _PREV_BEAT_FIT_THRESHOLD = process.env.TEMPO_BEAT_FIT_THRESHOLD;

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
  compareSourcesT1,
  compareStoriesR1,
  resolveGeoStageBudgetMs,
  resolveRefreshProfile,
  INTERACTIVE_GEO_STAGE_BUDGET_MS_DEFAULT,
  INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT,
  INTERACTIVE_CLUSTER_MAX_ATTEMPTS_DEFAULT,
  DEFAULT_CLUSTER_MAX_ATTEMPTS,
  COLD_START_GEO_STAGE_BUDGET_MS_DEFAULT,
  COLD_START_CLUSTER_TIMEOUT_MS_DEFAULT,
  COLD_START_CLUSTER_MAX_ATTEMPTS_DEFAULT,
  COLD_START_CLUSTER_INPUT_CAP_DEFAULT,
  compareClusterInputItems,
  applyClusterInputCap,
  CLUSTER_INPUT_CAP,
  enrichWhyItMattersForStories,
  prioritizeLane2Candidates,
  buildSourceGroundedWhyFallback,
} from "./refresh-pipeline.mjs";
import { PUBLISH_WINDOW_MINUTES } from "../ingestion/source-deduper.mjs";
// Hoisted from further down the file: ESM imports must sit at module top level,
// not inside the describe() wrapper that scopes this file's env knobs.
import {
  resolveSemanticBeatFitConfig,
  createProfileEmbeddingCache,
} from "./semantic-beat-fit.mjs";
import { WHAT_CHANGED_COPY, WHAT_CHANGED_DIAGNOSTICS_SCHEMA_VERSION } from "./what-changed-engine.mjs";
// Slice 3 follow-up: assert the terminal-field SLO guard directly against the
// ops evaluator (no server/route round-trip needed for the counting semantics).
import { evaluateRefreshSlo, _resetSloState } from "../ops/refresh-slo.mjs";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  const sourceId = overrides.sourceId ?? "src-1";
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
    sourceId,
    outlet: "Reuters",
    byline: "Test Author",
    kind: "traditional",
    weight: 75,
    // URL defaults to a unique-per-sourceId path so cross-feed dedupe (which
    // groups by canonical URL) does NOT collapse fixture items that aren't
    // intentionally testing dedupe.  Tests that exercise dedupe behavior
    // override `url` explicitly to share a canonical URL across items.
    url: `https://example.com/${sourceId}`,
    minutesAgo: 30,
    headline: "Test Headline",
    body: ["Test body."],
    ...overrides,
  };
}

// Slice 2: the post-cluster split healer defaults to ENABLED. Pre-existing
// pipeline tests below build multi-source meta-stories with deliberately
// low-overlap (or hallucinated-id) fixtures to exercise grounding / tags /
// outletCount aggregation — those clusters would now be split by the healer,
// changing the stage under test. Tests that are NOT exercising the healer pass
// this override so they stay hermetic; the healer's own behavior is covered by
// the dedicated "Slice 2" tests at the end of this file and by
// cluster-split-healer.test.mjs.
const SPLIT_HEALER_DISABLED = { enabled: false, jaccardThreshold: 0.15 };

const BASE_SETTINGS = {
  contractVersion: "2026-05-19-meta-story-fields",
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["OFAC", "sanctions"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["Reuters", "El Tiempo"],
  socialSources: [],
};

describe("refresh-pipeline", () => {
  // Apply the file-scoped pipeline knobs before each test and restore the
  // captured originals after, so they never leak into sibling test files when
  // the whole suite shares one process.
  beforeEach(() => {
    process.env.TEMPO_RECALL_MODE = "keyword";
    process.env.TEMPO_SEMANTIC_BEAT_FIT_ENABLED = "false";
    process.env.TEMPO_BEAT_FIT_THRESHOLD = "0.40";
  });
  afterEach(() => {
    if (_PREV_RECALL_MODE === undefined) delete process.env.TEMPO_RECALL_MODE;
    else process.env.TEMPO_RECALL_MODE = _PREV_RECALL_MODE;
    if (_PREV_SEMANTIC_BEAT_FIT_ENABLED === undefined) delete process.env.TEMPO_SEMANTIC_BEAT_FIT_ENABLED;
    else process.env.TEMPO_SEMANTIC_BEAT_FIT_ENABLED = _PREV_SEMANTIC_BEAT_FIT_ENABLED;
    if (_PREV_BEAT_FIT_THRESHOLD === undefined) delete process.env.TEMPO_BEAT_FIT_THRESHOLD;
    else process.env.TEMPO_BEAT_FIT_THRESHOLD = _PREV_BEAT_FIT_THRESHOLD;
  });

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

test("selectSourcePool: fail-closes to [] when both source lists are empty (C2 / M6)", () => {
  // C2: zero configured sources means the user hasn't opted into any outlets.
  // Surfacing the whole pool under that state would recommend content the
  // user never chose to monitor — the legacy "all items" semantics are gone.
  const settings = { ...BASE_SETTINGS, traditionalSources: [], socialSources: [] };
  const items = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  const result = selectSourcePool(items, settings);
  assert.deepEqual(result, []);
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

test("applyTopicKeywordFilter: passes all items only when topics, keywords AND geographies are all empty", () => {
  const settings = { ...BASE_SETTINGS, topics: [], keywords: [], geographies: [] };
  const items = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  assert.equal(applyTopicKeywordFilter(items, settings).length, 2);
});

test("applyTopicKeywordFilter: geographies-only settings now filter by geo text mention (Slice 2)", () => {
  const items = [
    // Mentions configured geo "Colombia" in text — passes via geo lexical gate.
    makeItem({ sourceId: "geo-hit", topic: "Unknown", geographies: [], headline: "Colombia presidential candidate enters race", body: ["No keyword."] }),
    // No topic/keyword/geo text — must NOT pass now that geo gate is active.
    makeItem({ sourceId: "geo-miss", topic: "Unknown", geographies: ["US"], headline: "Local news today", body: ["No keyword."] }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: [], geographies: ["Colombia"] });
  assert.deepEqual(result.map((i) => i.sourceId), ["geo-hit"], "geo text mention passes; non-mention is filtered");
});

test("applyTopicKeywordFilter: 'Colombia presidential candidate…' passes on configured geo alone (no topic/keyword)", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Unknown", geographies: [], headline: "Colombia presidential candidate floats new policy", body: ["No keyword here."] }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: [], geographies: ["Colombia"] });
  assert.equal(result.length, 1, "configured geography text mention is a sufficient lexical signal");
});

test("applyTopicKeywordFilter: 'Colombians head to the polls…' passes via demonym synonym (Slice 1 parity)", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Unknown", geographies: [], headline: "Colombians head to the polls this weekend", body: ["No keyword here."] }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: [], geographies: ["Colombia"] });
  assert.equal(result.length, 1, "demonym 'Colombians' resolves to configured 'Colombia'");
});

test("applyTopicKeywordFilter: unrelated geography text does not pass when only Colombia/Kenya configured", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Unknown", geographies: [], headline: "Norwegian fisheries report record salmon harvest", body: ["No keyword here."] }),
  ];
  const result = applyTopicKeywordFilter(items, { ...BASE_SETTINGS, topics: [], keywords: [], geographies: ["Colombia", "Kenya"] });
  assert.deepEqual(result, [], "text mentions neither configured geo → filtered");
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
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.contractVersion, "2026-05-19-meta-story-fields");
  assert.equal(payload.stories.length, 1);
  assert.equal(payload.stories[0].id, "diplomatic-relations-developments");
  assert.equal(log.metaStoryCount, 1);
  assert.equal(log.usedFallbackClustering, false);
});

test("runRefreshPipeline: two-outlet input (WaPo + Reuters) reaches clustering with both outlets", async () => {
  // Batch 1 two-outlet assertion (Sub-slice 1.3/1.4): when settings select
  // both publishers, the pool stage must admit items from each outlet and
  // pass them through to the clustering stage.  Pins the pipeline contract
  // that lets a downstream meta-story carry source items from more than one
  // publisher — the cross-outlet sourcing that's the stretch goal of 1.3.
  const settings = {
    ...BASE_SETTINGS,
    traditionalSources: ["The Washington Post", "Reuters"],
  };
  const rawItems = [
    makeItem({ sourceId: "wapo-1", outlet: "The Washington Post", minutesAgo: 30 }),
    makeItem({ sourceId: "reuters-1", outlet: "Reuters", minutesAgo: 45 }),
  ];
  let clusterInput = null;
  await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async (items) => { clusterInput = items; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.ok(clusterInput, "cluster must be invoked when both outlets carry relevant items");
  const sourceIdsSeen = clusterInput.map((i) => i.sourceId).sort();
  assert.deepEqual(sourceIdsSeen, ["reuters-1", "wapo-1"]);
  const outletsSeen = [...new Set(clusterInput.map((i) => i.outlet))].sort();
  assert.deepEqual(outletsSeen, ["Reuters", "The Washington Post"]);
});

test("runRefreshPipeline: returns empty stories when relevant pool is empty", async () => {
  const rawItems = [makeItem({ sourceId: "src-out", outlet: "BBC", topic: "Cooking", geographies: ["France"], headline: "Food" })];
  let clusterCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => { clusterCalled = true; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(clusterCalled, false, "cluster should not be called when pool is empty");
});

test("runRefreshPipeline: fail-closed (0 stories) when clustering fails on both attempts", async () => {
  // Locked policy: clustering failure → retry once → publish ZERO meta-stories.
  // The pipeline must NOT ship gracefulFallbackClustering buckets to users.
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let attempts = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => { attempts++; throw new Error("model unavailable"); },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(attempts, 2, "clustering must be attempted exactly twice (initial + one retry)");
  assert.equal(payload.stories.length, 0, "fail-closed: no stories on clustering failure");
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(log.clusteringFailureReason, "error");
  assert.equal(log.clusteringAttempts, 2);
});

test("runRefreshPipeline: retries clustering once and publishes when the retry succeeds", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let attempts = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient blip");
      return MOCK_META_STORIES;
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(attempts, 2, "first attempt fails, second succeeds");
  assert.equal(payload.stories.length, 1, "stories published from the successful retry");
  assert.equal(log.usedFallbackClustering, false);
  assert.equal(log.clusteringFailureReason, null);
  assert.equal(log.clusteringAttempts, 2);
});

test("runRefreshPipeline: classifies a clustering timeout failure reason", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => { throw new Error("Anthropic clustering timed out (claude-sonnet-4-6)"); },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(log.clusteringFailureReason, "timeout");
  assert.equal(log.clusteringAttempts, 2);
});

test("runRefreshPipeline: fail-closed emits the exact diagnostic contract the route's snapshot-continuity guard gates on", async () => {
  // Slice 1: the route handler decides whether to preserve a prior healthy
  // snapshot by reading `clusteringFailureReason` (non-null) + an empty
  // `payload.stories`.  Pin that contract here so a future pipeline change
  // can't silently break fail-closed snapshot continuity at the route layer.
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => { throw new Error("model unavailable"); },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  // No fabricated fallback stories — the empty array is the gating signal.
  assert.ok(Array.isArray(payload.stories), "payload.stories must be an array");
  assert.equal(payload.stories.length, 0, "fail-closed must publish zero stories (no fabricated buckets)");
  // The route requires a non-null failure reason to enter the preserve branch.
  assert.notEqual(log.clusteringFailureReason, null, "clusteringFailureReason must be set on fail-closed");
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(typeof log.clusteringAttempts, "number");
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
  });
  const { payload: p2 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [story2],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
  });

  const { payload: p2 } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => makeResult("Completely Different Title"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    readHeldFn: async () => [{ ...heldItem, geoCategory: "implicit_geo", geoConfidence: 0.3 }],
    geoAssessFn: async () => ({ confidence: 0.3 }),
    writeHeldFn: async (items) => { writtenHeld = items; },
  });

  assert.ok(!seenIds.includes("still-held"), "low-confidence item must not reach cluster");
  assert.ok(writtenHeld !== null && writtenHeld.some((i) => i.sourceId === "still-held"),
    "item must be written back to hold bucket");
});

// ─── A1.1: protected must-see lane + adaptive geo time budget ────────────────
//
// The geo stage splits candidates into Lane 1 (protected must-see: from a
// selected source AND carrying a geo signal — explicit geographies overlap OR a
// configured-geography lexical mention) and Lane 2 (everything else, incl.
// hold-bucket re-evals). Lane 1 always finishes; Lane 2 is processed only while
// the wall-clock budget holds, then deferred to the hold path. Tests pin the
// budget via the `geoStageBudgetMs` opt (0 forces a post-Lane-1 budget hit).

test("resolveGeoStageBudgetMs: unset/invalid env → default 25000, valid honored", () => {
  const saved = process.env.TEMPO_AI_GEO_STAGE_BUDGET_MS;
  try {
    delete process.env.TEMPO_AI_GEO_STAGE_BUDGET_MS;
    assert.equal(resolveGeoStageBudgetMs(), 25000);
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env.TEMPO_AI_GEO_STAGE_BUDGET_MS = bad;
      assert.equal(resolveGeoStageBudgetMs(), 25000, `"${bad}" → default`);
    }
    process.env.TEMPO_AI_GEO_STAGE_BUDGET_MS = "8000";
    assert.equal(resolveGeoStageBudgetMs(), 8000);
  } finally {
    if (saved !== undefined) process.env.TEMPO_AI_GEO_STAGE_BUDGET_MS = saved;
    else delete process.env.TEMPO_AI_GEO_STAGE_BUDGET_MS;
  }
});

// ─── Slice 4: interactive fast-path profile ──────────────────────────────────

test("resolveRefreshProfile: default profile is inert (no geo/cluster timeout override, 2 attempts)", () => {
  const p = resolveRefreshProfile(null);
  assert.equal(p.name, "default");
  assert.equal(p.interactive, false);
  assert.equal(p.geoStageBudgetMs, null, "default must fall through to env/default geo budget");
  assert.equal(p.clusterTimeoutMs, null, "default must fall through to env/default cluster timeout");
  assert.equal(p.clusterMaxAttempts, DEFAULT_CLUSTER_MAX_ATTEMPTS);
  // Any unknown profile name also resolves to the default (forward-compat).
  assert.equal(resolveRefreshProfile("scheduled").name, "default");
  assert.equal(resolveRefreshProfile("totally-unknown").name, "default");
});

test("resolveRefreshProfile: cold_start profile yields the locked first-run knobs (Slice 1)", () => {
  const p = resolveRefreshProfile("cold_start");
  assert.equal(p.name, "cold_start");
  assert.equal(p.interactive, true);
  // Locked cold-start-v1 defaults: 12000 / 45000 / 2 / cap 10, Lane 2 deferred.
  assert.equal(p.geoStageBudgetMs, COLD_START_GEO_STAGE_BUDGET_MS_DEFAULT);
  assert.equal(p.geoStageBudgetMs, 12000);
  assert.equal(p.clusterTimeoutMs, COLD_START_CLUSTER_TIMEOUT_MS_DEFAULT);
  assert.equal(p.clusterTimeoutMs, 45000);
  assert.equal(p.clusterMaxAttempts, COLD_START_CLUSTER_MAX_ATTEMPTS_DEFAULT);
  assert.equal(p.clusterMaxAttempts, 2);
  assert.equal(p.deferGeoLane2, true);
  assert.equal(p.clusterInputCap, COLD_START_CLUSTER_INPUT_CAP_DEFAULT);
  assert.equal(p.clusterInputCap, 10);
});

test("resolveRefreshProfile: interactive profile yields bounded fast-path knobs (env-overridable)", () => {
  const savedGeo = process.env.TEMPO_INTERACTIVE_GEO_STAGE_BUDGET_MS;
  const savedTimeout = process.env.TEMPO_INTERACTIVE_CLUSTER_TIMEOUT_MS;
  const savedAttempts = process.env.TEMPO_INTERACTIVE_CLUSTER_MAX_ATTEMPTS;
  try {
    delete process.env.TEMPO_INTERACTIVE_GEO_STAGE_BUDGET_MS;
    delete process.env.TEMPO_INTERACTIVE_CLUSTER_TIMEOUT_MS;
    delete process.env.TEMPO_INTERACTIVE_CLUSTER_MAX_ATTEMPTS;
    const p = resolveRefreshProfile("interactive");
    assert.equal(p.name, "interactive");
    assert.equal(p.interactive, true);
    // Slice 4.1 calibrated defaults: 12000 / 22000 / 2.
    assert.equal(p.geoStageBudgetMs, INTERACTIVE_GEO_STAGE_BUDGET_MS_DEFAULT);
    assert.equal(p.geoStageBudgetMs, 12000);
    assert.equal(p.clusterTimeoutMs, INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT);
    assert.equal(p.clusterTimeoutMs, 22000);
    assert.equal(p.clusterMaxAttempts, INTERACTIVE_CLUSTER_MAX_ATTEMPTS_DEFAULT);
    assert.equal(p.clusterMaxAttempts, 2, "interactive clustering attempts are ALWAYS 2 (locked)");
    // Interactive geo budget must still be materially tighter than the default
    // to cut wall clock (the latency win now comes from geo + per-attempt
    // timeout, not from dropping the retry).
    assert.ok(
      INTERACTIVE_GEO_STAGE_BUDGET_MS_DEFAULT < resolveGeoStageBudgetMs(),
      "interactive geo budget must be below the default geo budget"
    );
    // Env overrides win so ops can retune the band without a deploy.  Use a
    // distinct attempts value (3) so the override is provably honored rather
    // than coinciding with the new default of 2.
    process.env.TEMPO_INTERACTIVE_GEO_STAGE_BUDGET_MS = "5000";
    process.env.TEMPO_INTERACTIVE_CLUSTER_TIMEOUT_MS = "15000";
    process.env.TEMPO_INTERACTIVE_CLUSTER_MAX_ATTEMPTS = "3";
    const o = resolveRefreshProfile("interactive");
    assert.equal(o.geoStageBudgetMs, 5000);
    assert.equal(o.clusterTimeoutMs, 15000);
    assert.equal(o.clusterMaxAttempts, 3);
  } finally {
    if (savedGeo !== undefined) process.env.TEMPO_INTERACTIVE_GEO_STAGE_BUDGET_MS = savedGeo;
    else delete process.env.TEMPO_INTERACTIVE_GEO_STAGE_BUDGET_MS;
    if (savedTimeout !== undefined) process.env.TEMPO_INTERACTIVE_CLUSTER_TIMEOUT_MS = savedTimeout;
    else delete process.env.TEMPO_INTERACTIVE_CLUSTER_TIMEOUT_MS;
    if (savedAttempts !== undefined) process.env.TEMPO_INTERACTIVE_CLUSTER_MAX_ATTEMPTS = savedAttempts;
    else delete process.env.TEMPO_INTERACTIVE_CLUSTER_MAX_ATTEMPTS;
  }
});

test("runRefreshPipeline: interactive profile surfaces tuned diagnostics and passes the tighter cluster timeout (Slice 4.1)", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const seenClusterOpts = [];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (_items, _settings, _model, opts) => {
      seenClusterOpts.push(opts);
      return MOCK_META_STORIES;
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    refreshProfile: "interactive",
  });
  assert.equal(payload.stories.length, 1, "interactive profile still yields stories (quality preserved)");
  // Diagnostics — additive, deterministic, comparable to baseline.  Slice 4.1
  // calibration: geo budget 12000, cluster timeout 22000, attempts ALWAYS 2.
  assert.equal(log.profile.name, "interactive");
  assert.equal(log.profile.interactive, true);
  assert.equal(log.profile.geoStageBudgetMs, INTERACTIVE_GEO_STAGE_BUDGET_MS_DEFAULT);
  assert.equal(log.profile.clusterMaxAttempts, INTERACTIVE_CLUSTER_MAX_ATTEMPTS_DEFAULT);
  assert.equal(log.profile.clusterMaxAttempts, 2, "interactive clustering attempts are ALWAYS 2 (locked)");
  assert.equal(log.profile.clusterTimeoutMs, INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT);
  // First attempt succeeds → loop breaks after one call, but the tighter
  // interactive timeout is threaded on every clusterFn call.
  assert.equal(seenClusterOpts.length, 1, "clustering succeeds on the first attempt → single call");
  assert.equal(seenClusterOpts[0]?.timeoutMs, INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT);
});

test("runRefreshPipeline: interactive profile retries clustering once (attempts ALWAYS 2) and recovers on the retry", async () => {
  // Slice 4.1 locked decision: interactive runs keep the default profile's
  // resilience (initial try + one retry).  A transient first-attempt failure
  // must NOT fail closed when the retry succeeds — this is the empty-risk
  // reduction the recalibration exists for.
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let attempts = 0;
  const seenClusterOpts = [];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (_items, _settings, _model, opts) => {
      attempts++;
      seenClusterOpts.push(opts);
      if (attempts === 1) throw new Error("transient blip");
      return MOCK_META_STORIES;
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    refreshProfile: "interactive",
  });
  assert.equal(attempts, 2, "interactive retries once (initial + one retry)");
  assert.equal(payload.stories.length, 1, "recovers on the retry rather than shipping empty");
  assert.equal(log.usedFallbackClustering, false);
  assert.equal(log.clusteringFailureReason, null);
  assert.equal(log.clusteringAttempts, 2);
  assert.equal(log.profile.clusterMaxAttempts, 2);
  // The tighter interactive timeout is threaded on BOTH attempts.
  assert.deepEqual(seenClusterOpts, [
    { timeoutMs: INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT },
    { timeoutMs: INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT },
  ]);
});

test("runRefreshPipeline: default profile is unchanged — 2 attempts, no cluster timeout override, profile diagnostics report default", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let attempts = 0;
  const seenClusterOpts = [];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (_items, _settings, _model, opts) => {
      attempts++;
      seenClusterOpts.push(opts);
      if (attempts === 1) throw new Error("transient blip");
      return MOCK_META_STORIES;
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    // No refreshProfile → default profile.
  });
  // Default keeps the retry (2 attempts); interactive is also locked at 2 after
  // Slice 4.1, with latency wins coming from tighter geo/timeout knobs.
  assert.equal(attempts, 2, "default profile retries once (initial + retry)");
  assert.equal(payload.stories.length, 1);
  assert.equal(log.profile.name, "default");
  assert.equal(log.profile.interactive, false);
  assert.equal(log.profile.clusterMaxAttempts, DEFAULT_CLUSTER_MAX_ATTEMPTS);
  assert.equal(log.profile.clusterTimeoutMs, null, "default passes no per-call cluster timeout");
  // No timeout override threaded on the default path.
  assert.deepEqual(seenClusterOpts, [{}, {}]);
});

test("runRefreshPipeline: interactive profile preserves fail-closed trust (both attempts fail → zero stories, classified error)", async () => {
  // Slice 1 continuity contract still holds: when BOTH interactive attempts
  // fail, the pipeline publishes ZERO stories (no fabricated fallback) with a
  // non-null clusteringFailureReason the route's continuity gate keys on.
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let attempts = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => { attempts++; throw new Error("model unavailable"); },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    refreshProfile: "interactive",
  });
  assert.equal(attempts, 2, "interactive attempts clustering twice before failing closed (always 2)");
  assert.equal(payload.stories.length, 0, "fail-closed: no fabricated fallback stories");
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(log.clusteringFailureReason, "error", "non-null reason preserves Slice 1 continuity gate");
  assert.equal(log.clusteringAttempts, 2);
  assert.equal(log.profile.name, "interactive");
});

// ─── Slice 5: progressive whyItMatters enrichment ────────────────────────────

test("runRefreshPipeline: deferWhyItMatters skips the writer, emits non-empty fallback copy + deferred diagnostics", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let whyResolverCalls = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    deferWhyItMatters: true,
    // If the writer ran, this would increment — it must NOT on the deferred path.
    resolveWhyItMattersFn: async () => { whyResolverCalls += 1; return { whyItMatters: "SHOULD-NOT-RUN", trace: {}, diagnostics: {} }; },
  });
  assert.equal(payload.stories.length, 1);
  // whyItMatters is non-empty fallback copy — never empty, never a subtitle echo.
  assert.ok(payload.stories[0].whyItMatters.length > 0, "fallback whyItMatters must be non-empty");
  assert.notEqual(payload.stories[0].whyItMatters, payload.stories[0].subtitle, "never a subtitle echo");
  assert.equal(whyResolverCalls, 0, "deferred path must NOT invoke the why writer");
  // Diagnostics make the deferred/pending state observable.
  assert.equal(log.whyItMatters.deferred, true);
  assert.equal(log.whyEnrichment.deferred, true);
  assert.equal(log.whyEnrichment.pending, 1);
  assert.equal(log.whyEnrichment.completed, 0);
  assert.equal(log.whyEnrichment.total, 1);
});

test("runRefreshPipeline: default (non-deferred) run reports whyEnrichment completed (no pending)", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    // deferWhyItMatters defaults false.
  });
  assert.equal(log.whyItMatters.deferred, false);
  assert.equal(log.whyEnrichment.deferred, false);
  assert.equal(log.whyEnrichment.pending, 0);
  assert.equal(log.whyEnrichment.completed, 1);
});

test("enrichWhyItMattersForStories: upgrades whyItMatters in place via the injected resolver (lineage preserved)", async () => {
  const stories = [
    { id: "m1", metaStoryId: "m1", title: "T1", subtitle: "s1", summary: "sum1", whatChanged: "c1", whyItMatters: "FALLBACK copy", sources: [] },
    { id: "m2", metaStoryId: "m2", title: "T2", subtitle: "s2", summary: "sum2", whatChanged: "c2", whyItMatters: "FALLBACK copy", sources: [] },
  ];
  const richResolver = async (input) => ({
    whyItMatters: `RICH:${input.metaStoryId}`,
    trace: { metaStoryId: input.metaStoryId },
    diagnostics: {},
  });
  const { stories: upgraded, diagnostics } = await enrichWhyItMattersForStories({
    stories,
    resolveWhyItMattersFn: richResolver,
  });
  assert.equal(upgraded.length, 2);
  assert.equal(upgraded[0].whyItMatters, "RICH:m1");
  assert.equal(upgraded[1].whyItMatters, "RICH:m2");
  // metaStoryId lineage preserved exactly (no re-clustering).
  assert.equal(upgraded[0].metaStoryId, "m1");
  assert.equal(upgraded[1].metaStoryId, "m2");
  assert.equal(diagnostics.upgraded, 2);
  assert.equal(diagnostics.total, 2);
});

test("enrichWhyItMattersForStories: a throwing resolver degrades to non-empty safe fallback (no corruption)", async () => {
  const stories = [
    { id: "m1", metaStoryId: "m1", title: "T1", subtitle: "s1", summary: "sum1", whatChanged: "c1", whyItMatters: "FALLBACK copy", sources: [] },
  ];
  const throwingResolver = async () => { throw new Error("writer unavailable"); };
  const { stories: upgraded, diagnostics } = await enrichWhyItMattersForStories({
    stories,
    resolveWhyItMattersFn: throwingResolver,
  });
  assert.equal(upgraded.length, 1);
  assert.ok(upgraded[0].whyItMatters.length > 0, "must remain non-empty on resolver failure");
  assert.notEqual(upgraded[0].whyItMatters, upgraded[0].subtitle, "never a subtitle echo");
  assert.equal(diagnostics.upgraded, 0, "no stories counted as upgraded when the resolver fails");
});

test("runRefreshPipeline: Lane 1 is processed before Lane 2 in the geo stage (A1.1 ordering)", async () => {
  // A1.1 sequencing contract, asserted independently of the A2 bypass: the geo
  // lane split must emit Lane 1 (must-see) ahead of Lane 2 regardless of input
  // order. Lane 1 here is an explicit_match item — must-see by tagged geography,
  // so the lexical pre-pass plays no part (it neither short-circuits nor masks
  // ordering). Lane 2 is an implicit_geo item with no geo signal that hits the
  // assessor. The input is deliberately ordered Lane 2 first, so a passing
  // assertion can only come from the split reordering Lane 1 ahead.
  const assessOrder = [];
  let clusterOrder = [];
  const rawItems = [
    makeItem({ sourceId: "lane2", outlet: "Reuters", geographies: [], headline: "Local council budget talks" }),
    makeItem({ sourceId: "lane1", outlet: "Reuters", geographies: ["US"] }),
  ];
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { clusterOrder = items.map((i) => i.sourceId); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async (item) => { assessOrder.push(item.sourceId); return { confidence: 0.85 }; },
    beatFitEnabled: false, // isolate lane ordering from the relevance gate
  });
  assert.deepEqual(clusterOrder, ["lane1", "lane2"], "geo lane split must place Lane 1 ahead of Lane 2");
  // The Lane 1 must-see item is admitted without an assess call (explicit_match
  // short-circuits the assessor); only the no-signal Lane 2 item is assessed.
  assert.deepEqual(assessOrder, ["lane2"], "only the Lane 2 candidate reaches the assessor");
});

test("runRefreshPipeline: A2 lexical pre-pass admits a Lane 1 geo-mention item without an assess call", async () => {
  // Lane 1: implicit_geo item whose text names a configured geography ("US") →
  // must-see. Under A2 its lexical signal admits it WITHOUT an assess call.
  // Lane 2: implicit_geo item with no geo mention → still hits the assessor.
  // Both from the selected source (Reuters).
  const assessed = [];
  const rawItems = [
    // Order the Lane 2 (assessed) item first so the result can't be an accident
    // of input position — the lane split reorders Lane 1 ahead of it anyway.
    makeItem({ sourceId: "assessed", outlet: "Reuters", geographies: [], headline: "Local council budget talks" }),
    makeItem({ sourceId: "bypass", outlet: "Reuters", geographies: [], headline: "US sanctions package debated" }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async (item) => { assessed.push(item.sourceId); return { confidence: 0.85 }; },
  });
  assert.deepEqual(assessed, ["assessed"], "only the no-mention item hits the assessor; the geo-mention item bypasses");
  assert.equal(log.geo.geoLexicalBypassCount, 1, "the Lane 1 geo-mention item is admitted via the lexical pre-pass");
  assert.equal(log.geo.geoAssessedCount, 1, "exactly one assess call — the no-signal Lane 2 item");
});

test("runRefreshPipeline: Lane 1 still completes when budget is already exhausted (budget=0)", async () => {
  // budget=0 means the geo stage is "over budget" the instant Lane 1 finishes,
  // yet Lane 1 must always run to completion. Lane 1 = explicit_match (US) →
  // always included → reaches clustering even though the budget is blown.
  const seenIds = [];
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
    makeItem({ sourceId: "opportunistic", outlet: "Reuters", geographies: [], headline: "Unrelated filler" }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    geoStageBudgetMs: 0,
    beatFitEnabled: false,
  });
  assert.ok(seenIds.includes("mustsee"), "Lane 1 must-see item must reach clustering despite budget=0");
  assert.equal(log.geo.geoLane1Count, 1);
  assert.equal(log.geo.geoBudgetHit, true);
});

test("runRefreshPipeline: Lane 2 is deferred (and not clustered) when budget is hit post-Lane-1", async () => {
  const seenIds = [];
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
    makeItem({ sourceId: "defer-a", outlet: "Reuters", geographies: [], headline: "Filler one" }),
    makeItem({ sourceId: "defer-b", outlet: "Reuters", geographies: [], headline: "Filler two" }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    geoStageBudgetMs: 0,
    beatFitEnabled: false,
  });
  assert.equal(log.geo.geoLane2Count, 2, "two opportunistic candidates form Lane 2");
  assert.equal(log.geo.geoLane2DeferredCount, 2, "both Lane 2 items deferred under budget=0");
  assert.equal(log.geo.geoBudgetHit, true);
  assert.ok(!seenIds.includes("defer-a") && !seenIds.includes("defer-b"),
    "deferred Lane 2 items must not reach clustering this refresh");
});

test("runRefreshPipeline: deferred Lane 2 items are written to the hold path for re-evaluation", async () => {
  let writtenHeld = null;
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
    makeItem({ sourceId: "deferred", outlet: "Reuters", geographies: [], headline: "Filler" }),
  ];
  await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    geoStageBudgetMs: 0,
    writeHeldFn: async (items) => { writtenHeld = items; },
  });
  assert.ok(writtenHeld !== null, "writeHeldFn must be called");
  assert.ok(writtenHeld.some((i) => i.sourceId === "deferred"),
    "budget-deferred item must be persisted to hold for next-refresh re-evaluation");
  // Deferred items are written bare (no geo metadata) so the hold reader admits
  // them cleanly next refresh.
  const deferred = writtenHeld.find((i) => i.sourceId === "deferred");
  assert.equal(deferred.geoConfidence, undefined, "deferred item carries no stale geoConfidence");
});

test("runRefreshPipeline: ample budget processes all of Lane 2 (no defer, no budget hit)", async () => {
  const seenIds = [];
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
    makeItem({ sourceId: "lane2", outlet: "Reuters", geographies: [], headline: "Filler" }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    geoStageBudgetMs: 60000,
    beatFitEnabled: false,
  });
  assert.equal(log.geo.geoBudgetHit, false);
  assert.equal(log.geo.geoLane2DeferredCount, 0);
  // Slice 2: budget-pressure / no-defer paths carry no profile reason.
  assert.equal(log.geo.geoLane2DeferredReason, null,
    "non-cold_start defer reason stays null (budget path is signalled by geoBudgetHit)");
  assert.ok(seenIds.includes("mustsee") && seenIds.includes("lane2"),
    "with ample budget both lanes reach clustering");
});

// ─── Slice 2: cold_start profile-driven Lane 2 deferral ──────────────────────

test("runRefreshPipeline: cold_start defers ALL of Lane 2 without assessing it (profile_defer)", async () => {
  const seenIds = [];
  const assessedIds = [];
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
    makeItem({ sourceId: "defer-a", outlet: "Reuters", geographies: [], headline: "Filler one" }),
    makeItem({ sourceId: "defer-b", outlet: "Reuters", geographies: [], headline: "Filler two" }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-sonnet",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async (item) => { assessedIds.push(item.sourceId); return { confidence: 0.85 }; },
    refreshProfile: "cold_start",
    beatFitEnabled: false,
  });
  const g = log.geo;
  // Lane 1 still fully processed; the must-see item reaches clustering.
  assert.equal(g.geoLane1Count, 1);
  assert.equal(g.geoLane1Processed, 1, "Lane 1 processed to completion under cold_start");
  assert.ok(seenIds.includes("mustsee"), "Lane 1 must-see still reaches clustering");
  // Lane 2 entirely deferred — not processed, not in clustering.
  assert.equal(g.geoLane2Count, 2, "two opportunistic candidates form Lane 2");
  assert.equal(g.geoLane2DeferredCount, 2, "cold_start defers all Lane 2 items");
  assert.equal(g.geoLane2Processed, 0, "no Lane 2 processed under cold_start");
  assert.ok(!seenIds.includes("defer-a") && !seenIds.includes("defer-b"),
    "deferred Lane 2 items must not reach clustering this refresh");
  // Explicit, profile-driven reason — distinguishable from budget pressure.
  assert.equal(g.geoLane2DeferredReason, "profile_defer");
  // Lane 2 contributes zero assessor calls (the must-see item is an
  // explicit_match that bypasses the assessor, so total calls are zero too).
  assert.ok(!assessedIds.includes("defer-a") && !assessedIds.includes("defer-b"),
    "Lane 2 items are never assessed under cold_start defer");
  assert.equal(assessedIds.length, 0, "no geoAssessFn calls at all this refresh");
});

test("runRefreshPipeline: cold_start defer is NOT budget pressure (geoBudgetHit stays false)", async () => {
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
    makeItem({ sourceId: "defer-a", outlet: "Reuters", geographies: [], headline: "Filler one" }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-sonnet",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    refreshProfile: "cold_start",
    beatFitEnabled: false,
  });
  assert.equal(log.geo.geoBudgetHit, false,
    "intentional profile defer must not read as geo budget exhaustion");
  assert.equal(log.geo.geoLane2DeferredReason, "profile_defer");
  // Cold_start surfaces the profile's bounded geo budget unchanged (12000); the
  // defer happens before the budget loop, so the budget itself is untouched.
  assert.equal(log.profile.name, "cold_start");
});

test("runRefreshPipeline: cold_start defer scope includes previously-held re-evals", async () => {
  let writtenHeld = null;
  const heldItem = makeItem({
    sourceId: "held-reeval", outlet: "Reuters", geographies: [], headline: "Backlog item",
  });
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-sonnet",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    refreshProfile: "cold_start",
    readHeldFn: async () => [{ ...heldItem, geoCategory: "implicit_geo", geoConfidence: 0.5 }],
    writeHeldFn: async (items) => { writtenHeld = items; },
    beatFitEnabled: false,
  });
  // The held re-eval is a Lane 2 candidate; under cold_start it defers right back
  // to the hold path rather than being assessed this refresh.
  assert.equal(log.geo.geoLane2DeferredCount, 1, "the held re-eval counts as a deferred Lane 2 item");
  assert.equal(log.geo.geoLane2DeferredReason, "profile_defer");
  assert.ok(writtenHeld !== null, "writeHeldFn must be called");
  assert.ok(writtenHeld.some((i) => i.sourceId === "held-reeval"),
    "previously-held re-eval is deferred back to the hold path under cold_start");
});

// ─── Slice 6: Lane 2 throughput prioritization + diagnostics ─────────────────

test("prioritizeLane2Candidates: geo-signal candidates first, then fresh, then fresher, deterministic", () => {
  const items = [
    { sourceId: "stale-backlog", minutesAgo: 500 },          // no signal, not selected
    { sourceId: "signal-backlog", minutesAgo: 400 },          // signal, not selected
    { sourceId: "fresh-nosignal", minutesAgo: 10 },           // no signal, selected
    { sourceId: "signal-fresh-old", minutesAgo: 300 },        // signal, selected
    { sourceId: "signal-fresh-new", minutesAgo: 50 },         // signal, selected
  ];
  const selectedSourceIds = new Set(["fresh-nosignal", "signal-fresh-old", "signal-fresh-new"]);
  const relevantSignalIds = new Set(["signal-backlog", "signal-fresh-old", "signal-fresh-new"]);
  const ordered = prioritizeLane2Candidates(items, { selectedSourceIds, relevantSignalIds }).map((i) => i.sourceId);
  // Signal+fresh first (by minutesAgo), then signal+backlog, then fresh-no-signal,
  // then stale backlog last.
  assert.deepEqual(ordered, [
    "signal-fresh-new",   // signal + selected + freshest
    "signal-fresh-old",   // signal + selected
    "signal-backlog",     // signal, not selected
    "fresh-nosignal",     // no signal, selected
    "stale-backlog",      // no signal, not selected
  ]);
  // Deterministic run-to-run: same input → identical order.
  const again = prioritizeLane2Candidates(items, { selectedSourceIds, relevantSignalIds }).map((i) => i.sourceId);
  assert.deepEqual(again, ordered);
  // Pure: input array is not mutated.
  assert.equal(items[0].sourceId, "stale-backlog");
});

test("runRefreshPipeline: Slice 6 geo diagnostics expose lane processed/deferred + budget used + memo hits", async () => {
  const rawItems = [
    makeItem({ sourceId: "mustsee", outlet: "Reuters", geographies: ["US"] }),
    makeItem({ sourceId: "defer-a", outlet: "Reuters", geographies: [], headline: "Filler one" }),
    makeItem({ sourceId: "defer-b", outlet: "Reuters", geographies: [], headline: "Filler two" }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    geoStageBudgetMs: 0, // force Lane 2 deferral
    beatFitEnabled: false,
  });
  const g = log.geo;
  // Lane 1 always fully processed under tight budget.
  assert.equal(g.geoLane1Processed, 1, "Lane 1 processed to completion even at budget=0");
  assert.equal(g.geoLane1Count, 1);
  // Lane 2 deferred (not dropped) under budget pressure.
  assert.equal(g.geoLane2Processed, 0, "no Lane 2 processed under budget=0");
  assert.equal(g.geoLane2Deferred, 2);
  assert.equal(g.geoLane2DeferredCount, 2, "legacy key retained for back-compat");
  // Budget pair + latency present and consistent.
  assert.equal(g.geoBudgetMsConfigured, 0);
  assert.equal(typeof g.geoBudgetMsUsed, "number");
  assert.equal(typeof g.geoStageLatencyMs, "number");
  assert.equal(g.geoBudgetMsUsed, g.geoStageLatencyMs);
  // Memo dedup ran (lane-split signal reused by the Lane 2 prioritizer).
  assert.equal(typeof g.geoSignalMemoHits, "number");
  assert.ok(g.geoSignalMemoHits >= 1, "Lane 2 prioritization reuses the lane-split geo-signal memo");
});

test("runRefreshPipeline: deterministic cluster-input ordering across identical interactive runs (Slice 6 ordering stability)", async () => {
  const rawItems = [
    makeItem({ sourceId: "a", outlet: "Reuters", geographies: ["US"], minutesAgo: 30 }),
    makeItem({ sourceId: "b", outlet: "Reuters", geographies: [], headline: "US sanctions update", minutesAgo: 20 }),
    makeItem({ sourceId: "c", outlet: "Reuters", geographies: [], headline: "Filler", minutesAgo: 40 }),
  ];
  const run = async () => {
    let clusterOrder = [];
    const { log } = await runRefreshPipeline({
      settings: BASE_SETTINGS,
      rawItems: rawItems.map((i) => ({ ...i })),
      clusterFn: async (items) => { clusterOrder = items.map((it) => it.sourceId); return []; },
      clusterModel: "mock-anthropic-haiku",
      contractVersion: "2026-05-19-meta-story-fields",
      geoAssessFn: async () => ({ confidence: 0.95 }),
      geoStageBudgetMs: 60000,
      beatFitEnabled: false,
      refreshProfile: "interactive",
    });
    return { clusterOrder, geo: log.geo };
  };
  const [r1, r2] = await Promise.all([run(), run()]);
  // Same inputs → identical cluster-input ordering and identical geo
  // diagnostics, proving the Lane 2 prioritization is deterministic run-to-run.
  assert.deepEqual(r1.clusterOrder, r2.clusterOrder);
  assert.equal(r1.geo.geoLane1Count, r2.geo.geoLane1Count);
  assert.equal(r1.geo.geoLane2Deferred, r2.geo.geoLane2Deferred);
  assert.equal(r1.geo.geoAssessedCount, r2.geo.geoAssessedCount);
});

test("buildSourceGroundedWhyFallback: derives a non-empty grounded line from summary + outletCount", () => {
  const grounded = buildSourceGroundedWhyFallback({
    summary: "US and Colombia resumed trade talks. A second sentence follows here.",
    outletCount: 3,
    sources: [],
  });
  assert.ok(grounded && grounded.length > 0);
  assert.match(grounded, /Across 3 sources, /);
  assert.match(grounded, /US and Colombia resumed trade talks\./);
  // Only the first sentence is used (no second-sentence leak).
  assert.doesNotMatch(grounded, /second sentence/);
  // No groundable summary → null (caller falls back to the state template).
  assert.equal(buildSourceGroundedWhyFallback({ summary: "" }), null);
  assert.equal(buildSourceGroundedWhyFallback({}), null);
});

test("enrichWhyItMattersForStories: failed upgrade prefers source-grounded fallback over generic template", async () => {
  const stories = [
    { id: "m1", metaStoryId: "m1", title: "T", subtitle: "s", summary: "Sanctions tightened on key exporters.", whatChanged: "c", outletCount: 2, sources: [], whyItMatters: "old" },
  ];
  const throwingResolver = async () => { throw new Error("writer down"); };
  const { stories: out, diagnostics } = await enrichWhyItMattersForStories({
    stories,
    resolveWhyItMattersFn: throwingResolver,
  });
  assert.equal(diagnostics.upgraded, 0, "resolver failure → not counted as upgraded");
  // Grounded fallback, NOT the generic 'newly entering your monitoring set' template.
  assert.match(out[0].whyItMatters, /Across 2 sources, Sanctions tightened on key exporters\./);
  assert.doesNotMatch(out[0].whyItMatters, /newly entering your monitoring set/);
  assert.notEqual(out[0].whyItMatters, out[0].subtitle, "never a subtitle echo");
});

// ─── A1.2: Lane 1 protected end-to-end through the recall gate ───────────────
//
// The recall gate (`applyTopicKeywordFilter`) is text-driven, so a Lane 1
// must-see item with an EXPLICIT geo tag but no geography *named in its text*
// (and no topic/keyword match) used to be dropped at recall even though it's
// exactly what the user tracks. A1.2 unions such Lane 1 survivors back into the
// recall set. Non-Lane-1 items keep obeying recall.

test("runRefreshPipeline: Lane 1 must-see item survives recall even with no topic/keyword/geo-text match", async () => {
  const seenIds = [];
  const rawItems = [
    // Lane 1: selected source + EXPLICIT geo (US) → must-see. Topic "Sports" is
    // not configured, no keyword, and the text never names a geography → it
    // fails the text-driven recall gate and is only admitted by lane protection.
    makeItem({
      sourceId: "lane1-explicit", outlet: "Reuters", geographies: ["US"],
      topic: "Sports", headline: "Local derby ends in a draw", body: ["Fans cheered."],
    }),
    // Non-Lane-1: implicit geo, no geo signal, same un-matchable topic/text →
    // passes geo (0.85) but must still be dropped by recall (no protection).
    makeItem({
      sourceId: "lane2-norecall", outlet: "Reuters", geographies: [],
      topic: "Sports", headline: "Local derby ends in a draw", body: ["Fans cheered."],
    }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    beatFitEnabled: false, // isolate the recall gate from the relevance gate
  });
  assert.ok(seenIds.includes("lane1-explicit"),
    "Lane 1 must-see item must survive recall and reach clustering");
  assert.ok(!seenIds.includes("lane2-norecall"),
    "non-Lane-1 item with no recall signal must still be dropped by recall");
  assert.equal(log.recall.lane1Protected, 1, "exactly one must-see item was re-admitted past recall");
});

test("runRefreshPipeline: Lane 1 protection is a no-op when the must-see item already passes recall", async () => {
  // Lane 1 item that DOES match a configured topic — recall admits it normally,
  // so protection must not double-count or duplicate it.
  const seenIds = [];
  const rawItems = [
    makeItem({
      sourceId: "lane1-clean", outlet: "Reuters", geographies: ["US"],
      topic: "Diplomatic relations", headline: "Bilateral talks resume",
    }),
  ];
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { seenIds.push(...items.map((i) => i.sourceId)); return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    geoAssessFn: async () => ({ confidence: 0.85 }),
    beatFitEnabled: false,
  });
  assert.deepEqual(seenIds, ["lane1-clean"], "no duplication when recall already admits the item");
  assert.equal(log.recall.lane1Protected, 0, "nothing to re-admit → zero protected");
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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

// ─── Meta-story fields PR (Prompt 1): subtitle vs summary contract ──────────

test("runRefreshPipeline: emitted stories carry subtitle + summary and never the legacy takeaway field", async () => {
  const rawItems = [makeItem({ sourceId: "src-meta-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Story",
      subtitle: "Original LLM subtitle.",
      source_item_ids: ["src-meta-1"],
      summary: "Original LLM summary.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Reuters reports a verified development."],
      claim_evidence_map: { "0": ["src-meta-1"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 1);
  const s = payload.stories[0];
  assert.equal(typeof s.subtitle, "string");
  assert.ok(s.subtitle.length > 0);
  assert.equal(typeof s.summary, "string");
  assert.ok(s.summary.length > 0);
  assert.equal(
    Object.prototype.hasOwnProperty.call(s, "takeaway"),
    false,
    "emitted story shape must not carry the legacy `takeaway` field"
  );
});

test("runRefreshPipeline: ≥2 grounded factual_claims → subtitle ≠ summary (C0 split)", async () => {
  // Regression for the prior J3b behavior where subtitle and summary both
  // collapsed to the first claim.  After the meta-story fields PR, summary
  // joins ALL grounded claims while subtitle stays as the first claim.
  const rawItems = [
    makeItem({ sourceId: "src-c0-a", outlet: "Reuters", minutesAgo: 30 }),
    makeItem({ sourceId: "src-c0-b", outlet: "El Tiempo", minutesAgo: 31 }),
  ];
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [{
      title: "Multi-claim story",
      subtitle: "Original LLM subtitle (will be replaced).",
      source_item_ids: ["src-c0-a", "src-c0-b"],
      summary: "Original LLM summary (will be replaced).",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US", "Colombia"] },
      factual_claims: [
        "Reuters reports the first verified claim.",
        "El Tiempo reports an independently verified second claim.",
      ],
      claim_evidence_map: { "0": ["src-c0-a"], "1": ["src-c0-b"] },
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
  });
  assert.equal(payload.stories.length, 1);
  const s = payload.stories[0];
  assert.equal(s.subtitle, "Reuters reports the first verified claim.");
  assert.ok(
    s.summary.startsWith("Reuters reports the first verified claim."),
    "summary should begin with the first claim"
  );
  assert.ok(
    s.summary.includes("El Tiempo reports an independently verified second claim"),
    "summary should include all grounded claims, not just the first"
  );
  assert.notEqual(
    s.subtitle,
    s.summary,
    "C0: with ≥2 claims, subtitle and summary must differ"
  );
});

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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
  contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    // No structural geo — mockAssessGeoConfidence's 0.85 clears the implicit
    // threshold (0.80) so the item still reaches beat-fit. With no geo bonus
    // and no keyword, the commodity penalty drops it below 0.40 — the
    // D-060-shape negative path.
    geographies: [],
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
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.deepEqual(seenIds.sort(), ["include"], "only the include candidate should reach clustering");
  assert.equal(payload.stories.length, 1);
  assert.equal(log.beatFit.includedCount, 1);
  assert.equal(log.beatFit.excludedCount, 1);
  assert.ok(
    (log.beatFit.excludeReasonHistogram.excluded_commodity_framing ?? 0) >= 1,
    "exclude histogram must record commodity-framing (D-060 removed off-beat penalty)"
  );
});

test("Phase 1 strict-empty: when nothing clears beat-fit, payload.stories is []", async () => {
  // Single commodity-noise item that passes recall (item.topic matches a
  // configured topic) but fails beat-fit — D-060 keeps the commodity penalty.
  // No structural geo so the geo filter accepts via implicit confidence and
  // scoreBeatFit gets no geo bonus, letting commodity drop the score below
  // threshold.
  const offbeat = makeItem({
    sourceId: "x",
    outlet: "The Washington Post — World",
    geographies: [],
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    afterDedupe: 5,
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
    afterDedupe: 5,
    finalStories: 3,
  };
  const s = formatFunnel(funnel);
  assert.match(s, /^normalize=100 → time_window_24h=80 → source_selection=30 → geo_filter=28 → topic_keyword_recall=5 → beat_fit_precision=5 → cross_feed_dedupe=5 → clustering_and_grounding=3$/);
});

test("summarizeFunnel: flags topicKeywordRecallIsNoop when settings have neither topics nor keywords", () => {
  const funnel = {
    totalNormalized: 10, afterTimeWindow: 10, afterSourceSelection: 10,
    afterGeoFilter: 10, afterTopicKeyword: 10, afterBeatFit: 10, afterDedupe: 10, finalStories: 0,
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(log.funnel.afterSourceSelection, 0);
  assert.equal(log.funnel.primaryDropStage, "source_selection");
});

test("runRefreshPipeline: log.funnel.primaryDropStage is beat_fit_precision when recall has items but beat-fit drops them", async () => {
  // Item passes recall (keyword match on "sanctions") but beat-fit drops it:
  // no configured topic in text, no geo overlap, and the commodity-framing
  // penalty pulls the score below 0.40. D-060 removed the off-beat-region
  // penalty; commodity remains the precision filter for this shape.
  const items = [
    makeItem({
      sourceId: "x1",
      outlet: "Reuters",
      topic: "Other",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    beatFitEnabled: false, // keep this test focused on watermark+funnel, not beat-fit
  });
  assert.ok(first.log.watermark);
  const second = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
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
    afterGeoFilter: 10, afterTopicKeyword: 10, afterBeatFit: 10, afterDedupe: 10, finalStories: null,
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(clusterCalled, false);
  assert.equal(log.recall.degraded, true);
  assert.equal(log.recall.degraded_reason, "embedding_unavailable_fail_closed");
  assert.notEqual(log.recall.keywordFallbackAfterEmbeddingFailure, true);
});

test("runRefreshPipeline: zero configured sources → C2 fail-closed at source-selection (M6)", async () => {
  // C2 (M6): a user with no topics/keywords/geos/sources/narrative trips the
  // source-selection gate BEFORE recall.  The pipeline emits zero stories and
  // surfaces `sourceFallbackReason="no_selected_sources"` on selection meta
  // so operators can tell empty-settings apart from a recall cliff.  Recall
  // never runs with profile data here because the candidate pool is empty
  // upstream — E3b's empty-profile path is exercised at the unit level in
  // embedding-recall.test.mjs.
  const item = makeItem({
    sourceId: "kw-only",
    outlet: "Reuters",
    minutesAgo: 30,
    headline: "OFAC ruling",
  });
  const settingsNoProfile = {
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: async () => { embedCalled = true; return []; },
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(payload.stories.length, 0);
  assert.equal(log.selection.sourceSelectionMode, "strict");
  assert.equal(log.selection.sourceFallbackUsed, false);
  assert.equal(log.selection.sourceFallbackReason, "no_selected_sources");
  assert.equal(log.selection.selectedSourceCount, 0);
  // Recall runs with an empty candidate pool — it shouldn't report a degrade
  // (the upstream gate explains the empty), and embedFn must not be called.
  assert.equal(embedCalled, false);
  assert.equal(log.recall.degraded, false);
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

test("analyzeTopicKeywordStage: geoLexicalOnly is its own mutually-exclusive bucket (Slice 2)", async () => {
  const { analyzeTopicKeywordStage } = await import("./refresh-pipeline.mjs");
  const settings = { topics: ["Diplomatic relations"], keywords: ["sanctions"], geographies: ["Colombia"] };
  const items = [
    { topic: "Diplomatic relations", headline: "no kw here", body: [] },              // topicOnly
    { topic: "Other", headline: "Treasury sanctions update", body: [] },              // keywordOnly
    { topic: "Diplomatic relations", headline: "sanctions", body: [] },               // both
    { topic: "Other", headline: "Colombians head to the polls", body: [] },           // geoLexicalOnly
    { topic: "Other", headline: "Local sports", body: [] },                           // neither
    // keyword + geo both fire → counted as keywordOnly (geo only when sole reason)
    { topic: "Other", headline: "Bogotá sanctions ruling", body: [] },                // keywordOnly
  ];
  const b = analyzeTopicKeywordStage(items, settings);
  assert.equal(b.inputCount, 6);
  assert.equal(b.hasGeographies, true);
  assert.equal(b.topicOnly, 1);
  assert.equal(b.keywordOnly, 2);
  assert.equal(b.both, 1);
  assert.equal(b.geoLexicalOnly, 1);
  assert.equal(b.neither, 1);
  // passCount sums every passing bucket (topic+keyword+both+geo).
  assert.equal(b.passCount, 5);
  assert.equal(b.primaryDropCause, null, "at least one item passed");
});

test("analyzeTopicKeywordStage: only geographies configured + no text match → primaryDropCause='no_geo_match'", async () => {
  const { analyzeTopicKeywordStage } = await import("./refresh-pipeline.mjs");
  const items = [{ topic: "Other", headline: "unrelated", body: [] }];
  const b = analyzeTopicKeywordStage(items, { topics: [], keywords: [], geographies: ["Colombia"] });
  assert.equal(b.passCount, 0);
  assert.equal(b.geoLexicalOnly, 0);
  assert.equal(b.primaryDropCause, "no_geo_match");
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    recallConfig: KEYWORD_RECALL_CONFIG,
  });

  const second = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => { clusterCalls++; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
  });
  const story = payload.stories[0];
  assert.equal(story.sources.length, 3, "all 3 source pieces remain on the story");
  assert.equal(story.outletCount, 2, "outletCount must count unique outlets, not rows");
});

test("runRefreshPipeline: outletCount collapses casing/whitespace variants of the same outlet", async () => {
  // Same outlet emitted three ways ("Reuters", "reuters ", "REUTERS") plus one
  // legitimately distinct outlet — pipeline should report outletCount=2.
  //
  // C2 (M6) forbids the older trick of bypassing source filtering with empty
  // source lists.  Each unique item-outlet string is enumerated in
  // `traditionalSources` so all four variants survive source-selection and
  // reach buildStory — this test is about the unique count emitted by
  // buildStory, not about source-selection matching.
  const settings = {
    ...BASE_SETTINGS,
    traditionalSources: ["Reuters", "reuters ", "REUTERS", "El Tiempo"],
    socialSources: [],
  };
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
  //
  // C2 (M6): each unique outlet string (including "" and "   ") is enumerated
  // in `traditionalSources` so all four rows survive source-selection.  The
  // test still pins buildStory's behavior on bad-outlet rows; in production
  // those rows would also fail at source-selection, which is fine — the
  // defense is layered.
  const settings = {
    ...BASE_SETTINGS,
    traditionalSources: ["Reuters", "", "   ", "El Tiempo"],
    socialSources: [],
  };
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
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
  //
  // C2 (M6): the blank/whitespace strings are enumerated in `traditionalSources`
  // so the rows survive source-selection and reach buildStory.  In production
  // these items would be filtered upstream too — defense is layered.
  const settings = {
    ...BASE_SETTINGS,
    traditionalSources: ["", "   "],
    socialSources: [],
  };
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
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
  });
  const story = payload.stories[0];
  assert.equal(story.sources.length, 2);
  assert.equal(
    story.outletCount,
    0,
    "outletCount must be 0 when no source has a non-blank outlet"
  );
});

test("runRefreshPipeline: three sibling-section feeds from one publisher collapse to outletCount=1", async () => {
  // The user-visible payoff of publisher-level outlet labels (spec D1):
  // three Washington Post section feeds (Politics + World + National) feed
  // distinct articles into one meta-story; the collapsed story-card chip
  // must read "1 source", not "3 sources".  By the time items reach the
  // pipeline they already carry publisher-level `outlet` (mapEntry handles
  // the publisher derivation upstream — covered in feed-reader.test.mjs),
  // so this test pins the pipeline's count-collapse contract end-to-end.
  const settings = {
    ...BASE_SETTINGS,
    traditionalSources: ["The Washington Post"],
    socialSources: [],
  };
  const rawItems = [
    makeItem({
      sourceId: "wapo-pol-a",
      outlet: "The Washington Post",
      minutesAgo: 10,
      headline: "OFAC weighs new tools",
      body: ["Politics desk reporting."],
    }),
    makeItem({
      sourceId: "wapo-world-b",
      outlet: "The Washington Post",
      minutesAgo: 20,
      headline: "OFAC reaction across the Atlantic",
      body: ["World desk reporting."],
    }),
    makeItem({
      sourceId: "wapo-natl-c",
      outlet: "The Washington Post",
      minutesAgo: 30,
      headline: "OFAC enforcement memo lands",
      body: ["National desk reporting."],
    }),
  ];
  const metaStory = {
    meta_story_id: "wapo-pub-collapse",
    title: "OFAC coverage",
    subtitle: "Sub.",
    source_item_ids: ["wapo-pol-a", "wapo-world-b", "wapo-natl-c"],
    summary: "Summary.",
    tags: {
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
    },
    factual_claims: [
      "The Washington Post reports: OFAC weighs new tools",
      "The Washington Post reports: OFAC reaction across the Atlantic",
      "The Washington Post reports: OFAC enforcement memo lands",
    ],
    claim_evidence_map: {
      "0": ["wapo-pol-a"],
      "1": ["wapo-world-b"],
      "2": ["wapo-natl-c"],
    },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
  });
  const story = payload.stories[0];
  assert.equal(story.sources.length, 3, "all three articles remain on the story");
  assert.equal(
    story.outletCount,
    1,
    "three section feeds from one publisher must collapse to a single source identity"
  );
  // The user-visible outlet label on each source row carries the publisher
  // brand verbatim — sanity check so a future projection change can't sneak
  // a section name back in.
  for (const s of story.sources) {
    assert.equal(s.outlet, "The Washington Post");
  }
});

// ─── Cross-feed dedupe (meta-story pipeline integration) ─────────────────────
//
// Pinning the strict-match contract for the cross-feed dedupe stage at the
// pipeline boundary so a regression at any earlier seam (clustering input,
// source-id index, story-build projection) is caught here, not just in the
// unit-level source-deduper tests.  Each test captures the clusterFn input
// directly so assertions prove what clustering ACTUALLY saw, rather than
// inferring it from downstream story shape (which can false-pass if
// `source_item_ids` filtering hides a missed merge).

// Small helper used across these tests: a clusterFn that captures the items
// it received into the supplied `capture` object, then echoes them back as a
// single meta-story.  Returns the same shape every time so tests can focus on
// the dedupe assertion (cluster input, log.dedupe, story.sources) without
// worrying about clustering / grounding side effects.
function captureClusterFn(capture, limit = null) {
  return async (clusterInput) => {
    capture.input = clusterInput;
    const ids = limit ? clusterInput.slice(0, limit).map((i) => i.sourceId) : clusterInput.map((i) => i.sourceId);
    return [
      {
        title: "T",
        subtitle: "S",
        source_item_ids: ids,
        summary: "Summary.",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["A claim."],
        claim_evidence_map: { "0": ids },
      },
    ];
  };
}

test("cross-feed dedupe: canonical URL + exact headline + time within window collapses to one cluster input", async () => {
  // Same article surfaces from two different feeds (Washington Post —
  // National + Washington Post — World).  feed-reader hashes feedId into
  // sourceId so we get two distinct sourceItems with the same canonical URL
  // and identical headlines.  With |Δ minutesAgo| = 30 ≤ PUBLISH_WINDOW_MINUTES,
  // the strict rule fires and dedupe must collapse to ONE entry — both in
  // what clustering sees AND on the resulting story.  Outlet "Reuters"
  // matches BASE_SETTINGS.traditionalSources so the test exercises dedupe,
  // not source-pool selection.
  const sharedUrl = "https://www.washingtonpost.com/news/deportation-piece";
  const sharedHeadline =
    "More of the men being deported now have lived in the U.S. for years.";
  const rawItems = [
    makeItem({
      sourceId: "wp-nat-1",
      feedId: "wp-national",
      outlet: "Reuters",
      url: sharedUrl,
      headline: sharedHeadline,
      body: ["Short-form national wire copy."],
      weight: 90,
      minutesAgo: 60,
    }),
    makeItem({
      sourceId: "wp-world-1",
      feedId: "wp-world",
      outlet: "Reuters",
      url: sharedUrl,
      headline: sharedHeadline,
      body: ["A longer, more detailed wire copy with more content text body."],
      weight: 90,
      minutesAgo: 30,
    }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  // Direct proof: clustering received exactly one candidate, and that one
  // candidate was the tie-break winner (richer evidence → wp-world-1).
  assert.equal(capture.input.length, 1, "clusterFn must observe a deduped pool of size 1");
  assert.equal(
    capture.input[0].sourceId,
    "wp-world-1",
    "winner must be the item with richer body (evidence richness tie-break)"
  );
  // Downstream story shape confirms the same.
  const story = payload.stories[0];
  assert.equal(story.sources.length, 1);
  assert.equal(story.sources[0].id, "wp-world-1");
  // Funnel + dedupe diagnostics report exact counts.
  assert.equal(log.dedupe.inputCount, 2);
  assert.equal(log.dedupe.uniqueCount, 1);
  assert.equal(log.dedupe.collapsedCount, 1);
  assert.equal(log.funnel.afterBeatFit, 2, "beat-fit count is the pre-dedupe candidate pool");
  assert.equal(log.funnel.afterDedupe, 1, "afterDedupe count reflects unique articles");
});

test("cross-feed dedupe: canonical URL match but headline mismatch does NOT merge", async () => {
  // Same URL reused to host two distinct pieces.  Strict policy: URL alone
  // is not enough.  Cluster input MUST carry both items, story MUST list
  // both sources, dedupe diagnostic MUST report zero collapses.
  const sharedUrl = "https://example.com/url-recycle";
  const rawItems = [
    makeItem({
      sourceId: "piece-a",
      feedId: "f-a",
      outlet: "Reuters",
      url: sharedUrl,
      headline: "Trump and Petro discuss tariffs",
      minutesAgo: 20,
    }),
    makeItem({
      sourceId: "piece-b",
      feedId: "f-b",
      outlet: "Reuters",
      url: sharedUrl,
      headline: "Different article entirely",
      minutesAgo: 22,
    }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.equal(capture.input.length, 2, "headline mismatch must keep both candidates");
  const inputIds = new Set(capture.input.map((i) => i.sourceId));
  assert.ok(inputIds.has("piece-a") && inputIds.has("piece-b"));
  assert.equal(log.dedupe.collapsedCount, 0, "headline mismatch must not collapse");
  assert.equal(log.dedupe.uniqueCount, 2);
  assert.equal(log.funnel.afterDedupe, 2);
  assert.equal(payload.stories[0].sources.length, 2);
});

test("cross-feed dedupe: canonical URL + headline match but |Δ minutesAgo| > PUBLISH_WINDOW_MINUTES does NOT merge", async () => {
  // Time-window guard: same URL + same headline at very different times
  // implies a long-delayed republish or URL recycle — not same-tick
  // syndication.  Cluster input must see both items.
  const sharedUrl = "https://example.com/republished";
  const sharedHeadline = "Shared headline text";
  const rawItems = [
    makeItem({
      sourceId: "early",
      feedId: "f-early",
      outlet: "Reuters",
      url: sharedUrl,
      headline: sharedHeadline,
      minutesAgo: 10,
    }),
    makeItem({
      sourceId: "late",
      feedId: "f-late",
      outlet: "Reuters",
      url: sharedUrl,
      headline: sharedHeadline,
      minutesAgo: 10 + PUBLISH_WINDOW_MINUTES + 30,
    }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.equal(capture.input.length, 2, "items outside the time window must stay distinct");
  assert.equal(log.dedupe.collapsedCount, 0);
  assert.equal(log.dedupe.uniqueCount, 2);
  assert.equal(payload.stories[0].sources.length, 2);
});

test("cross-feed dedupe: similar headlines but different URLs do NOT merge", async () => {
  // Conservative match: a shared headline across different canonical URLs is
  // not enough to merge.  Direct proof via captured cluster input.
  const sharedHeadline =
    "More of the men being deported now have lived in the U.S. for years.";
  const rawItems = [
    makeItem({
      sourceId: "a",
      feedId: "f-a",
      outlet: "Reuters",
      url: "https://outlet-a.example.com/story-1",
      headline: sharedHeadline,
    }),
    makeItem({
      sourceId: "b",
      feedId: "f-b",
      outlet: "Reuters",
      url: "https://outlet-b.example.com/story-2",
      headline: sharedHeadline,
    }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(capture.input.length, 2);
  assert.equal(log.dedupe.collapsedCount, 0, "different URLs must not merge");
  assert.equal(payload.stories[0].sources.length, 2);
});

test("cross-feed dedupe: no-URL items merge on exact normalized headline", async () => {
  // No-URL path: per policy, two items with no parsable URL merge if their
  // normalized headlines are exactly equal (case / punctuation / whitespace
  // variants collapse to the same key via normalizeHeadline).  url="" is the
  // pipeline-level no-URL shape; canonicalizeUrl returns null for it.
  const rawItems = [
    makeItem({
      sourceId: "wireless-a",
      feedId: "f-a",
      outlet: "Reuters",
      url: "",
      headline: "  Petro’s response to tariffs!  ",
      body: ["short copy"],
      byline: "",
      minutesAgo: 20,
    }),
    makeItem({
      sourceId: "wireless-b",
      feedId: "f-b",
      outlet: "Reuters",
      url: "",
      headline: "Petro's response to tariffs",
      body: ["a much longer body wins evidence richness"],
      byline: "Reporter Two",
      minutesAgo: 25,
    }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(capture.input.length, 1, "no-URL exact-headline duplicates must collapse to one");
  assert.equal(
    capture.input[0].sourceId,
    "wireless-b",
    "winner must be the richer-evidence item under the tie-break order"
  );
  assert.equal(log.dedupe.collapsedCount, 1);
  assert.equal(log.dedupe.uniqueCount, 1);
  assert.equal(payload.stories[0].sources.length, 1);
});

test("cross-feed dedupe: deterministic winner under the strict tie-break order", async () => {
  // Three items share canonical URL + headline + |Δt| ≤ window → one cluster.
  // Tie-break order: evidence → freshness → weight → feedId lex → sourceId lex.
  // Construct items so the resolution is unambiguous and verifiable per step:
  //   - "loser-thin": thin body, fresher, higher weight  →  loses on evidence.
  //   - "rich-older": rich body, older                   →  beats thin on evidence.
  //   - "rich-fresh": same rich body, fresher            →  beats rich-older on freshness.
  const sharedUrl = "https://example.com/tiebreak";
  const richBody = ["a substantially longer body that wins the evidence richness check decisively"];
  const rawItems = [
    makeItem({
      sourceId: "loser-thin",
      feedId: "f-thin",
      outlet: "Reuters",
      url: sharedUrl,
      body: ["short"],
      byline: "",
      minutesAgo: 5,
      weight: 99,
    }),
    makeItem({
      sourceId: "rich-older",
      feedId: "f-older",
      outlet: "Reuters",
      url: sharedUrl,
      body: richBody,
      byline: "",
      minutesAgo: 40,
      weight: 50,
    }),
    makeItem({
      sourceId: "rich-fresh",
      feedId: "f-fresh",
      outlet: "Reuters",
      url: sharedUrl,
      body: richBody,
      byline: "",
      minutesAgo: 20,
      weight: 50,
    }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.equal(capture.input.length, 1);
  assert.equal(
    capture.input[0].sourceId,
    "rich-fresh",
    "tie-break: rich body beats thin (evidence); among ties, fresher wins (freshness)"
  );
  assert.equal(log.dedupe.collapsedCount, 2);
  assert.equal(payload.stories[0].sources[0].id, "rich-fresh");
});

test("cross-feed dedupe: same input across runs picks the same canonical winner (idempotence)", async () => {
  const sharedUrl = "https://example.com/idempotent";
  const rawItems = [
    makeItem({
      sourceId: "loser",
      feedId: "f-old",
      outlet: "Reuters",
      url: sharedUrl,
      minutesAgo: 25,
      body: ["thin"],
      byline: "",
    }),
    makeItem({
      sourceId: "winner",
      feedId: "f-fresh",
      outlet: "Reuters",
      url: sharedUrl,
      minutesAgo: 10,
      body: ["a longer body wins evidence richness handily"],
      byline: "Named Reporter",
    }),
  ];
  const cap1 = {};
  const cap2 = {};
  const opts1 = {
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(cap1),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  };
  const opts2 = { ...opts1, clusterFn: captureClusterFn(cap2) };
  const { payload: run1 } = await runRefreshPipeline(opts1);
  const { payload: run2 } = await runRefreshPipeline(opts2);
  assert.equal(cap1.input.length, 1);
  assert.equal(cap2.input.length, 1);
  assert.equal(cap1.input[0].sourceId, "winner");
  assert.equal(cap2.input[0].sourceId, "winner");
  assert.equal(run1.stories[0].sources[0].id, "winner");
  assert.equal(run2.stories[0].sources[0].id, "winner");
});

test("cross-feed dedupe: denominator-driving semantics — sources.length reflects deduped universe", async () => {
  // 9 distinct articles + 1 cross-feed duplicate of unique-3.  Strict-mode
  // dedupe must produce exactly 9 unique candidates.  We assert directly on:
  //   (a) the cluster-input length (== 9)
  //   (b) the duplicate's sourceId never appearing in clustering or payload
  //   (c) the dedupe log diagnostic (1 collapse, 9 unique)
  // and avoid an indirect "≤9" inequality that could false-pass.
  const items = [];
  for (let i = 0; i < 9; i++) {
    items.push(
      makeItem({
        sourceId: `unique-${i}`,
        feedId: `feed-${i}`,
        outlet: "Reuters",
        url: `https://example.com/article-${i}`,
        weight: 85,
        minutesAgo: 30 + i,
      })
    );
  }
  // Cross-feed duplicate of unique-3 — same URL, same default headline
  // ("Test Headline"), minutesAgo within PUBLISH_WINDOW_MINUTES of unique-3.
  items.push(
    makeItem({
      sourceId: "dup-of-3",
      feedId: "feed-3-mirror",
      outlet: "Reuters",
      url: "https://example.com/article-3",
      weight: 85,
      minutesAgo: 35,
    })
  );

  const capture = {};
  // Cap clustering output at 5 source_item_ids so we hit the schema bound,
  // but the assertion of interest is the FULL cluster input length.
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: captureClusterFn(capture, 5),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.equal(
    capture.input.length,
    9,
    "clusterFn must see exactly 9 unique candidates (10 raw - 1 collapsed)"
  );
  const inputIds = new Set(capture.input.map((i) => i.sourceId));
  assert.equal(
    inputIds.has("dup-of-3"),
    false,
    "the loser sourceId must not survive into clustering"
  );
  assert.ok(inputIds.has("unique-3"), "winner of the dup group must be unique-3 (fresher)");
  assert.equal(log.dedupe.inputCount, 10);
  assert.equal(log.dedupe.uniqueCount, 9);
  assert.equal(log.dedupe.collapsedCount, 1);
  assert.equal(log.funnel.afterBeatFit, 10);
  assert.equal(log.funnel.afterDedupe, 9);

  // Payload-level confirmation: the duplicate sourceId is also absent from
  // the response.  The story took the first 5 deduped items per clusterFn cap.
  const allSourceIds = new Set(
    payload.stories.flatMap((s) => s.sources.map((src) => src.id))
  );
  assert.equal(allSourceIds.has("dup-of-3"), false);
  assert.equal(payload.stories[0].sources.length, 5);
});

test("cross-feed dedupe: response payload never exposes internal _duplicates / _canonicalUrl / _normHeadline", async () => {
  const sharedUrl = "https://example.com/shared-article";
  const rawItems = [
    makeItem({ sourceId: "a", feedId: "f-a", outlet: "Reuters", url: sharedUrl, minutesAgo: 10 }),
    makeItem({ sourceId: "b", feedId: "f-b", outlet: "Reuters", url: sharedUrl, minutesAgo: 12 }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  // Sanity: dedupe ran and collapsed the pair (otherwise the no-leak assertion
  // is trivial because no winner carried provenance to begin with).
  assert.equal(log.dedupe.collapsedCount, 1);
  let checked = 0;
  for (const story of payload.stories) {
    for (const src of story.sources) {
      checked++;
      assert.equal(
        Object.prototype.hasOwnProperty.call(src, "_duplicates"),
        false,
        "_duplicates is internal-only and must never reach the response payload"
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(src, "_canonicalUrl"),
        false,
        "internal _canonicalUrl annotation must never reach the response payload"
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(src, "_normHeadline"),
        false,
        "internal _normHeadline annotation must never reach the response payload"
      );
    }
  }
  assert.ok(checked > 0, "at least one source must be checked for leakage");
});

test("cross-feed dedupe: stage runs before clustering — clusterFn sees deduped universe, source_item_ids resolve", async () => {
  // Defensive check that dedupe sits ahead of clustering AND that the
  // grounding source-id index is built from the same deduped set, so the
  // story buildStory step can resolve every id without falling back to
  // partial-source fallbacks (which would expose a stage-order bug).
  const sharedUrl = "https://example.com/order-check";
  const rawItems = [
    makeItem({
      sourceId: "dup-loser",
      feedId: "f-loser",
      outlet: "Reuters",
      url: sharedUrl,
      minutesAgo: 25,
      body: ["thin"],
      byline: "",
    }),
    makeItem({
      sourceId: "dup-winner",
      feedId: "f-winner",
      outlet: "Reuters",
      url: sharedUrl,
      minutesAgo: 10,
      body: ["a long body that takes the evidence-richness tie-break"],
      byline: "Reporter",
    }),
    makeItem({
      sourceId: "solo",
      feedId: "f-solo",
      outlet: "Reuters",
      url: "https://example.com/standalone",
      minutesAgo: 15,
    }),
  ];
  const capture = {};
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  // Cluster saw exactly the two deduped survivors.
  assert.equal(capture.input.length, 2);
  const inputIds = capture.input.map((i) => i.sourceId).sort();
  assert.deepEqual(inputIds, ["dup-winner", "solo"]);
  // The story carries both ids — meaning the source-id index built downstream
  // resolved every id from the same deduped universe (no missing-id drops).
  const storyIds = payload.stories[0].sources.map((s) => s.id).sort();
  assert.deepEqual(storyIds, ["dup-winner", "solo"]);
  assert.equal(log.dedupe.collapsedCount, 1);
});

// ─── M6b: T1 + R1 ordering ────────────────────────────────────────────────────
//
// Server-canonical ordering for the response payload.  Both comparators are
// pure functions over plain values so callers can sort either the raw source
// items (T1, pre-projection) or pre-computed sort keys (R1).  Tests pin every
// tie level so a future re-implementation can't quietly drop a tie-breaker.

// T1: comparator over source items (weight DESC, minutesAgo ASC, sourceId ASC)
test("compareSourcesT1: orders by weight DESC first", () => {
  const items = [
    { sourceId: "a", weight: 50, minutesAgo: 30 },
    { sourceId: "b", weight: 90, minutesAgo: 30 },
    { sourceId: "c", weight: 70, minutesAgo: 30 },
  ];
  const sorted = items.slice().sort(compareSourcesT1);
  assert.deepEqual(sorted.map((i) => i.sourceId), ["b", "c", "a"]);
});

test("compareSourcesT1: breaks weight ties by minutesAgo ASC (freshest wins)", () => {
  const items = [
    { sourceId: "a", weight: 80, minutesAgo: 120 },
    { sourceId: "b", weight: 80, minutesAgo: 10 },
    { sourceId: "c", weight: 80, minutesAgo: 60 },
  ];
  const sorted = items.slice().sort(compareSourcesT1);
  assert.deepEqual(sorted.map((i) => i.sourceId), ["b", "c", "a"]);
});

test("compareSourcesT1: breaks weight+minutesAgo ties by sourceId ASC (stable)", () => {
  const items = [
    { sourceId: "src-c", weight: 80, minutesAgo: 30 },
    { sourceId: "src-a", weight: 80, minutesAgo: 30 },
    { sourceId: "src-b", weight: 80, minutesAgo: 30 },
  ];
  const sorted = items.slice().sort(compareSourcesT1);
  assert.deepEqual(sorted.map((i) => i.sourceId), ["src-a", "src-b", "src-c"]);
});

test("compareSourcesT1: missing weight/minutesAgo coerce to safe defaults (0 / +Inf)", () => {
  const items = [
    { sourceId: "no-weight", minutesAgo: 30 },           // weight defaulted to 0
    { sourceId: "no-min", weight: 80 },                  // minutesAgo defaulted to +Inf
    { sourceId: "fresh", weight: 80, minutesAgo: 10 },
  ];
  const sorted = items.slice().sort(compareSourcesT1);
  // weight 80 wins; among weight-80, fresh (10) < no-min (+Inf); no-weight (0) sinks last.
  assert.deepEqual(sorted.map((i) => i.sourceId), ["fresh", "no-min", "no-weight"]);
});

test("runRefreshPipeline: T1 applied — story.sources[] sorted by weight/minutesAgo/sourceId", async () => {
  // All four source items reach the same meta-story; the pipeline must emit
  // them in T1 order in the response.  Weights chosen to make the canonical
  // order non-trivially different from input order, with two pairs sharing
  // weight to exercise the minutesAgo tie-breaker, and one fully-equal pair
  // to exercise the sourceId tie-breaker.
  const rawItems = [
    makeItem({ sourceId: "src-z", outlet: "Reuters", weight: 80, minutesAgo: 40, headline: "OFAC update one" }),
    makeItem({ sourceId: "src-a", outlet: "Reuters", weight: 80, minutesAgo: 40, headline: "OFAC update two" }),
    makeItem({ sourceId: "src-b", outlet: "Reuters", weight: 95, minutesAgo: 60, headline: "OFAC update three" }),
    makeItem({ sourceId: "src-c", outlet: "Reuters", weight: 80, minutesAgo: 10, headline: "OFAC update four" }),
  ];
  const metaStory = {
    meta_story_id: "ms-t1",
    title: "T1 sort coverage",
    subtitle: "Sub.",
    source_item_ids: ["src-z", "src-a", "src-b", "src-c"],
    summary: "Summary.",
    tags: { topics: ["Diplomatic relations"], keywords: ["OFAC"], geographies: ["US"] },
    factual_claims: ["Reuters reports OFAC."],
    claim_evidence_map: { "0": ["src-z", "src-a", "src-b", "src-c"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  const ids = payload.stories[0].sources.map((s) => s.id);
  // Expected order:
  //   1. src-b (weight 95)
  //   2. src-c (weight 80, minutesAgo 10 — freshest)
  //   3. src-a (weight 80, minutesAgo 40; ties src-z on minutesAgo → ASC sourceId)
  //   4. src-z (weight 80, minutesAgo 40; loses sourceId tie-break)
  assert.deepEqual(ids, ["src-b", "src-c", "src-a", "src-z"]);
});

// R1: comparator over sort keys (maxBeatFitScore DESC, minMinutesAgo ASC, metaStoryId ASC)
test("compareStoriesR1: orders by maxBeatFitScore DESC first", () => {
  const keys = [
    { maxBeatFitScore: 0.4, minMinutesAgo: 10, metaStoryId: "ms-a" },
    { maxBeatFitScore: 0.9, minMinutesAgo: 10, metaStoryId: "ms-b" },
    { maxBeatFitScore: 0.7, minMinutesAgo: 10, metaStoryId: "ms-c" },
  ];
  const sorted = keys.slice().sort(compareStoriesR1);
  assert.deepEqual(sorted.map((k) => k.metaStoryId), ["ms-b", "ms-c", "ms-a"]);
});

test("compareStoriesR1: breaks beat-fit ties by minMinutesAgo ASC (freshest wins)", () => {
  const keys = [
    { maxBeatFitScore: 0.8, minMinutesAgo: 120, metaStoryId: "ms-a" },
    { maxBeatFitScore: 0.8, minMinutesAgo: 5, metaStoryId: "ms-b" },
    { maxBeatFitScore: 0.8, minMinutesAgo: 60, metaStoryId: "ms-c" },
  ];
  const sorted = keys.slice().sort(compareStoriesR1);
  assert.deepEqual(sorted.map((k) => k.metaStoryId), ["ms-b", "ms-c", "ms-a"]);
});

test("compareStoriesR1: breaks beat-fit+freshness ties by metaStoryId ASC (stable)", () => {
  const keys = [
    { maxBeatFitScore: 0.8, minMinutesAgo: 30, metaStoryId: "ms-c" },
    { maxBeatFitScore: 0.8, minMinutesAgo: 30, metaStoryId: "ms-a" },
    { maxBeatFitScore: 0.8, minMinutesAgo: 30, metaStoryId: "ms-b" },
  ];
  const sorted = keys.slice().sort(compareStoriesR1);
  assert.deepEqual(sorted.map((k) => k.metaStoryId), ["ms-a", "ms-b", "ms-c"]);
});

test("runRefreshPipeline: R1 applied — stories[] sorted by max beatFitScore / min minutesAgo / metaStoryId", async () => {
  // Construct three meta-stories whose member items have known beatFitScores
  // (assigned via the real beat-fit scorer by tuning topic/keyword overlap).
  // Goal: assert R1 ordering at the payload boundary.  We pin a permissive
  // beat-fit threshold via opts so the strict-empty branch doesn't fire when
  // a fixture item lands below the production cut-off.
  //
  // Simpler approach: bypass the score plumbing and inject beatFitScore via
  // a custom clusterFn that ALSO mutates the input items.  But the canonical
  // pipeline path doesn't expose that knob — instead, exercise R1 by
  // crafting items whose real beat-fit scores happen to land in the order
  // we want.  We rely on `compareStoriesR1` unit coverage above to pin the
  // comparator's tie-break behavior; this pipeline-level test pins the wiring.
  const settings = {
    ...BASE_SETTINGS,
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
  };
  const rawItems = [
    // ms-low: cold beat-fit (different topic, no keyword)
    makeItem({ sourceId: "low-1", outlet: "Reuters", weight: 70, minutesAgo: 5, topic: "Migration policy", headline: "Migration update", body: ["Body."] }),
    // ms-mid: matches topic only
    makeItem({ sourceId: "mid-1", outlet: "Reuters", weight: 70, minutesAgo: 60, topic: "Diplomatic relations", headline: "Talks resume", body: ["Body."] }),
    // ms-hi: matches topic AND keyword AND geo — best fit
    makeItem({ sourceId: "hi-1", outlet: "Reuters", weight: 70, minutesAgo: 120, topic: "Diplomatic relations", geographies: ["US"], headline: "OFAC ruling tightens", body: ["OFAC sanctions update."] }),
  ];
  const clusterFn = async (items) => {
    // Echo each item back as its own meta-story so the R1 sort has real
    // beat-fit scores from the production scorer to rank.
    return items.map((item, idx) => ({
      meta_story_id: `ms-${item.sourceId}`,
      title: `Story for ${item.sourceId}`,
      subtitle: "Sub.",
      source_item_ids: [item.sourceId],
      summary: "Summary.",
      tags: { topics: [item.topic], keywords: [], geographies: item.geographies },
      factual_claims: [`${item.outlet} reports: ${item.headline}`],
      claim_evidence_map: { "0": [item.sourceId] },
    }));
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  // `hi-1` has the strongest topic+keyword+geo match → highest beat-fit;
  // it must lead even though it's the OLDEST (R1 prioritizes beat-fit over
  // freshness).  `mid-1` and `low-1` may or may not survive beat-fit
  // depending on threshold — assert only that `hi-1` is first if present.
  assert.ok(payload.stories.length >= 1);
  assert.equal(payload.stories[0].metaStoryId, "ms-hi-1",
    `expected ms-hi-1 first (best beat-fit), got order: ${payload.stories.map((s) => s.metaStoryId).join(", ")}`);
});

test("runRefreshPipeline: R1 stable tie-break by metaStoryId when beat-fit + freshness tie", async () => {
  // Three items with identical topic/keyword/geo profiles + identical
  // minutesAgo → same beat-fit score, same freshness.  R1 must order by
  // metaStoryId ASC ("ms-a" < "ms-b" < "ms-c").  Input order is shuffled so
  // a stable-but-non-deterministic implementation would fail this test.
  const settings = {
    ...BASE_SETTINGS,
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
  };
  const rawItems = [
    makeItem({ sourceId: "src-c", outlet: "Reuters", weight: 70, minutesAgo: 30, topic: "Diplomatic relations", geographies: ["US"], headline: "OFAC update C", body: ["OFAC."] }),
    makeItem({ sourceId: "src-a", outlet: "Reuters", weight: 70, minutesAgo: 30, topic: "Diplomatic relations", geographies: ["US"], headline: "OFAC update A", body: ["OFAC."] }),
    makeItem({ sourceId: "src-b", outlet: "Reuters", weight: 70, minutesAgo: 30, topic: "Diplomatic relations", geographies: ["US"], headline: "OFAC update B", body: ["OFAC."] }),
  ];
  const clusterFn = async (items) => items.map((item) => ({
    meta_story_id: `ms-${item.sourceId.slice(-1)}`, // "ms-a" / "ms-b" / "ms-c"
    title: `Story ${item.sourceId}`,
    subtitle: "Sub.",
    source_item_ids: [item.sourceId],
    summary: "Summary.",
    tags: { topics: [item.topic], keywords: ["OFAC"], geographies: item.geographies },
    factual_claims: [`${item.outlet} reports: ${item.headline}`],
    claim_evidence_map: { "0": [item.sourceId] },
  }));
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  // Each item is identical for beat-fit/freshness purposes; expect lexicographic
  // metaStoryId order regardless of input order.
  assert.deepEqual(
    payload.stories.map((s) => s.metaStoryId),
    ["ms-a", "ms-b", "ms-c"]
  );
});

// ─── Phase 3: lexical whole-word policy preservation (regression guards) ─────
//
// Q6 locks lexical recall to whole-word matching (`\b<token>\b`).  Phase 1's
// extractor hygiene changes (open-vocab + Unicode-safe junk filter) and
// Phase 2's manual-refresh trigger do NOT touch the recall regex.  These
// tests pin the contract end-to-end so a future refactor that converts to
// substring matching trips loudly.

test("applyTopicKeywordFilter: whole-word match excludes substring hits (Q6 lexical baseline)", () => {
  const settings = { topics: [], keywords: ["OFAC"] };
  const items = [
    makeItem({ sourceId: "match", headline: "OFAC ruling" }),
    // "ofacility" contains "ofac" but must NOT match under \b<token>\b.
    makeItem({ sourceId: "no-match", headline: "Acme Ofacility ribbon-cutting" }),
  ];
  const passed = applyTopicKeywordFilter(items, settings);
  assert.deepEqual(passed.map((i) => i.sourceId), ["match"]);
});

test("applyTopicKeywordFilter: case-insensitive whole-word (OFAC matches 'ofac' inside text)", () => {
  const settings = { topics: [], keywords: ["OFAC"] };
  const passed = applyTopicKeywordFilter(
    [makeItem({ sourceId: "x", headline: "treasury ofac announced new sanctions" })],
    settings
  );
  assert.equal(passed.length, 1);
});

test("applyTopicKeywordFilter: multi-word keyword treated as a contiguous phrase", () => {
  // Phase 1 / Q6 baseline: multi-word entries match as phrases under
  // `\b<exact phrase>\b`, not as independent word ORs.  "organized crime"
  // matches the phrase but NOT "organized" alone, and NOT "crime" alone.
  const settings = { topics: [], keywords: ["organized crime"] };
  const items = [
    makeItem({ sourceId: "phrase", headline: "Organized crime crackdown widens" }),
    makeItem({ sourceId: "first-word-only", headline: "Organized labor talks" }),
    makeItem({ sourceId: "second-word-only", headline: "Local crime stats released" }),
  ];
  const passed = applyTopicKeywordFilter(items, settings);
  assert.deepEqual(passed.map((i) => i.sourceId), ["phrase"]);
});

test("applyTopicKeywordFilter: keyword-only matching surfaces items even when item.topic is empty", () => {
  // RSS items often arrive with an empty `topic` field — recall must rely on
  // the keyword regex.  Mirrors the WaPo Iran/oil regression at the recall
  // module's level, but pinned here so the pipeline keyword gate stays honest
  // independently.
  const settings = { topics: ["Migration policy"], keywords: ["petroleum"] };
  const passed = applyTopicKeywordFilter(
    [makeItem({ sourceId: "lex-only", topic: "", headline: "Petroleum trade rerouted across the Gulf" })],
    settings
  );
  assert.equal(passed.length, 1);
  assert.equal(passed[0].sourceId, "lex-only");
});

// ─── Phase 3: log.recall coherence with funnel afterTopicKeyword ─────────────

test("runRefreshPipeline: log.funnel.afterTopicKeyword === log.recall.finalRelevant (post-union invariant)", async () => {
  // The funnel field is the legacy `afterTopicKeyword` name, but its value is
  // the POST-RECALL-STAGE count (lexical-or-union).  Pin the invariant so a
  // future refactor that re-introduces a separate post-lexical stage trips
  // here and forces an explicit decision rather than silently double-counting.
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
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(log.funnel.afterTopicKeyword, log.recall.finalRelevant);
});

test("runRefreshPipeline: log.recall.profileAxes surfaces on full-run hybrid_strict", async () => {
  // Phase 3 observability: every refresh emits the profile-axis count so
  // operators reading `_meta.recall` can tell "thin profile" apart from
  // "embedding cliff" without having to inspect raw settings.
  const item = makeItem({
    sourceId: "x",
    outlet: "Reuters",
    minutesAgo: 30,
    headline: "OFAC update on US Colombia",
    topic: "Diplomatic relations",
    geographies: ["US"],
  });
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS, // 4 axes contribute (topics/keywords/geographies/sources)
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  assert.equal(log.recall.profileAxes, 4);
  assert.deepEqual(log.recall.profileAxisNames, ["topics", "keywords", "geographies", "sources"]);
  assert.ok(log.recall.profileTextLength > 0);
});

test("runRefreshPipeline: log.recall.profileAxes surfaces on keyword-mode bypass too (no diagnostic shrink on mode toggle)", async () => {
  const item = makeItem({
    sourceId: "kw",
    outlet: "Reuters",
    minutesAgo: 30,
    headline: "OFAC ruling",
  });
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: async () => [],
    recallConfig: KEYWORD_RECALL_CONFIG,
  });
  assert.equal(log.recall.mode, "keyword");
  // Keyword mode skips the embedder, but still reports profile sparseness so
  // `_meta.recall` shape is uniform across modes.
  assert.equal(log.recall.profileAxes, 4);
});

test("runRefreshPipeline: hybrid_strict + sparse multi-axis profile → runs, no degrade, profileAxes=2", async () => {
  // Sparse profile is observability-only — the recall stage MUST still run
  // semantic widen, MUST NOT flip `degraded`, and MUST surface profileAxes
  // so operators can see the sparseness signature on `_meta.recall`.
  const item = makeItem({
    sourceId: "kw-hit",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Diplomatic relations",
    headline: "Reuters US sanctions update",
    geographies: ["US"],
  });
  const sparseSettings = {
    ...BASE_SETTINGS,
    topics: [],
    keywords: ["sanctions"], // one-axis lexical so recall still has hits
    geographies: [],
    traditionalSources: ["Reuters"],
  };
  const { log } = await runRefreshPipeline({
    settings: sparseSettings,
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
  });
  // Two axes contribute (keywords + sources), so we pin this sparse
  // multi-axis signature explicitly.
  assert.equal(log.recall.profileAxes, 2);
  assert.equal(log.recall.degraded, false);
  assert.equal(log.recall.degraded_reason, null);
});

// ─── Phase 2: lightweight decision trace ─────────────────────────────────────
//
// log.decisionTrace is a compact, backend-only diagnostics object: stage
// counts mirror the funnel, beatFit mirrors the scorer summary (including the
// rescue counters), and sampleExclusions is a capped list of {sourceId,
// stage, excludeReason, inRescueBand, rescueBlockedBy, score}. Never carries
// source bodies or large text — safe for log scrapes and _meta payloads.

test("decisionTrace: full-run log carries stageCounts, beatFit details, and a sample array", async () => {
  // One include item that clears beat-fit; one off-beat item that fails the
  // gate. Tests the happy-path shape on a representative mixed run.
  const include = makeItem({
    sourceId: "include",
    outlet: "The Washington Post — World",
    geographies: ["US"],
    topic: "Diplomatic relations",
    headline: "U.S. strikes two Iranian-flagged tankers as tensions continue amid ceasefire",
    body: ["WASHINGTON — The Pentagon confirmed two strikes."],
    minutesAgo: 30,
  });
  const exclude = makeItem({
    sourceId: "exclude",
    outlet: "The Washington Post — World",
    geographies: ["US"],
    topic: "Migration policy",
    headline: "Iran war is crushing Asia's farmers, threatening global food supply",
    body: ["Wheat and grain prices have surged across Asia."],
    minutesAgo: 30,
  });
  const { log } = await runRefreshPipeline({
    settings: PHASE1_SETTINGS,
    rawItems: [include, exclude],
    clusterFn: async (items) =>
      items.map((i) => ({
        title: "T",
        subtitle: "S",
        source_item_ids: [i.sourceId],
        summary: "x",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["A claim."],
        claim_evidence_map: { "0": [i.sourceId] },
      })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.ok(log.decisionTrace, "full-run log must carry decisionTrace");
  const trace = log.decisionTrace;

  // stageCounts mirrors the funnel inputs (and stays in sync with it).
  assert.equal(typeof trace.stageCounts, "object");
  assert.equal(trace.stageCounts.totalNormalized, log.funnel.totalNormalized);
  assert.equal(trace.stageCounts.afterTopicKeyword, log.funnel.afterTopicKeyword);
  assert.equal(trace.stageCounts.afterBeatFit, log.funnel.afterBeatFit);
  assert.equal(trace.stageCounts.finalStories, log.funnel.finalStories);

  // beatFit mirrors the scorer summary (incl. rescue counters added in P1 +
  // the D-059 / D-062 path-split counters added in P4).
  assert.equal(typeof trace.beatFit.threshold, "number");
  assert.equal(typeof trace.beatFit.includedCount, "number");
  assert.equal(typeof trace.beatFit.excludedCount, "number");
  assert.equal(typeof trace.beatFit.rescuedCount, "number");
  assert.equal(typeof trace.beatFit.rescuedBorderlineCount, "number");
  assert.equal(typeof trace.beatFit.rescuedSemanticGeoCount, "number");
  assert.equal(typeof trace.beatFit.rescueBlockedPenaltyCount, "number");
  assert.equal(typeof trace.beatFit.rescueBlockedInsufficientSignalsCount, "number");
  assert.equal(typeof trace.beatFit.rescueBlockedGeoGateCount, "number");
  assert.equal(typeof trace.beatFit.rescueBlockedWeakSemanticCount, "number");
  assert.equal(typeof trace.beatFit.semanticGeoRescueMin, "number");
  assert.equal(typeof trace.beatFit.excludeReasonHistogram, "object");

  // sampleExclusions is an array; entries (if any) carry the documented shape.
  assert.ok(Array.isArray(trace.sampleExclusions));
  if (trace.sampleExclusions.length > 0) {
    const sample = trace.sampleExclusions[0];
    assert.equal(sample.stage, "beat_fit");
    assert.equal(typeof sample.sourceId, "string");
    assert.equal(typeof sample.excludeReason, "string");
    assert.equal(typeof sample.inRescueBand, "boolean");
    assert.ok(
      sample.rescueBlockedBy === null ||
        sample.rescueBlockedBy === "penalty" ||
        sample.rescueBlockedBy === "insufficient_signals" ||
        sample.rescueBlockedBy === "geo_gate" ||
        sample.rescueBlockedBy === "weak_semantic",
      "rescueBlockedBy must be a known rescue-blocked code or null"
    );
    assert.equal(typeof sample.score, "number");
  }

  // D-059 + D-062: sampleRescues is an array; rescued items carry an explicit
  // machine-readable reason so an operator can answer "which path admitted
  // this item" from the trace alone.
  assert.ok(Array.isArray(trace.sampleRescues), "decisionTrace must include sampleRescues array");
});

test("decisionTrace: beatFit counters are consistent with histogram totals (no double-counting)", async () => {
  // A mixed run with one in-band penalty-blocked candidate plus one clear
  // include. Verifies that the trace's rescue-blocked counters never exceed
  // excludedCount, and that excludedCount equals the sum of histogram values.
  const include = makeItem({
    sourceId: "incl",
    outlet: "The Washington Post — World",
    geographies: ["US"],
    topic: "Diplomatic relations",
    headline: "U.S. strikes two Iranian-flagged tankers as tensions continue amid ceasefire",
    minutesAgo: 30,
  });
  const offbeat = makeItem({
    sourceId: "off",
    outlet: "The Washington Post — World",
    geographies: ["US"],
    topic: "Diplomatic relations",
    headline: "Asian commodity markets brace for fertilizer crunch",
    body: ["Farmers across Asia face commodity stress."],
    minutesAgo: 30,
  });
  const { log } = await runRefreshPipeline({
    settings: PHASE1_SETTINGS,
    rawItems: [include, offbeat],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  const t = log.decisionTrace.beatFit;
  const histTotal = Object.values(t.excludeReasonHistogram).reduce(
    (acc, v) => acc + v,
    0
  );
  assert.equal(
    histTotal,
    t.excludedCount,
    "excludeReasonHistogram sum must equal excludedCount"
  );
  assert.ok(
    t.rescueBlockedPenaltyCount + t.rescueBlockedInsufficientSignalsCount <=
      t.excludedCount,
    "rescue-blocked counters cannot exceed excludedCount"
  );
});

test("decisionTrace: sampleExclusions is capped (≤ 5) and entries carry only minimal fields", async () => {
  // Six recall-passing but beat-fit-failing items. Each clears recall via the
  // configured topic, then trips beat-fit on the commodity-framing penalty
  // (D-060 kept commodity; off-beat-region penalty is gone). No structural
  // geo → no geo bonus → topic alone + recency − commodity drops the score
  // below 0.40. Cap = 5 is enforced inside the pipeline.
  const items = Array.from({ length: 6 }, (_, i) =>
    makeItem({
      sourceId: `off-${i}`,
      outlet: "The Washington Post — World",
      geographies: [],
      topic: "Diplomatic relations",        // pass topic+keyword recall
      headline: "Asia farmers face commodity squeeze on wheat and fertilizer",
      body: ["Farmers across Asia continue to face commodity stress."],
      minutesAgo: 30,
    })
  );
  const { log } = await runRefreshPipeline({
    settings: PHASE1_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  const trace = log.decisionTrace;
  assert.ok(trace.beatFit.excludedCount >= 6);
  assert.ok(
    trace.sampleExclusions.length <= 5,
    `sample must be capped at 5 (got ${trace.sampleExclusions.length})`
  );
  // Sample entries must NOT carry raw source bodies / headlines.
  const allowedKeys = new Set([
    "sourceId",
    "stage",
    "excludeReason",
    "inRescueBand",
    "rescueBlockedBy",
    "score",
  ]);
  for (const entry of trace.sampleExclusions) {
    for (const k of Object.keys(entry)) {
      assert.ok(allowedKeys.has(k), `sample entry has unexpected key: ${k}`);
    }
  }
});

// ─── D-059 + D-062 (PR4): pipeline-level rescue diagnostics ──────────────────
//
// End-to-end: the pipeline must (1) admit an eligible item via the new
// rescue_semantic_geo path, (2) surface the explicit machine-readable
// rescue reason in `decisionTrace.sampleRescues`, (3) bump the path-split
// counters in `decisionTrace.beatFit`, and (4) annotate exclusions with
// rescue_blocked_geo_gate when the geo gate is what blocks rescue.
//
// The raw `semanticIntentScore` on the input items doesn't survive
// `normalizeSourceItems` (which returns a fresh canonical-shape object). The
// canonical injection point is the `semanticBeatFitEmbedFn` opt; the stub
// below maps the profile text to one direction and items to a vector whose
// cosine with the profile is 0.30 → `normalizeCosineToScore(0.30) = 0.65`.
// That lands every item's semantic score at exactly 0.65 — comfortably above
// the 0.60 rescue floor but not at 1.0 (which would push some shapes over
// the 0.40 blend threshold).
function p4SemanticGeoStub() {
  return async (texts) =>
    texts.map((_, i) => {
      // texts[0] is the profile when the profile cache is cold (we always
      // pass a fresh cache in these tests).
      if (i === 0) return [1, 0];
      return [0.30, Math.sqrt(1 - 0.09)];
    });
}

test("decisionTrace: pipeline surfaces rescue_semantic_geo path in sampleRescues + counters (D-059 / D-062)", async () => {
  // Settings have NO configured topic/keyword. After Slice 2 the recall geo
  // lexical gate is active, so the item must mention the configured geography
  // ("Nigeria") in text to pass recall; beat-fit then fires ONLY the geo
  // component — deterministic ≈ 0.20 (geo) + 0 (stale recency). With semantic
  // ≈ 0.65 the blended score lands just under 0.40 → multisignal rescue fails
  // (only 1 signal), semantic-geo rescue succeeds (geo + strong semantic + no
  // penalty).
  const settings = {
    contractVersion: "2026-05-19-meta-story-fields",
    topics: [],
    keywords: [],
    geographies: ["Nigeria"],
    traditionalSources: ["The Washington Post — World"],
    socialSources: [],
  };
  const item = makeItem({
    sourceId: "sg-pipeline-rescue",
    outlet: "The Washington Post — World",
    geographies: ["Nigeria"],
    topic: "",
    headline: "Background piece on Nigeria and the Sahel region",
    body: ["A long-form analysis of regional dynamics without any configured signal terms."],
    minutesAgo: 1440,
  });
  const { log } = await runRefreshPipeline({
    settings,
    rawItems: [item],
    clusterFn: async (items) =>
      items.map((i) => ({
        title: "T",
        subtitle: "S",
        source_item_ids: [i.sourceId],
        summary: "x",
        tags: { topics: [], keywords: [], geographies: ["Nigeria"] },
        factual_claims: ["A claim."],
        claim_evidence_map: { "0": [i.sourceId] },
      })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticBeatFitConfig: SEMANTIC_ON,
    semanticBeatFitEmbedFn: p4SemanticGeoStub(),
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });

  const trace = log.decisionTrace;
  assert.ok(trace, "decisionTrace must be present");
  // Path-split counter: exactly one semantic-geo rescue.
  assert.equal(trace.beatFit.rescuedSemanticGeoCount, 1);
  assert.equal(trace.beatFit.rescuedBorderlineCount, 0);
  assert.equal(trace.beatFit.rescuedCount, 1, "union counter matches");
  // sampleRescues exposes the explicit machine-readable reason.
  assert.ok(Array.isArray(trace.sampleRescues));
  assert.equal(trace.sampleRescues.length, 1);
  const sample = trace.sampleRescues[0];
  assert.equal(sample.stage, "beat_fit");
  assert.equal(sample.sourceId, "sg-pipeline-rescue");
  assert.equal(sample.rescueReason, "rescue_semantic_geo");
  assert.equal(typeof sample.score, "number");
  assert.equal(typeof sample.deterministicScore, "number");
});

test("decisionTrace: geo mismatch is reported via rescueBlockedBy='geo_gate' in sampleExclusions (D-059)", async () => {
  // Item has no structural geo (IMPLICIT_GEO) so the geo filter admits it at
  // the mock-assess confidence (0.85 ≥ 0.80 implicit threshold). Beat-fit
  // then sees zero configured-geo signal — strong semantic + below-threshold
  // + keyword bonus (no noConfiguredSignal preempt) → rescue blocked at
  // geo_gate, not at major_penalty.
  const settings = {
    contractVersion: "2026-05-19-meta-story-fields",
    topics: [],
    keywords: ["sanctions"],
    geographies: ["Nigeria"],
    traditionalSources: ["The Washington Post — World"],
    socialSources: [],
  };
  const item = makeItem({
    sourceId: "sg-pipeline-geo-gate",
    outlet: "The Washington Post — World",
    geographies: [],
    topic: "",
    headline: "Background piece on sanctions enforcement abroad",
    // No structural geo and no configured-geo text mention — the soft-geo
    // matcher would otherwise pick up a bare "Nigeria" mention and fire
    // geoMatch, defeating the test.
    body: ["A piece on sanctions context with no structural geo tag."],
    minutesAgo: 1440,
  });
  const { log } = await runRefreshPipeline({
    settings,
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticBeatFitConfig: SEMANTIC_ON,
    semanticBeatFitEmbedFn: p4SemanticGeoStub(),
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });

  const trace = log.decisionTrace;
  assert.ok(trace);
  assert.equal(trace.beatFit.rescuedSemanticGeoCount, 0);
  assert.equal(trace.beatFit.rescueBlockedGeoGateCount, 1);
  // sampleExclusions surfaces the geo_gate diagnosis for this candidate.
  const entry = trace.sampleExclusions.find((e) => e.sourceId === "sg-pipeline-geo-gate");
  assert.ok(entry, "sample entry for geo-gate candidate must be present");
  assert.equal(entry.rescueBlockedBy, "geo_gate");
});

test("decisionTrace: watermark-skip branch still emits a trace with finalStories=null", async () => {
  // First run computes a watermark. Second run with the same priorWatermark
  // short-circuits, and must still surface decisionTrace — beat-fit ran
  // before the short-circuit, so the trace is meaningful.
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
    contractVersion: "2026-05-19-meta-story-fields",
    beatFitEnabled: false, // skip-branch + bypassed beat-fit: trace must still be safe
  });
  assert.ok(first.log.decisionTrace, "full-run trace must be present even when beat-fit is bypassed");
  assert.equal(typeof first.log.decisionTrace.beatFit.includedCount, "number");

  const second = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    beatFitEnabled: false,
    priorWatermark: first.log.watermark,
  });
  assert.equal(second.payload, null, "watermark-skip returns payload=null");
  assert.equal(second.log.unchanged, true);
  assert.ok(second.log.decisionTrace, "watermark-skip log must carry decisionTrace");
  assert.equal(
    second.log.decisionTrace.stageCounts.finalStories,
    null,
    "skip-branch trace must report finalStories=null (clustering never ran)"
  );
  assert.ok(Array.isArray(second.log.decisionTrace.sampleExclusions));
});

// ─── Phase 3: regression harness ─────────────────────────────────────────────
//
// High-signal, end-to-end regression coverage for the rescue + decision-trace
// behaviors that ship as a unit. Tests in this section deliberately use
// synthetic fixtures (no production URLs/titles) and assert on shapes rather
// than exact floats so they survive small, intentional weight tweaks but
// catch directional drift.

// User profile modeled after a comms team monitoring multiple foreign
// hotspots (Ukraine, Haiti, China) from a US perspective. The contract
// geography enum is "US" | "Colombia"; hotspot country names live in
// `keywords` (where the actual filter logic looks for them in headlines
// and bodies). topics/keywords/sources are wide enough that all three
// candidate stories below clear source-selection + topic+keyword recall.
const WAPO_REGRESSION_SETTINGS = {
  contractVersion: "2026-05-19-meta-story-fields",
  topics: ["Diplomatic relations", "Security cooperation"],
  keywords: ["war", "gang", "trade", "Ukraine", "Haiti", "China", "sanctions"],
  geographies: ["US"],
  traditionalSources: ["The Washington Post"],
  socialSources: [],
};

// Synthetic three-story candidate set: war, gang, summit. Each fires the
// four core beat-fit signals (topic, actor "u.s.", a configured keyword,
// explicit US geo) so all three should pass the gate cleanly. If a future
// change drops one, the decision trace below must explain WHY.
function makeWapoCandidates() {
  return [
    makeItem({
      sourceId: "wapo-ukraine",
      outlet: "The Washington Post",
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "U.S. expands Ukraine aid amid intensifying war on the eastern front",
      body: ["Officials briefed congressional leaders on the latest aid package."],
      minutesAgo: 30,
    }),
    makeItem({
      sourceId: "wapo-haiti",
      outlet: "The Washington Post",
      topic: "Security cooperation",
      geographies: ["US"],
      headline: "Gang violence in Haiti prompts new U.S. sanctions and aid coordination",
      body: ["The State Department announced fresh measures targeting gang financiers."],
      minutesAgo: 45,
    }),
    makeItem({
      sourceId: "wapo-china",
      outlet: "The Washington Post",
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "U.S. and China hold trade summit amid renewed tariff tensions",
      body: ["The summit followed weeks of escalating tariff exchanges."],
      minutesAgo: 60,
    }),
  ];
}

function buildOneClusterPerItem(items) {
  return items.map((i) => ({
    title: `Story-${i.sourceId}`,
    subtitle: "Subtitle",
    source_item_ids: [i.sourceId],
    summary: "Summary.",
    tags: { topics: [i.topic], keywords: [], geographies: ["US"] },
    factual_claims: ["A claim."],
    claim_evidence_map: { "0": [i.sourceId] },
  }));
}

test("regression (three-story WaPo): all three candidates pass source/recall and become stories", async () => {
  const candidates = makeWapoCandidates();
  const seenAtCluster = [];
  const { payload, log } = await runRefreshPipeline({
    settings: WAPO_REGRESSION_SETTINGS,
    rawItems: candidates,
    clusterFn: async (items) => {
      seenAtCluster.push(...items.map((i) => i.sourceId));
      return buildOneClusterPerItem(items);
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  // Source + recall stages: all three reach clustering. Stage counts hold a
  // monotonic invariant — no stage may produce more items than the previous.
  const counts = log.decisionTrace.stageCounts;
  assert.equal(counts.afterSourceSelection, 3, "all three WaPo items pass source selection");
  assert.equal(counts.afterTopicKeyword, 3, "all three clear topic+keyword recall");
  const monotonic = [
    counts.totalNormalized,
    counts.afterTimeWindow,
    counts.afterSourceSelection,
    counts.afterGeoFilter,
    counts.afterTopicKeyword,
    counts.afterBeatFit,
    counts.afterDedupe,
  ];
  for (let i = 1; i < monotonic.length; i++) {
    assert.ok(
      monotonic[i] <= monotonic[i - 1],
      `funnel monotonicity broken at stage index ${i}: ${monotonic.join(" → ")}`
    );
  }

  // Beat-fit: with three core signals firing on each candidate, all three
  // should clear the gate. If a future change drops one, the test fails AND
  // the decision trace must explain it (no silent drops).
  assert.equal(
    log.decisionTrace.beatFit.includedCount,
    3,
    "all three core-aligned candidates must clear beat-fit"
  );
  assert.equal(log.decisionTrace.beatFit.excludedCount, 0);
  assert.equal(log.decisionTrace.sampleExclusions.length, 0);

  // Clustering: all three reached cluster; payload contains three stories.
  assert.deepEqual(
    seenAtCluster.sort(),
    ["wapo-china", "wapo-haiti", "wapo-ukraine"],
    "all three candidates must reach clustering"
  );
  assert.equal(payload.stories.length, 3);
});

test("regression (three-story WaPo): if a candidate is excluded, decisionTrace explains it (no silent drops)", async () => {
  // Same profile but the China story now has commodity-only framing with no
  // geo overlap and no configured keyword in text — beat-fit drops it via
  // the commodity-framing penalty (D-060 kept commodity; off-beat-region is
  // gone). The other two still clear. The contract: the drop is NEVER
  // silent — the trace surfaces the excluded item with a structured reason
  // and counters.
  const candidates = makeWapoCandidates();
  candidates[2] = makeItem({
    sourceId: "wapo-china",
    outlet: "The Washington Post",
    topic: "Diplomatic relations",
    geographies: [],
    headline: "Commodity markets brace for fertilizer crunch",
    body: ["Farmers continue to face commodity stress across the region."],
    minutesAgo: 60,
    // Override default URL so the path token "wapo-china" doesn't trigger the
    // configured "China" keyword via the D-064 URL-as-evidence join.
    url: "https://example.com/commodity-markets",
  });

  const { log } = await runRefreshPipeline({
    settings: WAPO_REGRESSION_SETTINGS,
    rawItems: candidates,
    clusterFn: async (items) => buildOneClusterPerItem(items),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.equal(log.decisionTrace.beatFit.includedCount, 2);
  assert.equal(log.decisionTrace.beatFit.excludedCount, 1);

  // Trace must identify the dropped sourceId AND give a primary reason.
  const sample = log.decisionTrace.sampleExclusions.find(
    (s) => s.sourceId === "wapo-china"
  );
  assert.ok(sample, "decisionTrace.sampleExclusions must include the dropped wapo-china");
  assert.equal(sample.stage, "beat_fit");
  assert.ok(
    typeof sample.excludeReason === "string" && sample.excludeReason.length > 0,
    "drop must carry a non-empty primary reason code"
  );
  assert.equal(typeof sample.inRescueBand, "boolean");
});

// ─── Phase 2 trace invariants (consolidated lock) ────────────────────────────
//
// One representative batch exercises every trace invariant at once so any
// regression in shape/cap/counters surfaces with a single specific failure.

test("trace invariants: cap, key-whitelist, and counter consistency hold on a mixed batch", async () => {
  // Six commodity-only candidates that pass recall (via topic) but fail
  // beat-fit (commodity-framing penalty; no geo overlap → no geo bonus).
  // D-060 removed the off-beat-region penalty; commodity remains the
  // precision filter that catches this shape. Exercises the cap (6 → ≤5
  // samples), the key-whitelist, and the counter-vs-histogram identity in
  // one shot.
  const items = Array.from({ length: 6 }, (_, i) =>
    makeItem({
      sourceId: `off-${i}`,
      outlet: "The Washington Post",
      geographies: [],
      topic: "Diplomatic relations",
      headline: "Farmers brace for fertilizer and wheat commodity squeeze",
      body: ["Farmers continue to face commodity stress."],
      minutesAgo: 30,
    })
  );
  const { log } = await runRefreshPipeline({
    settings: WAPO_REGRESSION_SETTINGS,
    rawItems: items,
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  const trace = log.decisionTrace;
  const bf = trace.beatFit;

  // Cap.
  assert.ok(
    trace.sampleExclusions.length <= 5,
    `sampleExclusions cap violated (${trace.sampleExclusions.length} > 5)`
  );

  // Key whitelist — sample entries never leak headlines/bodies.
  const ALLOWED = new Set([
    "sourceId", "stage", "excludeReason", "inRescueBand", "rescueBlockedBy", "score",
  ]);
  for (const entry of trace.sampleExclusions) {
    for (const k of Object.keys(entry)) {
      assert.ok(ALLOWED.has(k), `sample entry leaked unexpected key: ${k}`);
    }
  }

  // Histogram identity: every excluded item contributes exactly one bucket.
  const histTotal = Object.values(bf.excludeReasonHistogram).reduce(
    (acc, v) => acc + v,
    0
  );
  assert.equal(histTotal, bf.excludedCount, "histogram sum must equal excludedCount");

  // Rescue-blocked counters can never exceed excluded total.
  assert.ok(
    bf.rescueBlockedPenaltyCount + bf.rescueBlockedInsufficientSignalsCount <=
      bf.excludedCount,
    "rescue-blocked counters cannot exceed excludedCount"
  );

  // included + excluded = candidates that reached the gate (post-recall).
  assert.equal(
    bf.includedCount + bf.excludedCount,
    trace.stageCounts.afterTopicKeyword,
    "included + excluded must equal the post-recall candidate count"
  );
});

// ─── Phase 3: meta-story-level tag assignment (pipeline integration) ─────────
//
// These tests pin the *pipeline-level* contract for Phase 3 — they verify
// what shows up in `payload.stories[i].tags` once `buildStory` calls the new
// `assignMetaStoryTags` module.  Module-level invariants are covered in
// [`meta-story-tags.test.mjs`](./meta-story-tags.test.mjs); the cases here
// guard the wiring and the Phase 4 boundary.

test("Phase 3 wiring: topic tag derived from meta-story summary even when source.topic is weak", async () => {
  // Source `topic` is intentionally an out-of-settings label ("General") —
  // legacy/source-only `deriveStoryTags` would have dropped it as not-in-
  // settings and produced no topic tag.  Recall still passes the item via the
  // OFAC keyword in the headline.  The meta-story summary mentions
  // "Diplomatic relations" verbatim; the Phase 3 assigner must pick it up
  // off the evidence bundle even though the structural `source.topic` field
  // contributes nothing.
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "General", // not in BASE_SETTINGS.topics — structural path yields []
      geographies: ["US"],
      headline: "OFAC briefing in the capital",
      body: ["No canonical topic phrase on the structural field."],
    }),
  ];
  // Note: `verifyGrounding` replaces `summary`/`subtitle` with the first
  // `factual_claims[0]` when claims are non-empty — so the claim text itself
  // is what reaches the evidence bundle, not the model summary.  We place the
  // canonical topic phrase in the title (untouched by grounding) AND in the
  // grounded claim so the assertion is robust across either path.
  const metaStory = {
    meta_story_id: "phase3-topic-bundle",
    title: "Diplomatic relations roundup",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Routine narrative summary.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: Diplomatic relations briefing in the capital"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(
    payload.stories[0].tags.topics.includes("Diplomatic relations"),
    "Phase 3: topic surfaced from meta-story evidence bundle, not source.topic"
  );
});

test("Phase 3 wiring: 'Beijing' in evidence with 'China' added to settings emits China tag", async () => {
  const settings = {
    ...BASE_SETTINGS,
    // Opt into China for this test only — BASE_SETTINGS doesn't include it.
    geographies: [...BASE_SETTINGS.geographies, "China"],
  };
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Officials in Beijing issued a statement",
      body: ["The remarks land amid diplomatic friction."],
    }),
  ];
  const metaStory = {
    meta_story_id: "phase3-beijing-alias",
    title: "Diplomatic friction widens",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Beijing pushed back on the new measures.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: Officials in Beijing issued a statement"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(
    payload.stories[0].tags.geographies.includes("China"),
    "Phase 3 alias map: Beijing → China when China is in settings.geographies"
  );
  assert.ok(
    !payload.stories[0].tags.geographies.includes("Beijing"),
    "alias surface form must NEVER be emitted into the payload"
  );
});

test("Phase 3 wiring: alias hit is silently dropped when canonical target is NOT in settings", async () => {
  // Same evidence as the previous test, but settings drops "China".  No
  // alias-derived tag may appear, and the alias token itself must not leak.
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Officials in Beijing issued a statement",
      body: ["The remarks land amid diplomatic friction."],
    }),
  ];
  const metaStory = {
    meta_story_id: "phase3-alias-gated",
    title: "Diplomatic friction widens",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Beijing pushed back on the new measures.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: Officials in Beijing issued a statement"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS, // does NOT include "China"
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(
    !payload.stories[0].tags.geographies.includes("China"),
    "alias must NOT fabricate China when settings haven't opted in"
  );
  assert.ok(
    !payload.stories[0].tags.geographies.includes("Beijing"),
    "alias surface form must NEVER leak into the payload"
  );
});

test("Phase 3 wiring: 'petroleum' in text + 'oil' in settings emits NO keyword tag (Phase 4 deferred)", async () => {
  // Phase 3 keyword matching is deterministic whole-word only.  This pipeline
  // regression locks the boundary between Phase 3 and Phase 4 (semantic
  // keyword aliasing).  If a future change accidentally widens "petroleum"
  // to the "oil" tag, this test fails and the boundary is reaffirmed.
  const settings = {
    ...BASE_SETTINGS,
    keywords: [...BASE_SETTINGS.keywords, "oil"], // settings now includes 'oil'
  };
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Petroleum prices climb again",
      body: ["Crude refining capacity strained across the region."],
    }),
  ];
  const metaStory = {
    meta_story_id: "phase3-petroleum-oil-boundary",
    title: "Energy market roundup",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Markets shift on supply concerns.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: Petroleum prices climb again"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(
    !payload.stories[0].tags.keywords.includes("oil"),
    "Phase 3 default (semantic OFF) must NOT widen 'petroleum' evidence to the 'oil' keyword"
  );
});

// ─── Phase 4: constrained semantic mapping (pipeline integration) ────────────
//
// These tests pin the *pipeline-level* contract for Phase 4 — they verify
// what shows up in `payload.stories[i].tags` once the pipeline is invoked
// with a semantic config + injected scorer.  Per-module behavior is covered
// in [`meta-story-semantic-mapper.test.mjs`](./meta-story-semantic-mapper.test.mjs)
// and [`meta-story-tags.test.mjs`](./meta-story-tags.test.mjs); the cases here
// guard the wiring, the Phase 5+ scope (geo deterministic), and the K1a
// one-way invariant (no admission count drift from semantic uplift).

const PHASE4_SEMANTIC_ON = Object.freeze({
  enabled: true,
  topicsEnabled: true,
  keywordsEnabled: true,
  topicsThreshold: 0.75,
  keywordsThreshold: 0.75,
});

function makePhase4Scorer(table) {
  // table: { labelLower: { evidenceSubstring -> score } }
  return async (evidence, label) => {
    const lower = evidence.toLowerCase();
    const entries = Object.entries(table[label.toLowerCase()] ?? {});
    for (const [needle, score] of entries) {
      if (lower.includes(needle)) return score;
    }
    return 0;
  };
}

test("Phase 4 wiring: keyword semantic uplift — 'petroleum' evidence + 'oil' in settings emits 'oil' when ON", async () => {
  const settings = { ...BASE_SETTINGS, keywords: [...BASE_SETTINGS.keywords, "oil"] };
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Petroleum prices climb again — sanctions context",
      body: ["Crude refining capacity strained."],
    }),
  ];
  const metaStory = {
    meta_story_id: "phase4-keyword-uplift",
    title: "Energy market roundup",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Markets shift on supply concerns.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: Petroleum prices climb"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload, log } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE4_SEMANTIC_ON,
    semanticTagScorer: makePhase4Scorer({ oil: { petroleum: 0.9 } }),
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(
    payload.stories[0].tags.keywords.includes("oil"),
    "Phase 4 keyword uplift: 'petroleum' evidence + scorer above threshold → 'oil' tag"
  );
  // Deterministic baseline ('sanctions' in body) still fires.
  assert.ok(payload.stories[0].tags.keywords.includes("sanctions"));
  // Diagnostics aggregate reflects the run.
  assert.equal(log.tags.keywords.enabled, true);
  assert.ok(log.tags.keywords.acceptedCount >= 1);
});

test("Phase 4 wiring: topic semantic uplift — bundle text + scorer adds settings topic when ON", async () => {
  // Source has out-of-settings topic ('General') and headline does not match a
  // canonical settings topic.  Deterministic baseline yields no topic tag.
  // Semantic scorer maps 'talks' evidence to 'Diplomatic relations'.
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "General",
      geographies: ["US"],
      headline: "OFAC briefing concludes",
      body: ["High-stakes talks resumed in the capital."],
    }),
  ];
  const metaStory = {
    meta_story_id: "phase4-topic-uplift",
    title: "Capital briefing",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Negotiation tone continued today.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: OFAC briefing concludes"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const scorer = makePhase4Scorer({
    "diplomatic relations": { talks: 0.9, negotiation: 0.85 },
  });
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE4_SEMANTIC_ON,
    semanticTagScorer: scorer,
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(
    payload.stories[0].tags.topics.includes("Diplomatic relations"),
    "Phase 4 topic uplift: bundle text + scorer → 'Diplomatic relations' tag"
  );
  assert.equal(log.tags.topics.enabled, true);
  assert.ok(log.tags.topics.acceptedCount >= 1);
});

test("Phase 4 wiring: semantic ON cannot emit an out-of-settings keyword (closed vocabulary)", async () => {
  // Settings keywords are ["OFAC", "sanctions"] — 'oil' is intentionally NOT
  // opted in.  Even with a confident scorer, no 'oil' tag must appear.
  const settings = { ...BASE_SETTINGS }; // keywords: ["OFAC", "sanctions"]
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Petroleum prices climb — sanctions noted",
      body: ["Crude refining capacity strained."],
    }),
  ];
  const metaStory = {
    meta_story_id: "phase4-out-of-settings-block",
    title: "Energy roundup",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Markets shift on supply concerns.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: Petroleum prices climb"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE4_SEMANTIC_ON,
    semanticTagScorer: makePhase4Scorer({ oil: { petroleum: 0.99 } }),
  });
  assert.ok(
    !payload.stories[0].tags.keywords.includes("oil"),
    "out-of-settings keyword must never appear regardless of semantic score"
  );
});

test("Phase 4 wiring: geography axis is unchanged when semantic is ON (deterministic-only lock)", async () => {
  // Aggressive scorer would otherwise widen anything.  Geographies must stay
  // deterministic (exact match + Phase 3 alias map).  Settings opt out of
  // 'China' — no 'China' tag despite 'Beijing' evidence and ON flag.
  const settingsNoChina = { ...BASE_SETTINGS, geographies: ["US", "Colombia"] };
  const rawItems = [
    makeItem({
      sourceId: "src-1",
      outlet: "Reuters",
      minutesAgo: 30,
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Officials in Beijing met today",
      body: ["The remarks land amid diplomatic friction."],
    }),
  ];
  const metaStory = {
    meta_story_id: "phase4-geo-locked",
    title: "Diplomatic friction widens",
    subtitle: "Sub.",
    source_item_ids: ["src-1"],
    summary: "Beijing pushed back on the new measures.",
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["Reuters reports: Officials in Beijing met today"],
    claim_evidence_map: { "0": ["src-1"] },
  };
  const { payload, log } = await runRefreshPipeline({
    settings: settingsNoChina,
    rawItems,
    clusterFn: async () => [metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE4_SEMANTIC_ON,
    semanticTagScorer: async () => 0.99, // would accept anything semantically
  });
  assert.ok(!payload.stories[0].tags.geographies.includes("China"));
  assert.ok(!payload.stories[0].tags.geographies.includes("Beijing"));
  assert.equal(
    log.tags.geographies.semanticApplied,
    false,
    "geographies.semanticApplied must always be false in Phase 4"
  );
});

test("Phase 4 wiring: semantic uplift does NOT change funnel / admission counts (K1a one-way invariant)", async () => {
  // Build a 4-item fixture: 3 in-pool/relevant + 1 out of recall.  Run twice
  // — once semantic OFF, once semantic ON with aggressive scorer.  Funnel
  // stage counts and afterDedupe / finalStories must be identical.
  const rawItems = [
    makeItem({ sourceId: "in-1", outlet: "Reuters", minutesAgo: 30, topic: "Diplomatic relations" }),
    makeItem({ sourceId: "in-2", outlet: "Reuters", minutesAgo: 35, topic: "Diplomatic relations" }),
    makeItem({ sourceId: "in-3", outlet: "Reuters", minutesAgo: 40, topic: "Diplomatic relations" }),
    makeItem({ sourceId: "out", outlet: "BBC", minutesAgo: 45, topic: "Cooking", geographies: ["France"], headline: "Food", body: ["No keyword."] }),
  ];
  const metaStory = {
    meta_story_id: "phase4-no-admission-drift",
    title: "Diplomatic Relations Developments",
    subtitle: "Sub.",
    source_item_ids: ["in-1", "in-2", "in-3"],
    summary: "Diplomatic relations updates tracked.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US", "Colombia"] },
    factual_claims: ["Reuters reports: Routine briefing"],
    claim_evidence_map: { "0": ["in-1"] },
  };
  const runOnce = async (semanticConfig, scorer) =>
    runRefreshPipeline({
      settings: BASE_SETTINGS,
      rawItems,
      clusterFn: async () => [metaStory],
      clusterModel: "mock-anthropic-haiku",
      contractVersion: "2026-05-19-meta-story-fields",
      semanticTagConfig: semanticConfig,
      semanticTagScorer: scorer,
    });
  const off = await runOnce(undefined, undefined);
  const on = await runOnce(PHASE4_SEMANTIC_ON, async () => 0.99);
  // Funnel stage counts must match (semantic only affects post-build tag
  // overlay; admission/recall/clustering inputs are identical).
  assert.deepEqual(on.log.funnel.stages, off.log.funnel.stages);
  assert.equal(on.log.metaStoryCount, off.log.metaStoryCount);
  assert.equal(on.payload.stories.length, off.payload.stories.length);
  // Diagnostics confirm the OFF/ON split: semantic flags reflect config.
  assert.equal(off.log.tags.topics.enabled, false);
  assert.equal(on.log.tags.topics.enabled, true);
});

// ─── Phase 5: production-scorer fail-closed + runtime state (pipeline) ──────
//
// These tests verify the pipeline-level guarantees that the rollout posture
// depends on:
//   - scorer timeout / error never breaks refresh (deterministic baseline
//     still ships);
//   - per-axis runtime state is surfaced through `log.tags.{topics,keywords}`
//     so the operator can read rollout posture;
//   - funnel counts are identical with semantic ON vs OFF, even when the
//     scorer fails (K1a one-way invariant — semantic is post-clustering).

const PHASE5_SEMANTIC_ON = Object.freeze({
  enabled: true,
  topicsEnabled: true,
  keywordsEnabled: true,
  topicsThreshold: 0.75,
  keywordsThreshold: 0.75,
});

function makePhase5Fixture() {
  return {
    settings: { ...BASE_SETTINGS, keywords: [...BASE_SETTINGS.keywords, "oil"] },
    rawItems: [
      makeItem({
        sourceId: "src-1",
        outlet: "Reuters",
        minutesAgo: 30,
        topic: "Diplomatic relations",
        geographies: ["US"],
        headline: "Petroleum prices climb — sanctions context",
        body: ["Crude refining capacity strained."],
      }),
    ],
    metaStory: {
      meta_story_id: "phase5-fixture",
      title: "Energy roundup",
      subtitle: "Sub.",
      source_item_ids: ["src-1"],
      summary: "Markets shift on supply concerns.",
      tags: { topics: [], keywords: [], geographies: [] },
      factual_claims: ["Reuters reports: Petroleum prices climb"],
      claim_evidence_map: { "0": ["src-1"] },
    },
  };
}

test("Phase 5 wiring: scorer timeout degrades gracefully — deterministic tags still ship; runtimeState = scorer_timeout_fallback", async () => {
  const fixture = makePhase5Fixture();
  const { default: assertModule } = await import("node:assert/strict");
  const { SemanticScorerTimeoutError } = await import("./meta-story-semantic-mapper.mjs");

  const timeoutScorer = async () => {
    throw new SemanticScorerTimeoutError("simulated timeout");
  };
  const { payload, log } = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: timeoutScorer,
  });
  // Refresh did NOT throw — pipeline survived the scorer failure.
  assertModule.equal(payload.stories.length, 1);
  // Deterministic baseline still ships: source body has "sanctions" + "OFAC"
  // -ish text would clear the Phase 3 keyword path.  Semantic uplift (oil)
  // does NOT appear because the scorer never returned.
  assertModule.ok(!payload.stories[0].tags.keywords.includes("oil"));
  assertModule.equal(log.tags.keywords.runtimeState, "scorer_timeout_fallback");
  assertModule.ok(log.tags.keywords.fallbackReasonCounts.timeout >= 1);
});

test("Phase 5 wiring: scorer generic error degrades gracefully — runtimeState = scorer_error_fallback", async () => {
  const fixture = makePhase5Fixture();
  const errorScorer = async () => {
    throw new Error("provider went sideways");
  };
  const { payload, log } = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: errorScorer,
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(!payload.stories[0].tags.keywords.includes("oil"));
  assert.equal(log.tags.keywords.runtimeState, "scorer_error_fallback");
  assert.ok(log.tags.keywords.fallbackReasonCounts.error >= 1);
});

test("Phase 5 wiring: enabled but no scorer wired → runtimeState = enabled_no_scorer (no uplift, no errors)", async () => {
  const fixture = makePhase5Fixture();
  const { payload, log } = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: null, // production scorer not wired
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(!payload.stories[0].tags.keywords.includes("oil"));
  assert.equal(log.tags.keywords.runtimeState, "enabled_no_scorer");
  assert.equal(log.tags.keywords.fallbackReasonCounts.timeout, 0);
  assert.equal(log.tags.keywords.fallbackReasonCounts.error, 0);
});

test("Phase 5 wiring: scorer-ready run sets runtimeState = enabled_scorer_ready and records latency", async () => {
  const fixture = makePhase5Fixture();
  const readyScorer = async (_evidence, label) => {
    await new Promise((r) => setTimeout(r, 2));
    return label.toLowerCase() === "oil" ? 0.9 : 0.1;
  };
  const { payload, log } = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: readyScorer,
  });
  assert.equal(payload.stories.length, 1);
  assert.ok(payload.stories[0].tags.keywords.includes("oil"));
  assert.equal(log.tags.keywords.runtimeState, "enabled_scorer_ready");
  assert.ok(log.tags.keywords.scorerLatencyMs > 0, "latency must be recorded for the scorer-ready path");
});

test("Phase 5 wiring: funnel counts identical for scorer-OFF vs scorer-FAIL (K1a invariant under fallback)", async () => {
  const fixture = makePhase5Fixture();
  const off = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    // semantic OFF
  });
  const failScorer = async () => {
    throw new (await import("./meta-story-semantic-mapper.mjs")).SemanticScorerTimeoutError("slow");
  };
  const failed = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: failScorer,
  });
  // Even when the scorer fails closed, funnel counts must match the OFF run.
  assert.deepEqual(failed.log.funnel.stages, off.log.funnel.stages);
  assert.equal(failed.log.metaStoryCount, off.log.metaStoryCount);
  // Geographies axis is always locked to no semantic application.
  assert.equal(failed.log.tags.geographies.semanticApplied, false);
});

test("Phase 5 wiring: geographies stay deterministic when scorer ready (no semantic geo path, even on full success)", async () => {
  // Aggressive scorer would happily widen anything; geographies must stay
  // deterministic-only.  Beijing evidence + China NOT in settings → no widening.
  const fixture = makePhase5Fixture();
  const settingsNoChina = { ...fixture.settings, geographies: ["US", "Colombia"] };
  const aggressiveScorer = async () => 0.99;
  const { payload, log } = await runRefreshPipeline({
    settings: settingsNoChina,
    rawItems: [
      makeItem({
        sourceId: "src-1",
        outlet: "Reuters",
        minutesAgo: 30,
        topic: "Diplomatic relations",
        geographies: ["US"],
        headline: "Officials in Beijing met today",
        body: ["Diplomatic friction persists."],
      }),
    ],
    clusterFn: async () => [{
      ...fixture.metaStory,
      title: "Diplomatic friction widens",
      summary: "Beijing pushed back on the measures.",
    }],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: aggressiveScorer,
  });
  assert.ok(!payload.stories[0].tags.geographies.includes("China"));
  assert.equal(log.tags.geographies.semanticApplied, false);
});

// ─── Phase 7: rollout hardening (kill switch, schema version, abort) ────────
//
// These tests pin the pipeline-level guarantees that Phase 7 layers on top
// of the Phase 4/5 surface:
//   - `log.tags` carries `schemaVersion` + `killSwitchActive` for operator
//     diagnostics;
//   - the kill switch forces every axis to `disabled` regardless of the
//     other flags;
//   - K1a one-way invariant still holds under the abort/cancellation path
//     (funnel counts identical to OFF when scorer aborts);
//   - latency observability surfaces `scorerCallCount` + `scorerLatencyMaxMs`.

test("Phase 7 wiring: log.tags carries schemaVersion + killSwitchActive on every run", async () => {
  const fixture = makePhase5Fixture();
  const { log } = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    // semantic OFF — schema version + killSwitchActive must still surface.
  });
  assert.equal(typeof log.tags.schemaVersion, "string");
  assert.ok(log.tags.schemaVersion.length > 0);
  assert.equal(log.tags.killSwitchActive, false);
});

test("Phase 7 wiring: kill switch forces semantic OFF and surfaces killSwitchActive=true even with flags ON", async () => {
  const fixture = makePhase5Fixture();
  const aggressiveScorer = async () => 0.99; // would otherwise widen everything
  const { payload, log } = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: {
      killSwitch: true,
      enabled: false, // kill switch already forces global to false
      topicsEnabled: false,
      keywordsEnabled: false,
      topicsThreshold: 0.75,
      keywordsThreshold: 0.75,
    },
    semanticTagScorer: aggressiveScorer,
  });
  assert.equal(payload.stories.length, 1);
  assert.equal(log.tags.killSwitchActive, true);
  assert.equal(log.tags.topics.runtimeState, "disabled");
  assert.equal(log.tags.keywords.runtimeState, "disabled");
  // Even with a confident scorer in the slot, semantic uplift must be empty.
  assert.equal(log.tags.topics.acceptedCount, 0);
  assert.equal(log.tags.keywords.acceptedCount, 0);
});

test("Phase 7 wiring: K1a invariant under abort cancellation — funnel counts identical to scorer-OFF", async () => {
  // Inject an embedFn that hangs until its `signal` aborts.  When the scorer
  // wrapper aborts on timeout, embedFn's "aborted" rejection AND the
  // scorer's timeout rejection both fire; the scorer surfaces the timeout
  // attribution, the mapper falls closed, and the pipeline ships the
  // deterministic baseline.  Funnel counts must be identical to a scorer-OFF
  // run over the same fixture.
  const { createEmbeddingSemanticScorer: makeScorer } = await import(
    "./meta-story-semantic-mapper.mjs"
  );
  const fixture = makePhase5Fixture();
  const hangingEmbedFn = (_texts, { signal } = {}) =>
    new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const abortingScorer = makeScorer({ embedFn: hangingEmbedFn, timeoutMs: 25 });

  const off = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  const onAbort = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: abortingScorer,
  });
  // Funnel counts MUST match across OFF and abort-fallback runs.
  assert.deepEqual(onAbort.log.funnel.stages, off.log.funnel.stages);
  assert.equal(onAbort.log.metaStoryCount, off.log.metaStoryCount);
  // Abort fallback surfaces as timeout state at the axis level.
  assert.equal(onAbort.log.tags.keywords.runtimeState, "scorer_timeout_fallback");
  assert.ok(onAbort.log.tags.keywords.fallbackReasonCounts.timeout >= 1);
  // Stories still shipped with deterministic baseline tags.
  assert.equal(onAbort.payload.stories.length, 1);
});

test("Phase 7 wiring: log.tags surfaces scorerCallCount + scorerLatencyMaxMs", async () => {
  const fixture = makePhase5Fixture();
  const readyScorer = async (_evidence, label) => {
    await new Promise((r) => setTimeout(r, 3));
    return label.toLowerCase() === "oil" ? 0.9 : 0.1;
  };
  const { log } = await runRefreshPipeline({
    settings: fixture.settings,
    rawItems: fixture.rawItems,
    clusterFn: async () => [fixture.metaStory],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    semanticTagConfig: PHASE5_SEMANTIC_ON,
    semanticTagScorer: readyScorer,
  });
  // Both axes were exercised on at least one candidate.
  assert.ok(log.tags.keywords.scorerCallCount > 0);
  assert.ok(log.tags.keywords.scorerLatencyMaxMs > 0);
  // Max must never exceed cumulative — basic invariant.
  assert.ok(log.tags.keywords.scorerLatencyMaxMs <= log.tags.keywords.scorerLatencyMs);
});

// ─── Semantic BeatFit (Option A) ─────────────────────────────────────────────
//
// Contract pinned at the pipeline level:
//   1. Lexical-miss / semantic-hit rescue (the ISIS/Nigeria regression).
//   2. Precision posture preserved: irrelevant items still excluded with
//      semantic stage enabled and active.
//   3. Embedding failure (timeout/error) degrades to deterministic-only —
//      refresh completes, no broken snapshot.
//   4. Kill switch (env or override) instantly restores deterministic-only
//      behavior with no other pipeline changes.

const TERRORISM_SETTINGS = {
  contractVersion: "2026-05-19-meta-story-fields",
  topics: ["Terrorism"],
  keywords: ["terrorism"],
  geographies: ["US", "Nigeria"],
  traditionalSources: ["Reuters"],
  socialSources: [],
};

const SEMANTIC_ON = Object.freeze(
  resolveSemanticBeatFitConfig({}, { enabled: true })
);
const SEMANTIC_OFF = Object.freeze(
  resolveSemanticBeatFitConfig({}, { enabled: false })
);
const SEMANTIC_KILL = Object.freeze(
  resolveSemanticBeatFitConfig({}, { killSwitch: true })
);

// Deterministic semantic stub: returns a 2-D vector that maps the user's
// intent profile to one direction and "aligned" items (containing concept
// tokens for terrorism/extremism) to the same direction. Non-aligned items
// land orthogonal so their cosine collapses to ~0 (normalized score ~0.5).
// Keeps the test's semantic-score expectations tight without depending on
// real embedding behavior.
const SEMANTIC_ALIGNMENT_RE = /\b(isis|militant|militants|extremist|extremists|attack|attacks|terror|terrorism)\b/i;

function semanticStubEmbedFn() {
  return async (texts) =>
    texts.map((text) => {
      const s = String(text);
      // Profile text always starts with "I monitor news about" — see
      // semantic-beat-fit.mjs#buildIntentProfileText.
      if (s.startsWith("I monitor news about")) return [1, 0];
      return SEMANTIC_ALIGNMENT_RE.test(s) ? [1, 0] : [0, 1];
    });
}

test("Semantic BeatFit: rescues ISIS/Nigeria-style lexical miss when stage is enabled", async () => {
  // Headline doesn't carry the literal "terrorism" keyword, so deterministic
  // BeatFit would score it below threshold. The semantic stage aligns
  // ISIS/militant/attack with the user's terrorism intent and the blended
  // score crosses the threshold.
  const isisItem = makeItem({
    sourceId: "isis-nigeria",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Other",
    geographies: ["Nigeria"],
    headline: "ISIS militants attack village in northeast Nigeria, dozens killed",
    body: ["Witnesses said extremist fighters launched the assault overnight."],
  });
  const seenIds = [];
  const { payload } = await runRefreshPipeline({
    settings: TERRORISM_SETTINGS,
    rawItems: [isisItem],
    clusterFn: async (items) => {
      seenIds.push(...items.map((i) => i.sourceId));
      return items.map((i) => ({
        meta_story_id: "ms-isis",
        title: "ISIS attack in Nigeria",
        subtitle: "Sub",
        source_item_ids: [i.sourceId],
        summary: "Summary.",
        tags: { topics: ["Terrorism"], keywords: [], geographies: ["Nigeria"] },
        factual_claims: ["A claim."],
        claim_evidence_map: { "0": [i.sourceId] },
      }));
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    semanticBeatFitConfig: SEMANTIC_ON,
    semanticBeatFitEmbedFn: semanticStubEmbedFn(),
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });
  assert.equal(payload.stories.length, 1, "ISIS/Nigeria must survive BeatFit when semantic is enabled");
  assert.ok(seenIds.includes("isis-nigeria"));
});

test("Semantic BeatFit: same ISIS/Nigeria item is excluded when semantic is OFF (regression boundary)", async () => {
  // Same item, semantic stage disabled — confirms it's the semantic stage
  // doing the work, not some other coincidence in fixtures.
  const isisItem = makeItem({
    sourceId: "isis-nigeria-off",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Other",
    geographies: ["Nigeria"],
    headline: "ISIS militants attack village in northeast Nigeria, dozens killed",
    body: ["Witnesses said extremist fighters launched the assault overnight."],
  });
  const { payload, log } = await runRefreshPipeline({
    settings: TERRORISM_SETTINGS,
    rawItems: [isisItem],
    clusterFn: async (items) => items.map((i) => ({
      meta_story_id: "ms-isis-off",
      title: "ISIS attack",
      subtitle: "Sub",
      source_item_ids: [i.sourceId],
      summary: "Summary.",
      tags: { topics: ["Terrorism"], keywords: [], geographies: ["Nigeria"] },
      factual_claims: ["A claim."],
      claim_evidence_map: { "0": [i.sourceId] },
    })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    semanticBeatFitConfig: SEMANTIC_OFF,
    semanticBeatFitEmbedFn: semanticStubEmbedFn(),
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });
  // Either nothing reaches clustering (recall drops) or beat-fit drops it.
  // The contract we want: zero shipped stories when semantic is off.
  assert.equal(payload.stories.length, 0);
  assert.equal(log.semanticBeatFit.enabled, false);
});

test("Semantic BeatFit: irrelevant story still excluded under precision-first posture (no flood)", async () => {
  // Even with the semantic stage on, an obviously off-beat story (low
  // deterministic + low semantic) must not slip through. Locks the
  // precision-first invariant.
  const irrelevantItem = makeItem({
    sourceId: "celeb-yacht",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Other",
    geographies: [],
    headline: "Celebrity buys yacht for tropical vacation",
    body: ["Tabloid coverage of celebrity excess."],
  });
  let clusterCalled = false;
  const { payload } = await runRefreshPipeline({
    settings: TERRORISM_SETTINGS,
    rawItems: [irrelevantItem],
    clusterFn: async () => {
      clusterCalled = true;
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    semanticBeatFitConfig: SEMANTIC_ON,
    semanticBeatFitEmbedFn: semanticStubEmbedFn(),
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });
  assert.equal(payload.stories.length, 0, "irrelevant story must not be promoted by semantic stage");
  assert.equal(clusterCalled, false);
});

test("Semantic BeatFit: embedding failure → deterministic-only, refresh completes with degraded reason", async () => {
  // The semantic embed function rejects; refresh must NOT fail. It falls back
  // to deterministic-only BeatFit. Recall's embedFn still works (we keep that
  // path on a separate stub to isolate the semantic-stage failure).
  const item = makeItem({
    sourceId: "real-kw-hit",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Terrorism",
    geographies: ["US"],
    headline: "Treasury sanctions tied to terrorism financing",
    body: ["The action targets known networks."],
  });
  const { payload, log } = await runRefreshPipeline({
    settings: TERRORISM_SETTINGS,
    rawItems: [item],
    clusterFn: async (items) => items.map((i) => ({
      meta_story_id: "ms-deg",
      title: "Sanctions update",
      subtitle: "Sub",
      source_item_ids: [i.sourceId],
      summary: "Summary.",
      tags: { topics: ["Terrorism"], keywords: [], geographies: ["US"] },
      factual_claims: ["A claim."],
      claim_evidence_map: { "0": [i.sourceId] },
    })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    semanticBeatFitConfig: SEMANTIC_ON,
    semanticBeatFitEmbedFn: async () => {
      throw new Error("provider 503 service unavailable");
    },
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });
  assert.equal(payload.stories.length, 1, "refresh must complete on semantic stage failure");
  assert.equal(log.semanticBeatFit.degraded, true);
  assert.equal(log.semanticBeatFit.degradedReason, "embedding_error");
  // BeatFit should report zero semantic-blend applications since the stage
  // emitted no scores.
  assert.equal(log.beatFit.semanticBlendAppliedCount, 0);
});

test("Semantic BeatFit: kill switch active → stage disabled, deterministic-only path intact", async () => {
  const item = makeItem({
    sourceId: "kill-switch-item",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Terrorism",
    geographies: ["US"],
    headline: "U.S. counterterrorism partnership widens",
    body: ["A bilateral statement was issued."],
  });
  const { log, payload } = await runRefreshPipeline({
    settings: TERRORISM_SETTINGS,
    rawItems: [item],
    clusterFn: async (items) => items.map((i) => ({
      meta_story_id: "ms-kill",
      title: "Counterterror",
      subtitle: "Sub",
      source_item_ids: [i.sourceId],
      summary: "Summary.",
      tags: { topics: ["Terrorism"], keywords: [], geographies: ["US"] },
      factual_claims: ["A claim."],
      claim_evidence_map: { "0": [i.sourceId] },
    })),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    semanticBeatFitConfig: SEMANTIC_KILL,
    semanticBeatFitEmbedFn: semanticStubEmbedFn(),
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });
  assert.equal(log.semanticBeatFit.killSwitchActive, true);
  assert.equal(log.semanticBeatFit.enabled, false);
  assert.equal(log.semanticBeatFit.degradedReason, "kill_switch_active");
  assert.equal(payload.stories.length, 1);
});

test("Semantic BeatFit: log surfaces version, model, latency, and score buckets", async () => {
  const item = makeItem({
    sourceId: "log-shape",
    outlet: "Reuters",
    minutesAgo: 30,
    topic: "Terrorism",
    geographies: ["US"],
    headline: "Terrorism investigation update",
    body: ["Officials confirm."],
  });
  const { log } = await runRefreshPipeline({
    settings: TERRORISM_SETTINGS,
    rawItems: [item],
    clusterFn: async () => [],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    embedFn: stubEmbedFn(),
    recallConfig: HYBRID_RECALL_CONFIG,
    semanticBeatFitConfig: SEMANTIC_ON,
    semanticBeatFitEmbedFn: semanticStubEmbedFn(),
    semanticBeatFitProfileCache: createProfileEmbeddingCache(),
  });
  assert.ok(log.semanticBeatFit, "log.semanticBeatFit must be present");
  for (const f of [
    "version",
    "enabled",
    "killSwitchActive",
    "model",
    "scoredCount",
    "skippedCount",
    "profileCacheHit",
    "latencyMs",
    "scoreBuckets",
    "meanScore",
    "degraded",
    "degradedReason",
  ]) {
    assert.ok(f in log.semanticBeatFit, `log.semanticBeatFit.${f} must be present`);
  }
  assert.equal(typeof log.semanticBeatFit.latencyMs, "number");
});

// ─── What-changed Phase 4: pipeline integration ──────────────────────────────
//
// These tests verify the engine runs per-story after the R1 sort + tag
// overlay, that `log.whatChanged` carries the run-level diagnostics, and
// that the deprecated `Latest update N min ago.` template is gone from
// every shipped story.  LLM stages stay stubbed — production reads env at
// call time and stays disabled by default until an operator opts in.

const PHASE4_ENABLED_CONFIG = {
  enabled: true,
  mockOnly: false,
  classifyModel: "anthropic:claude-haiku-4-5-20251001",
  writeModel: "anthropic:claude-sonnet-4-6",
  timeoutMs: 2500,
};

function assertNoFreshnessTemplate(stories) {
  for (const s of stories) {
    assert.ok(
      !/Latest update .* min ago\./.test(s.whatChanged ?? ""),
      `story "${s.metaStoryId}" still carries the legacy freshness template: "${s.whatChanged}"`
    );
  }
}

test("Phase 4 — first refresh (empty ever-seen): every shipped story gets first-seen copy + log.whatChanged.firstSeen counts", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    everSeenMetaStoryIds: [],
    priorStoriesById: new Map(),
  });
  assert.equal(payload.stories.length, 1);
  assert.equal(payload.stories[0].whatChanged, WHAT_CHANGED_COPY.firstSeen);
  assertNoFreshnessTemplate(payload.stories);
  assert.ok(log.whatChanged);
  assert.equal(log.whatChanged.schemaVersion, WHAT_CHANGED_DIAGNOSTICS_SCHEMA_VERSION);
  assert.equal(log.whatChanged.firstSeen, payload.stories.length);
  assert.equal(log.whatChanged.unchanged, 0);
  assert.equal(log.whatChanged.changed, 0);
  assert.equal(log.whatChanged.classifySkipped, payload.stories.length);
  assert.equal(log.whatChanged.classifyCalled, 0);
  assert.equal(log.whatChanged.everSeenCount, 0);
  assert.equal(log.whatChanged.priorStoryCount, 0);
});

test("Phase 4 — second refresh (same metaStoryId, no structural change): unchanged copy + gateNone increments", async () => {
  const metaStoryId = "diplomatic-relations-developments";
  // The prior story matches the cluster output buildStory will produce
  // (same sources[].id, same headline, same summary), so the gate should
  // see no material change.
  const priorStory = {
    id: metaStoryId,
    metaStoryId,
    title: "Diplomatic Relations Developments",
    subtitle: "Recent diplomatic updates.",
    summary: "Diplomatic relations updates tracked.",
    sources: [
      { id: "src-1", outlet: "Reuters", headline: "Test Headline", minutesAgo: 0, body: ["Test body."] },
    ],
  };
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    everSeenMetaStoryIds: [metaStoryId],
    priorStoriesById: new Map([[metaStoryId, priorStory]]),
  });
  assert.equal(payload.stories[0].whatChanged, WHAT_CHANGED_COPY.unchanged);
  assertNoFreshnessTemplate(payload.stories);
  assert.equal(log.whatChanged.firstSeen, 0);
  assert.equal(log.whatChanged.unchanged, 1);
  assert.equal(log.whatChanged.gateNone, 1);
  assert.equal(log.whatChanged.gateStrong, 0);
  assert.equal(log.whatChanged.classifyCalled, 0);
});

test("Phase 4 — strong gate + deltaConfig enabled + classify/write stubs → state:'changed' with stubbed prose on story", async () => {
  const metaStoryId = "diplomatic-relations-developments";
  // Prior story carries a different set of sources so the gate fires
  // strong (added_source + new_outlet).
  const priorStory = {
    id: metaStoryId,
    metaStoryId,
    title: "Diplomatic Relations Developments",
    subtitle: "Recent diplomatic updates.",
    summary: "Diplomatic relations updates tracked.",
    sources: [
      { id: "src-prior-only", outlet: "AP", headline: "Old headline", minutesAgo: 600, body: ["Old body."] },
    ],
  };
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let classifyCalled = false;
  let writeCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    everSeenMetaStoryIds: [metaStoryId],
    priorStoriesById: new Map([[metaStoryId, priorStory]]),
    deltaConfig: PHASE4_ENABLED_CONFIG,
    classifyFn: async () => { classifyCalled = true; return { material: true, confidence: 0.9, reasonCode: "new_outlet" }; },
    writeFn: async () => { writeCalled = true; return "Reuters joined coverage with a new diplomatic angle."; },
  });
  assert.equal(classifyCalled, true);
  assert.equal(writeCalled, true);
  assert.equal(payload.stories[0].whatChanged, "Reuters joined coverage with a new diplomatic angle.");
  assertNoFreshnessTemplate(payload.stories);
  assert.equal(log.whatChanged.changed, 1);
  assert.equal(log.whatChanged.gateStrong, 1);
  assert.equal(log.whatChanged.classifyCalled, 1);
  assert.equal(log.whatChanged.classifyMaterialTrue, 1);
  assert.equal(log.whatChanged.writeCalled, 1);
  assert.equal(log.whatChanged.writeOk, 1);
});

test("Phase 4 — deltaConfig disabled + strong gate → unchanged copy + classifySkipped (stubs not called)", async () => {
  const metaStoryId = "diplomatic-relations-developments";
  const priorStory = {
    id: metaStoryId,
    metaStoryId,
    title: "Diplomatic Relations Developments",
    subtitle: "Recent diplomatic updates.",
    summary: "Diplomatic relations updates tracked.",
    sources: [
      { id: "src-prior-only", outlet: "AP", headline: "Old headline", minutesAgo: 600, body: ["Old body."] },
    ],
  };
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  let classifyCalled = false;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    everSeenMetaStoryIds: [metaStoryId],
    priorStoriesById: new Map([[metaStoryId, priorStory]]),
    deltaConfig: { ...PHASE4_ENABLED_CONFIG, enabled: false },
    classifyFn: async () => { classifyCalled = true; return { material: true }; },
  });
  assert.equal(classifyCalled, false, "disabled config must veto classify");
  assert.equal(payload.stories[0].whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(log.whatChanged.classifySkipped, 1);
  assert.equal(log.whatChanged.classifyCalled, 0);
  // The gate still ran and saw strong signals.
  assert.equal(log.whatChanged.gateStrong, 1);
});

test("Phase 4 — watermark short-circuit: log.whatChanged.watermarkShortCircuited=true, no payload built, no freshness template emitted", async () => {
  // Run twice with the same input — the second run hits the watermark
  // short-circuit because the candidate set is identical.  The pipeline
  // returns `payload: null` and the engine never runs.
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const first = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    everSeenMetaStoryIds: [],
    priorStoriesById: new Map(),
  });
  const second = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    priorWatermark: first.log.watermark,
    priorStoryCount: first.payload.stories.length,
    everSeenMetaStoryIds: [first.payload.stories[0].metaStoryId],
    priorStoriesById: new Map([[first.payload.stories[0].metaStoryId, first.payload.stories[0]]]),
  });
  assert.equal(second.payload, null, "watermark match must short-circuit payload build");
  assert.equal(second.log.unchanged, true);
  assert.ok(second.log.whatChanged, "log.whatChanged must be present on watermark skip");
  assert.equal(second.log.whatChanged.watermarkShortCircuited, true);
  assert.equal(second.log.whatChanged.firstSeen, 0);
  assert.equal(second.log.whatChanged.unchanged, 0);
  assert.equal(second.log.whatChanged.changed, 0);
  assert.equal(second.log.whatChanged.schemaVersion, WHAT_CHANGED_DIAGNOSTICS_SCHEMA_VERSION);
  // Sanity: first run's stories never carried the freshness template either.
  assertNoFreshnessTemplate(first.payload.stories);
});

test("Phase 4 — no story ever ships the legacy `Latest update … min ago.` template (regression guard)", async () => {
  const rawItems = [
    makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 5 }),
    makeItem({ sourceId: "src-2", outlet: "Reuters", minutesAgo: 60 }),
  ];
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assertNoFreshnessTemplate(payload.stories);
});

// ─── Phase 5 (why-this-matters): doctrine retrieval flows into the writer ───

const PHASE5_WHY_ENABLED_CONFIG = {
  enabled: true,
  mockOnly: false,
  model: "anthropic:claude-sonnet-4-6",
  timeoutMs: 4000,
};

test("Phase 5 — doctrine retrieval output is passed into resolveWhyItMatters and surfaced on trace.doctrineRefs", async () => {
  const stubSnippet = {
    id: "stub.doctrine.bilateral",
    topics: ["Diplomatic relations"],
    geographies: ["US", "Colombia"],
    keywords: [],
    body: "Stub doctrine body.",
    prov: "test-fixture",
  };
  const observedPayloads = [];
  const whyWriteFn = (payload) => {
    observedPayloads.push(payload);
    return {
      text: "Stub implication line — keep baseline monitoring posture across outlets.",
      taxonomyPrimary: "monitoring_intensity",
      confidence: "medium",
    };
  };
  const doctrineRetrievalFn = ({ story, state }) => {
    // The pipeline computes state via the engine-derived mapping; assert it
    // looks like one of the three canonical values.
    assert.ok(["intro", "steady", "evolving"].includes(state));
    assert.ok(story?.metaStoryId);
    return [stubSnippet];
  };
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    everSeenMetaStoryIds: [],
    priorStoriesById: new Map(),
    whyConfig: PHASE5_WHY_ENABLED_CONFIG,
    whyWriteFn,
    doctrineRetrievalFn,
  });
  assert.equal(payload.stories.length, 1);
  // Writer received the doctrine snippets that the retrieval function
  // returned — verifying the pipeline wires retrieval -> writer.
  assert.equal(observedPayloads.length, 1, "writer must run once for the shipped story");
  assert.equal(observedPayloads[0].doctrineSnippets.length, 1);
  assert.equal(observedPayloads[0].doctrineSnippets[0].id, "stub.doctrine.bilateral");
  // Trace records the snippet ids that were passed to the writer.
  const trace = payload._whyItMattersTraces[payload.stories[0].metaStoryId];
  assert.ok(trace);
  assert.deepEqual(trace.doctrineRefs, ["stub.doctrine.bilateral"]);
});

test("Phase 5 — doctrine retrieval throw is caught and writer still runs with []", async () => {
  const observedPayloads = [];
  const whyWriteFn = (payload) => {
    observedPayloads.push(payload);
    return {
      text: "Stub line — keep baseline monitoring posture across outlets.",
      taxonomyPrimary: "monitoring_intensity",
      confidence: "medium",
    };
  };
  const doctrineRetrievalFn = () => {
    throw new Error("simulated corpus failure");
  };
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const { payload } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    everSeenMetaStoryIds: [],
    priorStoriesById: new Map(),
    whyConfig: PHASE5_WHY_ENABLED_CONFIG,
    whyWriteFn,
    doctrineRetrievalFn,
  });
  // Writer ran even though retrieval threw — fail-closed to [] (spec §5).
  assert.equal(observedPayloads.length, 1);
  assert.deepEqual(observedPayloads[0].doctrineSnippets, []);
  assert.equal(payload.stories.length, 1);
  const trace = payload._whyItMattersTraces[payload.stories[0].metaStoryId];
  assert.deepEqual(trace.doctrineRefs, []);
});

// ─── Slice 2: post-cluster split healer integration ──────────────────────────
//
// These pin the wiring of `splitOverMergedClusters` into the pipeline (between
// clustering and ID lineage). The unit-level split policy is covered in
// cluster-split-healer.test.mjs; here we assert the end-to-end payload effect
// and the `log.clusterSplit` diagnostics surface.

// Two unrelated Colombia stories the clusterFn deliberately over-merges into a
// single meta-story — the case the healer exists to undo.
const SPLIT_ELECTION_ITEM = {
  sourceId: "co-election",
  outlet: "Reuters",
  topic: "Diplomatic relations",
  geographies: ["Colombia"],
  weight: 75,
  minutesAgo: 30,
  headline: "Colombia presidential candidates clash in final election debate",
  body: ["Voters head to the polls next month to choose a new president."],
};
const SPLIT_MINE_ITEM = {
  sourceId: "co-mine",
  outlet: "Reuters",
  topic: "Diplomatic relations",
  geographies: ["Colombia"],
  weight: 75,
  minutesAgo: 45,
  headline: "Armed group attacks Colombia gold mine, killing several workers",
  body: ["Authorities blame an illegal armed faction for the deadly assault."],
};

// One merged meta-story carrying both unrelated source items.
function mergedColombiaMetaStory() {
  return {
    meta_story_id: "merged-colombia",
    title: "Colombia Developments",
    subtitle: "Recent developments in colombia.",
    source_item_ids: ["co-election", "co-mine"],
    summary: "merged",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["Colombia"] },
    factual_claims: ["election claim", "mine claim"],
    claim_evidence_map: { "0": ["co-election"], "1": ["co-mine"] },
  };
}

test("runRefreshPipeline (Slice 2): merged unrelated Colombia stories get split into 2", async () => {
  const rawItems = [
    makeItem(SPLIT_ELECTION_ITEM),
    makeItem(SPLIT_MINE_ITEM),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [mergedColombiaMetaStory()],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.equal(payload.stories.length, 2, "healer should split the over-merge into 2 stories");
  assert.ok(log.clusterSplit, "log.clusterSplit diagnostics must be present");
  assert.equal(log.clusterSplit.enabled, true);
  assert.ok(log.clusterSplit.splitCount >= 1, "splitCount must reflect at least one split");
  assert.equal(log.clusterSplit.inputCount, 1);
  assert.equal(log.clusterSplit.outputCount, 2);
  // Each split story carries its own source headline as the title.
  const titles = payload.stories.map((s) => s.title).sort();
  assert.deepEqual(titles, [
    "Armed group attacks Colombia gold mine, killing several workers",
    "Colombia presidential candidates clash in final election debate",
  ]);
});

test("runRefreshPipeline (Slice 2): healer disabled keeps the merged story (1)", async () => {
  const rawItems = [
    makeItem(SPLIT_ELECTION_ITEM),
    makeItem(SPLIT_MINE_ITEM),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async () => [mergedColombiaMetaStory()],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    clusterSplitConfig: SPLIT_HEALER_DISABLED,
  });

  assert.equal(payload.stories.length, 1, "disabled healer must leave the merge intact");
  assert.equal(log.clusterSplit.enabled, false);
  assert.equal(log.clusterSplit.splitCount, 0);
  assert.equal(log.clusterSplit.outputCount, 1);
});

test("runRefreshPipeline (Slice 2): a same-event election pair is not split", async () => {
  const rawItems = [
    makeItem({
      sourceId: "co-elec-a",
      outlet: "Reuters",
      topic: "Diplomatic relations",
      geographies: ["Colombia"],
      minutesAgo: 30,
      headline: "Colombia presidential election debate draws record viewers",
      body: ["The presidential debate covered tax reform and security policy."],
    }),
    makeItem({
      sourceId: "co-elec-b",
      outlet: "Reuters",
      topic: "Diplomatic relations",
      geographies: ["Colombia"],
      minutesAgo: 45,
      headline: "Colombia presidential election debate sparks tax reform clash",
      body: ["Candidates argued over tax reform and security during the debate."],
    }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    // Single merged story with corroborated (shared-source) claim evidence so
    // neither the low-overlap nor the disjoint-claim split path fires.
    clusterFn: async () => [
      {
        meta_story_id: "same-event-election",
        title: "Colombia Election Debate",
        subtitle: "Coverage of the presidential debate.",
        source_item_ids: ["co-elec-a", "co-elec-b"],
        summary: "merged",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["Colombia"] },
        factual_claims: ["Candidates debated tax reform and security"],
        claim_evidence_map: { "0": ["co-elec-a", "co-elec-b"] },
      },
    ],
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });

  assert.equal(payload.stories.length, 1, "high-overlap same-event pair must stay merged");
  assert.equal(log.clusterSplit.splitCount, 0);
});
test("runRefreshPipeline Phase 5: parallel why respects concurrency and beats serial wall-clock (order preserved)", async () => {
  // Slice 6: Phase 5 now fans the per-story why-it-matters resolver calls out
  // through a bounded `pMap` pool instead of awaiting them serially.  Pins:
  //   1. every story still gets a non-empty whyItMatters,
  //   2. payload story order is the deterministic R1 order (unaffected by why
  //      completion order),
  //   3. wall-clock for the stage reflects parallel waves, not the serial sum.
  const STORY_COUNT = 6;
  const PER_STORY_DELAY_MS = 100;
  const localDelay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Six distinct stories so none get merged/deduped before Phase 5.  Built off
  // MOCK_META_STORIES[0] (which grounds against the rawItems) with unique
  // ids/titles/sources.  Ids are lexically ascending so the R1 tiebreaker
  // (metaStoryId) yields the same order as construction.
  const clusterStories = Array.from({ length: STORY_COUNT }, (_, i) => ({
    ...MOCK_META_STORIES[0],
    meta_story_id: `ms-why-par-${i}`,
    title: `Parallel why story ${i}: US Colombia diplomatic developments`,
    subtitle: `Subtitle ${i} - multiple outlets report on developments`,
    summary: `Summary ${i}: diplomatic relations updates tracked across outlets.`,
    source_item_ids: ["src-1"],
  }));

  let inFlight = 0;
  let maxInFlight = 0;

  const prevConc = process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY;
  process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "4";
  try {
    const { payload, log } = await runRefreshPipeline({
      settings: BASE_SETTINGS,
      rawItems: [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })],
      clusterFn: async () => clusterStories,
      clusterModel: "mock-anthropic-haiku",
      contractVersion: "2026-05-19-meta-story-fields",
      deltaConfig: { enabled: false },
      whyConfig: PHASE5_WHY_ENABLED_CONFIG,
      whyWriteFn: async (payload) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await localDelay(PER_STORY_DELAY_MS);
        inFlight -= 1;
        return {
          text: `Parallel implications copy for ${payload?.state ?? "steady"} state, sufficiently long to pass the validation gates.`,
          taxonomyPrimary: "monitoring_intensity",
          confidence: "medium",
        };
      },
    });

    const whyStories = payload.stories.filter((s) => s.metaStoryId.startsWith("ms-why-par-"));
    assert.equal(whyStories.length, STORY_COUNT, "all six stories survive to the payload");
    for (const s of whyStories) {
      assert.ok(s.whyItMatters && s.whyItMatters.length > 0, `whyItMatters populated for ${s.metaStoryId}`);
    }

    // R1: payload order is the deterministic server-canonical order.  With
    // equal beat-fit / recency, the metaStoryId tiebreaker yields ascending
    // ms-why-par-0..5 — and crucially it is NOT driven by why completion order
    // (the Slice 6 invariant: parallel apply preserves order).
    const expectedOrder = clusterStories.map((s) => s.meta_story_id).slice().sort();
    assert.deepEqual(
      payload.stories.map((s) => s.metaStoryId),
      expectedOrder,
      "story order in payload is the deterministic R1 order, independent of parallel completion order (R1)"
    );

    // Concurrency cap honored — at most 4 why writers in flight; with 6 stories
    // and cap 4 the ceiling is actually reached.
    assert.ok(maxInFlight <= 4, `max in-flight why writers must be <= 4, saw ${maxInFlight}`);
    assert.equal(maxInFlight, 4, "concurrency 4 with 6 stories must reach the cap");

    // Stage telemetry surfaced on the returned log.
    assert.equal(log.whyItMatters.whyConcurrency, 4, "whyConcurrency surfaced on log.whyItMatters");
    assert.equal(typeof log.whyItMatters.whyMs, "number", "whyMs surfaced on log.whyItMatters");

    // Wall-clock proof: serial would be 6 * 100 = ~600ms; parallel with cap 4
    // is two waves (4 then 2) ~ 200ms.  Generous threshold well under serial.
    assert.ok(
      log.whyItMatters.whyMs < STORY_COUNT * PER_STORY_DELAY_MS * 0.85, // 0.85 margin absorbs GHA runner jitter while staying clearly under serial
      `parallel why wall-clock (${log.whyItMatters.whyMs}ms) must beat serial ~${STORY_COUNT * PER_STORY_DELAY_MS}ms`
    );
  } finally {
    if (prevConc === undefined) delete process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY;
    else process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = prevConc;
  }
});


test("runRefreshPipeline Phase 5 (D2): persistent resolver throw → story dropped after one retry, others survive", async () => {
  // D2 fail-closed-per-story: a resolver that throws even after the single
  // retry is an unrecoverable transient failure — the story is DROPPED from the
  // published set (not shipped with safe-fallback copy), while the global
  // refresh succeeds and the other stories ship normally.  This pins the policy
  // change vs the pre-D2 fail-open behavior.
  const REJECT_ID = "ms-why-reject-1";
  const stories = [0, 1, 2].map((i) => ({
    ...MOCK_META_STORIES[0],
    meta_story_id: `ms-why-reject-${i}`,
    title: `Reject-path story ${i}: US Colombia diplomatic developments`,
    subtitle: `Subtitle ${i} - outlets report developments`,
    summary: `Summary ${i}: diplomatic relations updates tracked across outlets.`,
    source_item_ids: ["src-1"],
  }));
  // Always throws for one story (both the initial attempt AND the D2 retry);
  // returns a valid resolver-shaped result for the others.
  let rejectCalls = 0;
  const resolveWhyItMattersFn = (input) => {
    if (input.metaStoryId === REJECT_ID) {
      rejectCalls += 1;
      throw new Error("synthetic resolver explosion");
    }
    return {
      whyItMatters: `OK copy for ${input.metaStoryId}`,
      trace: { metaStoryId: input.metaStoryId, state: input.state, fallback_used: false },
      diagnostics: { fallbackUsed: false, writerOk: true, latencyMs: { write: 0, rewrite: 0 } },
    };
  };

  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })],
    clusterFn: async () => stories,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    deltaConfig: { enabled: false },
    whyConfig: PHASE5_WHY_ENABLED_CONFIG,
    resolveWhyItMattersFn,
  });

  // The persistently-failing story is dropped — not in the payload, no trace.
  const failed = payload.stories.find((s) => s.metaStoryId === REJECT_ID);
  assert.equal(failed, undefined, "the persistently-failing story is dropped from the payload");
  assert.equal(payload._whyItMattersTraces[REJECT_ID], undefined, "no trace persisted for a dropped story");

  // Single retry: the resolver was invoked exactly twice for the failing story.
  assert.equal(rejectCalls, 2, "exactly one retry — initial attempt + one retry, then drop");

  // The global refresh still succeeds and the other two stories ship normally.
  const others = payload.stories.filter((s) => s.metaStoryId !== REJECT_ID);
  assert.equal(others.length, 2, "two non-failing stories ship (global refresh not failed)");
  for (const s of others) {
    assert.equal(s.whyItMatters, `OK copy for ${s.metaStoryId}`, `normal copy for ${s.metaStoryId}`);
    assert.equal(payload._whyItMattersTraces[s.metaStoryId].fallback_used, false, `${s.metaStoryId} did not fall back`);
  }

  // D2 stability diagnostics: 3 eligible, 1 dropped by the why stage, 2 survive
  // (retention 2/3 ≈ 0.667 ≥ the 0.5 guardrail).
  assert.equal(log.narrativeStability.policy, "fail_closed_per_story");
  assert.equal(log.narrativeStability.eligible, 3);
  assert.equal(log.narrativeStability.survived, 2);
  assert.equal(log.narrativeStability.dropped, 1);
  assert.equal(log.narrativeStability.whyItMatters.retried, 1, "one why-stage retry recorded");
  assert.equal(log.narrativeStability.whyItMatters.dropped, 1);
  assert.deepEqual(log.narrativeStability.droppedStoryIds, [REJECT_ID]);
  assert.ok(log.narrativeStability.retentionRate >= 0.5, "retention clears the 50% guardrail");
});


test("runRefreshPipeline (D2): what-changed write failure → story dropped after one retry; others survive", async () => {
  // Drive the what-changed stage via the `resolveWhatChangedFn` seam so the
  // failure is deterministic without setting up a structural-gate prior. The
  // targeted story returns a write-failure result on EVERY attempt; the others
  // return a healthy result. Expect: targeted story dropped after exactly one
  // retry, global refresh succeeds, the rest ship.
  const FAIL_ID = "ms-wc-fail-1";
  const stories = [0, 1, 2].map((i) => ({
    ...MOCK_META_STORIES[0],
    meta_story_id: `ms-wc-fail-${i}`,
    title: `WC-fail story ${i}: US Colombia diplomatic developments`,
    subtitle: `Subtitle ${i} - outlets report developments`,
    summary: `Summary ${i}: diplomatic relations updates tracked across outlets.`,
    source_item_ids: ["src-1"],
  }));
  let failCalls = 0;
  const wcWriteFailed = {
    state: "unchanged",
    whatChanged: "",
    gate: { signal: "strong", reasons: ["stub_fail"] },
    diagnostics: {
      classifySkipped: false, classifyCalled: true, classifyMaterial: true,
      writeCalled: true, writeOk: false,
      llmFailed: { classify: false, write: true, hallucination: false },
      latencyMs: { classify: 0, write: 0 },
    },
  };
  const wcOk = (id) => ({
    state: "changed",
    whatChanged: `Changed copy for ${id}.`,
    gate: { signal: "strong", reasons: ["stub_ok"] },
    diagnostics: {
      classifySkipped: false, classifyCalled: true, classifyMaterial: true,
      writeCalled: true, writeOk: true,
      llmFailed: { classify: false, write: false, hallucination: false },
      latencyMs: { classify: 0, write: 0 },
    },
  });
  const resolveWhatChangedFn = (input) => {
    if (input.metaStoryId === FAIL_ID) { failCalls += 1; return Promise.resolve(wcWriteFailed); }
    return Promise.resolve(wcOk(input.metaStoryId));
  };

  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })],
    clusterFn: async () => stories,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    deltaConfig: { enabled: true },
    everSeenMetaStoryIds: stories.map((s) => s.meta_story_id),
    resolveWhatChangedFn,
  });

  // Targeted story dropped; others survive; one retry only.
  assert.equal(payload.stories.find((s) => s.metaStoryId === FAIL_ID), undefined, "failing story dropped");
  assert.equal(failCalls, 2, "exactly one retry for the failing story (initial + retry)");
  assert.equal(payload.stories.length, 2, "two stories survive — global refresh not failed");
  for (const s of payload.stories) {
    assert.equal(s.whatChanged, `Changed copy for ${s.metaStoryId}.`, `survivor ${s.metaStoryId} keeps its copy`);
  }
  // D2 diagnostics reflect the what-changed-stage drop.
  assert.equal(log.narrativeStability.eligible, 3);
  assert.equal(log.narrativeStability.survived, 2);
  assert.equal(log.narrativeStability.whatChanged.retried, 1);
  assert.equal(log.narrativeStability.whatChanged.dropped, 1);
  assert.equal(log.narrativeStability.whyItMatters.dropped, 0);
  assert.deepEqual(log.narrativeStability.droppedStoryIds, [FAIL_ID]);
});


test("runRefreshPipeline Phase 5: parallel apply is index-ordered, not completion-ordered (R1)", async () => {
  // Reverse the completion order vs input order (descending delay by index) and
  // prove the payload still ships in deterministic R1 order — pinning that the
  // index-aligned apply pass, not pMap completion order, drives story order.
  const N = 4;
  const completion = [];
  const stories = Array.from({ length: N }, (_, i) => ({
    ...MOCK_META_STORIES[0],
    meta_story_id: `ms-why-order-${i}`,
    title: `Order story ${i}: US Colombia diplomatic developments`,
    subtitle: `Subtitle ${i} - outlets report developments`,
    summary: `Summary ${i}: diplomatic relations updates tracked across outlets.`,
    source_item_ids: ["src-1"],
  }));
  // Story 0 waits longest, story N-1 shortest → completion order is reversed.
  const resolveWhyItMattersFn = async (input) => {
    const idx = Number(String(input.metaStoryId).split("-").pop());
    await new Promise((r) => setTimeout(r, (N - idx) * 40));
    completion.push(input.metaStoryId);
    return {
      whyItMatters: `Order copy ${idx}`,
      trace: { metaStoryId: input.metaStoryId, state: input.state, fallback_used: false },
      diagnostics: { fallbackUsed: false, writerOk: true, latencyMs: { write: 0, rewrite: 0 } },
    };
  };

  const prevConc = process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY;
  process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "4"; // all four resolve in one wave
  try {
    const { payload } = await runRefreshPipeline({
      settings: BASE_SETTINGS,
      rawItems: [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })],
      clusterFn: async () => stories,
      clusterModel: "mock-anthropic-haiku",
      contractVersion: "2026-05-19-meta-story-fields",
      deltaConfig: { enabled: false },
      whyConfig: PHASE5_WHY_ENABLED_CONFIG,
      resolveWhyItMattersFn,
    });

    const order = payload.stories.map((s) => s.metaStoryId);
    assert.deepEqual(
      order,
      ["ms-why-order-0", "ms-why-order-1", "ms-why-order-2", "ms-why-order-3"],
      "payload ships in deterministic R1 (metaStoryId) order"
    );
    // Completion order is the reverse — proving the order assertion is meaningful
    // (payload order is NOT a side effect of which resolver finished first).
    assert.deepEqual(
      completion,
      ["ms-why-order-3", "ms-why-order-2", "ms-why-order-1", "ms-why-order-0"],
      "resolvers completed in reverse-of-input order"
    );
    assert.notDeepEqual(completion, order, "completion order must differ from payload order");
    for (const s of payload.stories) {
      assert.ok(s.whyItMatters && s.whyItMatters.length > 0, `whyItMatters populated for ${s.metaStoryId}`);
    }
  } finally {
    if (prevConc === undefined) delete process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY;
    else process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = prevConc;
  }
});


test("Slice 7: log.timings exposes non-negative integer per-stage wall-clock; whyMs === whyItMatters.whyMs", async () => {
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })],
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.ok(log.timings && typeof log.timings === "object", "log.timings present on a full run");
  assert.equal(typeof log.timings.whyMs, "number"); // plan-required
  for (const k of ["preClusterMs", "geoMs", "recallMs", "clusterMs", "whatChangedMs", "whyMs", "pipelineMs"]) {
    const v = log.timings[k];
    assert.equal(typeof v, "number", `${k} is a number`);
    assert.ok(Number.isFinite(v) && v >= 0, `${k} >= 0`);
    assert.equal(v, Math.trunc(v), `${k} is an integer ms`);
  }
  assert.equal(log.timings.whyMs, log.whyItMatters.whyMs, "single source of truth for whyMs");
  // Non-overlapping brackets must not exceed the outer envelope (small slack
  // for inter-bracket overhead). Under-counting is fine: the build/sort/tag
  // span between clusterMs and whatChangedMs is intentionally unattributed.
  assert.ok(
    log.timings.preClusterMs + log.timings.geoMs + log.timings.recallMs + log.timings.clusterMs +
      log.timings.whatChangedMs + log.timings.whyMs <= log.timings.pipelineMs + 50,
    "non-overlapping stage timings should not exceed pipelineMs by much"
  );
  // Additive: existing per-stage diagnostic latency fields untouched.
  assert.ok("latencyMs" in log.whyItMatters, "whyItMatters.latencyMs preserved");
  assert.ok("latencyMs" in log.whatChanged, "whatChanged.latencyMs preserved");
  assert.ok("clusteringLatencyMs" in log, "clusteringLatencyMs preserved");
});

test("Slice 3: log.outcomes rolls up stories, clustering, and geo-assess counts coherently", async () => {
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems: [
      // explicit_match (geographies overlap configured) — included WITHOUT an
      // assess call, so it must NOT count toward geoAssessedCount.
      makeItem({ sourceId: "match-1", outlet: "Reuters", minutesAgo: 30, geographies: ["US"] }),
      // implicit_geo (no geographies) — hits the assessor (mock → 0.85 ≥ 0.80).
      makeItem({ sourceId: "implicit-1", outlet: "Reuters", minutesAgo: 30, geographies: [] }),
    ],
    clusterFn: async () => MOCK_META_STORIES,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.ok(log.outcomes && typeof log.outcomes === "object", "log.outcomes present on a full run");
  // Each outcome mirrors the authoritative top-level field — a single source of
  // truth, just rolled up for the summary/SLO surfaces.
  assert.equal(log.outcomes.storiesPublished, log.metaStoryCount, "storiesPublished mirrors metaStoryCount");
  assert.equal(log.outcomes.clusteringAttempts, log.clusteringAttempts);
  assert.equal(log.outcomes.clusteringFailureReason, log.clusteringFailureReason);
  assert.equal(log.outcomes.usedFallbackClustering, log.usedFallbackClustering);
  assert.equal(log.outcomes.geoHeldCount, log.geoHeldCount, "geoHeldCount mirrors top-level count");
  // Only the implicit_geo item was assessed; the explicit_match item bypassed
  // the assessor entirely.
  assert.equal(log.outcomes.geoAssessedCount, 1, "exactly one item hit the geo assessor");
});

// ─── C1: deterministic cluster input cap ─────────────────────────────────────

test("C1 ranking: compareClusterInputItems orders by beatFitScore desc, then minutesAgo asc, then sourceId asc", () => {
  // beatFitScore dominates regardless of recency / id.
  const byScore = [
    { sourceId: "low", beatFitScore: 0.1, minutesAgo: 5 },
    { sourceId: "high", beatFitScore: 0.9, minutesAgo: 500 },
    { sourceId: "mid", beatFitScore: 0.5, minutesAgo: 1 },
  ].slice().sort(compareClusterInputItems);
  assert.deepEqual(byScore.map((i) => i.sourceId), ["high", "mid", "low"]);

  // Equal score → fresher (smaller minutesAgo) wins.
  const byRecency = [
    { sourceId: "older", beatFitScore: 0.5, minutesAgo: 50 },
    { sourceId: "fresher", beatFitScore: 0.5, minutesAgo: 10 },
  ].slice().sort(compareClusterInputItems);
  assert.deepEqual(byRecency.map((i) => i.sourceId), ["fresher", "older"]);

  // Equal score AND recency → sourceId ascending is the stable final tie-break.
  const byId = [
    { sourceId: "zeta", beatFitScore: 0.5, minutesAgo: 10 },
    { sourceId: "alpha", beatFitScore: 0.5, minutesAgo: 10 },
  ].slice().sort(compareClusterInputItems);
  assert.deepEqual(byId.map((i) => i.sourceId), ["alpha", "zeta"]);

  // Missing beatFitScore sorts as 0 (below any positive-scored item).
  const missingScore = [
    { sourceId: "scored", beatFitScore: 0.01, minutesAgo: 100 },
    { sourceId: "unscored", minutesAgo: 1 },
  ].slice().sort(compareClusterInputItems);
  assert.deepEqual(missingScore.map((i) => i.sourceId), ["scored", "unscored"]);
});

test("C1 cap: applyClusterInputCap slices to 15 and reports dropped IDs beyond the cap", () => {
  assert.equal(CLUSTER_INPUT_CAP, 15);
  // 20 items, beatFitScore descending with sourceId so the rank order is
  // unambiguous: src-00 (highest score) … src-19 (lowest).
  const items = Array.from({ length: 20 }, (_, i) => ({
    sourceId: `src-${String(i).padStart(2, "0")}`,
    beatFitScore: (20 - i) / 20,
    minutesAgo: 30,
  }));
  const { clusterInputItems, diagnostics } = applyClusterInputCap(items);
  assert.equal(clusterInputItems.length, 15);
  assert.deepEqual(
    clusterInputItems.map((i) => i.sourceId),
    Array.from({ length: 15 }, (_, i) => `src-${String(i).padStart(2, "0")}`)
  );
  assert.equal(diagnostics.dedupedCount, 20);
  assert.equal(diagnostics.clusterInputCount, 15);
  assert.equal(diagnostics.clusterDroppedCount, 5);
  assert.deepEqual(diagnostics.clusterDroppedSourceIds, [
    "src-15",
    "src-16",
    "src-17",
    "src-18",
    "src-19",
  ]);
});

test("C1 cap: applyClusterInputCap is a no-op when input is at/under the cap", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    sourceId: `src-${i}`,
    beatFitScore: 0.5,
    minutesAgo: i,
  }));
  const { clusterInputItems, diagnostics } = applyClusterInputCap(items);
  assert.equal(clusterInputItems.length, 10);
  assert.equal(diagnostics.dedupedCount, 10);
  assert.equal(diagnostics.clusterInputCount, 10);
  assert.equal(diagnostics.clusterDroppedCount, 0);
  assert.deepEqual(diagnostics.clusterDroppedSourceIds, []);
});

test("C1 integration: exactly 15 items reach clusterFn when dedupedItems > 15", async () => {
  // 20 relevant items, fresher = smaller minutesAgo. With beat-fit bypassed all
  // scores tie at 0, so the cap ranking falls to minutesAgo asc — the 15
  // freshest survive and the 5 oldest are dropped.
  const rawItems = Array.from({ length: 20 }, (_, i) =>
    makeItem({ sourceId: `src-${String(i).padStart(2, "0")}`, minutesAgo: i * 10 })
  );
  let clusterInput = null;
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => {
      clusterInput = items;
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    beatFitEnabled: false,
  });
  assert.ok(clusterInput, "clusterFn must be invoked");
  assert.equal(clusterInput.length, 15, "exactly 15 candidates passed to clustering");
  assert.deepEqual(
    clusterInput.map((i) => i.sourceId).sort(),
    Array.from({ length: 15 }, (_, i) => `src-${String(i).padStart(2, "0")}`),
    "the 15 freshest candidates survive the cap"
  );
  // Diagnostics consistent with the actual clusterInput slice.
  assert.equal(log.clusterCap.dedupedCount, 20);
  assert.equal(log.clusterCap.clusterInputCount, 15);
  assert.equal(log.clusterCap.clusterDroppedCount, 5);
  assert.deepEqual(
    log.clusterCap.clusterDroppedSourceIds.slice().sort(),
    ["src-15", "src-16", "src-17", "src-18", "src-19"],
    "dropped IDs are the 5 oldest, beyond the cap"
  );
});

test("C1 integration: no cap effect when dedupedItems <= 15", async () => {
  const rawItems = Array.from({ length: 10 }, (_, i) =>
    makeItem({ sourceId: `src-${i}`, minutesAgo: i })
  );
  let clusterInput = null;
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => {
      clusterInput = items;
      return [];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    beatFitEnabled: false,
  });
  assert.ok(clusterInput, "clusterFn must be invoked");
  assert.equal(clusterInput.length, 10, "all candidates passed through when under the cap");
  assert.equal(log.clusterCap.dedupedCount, 10);
  assert.equal(log.clusterCap.clusterInputCount, 10);
  assert.equal(log.clusterCap.clusterDroppedCount, 0);
  assert.deepEqual(log.clusterCap.clusterDroppedSourceIds, []);
});

// ─── Slice 3: profile-aware cluster input cap ────────────────────────────────

test("Slice 3: cold_start tightens the cluster cap to 10 (effective cap surfaced)", async () => {
  // 14 Lane-1 items (default fixtures carry a geo signal from a selected source,
  // so cold_start's Lane 2 defer doesn't strip them) — more than the cold_start
  // cap of 10 so the tighter cap actually bites.
  const rawItems = Array.from({ length: 14 }, (_, i) =>
    makeItem({ sourceId: `src-${String(i).padStart(2, "0")}`, minutesAgo: i * 10 })
  );
  let clusterInput = null;
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { clusterInput = items; return []; },
    clusterModel: "mock-anthropic-sonnet",
    contractVersion: "2026-05-19-meta-story-fields",
    refreshProfile: "cold_start",
    beatFitEnabled: false,
  });
  assert.ok(clusterInput, "clusterFn must be invoked");
  assert.ok(clusterInput.length <= 10, "cold_start passes at most 10 candidates to clustering");
  assert.equal(log.clusterCap.clusterInputCount, clusterInput.length,
    "diagnostics clusterInputCount matches the actual clusterFn input");
  assert.ok(log.clusterCap.clusterInputCount <= 10);
  assert.equal(log.clusterCap.clusterInputCapEffective, 10,
    "cold_start surfaces the profile cap (10) as the effective cap");
});

test("Slice 3: default profile keeps CLUSTER_INPUT_CAP (15) as the effective cap", async () => {
  // 20 items under the default profile — the global cap (15) still governs, and
  // the effective-cap diagnostic reports 15 (not the cold_start 10).
  const rawItems = Array.from({ length: 20 }, (_, i) =>
    makeItem({ sourceId: `src-${String(i).padStart(2, "0")}`, minutesAgo: i * 10 })
  );
  let clusterInput = null;
  const { log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn: async (items) => { clusterInput = items; return []; },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
    beatFitEnabled: false,
  });
  assert.ok(clusterInput, "clusterFn must be invoked");
  assert.equal(clusterInput.length, CLUSTER_INPUT_CAP, "default cap (15) still governs");
  assert.equal(clusterInput.length, 15);
  assert.equal(log.clusterCap.clusterInputCount, 15);
  assert.equal(log.clusterCap.clusterInputCapEffective, CLUSTER_INPUT_CAP,
    "default profile surfaces the global cap (15) as the effective cap");
  assert.equal(log.clusterCap.clusterInputCapEffective, 15);
});

// ─── C2: clustering repair diagnostics plumbing ──────────────────────────────

test("C2 plumbing: repair diagnostics from a successful clusterFn surface on _meta", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  // Simulate clusterItems attaching repair diagnostics to the returned array
  // (the production path uses a non-enumerable property; an own property reads
  // identically through readClusteringRepairDiagnostics).
  const clusterFn = async () => {
    const stories = MOCK_META_STORIES.slice();
    stories._clusteringRepair = { attempted: true, succeeded: true, failureReason: null };
    return stories;
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 1, "stories still publish when repair succeeded");
  assert.equal(log.clusteringRepairAttempted, true);
  assert.equal(log.clusteringRepairSucceeded, true);
  assert.equal(log.clusteringRepairFailureReason, null);
  // Slice 3 back-compat: a producer that attaches only the legacy 3-field
  // shape normalizes to null on the new fields (no undefined leakage).
  assert.equal(log.clusteringRepairRawFailureClass, null);
  assert.equal(log.clusteringRepairSchemaErrorBucket, null);
  assert.equal(log.clusteringRepairCoercion, null);
  // Fail-closed policy untouched: a successful (repaired) run is not a fallback.
  assert.equal(log.usedFallbackClustering, false);
});

test("C2 plumbing: failed-repair diagnostics ride the thrown error and surface fail-closed", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  // Both attempts throw an error carrying repair diagnostics (mirrors the
  // parser attaching `_clusteringRepair` to the thrown error).
  let attempts = 0;
  const clusterFn = async () => {
    attempts++;
    const err = new Error("Clustering response parse failed after safe-trim repair: bad json");
    err._clusteringRepair = { attempted: true, succeeded: false, failureReason: "json_parse_error" };
    throw err;
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  // Fail-closed semantics intact: retried once (2 attempts) then zero stories.
  assert.equal(attempts, 2, "retry count behavior unchanged (initial + one retry)");
  assert.equal(payload.stories.length, 0, "fail-closed: zero stories published");
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(log.clusteringAttempts, 2);
  assert.equal(log.clusteringFailureReason, "error");
  // C2 repair diagnostics reflect the last attempt.
  assert.equal(log.clusteringRepairAttempted, true);
  assert.equal(log.clusteringRepairSucceeded, false);
  assert.equal(log.clusteringRepairFailureReason, "json_parse_error");
});

// ─── Slice 3: structured-output hardening diagnostics plumbing ───────────────

test("Slice 3 plumbing: repairable run surfaces rawFailureClass + coercion and still publishes", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  // Mirrors the parser recovering a bare-array response via array_wrap: the raw
  // output was schema-invalid, the single repair pass wrapped it, and stories
  // publish.  The pipeline must surface the full Slice 3 diagnostic set.
  const clusterFn = async () => {
    const stories = MOCK_META_STORIES.slice();
    stories._clusteringRepair = {
      attempted: true,
      succeeded: true,
      failureReason: null,
      rawFailureClass: "schema_validation_error",
      schemaErrorBucket: "invalid_type",
      coercion: "array_wrap",
    };
    return stories;
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(payload.stories.length, 1, "recovered stories publish");
  assert.equal(log.usedFallbackClustering, false, "a recovered run is not a fallback");
  assert.equal(log.clusteringFailureReason, null, "recovered run is not a clustering failure");
  assert.equal(log.clusteringRepairSucceeded, true);
  assert.equal(log.clusteringRepairRawFailureClass, "schema_validation_error");
  assert.equal(log.clusteringRepairSchemaErrorBucket, "invalid_type");
  assert.equal(log.clusteringRepairCoercion, "array_wrap");
  // Follow-up semantics lock: the explicit recovered flag is true, and the
  // raw-class/schema-bucket fields being non-null must NOT make this look like
  // a failure — the TERMINAL failure fields stay clean on a recovered run.
  assert.equal(log.clusteringRepairRecovered, true, "recovered flag is true on a repaired+published run");
  assert.ok(
    log.clusteringRepairRawFailureClass !== null && log.clusteringFailureReason === null,
    "raw failure observed (non-null rawFailureClass) yet NOT a terminal failure (clusteringFailureReason null)"
  );
  // A failure rollup keyed on terminal fields counts this run as a success.
  assert.equal(log.outcomes.clusteringFailureReason, null);
  assert.equal(log.outcomes.usedFallbackClustering, false);
});

test("Slice 3 plumbing: schema-bucketed fail-closed surfaces bucket and keeps clusteringFailureReason non-null (Slice 1 continuity)", async () => {
  const rawItems = [makeItem({ sourceId: "src-1", outlet: "Reuters", minutesAgo: 30 })];
  const clusterFn = async () => {
    const err = new Error("Clustering response parse failed after safe-trim repair: too many meta-stories");
    err._clusteringRepair = {
      attempted: true,
      succeeded: false,
      failureReason: "schema_validation_error",
      rawFailureClass: "schema_validation_error",
      schemaErrorBucket: "too_many_meta_stories",
      coercion: null,
    };
    throw err;
  };
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    clusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  // Fail-closed honesty: zero stories, no fabricated fallback buckets.
  assert.equal(payload.stories.length, 0, "fail-closed: zero stories");
  assert.equal(log.usedFallbackClustering, true);
  // Slice 1 continuity gate: clusteringFailureReason MUST be non-null on a
  // parse/schema fail-closed (a schema bucket is still an `error`, not a timeout).
  assert.equal(log.clusteringFailureReason, "error");
  assert.equal(log.clusteringAttempts, 2);
  // Slice 3 buckets surface for triage.
  assert.equal(log.clusteringRepairSucceeded, false);
  assert.equal(log.clusteringRepairFailureReason, "schema_validation_error");
  assert.equal(log.clusteringRepairRawFailureClass, "schema_validation_error");
  assert.equal(log.clusteringRepairSchemaErrorBucket, "too_many_meta_stories");
  // Follow-up semantics lock: a terminal fail-closed run is NOT recovered, and
  // the failure rollup (keyed on terminal fields) counts it as a failure.
  assert.equal(log.clusteringRepairRecovered, false, "terminal fail-closed is not recovered");
  assert.equal(log.outcomes.clusteringFailureReason, "error");
  assert.equal(log.outcomes.usedFallbackClustering, true);
});

test("Slice 3 follow-up: SLO does not overcount a recovered run as a failure (terminal-field guard)", () => {
  // A recovered run reaches the SLO evaluator with clusteringAttempts>0 and a
  // null (terminal) clusteringFailureReason — even though its raw diagnostics
  // are non-null.  It must sample the timeout window as a NON-timeout and never
  // contribute to the cluster_timeout_rate breach.
  _resetSloState();
  const recovered = evaluateRefreshSlo({
    pipelineMs: 10,
    clusteringFailureReason: null, // terminal field — recovered runs are null here
    clusteringAttempts: 1,
  });
  assert.equal(recovered.windowSize, 1, "recovered run is sampled (it attempted clustering)");
  assert.equal(recovered.clusterTimeoutRate, 0, "recovered run counts as a non-timeout, not a failure");
  assert.deepEqual(recovered.breaches, [], "no breach from a recovered run");
});

// ─── PR B Step 1: Option B clustering auto-recovery tier ──────────────────────
//
// A non-timeout (parse/schema-style) primary clustering failure triggers ONE
// bounded recovery attempt on a reduced (top-half, min 6) candidate set.
// Recovery success publishes recovered stories and clears the fail-closed
// flags; recovery failure preserves the fail-closed (0 stories) outcome. Timeout
// failures never trigger recovery. No `gracefulFallbackClustering` buckets ever.

// 10 relevant items (beat-fit bypassed) so exactly 10 reach clustering and the
// reduced recovery cap (max(6, floor(10/2))=6) genuinely shrinks the input.
function makeRecoveryRawItems(n = 10) {
  return Array.from({ length: n }, (_, i) =>
    makeItem({ sourceId: `src-${i}`, outlet: "Reuters", minutesAgo: i })
  );
}

test("PR B recovery: non-timeout error → recovery on reduced input succeeds and publishes", async () => {
  const rawItems = makeRecoveryRawItems(10);
  // Recovered story references src-0 (freshest → ranked first → inside the
  // reduced set) and carries no factual_claims, so it grounds and publishes.
  const recoveredStory = {
    meta_story_id: "recovered-1",
    title: "Recovered Story",
    subtitle: "Recovered after reduced-input retry.",
    source_item_ids: ["src-0"],
    summary: "Recovered.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US", "Colombia"] },
  };
  let calls = 0;
  let recoveryInputLen = null;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    beatFitEnabled: false,
    clusterFn: async (items) => {
      calls += 1;
      if (calls <= 2) {
        // Primary attempts (initial + one retry) fail with a non-timeout error.
        const err = new Error("Clustering response parse failed: schema validation");
        err._clusteringRepair = { attempted: true, succeeded: false, failureReason: "schema_validation_error" };
        throw err;
      }
      recoveryInputLen = items.length; // the reduced recovery set
      return [recoveredStory];
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(calls, 3, "2 primary attempts + 1 recovery attempt");
  assert.equal(recoveryInputLen, 6, "recovery used the reduced (50%, min 6) input");
  assert.equal(payload.stories.length, 1, "recovered story is published");
  assert.equal(log.usedFallbackClustering, false, "recovery clears fail-closed");
  assert.equal(log.clusteringFailureReason, null, "no terminal failure after recovery");
  assert.equal(log.clusteringRecoveryAttempted, true);
  assert.equal(log.clusteringRecoverySucceeded, true);
  assert.equal(log.clusteringRecoveryReason, null);
  assert.equal(log.clusteringAttempts, 3, "attempt count includes the recovery attempt");
  assert.equal(log.clusteringLatencyMs.length, 3, "one latency sample per attempt incl. recovery");
});

test("PR B recovery: recovery also fails → remains fail-closed with recovery flags set", async () => {
  const rawItems = makeRecoveryRawItems(10);
  let calls = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    beatFitEnabled: false,
    clusterFn: async () => {
      calls += 1;
      const err = new Error("Clustering response parse failed: schema validation");
      err._clusteringRepair = { attempted: true, succeeded: false, failureReason: "schema_validation_error" };
      throw err;
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(calls, 3, "2 primary attempts + 1 recovery attempt");
  assert.equal(payload.stories.length, 0, "fail-closed preserved: zero stories (no fallback buckets)");
  // No fabricated "* Updates"/"General Updates" buckets ever ship.
  assert.deepEqual(payload.stories, [], "no gracefulFallbackClustering stories");
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(log.clusteringFailureReason, "error", "terminal reason preserved");
  assert.equal(log.clusteringRecoveryAttempted, true);
  assert.equal(log.clusteringRecoverySucceeded, false);
  assert.equal(log.clusteringRecoveryReason, "error", "recovery's own failure class");
  assert.equal(log.clusteringAttempts, 3);
});

test("PR B recovery: timeout-class failure does NOT trigger recovery", async () => {
  const rawItems = makeRecoveryRawItems(10);
  let calls = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    beatFitEnabled: false,
    clusterFn: async () => {
      calls += 1;
      throw new Error("Anthropic clustering timed out (claude-sonnet-4-6)");
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(calls, 2, "timeout path keeps the locked 2-attempt behavior — no recovery call");
  assert.equal(payload.stories.length, 0, "fail-closed on timeout");
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(log.clusteringFailureReason, "timeout");
  assert.equal(log.clusteringRecoveryAttempted, false, "recovery not attempted for timeouts");
  assert.equal(log.clusteringRecoverySucceeded, false);
  assert.equal(log.clusteringRecoveryReason, null);
  assert.equal(log.clusteringAttempts, 2);
});

test("PR B recovery: small candidate set (no genuine reduction) does NOT trigger recovery", async () => {
  // 6 items → reduced cap max(6, floor(6/2))=6 → no actual shrink → recovery is
  // skipped (it would be an identical retry). Locks the reducibility guard.
  const rawItems = makeRecoveryRawItems(6);
  let calls = 0;
  const { payload, log } = await runRefreshPipeline({
    settings: BASE_SETTINGS,
    rawItems,
    beatFitEnabled: false,
    clusterFn: async () => {
      calls += 1;
      const err = new Error("Clustering response parse failed: schema validation");
      err._clusteringRepair = { attempted: true, succeeded: false, failureReason: "schema_validation_error" };
      throw err;
    },
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-05-19-meta-story-fields",
  });
  assert.equal(calls, 2, "no recovery call when the set cannot be reduced");
  assert.equal(payload.stories.length, 0, "fail-closed preserved");
  assert.equal(log.usedFallbackClustering, true);
  assert.equal(log.clusteringFailureReason, "error");
  assert.equal(log.clusteringRecoveryAttempted, false);
  assert.equal(log.clusteringAttempts, 2);
});

});
