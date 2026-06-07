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
      if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) {
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
