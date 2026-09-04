// Single policy module for language-level relevance: lexicon-driven topic /
// keyword soft-widen and deterministic geo fit. No LLM calls live here — every
// function is a pure, synchronous decision over an item's text + the user's
// settings, so it can run anywhere in the pipeline (including the geo stage,
// before any provider call) and be unit-tested in isolation.
//
// Two concerns:
//
//   1. A small bilingual LEXICON (English morphological proximity +
//      English↔Spanish translation pairs) that widens recall and scores
//      topic/keyword fit. The Spanish pairs (e.g. `elecciones` ↔ `election`,
//      `campaña` ↔ `campaign`) are RECALL WIDENERS — they map a Spanish surface
//      form onto the user's English concept. They are deliberately NOT entity
//      names: a widener never asserts an item is about a specific place/person,
//      only that the concept is present.
//
//   2. `scoreGeoFit` — deterministic geo relevance reusing the
//      EXPLICIT_CONFLICT categorization from `geo-filter.mjs` and the lexical
//      matcher from `geo-lexical-match.mjs`. Returns `{ hardFail: true }` for an
//      unambiguous explicit geo conflict (item is tagged with geographies, none
//      configured, and its text names none of the configured ones) and a 0–1
//      `score` otherwise.
//
// ── Translation boundary (IMPORTANT) ──────────────────────────────────────────
// The recall gate (`applyTopicKeywordFilter`) reads NORMALIZED-ENGLISH evidence
// and must stay in lockstep with the translation-first architecture (Slice 14):
// a Spanish item only clears recall once translation has surfaced the English
// keyword. Therefore `buildKeywordMatchRegex` (the recall-widen regex) expands
// ONLY with English morphological forms — the Spanish surface forms in the
// lexicon are NEVER folded into that regex, because doing so would let an
// untranslated Spanish item bypass the translation gate. The Spanish forms power
// the soft `scoreKeywordFit` / `scoreTopicFit` scores only, which run as a
// language-agnostic signal rather than a recall gate.

import { GEO_CATEGORY, categorizeItem } from "./geo-filter.mjs";
import {
  buildPlainTokenRegex,
  itemMentionsConfiguredGeography,
} from "./geo-lexical-match.mjs";
import { normalizeTopicLabel } from "../contracts-runtime/index.mjs";

// ── Lexicon ───────────────────────────────────────────────────────────────────
//
// Each entry is one CONCEPT cluster. `en` lists English morphological variants
// (singular/plural/derived word-forms of the same root); `es` lists the Spanish
// translation surface forms that map onto it. Clusters are intentionally narrow:
// `election` and `candidate` are SEPARATE clusters, not one "elections beat", so
// widening the keyword "election" never silently pulls in "candidate"/"campaign"
// (that would over-admit and erase the geo-only recall signal downstream relies
// on). Add new concepts as discrete clusters rather than enlarging existing ones.
export const RELEVANCE_LEXICON = Object.freeze([
  {
    key: "election",
    en: ["election", "elections", "electoral"],
    es: ["elección", "elecciones", "electoral", "electorales"],
  },
  {
    key: "vote",
    en: ["vote", "votes", "voting", "voter", "voters"],
    es: ["voto", "votos", "votación", "votante", "votantes"],
  },
  {
    key: "ballot",
    en: ["ballot", "ballots"],
    es: ["papeleta", "papeletas", "tarjetón"],
  },
  {
    key: "presidential",
    en: ["presidential", "president"],
    es: ["presidencial", "presidenciales", "presidente"],
  },
  {
    key: "candidate",
    en: ["candidate", "candidates", "candidacy"],
    es: ["candidato", "candidatos", "candidata", "candidatas", "candidatura"],
  },
  {
    key: "campaign",
    en: ["campaign", "campaigns", "campaigning"],
    es: ["campaña", "campañas"],
  },
  {
    key: "runoff",
    // `segunda vuelta` ("second round") is the Spanish recall widener for a
    // presidential runoff — a concept widener, not the name of any contest.
    en: ["runoff", "runoffs", "second round"],
    es: ["segunda vuelta", "balotaje"],
  },
  {
    key: "migration",
    en: ["migration", "migrant", "migrants", "immigration", "immigrant", "immigrants"],
    es: ["migración", "migraciones", "migrante", "migrantes", "inmigración", "inmigrante"],
  },
  {
    key: "security",
    en: ["security"],
    es: ["seguridad"],
  },
  {
    key: "outbreak",
    en: ["outbreak", "outbreaks"],
    es: ["brote", "brotes"],
  },
]);

