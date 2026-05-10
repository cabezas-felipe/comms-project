// Beat-fit scoring (Phase 1 relevance Stage 2).
//
// Stage 1 (selectSourcePool / 24h / geo / topic+keyword) is recall-oriented:
// it cuts the global pool down to plausibly-relevant items using OR semantics.
// Stage 2 (this module) is precision-oriented with the "balanced" posture:
// each candidate is scored on a 0..1 scale combining several signals, and only
// items above a threshold reach clustering. Strict-empty: if no candidate
// clears, the pipeline returns an empty stories list rather than falling back
// to a weak top-of-list pick.
//
// Design notes:
//   - Heuristic, not LLM-backed. Cheap, deterministic, testable. Replace later
//     with a learned ranker if precision plateaus.
//   - Scores are bounded to [0, 1] after clamping; reason codes are strings
//     attached to each item for offline analysis (logs, _meta).
//   - "Soft-geo" means a story can pass even when its primary geography is
//     broader than the configured target — but core actor-fit stories score
//     higher and off-beat-geo stories take a penalty unless other signals carry.
//   - Keyword + topic checks reuse the same canonical normalization + token
//     boundaries used elsewhere in the pipeline so lexical behavior stays
//     consistent across stages.

import { normalizeTopicLabel } from "@tempo/contracts";

export const BEAT_FIT_VERSION = "beat-fit-v1";

// Threshold tuned to the "balanced" product posture. Items at or above this
// reach clustering. The pairwise regression (US strikes Iranian tankers vs.
// Asia farmers food supply) calibrates this number.
export const BEAT_FIT_THRESHOLD = 0.40;

// Component weights (sum > threshold so no single signal can carry alone, but
// strong combinations clear comfortably).
const W = Object.freeze({
  topic: 0.30,
  actor: 0.25,
  keyword: 0.20,
  geoMatch: 0.15,
  recency: 0.10,
});

// Penalties subtract from the final score. Designed so a clearly off-beat
// story (e.g. "Asia's farmers, global food supply") sinks below threshold
// even when it incidentally hits a configured topic or geography.
const P = Object.freeze({
  offBeatGeo: 0.30,
  pureCommodity: 0.15,
  noConfiguredSignal: 0.20,
});

// Geographies treated as off-beat unless they appear in configured set.
// Substring match on item.headline + body. Keep tight — only well-known
// regional clusters; avoid country names that often co-occur with US foreign
// policy (Iran, Russia, Ukraine, etc.) so we don't downrank "U.S. strikes
// Iranian tankers" as a side effect.
const OFF_BEAT_REGIONS = [
  "asia",
  "asian",
  "africa",
  "african",
  "europe",
  "european",
  "australia",
  "oceania",
];

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

