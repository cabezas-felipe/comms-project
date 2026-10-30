// Pre-cluster item-level relevance scoring (Phase 1 · Step 1.1).
//
// A reusable, PURE, deterministic scorer for the cluster-input cap: when a
// refresh surfaces more candidate items than the clustering stage can afford to
// send, we need to drop the least-relevant items BEFORE clustering — without any
// new LLM call, DB read, or network I/O, and without grounded cluster entities
// (those don't exist yet at this stage). This mirrors the D-069 survival ordering
// intent (`computeRelevanceScore` / `compareSurvivalRank` in relevance-policy.mjs)
// but operates on item-level proxies only:
//
//   - topic / keyword / geo fit      → reuse `scoreTopicFit` / `scoreKeywordFit`
//                                       / `scoreGeoFit` from the policy module
//   - corroboration (source density) → a single-pass "headline family" proxy,
//                                       since real cross-source clusters are not
//                                       formed yet
//   - beat-fit + freshness           → soft shapers
//   - entity term                    → intentionally 0 (no grounded entities)
//
// Latency contract: pool preparation (`buildPreClusterPoolIndex`) is a single
// O(n) scan; per-item scoring is O(1) lookups against the prepared index. The
// module is self-contained and importable for the Step 1.3 pipeline wiring.

import {
  RELEVANCE_WEIGHTS,
  RELEVANCE_LEXICON,
  scoreTopicFit,
  scoreKeywordFit,
  scoreGeoFit,
  topicMatchesSettings,
} from "./relevance-policy.mjs";
import { buildPlainTokenRegex } from "./geo-lexical-match.mjs";
import { scoreBeatFit } from "./beat-fit-scorer.mjs";

// ── Small local primitives ────────────────────────────────────────────────────

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Gentle monotonic freshness decay in minutesAgo, bounded (0, 1]. Same 12h-ish
// scale as the policy module's private `freshnessScore`, replicated here (it is
// not exported) so freshness stays a soft tie-shaper rather than a dominant term.
function freshnessFromMinutes(minutesAgo) {
  const m =
    typeof minutesAgo === "number" && Number.isFinite(minutesAgo)
      ? minutesAgo
      : Number.POSITIVE_INFINITY;
  if (m < 0 || !Number.isFinite(m)) return 0;
  return 1 / (1 + m / 720);
}

// ── Decision 5C: election-cycle geo proximity ─────────────────────────────────
//
// A pre-cluster shaper, NOT an admission gate: an election item on the user's
// configured geography (their beat) is lifted above a cross-country election
// item, but the cross-country item is only DAMPENED — never zeroed — so it can
// still survive a thin pool. Hard-fail semantics from `scoreGeoFit` are untouched
// (we read its score/flag, we don't drop anything here).

// Lexicon clusters that signal an active election cycle. Migration / security /
// outbreak are deliberately excluded — they are configurable beats, not the
// election signal. EN + ES surface forms come straight from the shared lexicon
// so the detector stays bilingual without a second word list to drift.
const ELECTION_CLUSTER_KEYS = new Set([
  "election", "vote", "ballot", "presidential", "candidate", "campaign", "runoff",
]);

const ELECTION_REGEX = buildPlainTokenRegex(
  RELEVANCE_LEXICON.filter((c) => ELECTION_CLUSTER_KEYS.has(c.key)).flatMap((c) => [
    ...c.en,
    ...c.es,
  ])
);

// Minimum geo fit that counts as POSITIVE configured-geography evidence
// (explicit field overlap 1.0, lexical text match 0.9, demonym 0.7). Below this
// — implicit/no-evidence 0.5 or an explicit conflict 0 — the election item is
// not anchored to the configured beat, so it ranks as cross-country.
const CONFIGURED_GEO_MATCH_MIN = 0.7;

// Signed score shaping (in raw score units, added directly to preClusterScore).
// The boost is large enough to separate a configured-geo election from a
// cross-country one under otherwise-similar beat/freshness; the penalty is small
// so a cross-country election still clears non-election noise.
const ELECTION_GEO_BOOST = 1.5;
const ELECTION_GEO_PENALTY = 0.75;

// Deterministic election-cycle classification from topic + text (regex only).
export function isElectionCycleItem(item) {
  if (!ELECTION_REGEX) return false;
  const topic = String(item?.topic ?? "");
  return ELECTION_REGEX.test(`${topic} ${pickScoringText(item)}`);
}

