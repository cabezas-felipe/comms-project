import { normalizeSourceItems } from "../ingestion/source-normalizer.mjs";
import {
  verifyGrounding,
  generateMetaStoryId,
  readClusteringRepairDiagnostics,
  classifyClusteringFailureSubtype,
  clusteringReasonFromSubtype,
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
  buildSelectedSocialHandleSet,
  normalizeSocialHandle,
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
  buildKeywordMatchRegex,
  topicMatchesSettings,
  scoreGeoFit,
  computeRelevanceScore,
  compareSurvivalRank,
  isStoryOnBeat,
} from "./relevance-policy.mjs";
import {
  buildPreClusterPoolIndex,
  computePreClusterRelevanceScore,
  comparePreClusterRank,
} from "./pre-cluster-relevance.mjs";
import { buildRelevanceGatedFallbackStories } from "./relevance-gated-fallback.mjs";
import { rankItemsForTranslation } from "./translation-priority.mjs";
import {
  resolveGeoAdmissionMode,
  geoAdmissionDiagnostics,
} from "./geo-admission-config.mjs";
import {
  resolveRecallConfig,
  runEmbeddingRecall,
} from "../ingestion/embedding-recall.mjs";
import {
  TRANSLATION_COVERAGE_THRESHOLD,
  TRANSLATION_MODE,
  computeStoryCoverage,
  computeTranslationActivation,
  isNonEnglishItem,
  readBodyText,
  readHeadline,
  resolveTranslationConfig,
  resolveTranslationMode,
  translateEvidenceItems,
} from "../ingestion/evidence-translator.mjs";
import {
  SEMANTIC_BEAT_FIT_VERSION,
  attachSemanticScores,
  computeSemanticBeatFitScores,
  resolveSemanticBeatFitConfig,
} from "./semantic-beat-fit.mjs";
import { dedupeSourceItems } from "../ingestion/source-deduper.mjs";
import { mapIngestionKindToContractKind } from "../ingestion/source-kind.mjs";
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
  mergeElectionEventBundles,
  resolveElectionBundleConfig,
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
// 2 attempts, and a tighter 10-item cluster input cap.  All are wired into
// pipeline behavior (`deferGeoLane2` → geo stage, `clusterInputCap` → cluster
// cap).  No env overrides — these are locked constants.
export const COLD_START_GEO_STAGE_BUDGET_MS_DEFAULT = 12000;
export const COLD_START_CLUSTER_TIMEOUT_MS_DEFAULT = 45000;
export const COLD_START_CLUSTER_MAX_ATTEMPTS_DEFAULT = 2;
export const COLD_START_CLUSTER_INPUT_CAP_DEFAULT = 10;
// A3: locked cold-start translation caps — PROFILE-ONLY in this step.  The
// translation stage is NOT wired to them yet (that lands in A5/A6); for now they
// only shape `_meta.profile`.  They bound how much of a cold-start run's budget
// the translation stage may spend once wired: `…MAX_ITEMS` caps how many
// non-English items get translated, `…MAX_MS` caps the stage wall-clock.  No env
// overrides — locked like the other cold-start knobs above.
export const COLD_START_TRANSLATION_MAX_ITEMS_DEFAULT = 18;
export const COLD_START_TRANSLATION_MAX_MS_DEFAULT = 10000;

// ─── PR B / Step 2: cold-start clustering wall-clock envelope ────────────────
//
// Baseline (read from `_meta.timings` / `[pipeline.timings]` on cold-start runs):
// clustering (`clusterMs`) is by far the dominant term — the single largest AI
// round-trip — while `geoMs` (Lane 2 deferred → Lane 1 + lexical only),
// `recallMs`, and `preClusterMs` are comparatively small.  The p95 tail is NOT
// a single slow call; it is the RETRY case: attempt 1 runs to its 45s timeout
// on a slow provider, then attempt 2 runs up to ANOTHER full 45s.  Two
// sequential per-attempt timeouts = up to 90s of clustering alone — which, once
// geo + recall + what-changed + why are added, pushes `pipelineMs` past the 90s
// budget (`PIPELINE_SLOW_MS`).
//
// Targeted fix (latency-only, trust-preserving): bound the SUM of clustering
// attempts with a wall-clock budget.  The first attempt still gets the full,
// locked 45s per-attempt timeout; the retry's timeout is clamped to the budget
// the first attempt left behind (see `resolveClusterCallTimeoutMs`).  This caps
// the worst-case clustering envelope at ~60s (45s + a bounded retry) instead of
// ~90s, leaving ~30s of headroom for the rest of the pipeline.  Nothing that
// protects trust changes: still ALWAYS 2 attempts, still fail-closed on total
// failure, and the PR B Step 1 recovery tier's trigger/input semantics are
// untouched (it simply inherits the same budget-bounded call timeout the
// primary loop already used).  Locked constant, consistent with the other
// cold-start knobs — no env override.
export const COLD_START_CLUSTER_TOTAL_BUDGET_MS_DEFAULT = 60000;
// Floor for any single budget-bounded clustering call: even when the first
// attempt has eaten most/all of the total budget, the retry still gets a real
// (if short) shot rather than an instant-timeout 0ms call.  Bounds overshoot
// past the total budget to at most this value.
export const CLUSTER_CALL_MIN_TIMEOUT_MS = 5000;

// ─── Step 4.1: deadline-aware clustering envelope (cold-start p95 hardening) ──
//
// PR B Step 2 caps the clustering envelope at a FIXED 60s measured from
// clustering start, ignoring how much wall-clock the pipeline already spent on
// geo + recall + pre-cluster.  When upstream is slow that fixed 60s can still
// land `pipelineMs` above the 90s budget (60s clustering + slow upstream +
// downstream build/whatChanged/why).  Step 4.1 makes the envelope DEADLINE-aware:
// the clustering budget is additionally clamped to the wall-clock remaining
// until a pipeline-relative soft deadline, so clustering plans to FINISH by that
// deadline and leaves headroom for the downstream stages.
//
// `COLD_START_CLUSTER_DEADLINE_MS` is measured from `pipelineStartedAt` (NOT
// from clustering start): clustering should wrap up ~75s into the pipeline,
// reserving ~15s of the 90s `PIPELINE_SLOW_MS` budget for grounding + response
// build + what-changed + why.  In the common case (upstream finishes in well
// under ~15s) the deadline does NOT bind — `min(60000, 75000 - elapsed)` stays
// 60000 — so behavior is byte-identical to Step 2 and there is no common-path
// regression.  Only slow-upstream OUTLIERS (the p95 tail) get their clustering
// envelope trimmed.
//
// `COLD_START_CLUSTER_MIN_ENVELOPE_MS` floors the trimmed envelope so clustering
// always keeps a real shot even when the pipeline is already near/over the
// deadline — fail-closed + the PR B Step 1 recovery tier still function (a
// shorter envelope just makes a slow run more likely to fail closed → cold-start
// retry routes to the default profile, exactly the locked policy).  This is a
// time-budget knob only; the item cap (quality-shaping) is untouched.
export const COLD_START_CLUSTER_DEADLINE_MS = 75000;
export const COLD_START_CLUSTER_MIN_ENVELOPE_MS = 20000;

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
    // Locked cold-start defaults.  `deferGeoLane2` is honored by the geo stage
    // (Slice 2: all Lane 2 deferred to hold) and `clusterInputCap` by the
    // cluster-cap stage (Slice 3: tighter 10-item cap).
    return {
      name: "cold_start",
      interactive: true,
      geoStageBudgetMs: COLD_START_GEO_STAGE_BUDGET_MS_DEFAULT,
      clusterTimeoutMs: COLD_START_CLUSTER_TIMEOUT_MS_DEFAULT,
      clusterMaxAttempts: COLD_START_CLUSTER_MAX_ATTEMPTS_DEFAULT,
      // PR B Step 2: bound the whole 2-attempt clustering envelope (first
      // attempt keeps the locked 45s; the retry inherits the remaining budget).
      clusterTotalBudgetMs: COLD_START_CLUSTER_TOTAL_BUDGET_MS_DEFAULT,
      deferGeoLane2: true,
      clusterInputCap: COLD_START_CLUSTER_INPUT_CAP_DEFAULT,
      // A3: locked cold-start translation caps (profile-only — the translation
      // stage reads these in a later step, A5/A6).
      translationMaxItems: COLD_START_TRANSLATION_MAX_ITEMS_DEFAULT,
      translationMaxMs: COLD_START_TRANSLATION_MAX_MS_DEFAULT,
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
      // Interactive keeps a flat per-attempt timeout; no total-envelope cap.
      clusterTotalBudgetMs: null,
      // A3: no cold-start translation caps on this profile (explicit null for
      // shape clarity — only cold_start opts into the translation caps).
      translationMaxItems: null,
      translationMaxMs: null,
    };
  }
  return {
    name: "default",
    interactive: false,
    geoStageBudgetMs: null, // fall through to resolveGeoStageBudgetMs()
    clusterTimeoutMs: null, // fall through to env / cluster-engine default
    clusterMaxAttempts: DEFAULT_CLUSTER_MAX_ATTEMPTS,
    clusterTotalBudgetMs: null, // no clustering-envelope cap on the default path
    // A3: no cold-start translation caps on the default path (explicit null for
    // shape clarity).
    translationMaxItems: null,
    translationMaxMs: null,
  };
}

/**
 * PR B Step 2: resolve the `timeoutMs` for a SINGLE clustering call, bounded by
 * both the profile's per-attempt timeout AND the run's remaining clustering
 * wall-clock budget.  Pure (the caller injects `elapsedMs = Date.now() -
 * clusterStartedAt`) so the clamp math is unit-testable without real time.
 *
 *   - No total budget (default/interactive): returns the flat per-attempt
 *     timeout unchanged (null → caller passes no override).  Behavior is
 *     byte-identical to the pre-Step-2 path for those profiles.
 *   - With a total budget (cold_start): the call gets `min(perAttempt,
 *     remaining)` where `remaining = budget - elapsed`, floored at
 *     CLUSTER_CALL_MIN_TIMEOUT_MS so the retry always gets a real shot and the
 *     worst-case overshoot past the budget is bounded.  The first attempt
 *     (elapsed≈0) therefore keeps the full per-attempt timeout; only a retry
 *     after a slow/timed-out first attempt is shortened.
 *
 * Returns the timeout in ms, or null when neither bound applies.  Exported for
 * focused unit testing of the clamp contract.
 */
export function resolveClusterCallTimeoutMs({
  perAttemptTimeoutMs = null,
  totalBudgetMs = null,
  elapsedMs = 0,
}) {
  const perAttempt =
    Number.isFinite(perAttemptTimeoutMs) && perAttemptTimeoutMs > 0
      ? perAttemptTimeoutMs
      : null;
  const budget =
    Number.isFinite(totalBudgetMs) && totalBudgetMs > 0 ? totalBudgetMs : null;
  if (budget == null) {
    return perAttempt != null ? Math.floor(perAttempt) : null;
  }
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const remaining = Math.max(CLUSTER_CALL_MIN_TIMEOUT_MS, budget - elapsed);
  const bounded = perAttempt != null ? Math.min(perAttempt, remaining) : remaining;
  return Math.floor(bounded);
}

