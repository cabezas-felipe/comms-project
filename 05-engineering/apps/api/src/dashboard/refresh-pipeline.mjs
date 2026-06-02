import { normalizeSourceItems } from "../ingestion/source-normalizer.mjs";
import {
  verifyGrounding,
  generateMetaStoryId,
  readClusteringRepairDiagnostics,
} from "../ai/cluster-engine.mjs";
import {
  applyGeoFilter,
  mockAssessGeoConfidence,
  GEO_CATEGORY,
  categorizeItem,
  resolveGeoAssessConcurrency,
  createGeoDiagnostics,
} from "./geo-filter.mjs";
import {
  normalizeTopicLabel,
  normalizeSourceIdentity,
  geographySchema,
  topicSchema,
} from "../contracts-runtime/index.mjs";
import {
  resolveSelectedSources,
  buildMatchedOutletSet,
  buildMatchedFeedIdSet,
  filterItemsToMatchedFeeds,
  SELECTION_MODE,
  FALLBACK_REASON,
} from "../ingestion/source-matcher.mjs";
import { computeWatermark, watermarksMatch } from "./refresh-watermark.mjs";
import {
  applyBeatFitFilter,
  BEAT_FIT_VERSION,
  readBeatFitThreshold,
} from "./beat-fit-scorer.mjs";
import { itemMentionsConfiguredGeography } from "./geo-lexical-match.mjs";
import {
  resolveRecallConfig,
  runEmbeddingRecall,
} from "../ingestion/embedding-recall.mjs";
import {
  TRANSLATION_COVERAGE_THRESHOLD,
  computeStoryCoverage,
  readBodyText,
  readHeadline,
  resolveTranslationConfig,
  translateEvidenceItems,
} from "../ingestion/evidence-translator.mjs";
import {
  SEMANTIC_BEAT_FIT_VERSION,
  attachSemanticScores,
  computeSemanticBeatFitScores,
  resolveSemanticBeatFitConfig,
} from "./semantic-beat-fit.mjs";
import { dedupeSourceItems } from "../ingestion/source-deduper.mjs";
import { assignMetaStoryTags, assignMetaStoryTagsDetailed } from "./meta-story-tags.mjs";
import {
  TAGS_DIAGNOSTICS_SCHEMA_VERSION,
  accumulateAxisDiagnostics,
  emptyAggregateAxisDiagnostics,
  resolveSemanticTagConfig,
} from "./meta-story-semantic-mapper.mjs";
import {
  WHAT_CHANGED_COPY,
  aggregateWhatChangedDiagnostics,
  emptyWhatChangedRunDiagnostics,
  resolveWhatChanged,
} from "./what-changed-engine.mjs";
import {
  WHY_FALLBACK_COPY,
  aggregateWhyItMattersDiagnostics,
  deriveWhyStateFromWhatChangedState,
  emptyWhyItMattersRunDiagnostics,
  resolveWhyConcurrencyConfig,
  resolveWhyConfig,
  resolveWhyItMatters,
  safeWhyFallbackForState,
} from "./why-this-matters-engine.mjs";
import { retrieveDoctrineSnippetsForStory } from "./why-doctrine-retrieval.mjs";
import {
  splitOverMergedClusters,
  resolveClusterSplitConfig,
} from "./cluster-split-healer.mjs";
import { pMap } from "../util/p-map.mjs";
import {
  isWhatChangedFailure,
  isWhyItMattersFailure,
  runStageWithSingleRetry,
  buildNarrativeStabilityDiagnostics,
} from "./narrative-stability.mjs";

// ─── A1.1: geo-stage time budget ─────────────────────────────────────────────
//
// The geo stage assesses every implicit/conflict candidate through the (rate-
// limited, retrying) Haiku assessor.  Under heavy load that pool can run long
// enough to push total refresh latency past what a user will wait.  A1.1 caps
// the stage with a wall-clock budget: Lane 1 (protected must-see) always
// finishes, and Lane 2 (opportunistic) is processed only while the budget
// holds — the remainder is deferred to the hold path for next refresh.
export const GEO_STAGE_BUDGET_MS_DEFAULT = 25000;

/**
 * Resolve the geo-stage wall-clock budget (ms) from
 * `TEMPO_AI_GEO_STAGE_BUDGET_MS`.  Defaults to 25000 when unset or misconfigured
 * (non-finite / <= 0).  Exported so tests can pin the default without driving
 * the full pipeline.
 */