// Lightweight actor cue list. We do NOT try to do NER — instead we look for
// proper-noun policy actors that strongly signal the item is about US/Colombia
// foreign-policy / bilateral activity. Substring + word-boundary match.
const POLICY_ACTOR_CUES = [
  "u.s.",
  "us ",
  "united states",
  "white house",
  "state department",
  "treasury",
  "ofac",
  "congress",
  "senate",
  "house of representatives",
  "pentagon",
  "department of defense",
  "petro",
  "colombia",
  "colombian",
  "bogota",
  "bogotá",
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

function geoTextMatches(text, geo) {
  // 1. Word-boundary token match on the canonical name itself.
  const canonicalRe = buildPlainTokenRegex([geo]);
  if (canonicalRe && canonicalRe.test(text)) return true;
  // 2. Synonym list (handles "U.S." which has a period that defeats \b on the
  //    trailing side).
  const synonyms = GEO_SYNONYMS[geo];
  if (!synonyms) return false;
  for (const syn of synonyms) {
    const re = new RegExp(`\\b${escapeRegex(syn)}`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

function buildAnyTokenRegex(terms) {
  const cleaned = (terms ?? []).map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
  if (cleaned.length === 0) return null;
  // Use word boundaries; "u.s." has trailing period, so we relax the trailing
  // boundary requirement for the actor list specifically by anchoring with
  // \b at the start only.
  const alternation = cleaned.map(escapeRegex).join("|");
  return new RegExp(`\\b(?:${alternation})`, "i");
}

function buildPlainTokenRegex(terms) {
  const cleaned = (terms ?? []).map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
  if (cleaned.length === 0) return null;
  const alternation = cleaned.map(escapeRegex).join("|");
  return new RegExp(`\\b(?:${alternation})\\b`, "i");
}

const OFFBEAT_REGEX = buildPlainTokenRegex(OFF_BEAT_REGIONS);
const COMMODITY_REGEX = buildPlainTokenRegex(COMMODITY_TERMS);
const ACTOR_REGEX = buildAnyTokenRegex(POLICY_ACTOR_CUES);

function joinText(item) {
  const headline = String(item?.headline ?? "");
  const body = Array.isArray(item?.body) ? item.body.join(" ") : String(item?.body ?? "");
  const subtitle = String(item?.subtitle ?? "");
  return `${headline} ${subtitle} ${body}`.trim();
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
 *     score:        number in [0, 1]
 *     breakdown:    per-component signed contributions (positive bonuses,
 *                   negative penalties), useful for logs and tests
 *     reasonCodes:  string[] — internal-only codes describing why the score
 *                   landed where it did (e.g. "topic_match", "actor_us",
 *                   "geo_offbeat_asia", "commodity_framing")
 *   }
 */
export function scoreBeatFit(item, settings) {
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

  // Actor alignment — does the text mention a policy-actor cue?
  if (ACTOR_REGEX && ACTOR_REGEX.test(text)) {
    breakdown.actor = W.actor;
    const match = text.match(ACTOR_REGEX);
    reasonCodes.push(`actor_match:${match?.[0]?.toLowerCase().trim()}`);
  } else {
    breakdown.actor = 0;
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
  // first; fall back to text-based mention of a configured geography.
  const configuredGeos = new Set(settings?.geographies ?? []);
  let geoHit = false;
  if (configuredGeos.size > 0) {
    if ((item?.geographies ?? []).some((g) => configuredGeos.has(g))) {
      geoHit = true;
      reasonCodes.push("geo_explicit_match");
    } else {
      for (const g of configuredGeos) {
        if (geoTextMatches(text, g)) {
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

  // Penalties — off-beat geography (regional clusters not in configured set),
  // pure-commodity framing, and "no signal at all" floor.
  let penalty = 0;
  if (OFFBEAT_REGEX && OFFBEAT_REGEX.test(text)) {
    // Soft-geo: penalty applies only when the item has NO explicit geo overlap
    // with configured set. A US-strikes-Iran story might mention "Asia" in
    // body without being off-beat.
    if (!geoHit) {
      const match = text.match(OFFBEAT_REGEX);
      const tag = match?.[0]?.toLowerCase();
      breakdown.offBeatGeo = -P.offBeatGeo;
      penalty += P.offBeatGeo;
      reasonCodes.push(`geo_offbeat:${tag}`);
    }
  }
  if (COMMODITY_REGEX && COMMODITY_REGEX.test(lower) && !breakdown.actor) {
    breakdown.pureCommodity = -P.pureCommodity;
    penalty += P.pureCommodity;
    const match = lower.match(COMMODITY_REGEX);
    reasonCodes.push(`commodity_framing:${match?.[0]}`);
  }
  // No-signal floor — if the item triggered no positive signals at all, it's
  // off-beat by default.
  const positiveSum = breakdown.topic + breakdown.actor + breakdown.keyword + breakdown.geoMatch;
  if (positiveSum === 0) {
    breakdown.noConfiguredSignal = -P.noConfiguredSignal;
    penalty += P.noConfiguredSignal;
    reasonCodes.push("no_configured_signal");
  }

  const raw = positiveSum + breakdown.recency - penalty;
  const score = Math.max(0, Math.min(1, raw));

  return { score, breakdown, reasonCodes };
}

/**
 * Filter a candidate item pool down to those that meet the beat-fit threshold.
 *
 * Returns:
 *   {
 *     included: items[] (each carries { ...item, beatFitScore, beatFitReasonCodes })
 *     excluded: { item, score, reasonCodes, excludeReason }[]
 *     summary:  { threshold, includedCount, excludedCount, excludeReasonHistogram }
 *   }
 */
export function applyBeatFitFilter(items, settings, opts = {}) {
  const threshold = opts.threshold ?? BEAT_FIT_THRESHOLD;
  const included = [];
  const excluded = [];
  const histogram = {};

  for (const item of items ?? []) {
    const { score, breakdown, reasonCodes } = scoreBeatFit(item, settings);
    if (score >= threshold) {
      included.push({
        ...item,
        beatFitScore: score,
        beatFitReasonCodes: reasonCodes,
      });
    } else {
      const excludeReason = pickPrimaryExcludeReason(reasonCodes, breakdown);
      histogram[excludeReason] = (histogram[excludeReason] ?? 0) + 1;
      excluded.push({ item, score, reasonCodes, excludeReason });
    }
  }

  return {
    included,
    excluded,
    summary: {
      threshold,
      includedCount: included.length,
      excludedCount: excluded.length,
      excludeReasonHistogram: histogram,
    },
  };
}

// Pick the most informative single reason for the exclusion histogram. Order
// matters — penalties and structural misses dominate over absence-of-bonus.
function pickPrimaryExcludeReason(reasonCodes, breakdown) {
  if (breakdown.offBeatGeo) return "excluded_offbeat_geo";
  if (breakdown.pureCommodity) return "excluded_commodity_framing";
  if (breakdown.noConfiguredSignal) return "excluded_no_signal";
  // Item had some positive signals but didn't reach threshold — soft "low score".
  return "excluded_low_score";
}
