// Post-cluster split healer (Slice 1).
//
// Clustering (LLM or fallback) occasionally over-merges unrelated stories that
// happen to share a country — e.g. a Colombia election story and a Colombia
// mine-attack story land in one meta-story because "Colombia" dominates the
// signal. This module is a pure, deterministic post-pass that detects such
// over-merges and splits them back into one meta-story per source item.
//
// It is intentionally narrow and side-effect free: no network calls, no
// pipeline imports beyond the stable `generateMetaStoryId` helper. The only
// signals it uses are (a) pairwise token-Jaccard overlap on evidence text with
// geography tokens stripped (so a shared country cannot mask a real split), and
// (b) a disjoint single-source claim_evidence_map shape (each claim grounded in
// its own lone source, no source reused) — the structural fingerprint of two
// independent stories stitched together.
//
// Corroboration guard: the low-overlap path is suppressed when the cluster's
// claim_evidence_map corroborates a shared claim (any claim grounded in ≥2
// sources). Low lexical overlap is noisy — two articles about the same event
// can share few literal tokens — so a corroborated cluster is treated as one
// legitimate story regardless of token overlap. The disjoint path is the
// reliable over-merge detector and is left untouched.
//
// A3 (split less aggressively + ambiguous-defer + bundling). Two refinements to
// the Phase-1 policy layered on top of the two triggers above:
//
//   1. `low_token_overlap` is gated to NORMALIZED ENGLISH evidence. Token
//      overlap on raw Spanish (or mixed-language, un-translated) text is
//      cross-language noise — a shared-country-only Spanish cluster can score
//      low overlap for the wrong reason. So the low-overlap split only fires
//      when every source carries usable English evidence (English-native OR
//      successfully translated). A non-English cluster that LOOKS over-merged on
//      raw text but cannot be confirmed in English is NOT atomized in Phase 1 —
//      it is returned unchanged and FLAGGED (`_reclusterCandidate`) for the
//      Phase-2 deferred re-cluster pass. `disjoint_claim_evidence` is structural
//      (ID-based) and stays language-independent.
//
//   2. When a split fires we BUNDLE by overlap instead of always atomizing one
//      story per source: sources are grouped into connected components by
//      pairwise overlap, so an over-merge of [electionA, electionB, mineC]
//      becomes [electionA+electionB] + [mineC] (2 stories), not 3. If bundling
//      reunifies every source into a single component (the claim map said
//      "independent" but the text says "one story"), the conflict is treated as
//      ambiguous and deferred, never atomized.
//
// The healer runs as a post-cluster pass in refresh-pipeline (after clustering,
// before ID lineage); `TEMPO_CLUSTER_SPLIT_HEALER_ENABLED=false` is the instant
// rollback. The split policy itself stays pure and deterministic.

import {
  GEOGRAPHY_ALIASES,
  GEOGRAPHY_SYNONYMS,
  resolveGeographyAlias,
} from "../contracts-runtime/index.mjs";
import { generateMetaStoryId } from "../ai/cluster-engine.mjs";
import { readHeadline, readBody, isNonEnglishItem } from "../ingestion/evidence-translator.mjs";
import { RELEVANCE_LEXICON } from "./relevance-policy.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_ENABLED = true;
const DEFAULT_JACCARD_THRESHOLD = 0.15;

function parseEnvBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseEnvFloat(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Resolve the cluster-split-healer configuration from env (with optional
 * per-call overrides for tests, mirroring the resolver convention used by
 * `resolveSemanticBeatFitConfig`).
 *
 *   TEMPO_CLUSTER_SPLIT_HEALER_ENABLED      (default true)
 *   TEMPO_CLUSTER_SPLIT_JACCARD_THRESHOLD   (default 0.15)
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{ enabled?: boolean, jaccardThreshold?: number }} [overrides]
 * @returns {{ enabled: boolean, jaccardThreshold: number }}
 */
export function resolveClusterSplitConfig(env = process.env, overrides = {}) {
  const enabled =
    typeof overrides.enabled === "boolean"
      ? overrides.enabled
      : parseEnvBool(env?.TEMPO_CLUSTER_SPLIT_HEALER_ENABLED, DEFAULT_ENABLED);
  const jaccardThreshold =
    typeof overrides.jaccardThreshold === "number" && Number.isFinite(overrides.jaccardThreshold)
      ? Math.max(0, overrides.jaccardThreshold)
      : parseEnvFloat(env?.TEMPO_CLUSTER_SPLIT_JACCARD_THRESHOLD, DEFAULT_JACCARD_THRESHOLD);
  return { enabled, jaccardThreshold };
}

// ─── Tokenization ───────────────────────────────────────────────────────────