/**
 * Step 4.1: resolve the EFFECTIVE total clustering wall-clock budget for a run,
 * clamping the configured envelope down to the wall-clock that remains until a
 * pipeline-relative soft deadline.  Pure — `pipelineElapsedMs` is the wall-clock
 * the pipeline already spent before clustering started (`clusterStartedAt -
 * pipelineStartedAt`), injected by the caller so the math is unit-testable
 * without real time.
 *
 *   - No configured budget (`totalBudgetMs` null → default/interactive): returns
 *     null.  No envelope, behavior unchanged for those profiles.
 *   - No deadline (`deadlineMs` null): returns the configured budget verbatim —
 *     identical to the pre-Step-4.1 (Step 2) fixed-envelope behavior.
 *   - With a deadline (cold_start): returns `min(budget, deadline - elapsed)`,
 *     floored at `minEnvelopeMs`.  Fast upstream → `deadline - elapsed >= budget`
 *     → the budget is returned UNCHANGED (no common-path regression).  Slow
 *     upstream → the envelope is trimmed so clustering aims to finish by the
 *     deadline; a very slow pipeline floors at `minEnvelopeMs` so clustering
 *     still gets a real shot (fail-closed / recovery preserved).
 *
 * The result feeds `resolveClusterCallTimeoutMs` as its `totalBudgetMs`, so the
 * existing per-call clamp + floor still apply on top.  Exported for focused unit
 * testing of the envelope contract.
 */
export function resolveClusterEnvelopeBudgetMs({
  totalBudgetMs = null,
  pipelineElapsedMs = 0,
  deadlineMs = null,
  minEnvelopeMs = 0,
}) {
  const budget =
    Number.isFinite(totalBudgetMs) && totalBudgetMs > 0 ? totalBudgetMs : null;
  if (budget == null) return null;
  if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) return Math.floor(budget);
  const elapsed =
    Number.isFinite(pipelineElapsedMs) && pipelineElapsedMs > 0 ? pipelineElapsedMs : 0;
  const floor = Number.isFinite(minEnvelopeMs) && minEnvelopeMs > 0 ? minEnvelopeMs : 0;
  const remainingToDeadline = deadlineMs - elapsed;
  const effective = Math.max(floor, Math.min(budget, remainingToDeadline));
  return Math.floor(effective);
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
// Ranking (Phase 1.3): deterministic PRE-CLUSTER RELEVANCE order over the deduped
// set, replacing the legacy beat-fit-first order.  Each surviving item is scored
// by `computePreClusterRelevanceScore` (topic/keyword/geo fit + corroboration
// proxy + beat-fit/freshness shapers + Decision 5C election-geo shaping) against
// a single O(n) pool index, then sorted by `comparePreClusterRank`:
//   1. preClusterScore descending    — most relevant candidates survive the cap
//   2. corroboration descending       — more same-family sources wins ties
//   3. beatFitScore descending        — better beat fit next
//   4. minutesAgo ascending           — fresher item next
//   5. sourceId ascending             — stable final tie-break
// All keys come from the score object; missing numerics degrade to neutral
// (score 0 / oldest) exactly as the pre-cluster module specifies.  No new I/O,
// DB, or model calls — every signal is an item-level proxy.
export const CLUSTER_INPUT_CAP = 15;

// Step 1.4 diagnostics bounds.  `clusterDropped` carries explainable per-item
// drop reasons for `?debug=1`; both caps keep the payload bounded (no full
// bodies, no unbounded lists) so the diagnostic can ride in `_meta` cheaply.
export const CLUSTER_DROPPED_DETAIL_MAX = 10; // at most N explained drops
export const CLUSTER_DROPPED_HEADLINE_MAX_LEN = 160; // truncate headlines