// Internal: classify using an already-computed geo fit detail (avoids a second
// `scoreGeoFit` pass in the hot path). Returns one of
// "configuredGeoElection" | "crossCountryElection" | "nonElection".
function classifyElectionGeoFromFit(item, settings, fit) {
  if (!isElectionCycleItem(item)) return "nonElection";
  // No configured geographies → the cross-country rule is inert (no beat geo to
  // be "cross" to); leave the item unshaped.
  if ((settings?.geographies ?? []).length === 0) return "nonElection";
  if (!fit?.hardFail && Number(fit?.geoFit) >= CONFIGURED_GEO_MATCH_MIN) {
    return "configuredGeoElection";
  }
  return "crossCountryElection";
}

/**
 * Public Decision-5C classifier: is this an election item on the configured
 * geography, an election item elsewhere, or not an election item? Self-contained
 * (computes its own geo fit). Pure.
 */
export function classifyElectionGeo(item, settings) {
  const geo = scoreGeoFit(item, settings);
  return classifyElectionGeoFromFit(item, settings, { geoFit: geo.score, hardFail: geo.hardFail });
}

// Signed pre-cluster shaping for an election-geo class.
function electionGeoBoostFor(electionGeoClass) {
  if (electionGeoClass === "configuredGeoElection") return ELECTION_GEO_BOOST;
  if (electionGeoClass === "crossCountryElection") return -ELECTION_GEO_PENALTY;
  return 0;
}

// Coarse English/Spanish stopwords dropped from a headline family key. Kept small
// and explicit — the goal is to collapse incidental connective tokens so two
// outlets' phrasings of the SAME story land on the same key, not to do real
// linguistic stemming.
const FAMILY_STOPWORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "at",
  "by", "from", "as", "is", "are", "was", "were", "be", "new", "say", "says",
  "said", "after", "over", "amid", "into", "out", "its", "his", "her", "their",
  "this", "that", "near", "off",
  // Spanish
  "el", "la", "los", "las", "un", "una", "de", "del", "en", "con", "por",
  "para", "que", "se", "su", "sus", "y", "o", "al",
]);

// Minimum token length kept in a family key. Drops short fragments that add
// noise without disambiguating a story family — EXCEPT the curated 2-char
// abbreviations below, which carry real geo/political meaning.
const FAMILY_MIN_TOKEN_LEN = 3;

// Meaningful 2-char tokens kept despite the min-length floor. Small + explicit so
// it can't accidentally admit random 2-char noise (e.g. "to", "no" are caught by
// the stopword set; everything else stays dropped).
const FAMILY_SHORT_TOKEN_ALLOWLIST = new Set([
  "us", "eu", "uk", "un", "id", "ai",
]);

// Keep a token in the family key when it clears the length floor OR is an
// allowlisted short abbreviation. Stopword filtering is applied separately.
function keepFamilyToken(token) {
  return (
    token.length >= FAMILY_MIN_TOKEN_LEN ||
    (token.length === 2 && FAMILY_SHORT_TOKEN_ALLOWLIST.has(token))
  );
}

// Fold diacritics to their base letters (NFD decompose + strip combining marks)
// so accented and unaccented surface forms collapse to one token —
// `elección`→`eleccion`, `Bogotá`→`bogota`. Pure string transform.
function stripDiacritics(text) {
  return text.normalize("NFD").replace(/\p{M}+/gu, "");
}

// ── Text surfaces ─────────────────────────────────────────────────────────────

// Headline text used for the family key. Prefers translated English
// (`normalizedHeadline`) when present so two outlets — one already translated —
// can still share a family; falls back to the raw `headline`.
function pickHeadlineText(item) {
  const norm =
    typeof item?.normalizedHeadline === "string" ? item.normalizedHeadline.trim() : "";
  if (norm) return norm;
  return typeof item?.headline === "string" ? item.headline : String(item?.headline ?? "");
}

// Text surface for topic/keyword scoring. Favors normalized English evidence
// (`normalizedHeadline` / `normalizedBody`) when available — mirroring the
// translation-first recall behavior — and falls back to the raw fields. Geo fit
// is NOT sourced from here: `scoreGeoFit` reads raw fields internally because the
// geo stage runs before translation.
function pickScoringText(item) {
  const headline =
    typeof item?.normalizedHeadline === "string" && item.normalizedHeadline.trim()
      ? item.normalizedHeadline
      : String(item?.headline ?? "");
  const bodySrc =
    item?.normalizedBody != null && String(item.normalizedBody).toString().trim()
      ? item.normalizedBody
      : item?.body;
  const body = Array.isArray(bodySrc) ? bodySrc.join(" ") : String(bodySrc ?? "");
  const subtitle = String(item?.subtitle ?? "");
  return `${headline} ${subtitle} ${body}`.trim();
}

