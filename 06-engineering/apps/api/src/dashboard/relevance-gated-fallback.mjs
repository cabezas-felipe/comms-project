// Relevance-gated deterministic fallback story builder (Plan Step B1).
//
// Purpose: when LLM clustering TERMINALLY fails, the pipeline still needs
// *something* to show — but the legacy `gracefulFallbackClustering` groups by
// raw `item.topic` into "<Topic> Updates" buckets with NO relevance gate, which
// degrades trust posture (it can surface off-beat geography-only noise as a
// story). This module is the strict alternative: it builds SINGLETON meta-stories
// only from items that pass the same deterministic topic+keyword relevance bar
// the rest of the pipeline already enforces, ordered by the existing pre-cluster
// relevance scorer. No LLM, no embeddings, no network I/O — fully offline and
// deterministic so it is safe to run on the terminal-failure path.
//
// This module does NOT call `gracefulFallbackClustering` and does not weaken the
// trust posture: an item that does not clear the strict gate produces no story.
//
// Integration into `refresh-pipeline` is intentionally out of scope here (B2).

import {
  scoreTopicFit,
  scoreKeywordFit,
} from "./relevance-policy.mjs";
import {
  buildPreClusterPoolIndex,
  computePreClusterRelevanceScore,
  comparePreClusterRank,
} from "./pre-cluster-relevance.mjs";
import { generateMetaStoryId } from "../ai/cluster-engine.mjs";

// ── Text surface ──────────────────────────────────────────────────────────────

// Scoring text for the eligibility gate. Favors translated/normalized English
// (translation-first recall) and falls back to raw fields. The structured
// `item.topic` tag is folded in so a tagged-but-text-thin item can still clear
// topic fit, mirroring `computeItemTopicKeywordGeoFit`'s tag-aware behavior.
function pickGateText(item) {
  const headline =
    typeof item?.normalizedHeadline === "string" && item.normalizedHeadline.trim()
      ? item.normalizedHeadline
      : String(item?.headline ?? "");
  const bodySrc =
    item?.normalizedBody != null && String(item.normalizedBody).trim()
      ? item.normalizedBody
      : item?.body;
  const body = Array.isArray(bodySrc) ? bodySrc.join(" ") : String(bodySrc ?? "");
  const subtitle = String(item?.subtitle ?? "");
  const topic = String(item?.topic ?? "");
  return `${topic} ${headline} ${subtitle} ${body}`.trim();
}

// ── Eligibility gate (strict bar) ─────────────────────────────────────────────

// Defensive beat-fit guard. Callers pass beat-fit SURVIVORS (flat items carrying
// a `beatFitScore` marker). If a caller accidentally passes an EXCLUDED wrapper
// (`{ item, excludeReason, ... }` from `applyBeatFitFilter`), or an item with no
// usable `sourceId`, it is not a survivor and must not become a story.
function beatFitIncluded(item) {
  if (!item || typeof item !== "object") return false;
  // An excluded-wrapper shape leaks the beat-fit exclusion reason — reject it.
  if ("excludeReason" in item) return false;
  return true;
}

// Bucketed exclusion reasons (stable keys for diagnostics).
const EXCLUDED_REASONS = Object.freeze({
  NOT_BEAT_FIT: "not_beat_fit_included",
  MISSING_SOURCE_ID: "missing_source_id",
  NO_TOPIC_FIT: "no_topic_fit",
  NO_KEYWORD_FIT: "no_keyword_fit",
  OVER_CAP: "over_cap",
});

// Classify a single item against the strict bar. Returns null when eligible, or
// the bucket key of the FIRST failing condition otherwise. Order is fixed so the
// diagnostics are deterministic: structural guards first, then topic, then
// keyword (so a topic-fit-but-no-keyword item buckets as `no_keyword_fit`, and a
// keyword-fit-but-no-topic item buckets as `no_topic_fit`).
function classifyEligibility(item, settings) {
  if (!beatFitIncluded(item)) return EXCLUDED_REASONS.NOT_BEAT_FIT;

  const sourceId = item?.sourceId;
  if (typeof sourceId !== "string" || sourceId.trim() === "") {
    return EXCLUDED_REASONS.MISSING_SOURCE_ID;
  }

  const text = pickGateText(item);
  if (!(scoreTopicFit(text, settings).score > 0)) return EXCLUDED_REASONS.NO_TOPIC_FIT;
  if (!(scoreKeywordFit(text, settings).score > 0)) return EXCLUDED_REASONS.NO_KEYWORD_FIT;
  return null;
}

// ── Grounded tag / entity extraction ──────────────────────────────────────────

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// Build tags grounded in the source item + the configured settings. Topics and
// keywords are the configured terms the item actually matched (not the raw
// settings list), so the story's tags never assert a beat the evidence lacks.
// Geographies come from the item's own field intersected with the configured set
// (falling back to the item's geographies when none are configured).
function buildGroundedTags(item, settings) {
  const text = pickGateText(item);
  const topics = uniqueStrings([
    String(item?.topic ?? ""),
    ...scoreTopicFit(text, settings).matched,
  ]);
  const keywords = uniqueStrings(scoreKeywordFit(text, settings).matched);

  const itemGeos = Array.isArray(item?.geographies) ? item.geographies : [];
  const configured = settings?.geographies ?? [];
  let geographies;
  if (configured.length > 0) {
    const configuredSet = new Set(configured.map((g) => String(g).trim().toLowerCase()));
    geographies = uniqueStrings(
      itemGeos.filter((g) => configuredSet.has(String(g).trim().toLowerCase()))
    );
  } else {
    geographies = uniqueStrings(itemGeos);
  }

  return { topics, keywords, geographies };
}