// Find the lexicon cluster a term belongs to, matching on the cluster key or any
// of its English / Spanish surface forms (case-insensitive). Returns null when
// the term is not in the lexicon (callers fall back to the bare term).
export function lexiconClusterFor(term) {
  const t = String(term ?? "").trim().toLowerCase();
  if (!t) return null;
  for (const cluster of RELEVANCE_LEXICON) {
    if (cluster.key === t) return cluster;
    if (cluster.en.some((w) => w.toLowerCase() === t)) return cluster;
    if (cluster.es.some((w) => w.toLowerCase() === t)) return cluster;
  }
  return null;
}

// All surface forms (the term itself + its cluster's EN + ES variants) for a
// single configured term. Used by the *scoring* path, which is language-agnostic.
function allVariantsFor(term) {
  const t = String(term ?? "").trim();
  const variants = new Set();
  if (t) variants.add(t);
  const cluster = lexiconClusterFor(t);
  if (cluster) {
    for (const w of cluster.en) variants.add(w);
    for (const w of cluster.es) variants.add(w);
  }
  return [...variants];
}

// English-only surface forms (term + cluster's EN variants). Used by the
// recall-widen regex, which must not introduce Spanish forms (see the
// translation-boundary note in the module header). EN↔ES *homographs* — forms
// that are spelled identically in both languages (e.g. "electoral") — are
// excluded too: keeping them would let an untranslated Spanish item match the
// English regex and bypass the translation gate, which is exactly what the
// English-only restriction exists to prevent. The bare configured term itself is
// always kept (the user typed it as their keyword).
function englishVariantsFor(term) {
  const t = String(term ?? "").trim();
  const variants = new Set();
  if (t) variants.add(t);
  const cluster = lexiconClusterFor(t);
  if (cluster) {
    const esForms = new Set(cluster.es.map((w) => w.toLowerCase()));
    for (const w of cluster.en) {
      if (esForms.has(w.toLowerCase())) continue; // skip EN↔ES homographs
      variants.add(w);
    }
  }
  return [...variants];
}

// ── Keyword / topic soft-widen ────────────────────────────────────────────────

/**
 * Build a single case-insensitive whole-word regex matching any configured
 * keyword OR its English morphological lexicon variants. Returns null when no
 * usable keyword is configured. Spanish forms are deliberately excluded — this
 * regex runs over normalized-English recall evidence (see module header). Drop-in
 * widening of the legacy `buildKeywordTokenRegex`: exact keywords still match;
 * the lexicon only ADDS English variants.
 */
export function buildKeywordMatchRegex(settings) {
  const keywords = settings?.keywords ?? [];
  const terms = new Set();
  for (const kw of keywords) {
    for (const v of englishVariantsFor(kw)) terms.add(v);
  }
  return buildPlainTokenRegex([...terms]);
}

/**
 * Soft keyword-fit score over arbitrary (possibly untranslated) text. For each
 * configured keyword, a hit on ANY of its lexicon variants (English OR Spanish)
 * counts. Score is the fraction of configured keywords with at least one hit, in
 * [0, 1]. Returns `{ score, matched, hits }`. Unlike `buildKeywordMatchRegex`
 * this is a *scoring* signal, not a recall gate, so Spanish forms are in scope.
 */
export function scoreKeywordFit(text, settings) {
  const keywords = (settings?.keywords ?? [])
    .map((k) => String(k ?? "").trim())
    .filter(Boolean);
  if (keywords.length === 0) return { score: 0, matched: [], hits: 0 };
  const hay = String(text ?? "");
  const matched = [];
  for (const kw of keywords) {
    const re = buildPlainTokenRegex(allVariantsFor(kw));
    if (re && re.test(hay)) matched.push(kw);
  }
  return { score: matched.length / keywords.length, matched, hits: matched.length };
}