// Short / common function words that carry no topical signal. Kept tiny and
// deterministic — this is a structural split heuristic, not an NLP pipeline.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "has", "have", "had", "will",
  "with", "from", "that", "this", "into", "over", "after", "before", "amid",
  "its", "his", "her", "their", "they", "but", "not", "out", "who", "what",
  "how", "why", "you", "our", "your", "say", "says", "said", "new", "more",
  "than", "all", "can", "may", "now", "one", "two", "amp",
]);

const MIN_TOKEN_LEN = 3;

// Split text into normalized tokens: lowercase, punctuation stripped, unicode
// letters/digits only (so accented forms like "bogotá" survive).
function rawTokenize(text) {
  const matches = String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

/**
 * Build the set of geography tokens to strip so a shared country alone cannot
 * keep two unrelated stories merged. Covers: the configured geography names,
 * their GEOGRAPHY_SYNONYMS surface forms, and any GEOGRAPHY_ALIASES key that
 * resolves to a configured geography (e.g. "bogota", "medellin" → Colombia).
 * Each surface form is itself tokenized so multi-word names ("new york",
 * "united states") strip word-by-word.
 *
 * @param {{ geographies?: string[] }} settings
 * @returns {Set<string>}
 */
export function buildGeographyStopTokens(settings) {
  const configured = Array.isArray(settings?.geographies) ? settings.geographies : [];
  const stop = new Set();
  const addAllTokens = (surface) => {
    for (const tok of rawTokenize(surface)) stop.add(tok);
  };

  for (const geo of configured) {
    if (typeof geo !== "string" || !geo.trim()) continue;
    addAllTokens(geo);
    // Synonyms (case-insensitive key lookup, matching resolveGeographyAlias).
    const synsKey = Object.keys(GEOGRAPHY_SYNONYMS).find(
      (k) => k.toLowerCase() === geo.trim().toLowerCase()
    );
    if (synsKey) {
      for (const syn of GEOGRAPHY_SYNONYMS[synsKey]) addAllTokens(syn);
    }
  }

  // Aliases that resolve (gated on the configured list) to a configured geo.
  for (const aliasKey of Object.keys(GEOGRAPHY_ALIASES)) {
    if (resolveGeographyAlias(aliasKey, configured)) addAllTokens(aliasKey);
  }

  return stop;
}

// Tokenize evidence text into a Set, dropping stopwords, short tokens, and
// geography tokens.
function evidenceTokenSet(text, geoStopTokens) {
  const set = new Set();
  for (const tok of rawTokenize(text)) {
    if (tok.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(tok)) continue;
    if (geoStopTokens.has(tok)) continue;
    set.add(tok);
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

// ─── Q3B: election-cycle theme bundling ───────────────────────────────────────
//
// Same-country UNRELATED events (election + mine attack) must still split — that
// safety behavior is unchanged. But an over-merge of multiple pieces from the
// SAME election cycle (a presidential race: debate, ballot, runoff, candidates,
// campaign) should be BUNDLED into one meta-story rather than atomized into
// single-source rows. To do that deterministically, two over-merged sources that
// SHARE an election-cycle concept token are treated as connected during bundling
// (an extra edge in `overlapComponents`), in addition to the existing token-
// Jaccard edge. A source that carries NO election token (e.g. a mine attack)
// never gains a theme edge, so it still splits out — the unrelated-event contract
// is preserved.
//
// The token set is seeded from the shared relevance lexicon (the election cycle:
// election / vote / ballot / presidential / candidate / campaign / runoff, in
// English AND Spanish surface forms) so it can't drift from the recall/scoring
// vocabulary, plus a few strongly-electoral extras. Generic tokens that only
// appear inside multi-word phrases ("second round") are excluded so they cannot
// create a false theme edge.
const ELECTION_CYCLE_LEXICON_KEYS = new Set([
  "election",
  "vote",
  "ballot",
  "presidential",
  "candidate",
  "campaign",
  "runoff",
]);

// Tokens to drop even though they appear in an election-cycle lexicon phrase —
// too generic to signal the theme on their own (e.g. "second"/"round" from
// "second round").
const ELECTION_TOKEN_DENYLIST = new Set(["second", "round"]);

// Strongly-electoral terms not represented as their own lexicon cluster.
const ELECTION_CYCLE_EXTRA_TOKENS = [
  "debate", "debates", "electorate", "incumbent",
  "comicios", "sondeo", "sondeos", "encuesta", "encuestas",
];

// Build the curated election-cycle token set once at module load. Each lexicon
// surface form is tokenized the SAME way evidence is (so multi-word ES forms
// like "segunda vuelta" contribute "segunda"/"vuelta"), then filtered by the
// minimum length and the generic denylist.
function buildElectionCycleTokens() {
  const set = new Set();
  const add = (surface) => {
    for (const tok of rawTokenize(surface)) {
      if (tok.length < MIN_TOKEN_LEN) continue;
      if (ELECTION_TOKEN_DENYLIST.has(tok)) continue;
      set.add(tok);
    }
  };
  for (const cluster of RELEVANCE_LEXICON) {
    if (!ELECTION_CYCLE_LEXICON_KEYS.has(cluster.key)) continue;
    for (const w of cluster.en) add(w);
    for (const w of cluster.es) add(w);
  }
  for (const t of ELECTION_CYCLE_EXTRA_TOKENS) add(t);
  return set;
}

const ELECTION_CYCLE_TOKENS = buildElectionCycleTokens();

// The subset of an item's evidence tokens that are election-cycle concepts.
function electionCycleTokensOf(tokenSet) {
  const e = new Set();
  for (const t of tokenSet) if (ELECTION_CYCLE_TOKENS.has(t)) e.add(t);
  return e;
}

// Two over-merged sources belong to the same election theme when they SHARE at
// least one election-cycle concept token. Deterministic; symmetric.
function sharesElectionCycle(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) return true;
  return false;
}

// ─── Evidence extraction (deterministic, no model calls) ──────────────────────

function bodyLines(item, n) {
  if (Array.isArray(item?.body)) {
    return item.body.filter((l) => typeof l === "string" && l.trim()).slice(0, n);
  }
  if (typeof item?.body === "string" && item.body.trim()) return [item.body.trim()];
  return [];
}

// Raw evidence text (original fields): headline + first 1-2 body lines. Used
// only for the un-normalized over-merge SMELL check on non-English clusters
// (which is flagged for deferral, never used to atomize).
function evidenceText(item) {
  const headline = typeof item?.headline === "string" ? item.headline : "";
  return [headline, ...bodyLines(item, 2)].filter(Boolean).join(" ");
}

// Body lines read through the normalized evidence readers so a translated
// (English) body is preferred when present and the untouched originals are used
// otherwise. Shared by the split-story OUTPUT path and the A3 normalized-English
// overlap scoring.
function readBodyLines(item, n) {
  return readBody(item)
    .filter((l) => typeof l === "string" && l.trim())
    .map((l) => l.trim())
    .slice(0, n);
}

// Normalized-English evidence text used for the A3 `low_token_overlap` scoring
// and bundling: prefers translated English (normalizedHeadline/Body) and falls
// back to the originals for English-native items.
function englishEvidenceText(item) {
  const headline = readHeadline(item);
  return [headline, ...readBodyLines(item, 2)].filter(Boolean).join(" ");
}

// A3 language gate: a source carries usable English evidence when it was
// successfully translated (normalizedHeadline/Body present) OR it is
// English-native (no translation needed). A non-English item that was NOT
// translated has only raw foreign text — token overlap on it is untrustworthy.
function itemHasEnglishEvidence(item) {
  // A missing/invalid source-item lookup carries NO usable English evidence —
  // never let it pass the gate (otherwise `!isNonEnglishItem(undefined)` would
  // read as English and could admit a low-overlap split that grounding later
  // drops anyway).
  if (!item || typeof item !== "object") return false;
  const normHeadline =
    typeof item?.normalizedHeadline === "string" && item.normalizedHeadline.trim().length > 0;
  const normBody = Array.isArray(item?.normalizedBody) && item.normalizedBody.length > 0;
  if (normHeadline || normBody) return true;
  return !isNonEnglishItem(item);
}

function extractiveSubtitle(item) {
  const lines = readBodyLines(item, 1);
  if (lines.length > 0) return lines[0];
  const headline = readHeadline(item).trim();
  return headline || "";
}

function extractiveSummary(item, fallbackTitle) {
  const headline = readHeadline(item).trim() || fallbackTitle;
  const lines = readBodyLines(item, 2);
  const parts = [headline, ...lines].filter(Boolean);
  return parts.join(". ");
}

// ─── Split detection ──────────────────────────────────────────────────────────

// True when every claim group is a single source and no source is reused across
// groups, with at least two groups covering at least two distinct sources. This
// is the fingerprint of independent stories stitched into one cluster: each
// claim stands on its own lone source with no corroboration shared between them.
function isDisjointSingleSource(claimEvidenceMap) {
  if (!claimEvidenceMap || typeof claimEvidenceMap !== "object") return false;
  const groups = Object.values(claimEvidenceMap).filter((g) => Array.isArray(g));
  if (groups.length < 2) return false;
  const seen = new Set();
  let distinct = 0;
  for (const group of groups) {
    const ids = group.filter((id) => typeof id === "string" && id);
    if (ids.length !== 1) return false; // not single-source style
    const id = ids[0];
    if (seen.has(id)) return false; // source reused across groups → corroborated
    seen.add(id);
    distinct += 1;
  }
  return distinct >= 2;
}

// True when the cluster's own evidence map corroborates a shared claim — i.e.
// at least one claim group cites ≥2 distinct sources. Corroboration is the
// clustering stage telling us "these sources back the SAME claim", which is the
// signature of a single legitimate story even when the sources happen to share
// few literal tokens (e.g. two Colombia-election articles, one headlined around
// "ballot/vote" and the other around "campaign/rally"). This guards the noisy
// `low_token_overlap` path from splitting such corroborated clusters; the
// `disjoint_claim_evidence` path is unaffected (it already requires every group
// to be single-source, which is the opposite of corroboration).
function claimEvidenceCorroborates(claimEvidenceMap) {
  if (!claimEvidenceMap || typeof claimEvidenceMap !== "object") return false;
  for (const group of Object.values(claimEvidenceMap)) {
    if (!Array.isArray(group)) continue;
    const distinct = new Set(group.filter((id) => typeof id === "string" && id));
    if (distinct.size >= 2) return true;
  }
  return false;
}

// Build per-item token sets for overlap scoring. `useEnglish` selects the
// normalized-English evidence (A3 low-overlap + bundling); raw evidence is used
// only for the non-English over-merge smell check.
function evidenceTokenSets(items, geoStopTokens, useEnglish) {
  return items.map((it) =>
    evidenceTokenSet(useEnglish ? englishEvidenceText(it) : evidenceText(it), geoStopTokens)
  );
}

// All pairwise overlaps strictly below threshold → the cluster's items share
// (almost) no topical tokens once geography is removed.
function allPairwiseBelowThreshold(items, geoStopTokens, threshold, useEnglish) {
  const tokenSets = evidenceTokenSets(items, geoStopTokens, useEnglish);
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) return false;
    }
  }
  return true;
}

