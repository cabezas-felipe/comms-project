/**
 * Embed-floor Calibration — Core (side-effect-free)
 *
 * Sweeps `TEMPO_EMBED_MIN_SIMILARITY` (the recall cosine floor for
 * SEMANTIC-ONLY top-K union adds) across candidate values and reports objective
 * diagnostics per value, so we can compare floors with evidence instead of
 * guessing. It does NOT change any runtime default — it only injects a floor
 * via `recallConfig` per run.
 *
 * Reuses the golden fixture (`loadGold`) + `runRefreshPipeline`. To make the
 * floor's effect *measurable*, the harness adds four deterministic
 * "semantic-only" probe items pinned at cosine bands 0.33 / 0.38 / 0.43 / 0.48
 * (no keyword/topic match, so they enter recall ONLY via the embedding floor).
 * As the floor rises, more probes are rejected — a clean monotonic trend the
 * table surfaces via `similarityRejected` and `finalStories`.
 *
 * Hermetic + import-safe: deterministic stubs (clusterFn / embedFn), no live
 * RSS / Anthropic / embedding provider, no env reads, no console, no
 * `process.exit`. The CLI runner (`run-dashboard-calibration.mjs`) handles
 * formatting + exit codes.
 */

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";
import { loadGold, hasDegradedTitle } from "./dashboard-refresh-golden-core.mjs";

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

// Default sweep. `0` is the debug baseline (floor disabled); 0.35/0.40/0.45 are
// the calibration band documented in DECISIONS.md (D-063 addendum). Production
// default stays 0.40.
export const DEFAULT_CALIBRATION_FLOORS = Object.freeze([0, 0.35, 0.4, 0.45]);

// Semantic-only probe definitions, pinned at distinct cosine bands so the floor
// sweep rejects a different count at each step:
//   floor 0    → reject 0  (all 4 admitted)
//   floor 0.35 → reject 1  (0.33)
//   floor 0.40 → reject 2  (0.33, 0.38)
//   floor 0.45 → reject 3  (0.33, 0.38, 0.43)
// Outlets are real Batch-1 publishers so they clear source selection; topic
// "Other" + keyword-free text keep them out of lexical recall (semantic only).
const PROBE_DEFS = Object.freeze([
  { band: 0.33, sourceId: "cal-probe-33", outlet: "Reuters", marker: "cosineband33" },
  { band: 0.38, sourceId: "cal-probe-38", outlet: "Reuters", marker: "cosineband38" },
  { band: 0.43, sourceId: "cal-probe-43", outlet: "The Washington Post", marker: "cosineband43" },
  { band: 0.48, sourceId: "cal-probe-48", outlet: "The Washington Post", marker: "cosineband48" },
]);

function makeProbeItem(def, i) {
  return {
    sourceId: def.sourceId,
    feedId: "cal-probe",
    outlet: def.outlet,
    kind: "traditional",
    weight: 70,
    byline: "Staff",
    minutesAgo: 12 + i,
    url: `https://example.com/calibration/${def.sourceId}`,
    topic: "Other", // not in persona topics → no topic recall hit
    geographies: ["US"], // matches a persona geo → clears the geo gate
    headline: `Regional logistics outlook segment ${i + 1}`,
    body: [`Calibration probe ${def.marker} semantic only candidate.`],
  };
}

// Deterministic embedder. Profile is the unit vector [1,0]; a probe's vector is
// chosen so its cosine vs the profile equals its pinned band (vector
// [c, sqrt(1-c^2)] has cosine c against [1,0]). Everything else (keyword hits)
// gets cosine 1.0 — irrelevant, since keyword/topic hits bypass the floor.
function makeCalibrationEmbedder() {
  return async (texts) =>
    texts.map((t, idx) => {
      if (idx === 0) return [1, 0]; // profile
      const lower = String(t).toLowerCase();
      const hit = PROBE_DEFS.find((p) => lower.includes(p.marker));
      if (hit) {
        const c = hit.band;
        return [c, Math.sqrt(Math.max(0, 1 - c * c))];
      }
      return [1, 0];
    });
}

function calibrationConfig(minSimilarity) {
  return {
    mode: "hybrid_strict",
    // Large enough that every candidate is inside top-K, so the FLOOR (not the
    // top-K cap) is the only gate on semantic-only adds — keeps the sweep clean.
    embedTopK: 50,
    embedMaxItems: 100,
    minSimilarity,
    embeddingModel: "text-embedding-3-small",
  };
}

// Grounded meta-story shape (mirrors cluster-engine output so verifyGrounding
// keeps it). One story per deduped item so `finalStories` tracks the candidate
// pool size as the floor changes.
function makeGroundedCluster(id, item) {
  const sourceIds = [item.sourceId];
  return {
    meta_story_id: id,
    title: item.headline || `Story ${id}`,
    subtitle: "Composed from grounded sources.",
    source_item_ids: sourceIds,
    summary: `${item.headline}.`,
    tags: {
      topics: [item.topic].filter(Boolean),
      keywords: [],
      geographies: item.geographies ?? [],
    },
    factual_claims: ["A claim grounded in the cited sources."],
    claim_evidence_map: { "0": sourceIds },
  };
}