// Expanded set of acceptable normalized topic labels (lowercased) for the
// configured topics: each topic's canonical label plus, when it maps to a
// lexicon cluster, that cluster's EN + ES surface forms. Lets an item topic that
// is a sibling surface form of a configured topic still count as a topic match.
export function expandTopicLabels(settings) {
  const out = new Set();
  for (const t of settings?.topics ?? []) {
    const norm = normalizeTopicLabel(t);
    if (!norm) continue;
    out.add(norm.toLowerCase());
    const cluster = lexiconClusterFor(norm);
    if (cluster) {
      for (const w of cluster.en) out.add(w.toLowerCase());
      for (const w of cluster.es) out.add(w.toLowerCase());
    }
  }
  return out;
}

/**
 * Does this item's topic match the configured topics — exactly (canonical
 * `normalizeTopicLabel`, original behavior) OR via a lexicon-expanded sibling
 * surface form? Returns false when no topics are configured. Used by BOTH the
 * recall filter and its diagnostics so the two never disagree.
 */
export function topicMatchesSettings(itemTopic, settings) {
  const topics = settings?.topics ?? [];
  if (topics.length === 0) return false;
  const norm = normalizeTopicLabel(itemTopic ?? "");
  // Exact canonical match — preserves the legacy (case-sensitive) behavior.
  for (const t of topics) {
    if (normalizeTopicLabel(t) === norm) return true;
  }
  // Additive lexicon widen (case-insensitive cluster overlap).
  return expandTopicLabels(settings).has(norm.toLowerCase());
}

/**
 * Soft topic-fit score over arbitrary text. For each configured topic, a hit on
 * the topic label OR any of its lexicon variants (EN/ES) counts. Score is the
 * fraction of configured topics with at least one hit, in [0, 1].
 */
export function scoreTopicFit(text, settings) {
  const topics = (settings?.topics ?? [])
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);
  if (topics.length === 0) return { score: 0, matched: [], hits: 0 };
  const hay = String(text ?? "");
  const matched = [];
  for (const topic of topics) {
    const re = buildPlainTokenRegex(allVariantsFor(topic));
    if (re && re.test(hay)) matched.push(topic);
  }
  return { score: matched.length / topics.length, matched, hits: matched.length };
}

// ── Geo fit ───────────────────────────────────────────────────────────────────

// Common demonyms for partial geo credit. A demonym ("Colombian", "Kenyan") is
// softer evidence than naming the country itself, so it scores below a literal
// mention but still prevents a hard-fail. Kept small + explicit (no derivation
// rule) so it can't accidentally fire on unrelated tokens.
const GEO_DEMONYMS = Object.freeze({
  colombia: ["colombian", "colombians"],
  kenya: ["kenyan", "kenyans"],
  venezuela: ["venezuelan", "venezuelans"],
  mexico: ["mexican", "mexicans"],
  ecuador: ["ecuadorian", "ecuadorians"],
  panama: ["panamanian", "panamanians"],
  brazil: ["brazilian", "brazilians"],
  peru: ["peruvian", "peruvians"],
  "united states": ["american", "americans"],
  us: ["american", "americans"],
});

// Text surface for geo fit. Mirrors the geo stage's `joinGeoText`
// (headline + subtitle + body + url) but reads RAW fields only: the geo stage
// runs before translation, so no normalized-English evidence exists yet.
function joinGeoFitText(item) {
  const headline = String(item?.headline ?? "");
  const subtitle = String(item?.subtitle ?? "");
  const body = Array.isArray(item?.body) ? item.body.join(" ") : String(item?.body ?? "");
  const url = typeof item?.url === "string" ? item.url : "";
  return `${headline} ${subtitle} ${body} ${url}`.trim();
}

// First configured geography whose demonym appears in `text`, or null.
function mentionsConfiguredDemonym(text, configuredGeos) {
  for (const geo of configuredGeos) {
    const demonyms = GEO_DEMONYMS[String(geo).trim().toLowerCase()];
    if (!demonyms) continue;
    const re = buildPlainTokenRegex(demonyms);
    if (re && re.test(text)) return geo;
  }
  return null;
}

/**
 * Deterministic geo relevance for a single item against the configured
 * geographies. No LLM call. Returns:
 *   { hardFail, score, category, reason }
 *
 * - No configured geographies → never a hard-fail; score 0, geo-agnostic.
 * - Explicit field overlap (EXPLICIT_MATCH)        → score 1.0.
 * - Configured geography named in text (lexical)   → score 0.9.
 * - Configured-geography demonym in text           → score 0.7.
 * - EXPLICIT_CONFLICT with none of the above       → { hardFail: true }, score 0.
 *   (Item is tagged with geographies, none configured, and its text names none
 *   of the configured ones — a confident, drop-worthy off-geography signal.)
 * - IMPLICIT_GEO with no lexical/demonym evidence  → score 0.5, ambiguous; NOT a
 *   hard-fail (absence of a geo tag is not a conflict).
 *
 * The lexical + demonym checks run BEFORE the EXPLICIT_CONFLICT verdict so a
 * mislabeled item that still clearly discusses a configured geography is never
 * hard-failed.
 */
