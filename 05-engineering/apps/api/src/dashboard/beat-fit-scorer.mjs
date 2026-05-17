// Beat-fit scoring (Phase 1 relevance Stage 2).
//
// Stage 1 (selectSourcePool / 24h / geo / topic+keyword) is recall-oriented:
// it cuts the global pool down to plausibly-relevant items using OR semantics.
// Stage 2 (this module) is recall-first under the MVP posture (D-063): each
// candidate is scored on a 0..1 scale combining several signals, and only
// items at or above a low threshold (default 0.20) reach clustering. The
// posture is intentionally permissive so manual dashboard tests can validate
// that priority WaPo stories (Ukraine ~0.38, China ~0.22, Rwanda ~0.20)
// surface. Scope is still defined by configured geographies + sources.
// Threshold is env-tunable via `TEMPO_BEAT_FIT_THRESHOLD` for easy rollback
// to the previous 0.40 precision-first posture. Strict-empty: if no candidate
// clears, the pipeline returns an empty stories list rather than falling back
// to a weak top-of-list pick.
//
// Design notes:
//   - Heuristic, not LLM-backed. Cheap, deterministic, testable. Replace later
//     with a learned ranker if precision plateaus.
//   - Scores are bounded to [0, 1] after clamping; reason codes are strings
//     attached to each item for offline analysis (logs, _meta).
//   - "Soft-geo" means a story can pass even when its primary geography is
//     broader than the configured target — text mention of a configured geo
//     suffices alongside structural overlap.
//   - Keyword + topic checks reuse the same canonical normalization + token
//     boundaries used elsewhere in the pipeline so lexical behavior stays
//     consistent across stages.
//
// D-060 (Point 7) cleanup: the prototype-era `POLICY_ACTOR_CUES` actor list
// (Petro, Colombia, State Department, Treasury, …) and the
// `OFF_BEAT_REGIONS` penalty (asia, africa, …) are removed. Both encoded a
// single Colombia/US bilateral demo persona and produced wrong rankings for
// any other user beat (an Africa-monitoring user was penalized for the word
// "Africa"). The commodity-framing penalty is kept as a generic precision
// filter. Core positive signals are now topic + keyword + geo + recency.

import {
  GEOGRAPHY_ALIASES,
  normalizeTopicLabel,
  resolveGeographyAlias,
} from "../contracts-runtime/index.mjs";
import {
  SEMANTIC_BLEND_DETERMINISTIC,
  SEMANTIC_BLEND_SEMANTIC,
} from "./semantic-beat-fit.mjs";

// Precomputed alias entries for the per-item geo loop. Mirrors the structure
// used in meta-story-tags.mjs so beat-fit and tag assignment share identical
// alias-hit rules (D-064).
const ALIAS_ENTRIES = Object.entries(GEOGRAPHY_ALIASES);

export const BEAT_FIT_VERSION = "beat-fit-v1";

// Re-export the blend weights so callers can reference them without reaching
// into the semantic module.
export { SEMANTIC_BLEND_DETERMINISTIC, SEMANTIC_BLEND_SEMANTIC };

// MVP recall-first default (D-063). Items at or above this reach clustering.
// The previous 0.40 "balanced" precision-first gate dropped priority WaPo
// stories observed in manual tests (Ukraine ~0.38, China ~0.22, Rwanda
// ~0.20); 0.20 keeps them surfaced so we can learn from real usage. Override
// via `TEMPO_BEAT_FIT_THRESHOLD` (legacy alias `BEAT_FIT_THRESHOLD`) — set to
// 0.40 to roll back to the precision posture. `readBeatFitThreshold()` is the
// runtime accessor; this constant remains the default fallback.
export const BEAT_FIT_THRESHOLD = 0.20;

// Phase 1 borderline-rescue guardrail. Items that fall just below the main
// threshold can still pass when they show strong multi-signal evidence and
// carry no major penalty. The band is [rescueLowerBound, threshold).
// Default lower bound is 0.35 (sized for the legacy 0.40 threshold). The
// bound is configurable via env, with precedence:
//   1. TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND  (repo-convention primary)
//   2. BEAT_FIT_RESCUE_LOWER_BOUND        (legacy fallback, kept for back-compat)
//   3. DEFAULT_RESCUE_LOWER_BOUND
// `readRescueLowerBound()` is threshold-aware: when the active threshold is
// at or below the default, the effective lower bound collapses just under
// the threshold (e.g. 0.15 at threshold 0.20) so the band stays non-empty
// without re-tuning env each time. Rescue rule is intentionally strict
// (FP-first posture inside the band): require at least
// RESCUE_MIN_STRONG_SIGNALS distinct CORE positive signals (topic / keyword /
// geo — recency is excluded; actor was removed in D-060) AND zero penalties.
export const DEFAULT_RESCUE_LOWER_BOUND = 0.35;
export const RESCUE_MIN_STRONG_SIGNALS = 3;
export const BEAT_FIT_RESCUE_REASON = "rescue_borderline_multisignal";

