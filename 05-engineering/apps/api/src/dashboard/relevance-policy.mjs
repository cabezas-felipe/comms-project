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