// Deterministic, payload-safe number: finite → itself, otherwise null (so the
// JSON stays clean rather than emitting NaN/Infinity).
function safeNum(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// Build one bounded `clusterDropped` entry from a scored record + its absolute
// 1-based rank in the full ranked list.  All fields come off the pre-cluster
// score key (already computed for sorting) — no recompute, no I/O.
function buildClusterDropEntry(scored, rank) {
  const { item, key } = scored;
  const rawHeadline =
    typeof item?.headline === "string" && item.headline
      ? item.headline
      : typeof item?.normalizedHeadline === "string"
        ? item.normalizedHeadline
        : "";
  const headline =
    rawHeadline.length > CLUSTER_DROPPED_HEADLINE_MAX_LEN
      ? `${rawHeadline.slice(0, CLUSTER_DROPPED_HEADLINE_MAX_LEN - 1)}…`
      : rawHeadline;
  const c = key?.components ?? {};
  return {
    sourceId: typeof item?.sourceId === "string" ? item.sourceId : null,
    headline,
    rank,
    preClusterScore: safeNum(key?.preClusterScore),
    components: {
      topicFit: safeNum(c.topicFit),
      keywordFit: safeNum(c.keywordFit),
      geoFit: safeNum(c.geoFit),
      entityFit: safeNum(c.entityFit),
      corroboration: safeNum(c.corroboration),
      beatFit: safeNum(c.beatFit),
      freshness: safeNum(c.freshness),
      electionGeoBoost: safeNum(c.electionGeoBoost),
    },
    electionGeoClass: key?.electionGeoClass ?? null,
    hardFail: typeof key?.hardFail === "boolean" ? key.hardFail : null,
    geoReason: key?.geoReason ?? null,
    geoCategory: key?.geoCategory ?? null,
    headlineFamilyKey: typeof key?.headlineFamilyKey === "string" ? key.headlineFamilyKey : null,
  };
}

/**
 * Rank `dedupedItems` by pre-cluster relevance and slice to `cap`.  Returns the
 * capped `clusterInputItems` (what `clusterFn` actually sees) plus deterministic
 * diagnostics consistent with that slice.  Never mutates the input array.
 *
 * Flow: build the pool index once (single O(n) scan), score each item against it
 * (O(1) lookups), sort by `comparePreClusterRank`, slice the top `cap`.
 *
 * Diagnostics (Step 1.4): in addition to the counts + dropped IDs, an additive
 * `clusterDropped` array carries the top `CLUSTER_DROPPED_DETAIL_MAX` dropped
 * candidates (in drop-rank order) with their score + component breakdown so
 * `?debug=1` can explain WHY each was cut.
 *
 * @param {Array}  dedupedItems — post-beat-fit, post-dedupe candidate set
 * @param {Object} [settings]   — user settings (topics/keywords/geographies)
 * @param {number} [cap]        — max items to keep (default CLUSTER_INPUT_CAP)
 */
export function applyClusterInputCap(dedupedItems, settings = {}, cap = CLUSTER_INPUT_CAP) {
  const items = Array.isArray(dedupedItems) ? dedupedItems : [];
  const poolIndex = buildPreClusterPoolIndex(items, settings);
  // Carry the original item alongside its sort key so the cap slices real items
  // while ranking on the relevance score.
  const scored = items.map((item) => ({
    item,
    key: computePreClusterRelevanceScore(item, settings, poolIndex),
  }));
  scored.sort((a, b) => comparePreClusterRank(a.key, b.key));
  const clusterInputItems = scored.slice(0, cap).map((s) => s.item);
  const dropped = scored.slice(cap);
  return {
    clusterInputItems,
    diagnostics: {
      dedupedCount: items.length,
      clusterInputCount: clusterInputItems.length,
      clusterDroppedCount: dropped.length,
      // IDs of the candidates ranked beyond the cap, in drop (rank) order.
      clusterDroppedSourceIds: dropped
        .map((s) => s.item?.sourceId)
        .filter((id) => typeof id === "string"),
      // Explainable, bounded drop detail (drop-rank order; absolute 1-based
      // `rank` = cap + offset).  Same order as `clusterDroppedSourceIds`.
      clusterDropped: dropped
        .slice(0, CLUSTER_DROPPED_DETAIL_MAX)
        .map((s, i) => buildClusterDropEntry(s, cap + i + 1)),
    },
  };
}

// ─── A4: post-healer meta-story overflow cap ─────────────────────────────────
//
// Locked product decision: the dashboard ships AT MOST 5 meta-stories. The
// split-healer (A3) can, in rare over-merge cases, emit more rows than the
// clustering contract's nominal 5 (e.g. a wide disjoint over-merge bundled into
// 6+ sub-stories). This deterministic cap runs AFTER grounding so it trims only
// the published survivor set, and it maximizes what ships (post-grounding count,
// not pre-grounding) — grounding drops happen first, then this caps to 5.
//
// Drop ranking is a SURVIVAL order (best first → top 5 survive). It is
// deliberately distinct from the R1 *display* order: survivors keep their R1
// order; only WHICH stories survive is decided here.
//
// Q3A (Prompt 2): survival is now ordered by a deterministic RELEVANCE SCORE
// (`computeRelevanceScore`) rather than the coarse `topicKeywordMatchStrength`
// alone. The score combines, in weight order, configured-beat match
// (topic / keyword / grounded `associated_entities` entity fit) > geography fit
// > source corroboration > beat-fit > a small freshness shaper — so a story that
// genuinely matches the user's beat survives over generic same-geography noise.
// `compareSurvivalRank` then breaks exact ties with the SAME stable keys the
// legacy comparator used (more sources → higher beat-fit → fresher →
// metaStoryId ascending), so behavior stays byte-deterministic. The legacy
// `topicKeywordMatchStrength` is retained on the sort key for rejection-log
// observability. No new LLM call: every input is existing cluster output.
export const MAX_META_STORIES = 5;

export function topicKeywordMatchStrength(story) {
  const tags = story?.tags;
  const hasTopics = Array.isArray(tags?.topics) && tags.topics.length > 0;
  const hasKeywords = Array.isArray(tags?.keywords) && tags.keywords.length > 0;
  if (hasTopics && hasKeywords) return 2;
  if (hasTopics || hasKeywords) return 1;
  return 0;
}

/**
 * Cap a list of `{ story, sortKey }` entries to `cap` meta-stories. Entries are
 * assumed to already be in R1 display order; survivors are returned in that same
 * order (only the bottom-ranked overflow is removed). `sortKey` must carry the
 * rank inputs consumed by `compareSurvivalRank` (plus `metaStoryId`), and — for
 * the thin-on-beat guard — an `onBeat` boolean (see `isStoryOnBeat`).
 *
 * ── Decision 8C / Phase 2 · Step 2.1: thin on-beat guard ──────────────────────
 * When the survivor set OVERFLOWS the cap AND at least one on-beat story exists,
 * geo-only / off-beat noise must NOT survive as backfill: it is removed from the
 * eligible survivor set BEFORE the final cap selection. "Thin on-beat only" is an
 * allowed outcome — if only 2 of 6 overflow candidates are on-beat, just those 2
 * ship and the 4 geo-noise rows are dropped, even though that leaves fewer than
 * `cap` survivors. When NO on-beat story exists (e.g. an all-geo overflow set),
 * every story stays eligible and behavior is the prior pure-survival cap — the
 * guard never forces an empty result. The guard is gated on overflow (`> cap`):
 * the at-or-below-cap path is byte-identical to before.
 *
 * Returns the kept entries, the dropped entries (for rejection logging), and the
 * additive overflow diagnostics. A no-op (≤ cap) reports `overflowCapApplied:
 * false` and drops nothing. Two additive diagnostic fields report the guard:
 * `thinOnBeatGuardApplied` (true iff the guard removed ≥1 geo-noise story) and
 * `thinOnBeatFilteredCount` (how many it removed). Never mutates the input array.
 * Exported for testing.
 */
export function applyMetaStoryOverflowCap(entries, cap = MAX_META_STORIES) {
  const list = Array.isArray(entries) ? entries : [];
  const inputCount = list.length;
  const baseDiagnostics = {
    overflowCapApplied: false,
    overflowInputCount: inputCount,
    overflowOutputCount: inputCount,
    overflowDroppedCount: 0,
    overflowDroppedMetaStoryIds: [],
    thinOnBeatGuardApplied: false,
    thinOnBeatFilteredCount: 0,
  };

  if (inputCount <= cap) {
    return { kept: list, dropped: [], diagnostics: baseDiagnostics };
  }

  // Thin on-beat guard: when any on-beat story exists, only on-beat stories are
  // eligible to survive — geo-only/off-beat noise is suppressed (and still
  // rejection-logged via `dropped`). With no on-beat story, every story stays
  // eligible (prior behavior). Indices are the original (R1) positions.
  const indexed = list.map((entry, idx) => ({ entry, idx }));
  const onBeatIndexed = indexed.filter(({ entry }) => entry?.sortKey?.onBeat === true);
  const guardActive = onBeatIndexed.length > 0;
  const eligible = guardActive ? onBeatIndexed : indexed;
  const suppressed = guardActive
    ? indexed.filter(({ entry }) => entry?.sortKey?.onBeat !== true).map((r) => r.entry)
    : [];

  // Rank the eligible set by survival order, breaking final ties on the original
  // (R1) index so the cap itself is fully deterministic. Survivors = the top
  // `cap` eligible entries by rank.
  const ranked = eligible
    .slice()
    .sort((x, y) => {
      const c = compareSurvivalRank(x.entry?.sortKey, y.entry?.sortKey);
      return c !== 0 ? c : x.idx - y.idx;
    });
  const keepIdx = new Set(ranked.slice(0, cap).map((r) => r.idx));
  // Dropped = eligible overflow (survival drop-rank order) followed by any
  // guard-suppressed geo-noise (R1 order). Both reach the rejection log.
  const dropped = [...ranked.slice(cap).map((r) => r.entry), ...suppressed];
  const kept = list.filter((_, idx) => keepIdx.has(idx)); // preserves R1 order
  const overflowDroppedMetaStoryIds = dropped
    .map((e) => e?.sortKey?.metaStoryId)
    .filter((id) => typeof id === "string" && id);

  return {
    kept,
    dropped,
    diagnostics: {
      overflowCapApplied: true,
      overflowInputCount: inputCount,
      overflowOutputCount: kept.length,
      overflowDroppedCount: dropped.length,
      overflowDroppedMetaStoryIds,
      // Guard "applied" only when it actually removed geo-noise; an all-on-beat
      // overflow leaves this false and behaves like the prior pure-survival cap.
      thinOnBeatGuardApplied: suppressed.length > 0,
      thinOnBeatFilteredCount: suppressed.length,
    },
  };
}

// ─── B1: deferred re-cluster candidate queue (flagging + ranking only) ────────
//
// A3's split-healer DEFERS ambiguous over-merges instead of atomizing them,
// stamping each survivor with `_reclusterCandidate: true` + a `_reclusterReason`
// (`ambiguous_overlap_conflict` | `ambiguous_unnormalized_overlap`). B1 turns
// those flags into a deterministic, ranked, bounded QUEUE that a future B2
// executor can reconsider. This slice is metadata-ONLY: it runs NO re-cluster,
// patches NO snapshot, and does NOT change story selection/output. The queue is
// surfaced additively on `_meta.reclusterQueue`.
//
// Suspicion score (higher = more likely to need deferred re-cluster):
//   + RECLUSTER_FLAG_WEIGHT          the explicit A3 defer flag (dominant term,
//                                     so any flagged story outranks an unflagged
//                                     one regardless of the structural terms)
//   + reason weight                  `ambiguous_overlap_conflict` (the claim map
//                                     said "independent" but the text reunified —
//                                     a concrete disentanglement target) ranks
//                                     above `ambiguous_unnormalized_overlap`
//                                     (low overlap we simply couldn't confirm
//                                     cross-language)
//   + min(sourceCount, CAP) * W      more sources merged under ambiguity = more
//                                     to disentangle (bounded so it never
//                                     overtakes the reason term)
export const RECLUSTER_QUEUE_MAX = 2;
const RECLUSTER_FLAG_WEIGHT = 100;
const RECLUSTER_REASON_WEIGHTS = Object.freeze({
  ambiguous_overlap_conflict: 30,
  ambiguous_unnormalized_overlap: 20,
});
const RECLUSTER_SOURCE_WEIGHT = 2;
const RECLUSTER_SOURCE_CAP = 5; // bound the structural term (≤ +10)

/**
 * Score a single (grounded) meta-story as a deferred re-cluster candidate.
 * Returns null when the story carries no `_reclusterCandidate` flag (only A3's
 * explicit defers are candidates in B1). Pure; exported for focused testing.
 */
export function scoreReclusterCandidate(story) {
  if (!story || typeof story !== "object" || story._reclusterCandidate !== true) {
    return null;
  }
  const reason = typeof story._reclusterReason === "string" ? story._reclusterReason : null;
  const reasonCodes = ["recluster_flag"];
  let suspicionScore = RECLUSTER_FLAG_WEIGHT;
  if (reason) {
    reasonCodes.push(reason);
    suspicionScore += RECLUSTER_REASON_WEIGHTS[reason] ?? 0;
  }
  const sourceItemIds = Array.isArray(story.source_item_ids)
    ? story.source_item_ids.filter((id) => typeof id === "string" && id)
    : [];
  const sourceCount = sourceItemIds.length;
  suspicionScore += Math.min(sourceCount, RECLUSTER_SOURCE_CAP) * RECLUSTER_SOURCE_WEIGHT;
  return {
    metaStoryId: story.meta_story_id ?? null,
    suspicionScore,
    reason,
    reasonCodes,
    sourceItemIds,
    sourceCount,
  };
}

/**
 * Build the deferred re-cluster queue from a list of grounded meta-stories.
 * Candidates are the A3-flagged stories; they are ranked by suspicion score
 * (desc) then `metaStoryId` (asc, stable), de-duplicated by `metaStoryId`, and
 * capped at `maxQueue` (default 2). Returns the queue plus additive counts.
 * Pure; exported for focused testing.
 */
export function buildReclusterQueue(stories, maxQueue = RECLUSTER_QUEUE_MAX) {
  const list = Array.isArray(stories) ? stories : [];
  const candidates = [];
  const seen = new Set();
  for (const story of list) {
    const scored = scoreReclusterCandidate(story);
    if (!scored) continue;
    const key = scored.metaStoryId ?? `__noid_${candidates.length}`;
    if (seen.has(key)) continue; // no duplicates
    seen.add(key);
    candidates.push(scored);
  }
  candidates.sort((a, b) => {
    if (a.suspicionScore !== b.suspicionScore) return b.suspicionScore - a.suspicionScore;
    const aid = a.metaStoryId ?? "";
    const bid = b.metaStoryId ?? "";
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    return 0;
  });
  const reclusterQueue = candidates.slice(0, maxQueue);
  return {
    reclusterQueue,
    reclusterQueueCount: reclusterQueue.length,
    // Total flagged candidates before the cap — additive visibility into how
    // many were dropped because the queue is bounded to `maxQueue`.
    reclusterCandidateCount: candidates.length,
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

function joinOriginalText(item) {
  const headline = typeof item?.headline === "string" ? item.headline : "";
  const body = Array.isArray(item?.body)
    ? item.body.map((s) => String(s ?? "")).join(" ")
    : typeof item?.body === "string"
      ? item.body
      : "";
  return `${headline} ${body}`.trim();
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
  const hasTopics = (settings.topics ?? []).length > 0;
  // Soft widen (relevance-policy): the keyword regex now also matches the
  // English morphological lexicon variants of each configured keyword (e.g.
  // "election" admits "elections"/"electoral"). It stays ENGLISH-only on purpose
  // — the recall surface is normalized-English evidence, so folding in the
  // lexicon's Spanish forms would let an untranslated Spanish item bypass the
  // translation gate (see `relevance-policy.mjs` header). Topic matching widens
  // the same way via `topicMatchesSettings` (exact canonical OR lexicon sibling).
  const keywordRegex = buildKeywordMatchRegex(settings);
  const geographies = settings.geographies ?? [];
  const hasGeographies = geographies.length > 0;

  if (!hasTopics && !keywordRegex && !hasGeographies) return items;

  return items.filter((item) => {
    if (hasTopics && topicMatchesSettings(item.topic, settings)) return true;
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
  const hasTopics = (settings?.topics ?? []).length > 0;
  // Mirror applyTopicKeywordFilter's soft widen. `exactKeywordRegex` keeps the
  // pre-lexicon (verbatim-keyword) matcher around purely so the diagnostic can
  // attribute soft-match hits: an item that matches the widened regex but NOT
  // the exact one was admitted by the lexicon, counted in `keywordViaLexiconCount`.
  const keywordRegex = buildKeywordMatchRegex(settings ?? {});
  const exactKeywordRegex = buildKeywordTokenRegex(settings?.keywords);
  const geographies = settings?.geographies ?? [];
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
    keywordViaTranslatedCount: 0,
    // Soft-widen funnel diagnostics (relevance-policy): items admitted by a
    // lexicon variant rather than a verbatim keyword/topic match.
    keywordViaLexiconCount: 0,
    topicViaLexiconCount: 0,
    primaryDropCause: null,
  };

  if (!hasTopics && !hasKeywords && !hasGeographies) {
    breakdown.passNoConfig = inputCount;
    breakdown.passCount = inputCount;
    if (inputCount === 0) breakdown.primaryDropCause = "no_input";
    return breakdown;
  }

  for (const item of items ?? []) {
    const topicMatch = hasTopics && topicMatchesSettings(item?.topic ?? "", settings);
    if (
      topicMatch &&
      !(settings?.topics ?? []).some(
        (t) => normalizeTopicLabel(t) === normalizeTopicLabel(item?.topic ?? "")
      )
    ) {
      breakdown.topicViaLexiconCount++;
    }
    let keywordMatch = false;
    if (hasKeywords) {
      // Slice 14: mirror applyTopicKeywordFilter — read normalized English
      // evidence when present so the diagnostic breakdown matches the filter.
      const text = readHeadline(item) + " " + readBodyText(item);
      keywordMatch = keywordRegex.test(text);
      if (
        keywordMatch &&
        item?._translation?.applied === true &&
        !keywordRegex.test(joinOriginalText(item))
      ) {
        breakdown.keywordViaTranslatedCount++;
      }
      if (keywordMatch && !(exactKeywordRegex && exactKeywordRegex.test(text))) {
        breakdown.keywordViaLexiconCount++;
      }
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
 * R1 (M6b): comparator for top-level `stories[]` display ordering at the payload
 * boundary.  Accepts pre-computed sort keys (so the comparator stays a pure
 * function over plain values, not the story object).
 *
 * Prompt 2.1: display order is now RELEVANCE-FIRST, matching the overflow
 * survival policy (`compareSurvivalRank`) so "what shows first" and "what
 * survives the cap" use the same priority — the most beat-relevant story leads
 * the dashboard rather than merely the highest raw beat-fit:
 *   1. `relevanceScore` DESC   — most beat-relevant story first (new primary)
 *   2. `sourceCount` DESC      — more corroborated story first
 *   3. `maxBeatFitScore` DESC  — best raw beat-fit
 *   4. `minMinutesAgo` ASC     — freshest tie-breaker
 *   5. `metaStoryId` ASC       — stable, deterministic final tie-break
 *
 * Sort keys that predate Prompt 2.1 (no `relevanceScore` / `sourceCount`) read
 * those as 0 and tie through to the legacy beat-fit/freshness/id order, so the
 * comparator stays backward-compatible for callers passing bare keys.
 */
export function compareStoriesR1(a, b) {
  const ar = typeof a?.relevanceScore === "number" && Number.isFinite(a.relevanceScore) ? a.relevanceScore : 0;
  const br = typeof b?.relevanceScore === "number" && Number.isFinite(b.relevanceScore) ? b.relevanceScore : 0;
  if (ar !== br) return br - ar;
  const asc = typeof a?.sourceCount === "number" && Number.isFinite(a.sourceCount) ? a.sourceCount : 0;
  const bsc = typeof b?.sourceCount === "number" && Number.isFinite(b.sourceCount) ? b.sourceCount : 0;
  if (asc !== bsc) return bsc - asc;
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
 * Legacy geo-admission gate — the lane-1/lane-2 funnel, budget-bounded Lane 2
 * assessment, profile-driven defer, and the hold bucket.
 *
 * @deprecated ROLLBACK-ONLY. Since Prompt 4 the production default is `soft`
 *   (`TEMPO_GEO_ADMISSION_MODE` unset → no geo admission gate), which never
 *   calls this helper. It runs only when an operator explicitly sets
 *   `TEMPO_GEO_ADMISSION_MODE=hard` to roll back. This is a removal candidate
 *   once the soft default has been stable: before deleting, confirm telemetry
 *   shows no runs with `_meta.outcomes.geoAdmissionMode === "hard"` (and no
 *   `[pipeline.geo] hard admission gate ACTIVE` log lines) over the agreed
 *   stability window. Behavior here is byte-for-byte the pre-Prompt-5 inline
 *   path; do not change it while rollback must stay faithful.
 *
 * @returns {{
 *   geoPassedItems: object[], geoHeldItems: object[],
 *   geoLane2DeferredItems: object[], geoBudgetHit: boolean,
 *   geoLane2DeferredReason: ("profile_defer"|null)
 * }}
 */
async function runHardGeoAdmissionGate({
  lane1Items,
  lane2Ordered,
  configuredGeos,
  geoAssessFn,
  geoDiag,
  geoStartedAt,
  budgetMs,
  deferLane2,
}) {
  // Lane 1 always runs to completion (budget does not interrupt it).
  const lane1Result = await applyGeoFilter(lane1Items, configuredGeos, geoAssessFn, geoDiag);
  const geoPassedItems = [...lane1Result.included];
  const geoHeldItems = [...lane1Result.held];
  const geoLane2DeferredItems = [];
  let geoBudgetHit = false;

  // Slice 2 (cold_start): when the active profile sets `deferGeoLane2`, ALL of
  // Lane 2 (including held-bucket re-evals) is deferred to the hold path without
  // assessment — an intentional, profile-driven defer, NOT budget pressure. We
  // skip the wave loop entirely (no `applyGeoFilter` / assessor calls for Lane 2)
  // and leave `geoBudgetHit = false` (locked decision) so SLO/log consumers don't
  // misread this as the geo budget being exhausted.
  const geoLane2DeferredReason = deferLane2 ? "profile_defer" : null;
  if (deferLane2) {
    geoLane2DeferredItems.push(...lane2Ordered);
  } else {
    // Lane 2 runs in concurrency-sized waves; the budget is re-checked before
    // each wave so the stage stops cleanly at a pool boundary instead of
    // mid-flight. Iterate the PRIORITY-ORDERED set so the most-likely-relevant
    // items are assessed before the budget runs out; the deferred slice is the
    // lowest-priority tail.
    const lane2WaveSize = Math.max(1, resolveGeoAssessConcurrency());
    for (let i = 0; i < lane2Ordered.length; i += lane2WaveSize) {
      if (Date.now() - geoStartedAt >= budgetMs) {
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
  return {
    geoPassedItems,
    geoHeldItems,
    geoLane2DeferredItems,
    geoBudgetHit,
    geoLane2DeferredReason,
  };
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
    //
    // Phase 1.1 write-boundary guard: clamp every emitted axis to the saved
    // settings vocabulary so `story.tags.{topics,keywords,geographies}` are
    // guaranteed subsets of `settings.{topics,keywords,geographies}` even if
    // the assigner regresses.  `constrainTagsToSettings` preserves canonical
    // settings casing and dedupes — see the post-overlay clamp below for the
    // semantic-uplift path.
    tags: constrainTagsToSettings(
      assignMetaStoryTags({ metaStory, sourceItems, settings }),
      settings
    ),
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
        // D2 write-boundary guard: map any ingestion kind ("rss") to a valid
        // contract kind ("traditional" | "social") so a persisted snapshot can
        // never fail `dashboardPayloadSchema` on read, even if upstream
        // ingestion regresses. Shares the D1 mapper.
        kind: mapIngestionKindToContractKind(item.kind),
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
  // E2E determinism: when true, the watermark short-circuit is bypassed for this
  // run so the full clustering/grounding pipeline always executes (no skip even
  // on an unchanged watermark). Additive — default false leaves the optimization
  // untouched. The caller (server) decides when this applies (first load after
  // reset for the recognized E2E user); the pipeline only honors the flag.
  forceFullRefresh = false,
  beatFitEnabled = true,
  embedFn = null,
  recallConfig = null,
  // Geo admission mode override (tests only). Production falls through to
  // `resolveGeoAdmissionMode()` which reads `TEMPO_GEO_ADMISSION_MODE` (default
  // "soft"). Mirrors the `recallConfig` seam.
  geoAdmissionMode: geoAdmissionModeOverride = null,
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
  // Phase 4.1 — election same-event cross-cluster bundle merge config. When
  // omitted, `resolveElectionBundleConfig()` reads env (default ENABLED). Tests
  // inject an override (e.g. `{ enabled: false }` or a custom threshold) to
  // exercise the merge without env mutation, mirroring `clusterSplitConfig`.
  electionBundleConfig = null,
  // Slice 4 — latency-shaping profile for this run.  `"interactive"` activates
  // the onboarding fast-path (bounded geo Lane-2 budget + tighter clustering
  // envelope); null / anything else keeps the default scheduled/background
  // behavior.  The route passes `"interactive"` only for onboarding-driven
  // interactive entries; the heartbeat and bootstrap paths leave it null.
  refreshProfile = null,
  // A5 test seam: shallow-merge overrides onto the resolved refresh profile so
  // tests can pin profile-driven knobs (e.g. the cold-start translation cap
  // `translationMaxItems`) to small, deterministic values without depending on
  // the locked production constants.  Null in production — the resolved profile
  // is used verbatim.  Additive: it never changes which profile is selected.
  refreshProfileOverrides = null,
  // Slice 5 — progressive whyItMatters enrichment.  When true, the per-story
  // implications WRITER is skipped at first paint: every published story gets
  // the deterministic, state-aware safe fallback copy (non-empty, never a
  // subtitle echo) so the interactive response paints immediately, and the
  // server runs an async enrichment pass that upgrades the copy in place.
  // Trust is unchanged — no fabricated stories, only `whyItMatters` is
  // progressively enriched; clustering fail-closed continuity is untouched.
  deferWhyItMatters = false,
  // X ingestion (Phase 1, Step 1.5): when true, user-selected social handles
  // are admitted at source selection as an additive UNION alongside manifest
  // matching, so `kind:"social"` items survive to relevance/clustering. The
  // server passes `xConfig.enabled` here; default false keeps the social path
  // inert (no behavior change for RSS-only / X-disabled runs).
  socialIngestionEnabled = false,
}) {
  const profile =
    refreshProfileOverrides && typeof refreshProfileOverrides === "object"
      ? { ...resolveRefreshProfile(refreshProfile), ...refreshProfileOverrides }
      : resolveRefreshProfile(refreshProfile);
  const effectiveRecallConfig = recallConfig ?? resolveRecallConfig();
  // Geo admission mode, resolved once per run.
  const resolvedGeoAdmissionMode = resolveGeoAdmissionMode({
    override: geoAdmissionModeOverride,
  });
  const { geoAdmissionMode, geoAdmissionBypassed } = geoAdmissionDiagnostics(
    resolvedGeoAdmissionMode
  );
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
    // Additive social selection (X ingestion): user-selected X handles are not
    // manifest feeds, so `resolveSelectedSources` can't match them.  When X
    // ingestion is enabled for this run AND the user selected ≥1 social source,
    // admit `kind:"social"` items whose outlet matches a selected handle — a
    // true UNION with the manifest match.  Inert when X is disabled or the user
    // has no social sources (set stays empty → no items admitted via this path).
    const socialSelectionApplied =
      socialIngestionEnabled && (settings.socialSources ?? []).length > 0;
    const selectedSocialHandles = socialSelectionApplied
      ? buildSelectedSocialHandleSet(settings.socialSources)
      : new Set();

    const matchedKeys = {
      feedIds: buildMatchedFeedIdSet(selection.matchedFeeds),
      outlets: buildMatchedOutletSet(selection.matchedFeeds),
      socialHandles: selectedSocialHandles,
    };
    recentItems = filterItemsToMatchedFeeds(recentNormalizedItems, matchedKeys);

    // Which selected social handles actually admitted ≥1 item this run — the
    // truthful "matched social" surface.  Empty when X degraded / no social
    // items arrived, so a selected handle is never falsely reported as matched.
    const matchedSocialSet = new Set();
    if (socialSelectionApplied) {
      for (const it of recentItems) {
        if (it?.kind !== "social") continue;
        const handle = normalizeSocialHandle(it.outlet);
        if (handle && selectedSocialHandles.has(handle)) matchedSocialSet.add(handle);
      }
    }
    const matchedSocialSources = [...matchedSocialSet];

    // The selected social handles are served via the social connector, NOT the
    // RSS manifest — so they must not be reported as "unmatched manifest
    // sources" (the original bug).  Drop them from the unmatched list when the
    // social path is active.  Traditional unmatched names are untouched.
    const unmatchedSelectedSources = socialSelectionApplied
      ? selection.unmatchedSelectedSources.filter(
          (name) => !selectedSocialHandles.has(normalizeSocialHandle(name))
        )
      : selection.unmatchedSelectedSources;

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
      unmatchedSelectedSources,
      unavailableConnectorCount: selection.unavailableConnectorCount,
      unavailableConnectorSources: selection.unavailableConnectorSources,
      matchedFeedIds: selection.matchedFeeds.map((f) => f.id),
      // Additive social-selection diagnostics (truthful — NOT folded into
      // matchedFeedIds, which stays manifest-only / synthetic-id-free).
      matchedSocialSourceCount: matchedSocialSources.length,
      matchedSocialSources,
      socialSelectionApplied,
    };
    // Low-noise diagnostic: counts always; the actual unmatched/unavailable
    // source NAMES only when non-zero, so a mismatch (e.g. the embassy
    // `matched=6/7`) names the culprit without grepping per-item logs. The
    // happy path (all matched) stays a single clean counts line.
    const unmatchedNames = unmatchedSelectedSources;
    const unavailableNames = selection.unavailableConnectorSources;
    console.log(
      `[pipeline.selection] mode=${selection.mode} fallback=${selection.fallbackUsed}${selection.fallbackReason ? ` reason=${selection.fallbackReason}` : ""} matched=${selection.matchedSourceCount}/${selection.selectedSourceCount} unmatched=${unmatchedNames.length} unavailable=${selection.unavailableConnectorCount} feeds=${selectionMeta.matchedFeedIds.length}` +
        ` socialApplied=${socialSelectionApplied} matchedSocial=${matchedSocialSources.length}` +
        (unmatchedNames.length > 0 ? ` unmatchedSources=${JSON.stringify(unmatchedNames)}` : "") +
        (unavailableNames.length > 0 ? ` unavailableSources=${JSON.stringify(unavailableNames)}` : "") +
        (matchedSocialSources.length > 0 ? ` matchedSocialSources=${JSON.stringify(matchedSocialSources)}` : "")
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
  // Deterministic explicit-geo hard-fail drop (relevance-policy). Runs at the
  // geo stage, before the lane split / embedding / clustering, and adds NO LLM
  // calls: `scoreGeoFit` flags an item only when it carries explicit
  // geographies, NONE overlap the configured set, AND its text names (or
  // demonyms) none of them — an unambiguous off-geography signal. Soft geo
  // admission stopped *gating* relevance, but dropping a confident explicit
  // conflict here is a pure-precision win (keeps clearly-foreign stories out of
  // the cluster pool). Gated on a configured geo set so geo-agnostic profiles
  // are untouched; ambiguous/implicit items never hard-fail.
  const geoHardFailDropped = [];
  const geoAdmissibleItems =
    configuredGeos.length === 0
      ? candidateItems
      : candidateItems.filter((item) => {
          if (scoreGeoFit(item, settings).hardFail) {
            geoHardFailDropped.push(item);
            return false;
          }
          return true;
        });
  if (geoHardFailDropped.length > 0) {
    console.log(
      `[pipeline.geo] explicit-conflict hard-fail dropped ${geoHardFailDropped.length} item(s) ` +
        `before embedding/clustering (deterministic, no LLM)`
    );
  }
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
  for (const item of geoAdmissibleItems) {
    if (selectedSourceIds.has(item.sourceId) && hasGeoSignal(item)) lane1Items.push(item);
    else lane2Items.push(item);
  }
  // A1.1 (recall protection): the set of must-see sourceIds, used after the
  // recall gate to union Lane 1 survivors that topic/keyword recall would
  // otherwise drop (an explicit-geo item whose *text* never names the geo).
  // Used in BOTH modes — under soft, geo signal still *widens recall* here; it
  // simply no longer gates admission.
  const lane1SourceIds = new Set(lane1Items.map((i) => i.sourceId));

  // A1.2: request-scoped geo diagnostics — created per run and threaded into
  // `applyGeoFilter`, so 429/retry counts can't bleed across overlapping
  // refreshes the way the old global-snapshot delta could. Under soft the
  // assessor never runs, so these stay at their zero-init values.
  const geoDiag = createGeoDiagnostics();
  const geoStartedAt = Date.now();

  // ── Geo admission ───────────────────────────────────────────────────────────
  //
  //   SOFT (active default, TEMPO_GEO_ADMISSION_MODE unset/soft): geography is
  //   NOT an admission control. Admit every candidate — no assessor call, no
  //   Lane 2 defer, no hold-bucket write. Downstream stages (translation,
  //   recall, beat-fit, dedupe, clustering caps) decide relevance. The lane
  //   split above is kept only for `lane1SourceIds` recall protection and the
  //   informational lane counts, so the held/deferred/assessed counters are 0.
  //
  //   HARD (rollback-only, TEMPO_GEO_ADMISSION_MODE=hard): the legacy lane
  //   funnel, isolated in `runHardGeoAdmissionGate`. See that helper's
  //   @deprecated note — it exists solely for rollback and is a removal
  //   candidate once the soft default has been stable.
  let geoPassedItems;
  let geoHeldItems;
  let geoLane2DeferredItems;
  let geoBudgetHit;
  let geoLane2DeferredReason;
  if (geoAdmissionBypassed) {
    // SOFT — admit the full candidate set (minus the deterministic explicit-
    // conflict hard-fails already removed above); geo otherwise gates nothing.
    geoPassedItems = [...geoAdmissibleItems];
    geoHeldItems = [];
    geoLane2DeferredItems = [];
    geoBudgetHit = false;
    geoLane2DeferredReason = null;
  } else {
    // HARD (rollback) — greppable marker so operators can audit rollback usage
    // before this path is removed (see telemetry note on the helper).
    console.log(
      "[pipeline.geo] hard admission gate ACTIVE (rollback path; TEMPO_GEO_ADMISSION_MODE=hard)"
    );
    // Slice 6: reorder Lane 2 so the most-likely-relevant + cheapest-to-admit
    // candidates are assessed first under budget pressure; the deferred tail is
    // the least promising items. Hard-path only — `relevantSignalIds` reuses the
    // lane-split memo (memo hits, no recomputation).
    const lane2RelevantSignalIds = new Set(
      lane2Items.filter((item) => hasGeoSignal(item)).map((item) => item.sourceId)
    );
    const lane2Ordered = prioritizeLane2Candidates(lane2Items, {
      selectedSourceIds,
      relevantSignalIds: lane2RelevantSignalIds,
    });
    ({
      geoPassedItems,
      geoHeldItems,
      geoLane2DeferredItems,
      geoBudgetHit,
      geoLane2DeferredReason,
    } = await runHardGeoAdmissionGate({
      lane1Items,
      lane2Ordered,
      configuredGeos,
      geoAssessFn,
      geoDiag,
      geoStartedAt,
      budgetMs: effectiveGeoBudgetMs,
      deferLane2: profile.deferGeoLane2,
    }));
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
  //  In soft mode the assessor never runs, so this is unconditionally 0 (the
  //  filter would also yield 0 since admitted items carry no geo annotations,
  //  but we short-circuit to make the bypass explicit).
  const geoAssessedCount = geoAdmissionBypassed
    ? 0
    : [...geoPassedItems, ...geoHeldItems].filter(
        (i) =>
          !i.geoLexicalBypass &&
          (i.geoCategory === GEO_CATEGORY.EXPLICIT_CONFLICT ||
            i.geoCategory === GEO_CATEGORY.IMPLICIT_GEO)
      ).length;

  // A1.1 — per-refresh geo diagnostics, surfaced in `_meta`/logs on both the
  // normal and watermark-skip return paths so lane/budget behavior is auditable
  // without re-deriving it. Retains the A1 rate-limit/retry counters.
  const geoDiagnostics = {
    // Geo admission mode + runtime-bypass flag. These travel on `log.geo` and
    // `log.outcomes` → `_meta.outcomes` for both the full-run and watermark-skip
    // paths. On a full run `geoAdmissionBypassed` reflects what actually
    // happened this run: true means the gate was bypassed (soft — all
    // candidates admitted, nothing deferred/held/assessed), false means the
    // hard lane funnel ran.
    geoAdmissionMode,
    geoAdmissionBypassed,
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
    // relevance-policy: deterministic explicit-conflict drops removed before the
    // lane split (no LLM). Distinct from `geoHeldCount` (assessor hold bucket).
    geoHardFailDroppedCount: geoHardFailDropped.length,
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
  //
  // TODO(geo-soft-cleanup): the hold bucket is a HARD-mode (rollback-only)
  // artifact. Under the soft default both arrays are empty, so this writes `[]`
  // — which intentionally CLEARS any bucket left by a prior hard run (drains the
  // backlog; tests assert the empty-write). Once the hard path is removed after
  // the soft-default stability window, this write, `readHeldFn`/`writeHeldFn`,
  // and the hold-bucket repo become removable. Keep faithful until then.
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
  // Surface the admission mode + actual runtime bypass for this run. In soft,
  // assess/defer/held counters are zero and every candidate was admitted (lane
  // counts still report composition); in hard the lane funnel ran as reported.
  console.log(
    `[pipeline.geo] admission_mode=${geoAdmissionMode} bypassed=${geoAdmissionBypassed}`
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
  const nonEnglishPresent = (geoPassedItems ?? []).some(isNonEnglishItem);
  const VALID_MODES = new Set([TRANSLATION_MODE.AUTO, TRANSLATION_MODE.ON, TRANSLATION_MODE.OFF]);
  let translationMode;
  const injectedMode = effectiveTranslationConfig?.mode;
  if (typeof injectedMode === "string") {
    const normalized = injectedMode.trim().toLowerCase();
    translationMode = VALID_MODES.has(normalized) ? normalized : TRANSLATION_MODE.AUTO;
  } else if (typeof effectiveTranslationConfig?.enabled === "boolean") {
    translationMode = effectiveTranslationConfig.enabled ? TRANSLATION_MODE.ON : TRANSLATION_MODE.OFF;
  } else {
    translationMode = resolveTranslationMode();
  }
  const translationMockOnly =
    String(process.env.TEMPO_AI_MOCK_ONLY ?? "").trim().toLowerCase() === "true";
  const translationHasApiKey = Boolean(
    process.env.TEMPO_OPENAI_API_KEY || process.env.OPENAI_API_KEY
  );
  const translationActivation = computeTranslationActivation({
    mode: translationMode,
    nonEnglishPresent,
    hasTranslateFn: typeof translateFn === "function",
    mockOnly: translationMockOnly,
    hasApiKey: translationHasApiKey,
  });
  const translationShouldRun = translationActivation.shouldRun;

  // A5: cold-start translation candidate cap.  On a cold_start refresh the
  // profile carries a locked translation budget (`translationMaxItems` /
  // `translationMaxMs`).  When the stage will actually run, we translate only
  // the TOP-N non-English items by pre-cluster survival priority
  // (`rankItemsForTranslation`) instead of the whole post-geo pool — English
  // items never consume a cap slot, and the lowest-priority non-English items
  // are deferred this run.  The cap is applied ONLY for cold_start with a finite
  // `translationMaxItems` AND only when translation is active; every other
  // profile keeps the unchanged full-pool behavior.  Wall-clock (`translationMaxMs`)
  // is carried through diagnostics here but NOT yet enforced — that lands in A6.
  const coldStartTranslationCap =
    profile?.name === "cold_start" && Number.isFinite(profile?.translationMaxItems)
      ? {
          maxItems: profile.translationMaxItems,
          maxMs: Number.isFinite(profile?.translationMaxMs) ? profile.translationMaxMs : null,
        }
      : null;
  const translationCapApplied = Boolean(coldStartTranslationCap) && translationShouldRun;

  // Default (uncapped) path translates the full candidate set.  Capped path
  // narrows the translator input to the selected non-English subset.
  let translationInputItems = geoPassedItems;
  if (translationCapApplied) {
    const ranked = rankItemsForTranslation(geoPassedItems, settings);
    // Only non-English needed items consume the budget; English items pass
    // through untranslated regardless (stamped during merge-back below).
    translationInputItems = ranked
      .filter(isNonEnglishItem)
      .slice(0, coldStartTranslationCap.maxItems);
  }

  // A6: when the cold-start cap is active, hand the profile's translation
  // wall-clock budget (`translationMaxMs`) to the translator so it stops
  // scheduling new calls once the stage budget is spent (in-flight calls still
  // complete; deferred items fail open). Non-cold_start config is unchanged.
  const translationCallConfig = { ...effectiveTranslationConfig, enabled: translationShouldRun };
  if (translationCapApplied && coldStartTranslationCap.maxMs != null) {
    translationCallConfig.maxWallClockMs = coldStartTranslationCap.maxMs;
  }
  const translationStartedAt = Date.now();
  const { items: translatedInputItems, diagnostics: rawTranslationDiagnostics } =
    await translateEvidenceItems({
      items: translationInputItems,
      translateFn,
      config: translationCallConfig,
      cache: translationCache ?? undefined,
    });
  const translationMs = Math.max(0, Date.now() - translationStartedAt);

  // Merge the (possibly capped) translator output back into the FULL post-geo
  // list in original order.  In the uncapped path the translator already saw
  // every item, so its output IS the full list.  In the capped path we splice
  // the translated subset back in and stamp the two un-translated buckets so
  // every item carries a uniform `_translation` for downstream coverage math:
  //   - capped-out non-English → reason "cold_start_cap" (needed, not applied)
  //   - English / non-needed   → normal passthrough stamp (needed:false)
  let translatedGeoItems;
  let cappedOutCount = 0;
  if (translationCapApplied) {
    const translatedById = new Map(
      translatedInputItems.map((it) => [it.sourceId, it])
    );
    translatedGeoItems = geoPassedItems.map((item) => {
      const translated = translatedById.get(item.sourceId);
      if (translated) return translated; // selected subset → translator result
      const lang = typeof item?.lang === "string" ? item.lang : null;
      if (isNonEnglishItem(item)) {
        // Deferred this run by the cold-start cap (recall still sees the
        // original text; fail-open posture is unchanged, just untranslated).
        cappedOutCount += 1;
        return {
          ...item,
          _translation: {
            needed: true,
            applied: false,
            failed: false,
            fromCache: false,
            reason: "cold_start_cap",
            lang,
          },
        };
      }
      // English / non-needed item — same stamp `translateEvidenceItems` gives a
      // non-needed passthrough, so coverage math is identical to the full path.
      return {
        ...item,
        _translation: {
          needed: false,
          applied: false,
          failed: false,
          fromCache: false,
          reason: null,
          lang,
        },
      };
    });
  } else {
    translatedGeoItems = translatedInputItems;
  }

  const translationStageDiagnostics = {
    ...rawTranslationDiagnostics,
    mode: translationActivation.mode,
    required: translationActivation.required,
    unavailable: translationActivation.unavailable,
    unavailableReason: translationActivation.unavailableReason,
    recallRisk: translationActivation.recallRisk,
    // A5: cold-start translation cap diagnostics (additive; all inert off the
    // cold_start path so existing consumers are unaffected).  `capMaxMs` is
    // reported for observability but not enforced until A6.
    capped: translationCapApplied,
    capReason: translationCapApplied ? "cold_start_profile" : null,
    capMaxItems: translationCapApplied ? coldStartTranslationCap.maxItems : null,
    capMaxMs: translationCapApplied ? coldStartTranslationCap.maxMs : null,
    cappedOutCount,
  };
  console.log(
    `[pipeline.translation] cap_applied=${translationCapApplied}` +
      ` cap_reason=${translationStageDiagnostics.capReason ?? "none"}` +
      ` cap_max_items=${translationStageDiagnostics.capMaxItems ?? "none"}` +
      ` cap_max_ms=${translationStageDiagnostics.capMaxMs ?? "none"}` +
      ` capped_out=${cappedOutCount}`
  );
  console.log(
    `[pipeline.translation] mode=${translationActivation.mode}` +
      ` required=${translationActivation.required}` +
      ` unavailable=${translationActivation.unavailable}` +
      ` reason=${translationActivation.unavailableReason ?? "none"}` +
      ` recall_risk=${translationActivation.recallRisk}`
  );
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
      ` keywordViaTranslated=${topicKeywordBreakdown.keywordViaTranslatedCount}` +
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
  // Slice 3 (cold_start): prefer the active profile's `clusterInputCap` when it
  // is a finite integer > 0, else fall back to the global CLUSTER_INPUT_CAP.
  // cold_start tightens this to 10; all other profiles leave it unset and keep
  // the default 15.
  const clusterInputCapEffective =
    Number.isInteger(profile.clusterInputCap) && profile.clusterInputCap > 0
      ? profile.clusterInputCap
      : CLUSTER_INPUT_CAP;
  const clusterCapResult = applyClusterInputCap(dedupedItems, settings, clusterInputCapEffective);
  const clusterInputItems = clusterCapResult.clusterInputItems;
  // Additive: surface the cap actually used this run so profile-on (cold_start
  // 10) vs baseline (15) is auditable from `_meta.clusterCap` without re-deriving.
  const clusterCapDiagnostics = {
    ...clusterCapResult.diagnostics,
    clusterInputCapEffective,
  };
  if (clusterCapDiagnostics.clusterDroppedCount > 0) {
    console.log(
      `[pipeline.cluster-cap] deduped=${clusterCapDiagnostics.dedupedCount} ` +
        `clusterInput=${clusterCapDiagnostics.clusterInputCount} ` +
        `dropped=${clusterCapDiagnostics.clusterDroppedCount} ` +
        `cap=${clusterInputCapEffective}`
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
  // E2E override: forcing a full refresh suppresses the short-circuit on this run
  // regardless of watermark match, so the full pipeline always executes.
  const watermarkBypassedForE2e = Boolean(forceFullRefresh) && watermarkMatched;
  const watermarkSuppressed =
    watermarkMatched && (watermarkBypassedForE2e || (priorWasEmpty && dedupedItems.length > 0));
  if (watermarkBypassedForE2e) {
    console.log(
      `[pipeline.watermark] match bypassed (${watermarkInfo.watermark}) — forceFullRefresh (E2E) requested; running full pipeline`
    );
  } else if (watermarkSuppressed) {
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
        // E2E shape parity: on the skip path the override was not applied (a
        // requested forceFullRefresh would have bypassed this branch entirely).
        e2e: {
          forceFirstFullRefreshApplied: Boolean(forceFullRefresh),
          watermarkBypassed: false,
        },
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
        // Prompt 1: no terminal failure on a skip → subtype is null too. Keeps
        // the `_meta` shape consistent across full-run and skip paths.
        clusteringFailureSubtype: null,
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
          // PR B Step 2: clustering wall-clock envelope cap (cold_start only;
          // null elsewhere). Clustering never ran on a skip, so this is the
          // configured value, not a measured one.
          clusterTotalBudgetMs: profile.clusterTotalBudgetMs ?? null,
        },
        // Slice 3: outcome rollup on the short-circuit branch too, so the
        // summary/SLO surfaces have a consistent shape across both paths.
        // Geo + beat-fit ran before the watermark decision; clustering did not.
        outcomes: {
          storiesPublished: 0,
          clusteringAttempts: 0,
          clusteringFailureReason: null,
          // Prompt 1: subtype null on the skip path, mirroring the full-run rollup.
          clusteringFailureSubtype: null,
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
  // Step 4.1: effective (deadline-aware) clustering envelope for this run. Stays
  // null on profiles without a configured envelope (default/interactive) and on
  // the empty-input branch; set inside the clustering branch below so the
  // `[pipeline.profile]` log can surface the value clustering actually ran with.
  let effectiveClusterTotalBudgetMs = null;
  let rawMetaStories;
  let usedFallbackClustering = false;
  let clusteringFailureReason = null; // 'timeout' | 'error' | null
  // Prompt 1: stable, additive sub-classification of a terminal clustering
  // failure (see CLUSTERING_FAILURE_SUBTYPE). Splits the coarse `error` bucket
  // into parse / provider_request / unknown (and timeout_budget for the timeout
  // reason) for incident triage. Null whenever there is no terminal failure
  // (success, recovered run, or clustering never ran). `clusteringFailureReason`
  // is derived FROM this subtype so the two never drift.
  let clusteringFailureSubtype = null;
  let clusteringAttempts = 0;
  const clusteringAttemptLatencyMs = [];
  // PR B Step 1 + A2: Option B auto-recovery tier diagnostics.  A bounded,
  // single extra clustering attempt on a reduced input set, triggered for ANY
  // terminal fail-closed clustering failure — both error-class (parse/schema)
  // AND timeout-class (A2) — whenever the candidate set can genuinely shrink.
  // All default to the "not attempted" state so the fields are additive and
  // stable.
  let clusteringRecoveryAttempted = false;
  let clusteringRecoverySucceeded = false;
  let clusteringRecoveryReason = null; // recovery failure class ('error'|'timeout') or null
  // Prompt 1: subtype of the recovery attempt's OWN failure (mirrors
  // clusteringFailureSubtype). Null when recovery didn't run or succeeded.
  let clusteringRecoverySubtype = null;
  // B2: strict relevance-gated deterministic fallback diagnostics.  After both
  // the primary loop AND the Option B reduced-input recovery tier fail terminally
  // (i.e. `usedFallbackClustering` is still true here), we attempt a LAST-resort
  // DETERMINISTIC build — singleton meta-stories from the beat-fit survivors that
  // pass the strict topic+keyword relevance bar (`relevance-gated-fallback.mjs`).
  // This NEVER calls `gracefulFallbackClustering` and never weakens trust: an
  // item that fails the strict gate produces no story, so when nothing is
  // eligible the run stays fail-closed (0 stories) exactly as before.
  //   - `usedDeterministicClustering` — true ONLY when the deterministic builder
  //     published ≥1 story (so the run shipped real, relevance-gated content
  //     despite the LLM failing).
  //   - `clusteringLlmFailed` — true whenever the LLM clustering path terminally
  //     failed and the deterministic builder ran, REGARDLESS of whether it
  //     published. Honest attribution that the LLM did not produce these stories;
  //     `clusteringFailureReason`/`…Subtype` are retained for root-cause triage.
  //   - `deterministicClusteringDiagnostics` — the B1 builder's diagnostics
  //     (`inputCount`/`eligibleCount`/`outputCount`/`excludedReasons`).
  let usedDeterministicClustering = false;
  let clusteringLlmFailed = false;
  let deterministicClusteringDiagnostics = null;
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
    // Step 4.1: clamp the configured clustering envelope to the wall-clock that
    // remains until the pipeline-relative soft deadline (cold_start only — other
    // profiles have no configured budget, so this returns null and nothing
    // changes).  Fast upstream → unchanged 60s envelope; slow upstream → trimmed
    // so clustering aims to finish by the deadline, floored so it keeps a real
    // shot (fail-closed / recovery untouched).
    effectiveClusterTotalBudgetMs = resolveClusterEnvelopeBudgetMs({
      totalBudgetMs: profile.clusterTotalBudgetMs ?? null,
      pipelineElapsedMs: clusterStartedAt - pipelineStartedAt,
      deadlineMs: profile.clusterTotalBudgetMs != null ? COLD_START_CLUSTER_DEADLINE_MS : null,
      minEnvelopeMs: COLD_START_CLUSTER_MIN_ENVELOPE_MS,
    });
    // PR B Step 2: build each clustering call's `opts` at call time so a
    // total-budget profile (cold_start) can clamp the retry's timeout to the
    // wall-clock the earlier attempt(s) left behind.  Profiles WITHOUT a total
    // budget (default/interactive) ignore `elapsedMs` entirely and reproduce
    // the previous flat per-attempt behavior exactly (`{}` or
    // `{ timeoutMs: <perAttempt> }`).  Step 4.1: the budget passed here is the
    // deadline-aware EFFECTIVE envelope, not the raw configured one.
    const clusterCallOpts = () => {
      const t = resolveClusterCallTimeoutMs({
        perAttemptTimeoutMs: profile.clusterTimeoutMs,
        totalBudgetMs: effectiveClusterTotalBudgetMs,
        elapsedMs: Date.now() - clusterStartedAt,
      });
      return t != null ? { timeoutMs: t } : {};
    };
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_CLUSTER_ATTEMPTS; attempt++) {
      clusteringAttempts = attempt;
      const attemptStartedAt = Date.now();
      try {
        rawMetaStories = await clusterFn(clusterInputItems, settings, clusterModel, clusterCallOpts());
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
      // Prompt 1: classify the terminal failure into a stable subtype, then
      // DERIVE the coarse legacy reason from it so the two stay in lockstep
      // (`clusteringReasonFromSubtype` is the single source of that mapping —
      // timeout_budget → "timeout", every other subtype → "error").
      clusteringFailureSubtype = classifyClusteringFailureSubtype(lastErr);
      clusteringFailureReason = clusteringReasonFromSubtype(clusteringFailureSubtype);
      rawMetaStories = [];
      usedFallbackClustering = true;
      console.warn(
        `[pipeline] clustering FAILED after ${clusteringAttempts} attempt(s) (reason=${clusteringFailureReason} subtype=${clusteringFailureSubtype}) — publishing 0 meta-stories (fail-closed)`
      );
    }

    // PR B Step 1 + A2: Option B auto-recovery tier.  A terminal clustering
    // failure is frequently transient and input-size sensitive — ONE bounded
    // retry on a reduced (top-half) candidate set can recover real stories
    // without weakening fail-closed trust.  A2 widens the trigger from
    // error-class only to BOTH terminal reasons: error-class (parse/schema,
    // where a smaller set is more likely to parse cleanly) AND timeout-class
    // (where a smaller candidate set is a lighter, faster round-trip that can
    // beat the budget the full set blew).  The retry stays Sonnet-only and
    // reuses the same `clusterCallOpts()` timeout budgeting as the primary loop,
    // so a total-budget profile still bounds it to the wall-clock left behind.
    // On recovery success we publish the recovered meta-stories through the
    // normal grounding/build path and clear the fail-closed flags; on recovery
    // failure the existing fail-closed outcome (0 meta-stories) is preserved
    // untouched.  No `gracefulFallbackClustering` buckets are ever produced —
    // the trust posture is unchanged.
    const RECOVERY_MIN_ITEMS = 6;
    const recoveryCap = Math.max(
      RECOVERY_MIN_ITEMS,
      Math.floor(clusterInputItems.length / 2)
    );
    const recoveryInput = clusterInputItems.slice(0, recoveryCap);
    // Recovery only runs when the reduced cap genuinely SHRINKS the input — its
    // mechanism is "fewer items parse cleanly / complete within budget".  When
    // the candidate set is already at/below the floor there is nothing to
    // reduce, so we keep the existing fail-closed outcome rather than burn an
    // identical extra call (true for both error- and timeout-class failures).
    if (
      usedFallbackClustering &&
      // A2: recover for BOTH terminal reasons — error-class (parse/schema) and
      // timeout-class.  `usedFallbackClustering` already implies a non-null
      // terminal reason; the explicit check documents the eligible set.
      (clusteringFailureReason === "error" || clusteringFailureReason === "timeout") &&
      recoveryInput.length < clusterInputItems.length
    ) {
      clusteringRecoveryAttempted = true;
      clusteringAttempts += 1;
      const recoveryStartedAt = Date.now();
      try {
        rawMetaStories = await clusterFn(recoveryInput, settings, clusterModel, clusterCallOpts());
        clusteringAttemptLatencyMs.push(Date.now() - recoveryStartedAt);
        clusteringRepair = readClusteringRepairDiagnostics(rawMetaStories);
        // Recovered: publish recovered stories normally and clear the
        // fail-closed flags the primary loop set.
        clusteringRecoverySucceeded = true;
        usedFallbackClustering = false;
        clusteringFailureReason = null;
        // Recovered run is NOT a terminal failure — clear the subtype too.
        clusteringFailureSubtype = null;
        console.warn(
          `[pipeline] clustering RECOVERED on reduced input (${recoveryInput.length} of ${clusterInputItems.length} items) — publishing recovered meta-stories`
        );
      } catch (recoveryErr) {
        clusteringAttemptLatencyMs.push(Date.now() - recoveryStartedAt);
        // Keep the last attempt's repair diagnostics for `_meta`.
        clusteringRepair = readClusteringRepairDiagnostics(recoveryErr);
        // Prompt 1: classify the recovery attempt's own failure and derive its
        // legacy reason from the subtype via the same shared mapping as the
        // primary loop. The terminal `clusteringFailureSubtype` (set by the
        // primary loop) is left untouched — the recovery subtype is reported
        // separately.
        clusteringRecoverySubtype = classifyClusteringFailureSubtype(recoveryErr);
        clusteringRecoveryReason = clusteringReasonFromSubtype(clusteringRecoverySubtype);
        // Preserve the fail-closed outcome set above (0 meta-stories).
        rawMetaStories = [];
        console.warn(
          `[pipeline] clustering recovery FAILED (reason=${clusteringRecoveryReason} subtype=${clusteringRecoverySubtype}) — remaining fail-closed (0 meta-stories)`
        );
      }
    }

    // B2: strict relevance-gated deterministic fallback (LAST resort).  If the
    // primary loop AND the Option B recovery tier both failed terminally
    // (`usedFallbackClustering` still true), build SINGLETON meta-stories from
    // the beat-fit survivors that clear the strict topic+keyword relevance bar.
    // This is the trigger Plan Step B2 specifies: terminal LLM failure with no
    // recovered LLM stories.  It runs over `clusterInputItems` — the exact
    // beat-fit-survivor candidate set the LLM saw — and never touches
    // `gracefulFallbackClustering`, so trust posture is unchanged.  When nothing
    // is eligible the run stays fail-closed (0 stories) exactly as before; the
    // LLM-failure reason/subtype are preserved for attribution either way.
    if (usedFallbackClustering) {
      clusteringLlmFailed = true;
      const deterministicFallback = buildRelevanceGatedFallbackStories({
        items: clusterInputItems,
        settings,
        maxStories: 5,
        maxSourcesPerStory: 1,
      });
      deterministicClusteringDiagnostics = deterministicFallback.diagnostics;
      if (deterministicFallback.stories.length > 0) {
        rawMetaStories = deterministicFallback.stories;
        usedDeterministicClustering = true;
        // We published real, relevance-gated stories — the run is no longer the
        // "fail-closed published 0" case `usedFallbackClustering` denotes, so
        // clear ONLY that flag.  `clusteringFailureReason`/`…Subtype` and the
        // explicit `clusteringLlmFailed` flag are RETAINED for attribution (we
        // do not pretend the LLM succeeded), and the snapshot-preservation guard
        // (which also requires zero published stories) correctly does not fire.
        usedFallbackClustering = false;
        console.warn(
          `[pipeline] deterministic relevance-gated fallback PUBLISHED ${deterministicFallback.stories.length} story(ies)` +
            ` (eligible=${deterministicClusteringDiagnostics.eligibleCount}/${deterministicClusteringDiagnostics.inputCount}` +
            ` output=${deterministicClusteringDiagnostics.outputCount})` +
            ` — LLM clustering failed (reason=${clusteringFailureReason} subtype=${clusteringFailureSubtype})`
        );
      } else {
        // Nothing cleared the strict gate — preserve the fail-closed outcome
        // (0 meta-stories) untouched; the diagnostics record the empty result.
        console.warn(
          `[pipeline] deterministic relevance-gated fallback found 0 eligible stories` +
            ` (input=${deterministicClusteringDiagnostics.inputCount}) — remaining fail-closed (0 meta-stories)` +
            ` — LLM clustering failed (reason=${clusteringFailureReason} subtype=${clusteringFailureSubtype})`
        );
      }
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
  console.log(
    `[pipeline.cluster-split] enabled=${clusterSplitDiagnostics.enabled}` +
      ` input=${clusterSplitDiagnostics.inputCount}` +
      ` output=${clusterSplitDiagnostics.outputCount}` +
      ` splits=${clusterSplitDiagnostics.splitCount}` +
      ` low_overlap=${clusterSplitDiagnostics.splitReasons?.low_token_overlap ?? 0}` +
      ` disjoint=${clusterSplitDiagnostics.splitReasons?.disjoint_claim_evidence ?? 0}` +
      ` bundled=${clusterSplitDiagnostics.bundledStoryCount ?? 0}` +
      ` deferred=${clusterSplitDiagnostics.deferredCount ?? 0}` +
      ` recluster_candidates=${(clusterSplitDiagnostics.reclusterCandidateIds ?? []).length}`
  );

  // 6c. Phase 4.1 — election same-event bundle merge: the split healer only
  //     splits WITHIN a cluster, so same-event election coverage that clustering
  //     emitted as SEPARATE meta-stories (bilingual/wording variants, weak entity
  //     overlap) stays fragmented. This deterministic pass reunifies only
  //     genuinely-same-event configured-geo election stories (both election-cycle,
  //     both name a configured geography, high specific-token overlap) — it can't
  //     merge cross-country/wrong-beat/different-facet stories. Runs over the same
  //     `sourceItemsById` universe, before ID lineage so a bundle gets a fresh
  //     evidence-derived id. `TEMPO_ELECTION_BUNDLE_ENABLED=false` is the rollback.
  const effectiveElectionBundleConfig = electionBundleConfig ?? resolveElectionBundleConfig();
  const electionBundleResult = mergeElectionEventBundles(
    rawMetaStories,
    sourceItemsById,
    settings,
    effectiveElectionBundleConfig
  );
  rawMetaStories = electionBundleResult.stories;
  const electionBundleDiagnostics = electionBundleResult.diagnostics;
  console.log(
    `[pipeline.election-bundle] enabled=${electionBundleDiagnostics.enabled}` +
      ` input=${electionBundleDiagnostics.inputCount}` +
      ` output=${electionBundleDiagnostics.outputCount}` +
      ` merged_groups=${electionBundleDiagnostics.mergedGroupCount}` +
      ` absorbed=${electionBundleDiagnostics.mergedStoryCount}` +
      ` threshold=${electionBundleDiagnostics.threshold}`
  );

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
    // `sourceCount` (overflow rank input) is the meta-story's full source set;
    // grounded stories have all ids resolved, so this matches the published
    // `sources.length`.
    const sourceCount = Array.isArray(ms.source_item_ids) ? ms.source_item_ids.length : 0;
    // Q3A: relevance score over the grounded cluster output (tags +
    // `associated_entities`) + source-set stats. Drives overflow survival;
    // deterministic and LLM-free.
    const relevanceScore = computeRelevanceScore({
      story: ms,
      settings,
      sourceCount,
      maxBeatFitScore,
      minMinutesAgo,
    });
    return {
      story: buildStory(ms, sourceItems, settings),
      sortKey: {
        relevanceScore,
        // Retained for rejection-log observability (legacy coarse signal).
        topicKeywordMatchStrength: topicKeywordMatchStrength(ms),
        // Decision 8C / Phase 2 · Step 2.1: deterministic on-beat classification
        // (topic/keyword fit, geography excluded) consumed by the overflow
        // thin-on-beat guard so geo-only noise never backfills published slots.
        onBeat: isStoryOnBeat(ms, settings),
        maxBeatFitScore,
        minMinutesAgo,
        metaStoryId: ms.meta_story_id,
        sourceCount,
      },
    };
  });
  storiesWithSortKeys.sort((a, b) => compareStoriesR1(a.sortKey, b.sortKey));

  // A4: enforce the locked post-healer max-5 cap. Applied AFTER grounding (so it
  // trims only published survivors) and AFTER the R1 sort (so survivors keep
  // display order). Deterministic Q6-C survival ranking; additive diagnostics +
  // optional `overflow_cap` rejection-log entries for the dropped rows.
  const overflowCapResult = applyMetaStoryOverflowCap(storiesWithSortKeys);
  const overflowDiagnostics = overflowCapResult.diagnostics;
  const cappedEntries = overflowCapResult.kept;
  if (overflowDiagnostics.overflowCapApplied) {
    console.warn(
      `[pipeline.overflow-cap] post-healer cap — input=${overflowDiagnostics.overflowInputCount}` +
        ` output=${overflowDiagnostics.overflowOutputCount}` +
        ` dropped=${overflowDiagnostics.overflowDroppedCount}` +
        ` dropped_ids=[${overflowDiagnostics.overflowDroppedMetaStoryIds.join(",")}]`
    );
    if (writeRejectionsFn && overflowCapResult.dropped.length > 0) {
      const overflowRejections = overflowCapResult.dropped.map(({ story, sortKey }) => ({
        meta_story_id: sortKey?.metaStoryId ?? story?.metaStoryId ?? null,
        reason_code: "overflow_cap",
        source_item_ids: Array.isArray(story?.sources)
          ? story.sources.map((s) => s.id).filter(Boolean)
          : [],
        debug_payload: {
          title: story?.title ?? null,
          relevanceScore: Number.isFinite(sortKey?.relevanceScore) ? sortKey.relevanceScore : null,
          topicKeywordMatchStrength: sortKey?.topicKeywordMatchStrength ?? null,
          sourceCount: sortKey?.sourceCount ?? null,
          maxBeatFitScore: sortKey?.maxBeatFitScore ?? null,
          minMinutesAgo: Number.isFinite(sortKey?.minMinutesAgo) ? sortKey.minMinutesAgo : null,
        },
        watermark: watermarkInfo.watermark,
        created_at: rejectedAt,
      }));
      try {
        await writeRejectionsFn(overflowRejections);
      } catch (err) {
        console.warn(
          `[pipeline.overflow-cap] rejection-log write failed: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }

  // B1: build the deferred re-cluster queue from the A3 `_reclusterCandidate`
  // flags carried on the grounded meta-stories. Metadata ONLY — no executor runs
  // here, no snapshot is patched, and story selection/output is unchanged. The
  // ranked, ≤2 queue is surfaced additively on `_meta.reclusterQueue` for the
  // future B2 executor. Built from `groundedStories` (the full flagged set,
  // independent of the A4 presentation cap) so candidacy reflects cluster
  // quality, not whether the story landed in the shipped top-5.
  const reclusterQueueResult = buildReclusterQueue(groundedStories);
  if (reclusterQueueResult.reclusterQueueCount > 0) {
    console.log(
      `[pipeline.recluster-queue] candidates=${reclusterQueueResult.reclusterCandidateCount}` +
        ` queued=${reclusterQueueResult.reclusterQueueCount}` +
        ` ids=[${reclusterQueueResult.reclusterQueue.map((c) => c.metaStoryId).join(",")}]`
    );
  }

  // `let` (not const): D2 fail-closed-per-story may filter unrecoverable stories
  // out of this array after the narrative stages (see the `narrativeStability`
  // block below). Everything downstream (funnel, metaStoryCount, payload) then
  // reflects the published survivor set.
  let stories = cappedEntries.map(({ story }) => story);

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
    // (groundedStories) — the same map already used for `buildStory`. Iterate
    // the post-cap survivor set (A4) so dropped overflow rows are not enriched.
    for (let i = 0; i < cappedEntries.length; i++) {
      const ms = groundedStories.find(
        (m) => m.meta_story_id === cappedEntries[i].sortKey.metaStoryId
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
      //
      // Phase 1.1 write-boundary guard: re-clamp the overlaid tags to the
      // saved settings vocabulary so the semantic uplift path can never emit
      // an out-of-vocabulary axis value.  This holds regardless of whether
      // semantic uplift is on or off (off → deterministic tags pass through
      // unchanged; on → any uplifted value outside settings is dropped).
      stories[i].tags = constrainTagsToSettings(tags, settings);
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
      ` clusterTotalBudgetMs=${profile.clusterTotalBudgetMs ?? "none"}` +
      ` clusterEnvelopeMs=${effectiveClusterTotalBudgetMs ?? "none"}` +
      ` geoMs=${geoMs} clusterMs=${clusterMs} stories=${stories.length}`
  );
  const log = {
    // E2E determinism signal (surfaced on `_meta.e2e`). `forceFirstFullRefreshApplied`
    // = the caller requested a forced full refresh for this run; `watermarkBypassed`
    // = the watermark matched but the short-circuit was skipped because of that
    // override. Both false on normal (non-E2E) runs.
    e2e: {
      forceFirstFullRefreshApplied: Boolean(forceFullRefresh),
      watermarkBypassed: watermarkBypassedForE2e,
    },
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
    // null; `clusteringAttempts` counts initial-try + retries (and the single
    // PR B recovery attempt when the auto-recovery tier fires); latency is the
    // per-attempt array (same length) so an operator can see how long each
    // attempt ran before the timeout/error.
    clusteringFailureReason,
    // Prompt 1: stable sub-classification of the terminal failure splitting the
    // coarse `error`/`timeout` reason into parse | provider_request | unknown |
    // timeout_budget. Null when there is no terminal failure (success, recovered
    // run, watermark skip). Additive — `clusteringFailureReason` is unchanged and
    // is derived FROM this value, so existing consumers keep working.
    clusteringFailureSubtype,
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
    // PR B Step 1 + A2 — Option B auto-recovery tier diagnostics (additive).
    // `clusteringRecoveryAttempted` is true when a terminal primary failure —
    // error-class OR timeout-class (A2) — triggered the single reduced-input
    // recovery attempt; `…Succeeded` is true when that attempt published
    // recovered stories (in which case `usedFallbackClustering` is false and
    // `clusteringFailureReason` is null); `…Reason` is the recovery attempt's
    // own failure class ('error'|'timeout') when it failed, else null.  Recovery
    // only fires when the candidate set can genuinely shrink, so a failure at
    // the reduction floor (e.g. ≤6 items) leaves all three in the default state
    // regardless of the terminal reason.
    clusteringRecoveryAttempted,
    clusteringRecoverySucceeded,
    clusteringRecoveryReason,
    // Prompt 1: subtype of the recovery attempt's own failure (parse |
    // provider_request | unknown | timeout_budget), or null when recovery didn't
    // run or succeeded. Mirrors `clusteringFailureSubtype` for the recovery tier.
    clusteringRecoverySubtype,
    // B2 — strict relevance-gated deterministic fallback diagnostics (additive).
    // `usedDeterministicClustering` is true when the deterministic builder
    // published ≥1 singleton story after the LLM path (primary + recovery) failed
    // terminally — in which case `usedFallbackClustering` is false (stories WERE
    // published) while `clusteringLlmFailed` + `clusteringFailureReason`/`…Subtype`
    // remain set for attribution.  `clusteringLlmFailed` is true whenever the LLM
    // clustering path failed terminally and the deterministic builder ran
    // (regardless of whether it published), so an operator can split "LLM failed,
    // deterministic rescued it" from "LLM failed, nothing eligible → fail-closed".
    // `deterministicClusteringDiagnostics` carries the B1 builder's
    // `inputCount`/`eligibleCount`/`outputCount`/`excludedReasons` (null when the
    // deterministic builder never ran — i.e. clustering succeeded or recovered).
    usedDeterministicClustering,
    clusteringLlmFailed,
    deterministicClusteringDiagnostics,
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
      // PR B Step 2: the clustering wall-clock envelope cap that bounded this
      // run's 2-attempt loop (cold_start = 60000; null on every other profile,
      // i.e. no envelope cap). Additive — read alongside `clusterTimeoutMs`
      // (per-attempt) to reason about the worst-case clustering span.
      clusterTotalBudgetMs: profile.clusterTotalBudgetMs ?? null,
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
      // Prompt 1: subtype travels with the reason in the rollup so the SLO/summary
      // surface can split `error` without walking the full diagnostics tree.
      clusteringFailureSubtype,
      usedFallbackClustering,
      // B2: additive rollup signals so the SLO/summary surface can tell apart a
      // true terminal fail-closed (clusteringLlmFailed && !usedDeterministicClustering
      // && storiesPublished === 0) from an LLM-failed run rescued deterministically
      // (clusteringLlmFailed && usedDeterministicClustering && storiesPublished > 0).
      usedDeterministicClustering,
      clusteringLlmFailed,
      ...geoDiagnostics,
    },
    clusteringLatencyMs: clusteringAttemptLatencyMs,
    // Slice 2 — post-cluster split healer diagnostics. `enabled` reflects the
    // resolved config; `splitCount` / `splitReasons` show how many over-merged
    // clusters were split and why (low_token_overlap | disjoint_claim_evidence).
    // A3 adds (additive, non-breaking): `deferredCount` / `deferReasons` for
    // ambiguous clusters left intact and flagged for the Phase-2 deferred
    // re-cluster pass, `bundledStoryCount` for multi-source bundles a split kept
    // together instead of atomizing, and `reclusterCandidateIds` listing the
    // meta_story_ids that carry the `_reclusterCandidate` handoff flag.
    clusterSplit: {
      enabled: clusterSplitDiagnostics.enabled,
      inputCount: clusterSplitDiagnostics.inputCount,
      outputCount: clusterSplitDiagnostics.outputCount,
      splitCount: clusterSplitDiagnostics.splitCount,
      splitReasons: clusterSplitDiagnostics.splitReasons,
      deferredCount: clusterSplitDiagnostics.deferredCount ?? 0,
      deferReasons: clusterSplitDiagnostics.deferReasons ?? {},
      bundledStoryCount: clusterSplitDiagnostics.bundledStoryCount ?? 0,
      reclusterCandidateIds: clusterSplitDiagnostics.reclusterCandidateIds ?? [],
    },
    // Phase 4.1 — election same-event bundle merge diagnostics (additive,
    // bounded). `mergedGroupCount` = how many cross-cluster same-event election
    // bundles were formed this run; `mergedStoryCount` = input stories absorbed
    // into them; `mergedBundleIds` is a capped sample of the resulting ids.
    // All-zero on the common path (no fragmentation to reunify).
    electionBundle: {
      enabled: electionBundleDiagnostics.enabled,
      inputCount: electionBundleDiagnostics.inputCount,
      outputCount: electionBundleDiagnostics.outputCount,
      mergedGroupCount: electionBundleDiagnostics.mergedGroupCount,
      mergedStoryCount: electionBundleDiagnostics.mergedStoryCount,
      threshold: electionBundleDiagnostics.threshold,
      mergedBundleIds: electionBundleDiagnostics.mergedBundleIds,
    },
    // A4 — post-healer max-5 overflow cap. `overflowCapApplied` is false on the
    // common path (≤5 stories); when true, `overflowDropped*` records which
    // stories were trimmed by the deterministic Q6-C survival ranking.
    overflowCap: overflowDiagnostics,
    // B1 — deferred re-cluster queue (flagging + ranking only; NO executor runs
    // in this slice). `reclusterQueue` is the ranked, ≤2-item handoff list for
    // the future B2 executor; `reclusterQueueCount` / `reclusterCandidateCount`
    // expose queued-vs-total. Empty `[]` / 0 on the common path.
    reclusterQueue: reclusterQueueResult.reclusterQueue,
    reclusterQueueCount: reclusterQueueResult.reclusterQueueCount,
    reclusterCandidateCount: reclusterQueueResult.reclusterCandidateCount,
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