export function scoreGeoFit(item, settings) {
  const configured = settings?.geographies ?? [];
  if (configured.length === 0) {
    return { hardFail: false, score: 0, category: "no_configured_geo", reason: "no_configured_geo" };
  }

  const category = categorizeItem(item, configured);
  if (category === GEO_CATEGORY.EXPLICIT_MATCH) {
    return { hardFail: false, score: 1, category, reason: "explicit_match" };
  }

  const text = joinGeoFitText(item);
  const lexicalGeo = itemMentionsConfiguredGeography(text, configured);
  if (lexicalGeo) {
    return { hardFail: false, score: 0.9, category, reason: `geo_text_match:${lexicalGeo}` };
  }
  const demonymGeo = mentionsConfiguredDemonym(text, configured);
  if (demonymGeo) {
    return { hardFail: false, score: 0.7, category, reason: `geo_demonym_match:${demonymGeo}` };
  }

  if (category === GEO_CATEGORY.EXPLICIT_CONFLICT) {
    return { hardFail: true, score: 0, category, reason: "explicit_conflict" };
  }
  // IMPLICIT_GEO with no textual geo evidence — ambiguous, keep it.
  return { hardFail: false, score: 0.5, category, reason: "implicit_geo" };
}

// ── Story relevance + overflow survival ranking (Q1 B1 / Q3A) ─────────────────
//
// Deterministic, pure scoring over a clustering meta-story's grounded output
// (tags + `associated_entities`) and its source-set stats. Feeds the overflow
// survival cap so a story that genuinely matches the user's configured beat
// survives over generic geography-only noise — WITHOUT any new hot-path LLM
// call. All inputs are the existing cluster output + settings; the entity signal
// is the grounded `associated_entities` array (no static curated roster).

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Read a meta-story (or a bare tags object) into normalized tag + entity arrays.
// Accepts either `{ tags: {topics,keywords,geographies}, associated_entities }`
// or a bare `{ topics, keywords, geographies }` so callers can pass a story or
// just its tags.
function readStoryTagsEntities(storyOrTags) {
  const src = storyOrTags ?? {};
  const tags =
    src.tags && typeof src.tags === "object"
      ? src.tags
      : src.topics || src.keywords || src.geographies
        ? src
        : {};
  const entities = Array.isArray(src.associated_entities) ? src.associated_entities : [];
  return {
    topics: Array.isArray(tags.topics) ? tags.topics.map((s) => String(s ?? "")) : [],
    keywords: Array.isArray(tags.keywords) ? tags.keywords.map((s) => String(s ?? "")) : [],
    geographies: Array.isArray(tags.geographies) ? tags.geographies.map((s) => String(s ?? "")) : [],
    entities: entities.map((s) => String(s ?? "")),
  };
}

// 1 when any configured topic is corroborated by the story's topic tags (exact
// canonical or lexicon sibling) OR by its entity evidence; else 0.
function tagTopicFit(topics, entities, settings) {
  if ((settings?.topics ?? []).length === 0) return 0;
  if (topics.some((t) => topicMatchesSettings(t, settings))) return 1;
  return scoreTopicFit(entities.join(" "), settings).hits > 0 ? 1 : 0;
}

// 1 when any configured keyword (lexicon-aware) appears in the story's keyword
// tags or entity evidence; else 0.
function tagKeywordFit(keywords, entities, settings) {
  if ((settings?.keywords ?? []).length === 0) return 0;
  const text = [...keywords, ...entities].join(" ");
  return scoreKeywordFit(text, settings).hits > 0 ? 1 : 0;
}

// 1 when the story's geography tags overlap the configured set, or its
// geography/entity evidence names a configured geography; else 0.
function tagGeoFit(geographies, entities, settings) {
  const configured = settings?.geographies ?? [];
  if (configured.length === 0) return 0;
  const set = new Set(configured.map((g) => String(g).trim().toLowerCase()));
  if (geographies.some((g) => set.has(String(g).trim().toLowerCase()))) return 1;
  const text = [...geographies, ...entities].join(" ");
  return itemMentionsConfiguredGeography(text, configured) ? 1 : 0;
}