// Group source indices into connected components where an edge exists between
// two items iff their token-Jaccard overlap is ≥ threshold (geography stripped).
// Deterministic union-find; components are returned in first-appearance order,
// each as an array of original indices. Items that overlap no one are singletons.
// This is the bundling primitive: a split emits one meta-story per component, so
// related sources stay together instead of atomizing one-per-source.
function overlapComponents(items, geoStopTokens, threshold, useEnglish) {
  const n = items.length;
  const tokenSets = evidenceTokenSets(items, geoStopTokens, useEnglish);
  // Q3B: per-item election-cycle concept tokens, used to add a theme edge so
  // same-cycle election pieces bundle even when their literal token overlap is
  // below threshold. Non-election sources have an empty set → never theme-linked.
  const electionTokens = tokenSets.map(electionCycleTokensOf);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // Edge when literal token overlap clears the threshold OR the two sources
      // share an election-cycle concept (same-theme bundling). The theme edge
      // only ADDS connectivity — it can merge components, never split them, so
      // an unrelated event (no election token) is never pulled into a bundle.
      const linked =
        jaccard(tokenSets[i], tokenSets[j]) >= threshold ||
        sharesElectionCycle(electionTokens[i], electionTokens[j]);
      if (linked) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const groups = new Map();
  const order = [];
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    if (!groups.has(r)) {
      groups.set(r, []);
      order.push(r);
    }
    groups.get(r).push(i);
  }
  return order.map((r) => groups.get(r));
}