// ── 1. Headline family key ────────────────────────────────────────────────────

/**
 * Coarse "same story family" key for pre-cluster corroboration. Lowercases the
 * (preferably normalized) headline, strips punctuation, drops stopwords and very
 * short tokens, and joins the SORTED remainder so word-order variants between
 * outlets collapse to the same key. Returns `""` when nothing usable remains
 * (callers treat an empty key as "no family" — never corroborated).
 */
export function computeHeadlineFamilyKey(item) {
  const raw = pickHeadlineText(item);
  if (!raw || typeof raw !== "string") return "";
  const tokens = stripDiacritics(raw.toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => keepFamilyToken(t) && !FAMILY_STOPWORDS.has(t));
  if (tokens.length === 0) return "";
  // Sort for word-order independence; dedupe so a repeated token doesn't skew it.
  return [...new Set(tokens)].sort().join(" ");
}

// ── 2. Pool index (single O(n) scan) ──────────────────────────────────────────

/**
 * Build the reusable lookup index used by per-item scoring. Performs the ONE pool
 * scan (O(n)) that per-item scoring then reads with O(1) lookups, protecting
 * latency in the Step 1.3 hot path. Returns:
 *   - `familyCounts`     Map<familyKey, count>  (peers sharing a headline family)
 *   - `topicMatchCount`  pool-level count of items whose text matched a topic
 *   - `keywordMatchCount` pool-level count of items whose text matched a keyword
 *   - `size`             number of items scanned
 * Stable with empty / non-array input (returns zeroed stats and an empty map).
 */
export function buildPreClusterPoolIndex(items, settings) {
  const familyCounts = new Map();
  let topicMatchCount = 0;
  let keywordMatchCount = 0;
  const list = Array.isArray(items) ? items : [];

  for (const item of list) {
    const key = computeHeadlineFamilyKey(item);
    if (key) familyCounts.set(key, (familyCounts.get(key) ?? 0) + 1);

    const text = pickScoringText(item);
    if (scoreTopicFit(text, settings).hits > 0) topicMatchCount += 1;
    if (scoreKeywordFit(text, settings).hits > 0) keywordMatchCount += 1;
  }

  return { familyCounts, topicMatchCount, keywordMatchCount, size: list.length };
}

// ── 3. Topic / keyword / geo fit ──────────────────────────────────────────────

/**
 * Structured item-level fits in [0, 1] plus geo detail metadata. Reuses the
 * policy primitives:
 *   - topicFit:   max of soft `scoreTopicFit` over text and a structured
 *                 `item.topic` tag match (so a tagged-but-text-thin item still
 *                 scores on its topic).
 *   - keywordFit: soft `scoreKeywordFit` over text.
 *   - geoFit:     `scoreGeoFit` score; `hardFail` / `geoReason` / `geoCategory`
 *                 surfaced for callers (the wiring step may drop hard-fails).
 */
export function computeItemTopicKeywordGeoFit(item, settings) {
  const text = pickScoringText(item);
  const topicSoft = scoreTopicFit(text, settings).score;
  const topicTag = topicMatchesSettings(item?.topic ?? "", settings) ? 1 : 0;
  const topicFit = clamp01(Math.max(topicSoft, topicTag));
  const keywordFit = clamp01(scoreKeywordFit(text, settings).score);

  const geo = scoreGeoFit(item, settings);
  return {
    topicFit,
    keywordFit,
    geoFit: clamp01(geo.score),
    hardFail: !!geo.hardFail,
    geoReason: geo.reason,
    geoCategory: geo.category,
  };
}

// ── 4. Beat density (corroboration proxy) ─────────────────────────────────────

// Saturation constant for beat density: with K peers needed for a half value,
// density rises quickly for the first few corroborating sources then flattens,
// avoiding runaway values for a very large same-family burst.
const BEAT_DENSITY_HALF_SATURATION = 2;

/**
 * Corroboration proxy in [0, 1]: how many pool peers share this item's headline
 * family. Saturating (`peers / (peers + K)`) so it can't run away. An item with
 * no usable family key, or with no peers, scores 0.
 */
export function computeBeatDensity(item, poolIndex) {
  const key = computeHeadlineFamilyKey(item);
  if (!key) return 0;
  const counts = poolIndex?.familyCounts;
  const count = counts instanceof Map ? counts.get(key) ?? 0 : 0;
  const peers = Math.max(0, count - 1); // exclude the item itself
  if (peers === 0) return 0;
  return peers / (peers + BEAT_DENSITY_HALF_SATURATION);
}