// D-059 + D-062 (PR4): narrow "rescue_semantic_geo" path. Items below the
// active beat-fit threshold can still pass when ALL of:
//   - `semanticIntentScore >= SEMANTIC_GEO_RESCUE_MIN` (default 0.60)
//   - the scoreBeatFit geo component fired (`breakdown.geoMatch > 0`)
//   - no major penalty (pureCommodity / noConfiguredSignal — D-060 removed offBeatGeo)
// **Uncapped** (D-062 amendment) — every eligible item is rescued.
// Coexists with the older borderline-multisignal path; multisignal wins when
// both qualify so prior rescues keep their original reason code.
//
// Threshold is configurable via env, with precedence:
//   1. TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN  (repo-convention primary)
//   2. BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN        (legacy/short fallback)
//   3. DEFAULT_SEMANTIC_GEO_RESCUE_MIN
export const DEFAULT_SEMANTIC_GEO_RESCUE_MIN = 0.60;
export const SEMANTIC_GEO_RESCUE_REASON = "rescue_semantic_geo";

// Component weights (sum > legacy 0.40 gate so no single signal could carry
// alone under the precision posture; combinations clear comfortably). D-060:
// actor component removed; the freed weight (0.25) is redistributed into
// keyword (+0.05) and geoMatch (+0.05) so a clean topic + keyword + geo
// combination still clears the legacy 0.40 threshold without leaning on the
// actor cue list. D-063 lowered the default gate to 0.20 (recall-first); a
// single core signal can now suffice. Recency unchanged.
const W = Object.freeze({
  topic: 0.30,
  keyword: 0.25,
  geoMatch: 0.20,
  recency: 0.10,
});

// Penalties subtract from the final score. D-060 removed the off-beat-region
// penalty (penalized Africa-monitoring users for stories mentioning
// "Africa"). The commodity-framing penalty stays as a generic precision
// filter; the no-signal floor stays as the structural-misalignment guard.
const P = Object.freeze({
  pureCommodity: 0.15,
  noConfiguredSignal: 0.20,
});