function cloneParentTags(parentTags) {
  return parentTags && typeof parentTags === "object"
    ? {
        topics: Array.isArray(parentTags.topics) ? [...parentTags.topics] : [],
        keywords: Array.isArray(parentTags.keywords) ? [...parentTags.keywords] : [],
        geographies: Array.isArray(parentTags.geographies) ? [...parentTags.geographies] : [],
      }
    : { topics: [], keywords: [], geographies: [] };
}

// Build ONE meta-story from a component of source items. A singleton component
// reproduces the original one-per-source split shape exactly (claims=[title],
// claim_evidence_map={"0":[id]}); a multi-source bundle carries one factual
// claim per source, each grounded in its own source id, so the bundle stays
// grounded under verifyGrounding. Extractive + deterministic — no model calls.
function buildStoryFromComponent(componentIds, componentItems, parentTags) {
  const tags = cloneParentTags(parentTags);
  const first = componentItems[0];
  const firstId = componentIds[0];
  const title = readHeadline(first).trim() || String(firstId);

  const factual_claims = [];
  const claim_evidence_map = {};
  componentItems.forEach((it, i) => {
    const claim = readHeadline(it).trim() || String(componentIds[i]);
    factual_claims.push(claim);
    claim_evidence_map[String(i)] = [componentIds[i]];
  });

  const subtitle = extractiveSubtitle(first) || title;
  const summary =
    componentItems.length === 1
      ? extractiveSummary(first, title)
      : factual_claims.join(". ");

  const story = {
    title,
    subtitle,
    source_item_ids: [...componentIds],
    summary,
    tags,
    factual_claims,
    claim_evidence_map,
  };
  return { meta_story_id: generateMetaStoryId(story), ...story };
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Detect and split over-merged meta-stories. Pure and deterministic.
 *
 * @param {Array<object>} metaStories          clustered meta-stories
 * @param {Map<string,object>|Record<string,object>} sourceItemsById  sourceId → item
 * @param {{ geographies?: string[] }} settings
 * @param {{ enabled?: boolean, jaccardThreshold?: number }} [config]  resolved config override
 * @returns {{ stories: object[], diagnostics: object }}
 */
export function splitOverMergedClusters(metaStories, sourceItemsById, settings, config) {
  const cfg = config && typeof config === "object" ? config : resolveClusterSplitConfig();
  const enabled = cfg.enabled !== false;
  const threshold = Number.isFinite(cfg.jaccardThreshold)
    ? Math.max(0, cfg.jaccardThreshold)
    : DEFAULT_JACCARD_THRESHOLD;

  const input = Array.isArray(metaStories) ? metaStories : [];
  const inputCount = input.length;

  const diagnostics = {
    enabled,
    inputCount,
    outputCount: inputCount,
    splitCount: 0,
    splitReasons: { low_token_overlap: 0, disjoint_claim_evidence: 0 },
    // A3 additive diagnostics (non-breaking — existing consumers ignore these):
    //   deferredCount       — clusters left intact but flagged for Phase-2
    //                         deferred re-cluster (ambiguous, not atomized).
    //   deferReasons        — why each defer happened.
    //   bundledStoryCount   — multi-source stories emitted by a split (bundling
    //                         kept related sources together vs atomizing).
    //   reclusterCandidateIds — meta_story_ids flagged for the deferred pass.
    deferredCount: 0,
    deferReasons: { ambiguous_unnormalized_overlap: 0, ambiguous_overlap_conflict: 0 },
    bundledStoryCount: 0,
    reclusterCandidateIds: [],
  };

  if (!enabled) {
    return { stories: input, diagnostics };
  }

  // Normalize the lookup into a getter that tolerates Map or plain object.
  const getItem =
    sourceItemsById instanceof Map
      ? (id) => sourceItemsById.get(id)
      : (id) => (sourceItemsById && typeof sourceItemsById === "object" ? sourceItemsById[id] : undefined);

  const geoStopTokens = buildGeographyStopTokens(settings);
  const out = [];

  for (const story of input) {
    const ids = Array.isArray(story?.source_item_ids)
      ? story.source_item_ids.filter((id) => typeof id === "string" && id)
      : [];

    // Single-source (or malformed) meta-stories cannot be over-merged.
    if (ids.length < 2) {
      out.push(story);
      continue;
    }

    const items = ids.map((id) => getItem(id));

    // Corroborated clusters (a claim grounded in ≥2 sources) are legitimate
    // single stories even when their headlines share few literal tokens — the
    // low-overlap path must not split them. The disjoint path stays available
    // (it requires single-source-per-claim, which is never corroboration).
    const corroborated = claimEvidenceCorroborates(story?.claim_evidence_map);
    const disjoint = isDisjointSingleSource(story?.claim_evidence_map);
    // A3 language gate: the low-overlap trigger may only score NORMALIZED
    // ENGLISH evidence. Require every source to carry usable English evidence.
    const allEnglish = items.every((it) => itemHasEnglishEvidence(it));

    // Trigger resolution (precedence preserved from Slice 2: low_token_overlap
    // is evaluated before disjoint so a low-overlap cluster reports the lexical
    // reason). The low-overlap trigger is now gated to all-English clusters.
    let reason = null; // a SPLIT reason
    let deferReason = null; // an ambiguous DEFER reason (no split, flag for Phase 2)

    if (!corroborated && allEnglish && allPairwiseBelowThreshold(items, geoStopTokens, threshold, true)) {
      reason = "low_token_overlap";
    } else if (disjoint) {
      reason = "disjoint_claim_evidence";
    } else if (
      !corroborated &&
      !allEnglish &&
      allPairwiseBelowThreshold(items, geoStopTokens, threshold, false)
    ) {
      // Looks over-merged on raw text, but the evidence is not normalized
      // English, so the low overlap can't be trusted (cross-language noise).
      // Defer to Phase-2 re-cluster instead of atomizing in Phase 1.
      deferReason = "ambiguous_unnormalized_overlap";
    }

    if (deferReason) {
      out.push({ ...story, _reclusterCandidate: true, _reclusterReason: deferReason });
      diagnostics.deferredCount += 1;
      diagnostics.deferReasons[deferReason] += 1;
      if (story?.meta_story_id) diagnostics.reclusterCandidateIds.push(story.meta_story_id);
      continue;
    }

    if (!reason) {
      out.push(story);
      continue;
    }

    // Bundle by overlap rather than atomizing one story per source. Use the
    // normalized-English evidence when the cluster is fully English; otherwise
    // (disjoint path on un-translated text) fall back to raw evidence.
    const components = overlapComponents(items, geoStopTokens, threshold, allEnglish);

    if (components.length < 2) {
      // The claim map said "independent" but the text reunified into a single
      // component — conflicting signals. Don't atomize; keep the cluster intact
      // and flag it for the deferred re-cluster pass.
      out.push({
        ...story,
        _reclusterCandidate: true,
        _reclusterReason: "ambiguous_overlap_conflict",
      });
      diagnostics.deferredCount += 1;
      diagnostics.deferReasons.ambiguous_overlap_conflict += 1;
      if (story?.meta_story_id) diagnostics.reclusterCandidateIds.push(story.meta_story_id);
      continue;
    }

    for (const comp of components) {
      const compIds = comp.map((idx) => ids[idx]);
      const compItems = comp.map((idx) => items[idx]);
      out.push(buildStoryFromComponent(compIds, compItems, story?.tags));
      if (compIds.length > 1) diagnostics.bundledStoryCount += 1;
    }
    diagnostics.splitCount += 1;
    diagnostics.splitReasons[reason] += 1;
  }

  diagnostics.outputCount = out.length;
  return { stories: out, diagnostics };
}

// ─── Phase 4.1: election same-event cross-cluster bundle merge ─────────────────
//
// The split-healer above only ever SPLITS a single over-merged cluster; it never
// reunifies meta-stories that clustering emitted SEPARATELY. So same-event
// election coverage that the clusterer fragmented across clusters (bilingual
// headline variation, weak entity overlap, wording drift between wires) stays
// fragmented — two rows for one event.
//
// This pass closes that gap deterministically, with PRECISION-FIRST guards so it
// can only ever bundle genuinely-same-event configured-geo election coverage and
// can never resurrect a wrong-geo / wrong-beat / different-facet over-merge:
//
//   1. ELECTION-CYCLE ONLY — both stories must carry an election-cycle concept
//      token (same ELECTION_CYCLE_TOKENS set the within-split bundler uses). A
//      non-election story has no election token → never an edge. (wrong-beat)
//   2. CONFIGURED-GEO ONLY — both stories must name a configured geography
//      (a geoStopToken appears in their raw evidence). A cross-country election
//      ("Peru election", no Colombia mention) never matches → cross-country and
//      wrong-geo coverage is never merged. (wrong-geo; also inert when settings
//      configure no geographies → empty stop set → no merges.)
//   3. SAME EVENT, NOT SAME CYCLE — the merge edge requires HIGH Jaccard on the
//      SPECIFIC token set (evidence tokens with geography AND generic
//      election-cycle tokens removed). Same-event coverage shares its specifics
//      (candidate names, "tax reform", the venue); different FACETS of one cycle
//      (debate vs ballot-count vs turnout) share only the generic election
//      vocabulary, which is stripped, so they stay separate.
//
// `_reclusterCandidate`-flagged stories (ambiguous, awaiting the deferred pass)
// are passed through untouched — never merged. Pure + deterministic; the only
// new signal is a higher Jaccard threshold reusing the existing primitives.

const DEFAULT_ELECTION_BUNDLE_ENABLED = true;
// Deliberately high (vs the split threshold 0.15): this gate decides SAME EVENT,
// so it must clear specific-token overlap, not mere topical relatedness. Scored
// on SOURCE HEADLINES (not bodies), where the distinctive event signal — the
// candidate names + topic phrase — concentrates and wording noise is minimal.
const DEFAULT_ELECTION_BUNDLE_JACCARD_THRESHOLD = 0.34;
// A same-event pair must ALSO share at least this many distinctive (non-geo,
// non-generic-election) tokens. Different facets of one cycle share ~0 — they
// only have the generic election vocabulary in common, which is stripped — so
// this count is the precision backstop behind the Jaccard floor.
const ELECTION_BUNDLE_MIN_SHARED_SPECIFIC = 2;
const ELECTION_BUNDLE_DIAG_SAMPLE = 10;

/**
 * Resolve the election same-event bundle config from env (with test overrides),
 * mirroring `resolveClusterSplitConfig`.
 *
 *   TEMPO_ELECTION_BUNDLE_ENABLED            (default true)
 *   TEMPO_ELECTION_BUNDLE_JACCARD_THRESHOLD  (default 0.34)
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{ enabled?: boolean, jaccardThreshold?: number }} [overrides]
 * @returns {{ enabled: boolean, jaccardThreshold: number }}
 */
export function resolveElectionBundleConfig(env = process.env, overrides = {}) {
  const enabled =
    typeof overrides.enabled === "boolean"
      ? overrides.enabled
      : parseEnvBool(env?.TEMPO_ELECTION_BUNDLE_ENABLED, DEFAULT_ELECTION_BUNDLE_ENABLED);
  const jaccardThreshold =
    typeof overrides.jaccardThreshold === "number" && Number.isFinite(overrides.jaccardThreshold)
      ? Math.max(0, overrides.jaccardThreshold)
      : parseEnvFloat(
          env?.TEMPO_ELECTION_BUNDLE_JACCARD_THRESHOLD,
          DEFAULT_ELECTION_BUNDLE_JACCARD_THRESHOLD
        );
  return { enabled, jaccardThreshold };
}

// True when any source item's RAW evidence names a configured geography (one of
// the geography stop tokens appears). Distinguishes configured-geo election
// coverage (mentions "Colombia"/"Bogotá") from cross-country ("Peru election").
function storyMentionsConfiguredGeo(items, geoStopTokens) {
  if (geoStopTokens.size === 0) return false;
  for (const it of items) {
    if (!it) continue;
    for (const tok of rawTokenize(evidenceText(it))) {
      if (geoStopTokens.has(tok)) return true;
    }
  }
  return false;
}

// Per-story signals used by the merge gate. `specific` is the SOURCE HEADLINE
// token set with geography AND generic election-cycle tokens removed — the event
// fingerprint (candidate names + topic phrase). `isElection` is derived from the
// full evidence (headline + body) so an election story whose headline is terse
// still qualifies; `mentionsGeo` is the configured-geo gate.
function electionBundleSignals(items, geoStopTokens) {
  const headlineText = items.map((it) => readHeadline(it)).filter(Boolean).join(" ");
  const headlineTokens = evidenceTokenSet(headlineText, geoStopTokens); // geo + stopwords stripped
  const specific = new Set();
  for (const t of headlineTokens) if (!ELECTION_CYCLE_TOKENS.has(t)) specific.add(t);

  // Election-cycle membership uses the broader evidence (headline + 2 body lines)
  // so a headline that omits the literal election word still classifies.
  const fullText = items.map((it) => englishEvidenceText(it)).filter(Boolean).join(" ");
  const isElection = electionCycleTokensOf(evidenceTokenSet(fullText, geoStopTokens)).size > 0;

  return {
    specific,
    isElection,
    mentionsGeo: storyMentionsConfiguredGeo(items, geoStopTokens),
  };
}

// Count of distinct specific tokens two stories share.
function sharedSpecificCount(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small) if (large.has(t)) n += 1;
  return n;
}

