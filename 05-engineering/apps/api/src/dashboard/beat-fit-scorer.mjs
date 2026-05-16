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

import { normalizeTopicLabel } from "../contracts-runtime/index.mjs";

export const BEAT_FIT_VERSION = "beat-fit-v1";

// Threshold tuned to the "balanced" product posture. Items at or above this
// reach clustering. The pairwise regression (US strikes Iranian tankers vs.
// Asia farmers food supply) calibrates this number.
export const BEAT_FIT_THRESHOLD = 0.40;

// Phase 1 borderline-rescue guardrail. Items that fall just below the main
// threshold can still pass when they show strong multi-signal evidence and
// carry no major penalty. The band is [rescueLowerBound, BEAT_FIT_THRESHOLD).
// Default lower bound is 0.35. The bound is configurable via env, with
// precedence:
//   1. TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND  (repo-convention primary)
//   2. BEAT_FIT_RESCUE_LOWER_BOUND        (legacy fallback, kept for back-compat)
//   3. DEFAULT_RESCUE_LOWER_BOUND
// Rescue rule is intentionally strict (FP-first posture): require at least
// RESCUE_MIN_STRONG_SIGNALS distinct CORE positive signals (topic / actor /
// keyword / geo — recency is excluded) AND zero penalties, so global
// precision stays intact while a narrow slice of borderline-but-well-
// corroborated items survive.
export const DEFAULT_RESCUE_LOWER_BOUND = 0.35;
export const RESCUE_MIN_STRONG_SIGNALS = 3;
export const BEAT_FIT_RESCUE_REASON = "rescue_borderline_multisignal";

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

// Read the configurable rescue band lower bound from the environment, with
// a safe fallback. Precedence:
//   1. TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND  (current repo convention)
//   2. BEAT_FIT_RESCUE_LOWER_BOUND        (legacy name, kept for back-compat)
//   3. DEFAULT_RESCUE_LOWER_BOUND
// Each candidate is independently validated (finite number, strictly inside
// (0, BEAT_FIT_THRESHOLD)); invalid values are skipped rather than aborting,
// so a typo in the new var doesn't silently shadow a working legacy value.
// Equal-to-threshold collapses the band to empty, so it's rejected.
export function readRescueLowerBound() {
  const candidates = [
    process.env.TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND,
    process.env.BEAT_FIT_RESCUE_LOWER_BOUND,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n <= 0 || n >= BEAT_FIT_THRESHOLD) continue;
    return n;
  }
  return DEFAULT_RESCUE_LOWER_BOUND;
}

// Strong positive signals are derived from existing scorer outputs — no new
// scoring logic, just a count of distinct evidence dimensions that fired.
// Only the four core alignment signals (topic / actor / keyword / geo) count
// here. Recency still contributes to the score itself, but freshness alone is
// not evidence that an item is on the beat — letting recency_fresh count
// toward the rescue tally would let a thinly-aligned breaking story slip
// through the FP-first gate.
function countStrongSignals(breakdown) {
  let count = 0;
  if ((breakdown?.topic ?? 0) > 0) count++;
  if ((breakdown?.actor ?? 0) > 0) count++;
  if ((breakdown?.keyword ?? 0) > 0) count++;
  if ((breakdown?.geoMatch ?? 0) > 0) count++;
  return count;
}

// Any of the three penalty buckets disqualifies rescue. Penalties represent
// structural misalignment (off-beat region, pure commodity framing, no
// configured signal at all) — letting a penalized item through the rescue
// path would directly undo what the penalty was designed to catch.
function hasMajorPenalty(breakdown) {
  return (
    (breakdown?.offBeatGeo ?? 0) < 0 ||
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
 *                              (topic / actor / keyword / geo; recency excluded)
 *     blockedBy:     null | "major_penalty" | "insufficient_signals"
 *   }
 *
 * Operates purely on existing scoreBeatFit outputs, so unit tests can drive
 * it with synthetic breakdown/reasonCodes without battling the scorer math.
 */
export function evaluateRescue(score, breakdown, reasonCodes, opts = {}) {
  const threshold = opts.threshold ?? BEAT_FIT_THRESHOLD;
  const lowerBound = opts.rescueLowerBound ?? readRescueLowerBound();
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
  const threshold = opts.threshold ?? BEAT_FIT_THRESHOLD;
  const rescueLowerBound = opts.rescueLowerBound ?? readRescueLowerBound();
  const included = [];
  const excluded = [];
  const histogram = {};
  let rescuedCount = 0;
  let rescueBlockedPenaltyCount = 0;
  let rescueBlockedInsufficientSignalsCount = 0;

  for (const item of items ?? []) {
    const { score, breakdown, reasonCodes } = scoreBeatFit(item, settings);
    const normalPass = score >= threshold;

    if (normalPass) {
      included.push({
        ...item,
        beatFitScore: score,
        beatFitReasonCodes: reasonCodes,
      });
      continue;
    }

    const rescue = evaluateRescue(score, breakdown, reasonCodes, {
      threshold,
      rescueLowerBound,
    });

    if (rescue.rescued) {
      rescuedCount++;
      included.push({
        ...item,
        beatFitScore: score,
        beatFitReasonCodes: [...reasonCodes, BEAT_FIT_RESCUE_REASON],
        beatFitRescued: true,
      });
      continue;
    }

    const annotatedCodes = [...reasonCodes];
    if (rescue.inBand) {
      if (rescue.blockedBy === "major_penalty") {
        annotatedCodes.push("rescue_blocked_penalty");
        rescueBlockedPenaltyCount++;
      } else if (rescue.blockedBy === "insufficient_signals") {
        annotatedCodes.push("rescue_blocked_insufficient_signals");
        rescueBlockedInsufficientSignalsCount++;
      }
    }
    const excludeReason = pickPrimaryExcludeReason(breakdown);
    histogram[excludeReason] = (histogram[excludeReason] ?? 0) + 1;
    excluded.push({ item, score, reasonCodes: annotatedCodes, excludeReason });
  }

  return {
    included,
    excluded,
    summary: {
      threshold,
      rescueLowerBound,
      includedCount: included.length,
      rescuedCount,
      excludedCount: excluded.length,
      excludeReasonHistogram: histogram,
      rescueBlockedPenaltyCount,
      rescueBlockedInsufficientSignalsCount,
    },
  };
}

// Pick the most informative single reason for the exclusion histogram. Order
// matters — penalties and structural misses dominate over absence-of-bonus.
// Derived from the breakdown alone; rescue-blocked annotations live on the
// per-item reasonCodes (not the histogram).
function pickPrimaryExcludeReason(breakdown) {
  if (breakdown.offBeatGeo) return "excluded_offbeat_geo";
  if (breakdown.pureCommodity) return "excluded_commodity_framing";
  if (breakdown.noConfiguredSignal) return "excluded_no_signal";
  // Item had some positive signals but didn't reach threshold — soft "low score".
  return "excluded_low_score";
}