/**
 * Entity fit (Q1 B1): how well the story's GROUNDED entity evidence aligns with
 * the configured beat. The evidence surface is the cluster's `associated_entities`
 * (falling back to the tag values when a pre-cluster-v4 story omitted them, so
 * the signal degrades gracefully rather than collapsing to 0). Score is the
 * fraction of the configured dimensions (topics / keywords / geographies that are
 * actually set) which the entity evidence corroborates, in [0, 1]. Deterministic
 * and pure. Accepts a meta-story or a bare tags object.
 */
export function scoreEntityFit(storyOrTags, settings) {
  const { topics, keywords, geographies, entities } = readStoryTagsEntities(storyOrTags);
  const evidence = entities.length > 0 ? entities : [...topics, ...keywords, ...geographies];
  if (evidence.length === 0) return 0;
  const text = evidence.join(" ");

  const dims = [];
  if ((settings?.topics ?? []).length > 0) dims.push(scoreTopicFit(text, settings).hits > 0);
  if ((settings?.keywords ?? []).length > 0) dims.push(scoreKeywordFit(text, settings).hits > 0);
  if ((settings?.geographies ?? []).length > 0) {
    dims.push(!!itemMentionsConfiguredGeography(text, settings.geographies));
  }
  if (dims.length === 0) return 0;
  return dims.filter(Boolean).length / dims.length;
}

// Source corroboration: more distinct sources → higher value, saturating at 5
// (the per-story source cap). 0..1.
function corroborationScore(sourceCount) {
  const n = Number.isFinite(sourceCount) ? sourceCount : 0;
  return Math.min(Math.max(n, 0), 5) / 5;
}

// Freshness: gentle monotonic decay in minutesAgo, bounded (0, 1]. A 12h-ish
// scale keeps it a soft tie-shaper rather than a dominant term.
function freshnessScore(minMinutesAgo) {
  const m = Number.isFinite(minMinutesAgo) ? minMinutesAgo : Number.POSITIVE_INFINITY;
  if (m < 0 || !Number.isFinite(m)) return 0;
  return 1 / (1 + m / 720);
}

// Relevance weights. Ordered so configured-beat match (topic/keyword/entity)
// dominates geography, which dominates corroboration, beat-fit, and finally a
// small freshness shaper. This keeps a beat-matching story ahead of generic
// same-geography noise while staying deterministic.
export const RELEVANCE_WEIGHTS = Object.freeze({
  topic: 3,
  keyword: 3,
  entity: 2,
  geo: 1,
  corroboration: 1.5,
  beatFit: 1,
  freshness: 0.25,
});

/**
 * Combine the relevance signals into a single deterministic score (higher =
 * more relevant, survives the overflow cap first). Accepts either pre-computed
 * fit values OR a `{ story, settings }` pair from which the four fits are
 * derived (tags + grounded `associated_entities`). Remaining inputs:
 *   - sourceCount     — distinct grounded sources (corroboration)
 *   - maxBeatFitScore — best beat-fit across the story's sources (0..1)
 *   - minMinutesAgo   — freshest source age (lower = fresher)
 * Pure; no I/O, no LLM.
 */
export function computeRelevanceScore(input = {}) {
  const { story, settings } = input;
  const tags = readStoryTagsEntities(story ?? {});
  const topicFit =
    input.topicFit != null ? clamp01(input.topicFit) : tagTopicFit(tags.topics, tags.entities, settings);
  const keywordFit =
    input.keywordFit != null ? clamp01(input.keywordFit) : tagKeywordFit(tags.keywords, tags.entities, settings);
  const geoFit =
    input.geoFit != null ? clamp01(input.geoFit) : tagGeoFit(tags.geographies, tags.entities, settings);
  const entityFit =
    input.entityFit != null ? clamp01(input.entityFit) : scoreEntityFit(story ?? {}, settings);
  const corroboration = corroborationScore(input.sourceCount);
  const beatFit = clamp01(input.maxBeatFitScore);
  const freshness = freshnessScore(input.minMinutesAgo);

  const W = RELEVANCE_WEIGHTS;
  return (
    W.topic * topicFit +
    W.keyword * keywordFit +
    W.entity * entityFit +
    W.geo * geoFit +
    W.corroboration * corroboration +
    W.beatFit * beatFit +
    W.freshness * freshness
  );
}