// ── Story construction ────────────────────────────────────────────────────────

// Deterministic, extractive one-line summary for a singleton story. No
// "General Updates" style bucket phrasing — the summary is grounded in the
// source item's own outlet + headline.
function buildExtractiveSummary(item) {
  const outlet = String(item?.outlet ?? "").trim();
  const headline = String(item?.headline ?? "").trim();
  if (outlet && headline) return `${outlet} reports: ${headline}.`;
  if (headline) return `${headline}.`;
  return outlet ? `${outlet} report.` : "Source report.";
}

// Build one singleton meta-story from a single eligible item. Shape matches
// `metaStoryOutputSchema` (cluster-engine): exactly one source id, ≥1 factual
// claim, a claim→evidence map, grounded tags, and a deterministic id.
function buildSingletonStory(item, settings) {
  const sourceId = String(item.sourceId);
  const headline = String(item?.headline ?? "").trim();
  const outlet = String(item?.outlet ?? "").trim();
  const tags = buildGroundedTags(item, settings);

  // Extractive title/summary — deterministic, no generic bucket phrasing.
  const title = headline || (outlet ? `${outlet} report` : "Source report");
  const subtitle = outlet ? `Reported by ${outlet}.` : "Single-source report.";
  const claim = outlet && headline ? `${outlet} reports: ${headline}` : title;

  const story = {
    title,
    subtitle,
    source_item_ids: [sourceId],
    summary: buildExtractiveSummary(item),
    tags,
    // Grounded entities: the configured terms/geographies the item matched.
    // Purely extractive (no invention) so downstream relevance scoring has a
    // signal without violating the grounding contract.
    associated_entities: uniqueStrings([
      ...tags.topics,
      ...tags.keywords,
      ...tags.geographies,
    ]),
    factual_claims: [claim],
    claim_evidence_map: { "0": [sourceId] },
  };
  return { meta_story_id: generateMetaStoryId(story), ...story };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build strict, relevance-gated SINGLETON fallback meta-stories for the
 * terminal-clustering-failure path. Pure and deterministic — no LLM, embeddings,
 * or network I/O.
 *
 * @param {object}   params
 * @param {object[]} params.items               beat-fit SURVIVOR items (caller-supplied)
 * @param {object}   params.settings            user settings (topics/keywords/geographies)
 * @param {number}   [params.maxStories=5]       hard cap on emitted stories
 * @param {number}   [params.maxSourcesPerStory=1] sources per story (singleton-only here)
 * @returns {{ stories: object[], diagnostics: object }}
 *   `stories`     — deterministic, meta-story-shaped, ready for pipeline consumption
 *   `diagnostics` — `{ inputCount, eligibleCount, outputCount, excludedReasons }`
 *                   where `excludedReasons` is a bucketed count map.
 */
export function buildRelevanceGatedFallbackStories({
  items,
  settings,
  maxStories = 5,
  maxSourcesPerStory = 1,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const cap = Number.isFinite(maxStories) && maxStories > 0 ? Math.floor(maxStories) : 0;

  // Bucketed exclusion counts — every bucket key present (0 by default) so the
  // diagnostics contract is stable regardless of which reasons actually fired.
  const excludedReasons = {
    [EXCLUDED_REASONS.NOT_BEAT_FIT]: 0,
    [EXCLUDED_REASONS.MISSING_SOURCE_ID]: 0,
    [EXCLUDED_REASONS.NO_TOPIC_FIT]: 0,
    [EXCLUDED_REASONS.NO_KEYWORD_FIT]: 0,
    [EXCLUDED_REASONS.OVER_CAP]: 0,
  };

  // 1) Strict eligibility gate.
  const eligible = [];
  for (const item of list) {
    const reason = classifyEligibility(item, settings);
    if (reason) {
      excludedReasons[reason] += 1;
      continue;
    }
    eligible.push(item);
  }

  // 2) Deterministic ordering: pre-cluster relevance score descending, with the
  //    existing pre-cluster rank comparator's stable tie-breaks (corroboration →
  //    beat-fit → freshness → sourceId). Pool index is built over the eligible
  //    set so the corroboration proxy reflects this candidate pool.
  const poolIndex = buildPreClusterPoolIndex(eligible, settings);
  const ranked = eligible
    .map((item) => ({ item, key: computePreClusterRelevanceScore(item, settings, poolIndex) }))
    .sort((a, b) => comparePreClusterRank(a.key, b.key));

  // 3) Cap, then build singleton stories. Items beyond the cap bucket as OVER_CAP.
  const kept = ranked.slice(0, cap);
  const dropped = ranked.length - kept.length;
  if (dropped > 0) excludedReasons[EXCLUDED_REASONS.OVER_CAP] += dropped;

  const stories = kept.map(({ item }) => buildSingletonStory(item, settings));

  return {
    stories,
    diagnostics: {
      inputCount: list.length,
      eligibleCount: eligible.length,
      outputCount: stories.length,
      excludedReasons,
    },
  };
}