// ── 5. Composite pre-cluster relevance score ──────────────────────────────────

/**
 * Combine the item-level signals into a single deterministic pre-cluster score
 * (higher = more relevant, survives the cap first). Mirrors the policy module's
 * `computeRelevanceScore` weighting (`RELEVANCE_WEIGHTS`) with two intentional
 * pre-cluster substitutions:
 *   - entity term is 0 (no grounded cluster entities exist yet), and
 *   - corroboration is the headline-family `beatDensity` proxy rather than a
 *     grounded distinct-source count.
 * Beat-fit and freshness ride along as soft shapers. Returns the score plus the
 * component breakdown, the family key, and the fields the comparator needs.
 * Pure; no I/O.
 */
export function computePreClusterRelevanceScore(item, settings, poolIndex) {
  const { topicFit, keywordFit, geoFit, hardFail, geoReason, geoCategory } =
    computeItemTopicKeywordGeoFit(item, settings);

  const corroboration = clamp01(computeBeatDensity(item, poolIndex));
  const beatFit = clamp01(scoreBeatFit(item, settings).score);
  const freshness = freshnessFromMinutes(item?.minutesAgo);
  const headlineFamilyKey = computeHeadlineFamilyKey(item);

  // Decision 5C: election-cycle geo proximity shaping (signed, in score units).
  const electionGeoClass = classifyElectionGeoFromFit(item, settings, { geoFit, hardFail });
  const electionGeoBoost = electionGeoBoostFor(electionGeoClass);

  const W = RELEVANCE_WEIGHTS;
  const preClusterScore =
    W.topic * topicFit +
    W.keyword * keywordFit +
    W.entity * 0 + // intentional: no grounded cluster entities pre-cluster
    W.geo * geoFit +
    W.corroboration * corroboration +
    W.beatFit * beatFit +
    W.freshness * freshness +
    electionGeoBoost; // Decision 5C lift/dampen (0 for non-election)

  return {
    preClusterScore,
    components: {
      topicFit,
      keywordFit,
      geoFit,
      entityFit: 0,
      corroboration,
      beatFit,
      freshness,
      electionGeoBoost,
    },
    electionGeoClass,
    isElectionCycle: isElectionCycleItem(item),
    headlineFamilyKey,
    // Fields consumed by `comparePreClusterRank` (carried for a stable sort).
    beatFitScore: beatFit,
    corroborationScore: corroboration,
    minutesAgo:
      typeof item?.minutesAgo === "number" && Number.isFinite(item.minutesAgo)
        ? item.minutesAgo
        : Number.POSITIVE_INFINITY,
    sourceId: item?.sourceId ?? "",
    hardFail,
    geoReason,
    geoCategory,
  };
}

// ── 6. Deterministic descending comparator ────────────────────────────────────

/**
 * Survival comparator for pre-cluster ranking. Operates on the sort keys returned
 * by `computePreClusterRelevanceScore`. Negative → `a` ranks ahead of `b`.
 * Deterministic tie-break order (every step is total + stable):
 *   1. higher `preClusterScore`
 *   2. higher corroboration / source-density (`corroborationScore`)
 *   3. higher `beatFitScore`
 *   4. fresher (`minutesAgo` lower)
 *   5. `sourceId` ascending (final stable tie-break)
 * Pure; exported for unit testing.
 */
export function comparePreClusterRank(a, b) {
  const as = Number.isFinite(a?.preClusterScore) ? a.preClusterScore : 0;
  const bs = Number.isFinite(b?.preClusterScore) ? b.preClusterScore : 0;
  if (as !== bs) return bs - as; // higher score first

  const ac = Number.isFinite(a?.corroborationScore) ? a.corroborationScore : 0;
  const bc = Number.isFinite(b?.corroborationScore) ? b.corroborationScore : 0;
  if (ac !== bc) return bc - ac; // more corroboration first

  const abf = Number.isFinite(a?.beatFitScore) ? a.beatFitScore : 0;
  const bbf = Number.isFinite(b?.beatFitScore) ? b.beatFitScore : 0;
  if (abf !== bbf) return bbf - abf; // higher beat-fit first

  const am = Number.isFinite(a?.minutesAgo) ? a.minutesAgo : Number.POSITIVE_INFINITY;
  const bm = Number.isFinite(b?.minutesAgo) ? b.minutesAgo : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm; // fresher first

  const aid = a?.sourceId ?? "";
  const bid = b?.sourceId ?? "";
  if (aid < bid) return -1;
  if (aid > bid) return 1;
  return 0;
}