function calibrationClusterFn(capture) {
  return (items) => {
    capture.input = items;
    return Promise.resolve(items.map((it, i) => makeGroundedCluster(`cal-ms-${i}`, it)));
  };
}

// ─── Guardrails ──────────────────────────────────────────────────────────────
//
// HARD FAIL (any floor) — these are correctness regressions, not tuning knobs:
//   • clustering fail-closed triggered (usedFallbackClustering === true)
//   • degraded generic title regression ("General Updates" / "* Updates")
//   • no Reuters presence in the story pool (fixture expects Reuters)
//   • liveblog dedupe regression (the 4-variant stack failed to collapse)
//
// SOFT METRICS (informational, never fail): finalStories delta and
// similarityRejected trend across floors — these are the calibration signal.
function evaluateGuardrails({ stories, log, reutersCount }) {
  const failures = [];
  if (log?.usedFallbackClustering === true) {
    failures.push("clustering fail-closed triggered (usedFallbackClustering=true)");
  }
  if (hasDegradedTitle(stories)) {
    failures.push("degraded generic title regression ('* Updates' / 'General Updates')");
  }
  if (reutersCount === 0) {
    failures.push("no Reuters presence in story pool");
  }
  if ((log?.dedupe?.collapsedCount ?? 0) < 3) {
    failures.push(`liveblog dedupe regression (collapsed=${log?.dedupe?.collapsedCount ?? 0}, expected >= 3)`);
  }
  return failures;
}

/**
 * Run the floor sweep. Returns structured rows + a hardFail flag. Pure: no
 * console, no exits.
 *
 * @param {object} [opts]
 * @param {number[]} [opts.floors] — floor values to sweep (default 0/0.35/0.40/0.45)
 */
export async function runDashboardCalibration({ floors = DEFAULT_CALIBRATION_FLOORS } = {}) {
  const gold = loadGold();
  const probes = PROBE_DEFS.map(makeProbeItem);
  // onBeat (keyword hits) + liveblog variants (collapse check) + semantic probes.
  const rawItems = [...gold.onBeatItems, ...gold.liveblogVariants, ...probes];

  const rows = [];
  for (const floor of floors) {
    const capture = { input: null };
    const { payload, log } = await runRefreshPipeline({
      settings: gold.persona,
      rawItems,
      clusterFn: calibrationClusterFn(capture),
      clusterModel: "mock-anthropic-haiku",
      contractVersion: CONTRACT_VERSION,
      recallConfig: calibrationConfig(floor),
      embedFn: makeCalibrationEmbedder(),
      beatFitEnabled: false,
    });
    const stories = payload?.stories ?? [];
    const reutersCount = stories.reduce(
      (n, s) => n + (s.sources ?? []).filter((src) => src.outlet === "Reuters").length,
      0
    );
    const failures = evaluateGuardrails({ stories, log, reutersCount });
    rows.push({
      floor,
      finalStories: stories.length,
      usedFallbackClustering: log?.usedFallbackClustering === true,
      clusteringFailureReason: log?.clusteringFailureReason ?? null,
      keywordRecallCount: log?.recall?.keywordRecallCount ?? null,
      finalRelevant: log?.recall?.finalRelevant ?? null,
      similarityRejected: log?.recall?.similarityRejected ?? null,
      minSimilarityThreshold: log?.recall?.minSimilarityThreshold ?? null,
      reutersCount,
      liveblogCollapsed: log?.dedupe?.collapsedCount ?? null,
      failures,
    });
  }

  return { rows, hardFail: rows.some((r) => r.failures.length > 0) };
}

// Stable identity for the JSON artifact so consumers can validate they're
// reading the right harness/shape. Bump `version` only on a breaking shape
// change.
export const CALIBRATION_ARTIFACT_HARNESS = "dashboard-embed-floor-calibration";
export const CALIBRATION_ARTIFACT_VERSION = 1;

/**
 * Build a machine-readable artifact from a calibration result. Pure — the
 * caller supplies `timestamp` (ISO string) so this stays deterministic/testable
 * (no `Date` inside). Renames each row's internal `failures` array to a stable
 * `guardrail: { pass, reasons }` shape for consumers.
 *
 * @param {{ rows: Array, hardFail: boolean }} result
 * @param {{ timestamp: string }} opts
 */
export function buildCalibrationArtifact({ rows, hardFail }, { timestamp }) {
  return {
    harness: CALIBRATION_ARTIFACT_HARNESS,
    version: CALIBRATION_ARTIFACT_VERSION,
    timestamp,
    productionDefaultFloor: 0.4,
    floors: rows.map((r) => r.floor),
    overall: { pass: !hardFail, hardFail },
    rows: rows.map((r) => ({
      floor: r.floor,
      finalStories: r.finalStories,
      usedFallbackClustering: r.usedFallbackClustering,
      clusteringFailureReason: r.clusteringFailureReason,
      keywordRecallCount: r.keywordRecallCount,
      finalRelevant: r.finalRelevant,
      similarityRejected: r.similarityRejected,
      minSimilarityThreshold: r.minSimilarityThreshold,
      reutersCount: r.reutersCount,
      liveblogCollapsed: r.liveblogCollapsed,
      guardrail: { pass: r.failures.length === 0, reasons: r.failures },
    })),
  };
}