/**
 * Decision 8C / Phase 2 · Step 2.1: is this meta-story ON-BEAT?
 *
 * A story is on-beat when it corroborates the user's configured editorial BEAT
 * through at least one of the TOPIC or KEYWORD dimensions (the same fits
 * `computeRelevanceScore` rewards), where the grounded `associated_entities` may
 * corroborate a topic/keyword concept:
 *   - `tagTopicFit`   — a topic tag (exact/lexicon) OR a topic concept in entities
 *   - `tagKeywordFit` — a configured keyword (lexicon-aware) in keyword tags/entities
 *
 * GEOGRAPHY is deliberately EXCLUDED from this classification: a story whose only
 * relevance comes from naming a configured geography (e.g. a Colombia weather or
 * volcano item under an elections beat) is GEO-ONLY / off-beat noise and returns
 * false. This is why `scoreEntityFit` is NOT used here — it folds the geo
 * dimension into its evidence and would mis-classify geo-only stories as on-beat.
 *
 * When NO topics AND NO keywords are configured the beat is undefined; there is
 * nothing to be "off" from, so every story is treated as on-beat (the guard must
 * never suppress against an empty beat). Pure; deterministic; no I/O. Exported so
 * the overflow guard and its tests can classify a story without re-deriving the
 * fit primitives.
 */
export function isStoryOnBeat(storyOrTags, settings) {
  const hasTopicBeat = (settings?.topics ?? []).length > 0;
  const hasKeywordBeat = (settings?.keywords ?? []).length > 0;
  if (!hasTopicBeat && !hasKeywordBeat) return true; // no beat configured
  const { topics, keywords, entities } = readStoryTagsEntities(storyOrTags);
  if (hasTopicBeat && tagTopicFit(topics, entities, settings) > 0) return true;
  if (hasKeywordBeat && tagKeywordFit(keywords, entities, settings) > 0) return true;
  return false;
}

/**
 * Survival comparator for the overflow cap (Q3A). Operates on per-story sort
 * keys carrying `{ relevanceScore, sourceCount, maxBeatFitScore, minMinutesAgo,
 * metaStoryId }`. Negative → `a` survives ahead of `b`. Primary key is the
 * relevance score (descending); the remaining keys are the SAME deterministic
 * tie-breaks the legacy `compareOverflowRank` used, so when relevance ties (or
 * is absent on a bare sort key) behavior is byte-stable.
 *
 * Corroboration (Q3B): `sourceCount` is the FIRST tie-break after relevance, so
 * a multi-source (corroborated) story always survives over a single-source peer
 * of equal relevance. Corroboration is also folded into `relevanceScore` itself
 * (see `computeRelevanceScore`), so it is rewarded twice over — as a continuous
 * value signal in the score AND as a deterministic tie-break here. Full order:
 * relevance → more sources → higher beat-fit → fresher → metaStoryId ascending.
 * Pure; exported for unit testing.
 */
export function compareSurvivalRank(a, b) {
  const ar = Number.isFinite(a?.relevanceScore) ? a.relevanceScore : 0;
  const br = Number.isFinite(b?.relevanceScore) ? b.relevanceScore : 0;
  if (ar !== br) return br - ar; // higher relevance survives
  const asc = Number.isFinite(a?.sourceCount) ? a.sourceCount : 0;
  const bsc = Number.isFinite(b?.sourceCount) ? b.sourceCount : 0;
  if (asc !== bsc) return bsc - asc; // corroboration: more sources survive first
  const abf = Number.isFinite(a?.maxBeatFitScore) ? a.maxBeatFitScore : 0;
  const bbf = Number.isFinite(b?.maxBeatFitScore) ? b.maxBeatFitScore : 0;
  if (abf !== bbf) return bbf - abf; // higher beat-fit first
  const am = Number.isFinite(a?.minMinutesAgo) ? a.minMinutesAgo : Number.POSITIVE_INFINITY;
  const bm = Number.isFinite(b?.minMinutesAgo) ? b.minMinutesAgo : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm; // fresher first
  const aid = a?.metaStoryId ?? "";
  const bid = b?.metaStoryId ?? "";
  if (aid < bid) return -1;
  if (aid > bid) return 1;
  return 0;
}
