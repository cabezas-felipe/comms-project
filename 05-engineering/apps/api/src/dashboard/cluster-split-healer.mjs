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
// Slice 1 deliberately does NOT wire this into refresh-pipeline. It ships as a
// unit-tested module only.

import {
  GEOGRAPHY_ALIASES,
  GEOGRAPHY_SYNONYMS,
  resolveGeographyAlias,
} from "../contracts-runtime/index.mjs";
import { generateMetaStoryId } from "../ai/cluster-engine.mjs";

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

// Evidence text used for overlap scoring: headline + first 1-2 body lines.
function evidenceText(item) {
  const headline = typeof item?.headline === "string" ? item.headline : "";
  return [headline, ...bodyLines(item, 2)].filter(Boolean).join(" ");
}

function extractiveSubtitle(item) {
  const lines = bodyLines(item, 1);
  if (lines.length > 0) return lines[0];
  if (typeof item?.headline === "string" && item.headline.trim()) return item.headline.trim();
  return "";
}

function extractiveSummary(item, fallbackTitle) {
  const headline = typeof item?.headline === "string" && item.headline.trim() ? item.headline.trim() : fallbackTitle;
  const lines = bodyLines(item, 2);
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

// All pairwise overlaps strictly below threshold → the cluster's items share
// (almost) no topical tokens once geography is removed.
function allPairwiseBelowThreshold(items, geoStopTokens, threshold) {
  const tokenSets = items.map((it) => evidenceTokenSet(evidenceText(it), geoStopTokens));
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) return false;
    }
  }
  return true;
}

// Build one meta-story per source item from a split.
function buildSplitStory(sourceId, item, parentTags) {
  const title =
    typeof item?.headline === "string" && item.headline.trim()
      ? item.headline.trim()
      : String(sourceId);
  const subtitle = extractiveSubtitle(item) || title;
  const summary = extractiveSummary(item, title);
  const tags =
    parentTags && typeof parentTags === "object"
      ? {
          topics: Array.isArray(parentTags.topics) ? [...parentTags.topics] : [],
          keywords: Array.isArray(parentTags.keywords) ? [...parentTags.keywords] : [],
          geographies: Array.isArray(parentTags.geographies) ? [...parentTags.geographies] : [],
        }
      : { topics: [], keywords: [], geographies: [] };
  const story = {
    title,
    subtitle,
    source_item_ids: [sourceId],
    summary,
    tags,
    factual_claims: [title],
    claim_evidence_map: { "0": [sourceId] },
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

    let reason = null;
    if (allPairwiseBelowThreshold(items, geoStopTokens, threshold)) {
      reason = "low_token_overlap";
    } else if (isDisjointSingleSource(story?.claim_evidence_map)) {
      reason = "disjoint_claim_evidence";
    }

    if (!reason) {
      out.push(story);
      continue;
    }

    for (let i = 0; i < ids.length; i += 1) {
      out.push(buildSplitStory(ids[i], items[i], story?.tags));
    }
    diagnostics.splitCount += 1;
    diagnostics.splitReasons[reason] += 1;
  }

  diagnostics.outputCount = out.length;
  return { stories: out, diagnostics };
}
