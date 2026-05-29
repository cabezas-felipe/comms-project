/**
 * Dashboard Refresh Golden — Core (side-effect-free)
 *
 * Regression harness for the failed dashboard E2E that shipped:
 *   - exactly one degraded "General Updates"-style meta-story,
 *   - a Spelling Bee liveblog stack (no cross-feed/liveblog collapse),
 *   - no Reuters content, and
 *   - clustering fallback output on the publish path.
 *
 * Each scenario runs `runRefreshPipeline` against the bundled golden fixture
 * (`dashboard-refresh.gold.json`) with injected stubs (clusterFn / embedFn) so
 * the suite is deterministic and CI-safe — no live RSS, no Anthropic, no
 * embedding provider. A separate smoke command may exercise real providers.
 *
 * Import-safe: no env reads beyond the per-run threshold pin, no console, no
 * `process.exit`. The `.test.mjs` (wired as `npm run eval:dashboard-refresh-golden`)
 * drives formatting + exit via node:test.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GOLD_PATH = path.resolve(__dirname, "dashboard-refresh.gold.json");

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

// ─── Recall config presets ───────────────────────────────────────────────────
//
// Pin per-scenario so behavior doesn't depend on the process-wide
// TEMPO_RECALL_MODE (mutated by other test files).

const KEYWORD = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

// hybrid_strict with the Slice 1 similarity floor explicitly set so the
// recall-floor scenario exercises the gate (the floor is disabled when
// minSimilarity is absent from the config).
const HYBRID_WITH_FLOOR = Object.freeze({
  mode: "hybrid_strict",
  embedTopK: 5,
  embedMaxItems: 100,
  minSimilarity: 0.35,
  embeddingModel: "text-embedding-3-small",
});

// ─── Fixture loading ─────────────────────────────────────────────────────────

export function loadGold() {
  return JSON.parse(readFileSync(GOLD_PATH, "utf8"));
}

// ─── Cluster stub builders ───────────────────────────────────────────────────

// Build a grounded meta-story from a list of source items — mirrors the shape
// cluster-engine returns. Each claim maps to the cluster's sourceIds so
// verifyGrounding keeps the story.
function makeGroundedCluster({ id, title, sourceItems, summary }) {
  const sourceIds = sourceItems.map((i) => i.sourceId);
  return {
    meta_story_id: id,
    title,
    subtitle: "Composed from grounded sources.",
    source_item_ids: sourceIds,
    summary: summary ?? `${title}.`,
    tags: {
      topics: [sourceItems[0]?.topic].filter(Boolean),
      keywords: [],
      geographies: [...new Set(sourceItems.flatMap((i) => i.geographies ?? []))],
    },
    factual_claims: ["A claim grounded in the cited sources."],
    claim_evidence_map: { "0": sourceIds },
  };
}

// Healthy clustering: split the deduped input into TWO grounded meta-stories so
// the golden path yields metaStoryCount >= 2 with honest, non-degraded titles.
function healthyClusterFn(items) {
  if (!items || items.length === 0) return Promise.resolve([]);
  const mid = Math.max(1, Math.ceil(items.length / 2));
  const first = items.slice(0, mid);
  const second = items.slice(mid);
  const clusters = [
    makeGroundedCluster({
      id: "gold-ms-1",
      title: "US–Iran sanctions standoff sharpens",
      sourceItems: first,
    }),
  ];
  if (second.length > 0) {
    clusters.push(
      makeGroundedCluster({
        id: "gold-ms-2",
        title: "Economy and elections shape the agenda",
        sourceItems: second,
      })
    );
  }
  return Promise.resolve(clusters);
}

// Clustering that always throws — drives the fail-closed path (retried once by
// the pipeline, then zero stories).
function throwingClusterFn() {
  return Promise.reject(new Error("simulated clustering provider failure"));
}

// Capture clusterFn: records exactly what reached the cluster stage (the
// deduped candidate pool) and returns zero clusters. Used to assert pre-cluster
// funnel behavior (liveblog dedupe, recall floor) without producing stories.
function captureClusterFn(capture) {
  return (items) => {
    capture.input = items;
    return Promise.resolve([]);
  };
}

// Deterministic 2-d embedder for the recall-floor scenario. Profile is [1,0];
// the off-beat gardening item gets a near-orthogonal vector (cosine ≈ 0.10,
// below the 0.35 floor) so it is rejected as a weak semantic-only add. All
// other items are keyword hits, so their semantic score is irrelevant.
function makeFloorEmbedder() {
  return async (texts) =>
    texts.map((t, idx) => {
      if (idx === 0) return [1, 0]; // profile
      const lower = String(t).toLowerCase();
      if (lower.includes("garden") || lower.includes("plant")) return [0.1, 1];
      return [1, 0];
    });
}

const TITLE_DEGRADED_RE = /updates?$/i;

// Exported so the calibration core (which shares this fixture + pipeline)
// reuses the exact same degraded-title guard instead of re-declaring it.
export function hasDegradedTitle(stories) {
  return stories.some((s) => {
    const t = (s?.title ?? "").trim();
    return TITLE_DEGRADED_RE.test(t) || /general updates/i.test(t);
  });
}

// ─── Scenario runners ────────────────────────────────────────────────────────

async function scenarioFailClosed(gold) {
  const { payload, log } = await runRefreshPipeline({
    settings: gold.persona,
    rawItems: gold.onBeatItems,
    clusterFn: throwingClusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD,
    beatFitEnabled: false,
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  if (stories.length !== 0) reasons.push(`expected 0 stories, got ${stories.length}`);
  if (log?.usedFallbackClustering !== true) reasons.push("usedFallbackClustering must be true on clustering failure");
  if (log?.clusteringFailureReason !== "error") reasons.push(`expected clusteringFailureReason=error, got ${log?.clusteringFailureReason}`);
  if (log?.clusteringAttempts !== 2) reasons.push(`expected 2 clustering attempts (initial + retry), got ${log?.clusteringAttempts}`);
  if (hasDegradedTitle(stories)) reasons.push("a degraded 'updates'/'General Updates' title shipped");
  return { ok: reasons.length === 0, reasons, diagnostics: { stories, usedFallbackClustering: log?.usedFallbackClustering, clusteringFailureReason: log?.clusteringFailureReason, clusteringAttempts: log?.clusteringAttempts } };
}

async function scenarioHealthyPath(gold) {
  const { payload, log } = await runRefreshPipeline({
    settings: gold.persona,
    rawItems: gold.onBeatItems,
    clusterFn: healthyClusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD,
    beatFitEnabled: false,
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  if (stories.length < 2) reasons.push(`healthy clustering must yield >= 2 stories, got ${stories.length}`);
  if (log?.usedFallbackClustering !== false) reasons.push("usedFallbackClustering must be false on the healthy path");
  if ((log?.metaStoryCount ?? 0) < 2) reasons.push(`metaStoryCount must be >= 2, got ${log?.metaStoryCount}`);
  if (hasDegradedTitle(stories)) reasons.push("a degraded 'updates'/'General Updates' title shipped on the healthy path");
  // Reuters must be represented (the failed E2E lost all Reuters content).
  const outlets = new Set(stories.flatMap((s) => (s.sources ?? []).map((src) => src.outlet)));
  if (!outlets.has("Reuters")) reasons.push("no Reuters content surfaced in the healthy path");
  return { ok: reasons.length === 0, reasons, diagnostics: { storyCount: stories.length, titles: stories.map((s) => s.title), outlets: [...outlets] } };
}

async function scenarioLiveblogDedupe(gold) {
  const capture = { input: null };
  const rawItems = [...gold.onBeatItems, ...gold.liveblogVariants];
  const { log } = await runRefreshPipeline({
    settings: gold.persona,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD,
    beatFitEnabled: false,
  });

  const reasons = [];
  const clusterInput = capture.input ?? [];
  const spellingBee = clusterInput.filter((i) => /spelling bee/i.test(i.headline ?? ""));
  if (spellingBee.length !== 1) {
    reasons.push(`expected exactly 1 Spelling Bee item to reach clustering after dedupe, got ${spellingBee.length}`);
  }
  // The winner should be the newest snapshot (smallest minutesAgo among the 4).
  if (spellingBee.length === 1 && spellingBee[0].sourceId !== "lb-4") {
    reasons.push(`expected newest liveblog snapshot (lb-4) to survive, got ${spellingBee[0].sourceId}`);
  }
  if ((log?.dedupe?.collapsedCount ?? 0) < 3) {
    reasons.push(`expected >= 3 liveblog duplicates collapsed, got ${log?.dedupe?.collapsedCount}`);
  }
  return { ok: reasons.length === 0, reasons, diagnostics: { clusterInputIds: clusterInput.map((i) => i.sourceId), collapsedCount: log?.dedupe?.collapsedCount } };
}

async function scenarioRecallFloor(gold) {
  const capture = { input: null };
  const rawItems = [...gold.onBeatItems, gold.weakSemanticItem];
  const { log } = await runRefreshPipeline({
    settings: gold.persona,
    rawItems,
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: HYBRID_WITH_FLOOR,
    embedFn: makeFloorEmbedder(),
    beatFitEnabled: false,
  });

  const reasons = [];
  const clusterInput = capture.input ?? [];
  const ids = clusterInput.map((i) => i.sourceId);
  if (log?.recall?.minSimilarityThreshold !== 0.35) {
    reasons.push(`expected recall.minSimilarityThreshold=0.35, got ${log?.recall?.minSimilarityThreshold}`);
  }
  if ((log?.recall?.similarityRejected ?? 0) < 1) {
    reasons.push(`expected >= 1 weak semantic-only item rejected by the floor, got ${log?.recall?.similarityRejected}`);
  }
  if (ids.includes("weak-semantic-1")) {
    reasons.push("weak semantic-only item below the floor leaked into clustering");
  }
  return { ok: reasons.length === 0, reasons, diagnostics: { clusterInputIds: ids, similarityRejected: log?.recall?.similarityRejected, minSimilarityThreshold: log?.recall?.minSimilarityThreshold } };
}

// ─── Scenario registry ───────────────────────────────────────────────────────

const SCENARIO_DEFS = Object.freeze([
  { id: "gold-01-fail-closed", intent: "Clustering throws twice → 0 stories, fail-closed, no degraded titles", run: scenarioFailClosed },
  { id: "gold-02-healthy-path", intent: "Healthy clustering → >= 2 grounded stories, Reuters present, no degraded titles", run: scenarioHealthyPath },
  { id: "gold-03-liveblog-dedupe", intent: "Spelling Bee liveblog variants collapse to one before clustering", run: scenarioLiveblogDedupe },
  { id: "gold-04-recall-floor", intent: "Weak semantic-only item is excluded by the similarity floor", run: scenarioRecallFloor },
]);

export const DASHBOARD_GOLDEN_SCENARIO_IDS = Object.freeze(SCENARIO_DEFS.map((d) => d.id));

/**
 * Run all golden scenarios. Pure: no console, no exits. Pins the beat-fit
 * threshold defensively (scenarios disable beat-fit, but the pin keeps the run
 * independent of ambient env).
 */
export async function runDashboardRefreshGolden() {
  const gold = loadGold();
  const results = [];
  for (const def of SCENARIO_DEFS) {
    let outcome;
    try {
      outcome = await def.run(gold);
    } catch (err) {
      outcome = { ok: false, reasons: [`scenario threw: ${err instanceof Error ? err.message : String(err)}`], diagnostics: { error: true } };
    }
    results.push({ id: def.id, intent: def.intent, ok: outcome.ok, reasons: outcome.reasons ?? [], diagnostics: outcome.diagnostics ?? {} });
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    results,
    summary: { total: results.length, passed, failed: results.length - passed, hardFail: results.some((r) => !r.ok) },
  };
}