// Pure-commodity / agricultural-economy framing, often a tell that the story
// is about downstream economic effects rather than the policy beat itself.
const COMMODITY_TERMS = [
  "farmer",
  "farmers",
  "harvest",
  "crop",
  "crops",
  "commodity",
  "commodities",
  "wheat",
  "soy",
  "grain",
  "fertilizer",
  "livestock",
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Soft-geo lexical synonyms used when item.geographies is empty (very common
// for raw RSS items at the candidate stage). "US" should match "U.S.", "U.S",
// "USA", "United States" in text without depending on NER. Keep this map
// tightly scoped to MVP geographies (US, Colombia) — extend as new geos are
// added to the contract enum.
const GEO_SYNONYMS = Object.freeze({
  US: ["U.S.", "U.S", "USA", "U.S.A.", "U.S.A", "United States"],
  Colombia: ["Colombia", "Colombian", "Bogota", "Bogotá"],
});

function geoTextMatches(text, geo, settingsGeographies) {
  // 1. Word-boundary token match on the canonical name itself.
  const canonicalRe = buildPlainTokenRegex([geo]);
  if (canonicalRe && canonicalRe.test(text)) return true;
  // 2. Synonym list (handles "U.S." which has a period that defeats \b on the
  //    trailing side).
  const synonyms = GEO_SYNONYMS[geo];
  if (synonyms) {
    for (const syn of synonyms) {
      const re = new RegExp(`\\b${escapeRegex(syn)}`, "i");
      if (re.test(text)) return true;
    }
  }
  // 3. D-064: GEOGRAPHY_ALIASES gated on settings.geographies. Mirrors the
  //    `assignGeographies` alias path in meta-story-tags.mjs so beat-fit and
  //    tag-assignment treat alias evidence identically. For each alias key
  //    that resolves (via `resolveGeographyAlias`) to this same `geo` in the
  //    settings list, a whole-word hit in the joined text counts.
  const geoLower = String(geo).trim().toLowerCase();
  if (!geoLower) return false;
  for (const [aliasLower] of ALIAS_ENTRIES) {
    const resolved = resolveGeographyAlias(aliasLower, settingsGeographies);
    if (!resolved || resolved.trim().toLowerCase() !== geoLower) continue;
    const re = new RegExp(`\\b${escapeRegex(aliasLower)}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

function buildPlainTokenRegex(terms) {
  const cleaned = (terms ?? []).map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
  if (cleaned.length === 0) return null;
  const alternation = cleaned.map(escapeRegex).join("|");
  return new RegExp(`\\b(?:${alternation})\\b`, "i");
}

const COMMODITY_REGEX = buildPlainTokenRegex(COMMODITY_TERMS);

function joinText(item) {
  const headline = String(item?.headline ?? "");
  const body = Array.isArray(item?.body) ? item.body.join(" ") : String(item?.body ?? "");
  const subtitle = String(item?.subtitle ?? "");
  // D-064: `url` carries path-token evidence (e.g. `…/beijing/…` → China via
  // GEOGRAPHY_ALIASES). Empty / missing url is unchanged behavior.
  const url = typeof item?.url === "string" ? item.url : "";
  return `${headline} ${subtitle} ${body} ${url}`.trim();
}

function recencyScore(minutesAgo) {
  // Linear decay over 24h: 0 min → 1.0; 1440 min → 0.0; clamp.
  if (typeof minutesAgo !== "number" || !Number.isFinite(minutesAgo)) return 0;
  if (minutesAgo <= 0) return 1;
  if (minutesAgo >= 1440) return 0;
  return 1 - minutesAgo / 1440;
}

/**
 * Score a single candidate item against user settings.
 *
 * Returns:
 *   {
 *     score:        number in [0, 1]  — final score the threshold compares
 *                   against. When the item carries a valid
 *                   `semanticIntentScore` and blending is enabled, this is the
 *                   blended value (deterministic * 0.65 + semantic * 0.35);
 *                   otherwise it equals `deterministicScore`.
 *     deterministicScore:  number in [0, 1] — pure heuristic score
 *     semanticIntentScore: number | null  — input score from the semantic
 *                          stage (passed through for diagnostics, never
 *                          recomputed here)
 *     blendApplied: boolean  — true iff the final score was blended
 *     breakdown:    per-component signed contributions (positive bonuses,
 *                   negative penalties), useful for logs and tests. When
 *                   blending is applied, also includes:
 *                     `deterministicWeighted` = deterministic * 0.65
 *                     `semanticIntentWeighted` = semantic * 0.35
 *     reasonCodes:  string[] — internal-only codes describing why the score
 *                   landed where it did (e.g. "topic_match:diplomatic relations",
 *                   "keyword_match:sanctions", "geo_text_match:us",
 *                   "commodity_framing:wheat", "semantic_intent_score:0.74").
 *   }
 *
 * Opts:
 *   - semanticBlendEnabled (default true): controls whether the blend formula
 *     is applied when a `semanticIntentScore` is present on the item. Set to
 *     false at the call site (or via kill switch in opts) for an instant
 *     rollback to deterministic-only behavior without removing the field.
 */
export function scoreBeatFit(item, settings, opts = {}) {
  const breakdown = {};
  const reasonCodes = [];
  const text = joinText(item);
  const lower = text.toLowerCase();

  // Topic alignment — canonical equality on configured topics.
  const configuredTopics = new Set(
    (settings?.topics ?? []).map((t) => normalizeTopicLabel(t))
  );
  const itemTopic = normalizeTopicLabel(item?.topic ?? "");
  if (configuredTopics.size > 0 && itemTopic && configuredTopics.has(itemTopic)) {
    breakdown.topic = W.topic;
    reasonCodes.push(`topic_match:${itemTopic}`);
  } else {
    breakdown.topic = 0;
  }

  // Keyword/context alignment — token-bound match against configured keywords.
  const keywordRegex = buildPlainTokenRegex(settings?.keywords ?? []);
  if (keywordRegex && keywordRegex.test(text)) {
    breakdown.keyword = W.keyword;
    const match = text.match(keywordRegex);
    reasonCodes.push(`keyword_match:${match?.[0]?.toLowerCase()}`);
  } else {
    breakdown.keyword = 0;
  }

  // Geo alignment — soft-geo policy. Explicit overlap on item.geographies
  // first; fall back to text-based mention of a configured geography (incl.
  // GEOGRAPHY_ALIASES gated on the configured list — D-064).
  const settingsGeographies = settings?.geographies ?? [];
  const configuredGeos = new Set(settingsGeographies);
  let geoHit = false;
  if (configuredGeos.size > 0) {
    if ((item?.geographies ?? []).some((g) => configuredGeos.has(g))) {
      geoHit = true;
      reasonCodes.push("geo_explicit_match");
    } else {
      for (const g of configuredGeos) {
        if (geoTextMatches(text, g, settingsGeographies)) {
          geoHit = true;
          reasonCodes.push(`geo_text_match:${g.toLowerCase()}`);
          break;
        }
      }
    }
  }
  breakdown.geoMatch = geoHit ? W.geoMatch : 0;

  // Recency — graceful linear decay.
  const recScore = recencyScore(item?.minutesAgo);
  breakdown.recency = recScore * W.recency;
  if (recScore >= 0.75) reasonCodes.push("recency_fresh");
  else if (recScore <= 0.25) reasonCodes.push("recency_stale");

  // Penalties — pure-commodity framing and "no signal at all" floor.
  // D-060 removed the off-beat-region penalty.
  let penalty = 0;
  if (COMMODITY_REGEX && COMMODITY_REGEX.test(lower)) {
    breakdown.pureCommodity = -P.pureCommodity;
    penalty += P.pureCommodity;
    const match = lower.match(COMMODITY_REGEX);
    reasonCodes.push(`commodity_framing:${match?.[0]}`);
  }
  // No-signal floor — if the item triggered no positive signals at all, it's
  // off-beat by default.
  const positiveSum = breakdown.topic + breakdown.keyword + breakdown.geoMatch;
  if (positiveSum === 0) {
    breakdown.noConfiguredSignal = -P.noConfiguredSignal;
    penalty += P.noConfiguredSignal;
    reasonCodes.push("no_configured_signal");
  }

  const raw = positiveSum + breakdown.recency - penalty;
  const deterministicScore = Math.max(0, Math.min(1, raw));

  // Semantic intent blending. The blend is applied only when:
  //   1. `semanticBlendEnabled` opt is true (default true — flip to false to
  //      force deterministic-only behavior without touching the field).
  //   2. The item carries a finite `semanticIntentScore` in [0, 1].
  // Otherwise the final score equals the deterministic score so existing
  // behavior is preserved bit-for-bit when the semantic stage is off / failed
  // / not yet wired.
  const semanticBlendEnabled = opts.semanticBlendEnabled !== false;
  const activeThreshold = opts.threshold ?? readBeatFitThreshold();
  const rawSemantic =
    typeof item?.semanticIntentScore === "number" && Number.isFinite(item.semanticIntentScore)
      ? Math.max(0, Math.min(1, item.semanticIntentScore))
      : null;
  let score = deterministicScore;
  let blendApplied = false;
  if (semanticBlendEnabled && rawSemantic !== null) {
    const deterministicWeighted = deterministicScore * SEMANTIC_BLEND_DETERMINISTIC;
    const semanticWeighted = rawSemantic * SEMANTIC_BLEND_SEMANTIC;
    breakdown.deterministicWeighted = deterministicWeighted;
    breakdown.semanticIntentWeighted = semanticWeighted;
    score = Math.max(0, Math.min(1, deterministicWeighted + semanticWeighted));
    blendApplied = true;
    // Surface the raw semantic input + the rounded contribution so an
    // operator reading the trace can answer "did semantic help or hurt?".
    reasonCodes.push(`semantic_intent_score:${rawSemantic.toFixed(3)}`);
    if (rawSemantic >= 0.7) reasonCodes.push("semantic_intent_strong");
    // Compare against the active runtime threshold so the lift code stays
    // truthful when the env override lowers (or raises) the gate.
    if (deterministicScore < activeThreshold && score >= activeThreshold) {
      reasonCodes.push("semantic_intent_lift_over_threshold");
    }
  }

  return {
    score,
    deterministicScore,
    semanticIntentScore: rawSemantic,
    blendApplied,
    breakdown,
    reasonCodes,
  };
}

// Read the configurable beat-fit threshold from the environment, with a safe
// fallback to BEAT_FIT_THRESHOLD (default 0.20 under D-063). Precedence:
//   1. TEMPO_BEAT_FIT_THRESHOLD  (current repo convention)
//   2. BEAT_FIT_THRESHOLD        (legacy name, kept for back-compat)
//   3. BEAT_FIT_THRESHOLD constant
// Each candidate is independently validated (finite number, strictly inside
// (0, 1]); invalid values are skipped so a typo in the new var doesn't
// silently shadow a working legacy value.
export function readBeatFitThreshold() {
  const candidates = [
    process.env.TEMPO_BEAT_FIT_THRESHOLD,
    process.env.BEAT_FIT_THRESHOLD,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n <= 0 || n > 1) continue;
    return n;
  }
  return BEAT_FIT_THRESHOLD;
}

// Read the configurable rescue band lower bound from the environment, with
// a safe fallback. Precedence:
//   1. TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND  (current repo convention)
//   2. BEAT_FIT_RESCUE_LOWER_BOUND        (legacy name, kept for back-compat)
//   3. DEFAULT_RESCUE_LOWER_BOUND, clamped to stay strictly below `threshold`
// Each candidate is independently validated (finite number, strictly inside
// (0, threshold)); invalid values are skipped rather than aborting, so a typo
// in the new var doesn't silently shadow a working legacy value.
// Equal-to-threshold collapses the band to empty, so it's rejected.
//
// Threshold-aware fallback: D-063 lowered the default threshold to 0.20, which
// is below the historical `DEFAULT_RESCUE_LOWER_BOUND` (0.35). When the active
// threshold is at or below the default lower bound, the rescue band would
// otherwise collapse; we clamp the fallback to `max(0.05, threshold - 0.05)`
// (→ 0.15 at threshold 0.20) so the borderline band remains non-empty.
export function readRescueLowerBound(threshold = readBeatFitThreshold()) {
  const candidates = [
    process.env.TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND,
    process.env.BEAT_FIT_RESCUE_LOWER_BOUND,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n <= 0 || n >= threshold) continue;
    return n;
  }
  if (DEFAULT_RESCUE_LOWER_BOUND >= threshold) {
    return Math.max(0.05, threshold - 0.05);
  }
  return DEFAULT_RESCUE_LOWER_BOUND;
}

// Strong positive signals are derived from existing scorer outputs — no new
// scoring logic, just a count of distinct evidence dimensions that fired.
// D-060: only the three remaining core alignment signals (topic / keyword /
// geo) count here. Recency still contributes to the score itself, but
// freshness alone is not evidence that an item is on the beat — letting
// recency_fresh count toward the rescue tally would let a thinly-aligned
// breaking story slip through the FP-first gate.
function countStrongSignals(breakdown) {
  let count = 0;
  if ((breakdown?.topic ?? 0) > 0) count++;
  if ((breakdown?.keyword ?? 0) > 0) count++;
  if ((breakdown?.geoMatch ?? 0) > 0) count++;
  return count;
}

// Any remaining penalty bucket disqualifies rescue. D-060 removed the
// off-beat-region penalty; pureCommodity + noConfiguredSignal remain.
// Penalties represent structural misalignment (pure commodity framing, no
// configured signal at all) — letting a penalized item through the rescue
// path would directly undo what the penalty was designed to catch.
function hasMajorPenalty(breakdown) {
  return (
    (breakdown?.pureCommodity ?? 0) < 0 ||
    (breakdown?.noConfiguredSignal ?? 0) < 0
  );
}

/**
 * Decide whether a below-threshold item qualifies for the borderline rescue.
 *
 * Returns:
 *   {
 *     rescued:       boolean — true only if in band, no penalty, ≥ N signals
 *     inBand:        boolean — score is in [lowerBound, threshold)
 *     strongSignals: number  — count of distinct CORE positive signals
 *                              (topic / keyword / geo; recency excluded; actor
 *                              was removed in D-060)
 *     blockedBy:     null | "major_penalty" | "insufficient_signals"
 *   }
 *
 * Operates purely on existing scoreBeatFit outputs, so unit tests can drive
 * it with synthetic breakdown/reasonCodes without battling the scorer math.
 */
export function evaluateRescue(score, breakdown, reasonCodes, opts = {}) {
  const threshold = opts.threshold ?? readBeatFitThreshold();
  const lowerBound = opts.rescueLowerBound ?? readRescueLowerBound(threshold);
  const inBand = score >= lowerBound && score < threshold;
  if (!inBand) {
    return { rescued: false, inBand: false, strongSignals: 0, blockedBy: null };
  }
  const strongSignals = countStrongSignals(breakdown);
  if (hasMajorPenalty(breakdown)) {
    return { rescued: false, inBand: true, strongSignals, blockedBy: "major_penalty" };
  }
  if (strongSignals < RESCUE_MIN_STRONG_SIGNALS) {
    return { rescued: false, inBand: true, strongSignals, blockedBy: "insufficient_signals" };
  }
  return { rescued: true, inBand: true, strongSignals, blockedBy: null };
}

/**
 * Read the configurable semantic-geo rescue floor from the environment. See
 * `DEFAULT_SEMANTIC_GEO_RESCUE_MIN` for precedence. Invalid values (NaN, ≤ 0,
 * > 1) fall back to the default rather than aborting, mirroring
 * `readRescueLowerBound`'s defensive shape.
 */
export function readSemanticGeoRescueMin() {
  const candidates = [
    process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN,
    process.env.BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n <= 0 || n > 1) continue;
    return n;
  }
  return DEFAULT_SEMANTIC_GEO_RESCUE_MIN;
}

/**
 * D-059 + D-062: decide whether a below-threshold item qualifies for the
 * narrow `rescue_semantic_geo` path.
 *
 * Inputs are deliberately the scorer's own outputs so unit tests can drive
 * synthetic combinations without re-running the scorer:
 *   - `score`                  final blended score (post semantic blend)
 *   - `semanticIntentScore`    raw semantic input (0..1) — null/missing => weak
 *   - `breakdown`              per-component breakdown from scoreBeatFit
 *
 * Returns:
 *   {
 *     rescued:           boolean — true only if all criteria pass
 *     belowThreshold:    boolean — score < threshold
 *     hasStrongSemantic: boolean — semanticIntentScore >= minSemantic
 *     hasGeoMatch:       boolean — breakdown.geoMatch > 0
 *     blockedBy:         null
 *                      | "above_threshold"
 *                      | "major_penalty"
 *                      | "weak_semantic"
 *                      | "geo_gate"
 *   }
 *
 * Block-order is fixed (penalty → semantic → geo) so the blockedBy value is
 * deterministic for the same inputs; downstream diagnostics rely on the
 * specific value (e.g. eval suite case 11 asserts `geo_gate`).
 */
export function evaluateSemanticGeoRescue({
  score,
  semanticIntentScore,
  breakdown,
  threshold = readBeatFitThreshold(),
  minSemantic = readSemanticGeoRescueMin(),
} = {}) {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return {
      rescued: false,
      belowThreshold: false,
      hasStrongSemantic: false,
      hasGeoMatch: false,
      blockedBy: "above_threshold",
    };
  }
  if (score >= threshold) {
    return {
      rescued: false,
      belowThreshold: false,
      hasStrongSemantic: false,
      hasGeoMatch: false,
      blockedBy: "above_threshold",
    };
  }
  const hasStrongSemantic =
    typeof semanticIntentScore === "number" &&
    Number.isFinite(semanticIntentScore) &&
    semanticIntentScore >= minSemantic;
  const hasGeoMatch = (breakdown?.geoMatch ?? 0) > 0;
  if (hasMajorPenalty(breakdown)) {
    return {
      rescued: false,
      belowThreshold: true,
      hasStrongSemantic,
      hasGeoMatch,
      blockedBy: "major_penalty",
    };
  }
  if (!hasStrongSemantic) {
    return {
      rescued: false,
      belowThreshold: true,
      hasStrongSemantic: false,
      hasGeoMatch,
      blockedBy: "weak_semantic",
    };
  }
  if (!hasGeoMatch) {
    return {
      rescued: false,
      belowThreshold: true,
      hasStrongSemantic: true,
      hasGeoMatch: false,
      blockedBy: "geo_gate",
    };
  }
  return {
    rescued: true,
    belowThreshold: true,
    hasStrongSemantic: true,
    hasGeoMatch: true,
    blockedBy: null,
  };
}

/**
 * Filter a candidate item pool down to those that meet the beat-fit threshold,
 * with a borderline-rescue path for items just below threshold that show
 * strong multi-signal evidence.
 *
 * Returns:
 *   {
 *     included: items[] — normal passes plus rescues. Rescued items carry
 *                         `beatFitRescued: true` and an extra
 *                         `rescue_borderline_multisignal` reason code so
 *                         downstream observers can distinguish them.
 *     excluded: { item, score, reasonCodes, excludeReason }[]
 *                 — excluded items in the rescue band get an extra
 *                   `rescue_blocked_*` annotation in reasonCodes.
 *     summary:  { threshold, rescueLowerBound, includedCount, rescuedCount,
 *                 excludedCount, excludeReasonHistogram,
 *                 rescueBlockedPenaltyCount,
 *                 rescueBlockedInsufficientSignalsCount }
 *   }
 */
export function applyBeatFitFilter(items, settings, opts = {}) {
  const threshold = opts.threshold ?? readBeatFitThreshold();
  const rescueLowerBound =
    opts.rescueLowerBound ?? readRescueLowerBound(threshold);
  const semanticGeoRescueMin =
    opts.semanticGeoRescueMin ?? readSemanticGeoRescueMin();
  const semanticBlendEnabled = opts.semanticBlendEnabled !== false;
  const included = [];
  const excluded = [];
  const histogram = {};
  let rescuedCount = 0;
  let rescuedBorderlineCount = 0;     // D-059 + D-062: split by rescue path
  let rescuedSemanticGeoCount = 0;    // so operators can see uncapped path uptake
  let rescueBlockedPenaltyCount = 0;
  let rescueBlockedInsufficientSignalsCount = 0;
  let rescueBlockedGeoGateCount = 0;  // semantic strong + score < threshold + geo missed
  let rescueBlockedWeakSemanticCount = 0; // geo + score < threshold + semantic < min
  // Semantic-blend counters: surfaced on _meta so an operator can answer
  // "how often did semantic actually move the needle?" without re-running.
  let semanticBlendAppliedCount = 0;
  let semanticBlendMissingCount = 0;
  let semanticLiftOverThresholdCount = 0;
  let semanticDropBelowThresholdCount = 0;
  let excludedWithSemanticPresentCount = 0;

  for (const item of items ?? []) {
    const result = scoreBeatFit(item, settings, {
      semanticBlendEnabled,
      threshold,
    });
    const { score, deterministicScore, semanticIntentScore, breakdown, reasonCodes, blendApplied } = result;
    const normalPass = score >= threshold;

    if (blendApplied) {
      semanticBlendAppliedCount += 1;
      if (deterministicScore < threshold && score >= threshold) {
        semanticLiftOverThresholdCount += 1;
      } else if (deterministicScore >= threshold && score < threshold) {
        semanticDropBelowThresholdCount += 1;
      }
    } else if (
      typeof item?.semanticIntentScore === "number" &&
      Number.isFinite(item.semanticIntentScore)
    ) {
      // Score was on the item but blend was disabled at the call site.
    } else {
      semanticBlendMissingCount += 1;
    }

    if (normalPass) {
      included.push({
        ...item,
        beatFitScore: score,
        beatFitDeterministicScore: deterministicScore,
        beatFitReasonCodes: reasonCodes,
        beatFitBlendApplied: blendApplied,
      });
      continue;
    }

    // Below threshold. Try multisignal rescue first (preserves prior
    // contract — items that qualified under D-054 still surface with the
    // original reason code).
    const borderlineOutcome = evaluateRescue(score, breakdown, reasonCodes, {
      threshold,
      rescueLowerBound,
    });

    if (borderlineOutcome.rescued) {
      rescuedCount++;
      rescuedBorderlineCount++;
      included.push({
        ...item,
        beatFitScore: score,
        beatFitDeterministicScore: deterministicScore,
        beatFitReasonCodes: [...reasonCodes, BEAT_FIT_RESCUE_REASON],
        beatFitRescued: true,
        beatFitRescueReason: BEAT_FIT_RESCUE_REASON,
        beatFitBlendApplied: blendApplied,
      });
      continue;
    }

    // D-059 + D-062: narrow semantic-geo rescue, uncapped. Considered for
    // ANY below-threshold item (not just the [lowerBound, threshold) band)
    // — an item at 0.32 with strong semantic + geo + no penalty still
    // qualifies. No per-refresh cap.
    const semanticGeoOutcome = evaluateSemanticGeoRescue({
      score,
      semanticIntentScore,
      breakdown,
      threshold,
      minSemantic: semanticGeoRescueMin,
    });

    if (semanticGeoOutcome.rescued) {
      rescuedCount++;
      rescuedSemanticGeoCount++;
      included.push({
        ...item,
        beatFitScore: score,
        beatFitDeterministicScore: deterministicScore,
        beatFitReasonCodes: [...reasonCodes, SEMANTIC_GEO_RESCUE_REASON],
        beatFitRescued: true,
        beatFitRescueReason: SEMANTIC_GEO_RESCUE_REASON,
        beatFitBlendApplied: blendApplied,
      });
      continue;
    }

    // Excluded. Annotate with the most specific rescue-blocked code so the
    // pipeline trace / sample-exclusions surface why each item failed both
    // rescue paths.
    const annotatedCodes = [...reasonCodes];
    if (borderlineOutcome.inBand) {
      if (borderlineOutcome.blockedBy === "major_penalty") {
        annotatedCodes.push("rescue_blocked_penalty");
        rescueBlockedPenaltyCount++;
      } else if (borderlineOutcome.blockedBy === "insufficient_signals") {
        annotatedCodes.push("rescue_blocked_insufficient_signals");
        rescueBlockedInsufficientSignalsCount++;
      }
    }
    // Annotate semantic-geo-specific blocks separately so an operator can
    // tell "strong semantic but wrong geo" apart from "weak semantic." Major-
    // penalty exclusion is already covered above; only annotate geo / weak-
    // semantic here so the two annotations don't double-emit.
    if (
      semanticGeoOutcome.belowThreshold &&
      semanticGeoOutcome.blockedBy === "geo_gate"
    ) {
      annotatedCodes.push("rescue_blocked_geo_gate");
      rescueBlockedGeoGateCount++;
    } else if (
      semanticGeoOutcome.belowThreshold &&
      semanticGeoOutcome.blockedBy === "weak_semantic" &&
      semanticGeoOutcome.hasGeoMatch
    ) {
      // Only flag weak-semantic when geo would otherwise have passed — i.e.
      // the item was a genuine semantic-geo near-miss, not a generic low-
      // score exclusion.
      annotatedCodes.push("rescue_blocked_weak_semantic");
      rescueBlockedWeakSemanticCount++;
    }
    const excludeReason = pickPrimaryExcludeReason(breakdown);
    histogram[excludeReason] = (histogram[excludeReason] ?? 0) + 1;
    if (
      typeof item?.semanticIntentScore === "number" &&
      Number.isFinite(item.semanticIntentScore)
    ) {
      excludedWithSemanticPresentCount += 1;
    }
    excluded.push({
      item,
      score,
      deterministicScore,
      semanticIntentScore: result.semanticIntentScore,
      reasonCodes: annotatedCodes,
      excludeReason,
    });
  }

  return {
    included,
    excluded,
    summary: {
      threshold,
      rescueLowerBound,
      semanticGeoRescueMin,
      includedCount: included.length,
      rescuedCount,
      rescuedBorderlineCount,
      rescuedSemanticGeoCount,
      excludedCount: excluded.length,
      excludeReasonHistogram: histogram,
      rescueBlockedPenaltyCount,
      rescueBlockedInsufficientSignalsCount,
      rescueBlockedGeoGateCount,
      rescueBlockedWeakSemanticCount,
      // Semantic-blend rollup (always present so the shape is stable; counts
      // are zero when the semantic stage is off or no item carried a score).
      semanticBlendEnabled,
      semanticBlendAppliedCount,
      semanticBlendMissingCount,
      semanticLiftOverThresholdCount,
      semanticDropBelowThresholdCount,
      excludedWithSemanticPresentCount,
    },
  };
}

// Pick the most informative single reason for the exclusion histogram. Order
// matters — penalties and structural misses dominate over absence-of-bonus.
// Derived from the breakdown alone; rescue-blocked annotations live on the
// per-item reasonCodes (not the histogram). D-060 removed the off-beat-region
// bucket.
function pickPrimaryExcludeReason(breakdown) {
  if (breakdown.pureCommodity) return "excluded_commodity_framing";
  if (breakdown.noConfiguredSignal) return "excluded_no_signal";
  // Item had some positive signals but didn't reach threshold — soft "low score".
  return "excluded_low_score";
}