function unionDedup(...arrays) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      if (typeof v !== "string" || !v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// Merge a connected component of same-event meta-stories into one. Deterministic:
// the "primary" (most sources, ties broken by smallest meta_story_id) supplies
// the headline/subtitle; claims/evidence are concatenated and re-indexed so the
// merged story stays grounded (every claim still cites only its own sources).
function buildMergedElectionStory(componentStories) {
  const primary = componentStories
    .slice()
    .sort((a, b) => {
      const sa = Array.isArray(a.source_item_ids) ? a.source_item_ids.length : 0;
      const sb = Array.isArray(b.source_item_ids) ? b.source_item_ids.length : 0;
      if (sb !== sa) return sb - sa;
      return String(a.meta_story_id ?? "").localeCompare(String(b.meta_story_id ?? ""));
    })[0];

  const source_item_ids = unionDedup(
    ...componentStories.map((s) => (Array.isArray(s.source_item_ids) ? s.source_item_ids : []))
  );

  const idSet = new Set(source_item_ids);
  const factual_claims = [];
  const claim_evidence_map = {};
  let k = 0;
  for (const s of componentStories) {
    const claims = Array.isArray(s.factual_claims) ? s.factual_claims : [];
    const cem = s.claim_evidence_map && typeof s.claim_evidence_map === "object" ? s.claim_evidence_map : {};
    claims.forEach((claim, i) => {
      const evidence = Array.isArray(cem[String(i)])
        ? cem[String(i)].filter((id) => typeof id === "string" && idSet.has(id))
        : [];
      // Skip a claim whose evidence didn't survive into the merged source set
      // (defensive — should not happen since we union every source).
      if (evidence.length === 0) return;
      factual_claims.push(typeof claim === "string" ? claim : String(claim));
      claim_evidence_map[String(k)] = evidence;
      k += 1;
    });
  }

  const tags = cloneParentTags({
    topics: unionDedup(...componentStories.map((s) => s?.tags?.topics)),
    keywords: unionDedup(...componentStories.map((s) => s?.tags?.keywords)),
    geographies: unionDedup(...componentStories.map((s) => s?.tags?.geographies)),
  });

  const associated_entities = unionDedup(
    ...componentStories.map((s) => (Array.isArray(s.associated_entities) ? s.associated_entities : []))
  );

  const story = {
    title: typeof primary.title === "string" && primary.title.trim() ? primary.title : String(source_item_ids[0]),
    subtitle: typeof primary.subtitle === "string" ? primary.subtitle : "",
    source_item_ids,
    summary: typeof primary.summary === "string" && primary.summary.trim()
      ? primary.summary
      : factual_claims.join(". "),
    tags,
    factual_claims,
    claim_evidence_map,
  };
  if (associated_entities.length > 0) story.associated_entities = associated_entities;
  return { meta_story_id: generateMetaStoryId(story), ...story };
}

/**
 * Bundle same-event configured-geo election meta-stories that clustering emitted
 * separately. Pure and deterministic. Runs AFTER `splitOverMergedClusters`.
 *
 * @param {Array<object>} metaStories
 * @param {Map<string,object>|Record<string,object>} sourceItemsById
 * @param {{ geographies?: string[] }} settings
 * @param {{ enabled?: boolean, jaccardThreshold?: number }} [config]
 * @returns {{ stories: object[], diagnostics: object }}
 */
export function mergeElectionEventBundles(metaStories, sourceItemsById, settings, config) {
  const cfg = config && typeof config === "object" ? config : resolveElectionBundleConfig();
  const enabled = cfg.enabled !== false;
  const threshold = Number.isFinite(cfg.jaccardThreshold)
    ? Math.max(0, cfg.jaccardThreshold)
    : DEFAULT_ELECTION_BUNDLE_JACCARD_THRESHOLD;

  const input = Array.isArray(metaStories) ? metaStories : [];
  const diagnostics = {
    enabled,
    inputCount: input.length,
    outputCount: input.length,
    mergedGroupCount: 0, // number of multi-story bundles formed
    mergedStoryCount: 0, // number of input stories absorbed into a bundle
    threshold,
    mergedBundleIds: [], // resulting bundle meta_story_ids (bounded sample)
  };

  if (!enabled || input.length < 2) {
    return { stories: input, diagnostics };
  }

  const getItem =
    sourceItemsById instanceof Map
      ? (id) => sourceItemsById.get(id)
      : (id) => (sourceItemsById && typeof sourceItemsById === "object" ? sourceItemsById[id] : undefined);

  const geoStopTokens = buildGeographyStopTokens(settings);

  // Index of stories ELIGIBLE to merge (clean, configured-geo, election-cycle).
  // Everything else passes through verbatim, in original position.
  const eligibleIdx = [];
  const signals = new Array(input.length).fill(null);
  input.forEach((story, idx) => {
    if (story?._reclusterCandidate) return; // ambiguous → never merge
    const ids = Array.isArray(story?.source_item_ids)
      ? story.source_item_ids.filter((id) => typeof id === "string" && id)
      : [];
    if (ids.length === 0) return;
    const items = ids.map((id) => getItem(id)).filter(Boolean);
    if (items.length === 0) return;
    const sig = electionBundleSignals(items, geoStopTokens);
    if (!sig.isElection || !sig.mentionsGeo || sig.specific.size === 0) return;
    signals[idx] = sig;
    eligibleIdx.push(idx);
  });

  if (eligibleIdx.length < 2) {
    return { stories: input, diagnostics };
  }

  // Union-find over eligible stories; edge iff specific-token Jaccard ≥ threshold.
  const parent = new Map(eligibleIdx.map((i) => [i, i]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const next = parent.get(x);
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (let a = 0; a < eligibleIdx.length; a += 1) {
    for (let b = a + 1; b < eligibleIdx.length; b += 1) {
      const i = eligibleIdx[a];
      const j = eligibleIdx[b];
      // Same-event edge: enough shared distinctive tokens AND a Jaccard floor.
      // Both gates protect precision — a couple of incidentally-shared tokens in
      // long headlines won't clear the ratio, and high-ratio-but-thin overlaps
      // (1 shared token) won't clear the count.
      const shared = sharedSpecificCount(signals[i].specific, signals[j].specific);
      const linked =
        shared >= ELECTION_BUNDLE_MIN_SHARED_SPECIFIC &&
        jaccard(signals[i].specific, signals[j].specific) >= threshold;
      if (linked) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent.set(Math.max(ri, rj), Math.min(ri, rj));
      }
    }
  }

  // Group eligible stories by component root, preserving first-appearance order.
  const groups = new Map();
  for (const idx of eligibleIdx) {
    const r = find(idx);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(idx);
  }

  // Build output in original order: at each component's FIRST index emit the
  // merged story (or the lone passthrough); skip the absorbed members.
  const absorbed = new Set();
  for (const members of groups.values()) {
    if (members.length >= 2) {
      for (const m of members.slice(1)) absorbed.add(m);
    }
  }

  const out = [];
  for (let idx = 0; idx < input.length; idx += 1) {
    if (absorbed.has(idx)) continue;
    const root = parent.has(idx) ? find(idx) : null;
    const members = root !== null ? groups.get(root) : null;
    if (members && members.length >= 2 && members[0] === idx) {
      const merged = buildMergedElectionStory(members.map((m) => input[m]));
      out.push(merged);
      diagnostics.mergedGroupCount += 1;
      diagnostics.mergedStoryCount += members.length;
      if (diagnostics.mergedBundleIds.length < ELECTION_BUNDLE_DIAG_SAMPLE) {
        diagnostics.mergedBundleIds.push(merged.meta_story_id);
      }
    } else {
      out.push(input[idx]);
    }
  }

  diagnostics.outputCount = out.length;
  return { stories: out, diagnostics };
}