export function resolveGeoStageBudgetMs() {
  const n = Number(process.env.TEMPO_AI_GEO_STAGE_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : GEO_STAGE_BUDGET_MS_DEFAULT;
}

// ─── Slice 4: interactive fast-path refresh profile ──────────────────────────
//
// Onboarding → Dashboard fires an INTERACTIVE refresh: a human is staring at a
// spinner waiting for their first stories.  The default profile is tuned for
// background/scheduled refreshes where total yield matters more than wall
// clock; for the interactive entry we trade a slice of opportunistic geo
// assessment + clustering retry budget for a materially faster first paint
// (Balanced target: 20–30s).  The profile ONLY changes latency-shaping knobs —
// it never relaxes a trust guardrail:
//   - Geo Lane 1 (protected must-see) still always finishes; only Lane 2
//     opportunistic assessment is bounded sooner, deferring the remainder to
//     the hold path for the next refresh (geography relevance is preserved,
//     not removed).
//   - Clustering still fails closed (zero stories, no fabricated fallback) and
//     Slice 1 snapshot continuity still applies at the route layer.
//
// All knobs are env-overridable so ops can retune the band without a deploy.
//
// Slice 4.1 (balanced-safe calibration): the original Slice 4 values traded too
// much resilience for latency — an 8s geo budget + single clustering attempt
// raised first-run empty risk.  Recalibrated to keep a meaningful latency win
// while reducing that risk: a slightly larger geo budget, a marginally longer
// per-attempt clustering timeout, and — locked decision — ALWAYS 2 clustering
// attempts for interactive runs (initial + one retry), matching the default
// profile's resilience.  The latency win now comes from the bounded geo Lane-2
// budget and the tighter per-attempt clustering timeout, not from dropping the
// retry.
export const INTERACTIVE_GEO_STAGE_BUDGET_MS_DEFAULT = 12000;
export const INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT = 22000;
export const INTERACTIVE_CLUSTER_MAX_ATTEMPTS_DEFAULT = 2;
export const DEFAULT_CLUSTER_MAX_ATTEMPTS = 2; // initial try + one retry

// ─── Cold-start (Slice 1): first-run profile defaults ────────────────────────
//
// Brand-new users have no prior dashboard snapshot — the onboarding handoff
// fires a cold-start refresh.  These are the locked defaults from cold-start-v1
// (see ../../../../docs/cold-start-v1.md): a bounded geo budget with all Lane 2
// deferred to the hold path, a 45s-per-attempt Sonnet clustering timeout, always
// 2 attempts, and a tighter 10-item cluster input cap.  Slice 1 wires the
// profile contract ONLY — `deferGeoLane2`/`clusterInputCap` are additive, inert
// fields here; later slices thread them into pipeline behavior.  No env
// overrides in this slice — the defaults are locked constants.
export const COLD_START_GEO_STAGE_BUDGET_MS_DEFAULT = 12000;
export const COLD_START_CLUSTER_TIMEOUT_MS_DEFAULT = 45000;
export const COLD_START_CLUSTER_MAX_ATTEMPTS_DEFAULT = 2;
export const COLD_START_CLUSTER_INPUT_CAP_DEFAULT = 10;

function envIntPositive(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve the latency-shaping profile for a refresh run.  `name === "interactive"`
 * (onboarding-driven interactive entry) yields the bounded fast-path knobs;
 * `name === "cold_start"` (first-run, no prior snapshot) yields the locked
 * cold-start knobs; anything else (scheduled/background/default) yields the
 * inert default profile — `geoStageBudgetMs`/`clusterTimeoutMs` null so the
 * pipeline keeps reading the existing env defaults, and `clusterMaxAttempts`
 * stays at 2 (one retry).
 *
 * Returns a plain, fully-populated object so it can be surfaced verbatim on
 * `_meta.profile` for profile-on vs baseline comparison.  Exported for unit
 * testing of the knob matrix without driving the full pipeline.
 */
export function resolveRefreshProfile(name) {
  if (name === "cold_start") {
    // Slice 1: locked defaults only.  `deferGeoLane2`/`clusterInputCap` are
    // additive, inert fields — not yet wired into pipeline behavior.
    return {
      name: "cold_start",
      interactive: true,
      geoStageBudgetMs: COLD_START_GEO_STAGE_BUDGET_MS_DEFAULT,
      clusterTimeoutMs: COLD_START_CLUSTER_TIMEOUT_MS_DEFAULT,
      clusterMaxAttempts: COLD_START_CLUSTER_MAX_ATTEMPTS_DEFAULT,
      deferGeoLane2: true,
      clusterInputCap: COLD_START_CLUSTER_INPUT_CAP_DEFAULT,
    };
  }
  if (name === "interactive") {
    return {
      name: "interactive",
      interactive: true,
      geoStageBudgetMs: envIntPositive(
        "TEMPO_INTERACTIVE_GEO_STAGE_BUDGET_MS",
        INTERACTIVE_GEO_STAGE_BUDGET_MS_DEFAULT
      ),
      clusterTimeoutMs: envIntPositive(
        "TEMPO_INTERACTIVE_CLUSTER_TIMEOUT_MS",
        INTERACTIVE_CLUSTER_TIMEOUT_MS_DEFAULT
      ),
      clusterMaxAttempts: envIntPositive(
        "TEMPO_INTERACTIVE_CLUSTER_MAX_ATTEMPTS",
        INTERACTIVE_CLUSTER_MAX_ATTEMPTS_DEFAULT
      ),
    };
  }
  return {
    name: "default",
    interactive: false,
    geoStageBudgetMs: null, // fall through to resolveGeoStageBudgetMs()
    clusterTimeoutMs: null, // fall through to env / cluster-engine default
    clusterMaxAttempts: DEFAULT_CLUSTER_MAX_ATTEMPTS,
  };
}

// ─── C1: deterministic cluster input cap ─────────────────────────────────────
//
// Clustering is the single largest AI round-trip (whole candidate pool in one
// prompt) and the publish path fails closed after one retry.  Sending an
// unbounded candidate set is the main timeout/fail-closed risk.  C1 caps the
// set passed to `clusterFn` at CLUSTER_INPUT_CAP items, applied AFTER beat-fit
// and cross-feed dedupe so we keep the highest-value candidates rather than an
// arbitrary prefix.  Applied in ALL environments — there is no env gate — so
// behavior is identical everywhere.  Story output max is unchanged: the
// clustering contract still emits up to 5 meta-stories.
//
// Ranking (deterministic, total order over the deduped set):
//   1. beatFitScore descending      — best-fitting candidates survive the cap
//   2. minutesAgo ascending          — fresher item wins ties
//   3. sourceId ascending            — stable final tie-break
// Items missing a numeric beatFitScore (e.g. when beat-fit is disabled in a
// test) sort as score 0; missing minutesAgo sorts last (oldest).
export const CLUSTER_INPUT_CAP = 15;

/**
 * Total-order comparator for cluster-input ranking (see C1 note above).
 * Pure; callers sort a copy so the input array stays untouched.  Exported for
 * unit testing of the ranking contract.
 */
export function compareClusterInputItems(a, b) {
  const as =
    typeof a?.beatFitScore === "number" && Number.isFinite(a.beatFitScore)
      ? a.beatFitScore
      : 0;
  const bs =
    typeof b?.beatFitScore === "number" && Number.isFinite(b.beatFitScore)
      ? b.beatFitScore
      : 0;
  if (as !== bs) return bs - as;
  const am =
    typeof a?.minutesAgo === "number" && Number.isFinite(a.minutesAgo)
      ? a.minutesAgo
      : Number.POSITIVE_INFINITY;
  const bm =
    typeof b?.minutesAgo === "number" && Number.isFinite(b.minutesAgo)
      ? b.minutesAgo
      : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm;
  const aid = a?.sourceId ?? "";
  const bid = b?.sourceId ?? "";
  if (aid < bid) return -1;
  if (aid > bid) return 1;
  return 0;
}

/**
 * Rank `dedupedItems` per the C1 contract and slice to `cap`.  Returns the
 * capped `clusterInputItems` (what `clusterFn` actually sees) plus deterministic
 * diagnostics consistent with that slice.  Never mutates the input array.
 *
 * @param {Array}  dedupedItems — post-beat-fit, post-dedupe candidate set
 * @param {number} [cap]        — max items to keep (default CLUSTER_INPUT_CAP)
 */
export function applyClusterInputCap(dedupedItems, cap = CLUSTER_INPUT_CAP) {
  const items = Array.isArray(dedupedItems) ? dedupedItems : [];
  const ranked = items.slice().sort(compareClusterInputItems);
  const clusterInputItems = ranked.slice(0, cap);
  const dropped = ranked.slice(cap);
  return {
    clusterInputItems,
    diagnostics: {
      dedupedCount: items.length,
      clusterInputCount: clusterInputItems.length,
      clusterDroppedCount: dropped.length,
      // IDs of the candidates ranked beyond the cap, in drop (rank) order.
      clusterDroppedSourceIds: dropped
        .map((it) => it?.sourceId)
        .filter((id) => typeof id === "string"),
    },
  };
}

// ─── Lineage continuity (prior-snapshot keyed merge) ─────────────────────────
//
// Why a Jaccard-based merge instead of pure evidence hashing:
//   A narrative evolves across refreshes — sources are added, others age out.
//   A pure hash of `sorted(source_item_ids)` changes the moment any source
//   joins/leaves, breaking metaStoryId continuity (and therefore title locks).
//   The MVP strategy here is "prior-snapshot keyed merge": after clustering,
//   each new meta-story is matched against last refresh's stories using
//   primary topic + Jaccard overlap on source IDs.  Exactly-one match → reuse
//   the prior metaStoryId.  Zero or ambiguous matches → assign a fresh
//   evidence-derived ID via generateMetaStoryId.
//
// Trade-offs (deliberate):
//   - Threshold 0.5 = at least half the union must overlap.  Strict enough to
//     prevent accidental merges when two distinct narratives happen to share
//     one or two articles; loose enough to track "+1 source" or "-1 source"
//     evolution (Jaccard 0.67 / 0.5 respectively).
//   - When two new stories both match the same prior story, only the first
//     claims it — subsequent ones fall through to fresh IDs.  Favors
//     fragmentation over accidental merge if continuity is unclear.
//   - Topic must match.  Same sources but different primary topic ⇒ different
//     narrative ⇒ new ID.

const LINEAGE_JACCARD_THRESHOLD = 0.5;

function jaccardOverlap(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Reuse metaStoryIds from prior snapshot when a new cluster represents the
 * same narrative (same topic + Jaccard ≥ threshold on source IDs).  Otherwise
 * fall back to evidence-derived hash via generateMetaStoryId.
 */
function reuseOrAssignIds(metaStories, priorStories) {
  if (!priorStories || priorStories.length === 0) {
    return metaStories.map((ms) => ({
      ...ms,
      meta_story_id: ms.meta_story_id ?? generateMetaStoryId(ms),
    }));
  }

  const priorIndex = priorStories.map((s) => ({
    metaStoryId: s.metaStoryId ?? s.id,
    topic: s.topic ?? "",
    sourceIds: (s.sources ?? []).map((src) => src.id).filter(Boolean),
  }));
  const claimed = new Set();

  return metaStories.map((ms) => {
    const newSourceIds = ms.source_item_ids ?? [];
    const newTopic = (ms.tags?.topics ?? [])[0] ?? "";

    const candidates = [];
    for (let i = 0; i < priorIndex.length; i++) {
      if (claimed.has(i)) continue;
      const prior = priorIndex[i];
      if (!prior.topic || !newTopic || prior.topic !== newTopic) continue;
      const score = jaccardOverlap(newSourceIds, prior.sourceIds);
      if (score >= LINEAGE_JACCARD_THRESHOLD) candidates.push({ idx: i, score });
    }

    // Exactly one candidate → reuse.  Multiple equally-good candidates →
    // ambiguous → fresh ID (favor fragmentation over accidental merge).
    if (candidates.length === 1) {
      claimed.add(candidates[0].idx);
      return { ...ms, meta_story_id: priorIndex[candidates[0].idx].metaStoryId };
    }

    return { ...ms, meta_story_id: ms.meta_story_id ?? generateMetaStoryId(ms) };
  });
}

const TWENTY_FOUR_HOURS_MINUTES = 24 * 60;

// ─── Funnel diagnostics ──────────────────────────────────────────────────────
//
// When stories=0 we want to know — from logs alone — which stage of the
// pipeline collapsed the funnel. The funnel object records the count after
// each filter so the operator can read it linearly and spot the cliff. The
// "primary drop stage" is the stage with the largest absolute drop from its
// input; if every stage is fine but no stories emerged, that points at
// clustering/grounding instead.

// IMPORTANT: `afterTopicKeyword` is the POST-RECALL-STAGE count — i.e. the
// size of `recallResult.items`, which is:
//   - in `hybrid_strict` mode: the LEXICAL ∪ SEMANTIC union (or the lexical
//     fallback set on a degraded run);
//   - in `keyword`         mode: the lexical-only set.
// The field/label keep the legacy name (`topic_keyword_recall`) so existing
// log scrapers / dashboards don't break, but the value reflects post-union
// recall behavior.  The fine-grained breakdown (lexical vs union vs degraded
// reason) lives in `_meta.recall` — see embedding-recall.mjs.
const FUNNEL_STAGES = Object.freeze([
  // [field-on-funnel, label-in-log, prior-field]
  ["totalNormalized", "normalize", null],
  ["afterTimeWindow", "time_window_24h", "totalNormalized"],
  ["afterSourceSelection", "source_selection", "afterTimeWindow"],
  ["afterGeoFilter", "geo_filter", "afterSourceSelection"],
  ["afterTopicKeyword", "topic_keyword_recall", "afterGeoFilter"],
  ["afterBeatFit", "beat_fit_precision", "afterTopicKeyword"],
  // Cross-feed dedupe collapses same-article items from multiple feeds
  // before clustering. Drop here = duplicate-article folds, NOT lost data.
  ["afterDedupe", "cross_feed_dedupe", "afterBeatFit"],
  ["finalStories", "clustering_and_grounding", "afterDedupe"],
]);

/**
 * Execution markers attached to every funnel object. `full_run` means every
 * stage ran end-to-end (counts are real). `watermark_skip` means the pipeline
 * short-circuited before clustering because the input watermark matched the
 * prior snapshot — clustering/grounding never ran, so `finalStories` is
 * intentionally `null` (NOT `0`) and `primaryDropStage` is `not_executed`.
 *
 * Operators reading `[pipeline.funnel]` should treat `executionMode` as the
 * source of truth for "did the pipeline actually produce a number for the
 * final stage?" before drawing conclusions about drop locations.
 */
export const FUNNEL_EXECUTION_MODE = Object.freeze({
  FULL_RUN: "full_run",
  WATERMARK_SKIP: "watermark_skip",
});

/**
 * Identify the stage that dropped the most items (absolute count) given a
 * fully-populated funnel object. Returns "none" when no drop occurred, and
 * `not_executed` when the funnel represents a skip path (any stage with
 * `null` is treated as "not computed" rather than "dropped to 0").
 *
 * Exported for testing — the production callers consume `summarizeFunnel`
 * which returns the full diagnostic shape.
 */
export function primaryDropStage(funnel) {
  let maxDrop = 0;
  let maxStage = "none";
  for (const [field, label, prior] of FUNNEL_STAGES) {
    if (!prior) continue;
    const cur = funnel[field];
    const prev = funnel[prior];
    // `null` on either side means the stage didn't execute; we cannot
    // attribute a drop to a stage that never ran.
    if (cur === null || prev === null) continue;
    const drop = (prev ?? 0) - (cur ?? 0);
    if (drop > maxDrop) {
      maxDrop = drop;
      maxStage = label;
    }
  }
  return maxStage;
}

/**
 * Format the funnel as a one-line console string showing the per-stage
 * counts in pipeline order. Used by the [pipeline.funnel] log line.
 * `null` stages render as `n/a` so the operator can see "not executed"
 * at a glance vs a real "0" drop.
 */
export function formatFunnel(funnel) {
  return FUNNEL_STAGES
    .map(([field, label]) => {
      const v = funnel[field];
      return `${label}=${v === null ? "n/a" : (v ?? 0)}`;
    })
    .join(" → ");
}

/**
 * Build a diagnostic summary suitable for logs and `_meta.funnel`.
 *
 * Adds:
 *   - `executionMode` — "full_run" or "watermark_skip"
 *   - `primaryDropStage` — derived from the per-stage counts; `not_executed`
 *     on skip paths so we don't falsely claim a clustering drop when
 *     clustering never ran.
 *   - `topicKeywordRecallIsNoop` — true iff settings carry no topics AND no
 *     keywords (the recall stage passes everything in that case).
 *
 * `executionMode` defaults to "full_run" for backwards-compat with callers
 * that don't specify it; pass `{ executionMode: "watermark_skip" }` from the
 * skip branch.
 */
export function summarizeFunnel(funnel, settings = {}, opts = {}) {
  const executionMode = opts.executionMode ?? FUNNEL_EXECUTION_MODE.FULL_RUN;
  const noTopics = !(settings.topics && settings.topics.length > 0);
  const noKeywords = !(settings.keywords && settings.keywords.length > 0);
  const drop =
    executionMode === FUNNEL_EXECUTION_MODE.WATERMARK_SKIP
      ? "not_executed"
      : primaryDropStage(funnel);
  return {
    ...funnel,
    executionMode,
    primaryDropStage: drop,
    topicKeywordRecallIsNoop: noTopics && noKeywords,
  };
}

// ─── Decision-trace (Phase 2 lightweight diagnostics) ───────────────────────
//
// Backend-only, internal-explainability surface on top of the pipeline log.
// Purpose: answer "why did this item land in/out of the snapshot?" from a
// single compact object without storing full source bodies or re-running the
// pipeline.  Optional — never required by the dashboard payload contract.
//
// Shape (everything optional from a consumer's perspective):
//   decisionTrace.stageCounts      — per-gate enter/exit counts (mirrors funnel)
//   decisionTrace.beatFit          — scorer summary + rescue counters
//   decisionTrace.sampleExclusions — capped list (≤ DECISION_TRACE_SAMPLE_CAP)
//                                    of {sourceId, stage, excludeReason,
//                                    inRescueBand, rescueBlockedBy, score}
//
// Cap is deliberately small (5).  This is a debugging aid, not an audit log;
// operators only need a representative sample to spot a class of problem.

const DECISION_TRACE_SAMPLE_CAP = 5;
const DECISION_TRACE_SCORE_PRECISION = 4;

// Derive in-band / rescue-blocked context from the annotated reason codes the
// scorer attaches to excluded items.  Keeps the scorer's contract narrow (it
// already emits these codes for compatibility); the pipeline just translates
// them into a structured field for the trace.
//
// D-059 + D-062 (PR4): rescue-blocked codes now include semantic-geo paths.
// Priority order (most actionable first):
//   1. penalty           — structural misalignment; vetoes both rescue paths
//   2. geo_gate          — strong semantic + below threshold + no penalty,
//                           ONLY blocked because the geo gate didn't fire.
//                           Operator-actionable: configuring the right geo
//                           would admit this item.
//   3. weak_semantic     — geo matched but semantic was below the floor;
//                           pipeline-tuning-actionable.
//   4. insufficient_signals — multisignal rescue floor (older path); less
//                              actionable since the new semantic-geo path
//                              is the primary near-miss recovery channel.
// An excluded item may carry several codes simultaneously (one per rescue
// path that ran); this picks the single most informative diagnosis.
function deriveRescueContext(reasonCodes) {
  const codes = Array.isArray(reasonCodes) ? reasonCodes : [];
  if (codes.includes("rescue_blocked_penalty")) {
    return { inRescueBand: true, rescueBlockedBy: "penalty" };
  }
  if (codes.includes("rescue_blocked_geo_gate")) {
    return { inRescueBand: false, rescueBlockedBy: "geo_gate" };
  }
  if (codes.includes("rescue_blocked_weak_semantic")) {
    return { inRescueBand: false, rescueBlockedBy: "weak_semantic" };
  }
  if (codes.includes("rescue_blocked_insufficient_signals")) {
    return { inRescueBand: true, rescueBlockedBy: "insufficient_signals" };
  }
  return { inRescueBand: false, rescueBlockedBy: null };
}

function roundForTrace(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const factor = 10 ** DECISION_TRACE_SCORE_PRECISION;
  return Math.round(n * factor) / factor;
}

function buildSampleExclusions(excluded) {
  if (!Array.isArray(excluded) || excluded.length === 0) return [];
  const sample = [];
  for (const entry of excluded) {
    if (sample.length >= DECISION_TRACE_SAMPLE_CAP) break;
    const ctx = deriveRescueContext(entry?.reasonCodes);
    sample.push({
      sourceId: entry?.item?.sourceId ?? null,
      stage: "beat_fit",
      excludeReason: entry?.excludeReason ?? null,
      inRescueBand: ctx.inRescueBand,
      rescueBlockedBy: ctx.rescueBlockedBy,
      score: roundForTrace(entry?.score),
    });
  }
  return sample;
}

// D-059 + D-062: minimal per-rescue trace entries so an operator reading
// `decisionTrace.sampleRescues` can answer "which path admitted this item,
// and why" without joining logs by sourceId. Cap mirrors the exclusion
// sample so the trace stays small.
function buildSampleRescues(included) {
  if (!Array.isArray(included) || included.length === 0) return [];
  const sample = [];
  for (const entry of included) {
    if (!entry?.beatFitRescued) continue;
    if (sample.length >= DECISION_TRACE_SAMPLE_CAP) break;
    sample.push({
      sourceId: entry?.sourceId ?? null,
      stage: "beat_fit",
      rescueReason: entry?.beatFitRescueReason ?? null,
      score: roundForTrace(entry?.beatFitScore),
      deterministicScore: roundForTrace(entry?.beatFitDeterministicScore),
    });
  }
  return sample;
}

function buildDecisionTrace({ stageCounts, beatFitResult }) {
  const summary = beatFitResult?.summary ?? {};
  return {
    stageCounts: { ...stageCounts },
    beatFit: {
      threshold: summary.threshold,
      rescueLowerBound: summary.rescueLowerBound,
      // D-059 + D-062: configurable floor for the `rescue_semantic_geo`
      // path (default 0.60). Surfaced so an operator tuning the env override
      // can see the effective value alongside the path-split rescue counts.
      semanticGeoRescueMin: summary.semanticGeoRescueMin,
      includedCount: summary.includedCount ?? 0,
      excludedCount: summary.excludedCount ?? 0,
      rescuedCount: summary.rescuedCount ?? 0,
      rescuedBorderlineCount: summary.rescuedBorderlineCount ?? 0,
      rescuedSemanticGeoCount: summary.rescuedSemanticGeoCount ?? 0,
      rescueBlockedPenaltyCount: summary.rescueBlockedPenaltyCount ?? 0,
      rescueBlockedInsufficientSignalsCount:
        summary.rescueBlockedInsufficientSignalsCount ?? 0,
      rescueBlockedGeoGateCount: summary.rescueBlockedGeoGateCount ?? 0,
      rescueBlockedWeakSemanticCount:
        summary.rescueBlockedWeakSemanticCount ?? 0,
      excludeReasonHistogram: summary.excludeReasonHistogram ?? {},
    },
    sampleExclusions: buildSampleExclusions(beatFitResult?.excluded),
    sampleRescues: buildSampleRescues(beatFitResult?.included),
  };
}

// Sourced directly from the canonical zod enums so the pipeline never drifts
// from the contract schema.
const VALID_GEOGRAPHIES = new Set(geographySchema.options);
const VALID_TOPICS = new Set(topicSchema.options);

// ─── Legacy tag-governance helpers (back-compat) ─────────────────────────────
//
// `constrainTagsToSettings` and `deriveStoryTags` implement the original
// Phase 1/2 `settings ∩ source-evidence` contract.  Production tag emission
// now goes through [`assignMetaStoryTags`](./meta-story-tags.mjs) (Phase 3+);
// these helpers stay exported for the existing test surface and to give a
// clean rollback target.  Both functions are read-only on `settings` and
// emit canonical settings spelling; empty arrays mean "no evidence" — never
// fabricated placeholders.

function buildSettingsLookup(values, { useTopicNormalization = false } = {}) {
  const lookup = new Map();
  if (!Array.isArray(values)) return lookup;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = useTopicNormalization
      ? normalizeTopicLabel(trimmed).toLowerCase()
      : trimmed.toLowerCase();
    if (!lookup.has(key)) lookup.set(key, trimmed);
  }
  return lookup;
}

function constrainAxisToSettings(modelValues, settingsValues, opts = {}) {
  if (!Array.isArray(modelValues) || modelValues.length === 0) return [];
  const lookup = buildSettingsLookup(settingsValues, opts);
  if (lookup.size === 0) return [];
  const out = [];
  const emitted = new Set();
  for (const m of modelValues) {
    if (typeof m !== "string") continue;
    const trimmed = m.trim();
    if (!trimmed) continue;
    const key = opts.useTopicNormalization
      ? normalizeTopicLabel(trimmed).toLowerCase()
      : trimmed.toLowerCase();
    const canonical = lookup.get(key);
    if (!canonical) continue;
    if (emitted.has(canonical)) continue;
    emitted.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * Constrain a model-produced story.tags object to the settings vocabulary.
 * Returns a fresh `{ topics, keywords, geographies }` shape with axes that
 * are subsets of `settings.{topics,keywords,geographies}` respectively.
 * Never mutates `settings` or `tags`.  Exported for unit testing.
 */
export function constrainTagsToSettings(tags, settings) {
  const t = tags && typeof tags === "object" ? tags : {};
  return {
    topics: constrainAxisToSettings(t.topics, settings?.topics, {
      useTopicNormalization: true,
    }),
    keywords: constrainAxisToSettings(t.keywords, settings?.keywords),
    geographies: constrainAxisToSettings(t.geographies, settings?.geographies),
  };
}

function concatSourceText(sourceItems) {
  if (!Array.isArray(sourceItems)) return "";
  const parts = [];
  for (const it of sourceItems) {
    if (!it) continue;
    if (typeof it.headline === "string") parts.push(it.headline);
    if (Array.isArray(it.body)) parts.push(it.body.join(" "));
    else if (typeof it.body === "string") parts.push(it.body);
  }
  return parts.join("\n");
}

function evidenceBackedKeywords(sourceItems, settingsKeywords) {
  if (!Array.isArray(settingsKeywords) || settingsKeywords.length === 0) return [];
  const text = concatSourceText(sourceItems);
  if (!text) return [];
  const out = [];
  const emitted = new Set();
  for (const raw of settingsKeywords) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (emitted.has(trimmed)) continue;
    // Whole-word match (matches buildKeywordTokenRegex semantics: \b…\b,
    // case-insensitive, multi-word keywords match as contiguous phrases).
    const re = new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i");
    if (re.test(text)) {
      emitted.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Derive a story's tags from source evidence + settings vocabulary.
 *
 *   topics       = settings.topics ∩ {normalize(source.topic) for each source}
 *   geographies  = settings.geographies ∩ ⋃ source.geographies
 *   keywords     = { kw ∈ settings.keywords | kw appears as a whole word in
 *                    some source's headline/body }
 *
 * Model tags are NOT consulted here — they may agree with this output, but
 * the contract is "settings ∩ evidence", so an in-settings value the model
 * dreamed up without source support is dropped, and a settings value the
 * model omitted but the sources support is added back.  Output values use
 * the canonical settings spelling.  Returns a fresh `{ topics, keywords,
 * geographies }` shape; never mutates `sourceItems` or `settings`.
 *
 * Exported for unit testing.
 */
export function deriveStoryTags(sourceItems, settings) {
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  const topicEvidence = items
    .map((i) => i?.topic)
    .filter((t) => typeof t === "string");
  const geoEvidence = items
    .flatMap((i) => (Array.isArray(i?.geographies) ? i.geographies : []))
    .filter((g) => typeof g === "string");
  return {
    topics: constrainAxisToSettings(topicEvidence, settings?.topics, {
      useTopicNormalization: true,
    }),
    keywords: evidenceBackedKeywords(items, settings?.keywords),
    geographies: constrainAxisToSettings(geoEvidence, settings?.geographies),
  };
}

// ─── Source pool selection ────────────────────────────────────────────────────

/**
 * Select items whose outlet matches any configured traditionalSource or socialSource.
 * Comparison is case-insensitive.
 *
 * C2 (M6): when **both** source lists are empty, return `[]` — not "all items".
 * Zero configured sources is the user telling us "I haven't picked a beat
 * yet"; surfacing the entire fixture pool under that state risks recommending
 * outlets the user never opted into.  The manifest path in the refresh
 * pipeline enforces the same gate; both produce a clean strict-empty.
 */
export function selectSourcePool(items, settings) {
  const sources = new Set([
    ...(settings.traditionalSources ?? []).map((s) => s.toLowerCase()),
    ...(settings.socialSources ?? []).map((s) => s.toLowerCase()),
  ]);
  if (sources.size === 0) return [];
  return items.filter((item) => sources.has(item.outlet.toLowerCase()));
}

// ─── 24-hour filter ───────────────────────────────────────────────────────────

export function apply24hFilter(items) {
  return items.filter((item) => item.minutesAgo <= TWENTY_FOUR_HOURS_MINUTES);
}

// ─── Relevance filter ─────────────────────────────────────────────────────────

/**
 * An item passes if it satisfies ANY configured filter (OR logic).
 * Empty filter arrays are treated as "no restriction" and do not contribute to
 * the OR evaluation — they only broaden the result when all three are empty
 * (in which case all items pass).
 *
 * @deprecated Prefer applyGeoFilter + applyTopicKeywordFilter in the pipeline.
 * Kept for backward compatibility with tests.
 */
export function applyRelevanceFilter(items, settings) {
  const topics = new Set((settings.topics ?? []).map((t) => normalizeTopicLabel(t)));
  const geos = new Set(settings.geographies ?? []);
  const keywords = (settings.keywords ?? []).map((k) => k.toLowerCase());

  if (topics.size === 0 && geos.size === 0 && keywords.length === 0) return items;

  return items.filter((item) => {
    if (topics.size > 0 && topics.has(normalizeTopicLabel(item.topic))) return true;
    if (geos.size > 0 && item.geographies.some((g) => geos.has(g))) return true;
    if (keywords.length > 0) {
      const text = (item.headline + " " + item.body.join(" ")).toLowerCase();
      if (keywords.some((k) => text.includes(k))) return true;
    }
    return false;
  });
}

// Regex-escape characters that have special meaning inside a RegExp pattern.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a single case-insensitive whole-word regex that matches any of the
 * given keywords as a token (\b word boundaries).  Returns null when there are
 * no usable keywords.  Multi-word keywords like "border policy" are matched as
 * a contiguous phrase.  Empty/whitespace-only keywords are dropped.
 */
function buildKeywordTokenRegex(keywords) {
  const cleaned = (keywords ?? [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter(Boolean);
  if (cleaned.length === 0) return null;
  const alternation = cleaned.map((k) => escapeRegex(k)).join("|");
  return new RegExp(`\\b(?:${alternation})\\b`, "i");
}

// Join an item's lexical surfaces for the geography text gate. Mirrors the
// fields beat-fit's `joinText` consults (headline + subtitle + body + url) so
// the recall geo gate never narrows what beat-fit would later geo-match — geo
// recall stays at least as wide as the downstream scorer's geo signal.
function joinGeoText(item) {
  // Slice 14: read normalized English evidence when present (falls back to the
  // untouched originals for English items) so the geo lexical gate stays in
  // lockstep with the keyword/embedding recall surfaces.
  const headline = readHeadline(item);
  const subtitle = item?.subtitle ?? "";
  const body = readBodyText(item);
  const url = typeof item?.url === "string" ? item.url : "";
  return `${headline} ${subtitle} ${body} ${url}`.trim();
}

/**
 * Recall lexical gate: an item passes if it matches ANY configured lexical
 * signal (logical OR) — topic, keyword, OR a configured geography mentioned in
 * the item's text. Geo handling for explicit `item.geographies` overlap lives
 * in `applyGeoFilter`; this gate adds the *lexical* geo signal (Slice 2) via
 * the shared matcher in `geo-lexical-match.mjs` so it cannot drift from
 * beat-fit's geo behavior.
 *
 *   - Topic uses canonical normalization (`normalizeTopicLabel`).
 *   - Keyword uses whole-word/token matching (case-insensitive); substrings
 *     inside larger words (e.g. "ofac" inside "ofacility") do NOT match.
 *   - Geography uses `itemMentionsConfiguredGeography` (canonical token +
 *     GEOGRAPHY_SYNONYMS + settings-gated GEOGRAPHY_ALIASES) over the joined
 *     item text.
 *   - Pass-through (return all items) happens ONLY when none of the three
 *     gates are configured (no topics AND no keywords AND no geographies). When
 *     only geographies are configured, the item must still mention one of them
 *     in text to pass — geographies no longer wave items through.
 */
export function applyTopicKeywordFilter(items, settings) {
  const topics = new Set((settings.topics ?? []).map((t) => normalizeTopicLabel(t)));
  const keywordRegex = buildKeywordTokenRegex(settings.keywords);
  const geographies = settings.geographies ?? [];
  const hasGeographies = geographies.length > 0;

  if (topics.size === 0 && !keywordRegex && !hasGeographies) return items;

  return items.filter((item) => {
    if (topics.size > 0 && topics.has(normalizeTopicLabel(item.topic))) return true;
    if (keywordRegex) {
      // Slice 14: keyword recall reads normalized English evidence when present
      // so a Spanish item whose translation contains "migration" matches the
      // English user keyword. English items fall back to their originals.
      const text = readHeadline(item) + " " + readBodyText(item);
      if (keywordRegex.test(text)) return true;
    }
    if (hasGeographies && itemMentionsConfiguredGeography(joinGeoText(item), geographies)) {
      return true;
    }
    return false;
  });
}

/**
 * Returns a per-stage breakdown of why items passed/failed the topic+keyword
 * recall stage.  Used purely for diagnostics — never alters filter behavior.
 *
 * Counts are mutually-exclusive partition of the input set:
 *   - topicOnly      — passed via topic match (no keyword match)
 *   - keywordOnly    — passed via keyword match (no topic match)
 *   - both           — passed both topic and keyword
 *   - geoLexicalOnly — passed ONLY via a configured-geography text mention
 *                      (no topic, no keyword); the Slice 2 geo lexical gate
 *   - neither        — failed all configured gates (filter rejects)
 *   - passNoConfig   — when settings have no topic, no keyword, AND no
 *                      geography configured, the filter is a no-op
 *                      pass-through; counted separately so "everything passed
 *                      because nothing was checked" is distinguishable from
 *                      "everything passed because everything matched".
 *
 * Partition priority is topic/keyword first, then geo: `both`, `topicOnly`,
 * `keywordOnly`, `geoLexicalOnly`, `neither`. So an item matching keyword AND
 * geography is counted as `keywordOnly` (geo is only the *sole* reason for
 * `geoLexicalOnly`). `passCount` sums every passing bucket.
 *
 * Hint codes (`primaryDropCause`) attached when zero items pass:
 *   - `no_input`           — input set was empty before the stage ran
 *   - `no_topic_no_keyword`— neither gate matched anything (typical false-empty
 *                            we are debugging when "obvious" lexical matches
 *                            are missing — a tell that settings/topic taxonomy
 *                            drifted from the item.topic labels in feed data)
 *   - `no_topic_match`     — topic gate matched zero, keywords not configured
 *   - `no_keyword_match`   — keyword gate matched zero, topics not configured
 *   - `no_geo_match`       — only geographies configured, none mentioned in text
 *   - null                 — at least one item passed (or stage is no-op)
 */
export function analyzeTopicKeywordStage(items, settings) {
  const inputCount = items?.length ?? 0;
  const topics = new Set((settings?.topics ?? []).map((t) => normalizeTopicLabel(t)));
  const keywordRegex = buildKeywordTokenRegex(settings?.keywords);
  const geographies = settings?.geographies ?? [];
  const hasTopics = topics.size > 0;
  const hasKeywords = !!keywordRegex;
  const hasGeographies = geographies.length > 0;

  const breakdown = {
    inputCount,
    hasTopics,
    hasKeywords,
    hasGeographies,
    topicOnly: 0,
    keywordOnly: 0,
    both: 0,
    geoLexicalOnly: 0,
    neither: 0,
    passNoConfig: 0,
    passCount: 0,
    primaryDropCause: null,
  };

  if (!hasTopics && !hasKeywords && !hasGeographies) {
    breakdown.passNoConfig = inputCount;
    breakdown.passCount = inputCount;
    if (inputCount === 0) breakdown.primaryDropCause = "no_input";
    return breakdown;
  }

  for (const item of items ?? []) {
    const topicMatch = hasTopics && topics.has(normalizeTopicLabel(item?.topic ?? ""));
    let keywordMatch = false;
    if (hasKeywords) {
      // Slice 14: mirror applyTopicKeywordFilter — read normalized English
      // evidence when present so the diagnostic breakdown matches the filter.
      const text = readHeadline(item) + " " + readBodyText(item);
      keywordMatch = keywordRegex.test(text);
    }
    const geoMatch =
      hasGeographies && !!itemMentionsConfiguredGeography(joinGeoText(item), geographies);
    if (topicMatch && keywordMatch) breakdown.both++;
    else if (topicMatch) breakdown.topicOnly++;
    else if (keywordMatch) breakdown.keywordOnly++;
    else if (geoMatch) breakdown.geoLexicalOnly++;
    else breakdown.neither++;
  }
  breakdown.passCount =
    breakdown.topicOnly +
    breakdown.keywordOnly +
    breakdown.both +
    breakdown.geoLexicalOnly;

  if (inputCount === 0) {
    breakdown.primaryDropCause = "no_input";
  } else if (breakdown.passCount === 0) {
    if (hasTopics && hasKeywords) breakdown.primaryDropCause = "no_topic_no_keyword";
    else if (hasTopics) breakdown.primaryDropCause = "no_topic_match";
    else if (hasKeywords) breakdown.primaryDropCause = "no_keyword_match";
    else breakdown.primaryDropCause = "no_geo_match";
  }
  return breakdown;
}

// ─── Build response story shape ───────────────────────────────────────────────

/**
 * T1 (M6b): comparator for `sources[]` ordering inside a story.
 *   1. `weight` DESC          — higher-weight outlets surface first
 *   2. `minutesAgo` ASC       — freshest item next when weight ties
 *   3. `sourceId` ASC         — stable tie-break for fully equal pairs
 * Pure function; sort is applied via `.slice().sort(...)` so callers can keep
 * their input array untouched.
 */
export function compareSourcesT1(a, b) {
  const aw = typeof a?.weight === "number" ? a.weight : 0;
  const bw = typeof b?.weight === "number" ? b.weight : 0;
  if (aw !== bw) return bw - aw;
  const am = typeof a?.minutesAgo === "number" ? a.minutesAgo : Number.POSITIVE_INFINITY;
  const bm = typeof b?.minutesAgo === "number" ? b.minutesAgo : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm;
  const aid = a?.sourceId ?? a?.id ?? "";
  const bid = b?.sourceId ?? b?.id ?? "";
  if (aid < bid) return -1;
  if (aid > bid) return 1;
  return 0;
}

/**
 * R1 (M6b): comparator for top-level `stories[]` ordering at the payload
 * boundary.  Accepts pre-computed sort keys (so the comparator stays a pure
 * function over plain values, not the story object).
 *   1. `maxBeatFitScore` DESC  — best-fitting story first
 *   2. `minMinutesAgo` ASC     — freshest tie-breaker
 *   3. `metaStoryId` ASC       — stable tie-break
 */
export function compareStoriesR1(a, b) {
  const ab = typeof a?.maxBeatFitScore === "number" ? a.maxBeatFitScore : 0;
  const bb = typeof b?.maxBeatFitScore === "number" ? b.maxBeatFitScore : 0;
  if (ab !== bb) return bb - ab;
  const am = typeof a?.minMinutesAgo === "number" ? a.minMinutesAgo : Number.POSITIVE_INFINITY;
  const bm = typeof b?.minMinutesAgo === "number" ? b.minMinutesAgo : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm;
  const aid = a?.metaStoryId ?? "";
  const bid = b?.metaStoryId ?? "";
  if (aid < bid) return -1;
  if (aid > bid) return 1;
  return 0;
}

// ─── Slice 6: Lane 2 throughput prioritization ───────────────────────────────
//
// Lane 2 (opportunistic geo candidates) is processed in concurrency-sized waves
// only while the geo-stage budget holds; the remainder defers to the hold path
// (never dropped, re-evaluated next refresh).  To get the most relevance out of
// a tight budget (interactive profile), assess the MOST-LIKELY-RELEVANT and
// CHEAPEST candidates first so they're the ones that survive when the budget
// runs out — the deferred tail is then the least-promising items, which lose
// the least by waiting a refresh.
//
// This reorders ASSESSMENT ORDER ONLY — it never changes which items pass/fail
// (same thresholds) and never drops anything, so geography relevance is
// preserved.  The sort is a total order with a stable final tiebreak (original
// index) so output is deterministic run-to-run.
//
// Priority (lower sorts first):
//   1. carries a geo signal (lexical/explicit) — likely relevant AND admitted
//      via the cheap assessor-bypass, so it costs ~nothing and should never be
//      the item we defer.  `relevantSignalIds` holds these sourceIds.
//   2. from the current selected pool (fresh) ahead of hold-bucket backlog.
//   3. fresher (`minutesAgo` ascending).
//   4. `sourceId` ascending, then original index — fully deterministic.
export function prioritizeLane2Candidates(
  items,
  { selectedSourceIds = new Set(), relevantSignalIds = new Set() } = {}
) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const asig = relevantSignalIds.has(a.item?.sourceId) ? 0 : 1;
      const bsig = relevantSignalIds.has(b.item?.sourceId) ? 0 : 1;
      if (asig !== bsig) return asig - bsig;
      const afresh = selectedSourceIds.has(a.item?.sourceId) ? 0 : 1;
      const bfresh = selectedSourceIds.has(b.item?.sourceId) ? 0 : 1;
      if (afresh !== bfresh) return afresh - bfresh;
      const am =
        typeof a.item?.minutesAgo === "number" && Number.isFinite(a.item.minutesAgo)
          ? a.item.minutesAgo
          : Number.POSITIVE_INFINITY;
      const bm =
        typeof b.item?.minutesAgo === "number" && Number.isFinite(b.item.minutesAgo)
          ? b.item.minutesAgo
          : Number.POSITIVE_INFINITY;
      if (am !== bm) return am - bm;
      const aid = a.item?.sourceId ?? "";
      const bid = b.item?.sourceId ?? "";
      if (aid < bid) return -1;
      if (aid > bid) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.item);
}

/**
 * Converts a meta-story + its resolved source items into the response story shape
 * expected by dashboardPayloadSchema.  Derives schema-constrained fields (topic,
 * geographies, priority) from the source items so they stay within enum bounds.
 */
function buildStory(metaStory, sourceItems, settings) {
  const validGeos = sourceItems
    .flatMap((i) => i.geographies)
    .filter((g) => VALID_GEOGRAPHIES.has(g));
  const geographies = [...new Set(validGeos)];

  // Phase 1 trust cleanup: never fabricate a topic.  The legacy fallback
  // (`?? "Diplomatic relations"`) silently invented a canonical-looking label
  // for stories whose sources carried no recognized topic, which then showed
  // up as a real chip in the UI.  Now we emit `topic` only when at least one
  // source item resolves to a canonical topic; otherwise the field is omitted
  // (`storySchema.topic` is optional).  UI labels are driven by `tags` only.
  const rawTopics = sourceItems.map((i) => normalizeTopicLabel(i.topic));
  const validTopic = rawTopics.find((t) => VALID_TOPICS.has(t));

  const maxWeight = Math.max(...sourceItems.map((i) => i.weight), 0);
  const priority = maxWeight >= 80 ? "top" : "standard";

  const story = {
    id: metaStory.meta_story_id,
    metaStoryId: metaStory.meta_story_id,
    title: metaStory.title,
    // `subtitle` carries clustering context (one-sentence placement) and
    // `summary` is the narrative join of grounded claims — both populated by
    // `verifyGrounding` under the C0 policy.
    subtitle: metaStory.subtitle,
    geographies,
    summary: metaStory.summary,
    // Phase 5 (why-this-matters): schema-valid placeholder retired the
    // legacy subtitle echo (`whyItMatters: metaStory.subtitle`).  The
    // per-story `resolveWhyItMatters` loop further down overwrites this
    // before the payload is returned; the placeholder is the conservative
    // intro safe-fallback so a missed overwrite would still ship neutral,
    // non-prescriptive copy.  No environment may ship subtitle echo
    // (spec §1, §11).
    whyItMatters: WHY_FALLBACK_COPY.intro,
    // Phase 4 (what-changed): set to a schema-valid placeholder here and
    // overwritten by the per-story `resolveWhatChanged` loop further down
    // (see "Phase 4: compute whatChanged per story").  The legacy
    // freshness-template default is retired; the pipeline always replaces
    // this value before the payload is returned.
    whatChanged: WHAT_CHANGED_COPY.unchanged,
    priority,
    // `outletCount` reports unique source identities (one per distinct outlet/
    // handle); the prototype's collapsed story-card chip surfaces this as
    // "N sources". Total pieces are still available via `sources.length`.
    // `normalizeSourceIdentity` collapses casing/whitespace so the same outlet
    // emitted with formatting drift ("Reuters" / "reuters ") counts once.
    // Blank/whitespace-only outlets normalize to "" and are filtered out so
    // missing-data rows never inflate the count.
    outletCount: new Set(
      sourceItems
        .map((i) => normalizeSourceIdentity(i.outlet))
        .filter((k) => k.length > 0)
    ).size,
    // Deterministic baseline tags (Phase 3 — settings-gated, evidence-bundle
    // + alias-driven).  Phase 4 semantic uplift, when enabled, is layered
    // over this baseline by the post-build overlay below.  See
    // [`meta-story-tags.mjs`](./meta-story-tags.mjs).
    tags: assignMetaStoryTags({ metaStory, sourceItems, settings }),
    // `_duplicates` provenance from the cross-feed dedupe stage is intentionally
    // NOT projected onto the response shape — duplicate provenance stays
    // server-side for integrity/debugging only (product req: no expand UI,
    // no "also seen in X feeds", no duplicate-source disclosure).
    // T1 (M6b): server-canonical ordering for the chips/expanded view.
    // Sort BEFORE the response projection so input arrays stay untouched
    // and the comparator can rely on the canonical `sourceId` field.
    sources: sourceItems
      .slice()
      .sort(compareSourcesT1)
      .map((item) => ({
        id: item.sourceId,
        outlet: item.outlet,
        byline: item.byline,
        kind: item.kind,
        weight: item.weight,
        url: item.url,
        minutesAgo: item.minutesAgo,
        headline: item.headline,
        body: item.body,
      })),
  };
  // Only attach `topic` when we actually have a canonical value — omitting
  // the field is the schema-honest signal for "no recognized topic" and
  // prevents the legacy "Diplomatic relations" fabrication.
  if (validTopic) story.topic = validTopic;
  return story;
}

// ─── Why-this-matters evidenceRefs builder ───────────────────────────────────
//
// Computes the structured `evidenceRefs` block the why-this-matters engine
// uses for grounding (spec §4 + strategy §3c).  Pure function of the
// (post-Phase-4) story shape + the resolved whatChangedState.  Heuristic
// for `framingDivergence` and `cadenceSignal` — sufficient for MVP grounding
// (trace gets the value the engine actually saw) while we defer per-source
// stance modeling to a later slice.
function computeEvidenceRefsForStory(story, whatChangedState) {
  const summary = typeof story?.summary === "string" ? story.summary : "";
  const sources = Array.isArray(story?.sources) ? story.sources : [];
  const sourceCount = sources.length;
  const uniqueOutlets = new Set();
  for (const s of sources) {
    if (s && typeof s.outlet === "string") {
      const norm = normalizeSourceIdentity(s.outlet);
      if (norm.length > 0) uniqueOutlets.add(norm);
    }
  }
  const uniqueOutletCount = uniqueOutlets.size;

  // Cadence: only `accelerating` when the delta engine confirmed material
  // change this refresh.  Conservative `stable` otherwise — we do not yet
  // track multi-refresh cadence trends.
  let cadenceSignal = "stable";
  if (whatChangedState === "changed") cadenceSignal = "accelerating";

  // FramingDivergence: rough outlet-diversity proxy.  Single-outlet or
  // narrow coverage → low; broader spread bumps to medium/high.  Tightened
  // to lean conservative so the writer doesn't over-call divergence.
  let framingDivergence = "low";
  if (sourceCount >= 4 && uniqueOutletCount >= 4) framingDivergence = "medium";
  if (sourceCount >= 6 && uniqueOutletCount >= 5) framingDivergence = "high";

  return {
    summaryChars: summary.length,
    sourceCount,
    uniqueOutletCount,
    framingDivergence,
    cadenceSignal,
  };
}

// ─── Slice 15: writer-only normalized-evidence enrichment ────────────────────
//
// The response story carries the ORIGINAL (possibly Spanish) source
// headline/body for display. The what-changed writer, however, must ground its
// Haiku/Sonnet evidence bundle on the normalized English evidence. This returns
// a shallow clone whose sources also carry `normalizedHeadline`/`normalizedBody`
// (looked up from the translated source items by id), so the engine's
// `readHeadline`/`readBodyText` resolve to English. The original `story` is
// never mutated — normalized fields stay internal and never reach the payload.
function withNormalizedEvidence(story, sourceItemsById) {
  if (!story || !Array.isArray(story.sources) || !(sourceItemsById instanceof Map)) {
    return story;
  }
  let enriched = false;
  const sources = story.sources.map((s) => {
    const item = s && typeof s.id === "string" ? sourceItemsById.get(s.id) : null;
    const hasNormalized =
      item &&
      (typeof item.normalizedHeadline === "string" ||
        (Array.isArray(item.normalizedBody) && item.normalizedBody.length > 0));
    if (!hasNormalized) return s;
    enriched = true;
    return { ...s, normalizedHeadline: item.normalizedHeadline, normalizedBody: item.normalizedBody };
  });
  return enriched ? { ...story, sources } : story;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full refresh pipeline:
 *   normalize → source pool → 24h → geo filter → topic+keyword filter → cluster → verify grounding → build payload
 *
 * @param {object} opts
 * @param {object} opts.settings      — user settings
 * @param {Array}  opts.rawItems      — raw items from feed-reader (not yet normalized)
 * @param {Function} opts.clusterFn  — injectable cluster function (for tests)
 * @param {string} opts.clusterModel — model string for clustering
 * @param {string} opts.contractVersion — version to embed in payload
 * @param {Function} [opts.geoAssessFn]      — injectable geo-confidence assessor (for tests)
 * @param {Function} [opts.readHeldFn]       — injectable hold bucket reader; returns previously held items
 * @param {Function} [opts.writeHeldFn]      — injectable hold bucket writer (for tests)
 * @param {Function} [opts.readPriorSnapshotFn] — injectable prior snapshot reader (for ID lineage continuity)
 * @param {string[]} [opts.everSeenMetaStoryIds]  — what-changed: union of every metaStoryId
 *                                                  previously shipped to this user.  Populated by
 *                                                  the route handler from the prior snapshot's
 *                                                  `_everSeenMetaStoryIds`.  Drives the first-seen
 *                                                  branch of the engine; count surfaces on
 *                                                  `log.whatChanged.everSeenCount`.
 * @param {Map<string,object>} [opts.priorStoriesById] — what-changed: map of prior story payloads
 *                                                  keyed by metaStoryId.  The delta engine diffs
 *                                                  current vs prior for the gate; count surfaces on
 *                                                  `log.whatChanged.priorStoryCount`.
 * @param {Function} [opts.classifyFn]              — test injection: stub for Haiku classify.
 *                                                  Production reads model + key from env via
 *                                                  `resolveDeltaConfig()`; tests pass a stub here.
 * @param {Function} [opts.writeFn]                 — test injection: stub for Sonnet write.
 * @param {object}   [opts.deltaConfig]             — test injection: override of
 *                                                  `resolveDeltaConfig()` so tests can enable LLM
 *                                                  paths without env mutation.
 * @param {Array}    [opts.manifestFeeds]    — manifest feed list for source matching (Phase 2)
 * @param {object}   [opts.aliasMap]         — merged alias map (Supabase ∪ repo fallback)
 * @param {string[]} [opts.fallbackFeedIds]  — env-configured fallback baseline feed IDs
 * @param {boolean}  [opts.fallbackEnabled]
 * @param {Function} [opts.writeRejectionsFn] — injectable rejection-log writer (Phase 3)
 * @param {string}   [opts.priorWatermark]    — last persisted watermark (Phase 4); when matching the
 *                                              candidate watermark, the pipeline short-circuits and
 *                                              skips clustering/grounding/lock/rejection writes.
 * @param {number|null} [opts.priorStoryCount] — number of stories in the prior persisted snapshot.
 *                                              When this is `0` and we have items to cluster, the
 *                                              watermark short-circuit is suppressed so a previously
 *                                              empty snapshot doesn't trap us at zero — clustering and
 *                                              grounding get another chance.  Pass `null` (default)
 *                                              when the count is unknown; the guard does not engage.
 * @param {Function} [opts.embedFn]            — async (texts: string[]) => number[][]; recall stage
 *                                              uses this to compute the profile + per-item embeddings.
 *                                              Caller injects from src/ai/embeddings.mjs in production
 *                                              and from tests with deterministic stubs.  Required when
 *                                              recall mode is `hybrid_strict`; missing → fail-closed.
 * @param {object}   [opts.recallConfig]       — override for `resolveRecallConfig()` (tests only).
 * @param {Function} [opts.resolveWhyItMattersFn] — TEST-ONLY seam: override implications
 *                                                  resolver to exercise rejected-settle fallback paths.
 *
 * @returns {{ payload: object, log: object }}
 *   payload — ready-to-persist dashboard payload
 *   log     — observability metadata (includes selection meta in `log.selection`
 *             and Phase 3 strict-grounding metrics)
 */
export async function runRefreshPipeline({
  settings,
  rawItems,
  clusterFn,
  clusterModel,
  contractVersion,
  geoAssessFn = mockAssessGeoConfidence,
  // A1.1 — geo-stage wall-clock budget override (ms). Tests pin it (e.g. 0 to
  // force a post-Lane-1 budget hit) without env mutation; production falls
  // through to `resolveGeoStageBudgetMs()` (default 25000).
  geoStageBudgetMs = null,
  readHeldFn = null,
  writeHeldFn = null,
  readPriorSnapshotFn = null,
  manifestFeeds = null,
  aliasMap = undefined,
  fallbackFeedIds = [],
  fallbackEnabled = true,
  writeRejectionsFn = null,
  priorWatermark = null,
  priorStoryCount = null,
  beatFitEnabled = true,
  embedFn = null,
  recallConfig = null,
  // Slice 14 — translation-first evidence normalization (ES→EN). `translateFn`
  // is the injected batch segment translator; production wraps the AI router,
  // tests pass a deterministic stub. `translationConfig` overrides
  // `resolveTranslationConfig()` (default OFF) so tests enable the stage without
  // env mutation. `translationCache` lets tests assert cache hits across runs.
  // When disabled / no translateFn, the stage is a no-op pass-through and the
  // pipeline behaves exactly as before (English-only posture).
  translateFn = null,
  translationConfig = null,
  translationCache = null,
  // Phase 4: optional semantic tag-mapping config + scorer.  When omitted,
  // `resolveSemanticTagConfig()` reads env (defaults OFF), and no scorer is
  // present — the pipeline degrades cleanly to the Phase 3 deterministic
  // baseline.  Tests inject both to exercise the uplift path without env
  // mutation.  Geographies are intentionally NOT widened — see
  // [`meta-story-tags.mjs`](./meta-story-tags.mjs) for the Phase 4 scope.
  semanticTagConfig = null,
  semanticTagScorer = null,
  // Option A — semantic BeatFit configuration + scorer wiring.
  // `semanticBeatFitConfig` falls through to env (default ENABLED).
  // `semanticBeatFitEmbedFn` falls through to `embedFn` so callers can wire
  // one embedder for both recall widening and semantic BeatFit; tests inject
  // a distinct deterministic stub when they want to assert the two stages
  // independently.
  // `semanticBeatFitProfileCache` lets tests pass an isolated cache to avoid
  // leaking profile vectors across cases.
  semanticBeatFitConfig = null,
  semanticBeatFitEmbedFn = null,
  semanticBeatFitProfileCache = null,
  // What-changed engine inputs.  The route handler reads the prior snapshot
  // once and hands both priors in: `everSeenMetaStoryIds` drives the
  // first-seen branch; `priorStoriesById` is the per-`metaStoryId` map the
  // structural gate diffs against.  `classifyFn` / `writeFn` / `deltaConfig`
  // are test injection points — production reads env via
  // `resolveDeltaConfig()` and stays disabled until an operator sets
  // `TEMPO_AI_DELTA_ENABLED=true`.
  everSeenMetaStoryIds = null,
  priorStoriesById = null,
  classifyFn = null,
  writeFn = null,
  deltaConfig = null,
  // Test seam for the what-changed resolver itself (not just its classify/write
  // stubs). Defaults to the imported `resolveWhatChanged`; mirrors
  // `resolveWhyItMattersFn` so the D2 advisory eval can inject deterministic
  // per-story failures without driving the structural gate. Zero behavior
  // change when null.
  resolveWhatChangedFn = null,
  // Why-this-matters engine inputs (spec §6, §9).  `whyWriteFn` is a test
  // injection for the Sonnet writer; production reads model + key from env
  // via `resolveWhyConfig()`.  `whyConfig` lets tests enable the LLM path
  // without env mutation.  Default posture is LLM-first when
  // `TEMPO_AI_WHY_IT_MATTERS_ENABLED=true` (server.mjs bootstraps this on
  // for non-test environments); the deterministic state template is the
  // fallback / kill-switch path.
  whyWriteFn = null,
  whyConfig = null,
  // Test seam for the implications resolver itself (not just its writer).
  // Defaults to the imported `resolveWhyItMatters`; tests inject a wrapper to
  // exercise the rejected-settle defensive path in the Phase 5 parallel apply
  // (a throwing `whyWriteFn` is caught inside the resolver, so it cannot
  // produce a rejected pMap settle on its own). Zero behavior change when null.
  resolveWhyItMattersFn = null,
  // Doctrine retrieval injection point (spec §5).  Production reads the
  // hand-curated `doctrine-snippets.v0.json` allowlist via
  // `retrieveDoctrineSnippetsForStory`; tests pass a stub here to control
  // exactly which snippets the writer sees without touching the on-disk
  // corpus.  Signature: ({ story, state }) => Array<snippet>; throws are
  // caught and resolve to `[]` (spec §5 "retrieval error / timeout").
  doctrineRetrievalFn = null,
  // Slice 2 — post-cluster split healer config. When omitted,
  // `resolveClusterSplitConfig()` reads env (default ENABLED). Tests inject an
  // override (e.g. `{ enabled: false }`) to exercise — or opt out of — the
  // healer without env mutation, mirroring the other stage-config injection
  // points above.
  clusterSplitConfig = null,
  // Slice 4 — latency-shaping profile for this run.  `"interactive"` activates
  // the onboarding fast-path (bounded geo Lane-2 budget + tighter clustering
  // envelope); null / anything else keeps the default scheduled/background
  // behavior.  The route passes `"interactive"` only for onboarding-driven
  // interactive entries; the heartbeat and bootstrap paths leave it null.
  refreshProfile = null,
  // Slice 5 — progressive whyItMatters enrichment.  When true, the per-story
  // implications WRITER is skipped at first paint: every published story gets
  // the deterministic, state-aware safe fallback copy (non-empty, never a
  // subtitle echo) so the interactive response paints immediately, and the
  // server runs an async enrichment pass that upgrades the copy in place.
  // Trust is unchanged — no fabricated stories, only `whyItMatters` is
  // progressively enriched; clustering fail-closed continuity is untouched.
  deferWhyItMatters = false,
}) {
  const profile = resolveRefreshProfile(refreshProfile);
  const effectiveRecallConfig = recallConfig ?? resolveRecallConfig();
  const effectiveSemanticTagConfig = semanticTagConfig ?? resolveSemanticTagConfig();
  const effectiveSemanticBeatFitConfig =
    semanticBeatFitConfig ?? resolveSemanticBeatFitConfig();
  const effectiveSemanticBeatFitEmbedFn =
    typeof semanticBeatFitEmbedFn === "function"
      ? semanticBeatFitEmbedFn
      : embedFn;
  // What-changed pass-through counts, folded into `log.whatChanged` on
  // both the watermark short-circuit and the full-run branch so operators
  // can confirm the engine saw its priors.  Local names are prefixed to
  // avoid shadowing the unrelated `priorStoryCount` option above (which
  // counts the prior *snapshot's* stories for the watermark trap-guard,
  // not the size of the lookup map used here).
  const whatChangedEverSeenCount = Array.isArray(everSeenMetaStoryIds) ? everSeenMetaStoryIds.length : 0;
  const whatChangedPriorStoryCount =
    priorStoriesById && typeof priorStoriesById.size === "number"
      ? priorStoriesById.size
      : 0;
  // Slice 7: top-level wall-clock bracket. Only the full-run branch sets
  // log.timings; the watermark short-circuit returns before clustering.
  const pipelineStartedAt = Date.now();
  // 1. Normalize
  const { items: normalizedItems, errors: normErrors } = normalizeSourceItems(rawItems);
  if (normErrors.length > 0) {
    console.warn(`[pipeline] ${normErrors.length} item(s) skipped during normalization:`, normErrors);
  }

  // 2. Time window FIRST (per Phase 2 product decision: pre-source-selection,
  //    pre-relevance).  Items older than 24h are dropped before any selection
  //    or relevance work so downstream stages don't burn on stale items.
  const recentNormalizedItems = apply24hFilter(normalizedItems);

  // 3. Source selection (Phase 2): resolve user-selected sources against the
  //    manifest with alias map + connector availability.  When manifestFeeds
  //    is provided (production path), use the matcher.  When absent (legacy
  //    tests), fall back to the simple outlet-set selectSourcePool below.
  //
  //    C2 (M6): zero configured sources → strict-empty BEFORE we hit the
  //    matcher.  The matcher's `NO_SELECTED_SOURCES` fallback would otherwise
  //    return the configured fallback feeds — defeating the product rule that
  //    says "the user hasn't picked a beat, so we serve nothing".  Enforcing
  //    C2 in the pipeline (not the matcher) keeps the matcher a pure utility
  //    while binding the product gate to the funnel.
  let selectionMeta;
  let recentItems;
  const selectedNames = [
    ...(settings.traditionalSources ?? []),
    ...(settings.socialSources ?? []),
  ];
  if (selectedNames.length === 0) {
    recentItems = [];
    selectionMeta = {
      sourceSelectionMode: SELECTION_MODE.STRICT,
      sourceFallbackUsed: false,
      sourceFallbackReason: FALLBACK_REASON.NO_SELECTED_SOURCES,
      matchedSourceCount: 0,
      selectedSourceCount: 0,
      unmatchedSelectedSources: [],
      unavailableConnectorCount: 0,
      unavailableConnectorSources: [],
      matchedFeedIds: [],
    };
    console.log(
      `[pipeline.selection] C2 fail-closed: zero configured sources → strict-empty`
    );
  } else if (manifestFeeds) {
    const selection = resolveSelectedSources({
      selectedSources: selectedNames,
      manifestFeeds,
      aliasMap,
      fallbackFeedIds,
      fallbackEnabled,
    });
    // Layer two indices over `selection.matchedFeeds`:
    //   - feedIds (exact match) — authoritative for live items that carry
    //     `feedId` from feed-reader.mapEntry; survives canonical_name drift
    //     between the matcher's manifest snapshot and the reader's.
    //   - outlets (bidirectional substring) — legacy path used by fixture
    //     items that have only `outlet`.  Kept so existing tests and the
    //     fixture pipeline don't change behavior.
    const matchedKeys = {
      feedIds: buildMatchedFeedIdSet(selection.matchedFeeds),
      outlets: buildMatchedOutletSet(selection.matchedFeeds),
    };
    recentItems = filterItemsToMatchedFeeds(recentNormalizedItems, matchedKeys);
    // Low-noise diagnostic: when source-selection collapses a non-empty
    // input pool to zero despite matched feeds, log a small sample so
    // operators can see the mismatch shape without grepping per-item logs.
    if (
      recentItems.length === 0 &&
      recentNormalizedItems.length > 0 &&
      selection.matchedFeeds.length > 0
    ) {
      const sample = recentNormalizedItems.slice(0, 3).map((it) => ({
        feedId: it?.feedId ?? null,
        outlet: it?.outlet ?? null,
      }));
      console.warn(
        `[pipeline.selection] source_selection drop-to-zero: input=${recentNormalizedItems.length} matchedFeeds=${selection.matchedFeeds.length} matchedFeedIds=${JSON.stringify([...matchedKeys.feedIds])} matchedOutlets=${JSON.stringify([...matchedKeys.outlets])} sampleItems=${JSON.stringify(sample)}`
      );
    }
    selectionMeta = {
      sourceSelectionMode: selection.mode,
      sourceFallbackUsed: selection.fallbackUsed,
      sourceFallbackReason: selection.fallbackReason,
      matchedSourceCount: selection.matchedSourceCount,
      selectedSourceCount: selection.selectedSourceCount,
      unmatchedSelectedSources: selection.unmatchedSelectedSources,
      unavailableConnectorCount: selection.unavailableConnectorCount,
      unavailableConnectorSources: selection.unavailableConnectorSources,
      matchedFeedIds: selection.matchedFeeds.map((f) => f.id),
    };
    // Low-noise diagnostic: counts always; the actual unmatched/unavailable
    // source NAMES only when non-zero, so a mismatch (e.g. the embassy
    // `matched=6/7`) names the culprit without grepping per-item logs. The
    // happy path (all matched) stays a single clean counts line.
    const unmatchedNames = selection.unmatchedSelectedSources;
    const unavailableNames = selection.unavailableConnectorSources;
    console.log(
      `[pipeline.selection] mode=${selection.mode} fallback=${selection.fallbackUsed}${selection.fallbackReason ? ` reason=${selection.fallbackReason}` : ""} matched=${selection.matchedSourceCount}/${selection.selectedSourceCount} unmatched=${unmatchedNames.length} unavailable=${selection.unavailableConnectorCount} feeds=${selectionMeta.matchedFeedIds.length}` +
        (unmatchedNames.length > 0 ? ` unmatchedSources=${JSON.stringify(unmatchedNames)}` : "") +
        (unavailableNames.length > 0 ? ` unavailableSources=${JSON.stringify(unavailableNames)}` : "")
    );
  } else {
    recentItems = selectSourcePool(recentNormalizedItems, settings);
    selectionMeta = {
      sourceSelectionMode: SELECTION_MODE.STRICT,
      sourceFallbackUsed: false,
      sourceFallbackReason: null,
      matchedSourceCount: 0,
      selectedSourceCount: ((settings.traditionalSources ?? []).length + (settings.socialSources ?? []).length),
      unmatchedSelectedSources: [],
      unavailableConnectorCount: 0,
      unavailableConnectorSources: [],
      matchedFeedIds: [],
    };
  }

  // `recentItems` here = items that passed both the 24h time window AND source
  // selection.  The log surfaces both `poolCount` and `recentCount` as
  // historical aliases — they are equal by construction.

  // 4a. Merge with previous hold bucket — re-evaluate held items this refresh
  let previouslyHeld = [];
  if (readHeldFn) {
    try {
      const rawHeld = await readHeldFn();
      // Strip geo metadata (geoCategory/geoConfidence) added by the previous run
      // Dedupe: skip any sourceId already present in the current recent pool
      const currentIds = new Set(recentItems.map((i) => i.sourceId));
      previouslyHeld = (rawHeld ?? [])
        .map(({ geoCategory: _gc, geoConfidence: _gf, ...item }) => item)
        .filter((item) => !currentIds.has(item.sourceId));
      if (previouslyHeld.length > 0) {
        console.log(`[pipeline] merging ${previouslyHeld.length} item(s) from hold bucket for re-evaluation`);
      }
    } catch (err) {
      console.warn(`[pipeline] hold bucket read failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const candidateItems = [...recentItems, ...previouslyHeld];

  // 4b. Geo-confidence filter (categorize → assess → apply thresholds → persist hold bucket)
  //     The per-item assessor (Haiku) runs as a bounded-concurrency pool, so we
  //     bracket the whole stage as its own `geoMs` span — like recallMs, it is
  //     measured separately and excluded from preClusterMs (no double-count).
  //
  //     A1.1 — two protected lanes under a wall-clock budget:
  //       • Lane 1 (must-see): from a SELECTED source AND with a geo signal
  //         (explicit `item.geographies` overlap OR a configured-geography
  //         lexical mention). Topic/keyword are NOT required. Lane 1 is ALWAYS
  //         processed to completion, even if it alone blows the budget — these
  //         are the stories the user most expects to see.
  //       • Lane 2 (opportunistic): every other candidate (no geo signal, or a
  //         re-evaluation pulled back from the hold bucket). Processed in
  //         concurrency-sized waves only while the budget holds; once the budget
  //         is exhausted the remainder is deferred to the hold path so it is
  //         re-evaluated next refresh (never dropped).
  const configuredGeos = settings.geographies ?? [];
  // Precedence: explicit test override (`geoStageBudgetMs`) > active profile's
  // budget (Slice 4 interactive fast-path tightens this) > env/default.
  const effectiveGeoBudgetMs =
    geoStageBudgetMs ?? profile.geoStageBudgetMs ?? resolveGeoStageBudgetMs();
  // "Selected source" = present in the current source-selected pool. Held-bucket
  // re-evaluations (previouslyHeld) are deliberately Lane 2: fresh must-see
  // content takes priority over re-litigating the backlog under load.
  const selectedSourceIds = new Set(recentItems.map((i) => i.sourceId));
  // Slice 6: per-run memo for the (regex-heavy) lexical/explicit geo-signal
  // check, keyed by sourceId.  The lane-split below and the Lane 2 prioritizer
  // both need the SAME signal over the SAME text surface (`joinGeoText`), so a
  // run-scoped memo collapses the duplicate work to one computation per
  // candidate.  Safe because, within a run, both `configuredGeos` and an item's
  // text are constant for a given sourceId.
  const geoSignalMemo = new Map();
  let geoSignalMemoHits = 0;
  const hasGeoSignal = (item) => {
    if (configuredGeos.length === 0) return false;
    const key = item?.sourceId;
    if (key != null && geoSignalMemo.has(key)) {
      geoSignalMemoHits += 1;
      return geoSignalMemo.get(key);
    }
    const signal =
      categorizeItem(item, configuredGeos) === GEO_CATEGORY.EXPLICIT_MATCH ||
      itemMentionsConfiguredGeography(joinGeoText(item), configuredGeos) !== null;
    if (key != null) geoSignalMemo.set(key, signal);
    return signal;
  };
  const lane1Items = [];
  const lane2Items = [];
  for (const item of candidateItems) {
    if (selectedSourceIds.has(item.sourceId) && hasGeoSignal(item)) lane1Items.push(item);
    else lane2Items.push(item);
  }
  // Slice 6: reorder Lane 2 so the most-likely-relevant + cheapest-to-admit
  // candidates are assessed first under budget pressure; the deferred tail
  // (written to the hold path, re-evaluated next refresh) is then the least
  // promising items.  Pass/fail logic and the hold-path continuity are
  // unchanged — only assessment order shifts.  `relevantSignalIds` reuses the
  // memo populated during lane-split (memo hits, no recomputation).
  const lane2RelevantSignalIds = new Set(
    lane2Items.filter((item) => hasGeoSignal(item)).map((item) => item.sourceId)
  );
  const lane2Ordered = prioritizeLane2Candidates(lane2Items, {
    selectedSourceIds,
    relevantSignalIds: lane2RelevantSignalIds,
  });
  // A1.1 (recall protection): the set of must-see sourceIds, used after the
  // recall gate to union Lane 1 survivors that topic/keyword recall would
  // otherwise drop (an explicit-geo item whose *text* never names the geo).
  const lane1SourceIds = new Set(lane1Items.map((i) => i.sourceId));

  // A1.2: request-scoped geo diagnostics — created per run and threaded into
  // `applyGeoFilter`, so 429/retry counts can't bleed across overlapping
  // refreshes the way the old global-snapshot delta could.
  const geoDiag = createGeoDiagnostics();
  const geoStartedAt = Date.now();

  // Lane 1 always runs to completion (budget does not interrupt it).
  const lane1Result = await applyGeoFilter(lane1Items, configuredGeos, geoAssessFn, geoDiag);
  const geoPassedItems = [...lane1Result.included];
  const geoHeldItems = [...lane1Result.held];

  // Lane 2 runs in concurrency-sized waves; the budget is re-checked before each
  // wave so the stage stops cleanly at a pool boundary instead of mid-flight.
  const geoLane2DeferredItems = [];
  let geoBudgetHit = false;
  // Slice 2 (cold_start): when the active profile sets `deferGeoLane2`, ALL of
  // Lane 2 (including held-bucket re-evals) is deferred to the hold path without
  // assessment — an intentional, profile-driven defer, NOT budget pressure. We
  // skip the wave loop entirely (no `applyGeoFilter` / assessor calls for Lane 2)
  // and leave `geoBudgetHit = false` (locked decision) so SLO/log consumers don't
  // misread this as the geo budget being exhausted.
  const geoLane2DeferredReason = profile.deferGeoLane2 ? "profile_defer" : null;
  if (profile.deferGeoLane2) {
    geoLane2DeferredItems.push(...lane2Ordered);
  } else {
    const lane2WaveSize = Math.max(1, resolveGeoAssessConcurrency());
    // Iterate the PRIORITY-ORDERED Lane 2 set so the most-likely-relevant items
    // are assessed before the budget runs out; the deferred slice is the
    // lowest-priority tail.
    for (let i = 0; i < lane2Ordered.length; i += lane2WaveSize) {
      if (Date.now() - geoStartedAt >= effectiveGeoBudgetMs) {
        geoBudgetHit = true;
        geoLane2DeferredItems.push(...lane2Ordered.slice(i));
        break;
      }
      const wave = lane2Ordered.slice(i, i + lane2WaveSize);
      const waveResult = await applyGeoFilter(wave, configuredGeos, geoAssessFn, geoDiag);
      geoPassedItems.push(...waveResult.included);
      geoHeldItems.push(...waveResult.held);
    }
  }

  const geoEndedAt = Date.now();
  const geoMs = Math.max(0, geoEndedAt - geoStartedAt);
  const geoRateLimitedCount = geoDiag.rateLimitedCount;
  const geoRetryCount = geoDiag.retryCount;
  const geoBackoffMsTotal = geoDiag.backoffMsTotal;
  // A2: items admitted by the lexical pre-pass (configured-geography mention in
  // text) without spending an assess call. Request-scoped via `geoDiag`.
  const geoLexicalBypassCount = geoDiag.lexicalBypassCount;
  const geoLane1Count = lane1Items.length;
  const geoLane2Count = lane2Items.length;
  const geoLane2DeferredCount = geoLane2DeferredItems.length;
  // How many items actually hit the (Haiku) assessor — explicit_match items
  // pass through without a call, A2 lexical-bypass items skip the call, an empty
  // configuredGeos set assesses nothing, and budget-deferred Lane 2 items are
  // never assessed.  Observability only: lets an operator confirm the assess
  // pool's workload against geoMs (Slice 3) and the pre-pass's effect (A2).
  const geoAssessedCount = [...geoPassedItems, ...geoHeldItems].filter(
    (i) =>
      !i.geoLexicalBypass &&
      (i.geoCategory === GEO_CATEGORY.EXPLICIT_CONFLICT ||
        i.geoCategory === GEO_CATEGORY.IMPLICIT_GEO)
  ).length;

  // A1.1 — per-refresh geo diagnostics, surfaced in `_meta`/logs on both the
  // normal and watermark-skip return paths so lane/budget behavior is auditable
  // without re-deriving it. Retains the A1 rate-limit/retry counters.
  const geoDiagnostics = {
    geoLane1Count,
    geoLane2Count,
    geoLane2DeferredCount,
    // Slice 2: why Lane 2 was deferred — "profile_defer" for an intentional
    // profile-driven defer (cold_start), else null. Budget-pressure defers leave
    // this null and are signalled by `geoBudgetHit` instead.
    geoLane2DeferredReason,
    geoBudgetMs: effectiveGeoBudgetMs,
    geoBudgetHit,
    geoAssessedCount,
    geoLexicalBypassCount,
    geoHeldCount: geoHeldItems.length,
    geoRateLimitedCount,
    geoRetryCount,
    geoBackoffMsTotal,
    // ── Slice 6: explicit throughput counters (additive; existing keys above
    //    retained for back-compat).  `*Processed` make "what actually ran this
    //    refresh" unambiguous vs the `*Count` candidate totals; the budget pair
    //    lets ops compare profile-on (interactive 12000) vs baseline (25000)
    //    against the wall clock actually consumed.
    geoLane1Processed: geoLane1Count, // Lane 1 is always processed to completion
    geoLane2Processed: geoLane2Count - geoLane2DeferredCount,
    geoLane2Deferred: geoLane2DeferredCount,
    geoBudgetMsConfigured: effectiveGeoBudgetMs,
    geoBudgetMsUsed: geoMs,
    geoStageLatencyMs: geoMs,
    // Redundant-work avoided this run: lexical/explicit geo-signal checks served
    // from the per-run memo instead of recomputed (lane-split ↔ Lane 2 sort).
    geoSignalMemoHits,
  };

  // Persist BOTH the low-confidence holds and the budget-deferred Lane 2 items
  // to the hold path. Deferred items carry no geo metadata yet — the hold reader
  // strips geoCategory/geoConfidence anyway, so a bare item re-enters next
  // refresh's candidate pool cleanly for a fresh assessment.
  const geoHoldToWrite = [...geoHeldItems, ...geoLane2DeferredItems];
  if (writeHeldFn) {
    try {
      await writeHeldFn(geoHoldToWrite);
    } catch (err) {
      console.warn(`[pipeline] hold bucket write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (geoHoldToWrite.length > 0) {
    const lane2DeferredLabel =
      geoLane2DeferredCount > 0
        ? geoLane2DeferredReason ?? "budget"
        : "none";
    console.log(
      `[pipeline] ${geoHoldToWrite.length} item(s) in geo hold bucket after this refresh` +
        ` (${geoHeldItems.length} low-confidence,` +
        ` ${geoLane2DeferredCount} lane2-deferred[${lane2DeferredLabel}])`
    );
  }

  // A1.1 + A1: one concise line that makes lane split, budget behavior, and
  // rate-limit pressure obvious in prod logs.
  console.log(
    `[pipeline.geo] lane1=${geoLane1Count} lane2=${geoLane2Count}` +
      ` lane1_processed=${geoLane1Count} lane2_processed=${geoLane2Count - geoLane2DeferredCount}` +
      ` lane2_deferred=${geoLane2DeferredCount}` +
      ` lane2_deferred_reason=${geoLane2DeferredReason ?? "none"}` +
      ` budget_ms=${effectiveGeoBudgetMs}` +
      ` budget_ms_used=${geoMs} budget_hit=${geoBudgetHit} assessed=${geoAssessedCount}` +
      ` lexical_bypass=${geoLexicalBypassCount} memo_hits=${geoSignalMemoHits}` +
      ` held=${geoHeldItems.length}` +
      ` rate_limited=${geoRateLimitedCount} retries=${geoRetryCount}` +
      ` backoff_ms=${geoBackoffMsTotal} latency_ms=${geoMs}`
  );

  // 4b-bis. Translation-first evidence normalization (Slice 14).
  //
  //     Runs over the post-geo candidate set, BEFORE semantic intent scoring
  //     and recall, so every text-consuming stage downstream (lexical
  //     keyword/topic recall, embedding `buildItemText`, the geo lexical gate)
  //     reads normalized English evidence for non-English items. Originals are
  //     never mutated — the English text lands on `normalizedHeadline` /
  //     `normalizedBody`, and the readers fall back to originals for English
  //     items so this is a no-op for the all-English pool.
  //
  //     Bounded + fail-open: bounded concurrency + per-call timeout; a
  //     translation error/timeout leaves the item untranslated (recall still
  //     decides admission) and is recorded in diagnostics. It NEVER blocks the
  //     refresh. Default OFF — Spanish feeds are inactive until Phase 4, so
  //     production runs are no-ops until an operator wires `translateFn` and
  //     enables the stage.
  const effectiveTranslationConfig = translationConfig ?? resolveTranslationConfig();
  const translationStartedAt = Date.now();
  const { items: translatedGeoItems, diagnostics: translationStageDiagnostics } =
    await translateEvidenceItems({
      items: geoPassedItems,
      translateFn,
      config: effectiveTranslationConfig,
      cache: translationCache ?? undefined,
    });
  const translationMs = Math.max(0, Date.now() - translationStartedAt);
  console.log(
    `[pipeline.translation] version=${translationStageDiagnostics.version}` +
      ` enabled=${translationStageDiagnostics.enabled}` +
      ` candidates=${translationStageDiagnostics.candidateCount}` +
      ` needed=${translationStageDiagnostics.neededCount}` +
      ` translated=${translationStageDiagnostics.translatedCount}` +
      ` failed=${translationStageDiagnostics.failedCount}` +
      ` timeouts=${translationStageDiagnostics.timeoutCount}` +
      ` cache_hits=${translationStageDiagnostics.cacheHits}` +
      ` fallback_rate=${translationStageDiagnostics.degradedFallbackRate.toFixed(3)}` +
      ` p50_ms=${translationStageDiagnostics.latencyMsP50}` +
      ` p95_ms=${translationStageDiagnostics.latencyMsP95}` +
      ` latency_ms=${translationMs}`
  );

  // 4c. Semantic intent scoring (Option A — semantic BeatFit uplift).
  //
  //     Runs over ALL post-geo candidates (deliberately *before* the recall
  //     stage narrows) so the blended BeatFit score later has access to a
  //     semantic signal for every item that reached this point — not just the
  //     ones lexical recall passed.
  //
  //     The stage is fully optional: when disabled, mid-run kill-switched,
  //     or unable to embed (no fn / provider error / timeout), the function
  //     returns an empty score map and the items pass through unchanged.
  //     The BeatFit scorer then runs in pure deterministic mode for the rest
  //     of the refresh (graceful degradation, no broken snapshot).
  const semanticBeatFitResult = await computeSemanticBeatFitScores({
    items: translatedGeoItems,
    settings,
    embedFn: effectiveSemanticBeatFitEmbedFn,
    config: effectiveSemanticBeatFitConfig,
    profileCache: semanticBeatFitProfileCache ?? undefined,
  });
  const semanticBeatFitDiagnostics = semanticBeatFitResult.diagnostics;
  const semanticAnnotatedGeoItems = attachSemanticScores(
    translatedGeoItems,
    semanticBeatFitResult.scoresBySourceId
  );
  console.log(
    `[pipeline.semantic-beat-fit] version=${SEMANTIC_BEAT_FIT_VERSION}` +
      ` enabled=${semanticBeatFitDiagnostics.enabled}` +
      ` model=${semanticBeatFitDiagnostics.model ?? "n/a"}` +
      ` candidates=${geoPassedItems.length}` +
      ` scored=${semanticBeatFitDiagnostics.scoredCount}` +
      ` skipped=${semanticBeatFitDiagnostics.skippedCount}` +
      ` cache_hit=${semanticBeatFitDiagnostics.profileCacheHit}` +
      ` latency_ms=${semanticBeatFitDiagnostics.latencyMs}` +
      ` mean=${semanticBeatFitDiagnostics.meanScore == null ? "n/a" : semanticBeatFitDiagnostics.meanScore.toFixed(3)}` +
      (semanticBeatFitDiagnostics.degraded
        ? ` degraded=true reason=${semanticBeatFitDiagnostics.degradedReason}`
        : "")
  );

  // 5. Recall stage (embedding-aware).
  //
  //    Legacy keyword/topic filter still runs first so we never narrow recall
  //    vs the keyword baseline. In `hybrid_strict` mode (default) we then
  //    union it with semantic top-K from cosine similarity over a profile
  //    embedding; in `keyword` mode the embedding stage is bypassed entirely.
  //
  //    Fail-closed: an embedding error/timeout returns []; the pipeline does
  //    NOT silently fall back to keyword-only output. The route handler reads
  //    `log.recall.degraded_reason` to surface the cliff to operators without
  //    leaking speculative content to the user.
  // Stage-level breakdown computed before the filter runs so diagnostics can
  // distinguish "no input arrived" / "no topic match" / "no keyword match" /
  // "neither matched" — the four causes operators ask about when a clearly
  // relevant story is missing from the dashboard.  Counts are mutually
  // exclusive and add up to inputCount.
  // Use the semantically-annotated set from here on so every downstream item
  // carries its `semanticIntentScore` (when scored) into the recall, beat-fit,
  // and clustering stages.
  const topicKeywordBreakdown = analyzeTopicKeywordStage(semanticAnnotatedGeoItems, settings);
  const keywordRecallItems = applyTopicKeywordFilter(semanticAnnotatedGeoItems, settings);
  console.log(
    `[pipeline.topic-keyword] input=${topicKeywordBreakdown.inputCount}` +
      ` topicOnly=${topicKeywordBreakdown.topicOnly}` +
      ` keywordOnly=${topicKeywordBreakdown.keywordOnly}` +
      ` both=${topicKeywordBreakdown.both}` +
      ` geoLexicalOnly=${topicKeywordBreakdown.geoLexicalOnly}` +
      ` neither=${topicKeywordBreakdown.neither}` +
      ` pass=${topicKeywordBreakdown.passCount}` +
      ` hasTopics=${topicKeywordBreakdown.hasTopics}` +
      ` hasKeywords=${topicKeywordBreakdown.hasKeywords}` +
      (topicKeywordBreakdown.primaryDropCause
        ? ` drop_cause=${topicKeywordBreakdown.primaryDropCause}`
        : "")
  );

  const recallStartedAt = Date.now();
  const recallResult = await runEmbeddingRecall({
    candidateItems: semanticAnnotatedGeoItems,
    settings,
    keywordRecallItems,
    embedFn,
    config: effectiveRecallConfig,
  });
  const recallEndedAt = Date.now();
  const recallMs = Math.max(0, recallEndedAt - recallStartedAt);

  // A1.1 (recall protection): Lane 1 (must-see) items survive recall end-to-end.
  // The recall gate is text-driven (topic/keyword/geo-lexical), so an explicit-
  // geo Lane 1 item whose body never *names* the geography would be dropped here
  // even though the user explicitly tracks that geography from a selected
  // source. Union any such Lane 1 survivor — already past the geo stage, so we
  // pull the enriched copy from `semanticAnnotatedGeoItems` — back into the
  // recall set, deduped by sourceId, preserving recall order then appending. The
  // lexical gate's own diagnostics (`topicKeywordBreakdown`) are left untouched
  // so they keep faithfully describing the gate; this is an additive override,
  // not a change to recall semantics. Lane 1 items still face beat-fit, dedupe,
  // grounding, and clustering unchanged.
  //
  // Exception — recall fail-closed wins: when the embedding stage degraded
  // (e.g. embedFn threw in hybrid_strict), recall deliberately returns nothing
  // rather than leak unverified content. Lane protection must NOT paper over
  // that safety state, so we skip the union when `recall.degraded` is set.
  const recallDegraded = recallResult.diagnostics?.degraded === true;
  const recalledIds = new Set(recallResult.items.map((i) => i.sourceId));
  const lane1Protected = recallDegraded
    ? []
    : semanticAnnotatedGeoItems.filter(
        (it) => lane1SourceIds.has(it.sourceId) && !recalledIds.has(it.sourceId)
      );
  const recallItems = lane1Protected.length > 0
    ? [...recallResult.items, ...lane1Protected]
    : recallResult.items;
  if (lane1Protected.length > 0) {
    console.log(
      `[pipeline.recall] lane1_protected=${lane1Protected.length} must-see item(s) ` +
        `re-admitted past the topic/keyword gate`
    );
  }
  const recallDiagnostics = {
    ...recallResult.diagnostics,
    // Surface the lexical-stage breakdown alongside the embedding stats so
    // operators get a single `_meta.recall` object that answers both "how
    // did the lexical gate behave?" and "did embeddings widen recall?".
    topicKeywordBreakdown,
    // A1.1: count of must-see items re-admitted past the recall gate this run.
    lane1Protected: lane1Protected.length,
  };
  console.log(
    `[pipeline.recall] mode=${recallDiagnostics.mode}` +
      ` keyword=${recallDiagnostics.keywordRecallCount}` +
      ` embedded=${recallDiagnostics.embeddedCount ?? "n/a"}` +
      ` similarityKept=${recallDiagnostics.similarityKept ?? "n/a"}` +
      ` finalRelevant=${recallDiagnostics.finalRelevant}` +
      (recallDiagnostics.degraded_reason ? ` degraded_reason=${recallDiagnostics.degraded_reason}` : "") +
      (recallDiagnostics.keywordFallbackAfterEmbeddingFailure ? " keyword_fallback=true" : "")
  );

  // 5a. Beat-fit scoring (Phase 1 relevance Stage 2) — recall-first MVP
  //     posture (D-063). Items below the active threshold (default 0.20,
  //     env-tunable via `TEMPO_BEAT_FIT_THRESHOLD`) are dropped before
  //     clustering. Strict-empty: if zero items clear, downstream produces an
  //     empty payload rather than a weak top-of-list fallback.
  //
  //     `beatFitEnabled` defaults to true (production posture). Tests targeting
  //     unrelated pipeline mechanics can pass `false` to bypass this stage so
  //     their narrow fixtures don't have to model real beat-fit signals.
  let beatFitResult;
  let relevantItems;
  if (beatFitEnabled) {
    // Pass the runtime threshold explicitly so `_meta` / decisionTrace surface
    // the env-tuned value (D-063: default 0.20, override via
    // `TEMPO_BEAT_FIT_THRESHOLD`) instead of the static constant.
    beatFitResult = applyBeatFitFilter(recallItems, settings, {
      threshold: readBeatFitThreshold(),
    });
    relevantItems = beatFitResult.included;
    if (recallItems.length > 0) {
      const histogram = beatFitResult.summary.excludeReasonHistogram;
      const histStr = Object.entries(histogram).map(([k, v]) => `${k}=${v}`).join(",") || "(none)";
      console.log(
        `[pipeline.beat-fit] version=${BEAT_FIT_VERSION} threshold=${beatFitResult.summary.threshold}  ` +
        `recall=${recallItems.length}  included=${beatFitResult.summary.includedCount}  ` +
        `excluded=${beatFitResult.summary.excludedCount}  reasons=${histStr}`
      );
    }
    if (recallItems.length > 0 && relevantItems.length === 0) {
      console.log(
        `[pipeline.beat-fit] strict-empty: ${recallItems.length} candidate(s) failed threshold ` +
        `(${beatFitResult.summary.threshold}); returning no stories rather than weak fallback`
      );
    }
  } else {
    relevantItems = recallItems;
    beatFitResult = {
      included: recallItems,
      excluded: [],
      summary: {
        threshold: readBeatFitThreshold(),
        includedCount: recallItems.length,
        excludedCount: 0,
        excludeReasonHistogram: {},
        rescuedCount: 0,
        rescueBlockedPenaltyCount: 0,
        rescueBlockedInsufficientSignalsCount: 0,
        semanticBlendEnabled: false,
        semanticBlendAppliedCount: 0,
        semanticBlendMissingCount: 0,
        semanticLiftOverThresholdCount: 0,
        semanticDropBelowThresholdCount: 0,
        excludedWithSemanticPresentCount: 0,
      },
    };
  }

  // 5c. Cross-feed source-item dedupe.  Same article surfaced via multiple
  //     RSS feeds (different feedId) collapses to ONE canonical sourceItem
  //     before clustering.  Match policy is strict / false-merge-averse:
  //       - With URL    : canonical URL match AND exact normalized headline
  //                       match AND |Δ minutesAgo| ≤ PUBLISH_WINDOW_MINUTES.
  //                       Canonical URL alone is NOT enough to merge.
  //       - Without URL : exact normalized headline match (no time gate).
  //       - Cross-publisher / cross-feed merges are permitted whenever the
  //         rules above pass; outlet identity is not itself a gate.
  //       - Empty normalized headlines never merge (insufficient signal).
  //     See ingestion/source-deduper.mjs for tie-break rules and the internal
  //     `_duplicates` provenance shape (stripped from the response payload
  //     by buildStory's explicit field whitelist).
  const dedupeResult = dedupeSourceItems(relevantItems);
  const dedupedItems = dedupeResult.unique;
  // C1: deterministic cluster input cap.  Applied AFTER beat-fit + dedupe so we
  // bound the clustering round-trip to the highest-value candidates without
  // touching recall/beat-fit thresholds.  `clusterInputItems` is the exact set
  // passed to `clusterFn`; `clusterCapDiagnostics` is consistent with it and is
  // surfaced on `_meta.clusterCap` for both the full-run and watermark-skip
  // paths.  Watermarking still keys off `dedupedItems` (clusterInputItems is a
  // deterministic function of it, so the skip decision is unchanged).
  const clusterCapResult = applyClusterInputCap(dedupedItems);
  const clusterInputItems = clusterCapResult.clusterInputItems;
  const clusterCapDiagnostics = clusterCapResult.diagnostics;
  if (clusterCapDiagnostics.clusterDroppedCount > 0) {
    console.log(
      `[pipeline.cluster-cap] deduped=${clusterCapDiagnostics.dedupedCount} ` +
        `clusterInput=${clusterCapDiagnostics.clusterInputCount} ` +
        `dropped=${clusterCapDiagnostics.clusterDroppedCount} ` +
        `cap=${CLUSTER_INPUT_CAP}`
    );
  }
  // Slice 7 (non-overlap): the pre-cluster stage is the two spans that bracket
  // the recall block — [pipelineStartedAt → recallStartedAt] (normalize → time
  // window → source selection → semantic prep → topic/keyword) plus
  // [recallEndedAt → preClusterEndedAt] (beat-fit + cross-feed dedupe). Recall
  // (recallMs) AND geo-assess (geoMs) each get their own bracket, so geoMs —
  // which lives inside the first span — is subtracted out to avoid
  // double-counting, the same way recallMs is carved out.
  const preClusterEndedAt = Date.now();
  const preClusterMs = Math.max(
    0,
    (recallStartedAt - pipelineStartedAt) - geoMs + (preClusterEndedAt - recallEndedAt)
  );
  if (dedupeResult.duplicateCount > 0) {
    console.log(
      `[pipeline.dedupe] input=${relevantItems.length} unique=${dedupedItems.length} collapsed=${dedupeResult.duplicateCount}`
    );
  }

  // 5b. Phase 4: watermark over the actual clustering candidate set.  This is
  //     the "would clustering see the same input as last time?" check — if so
  //     we skip clustering, grounding, lock writes, and rejection writes.
  //     Computed AFTER dedupe so a duplicate disappearing from one feed (when
  //     the unique winner is unchanged) does not invalidate the watermark.
  const watermarkInfo = computeWatermark({
    candidateItems: dedupedItems,
    selectedFeedIds: selectionMeta?.matchedFeedIds ?? [],
  });
  // Trap guard: if the prior persisted snapshot has zero stories AND we have
  // candidates to cluster this run, do NOT short-circuit on watermark match.
  // The trap looks like this: a prior run was degraded (e.g. embedding
  // failure → lexical-fallback → clustering produced 0 stories due to
  // grounding rejection), persisted an empty snapshot AND a watermark.  On
  // the next refresh, an identical candidate set produces an identical
  // watermark, and the short-circuit serves the empty snapshot indefinitely.
  // Letting clustering re-run gives non-deterministic gates (LLM clustering,
  // grounding) another chance to produce something.  The optimization for
  // genuinely-stable runs (prior story count > 0) is preserved unchanged.
  const watermarkMatched = watermarksMatch(priorWatermark, watermarkInfo.watermark);
  const priorWasEmpty =
    typeof priorStoryCount === "number" && priorStoryCount === 0;
  const watermarkSuppressed =
    watermarkMatched && priorWasEmpty && dedupedItems.length > 0;
  if (watermarkSuppressed) {
    console.log(
      `[pipeline.watermark] match suppressed (${watermarkInfo.watermark}) — prior snapshot was empty AND ${dedupedItems.length} candidate(s) ready; re-running clustering rather than serving stale empty`
    );
  }
  if (watermarkMatched && !watermarkSuppressed) {
    // Watermark short-circuit: clustering + grounding never run, so we cannot
    // honestly report `finalStories=0` (the prior snapshot may carry stories).
    // Set the final stage to `null` and tag the funnel with
    // executionMode=watermark_skip so summarizeFunnel emits
    // primaryDropStage="not_executed" instead of falsely blaming clustering.
    const skipFunnel = summarizeFunnel(
      {
        totalNormalized: normalizedItems.length,
        afterTimeWindow: recentNormalizedItems.length,
        afterSourceSelection: recentItems.length,
        afterGeoFilter: geoPassedItems.length,
        afterTopicKeyword: recallItems.length,
        afterBeatFit: relevantItems.length,
        afterDedupe: dedupedItems.length,
        finalStories: null,
      },
      settings,
      { executionMode: FUNNEL_EXECUTION_MODE.WATERMARK_SKIP }
    );
    console.log(
      `[pipeline.watermark] unchanged (${watermarkInfo.watermark}) — skipping clustering, grounding, locks, rejections`
    );
    console.log(`[pipeline.funnel] ${formatFunnel(skipFunnel)}  execution_mode=${skipFunnel.executionMode}  primary_drop=${skipFunnel.primaryDropStage}`);
    return {
      payload: null, // signals caller to re-serve prior snapshot
      log: {
        unchanged: true,
        refreshSkippedReason: "unchanged_watermark",
        watermark: watermarkInfo.watermark,
        candidateCount: watermarkInfo.candidateCount,
        selectedFeedCount: watermarkInfo.selectedFeedCount,
        totalItems: normalizedItems.length,
        poolCount: recentItems.length,
        recentCount: recentItems.length,
        geoHeldCount: geoHeldItems.length,
        geo: geoDiagnostics,
        relevantCount: relevantItems.length,
        relevantItemCount: relevantItems.length,
        metaStoryCount: 0,
        usedFallbackClustering: false,
        // Clustering never ran on the watermark short-circuit.
        clusteringFailureReason: null,
        clusteringAttempts: 0,
        // C2: clustering never ran, so no repair was attempted — defaults keep
        // the `_meta` shape consistent across both paths.
        clusteringRepairAttempted: false,
        clusteringRepairSucceeded: false,
        clusteringRepairFailureReason: null,
        // Slice 3: keep the extended repair-diagnostic shape consistent on the
        // watermark short-circuit too (clustering never ran → all null/false).
        clusteringRepairRawFailureClass: null,
        clusteringRepairSchemaErrorBucket: null,
        clusteringRepairCoercion: null,
        // Clustering never ran on the short-circuit, so nothing was recovered.
        clusteringRepairRecovered: false,
        // Slice 4: surface the resolved profile on the short-circuit branch too
        // so `_meta.profile` shape is consistent across full-run and skip paths.
        // Geo ran before the watermark decision, so `geoStageBudgetMs` is the
        // value it actually used; clustering never ran on a skip.
        profile: {
          name: profile.name,
          interactive: profile.interactive,
          geoStageBudgetMs: effectiveGeoBudgetMs,
          clusterMaxAttempts: profile.clusterMaxAttempts,
          clusterTimeoutMs: profile.clusterTimeoutMs,
        },
        // Slice 3: outcome rollup on the short-circuit branch too, so the
        // summary/SLO surfaces have a consistent shape across both paths.
        // Geo + beat-fit ran before the watermark decision; clustering did not.
        outcomes: {
          storiesPublished: 0,
          clusteringAttempts: 0,
          clusteringFailureReason: null,
          usedFallbackClustering: false,
          ...geoDiagnostics,
        },
        clusteringLatencyMs: [],
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        rejectionRecords: [],
        normErrors: normErrors.length,
        selection: { ...selectionMeta, relevantItemCount: relevantItems.length },
        // Beat-fit ran on this candidate set even though we short-circuited
        // before clustering. Surfacing it makes "why is the snapshot stable?"
        // debuggable from logs alone.
        beatFit: {
          version: BEAT_FIT_VERSION,
          enabled: beatFitEnabled,
          threshold: beatFitResult.summary.threshold,
          recallCount: recallItems.length,
          includedCount: beatFitResult.summary.includedCount,
          excludedCount: beatFitResult.summary.excludedCount,
          excludeReasonHistogram: beatFitResult.summary.excludeReasonHistogram,
          semanticBlendEnabled: beatFitResult.summary.semanticBlendEnabled,
          semanticBlendAppliedCount: beatFitResult.summary.semanticBlendAppliedCount,
          semanticBlendMissingCount: beatFitResult.summary.semanticBlendMissingCount,
          semanticLiftOverThresholdCount: beatFitResult.summary.semanticLiftOverThresholdCount,
          semanticDropBelowThresholdCount: beatFitResult.summary.semanticDropBelowThresholdCount,
          excludedWithSemanticPresentCount: beatFitResult.summary.excludedWithSemanticPresentCount,
        },
        semanticBeatFit: semanticBeatFitDiagnostics,
        dedupe: {
          inputCount: relevantItems.length,
          uniqueCount: dedupedItems.length,
          collapsedCount: dedupeResult.duplicateCount,
        },
        // C1: clustering never ran on this short-circuit, but the cap is a
        // deterministic function of `dedupedItems`, so the diagnostics describe
        // exactly what clustering WOULD have seen — surfaced for a consistent
        // `_meta.clusterCap` shape across both paths.
        clusterCap: clusterCapDiagnostics,
        recall: recallDiagnostics,
        // Translation ran before recall (and thus before this short-circuit),
        // so the run-level normalization stats are honest even on a skip. No
        // per-story coverage — clustering never ran.
        translation: { ...translationStageDiagnostics, translationMs, stories: {} },
        funnel: skipFunnel,
        // Phase 2 lightweight decision trace.  Beat-fit ran before we decided
        // to short-circuit, so the trace surfaces the same explainability
        // surface as a full run, with finalStories=null to match the funnel.
        decisionTrace: buildDecisionTrace({
          stageCounts: {
            totalNormalized: normalizedItems.length,
            afterTimeWindow: recentNormalizedItems.length,
            afterSourceSelection: recentItems.length,
            afterGeoFilter: geoPassedItems.length,
            afterTopicKeyword: recallItems.length,
            afterBeatFit: relevantItems.length,
            afterDedupe: dedupedItems.length,
            finalStories: null,
          },
          beatFitResult,
        }),
        // What-changed on the watermark short-circuit (spec §10 row 6):
        // the prior snapshot's `whatChanged` strings are re-served by the
        // route handler verbatim — we never recompute the engine on a
        // skip.  All counters are zero; `watermarkShortCircuited:true`
        // flags the branch.  `everSeenCount` / `priorStoryCount` are
        // surfaced so operators can confirm the prior was loaded even
        // when the engine itself didn't run.
        whatChanged: {
          ...emptyWhatChangedRunDiagnostics(),
          watermarkShortCircuited: true,
          everSeenCount: whatChangedEverSeenCount,
          priorStoryCount: whatChangedPriorStoryCount,
        },
        // Watermark short-circuit (spec §8 row 6): the route handler
        // re-serves the prior snapshot's `whyItMatters` strings and
        // `_whyItMattersTraces` verbatim — the engine is not run on a
        // skip.  All counters zero; `watermarkShortCircuited:true` flags
        // the branch so operators can distinguish "engine ran, all
        // unchanged" from "engine skipped because watermark matched".
        whyItMatters: {
          ...emptyWhyItMattersRunDiagnostics(),
          watermarkShortCircuited: true,
          enabled: (whyConfig ?? resolveWhyConfig()).enabled,
        },
      },
    };
  }

  // 6. LLM clustering — operates on the deduped candidate set so each unique
  //    article shows up at most once, and the meta-story's source_item_ids
  //    therefore reference unique articles only.
  //    Fail-closed policy (locked): try clustering once; on throw/timeout
  //    retry ONCE; if the retry also fails, publish ZERO meta-stories.  We do
  //    NOT fall back to `gracefulFallbackClustering` on the publish path — that
  //    function produced degraded "General Updates"-style buckets that read as
  //    real stories to users.  An empty dashboard is the honest signal that the
  //    clustering stage failed.  `gracefulFallbackClustering` stays exported for
  //    tests/ops only.
  const clusterStartedAt = Date.now();
  let rawMetaStories;
  let usedFallbackClustering = false;
  let clusteringFailureReason = null; // 'timeout' | 'error' | null
  let clusteringAttempts = 0;
  const clusteringAttemptLatencyMs = [];
  // C2 + Slice 3: clustering JSON repair diagnostics for the last attempt
  // (success or failure both carry them via `_clusteringRepair`).  Shape
  // mirrors `EMPTY_CLUSTERING_REPAIR` — `rawFailureClass` / `schemaErrorBucket`
  // / `coercion` are the Slice 3 additions surfaced on `_meta` below.
  let clusteringRepair = {
    attempted: false,
    succeeded: false,
    failureReason: null,
    rawFailureClass: null,
    schemaErrorBucket: null,
    coercion: null,
  };
  if (clusterInputItems.length === 0) {
    rawMetaStories = [];
  } else {
    // Slice 4/4.1: the active profile bounds the clustering latency envelope.
    // Interactive and default both run 2 attempts (initial + one retry) — the
    // locked Slice 4.1 decision; the interactive win comes from a tighter geo
    // budget plus a tighter per-attempt clustering timeout passed to `clusterFn`.
    // Fail-closed trust is unchanged: if every attempt fails we still publish
    // zero stories with a classified `clusteringFailureReason`.
    const MAX_CLUSTER_ATTEMPTS = profile.clusterMaxAttempts;
    const clusterCallOpts =
      profile.clusterTimeoutMs != null ? { timeoutMs: profile.clusterTimeoutMs } : {};
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_CLUSTER_ATTEMPTS; attempt++) {
      clusteringAttempts = attempt;
      const attemptStartedAt = Date.now();
      try {
        rawMetaStories = await clusterFn(clusterInputItems, settings, clusterModel, clusterCallOpts);
        clusteringAttemptLatencyMs.push(Date.now() - attemptStartedAt);
        clusteringRepair = readClusteringRepairDiagnostics(rawMetaStories);
        lastErr = null;
        break;
      } catch (clusterErr) {
        clusteringAttemptLatencyMs.push(Date.now() - attemptStartedAt);
        lastErr = clusterErr;
        // C2: a parse failure carries repair diagnostics on the error; the last
        // attempt's value wins (mirrors clusteringAttempts/clusteringLatencyMs).
        clusteringRepair = readClusteringRepairDiagnostics(clusterErr);
        const msg = clusterErr instanceof Error ? clusterErr.message : String(clusterErr);
        console.warn(
          `[pipeline] clustering attempt ${attempt}/${MAX_CLUSTER_ATTEMPTS} failed: ${msg}`
        );
      }
    }
    if (lastErr) {
      // Both attempts failed → fail closed with zero stories.  Classify the
      // failure so `_meta.clusteringFailureReason` distinguishes a timeout
      // (capacity / slow round-trip) from a hard error (schema, auth, etc.).
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      clusteringFailureReason = /timed out|timeout|abort/i.test(msg) ? "timeout" : "error";
      rawMetaStories = [];
      usedFallbackClustering = true;
      console.warn(
        `[pipeline] clustering FAILED after ${clusteringAttempts} attempt(s) (reason=${clusteringFailureReason}) — publishing 0 meta-stories (fail-closed)`
      );
    }
  }

  // 6b. Post-cluster split healer (Slice 2): clustering can over-merge
  //     unrelated stories that share a country (e.g. a Colombia election story
  //     and a Colombia mine-attack story). The deterministic healer splits such
  //     over-merges back into one meta-story per source item BEFORE ID lineage
  //     runs, so each split child gets a fresh evidence-derived metaStoryId.
  //     Source index is built over the DEDUPED set (the only IDs clustering
  //     saw) and reused by grounding + buildStory below. Default ENABLED;
  //     `TEMPO_CLUSTER_SPLIT_HEALER_ENABLED=false` is the instant rollback.
  // C1: built over `clusterInputItems` (the exact set clustering saw) — the only
  // IDs a meta-story's `source_item_ids` can reference post-cap.  Reused by the
  // split healer, grounding, and buildStory below.
  const sourceItemsById = new Map(clusterInputItems.map((item) => [item.sourceId, item]));
  const effectiveClusterSplitConfig = clusterSplitConfig ?? resolveClusterSplitConfig();
  const clusterSplitResult = splitOverMergedClusters(
    rawMetaStories,
    sourceItemsById,
    settings,
    effectiveClusterSplitConfig
  );
  rawMetaStories = clusterSplitResult.stories;
  const clusterSplitDiagnostics = clusterSplitResult.diagnostics;

  // 7. Resolve stable meta_story_id with lineage continuity:
  //    Read prior snapshot, attempt to match each new cluster against a prior
  //    story (same primary topic + Jaccard ≥ 0.5 on source IDs).  Exactly-one
  //    match → reuse prior metaStoryId so title locks survive narrative
  //    evolution.  Otherwise → fresh evidence-derived ID via generateMetaStoryId.
  let priorStories = [];
  if (readPriorSnapshotFn) {
    try {
      const priorSnapshot = await readPriorSnapshotFn();
      priorStories = priorSnapshot?.stories ?? [];
    } catch (err) {
      console.warn(`[pipeline] prior snapshot read failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  rawMetaStories = reuseOrAssignIds(rawMetaStories, priorStories);

  // 8. Source index (`sourceItemsById`) was built over the DEDUPED set above
  //    (step 6b) — clustering only saw these IDs, so grounding + buildStory
  //    look up against the same universe.

  // 9. Grounding verification (source-level + claim-level + summary/subtitle grounding)
  const { valid: groundedStories, invalid: failedGrounding } = verifyGrounding(
    rawMetaStories,
    sourceItemsById
  );

  const groundingFailures = failedGrounding.length;

  // Phase 3 (strict trust posture): ANY grounding failure drops the story
  // from the published dashboard.  No extractive fallback for partial_source_ids,
  // no soft-publish for ungrounded_claims.  Dropped stories are persisted
  // separately (rejection log) for offline analysis — never returned to clients.
  const groundingDropReasons = {};
  const rejectionRecords = [];
  const rejectedAt = new Date().toISOString();
  for (const ms of failedGrounding) {
    const reason = ms.groundingFailure ?? "unknown";
    groundingDropReasons[reason] = (groundingDropReasons[reason] ?? 0) + 1;
    rejectionRecords.push({
      meta_story_id: ms.meta_story_id ?? null,
      reason_code: reason,
      source_item_ids: Array.isArray(ms.source_item_ids) ? ms.source_item_ids : [],
      debug_payload: {
        title: ms.title ?? null,
        factual_claims_count: Array.isArray(ms.factual_claims) ? ms.factual_claims.length : 0,
        tags: ms.tags ?? null,
      },
      watermark: watermarkInfo.watermark, // Phase 4: stamps for dedup key
      created_at: rejectedAt,
    });
  }
  const droppedUngroundedStoryCount = rejectionRecords.length;
  if (droppedUngroundedStoryCount > 0) {
    const breakdown = Object.entries(groundingDropReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    console.warn(
      `[pipeline.grounding] strict drop — ${droppedUngroundedStoryCount} story(ies) excluded (${breakdown})`
    );
    if (writeRejectionsFn) {
      try {
        await writeRejectionsFn(rejectionRecords);
      } catch (err) {
        console.warn(
          `[pipeline.grounding] rejection-log write failed: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }

  // Clustering + grounding stage wall-clock (cluster + split-heal + lineage
  // + grounding verification; before response shaping).
  const clusterMs = Math.max(0, Date.now() - clusterStartedAt);
  // 10. Build response stories (resolve source items, shape to schema).
  //     Only `groundedStories` (passed all grounding gates) reach this step.
  //
  //     R1 (M6b): server-canonical story ordering.  Compute the sort keys
  //     (max beat-fit, min minutesAgo) from the SOURCE ITEMS — they carry
  //     `beatFitScore` from the recall stage — not from the response shape
  //     (which intentionally doesn't surface beatFitScore).  Stories with no
  //     resolvable source items use 0 / +Infinity so they sink to the bottom
  //     and break ties on `metaStoryId` rather than crashing on `Math.min`.
  const storiesWithSortKeys = groundedStories.map((ms) => {
    const sourceItems = ms.source_item_ids
      .map((id) => sourceItemsById.get(id))
      .filter(Boolean);
    const maxBeatFitScore = sourceItems.reduce(
      (acc, item) => Math.max(acc, typeof item?.beatFitScore === "number" ? item.beatFitScore : 0),
      0
    );
    const minMinutesAgo = sourceItems.length === 0
      ? Number.POSITIVE_INFINITY
      : sourceItems.reduce(
          (acc, item) =>
            Math.min(acc, typeof item?.minutesAgo === "number" ? item.minutesAgo : Number.POSITIVE_INFINITY),
          Number.POSITIVE_INFINITY
        );
    return {
      story: buildStory(ms, sourceItems, settings),
      sortKey: { maxBeatFitScore, minMinutesAgo, metaStoryId: ms.meta_story_id },
    };
  });
  storiesWithSortKeys.sort((a, b) => compareStoriesR1(a.sortKey, b.sortKey));
  // `let` (not const): D2 fail-closed-per-story may filter unrecoverable stories
  // out of this array after the narrative stages (see the `narrativeStability`
  // block below). Everything downstream (funnel, metaStoryCount, payload) then
  // reflects the published survivor set.
  let stories = storiesWithSortKeys.map(({ story }) => story);

  // ── Phase 4: optional semantic tag uplift (topics + keywords only) ──────
  // Runs AFTER the deterministic stories are built and sorted — the overlay
  // only mutates `story.tags` and aggregates per-axis diagnostics for the
  // operator log.  It does NOT affect funnel counts, ordering, grounding, or
  // any pre-clustering stage (K1a one-way invariant).  When the config has
  // both axes OFF (the default), this loop is a no-op for `tags` and emits
  // skipped-state diagnostics.
  const semanticTopicsAgg = emptyAggregateAxisDiagnostics("topics");
  const semanticKeywordsAgg = emptyAggregateAxisDiagnostics("keywords");
  let semanticTopicsAggMut = semanticTopicsAgg;
  let semanticKeywordsAggMut = semanticKeywordsAgg;
  if (stories.length > 0) {
    // We re-resolve sourceItems per story from the cluster-output meta-stories
    // (groundedStories) — the same map already used for `buildStory`.
    for (let i = 0; i < storiesWithSortKeys.length; i++) {
      const ms = groundedStories.find(
        (m) => m.meta_story_id === storiesWithSortKeys[i].sortKey.metaStoryId
      );
      if (!ms) continue;
      const sourceItems = ms.source_item_ids
        .map((id) => sourceItemsById.get(id))
        .filter(Boolean);
      const { tags, diagnostics } = await assignMetaStoryTagsDetailed({
        metaStory: ms,
        sourceItems,
        settings,
        semantic: {
          config: effectiveSemanticTagConfig,
          scorer: semanticTagScorer,
        },
      });
      // Overlay only the tags — leave the rest of the deterministic story
      // payload (title, summary, geographies, sources, …) untouched.
      stories[i].tags = tags;
      semanticTopicsAggMut = accumulateAxisDiagnostics(semanticTopicsAggMut, diagnostics.topics);
      semanticKeywordsAggMut = accumulateAxisDiagnostics(semanticKeywordsAggMut, diagnostics.keywords);
    }
  }
  const tagsDiagnostics = {
    // Phase 7 schema version — operators and downstream consumers can read a
    // single string to detect contract changes without inspecting every
    // field.  Bumped on every Phase that grows/shrinks the per-axis diag
    // shape.  Older snapshots without this key are the "phase4/5" baseline.
    schemaVersion: TAGS_DIAGNOSTICS_SCHEMA_VERSION,
    // Phase 7 kill-switch surface: when `TEMPO_TAG_SEMANTIC_KILL_SWITCH=true`
    // the per-axis runtime states are forced to `disabled` regardless of
    // other flags.  Surfacing the kill-switch state explicitly here lets an
    // operator answer "is semantic OFF because of the kill switch, or
    // because the per-axis flag was never on?" from `_meta.tags` alone.
    killSwitchActive: Boolean(effectiveSemanticTagConfig.killSwitch),
    topics: semanticTopicsAggMut,
    keywords: semanticKeywordsAggMut,
    geographies: { axis: "geographies", semanticApplied: false },
  };
  // Phase 5: log line carries `runtimeState`, `scorerLatencyMs`, and
  // `fallbackReasonCounts` per axis so an operator can read the rollout
  // state from a single line: "is semantic on, did the scorer succeed, how
  // slow was it, did anything time out?".  Geographies remain locked
  // deterministic-only — that stamp is in the persisted `_meta.tags` too.
  console.log(
    `[pipeline.tags]` +
      ` schema=${tagsDiagnostics.schemaVersion}` +
      ` kill_switch=${tagsDiagnostics.killSwitchActive ? "on" : "off"}` +
      ` semantic_topics=${tagsDiagnostics.topics.runtimeState}` +
      ` accepted=${tagsDiagnostics.topics.acceptedCount}` +
      ` rejected=${tagsDiagnostics.topics.rejectedCount}` +
      ` below_threshold=${tagsDiagnostics.topics.belowThresholdCount}` +
      ` latency_ms=${tagsDiagnostics.topics.scorerLatencyMs}` +
      ` latency_max_ms=${tagsDiagnostics.topics.scorerLatencyMaxMs}` +
      ` calls=${tagsDiagnostics.topics.scorerCallCount}` +
      ` timeouts=${tagsDiagnostics.topics.fallbackReasonCounts.timeout}` +
      ` errors=${tagsDiagnostics.topics.fallbackReasonCounts.error}` +
      `  semantic_keywords=${tagsDiagnostics.keywords.runtimeState}` +
      ` accepted=${tagsDiagnostics.keywords.acceptedCount}` +
      ` rejected=${tagsDiagnostics.keywords.rejectedCount}` +
      ` below_threshold=${tagsDiagnostics.keywords.belowThresholdCount}` +
      ` latency_ms=${tagsDiagnostics.keywords.scorerLatencyMs}` +
      ` latency_max_ms=${tagsDiagnostics.keywords.scorerLatencyMaxMs}` +
      ` calls=${tagsDiagnostics.keywords.scorerCallCount}` +
      ` timeouts=${tagsDiagnostics.keywords.fallbackReasonCounts.timeout}` +
      ` errors=${tagsDiagnostics.keywords.fallbackReasonCounts.error}` +
      `  semantic_geographies=off(locked)`
  );

  // ── Phase 4: compute whatChanged per story ───────────────────────────────
  // Runs after R1 sort + tag overlay so the engine compares the same
  // story shape the user will see (modulo title locks, which are applied
  // post-pipeline in `server.mjs` — see spec §7 / alignment #8 for the
  // pre-lock vs post-lock asymmetry).  Default is OFF: `resolveDeltaConfig()`
  // reads `TEMPO_AI_DELTA_ENABLED` at call time and only routes weak/strong
  // gate signals through Haiku → Sonnet when an operator opts in.  Until
  // then, every story resolves to first-seen or unchanged from the gate
  // alone — no LLM calls in CI/prod.
  const whatChangedStartedAt = Date.now();
  const perStoryWhatChanged = [];
  // D2: pre-D2 eligible (post-cluster) story count + per-story drop set shared
  // across both narrative stages. Drops are silent (no user-facing notice).
  const narrativeEligibleCount = stories.length;
  const narrativeDroppedStoryIds = new Set();
  const d2WhatChanged = { eligible: stories.length, retried: 0, dropped: 0, droppedIds: [] };
  const whatChangedResolver = resolveWhatChangedFn ?? resolveWhatChanged;
  for (const story of stories) {
    const priorStory = priorStoriesById && typeof priorStoriesById.get === "function"
      ? priorStoriesById.get(story.metaStoryId) ?? null
      : null;
    // Serial loop is intentional for MVP: typical R1-sorted dashboard size
    // is small (~≤10 stories), and serializing keeps log/diagnostics
    // ordering deterministic.  Revisit if Haiku/Sonnet latency becomes a
    // dominant pipeline contributor.
    // D2: fail-closed per story with one retry. A failed write call (transient
    // execution failure) is retried once; if it still fails, the story is
    // dropped from the published set rather than shipped with degraded content
    // or failing the whole refresh. Classify/hallucination still degrade
    // gracefully to "unchanged" copy (not a drop) — see narrative-stability.mjs.
    // eslint-disable-next-line no-await-in-loop
    const { result, retried, failed } = await runStageWithSingleRetry(
      () =>
        whatChangedResolver(
          {
            metaStoryId: story.metaStoryId,
            // Slice 15: feed the writer the normalized English evidence (clone);
            // the response `story` keeps its original-language source text.
            currentStory: withNormalizedEvidence(story, sourceItemsById),
            priorStory,
            everSeenMetaStoryIds: everSeenMetaStoryIds ?? [],
          },
          { classifyFn, writeFn, config: deltaConfig ?? undefined }
        ),
      isWhatChangedFailure,
      // Defensive: engine normally never throws. Normalize a throw into an
      // aggregate-friendly write-failure result so diagnostics stay coherent.
      () => ({
        state: "unchanged",
        whatChanged: "",
        gate: { signal: "none", reasons: ["resolve_threw"] },
        diagnostics: {
          classifySkipped: false, classifyCalled: false, classifyMaterial: false,
          writeCalled: true, writeOk: false,
          llmFailed: { classify: false, write: true, hallucination: false },
          latencyMs: { classify: 0, write: 0 },
        },
      })
    );
    if (retried) d2WhatChanged.retried += 1;
    // Always record the result for aggregate diagnostics + why-stage index
    // alignment (perStoryWhatChanged[i] is read by the why prep pass).
    perStoryWhatChanged.push(result);
    if (failed) {
      d2WhatChanged.dropped += 1;
      if (typeof story.metaStoryId === "string" && story.metaStoryId.length > 0) {
        narrativeDroppedStoryIds.add(story.metaStoryId);
        d2WhatChanged.droppedIds.push(story.metaStoryId);
      }
      continue; // do not apply whatChanged; story will be filtered post-stages
    }
    story.whatChanged = result.whatChanged;
  }
  const whatChangedMs = Math.max(0, Date.now() - whatChangedStartedAt);
  const whatChangedDiagnostics = aggregateWhatChangedDiagnostics(perStoryWhatChanged, {
    everSeenCount: whatChangedEverSeenCount,
    priorStoryCount: whatChangedPriorStoryCount,
  });
  console.log(
    `[pipeline.whatChanged]` +
      ` schema=${whatChangedDiagnostics.schemaVersion}` +
      ` first_seen=${whatChangedDiagnostics.firstSeen}` +
      ` unchanged=${whatChangedDiagnostics.unchanged}` +
      ` changed=${whatChangedDiagnostics.changed}` +
      ` gate_strong=${whatChangedDiagnostics.gateStrong}` +
      ` gate_weak=${whatChangedDiagnostics.gateWeak}` +
      ` gate_none=${whatChangedDiagnostics.gateNone}` +
      ` classify_skipped=${whatChangedDiagnostics.classifySkipped}` +
      ` classify_called=${whatChangedDiagnostics.classifyCalled}` +
      ` classify_true=${whatChangedDiagnostics.classifyMaterialTrue}` +
      ` classify_false=${whatChangedDiagnostics.classifyMaterialFalse}` +
      ` write_called=${whatChangedDiagnostics.writeCalled}` +
      ` write_ok=${whatChangedDiagnostics.writeOk}` +
      ` llm_failed_classify=${whatChangedDiagnostics.llmFailed.classify}` +
      ` llm_failed_write=${whatChangedDiagnostics.llmFailed.write}` +
      ` llm_failed_hallucination=${whatChangedDiagnostics.llmFailed.hallucination}` +
      ` latency_classify_ms=${whatChangedDiagnostics.latencyMs.classify}` +
      ` latency_write_ms=${whatChangedDiagnostics.latencyMs.write}`
  );

  // ── Phase 5: compute whyItMatters per story (bounded parallel) ───────────
  // Runs after Phase 4 because the implications writer needs the resolved
  // `whatChangedState` to derive emphasis (intro/steady/evolving — see
  // why-this-matters-spec §3).
  //
  // Structure: a sync, index-aligned PREPARATION pass computes every input
  // the resolver needs per story (no awaits), then a bounded `pMap` worker
  // pool fans the `resolveWhyItMatters` calls out so the per-story LLM
  // round-trips overlap instead of running serially (Slice 6).  Concurrency
  // comes from `TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY` (default 4, clamp 1–6).
  // pMap returns settled results index-aligned with the input, so the APPLY
  // pass walks them in order — payload story order (R1) is preserved
  // regardless of completion order.
  //
  // Default posture is LLM-first when `TEMPO_AI_WHY_IT_MATTERS_ENABLED=true`;
  // on disable / mock-only / provider failure / rubric fail, the resolver
  // returns a Phase 3d state-aware safe-fallback template so
  // `story.whyItMatters` is never empty or subtitle-echo.
  const effectiveWhyConfig = whyConfig ?? resolveWhyConfig();
  const everSeenSet = new Set(Array.isArray(everSeenMetaStoryIds) ? everSeenMetaStoryIds : []);
  const perStoryWhyItMatters = [];
  const whyItMattersTraces = {};
  // Map what-changed `state` enum into the whatChangedState canonical delta
  // enum the implications engine couples on (spec §3 mapping).  Unknown /
  // missing states fall through to `null`, which the engine's fail-closed
  // derivation handles per §3.
  const WHAT_CHANGED_TO_DELTA_STATE = {
    "first-seen": "firstSeen",
    changed: "changed",
    unchanged: "unchanged",
  };

  // Preparation pass — sync, index-aligned with `stories`.  Computes the
  // resolver input for every story up front so the parallel stage below is a
  // pure fan-out with no per-task setup work.
  const preparedWhy = stories.map((story, i) => {
    const wcResult = perStoryWhatChanged[i] ?? null;
    const whatChangedState = WHAT_CHANGED_TO_DELTA_STATE[wcResult?.state] ?? null;
    const evidenceRefs = computeEvidenceRefsForStory(story, whatChangedState);
    const everSeenForStory =
      typeof story.metaStoryId === "string" && everSeenSet.has(story.metaStoryId);
    // State the implications engine will emphasize; computed here so the
    // doctrine retrieval can apply its `stateVariant` boost to the same
    // value the writer will see.
    const whyState = deriveWhyStateFromWhatChangedState({
      whatChangedState,
      everSeen: everSeenForStory,
    });
    // Doctrine retrieval (spec §5).  Pure / sync; fail-closes to [] on any
    // malformed input so the writer always proceeds with a valid snippets
    // array.  Tests can inject `doctrineSnippets` via `doctrineRetrievalFn`
    // to bypass the on-disk corpus.
    let doctrineSnippets = [];
    try {
      doctrineSnippets = doctrineRetrievalFn
        ? doctrineRetrievalFn({ story, state: whyState })
        : retrieveDoctrineSnippetsForStory({ story, state: whyState });
      if (!Array.isArray(doctrineSnippets)) doctrineSnippets = [];
    } catch {
      doctrineSnippets = [];
    }
    return {
      index: i,
      story,
      whyState,
      // D2: stories already dropped by the what-changed stage skip the why
      // stage entirely (no wasted writer calls, no double-counted drops).
      dropped:
        typeof story.metaStoryId === "string" && narrativeDroppedStoryIds.has(story.metaStoryId),
      resolveArgs: {
        metaStoryId: story.metaStoryId,
        title: story.title,
        subtitle: story.subtitle,
        summary: story.summary,
        whatChanged: story.whatChanged,
        whatChangedState,
        everSeen: everSeenForStory,
        state: whyState,
        evidenceRefs,
        doctrineSnippets,
      },
    };
  });
  const d2WhyItMatters = {
    eligible: preparedWhy.filter((p) => !p.dropped).length,
    retried: 0,
    dropped: 0,
    droppedIds: [],
  };

  // Slice 5: interactive first paint defers the expensive writer.  Each
  // non-dropped story takes the deterministic, state-aware safe fallback (the
  // same copy the resolver would emit on a disabled/failed write — non-empty,
  // never subtitle echo).  No why-stage drops; the async enrichment pass
  // upgrades the copy in place after the snapshot is written.
  let whyItMattersDiagnostics;
  // Hoisted so `pipelineTimings` can read it after either branch (deferred runs
  // skip the writer, so the why stage wall-clock is ~0).
  let whyMs = 0;
  if (deferWhyItMatters) {
    for (const prep of preparedWhy) {
      if (prep.dropped) continue;
      prep.story.whyItMatters = safeWhyFallbackForState(prep.whyState);
    }
    whyItMattersDiagnostics = {
      ...emptyWhyItMattersRunDiagnostics(),
      enabled: effectiveWhyConfig.enabled,
      deferred: true,
      whyConcurrency: 0,
      whyMs: 0,
    };
    console.log(
      `[pipeline.whyItMatters] deferred=true (interactive fast-path)` +
        ` stories=${preparedWhy.filter((p) => !p.dropped).length} enrichment=pending`
    );
  } else {
  // Parallel fan-out — bounded worker pool caps in-flight resolver calls at
  // `whyConcurrency`.  `whyMs` is the wall-clock for the whole stage.
  const { concurrency: whyConcurrency } = resolveWhyConcurrencyConfig();
  const whyStartedAt = Date.now();
  const whyResolver = resolveWhyItMattersFn ?? resolveWhyItMatters;
  const runWhyOnce = (prep) =>
    whyResolver(prep.resolveArgs, {
      writeFn: whyWriteFn ?? undefined,
      config: effectiveWhyConfig,
    });
  // A `rejected` settle means `resolveWhyItMatters` itself threw; it normally
  // fail-closes internally, so this is a defensive net: synthesize the same
  // state-aware safe fallback the resolver would have returned (marked as a
  // transient failure in diagnostics so the D2 retry/drop logic engages).
  const synthWhyResolverThrew = (prep) => ({
    whyItMatters: safeWhyFallbackForState(prep.whyState),
    trace: {
      metaStoryId: typeof prep.story.metaStoryId === "string" ? prep.story.metaStoryId : "",
      state: prep.whyState,
      fallback_used: true,
    },
    diagnostics: { fallbackUsed: true, fallbackReason: "resolver_threw", llmFailed: { write: true } },
  });
  const whySettled = await pMap(
    preparedWhy,
    // D2: skip the writer entirely for stories already dropped upstream.
    (prep) => (prep.dropped ? Promise.resolve(null) : runWhyOnce(prep)),
    whyConcurrency
  );
  // Collapse settled → plain results (index-aligned). Dropped stories carry a
  // null placeholder; rejected settles synthesize the resolver-threw fallback.
  const whyResults = preparedWhy.map((prep, i) => {
    if (prep.dropped) return null;
    const settled = whySettled[i];
    return settled.status === "fulfilled" ? settled.value : synthWhyResolverThrew(prep);
  });
  // D2: one retry per failing story (locked decision #3). Re-run the resolver
  // once for any non-dropped story whose first attempt was a transient failure.
  for (let i = 0; i < preparedWhy.length; i += 1) {
    const prep = preparedWhy[i];
    if (prep.dropped) continue;
    if (!isWhyItMattersFailure(whyResults[i])) continue;
    d2WhyItMatters.retried += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      whyResults[i] = await runWhyOnce(prep);
    } catch {
      whyResults[i] = synthWhyResolverThrew(prep);
    }
  }
  whyMs = Date.now() - whyStartedAt;

  // Apply pass — walk results in input index order so story order is unchanged
  // (R1). A story whose why stage still fails after the retry is dropped from
  // the published set (fail-closed per story); survivors get their copy/trace.
  for (let i = 0; i < preparedWhy.length; i += 1) {
    const prep = preparedWhy[i];
    if (prep.dropped) continue; // already dropped by what-changed
    const { story } = prep;
    const why = whyResults[i];
    if (isWhyItMattersFailure(why)) {
      d2WhyItMatters.dropped += 1;
      if (typeof story.metaStoryId === "string" && story.metaStoryId.length > 0) {
        narrativeDroppedStoryIds.add(story.metaStoryId);
        d2WhyItMatters.droppedIds.push(story.metaStoryId);
      }
      perStoryWhyItMatters.push(why); // count the failed attempt in aggregate
      continue;
    }
    story.whyItMatters = why.whyItMatters;
    if (typeof story.metaStoryId === "string" && story.metaStoryId.length > 0) {
      whyItMattersTraces[story.metaStoryId] = why.trace;
    }
    perStoryWhyItMatters.push(why);
  }
  whyItMattersDiagnostics = aggregateWhyItMattersDiagnostics(perStoryWhyItMatters, {
    enabled: effectiveWhyConfig.enabled,
  });
  // Stage wall-clock + concurrency surfaced on the diagnostics object so they
  // ride along in the returned `log.whyItMatters` next to `latencyMs` (the
  // analogous what-changed/recall stages already expose per-stage latency).
  whyItMattersDiagnostics.whyConcurrency = whyConcurrency;
  whyItMattersDiagnostics.whyMs = whyMs;
  // Slice 5: full (non-deferred) run already produced final copy — flag it so
  // `_meta.whyItMatters.deferred` is always present for profile comparison.
  whyItMattersDiagnostics.deferred = false;
  console.log(
    `[pipeline.whyItMatters]` +
      ` schema=${whyItMattersDiagnostics.schemaVersion}` +
      ` enabled=${whyItMattersDiagnostics.enabled}` +
      ` stories=${whyItMattersDiagnostics.storiesAttempted}` +
      ` pass=${whyItMattersDiagnostics.pass}` +
      ` rewrite_ok=${whyItMattersDiagnostics.rewriteOk}` +
      ` fallback=${whyItMattersDiagnostics.fallback}` +
      ` low_confidence=${whyItMattersDiagnostics.lowConfidence}` +
      ` llm_failed_write=${whyItMattersDiagnostics.llmFailed.write}` +
      ` llm_failed_rewrite=${whyItMattersDiagnostics.llmFailed.rewrite}` +
      ` latency_write_ms=${whyItMattersDiagnostics.latencyMs.write}` +
      ` latency_rewrite_ms=${whyItMattersDiagnostics.latencyMs.rewrite}` +
      ` why_concurrency=${whyConcurrency}` +
      ` why_ms=${whyMs}`
  );
  }

  // ── D2: fail-closed-per-story drop + stability diagnostics ───────────────
  // Remove the stories a narrative stage could not produce content for (after
  // one retry). Silent drop — no user-facing notice (locked decision #2). All
  // downstream counts (funnel finalStories, metaStoryCount, outcomes) reflect
  // the published survivor set. A global refresh is never failed by per-story
  // narrative failures (locked decision #1).
  if (narrativeDroppedStoryIds.size > 0) {
    const before = stories.length;
    stories = stories.filter(
      (s) => !(typeof s.metaStoryId === "string" && narrativeDroppedStoryIds.has(s.metaStoryId))
    );
    console.log(
      `[pipeline.narrativeStability] policy=fail_closed_per_story` +
        ` eligible=${narrativeEligibleCount} dropped=${before - stories.length}` +
        ` survived=${stories.length}` +
        ` whatChangedDropped=${d2WhatChanged.dropped} whyDropped=${d2WhyItMatters.dropped}` +
        ` ids=${[...narrativeDroppedStoryIds].join(",")}`
    );
  }
  const narrativeStabilityDiagnostics = buildNarrativeStabilityDiagnostics({
    eligible: narrativeEligibleCount,
    droppedStoryIds: narrativeDroppedStoryIds,
    whatChanged: d2WhatChanged,
    whyItMatters: d2WhyItMatters,
  });

  const payload = {
    contractVersion,
    stories,
    // Server-side trace map keyed by metaStoryId (spec §7).  Stripped from
    // the API response by `stripPersistedFields` in server.mjs; persisted
    // only inside the snapshot blob so operators can answer "why did we
    // say this?" on replay without re-running the writer.
    _whyItMattersTraces: whyItMattersTraces,
  };

  // Funnel summary — every refresh emits one. When stories=0 we additionally
  // log a strict-empty diagnosis line that names the primary drop stage so an
  // operator can spot "where did the 33 items collapse to 0?" without
  // re-running the pipeline by hand.
  const funnel = summarizeFunnel(
    {
      totalNormalized: normalizedItems.length,
      afterTimeWindow: recentNormalizedItems.length,
      afterSourceSelection: recentItems.length,
      afterGeoFilter: geoPassedItems.length,
      afterTopicKeyword: recallItems.length,
      afterBeatFit: relevantItems.length,
      afterDedupe: dedupedItems.length,
      finalStories: stories.length,
    },
    settings,
    { executionMode: FUNNEL_EXECUTION_MODE.FULL_RUN }
  );
  console.log(`[pipeline.funnel] ${formatFunnel(funnel)}  execution_mode=${funnel.executionMode}  primary_drop=${funnel.primaryDropStage}`);
  if (stories.length === 0) {
    const noteParts = [];
    noteParts.push(`primary_drop=${funnel.primaryDropStage}`);
    if (funnel.topicKeywordRecallIsNoop) noteParts.push("recall_noop=true(no topics+keywords configured)");
    if (groundingFailures > 0) noteParts.push(`grounding_dropped=${droppedUngroundedStoryCount}`);
    if (beatFitEnabled && recallItems.length > 0 && relevantItems.length === 0) noteParts.push("beat_fit_strict_empty=true");
    console.log(`[pipeline.strict-empty] stories=0  ${noteParts.join("  ")}`);
  }

  // Slice 7: unified per-stage wall-clock timings (additive). Stages are
  // NON-OVERLAPPING brackets — preClusterMs, geoMs, recallMs, clusterMs,
  // whatChangedMs, whyMs each cover a disjoint span — and `pipelineMs` is the
  // outer envelope (their sum <= pipelineMs; the remainder is bracket overhead
  // plus the unattributed build/sort/tag span between clusterMs and
  // whatChangedMs). whyMs reuses the Slice 6 measurement so it stays a single
  // source of truth.
  const pipelineMs = Math.max(0, Date.now() - pipelineStartedAt);
  const pipelineTimings = { preClusterMs, geoMs, recallMs, clusterMs, whatChangedMs, whyMs, pipelineMs };

  // ── Slice 14: per-story translated-source coverage + degraded markers ───────
  // A story is full-confidence when ≥60% of its sources carry usable English
  // evidence (English-native OR successfully translated). Below threshold it is
  // marked degraded/low-confidence in `_meta.translation.stories` — never
  // hard-blocked (the translated subset still ships). Per-story coverage lives
  // in `_meta` (NOT on the story payload) so the dashboard schema is untouched
  // and meta-story copy stays English (Slice 15 owns cluster/writer guardrails).
  const perStoryTranslation = {};
  let degradedStoryCount = 0;
  for (const ms of groundedStories) {
    const storyItems = (ms.source_item_ids ?? [])
      .map((id) => sourceItemsById.get(id))
      .filter(Boolean);
    const coverage = computeStoryCoverage(storyItems);
    perStoryTranslation[ms.meta_story_id] = coverage;
    if (coverage.degraded) degradedStoryCount++;
  }
  const translationDiagnostics = {
    ...translationStageDiagnostics,
    coverageThreshold: TRANSLATION_COVERAGE_THRESHOLD,
    translationMs,
    degraded: {
      storyCount: degradedStoryCount,
      rate: stories.length > 0 ? degradedStoryCount / stories.length : 0,
    },
    stories: perStoryTranslation,
  };
  if (degradedStoryCount > 0) {
    console.warn(
      `[pipeline.translation] ${degradedStoryCount}/${stories.length} story(ies) below ` +
        `${TRANSLATION_COVERAGE_THRESHOLD * 100}% translated-source coverage — marked low-confidence (degraded subset still shipped)`
    );
  }
  console.log(
    `[pipeline.timings] preClusterMs=${preClusterMs} geoMs=${geoMs} recallMs=${recallMs}` +
      ` clusterMs=${clusterMs} whatChangedMs=${whatChangedMs} whyMs=${whyMs} pipelineMs=${pipelineMs}`
  );
  // Slice 4: one grep-friendly line so operators can confirm the profile that
  // shaped this run's latency and read the key timing contributors (geo +
  // cluster) alongside the resulting story count for profile-on vs baseline
  // comparison.
  console.log(
    `[pipeline.profile] profile=${profile.name} geoBudgetMs=${effectiveGeoBudgetMs}` +
      ` clusterMaxAttempts=${profile.clusterMaxAttempts}` +
      ` clusterTimeoutMs=${profile.clusterTimeoutMs ?? "default"}` +
      ` geoMs=${geoMs} clusterMs=${clusterMs} stories=${stories.length}`
  );
  const log = {
    totalItems: normalizedItems.length,
    poolCount: recentItems.length,
    recentCount: recentItems.length,
    geoHeldCount: geoHeldItems.length,
    geo: geoDiagnostics,
    relevantCount: relevantItems.length,
    relevantItemCount: relevantItems.length, // alias surfaced in `_meta.selection`
    metaStoryCount: stories.length,
    usedFallbackClustering,
    // Clustering fail-closed diagnostics (Slice 1).  `usedFallbackClustering`
    // now means "clustering failed → published 0 stories" (not "degraded
    // buckets shipped").  `clusteringFailureReason` is 'timeout' | 'error' |
    // null; `clusteringAttempts` counts initial-try + retries; latency is the
    // per-attempt array so an operator can see how long each attempt ran
    // before the timeout/error.
    clusteringFailureReason,
    clusteringAttempts,
    // C2 (clustering JSON resilience): single safe-trim repair diagnostics for
    // the last clustering attempt.  `clusteringRepairAttempted` is true when the
    // strict parse failed and the one repair pass ran; `clusteringRepairSucceeded`
    // true when that pass parsed cleanly; `clusteringRepairFailureReason` is a
    // concise classification (`json_parse_error` | `schema_validation_error` |
    // `no_json_region` | `parse_error`) or null.
    clusteringRepairAttempted: clusteringRepair.attempted,
    clusteringRepairSucceeded: clusteringRepair.succeeded,
    clusteringRepairFailureReason: clusteringRepair.failureReason,
    // Slice 3 (structured-output hardening): finer-grained, machine-parseable
    // clustering diagnostics surfaced on `_meta` for incident triage.
    //
    // SEMANTICS — "raw failure observed" is NOT "terminal failure".  The two
    // fields below describe what was wrong with the model's RAW output and can
    // be NON-NULL on a RECOVERED run (one where the single repair pass parsed
    // cleanly and stories were published).  They must NOT be read as a failure
    // signal on their own — see `clusteringRepairRecovered` below and the
    // terminal-failure guard on the `outcomes` rollup.
    //   `clusteringRepairRawFailureClass`   — class of the INITIAL strict-parse
    //       failure even when the repair pass later succeeded (so "the raw model
    //       output was malformed but we recovered it" is observable).
    //   `clusteringRepairSchemaErrorBucket` — coarse schema-failure bucket when
    //       the (raw or terminal) failure was schema-level; null otherwise.
    //   `clusteringRepairCoercion`          — structural normalization applied
    //       to recover the output (`array_wrap`) or null.
    clusteringRepairRawFailureClass: clusteringRepair.rawFailureClass ?? null,
    clusteringRepairSchemaErrorBucket: clusteringRepair.schemaErrorBucket ?? null,
    clusteringRepairCoercion: clusteringRepair.coercion ?? null,
    // Slice 3 follow-up: explicit, additive "recovered" boolean so downstream
    // observability never has to infer recovery from the raw-class/bucket
    // fields.  True iff the strict parse failed (`attempted`) AND the single
    // repair pass then parsed cleanly (`succeeded`).  A recovered run publishes
    // stories and is NOT a clustering failure: `clusteringFailureReason` is
    // null and `usedFallbackClustering` is false on this path.
    clusteringRepairRecovered:
      clusteringRepair.attempted === true && clusteringRepair.succeeded === true,
    timings: pipelineTimings,
    // Slice 4: latency-shaping profile applied to this run.  Additive,
    // deterministic snapshot of the resolved knobs (name + the geo budget /
    // clustering envelope actually used) so an operator can compare profile-on
    // vs baseline from `_meta.profile` alone.  `effectiveGeoBudgetMs` reflects
    // the value the geo stage actually ran with (test override > profile > env).
    profile: {
      name: profile.name,
      interactive: profile.interactive,
      geoStageBudgetMs: effectiveGeoBudgetMs,
      clusterMaxAttempts: profile.clusterMaxAttempts,
      clusterTimeoutMs: profile.clusterTimeoutMs,
    },
    // Slice 3: run-level outcome rollup — the handful of fields an operator (or
    // the SLO log line / summary) needs to judge "did this refresh do its job?"
    // without walking the full diagnostics tree.  Additive; mirrors values
    // already present elsewhere in this log.
    //
    // TERMINAL-FAILURE GUARD: clustering-failure rollups MUST be derived from
    // the terminal fields `clusteringFailureReason` (non-null) and
    // `usedFallbackClustering` (true) — NEVER from the presence of
    // `clusteringRepairRawFailureClass` / `clusteringRepairSchemaErrorBucket`,
    // which are also populated on recovered (published) runs and would
    // overcount failures if treated as failure signals.
    outcomes: {
      storiesPublished: stories.length,
      clusteringAttempts,
      clusteringFailureReason,
      usedFallbackClustering,
      ...geoDiagnostics,
    },
    clusteringLatencyMs: clusteringAttemptLatencyMs,
    // Slice 2 — post-cluster split healer diagnostics. `enabled` reflects the
    // resolved config; `splitCount` / `splitReasons` show how many over-merged
    // clusters were split and why (low_token_overlap | disjoint_claim_evidence).
    clusterSplit: {
      enabled: clusterSplitDiagnostics.enabled,
      inputCount: clusterSplitDiagnostics.inputCount,
      outputCount: clusterSplitDiagnostics.outputCount,
      splitCount: clusterSplitDiagnostics.splitCount,
      splitReasons: clusterSplitDiagnostics.splitReasons,
    },
    groundingFailures,
    // Phase 3 strict-grounding metrics
    droppedUngroundedStoryCount,
    groundingDropReasons,
    rejectionRecords, // exposed in log for testability; route persists via writeRejectionsFn
    normErrors: normErrors.length,
    selection: { ...selectionMeta, relevantItemCount: relevantItems.length },
    // Phase 1 relevance Stage 2 — internal explainability (no UI surface).
    // Includes the threshold, totals, and a histogram of exclusion reasons so
    // we can debug "why did 12 items become 0 stories?" from logs alone.
    beatFit: {
      version: BEAT_FIT_VERSION,
      enabled: beatFitEnabled,
      threshold: beatFitResult.summary.threshold,
      recallCount: recallItems.length,
      includedCount: beatFitResult.summary.includedCount,
      excludedCount: beatFitResult.summary.excludedCount,
      excludeReasonHistogram: beatFitResult.summary.excludeReasonHistogram,
      // Option A — semantic blend rollup carried through to _meta so an
      // operator can answer "did semantic actually move the needle this
      // refresh?" without running a counterfactual.
      semanticBlendEnabled: beatFitResult.summary.semanticBlendEnabled,
      semanticBlendAppliedCount: beatFitResult.summary.semanticBlendAppliedCount,
      semanticBlendMissingCount: beatFitResult.summary.semanticBlendMissingCount,
      semanticLiftOverThresholdCount: beatFitResult.summary.semanticLiftOverThresholdCount,
      semanticDropBelowThresholdCount: beatFitResult.summary.semanticDropBelowThresholdCount,
      excludedWithSemanticPresentCount: beatFitResult.summary.excludedWithSemanticPresentCount,
    },
    // Option A — semantic stage diagnostics: latency, cache hit/miss, model,
    // per-bucket distribution, and any degraded reason. Surfaced under its
    // own `_meta.semanticBeatFit` key so the scorer log and the stage log
    // are independently inspectable.
    semanticBeatFit: semanticBeatFitDiagnostics,
    // Cross-feed dedupe metrics — `inputCount` is the post-beat-fit candidate
    // pool, `uniqueCount` what clustering actually saw, `collapsedCount` the
    // number of duplicate-article folds.  Operator-facing only; never
    // surfaced in the response payload.
    dedupe: {
      inputCount: relevantItems.length,
      uniqueCount: dedupedItems.length,
      collapsedCount: dedupeResult.duplicateCount,
    },
    // C1: deterministic cluster input cap.  `dedupedCount` is the post-dedupe
    // pool, `clusterInputCount` what `clusterFn` actually saw (≤ CLUSTER_INPUT_CAP),
    // `clusterDroppedCount` / `clusterDroppedSourceIds` the candidates ranked
    // beyond the cap.  Operator-facing only; never surfaced in the response.
    clusterCap: clusterCapDiagnostics,
    // Embedding-aware recall observability — mode, embedded/keyword counts,
    // top-K kept, and any fail-closed `degraded_reason` bubble up here so
    // operators can answer "did embeddings widen recall this run, or did the
    // run fall through fail-closed?" from logs alone.
    recall: recallDiagnostics,
    // Slice 14: translation-first normalization diagnostics. Run-level
    // (coverage, translated/failed/timeout counts, cache hits, degraded
    // fallback rate, latency p50/p95) plus per-story translated-source coverage
    // + degraded/low-confidence markers under `stories`. Surfaced under
    // `_meta.translation`.
    translation: translationDiagnostics,
    // Phase 4: per-axis semantic tag-mapping diagnostics aggregated across
    // shipped stories.  `enabled` reflects the configured state; `accepted`/
    // `rejected`/`belowThresholdCount` show how often the uplift fired and
    // how often it was borderline.  Geographies axis carries the explicit
    // `semanticApplied: false` lock so an operator can see Phase 4 scope
    // hasn't drifted.
    tags: tagsDiagnostics,
    // Per-stage funnel + primary-drop-stage diagnosis. Operator-facing only.
    funnel,
    // Phase 4 hardening: watermark + skip metadata.  `unchanged` is false here
    // because we executed the full pipeline; the short-circuit branch above
    // returns early with `unchanged: true` and `payload: null`.
    unchanged: false,
    refreshSkippedReason: null,
    watermark: watermarkInfo.watermark,
    candidateCount: watermarkInfo.candidateCount,
    selectedFeedCount: watermarkInfo.selectedFeedCount,
    // Phase 2 lightweight decision trace.  Compact, backend-only diagnostics
    // mirroring the funnel + beat-fit summary with a small capped sample of
    // exclusions.  Never carries source bodies; safe for log scrapes.
    decisionTrace: buildDecisionTrace({
      stageCounts: {
        totalNormalized: normalizedItems.length,
        afterTimeWindow: recentNormalizedItems.length,
        afterSourceSelection: recentItems.length,
        afterGeoFilter: geoPassedItems.length,
        afterTopicKeyword: recallItems.length,
        afterBeatFit: relevantItems.length,
        afterDedupe: dedupedItems.length,
        finalStories: stories.length,
      },
      beatFitResult,
    }),
    // Run-level what-changed diagnostics aggregated from the per-story
    // `resolveWhatChanged` results above.  Persisted via
    // `_lastRunMeta.whatChanged` and surfaced under `_meta.whatChanged` so
    // operators can answer "how often did the engine fire and what did it
    // decide?" without re-running refresh.
    whatChanged: whatChangedDiagnostics,
    // Run-level why-this-matters diagnostics aggregated from the per-story
    // `resolveWhyItMatters` results above.  Same shape pattern as
    // `whatChanged`: counters for pass / fallback / hardFail /
    // lowConfidence + write/rewrite latency.  Persisted via
    // `_lastRunMeta.whyItMatters` and surfaced under `_meta.whyItMatters`.
    whyItMatters: whyItMattersDiagnostics,
    // Slice 5: progressive-enrichment state for the interactive fast-path.
    // `deferred:true` means this run shipped fallback `whyItMatters` and an
    // async upgrade is pending; `pending`/`completed`/`total` count published
    // stories so the client can poll until `pending === 0`.  A non-deferred run
    // reports everything completed up front.  `upgradeLatencyMs` is filled in
    // by the enrichment write (null on the first paint).  Always present so the
    // contract is stable for older clients (additive, tolerant).
    whyEnrichment: deferWhyItMatters
      ? { deferred: true, pending: stories.length, completed: 0, total: stories.length, upgradeLatencyMs: null }
      : { deferred: false, pending: 0, completed: stories.length, total: stories.length, upgradeLatencyMs: null },
    // D2: per-story narrative-stability rollup (fail-closed policy, per-stage
    // retry/drop tallies, retention rate). Additive; surfaced for operators and
    // the standalone advisory eval. No user-facing messaging is derived from it.
    narrativeStability: narrativeStabilityDiagnostics,
  };

  return { payload, log };
}

// ─── Slice 5: standalone whyItMatters enrichment (async upgrade pass) ─────────
//
// Recomputes richer `whyItMatters` for an already-published, response-shaped
// story set WITHOUT re-running clustering / grounding (so metaStoryId lineage
// is preserved exactly).  Reuses the same why engine the pipeline uses, so the
// upgraded copy is identical to what a non-deferred run would have produced.
// Pure over its inputs (no snapshot I/O — the caller owns persistence + the
// stale guard); returns fresh story clones so the caller can patch by
// metaStoryId.  On any per-story resolver failure it falls back to the same
// state-aware safe copy the deferred first paint used (never empty, never a
// subtitle echo) — so a failed upgrade degrades to the already-valid fallback
// rather than corrupting the snapshot.
// Slice 5 follow-through (Slice 6): when an enrichment upgrade fails, prefer a
// SOURCE-GROUNDED fallback over the generic state template.  Built entirely
// from the story's own already-grounded fields (its C0 summary + real outlet
// count) — no fabrication — so it's safe and more useful than boilerplate.
// Returns null when there's no groundable summary, so the caller falls back to
// the state-aware template (still non-empty, never a subtitle echo).
const GROUNDED_WHY_MAX_CHARS = 300;
export function buildSourceGroundedWhyFallback(story) {
  const summary = typeof story?.summary === "string" ? story.summary.trim() : "";
  if (!summary) return null;
  // First sentence of the grounded summary (the summary is itself a join of
  // verified claims under the C0 policy), so this stays evidence-anchored.
  const firstSentence = (summary.split(/(?<=[.!?])\s+/)[0] ?? summary).trim();
  if (!firstSentence) return null;
  const outletCount =
    typeof story?.outletCount === "number" && story.outletCount > 0
      ? story.outletCount
      : Array.isArray(story?.sources)
        ? story.sources.length
        : 0;
  const lead = outletCount > 1 ? `Across ${outletCount} sources, ` : "Per current sourcing, ";
  let text = `${lead}${firstSentence}`;
  if (text.length > GROUNDED_WHY_MAX_CHARS) {
    text = text.slice(0, GROUNDED_WHY_MAX_CHARS - 1).trimEnd() + "…";
  }
  return text;
}

export async function enrichWhyItMattersForStories({
  stories,
  everSeenMetaStoryIds = null,
  whyConfig = null,
  whyWriteFn = null,
  resolveWhyItMattersFn = null,
  doctrineRetrievalFn = null,
}) {
  const list = Array.isArray(stories) ? stories : [];
  const effectiveWhyConfig = whyConfig ?? resolveWhyConfig();
  const everSeenSet = new Set(Array.isArray(everSeenMetaStoryIds) ? everSeenMetaStoryIds : []);
  const whyResolver = resolveWhyItMattersFn ?? resolveWhyItMatters;
  const { concurrency } = resolveWhyConcurrencyConfig();
  const startedAt = Date.now();

  // The persisted story carries `whatChanged` text but not the delta-state
  // enum, so enrichment derives the why state from everSeen alone (null
  // whatChangedState → engine's fail-closed derivation).  Emphasis fidelity is
  // slightly looser than first-cluster, but the copy is still grounded in the
  // story's own summary/subtitle/whatChanged — and far richer than the
  // fallback it replaces.
  const prepared = list.map((story) => {
    const everSeenForStory =
      typeof story?.metaStoryId === "string" && everSeenSet.has(story.metaStoryId);
    const whyState = deriveWhyStateFromWhatChangedState({
      whatChangedState: null,
      everSeen: everSeenForStory,
    });
    let doctrineSnippets = [];
    try {
      doctrineSnippets = doctrineRetrievalFn
        ? doctrineRetrievalFn({ story, state: whyState })
        : retrieveDoctrineSnippetsForStory({ story, state: whyState });
      if (!Array.isArray(doctrineSnippets)) doctrineSnippets = [];
    } catch {
      doctrineSnippets = [];
    }
    return {
      story,
      whyState,
      resolveArgs: {
        metaStoryId: story?.metaStoryId,
        title: story?.title,
        subtitle: story?.subtitle,
        summary: story?.summary,
        whatChanged: story?.whatChanged,
        whatChangedState: null,
        everSeen: everSeenForStory,
        state: whyState,
        evidenceRefs: computeEvidenceRefsForStory(story, null),
        doctrineSnippets,
      },
    };
  });

  const settled = await pMap(
    prepared,
    async (prep) => {
      try {
        const why = await whyResolver(prep.resolveArgs, {
          writeFn: whyWriteFn ?? undefined,
          config: effectiveWhyConfig,
        });
        if (why && typeof why.whyItMatters === "string" && why.whyItMatters.length > 0) {
          return { copy: why.whyItMatters, ok: true };
        }
        // Resolver returned no copy → prefer a source-grounded fallback over
        // the generic template (Slice 5 follow-through), else the state template.
        return {
          copy: buildSourceGroundedWhyFallback(prep.story) ?? safeWhyFallbackForState(prep.whyState),
          ok: false,
        };
      } catch {
        // Resolver threw → same grounded-first degrade (never empty / echo).
        return {
          copy: buildSourceGroundedWhyFallback(prep.story) ?? safeWhyFallbackForState(prep.whyState),
          ok: false,
        };
      }
    },
    concurrency
  );

  let upgraded = 0;
  const enrichedStories = prepared.map((prep, i) => {
    const r = settled[i];
    const value = r && r.status === "fulfilled" ? r.value : null;
    const copy = value?.copy ?? safeWhyFallbackForState(prep.whyState);
    if (value?.ok) upgraded += 1;
    return { ...prep.story, whyItMatters: copy };
  });

  return {
    stories: enrichedStories,
    diagnostics: {
      total: list.length,
      upgraded,
      enabled: effectiveWhyConfig.enabled,
      upgradeLatencyMs: Date.now() - startedAt,
    },
  };
}
