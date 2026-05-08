import { normalizeSourceItems } from "../ingestion/source-normalizer.mjs";
import {
  verifyGrounding,
  gracefulFallbackClustering,
  generateMetaStoryId,
} from "../ai/cluster-engine.mjs";
import { applyGeoFilter, mockAssessGeoConfidence } from "./geo-filter.mjs";
import { normalizeTopicLabel } from "@tempo/contracts";
import {
  resolveSelectedSources,
  buildMatchedOutletSet,
  filterItemsToMatchedFeeds,
  SELECTION_MODE,
} from "../ingestion/source-matcher.mjs";

// ─── Lineage continuity (prior-snapshot keyed merge) ─────────────────────────
//
// Why a Jaccard-based merge instead of pure evidence hashing:
//   A narrative evolves across refreshes — sources are added, others age out.
//   A pure hash of `sorted(source_item_ids)` changes the moment any source
//   joins/leaves, breaking metaStoryId continuity (and therefore title locks).
//   The MVP strategy here is "prior-snapshot keyed merge": after clustering,
//   each new meta-story is matched against last refresh's stories using
//   primary topic + Jaccard overlap on source IDs.  Exactly-one match → reuse
//   the prior metaStoryId.  Zero or ambiguous matches → assign a fresh
//   evidence-derived ID via generateMetaStoryId.
//
// Trade-offs (deliberate):
//   - Threshold 0.5 = at least half the union must overlap.  Strict enough to
//     prevent accidental merges when two distinct narratives happen to share
//     one or two articles; loose enough to track "+1 source" or "-1 source"
//     evolution (Jaccard 0.67 / 0.5 respectively).
//   - When two new stories both match the same prior story, only the first
//     claims it — subsequent ones fall through to fresh IDs.  Favors
//     fragmentation over accidental merge if continuity is unclear.
//   - Topic must match.  Same sources but different primary topic ⇒ different
//     narrative ⇒ new ID.

const LINEAGE_JACCARD_THRESHOLD = 0.5;

function jaccardOverlap(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Reuse metaStoryIds from prior snapshot when a new cluster represents the
 * same narrative (same topic + Jaccard ≥ threshold on source IDs).  Otherwise
 * fall back to evidence-derived hash via generateMetaStoryId.
 */
function reuseOrAssignIds(metaStories, priorStories) {
  if (!priorStories || priorStories.length === 0) {
    return metaStories.map((ms) => ({
      ...ms,
      meta_story_id: ms.meta_story_id ?? generateMetaStoryId(ms),
    }));
  }

  const priorIndex = priorStories.map((s) => ({
    metaStoryId: s.metaStoryId ?? s.id,
    topic: s.topic ?? "",
    sourceIds: (s.sources ?? []).map((src) => src.id).filter(Boolean),
  }));
  const claimed = new Set();

  return metaStories.map((ms) => {
    const newSourceIds = ms.source_item_ids ?? [];
    const newTopic = (ms.tags?.topics ?? [])[0] ?? "";

    const candidates = [];
    for (let i = 0; i < priorIndex.length; i++) {
      if (claimed.has(i)) continue;
      const prior = priorIndex[i];
      if (!prior.topic || !newTopic || prior.topic !== newTopic) continue;
      const score = jaccardOverlap(newSourceIds, prior.sourceIds);
      if (score >= LINEAGE_JACCARD_THRESHOLD) candidates.push({ idx: i, score });
    }

    // Exactly one candidate → reuse.  Multiple equally-good candidates →
    // ambiguous → fresh ID (favor fragmentation over accidental merge).
    if (candidates.length === 1) {
      claimed.add(candidates[0].idx);
      return { ...ms, meta_story_id: priorIndex[candidates[0].idx].metaStoryId };
    }

    return { ...ms, meta_story_id: ms.meta_story_id ?? generateMetaStoryId(ms) };
  });
}

const TWENTY_FOUR_HOURS_MINUTES = 24 * 60;

// Valid schema-enum values (must match packages/contracts schemas.ts)
const VALID_GEOGRAPHIES = new Set(["US", "Colombia"]);
const VALID_TOPICS = new Set([
  "Diplomatic relations",
  "Migration policy",
  "Security cooperation",
]);

// ─── Source pool selection ────────────────────────────────────────────────────

/**
 * Select items whose outlet matches any configured traditionalSource or socialSource.
 * Comparison is case-insensitive. If no sources are configured, all items pass.
 */
export function selectSourcePool(items, settings) {
  const sources = new Set([
    ...(settings.traditionalSources ?? []).map((s) => s.toLowerCase()),
    ...(settings.socialSources ?? []).map((s) => s.toLowerCase()),
  ]);
  if (sources.size === 0) return items;
  return items.filter((item) => sources.has(item.outlet.toLowerCase()));
}

// ─── 24-hour filter ───────────────────────────────────────────────────────────

export function apply24hFilter(items) {
  return items.filter((item) => item.minutesAgo <= TWENTY_FOUR_HOURS_MINUTES);
}

// ─── Relevance filter ─────────────────────────────────────────────────────────

/**
 * An item passes if it satisfies ANY configured filter (OR logic).
 * Empty filter arrays are treated as "no restriction" and do not contribute to
 * the OR evaluation — they only broaden the result when all three are empty
 * (in which case all items pass).
 *
 * @deprecated Prefer applyGeoFilter + applyTopicKeywordFilter in the pipeline.
 * Kept for backward compatibility with tests.
 */
export function applyRelevanceFilter(items, settings) {
  const topics = new Set((settings.topics ?? []).map((t) => normalizeTopicLabel(t)));
  const geos = new Set(settings.geographies ?? []);
  const keywords = (settings.keywords ?? []).map((k) => k.toLowerCase());

  if (topics.size === 0 && geos.size === 0 && keywords.length === 0) return items;

  return items.filter((item) => {
    if (topics.size > 0 && topics.has(normalizeTopicLabel(item.topic))) return true;
    if (geos.size > 0 && item.geographies.some((g) => geos.has(g))) return true;
    if (keywords.length > 0) {
      const text = (item.headline + " " + item.body.join(" ")).toLowerCase();
      if (keywords.some((k) => text.includes(k))) return true;
    }
    return false;
  });
}

// Regex-escape characters that have special meaning inside a RegExp pattern.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a single case-insensitive whole-word regex that matches any of the
 * given keywords as a token (\b word boundaries).  Returns null when there are
 * no usable keywords.  Multi-word keywords like "border policy" are matched as
 * a contiguous phrase.  Empty/whitespace-only keywords are dropped.
 */
function buildKeywordTokenRegex(keywords) {
  const cleaned = (keywords ?? [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter(Boolean);
  if (cleaned.length === 0) return null;
  const alternation = cleaned.map((k) => escapeRegex(k)).join("|");
  return new RegExp(`\\b(?:${alternation})\\b`, "i");
}

/**
 * Filters items by topic and keyword match only (no geography check).
 * Used after applyGeoFilter so geo is handled separately.
 *
 *   - Topic uses canonical normalization (`normalizeTopicLabel`).
 *   - Keyword uses whole-word/token matching (case-insensitive); substrings
 *     inside larger words (e.g. "ofac" inside "ofacility") do NOT match.
 *   - Topic OR keyword (logical OR) decides relevance.
 *   - If both topics and keywords are empty, all items pass through.
 */
export function applyTopicKeywordFilter(items, settings) {
  const topics = new Set((settings.topics ?? []).map((t) => normalizeTopicLabel(t)));
  const keywordRegex = buildKeywordTokenRegex(settings.keywords);

  if (topics.size === 0 && !keywordRegex) return items;

  return items.filter((item) => {
    if (topics.size > 0 && topics.has(normalizeTopicLabel(item.topic))) return true;
    if (keywordRegex) {
      const text = (item.headline ?? "") + " " + (Array.isArray(item.body) ? item.body.join(" ") : (item.body ?? ""));
      if (keywordRegex.test(text)) return true;
    }
    return false;
  });
}

// ─── Build response story shape ───────────────────────────────────────────────

/**
 * Converts a meta-story + its resolved source items into the response story shape
 * expected by dashboardPayloadSchema.  Derives schema-constrained fields (topic,
 * geographies, priority) from the source items so they stay within enum bounds.
 */
function buildStory(metaStory, sourceItems) {
  const validGeos = sourceItems
    .flatMap((i) => i.geographies)
    .filter((g) => VALID_GEOGRAPHIES.has(g));
  const geographies = [...new Set(validGeos)];

  const rawTopics = sourceItems.map((i) => normalizeTopicLabel(i.topic));
  const validTopic = rawTopics.find((t) => VALID_TOPICS.has(t)) ?? "Diplomatic relations";

  const maxWeight = Math.max(...sourceItems.map((i) => i.weight), 0);
  const priority = maxWeight >= 80 ? "top" : "standard";
  const freshestMinutesAgo = Math.min(...sourceItems.map((i) => i.minutesAgo));

  return {
    id: metaStory.meta_story_id,
    metaStoryId: metaStory.meta_story_id,
    title: metaStory.title,
    subtitle: metaStory.subtitle,
    geographies,
    topic: validTopic,
    takeaway: metaStory.summary,
    summary: metaStory.summary,
    whyItMatters: metaStory.subtitle,
    whatChanged: `Latest update ${freshestMinutesAgo} min ago.`,
    priority,
    outletCount: sourceItems.length,
    tags: metaStory.tags,
    sources: sourceItems.map((item) => ({
      id: item.sourceId,
      outlet: item.outlet,
      byline: item.byline,
      kind: item.kind,
      weight: item.weight,
      url: item.url,
      minutesAgo: item.minutesAgo,
      headline: item.headline,
      body: item.body,
    })),
  };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full refresh pipeline:
 *   normalize → source pool → 24h → geo filter → topic+keyword filter → cluster → verify grounding → build payload
 *
 * @param {object} opts
 * @param {object} opts.settings      — user settings
 * @param {Array}  opts.rawItems      — raw items from feed-reader (not yet normalized)
 * @param {Function} opts.clusterFn  — injectable cluster function (for tests)
 * @param {string} opts.clusterModel — model string for clustering
 * @param {string} opts.contractVersion — version to embed in payload
 * @param {Function} [opts.geoAssessFn]      — injectable geo-confidence assessor (for tests)
 * @param {Function} [opts.readHeldFn]       — injectable hold bucket reader; returns previously held items
 * @param {Function} [opts.writeHeldFn]      — injectable hold bucket writer (for tests)
 * @param {Function} [opts.readPriorSnapshotFn] — injectable prior snapshot reader (for ID lineage continuity)
 * @param {Array}    [opts.manifestFeeds]    — manifest feed list for source matching (Phase 2)
 * @param {object}   [opts.aliasMap]         — merged alias map (Supabase ∪ repo fallback)
 * @param {string[]} [opts.fallbackFeedIds]  — env-configured fallback baseline feed IDs
 * @param {boolean}  [opts.fallbackEnabled]
 * @param {Function} [opts.writeRejectionsFn] — injectable rejection-log writer (Phase 3)
 *
 * @returns {{ payload: object, log: object }}
 *   payload — ready-to-persist dashboard payload
 *   log     — observability metadata (includes selection meta in `log.selection`
 *             and Phase 3 strict-grounding metrics)
 */
export async function runRefreshPipeline({
  settings,
  rawItems,
  clusterFn,
  clusterModel,
  contractVersion,
  geoAssessFn = mockAssessGeoConfidence,
  readHeldFn = null,
  writeHeldFn = null,
  readPriorSnapshotFn = null,
  manifestFeeds = null,
  aliasMap = undefined,
  fallbackFeedIds = [],
  fallbackEnabled = true,
  writeRejectionsFn = null,
}) {
  // 1. Normalize
  const { items: normalizedItems, errors: normErrors } = normalizeSourceItems(rawItems);
  if (normErrors.length > 0) {
    console.warn(`[pipeline] ${normErrors.length} item(s) skipped during normalization:`, normErrors);
  }

  // 2. Time window FIRST (per Phase 2 product decision: pre-source-selection,
  //    pre-relevance).  Items older than 24h are dropped before any selection
  //    or relevance work so downstream stages don't burn on stale items.
  const recentNormalizedItems = apply24hFilter(normalizedItems);

  // 3. Source selection (Phase 2): resolve user-selected sources against the
  //    manifest with alias map + connector availability.  When manifestFeeds
  //    is provided (production path), use the matcher.  When absent (legacy
  //    tests), fall back to the simple outlet-set selectSourcePool below.
  let selectionMeta;
  let selectedItems;
  if (manifestFeeds) {
    const selectedNames = [
      ...(settings.traditionalSources ?? []),
      ...(settings.socialSources ?? []),
    ];
    const selection = resolveSelectedSources({
      selectedSources: selectedNames,
      manifestFeeds,
      aliasMap,
      fallbackFeedIds,
      fallbackEnabled,
    });
    const matchedOutlets = buildMatchedOutletSet(selection.matchedFeeds);
    selectedItems = filterItemsToMatchedFeeds(recentNormalizedItems, matchedOutlets);
    selectionMeta = {
      sourceSelectionMode: selection.mode,
      sourceFallbackUsed: selection.fallbackUsed,
      sourceFallbackReason: selection.fallbackReason,
      matchedSourceCount: selection.matchedSourceCount,
      selectedSourceCount: selection.selectedSourceCount,
      unmatchedSelectedSources: selection.unmatchedSelectedSources,
      unavailableConnectorCount: selection.unavailableConnectorCount,
      unavailableConnectorSources: selection.unavailableConnectorSources,
      matchedFeedIds: selection.matchedFeeds.map((f) => f.id),
    };
    console.log(
      `[pipeline.selection] mode=${selection.mode} fallback=${selection.fallbackUsed}${selection.fallbackReason ? ` reason=${selection.fallbackReason}` : ""} matched=${selection.matchedSourceCount}/${selection.selectedSourceCount} unmatched=${selection.unmatchedSelectedSources.length} unavailable=${selection.unavailableConnectorCount}`
    );
  } else {
    selectedItems = selectSourcePool(recentNormalizedItems, settings);
    selectionMeta = {
      sourceSelectionMode: SELECTION_MODE.STRICT,
      sourceFallbackUsed: false,
      sourceFallbackReason: null,
      matchedSourceCount: 0,
      selectedSourceCount: ((settings.traditionalSources ?? []).length + (settings.socialSources ?? []).length),
      unmatchedSelectedSources: [],
      unavailableConnectorCount: 0,
      unavailableConnectorSources: [],
      matchedFeedIds: [],
    };
  }

  // Variable name kept (`recentItems`) for backward compat with subsequent
  // pipeline steps.  Semantics unchanged: items that have passed time window
  // AND source selection.
  const recentItems = selectedItems;
  const poolItems = recentItems; // kept for log compatibility

  // 4a. Merge with previous hold bucket — re-evaluate held items this refresh
  let previouslyHeld = [];
  if (readHeldFn) {
    try {
      const rawHeld = await readHeldFn();
      // Strip geo metadata (geoCategory/geoConfidence) added by the previous run
      // Dedupe: skip any sourceId already present in the current recent pool
      const currentIds = new Set(recentItems.map((i) => i.sourceId));
      previouslyHeld = (rawHeld ?? [])
        .map(({ geoCategory: _gc, geoConfidence: _gf, ...item }) => item)
        .filter((item) => !currentIds.has(item.sourceId));
      if (previouslyHeld.length > 0) {
        console.log(`[pipeline] merging ${previouslyHeld.length} item(s) from hold bucket for re-evaluation`);
      }
    } catch (err) {
      console.warn(`[pipeline] hold bucket read failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const candidateItems = [...recentItems, ...previouslyHeld];

  // 4b. Geo-confidence filter (categorize → assess → apply thresholds → persist hold bucket)
  const configuredGeos = settings.geographies ?? [];
  const { included: geoPassedItems, held: geoHeldItems } = await applyGeoFilter(
    candidateItems,
    configuredGeos,
    geoAssessFn
  );

  if (writeHeldFn) {
    try {
      await writeHeldFn(geoHeldItems);
    } catch (err) {
      console.warn(`[pipeline] hold bucket write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (geoHeldItems.length > 0) {
    console.log(`[pipeline] ${geoHeldItems.length} item(s) in geo hold bucket after this refresh`);
  }

  // 5. Topic + keyword filter (geo handled in step 4)
  const relevantItems = applyTopicKeywordFilter(geoPassedItems, settings);

  // 6. LLM clustering
  let rawMetaStories;
  let usedFallbackClustering = false;
  if (relevantItems.length === 0) {
    rawMetaStories = [];
  } else {
    try {
      rawMetaStories = await clusterFn(relevantItems, settings, clusterModel);
    } catch (clusterErr) {
      console.warn(
        `[pipeline] clustering failed (${clusterErr instanceof Error ? clusterErr.message : clusterErr}), using graceful fallback`
      );
      rawMetaStories = gracefulFallbackClustering(relevantItems, settings);
      usedFallbackClustering = true;
    }
  }

  // 7. Resolve stable meta_story_id with lineage continuity:
  //    Read prior snapshot, attempt to match each new cluster against a prior
  //    story (same primary topic + Jaccard ≥ 0.5 on source IDs).  Exactly-one
  //    match → reuse prior metaStoryId so title locks survive narrative
  //    evolution.  Otherwise → fresh evidence-derived ID via generateMetaStoryId.
  let priorStories = [];
  if (readPriorSnapshotFn) {
    try {
      const priorSnapshot = await readPriorSnapshotFn();
      priorStories = priorSnapshot?.stories ?? [];
    } catch (err) {
      console.warn(`[pipeline] prior snapshot read failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  rawMetaStories = reuseOrAssignIds(rawMetaStories, priorStories);

  // 8. Build source index
  const sourceItemsById = new Map(relevantItems.map((item) => [item.sourceId, item]));

  // 9. Grounding verification (source-level + claim-level + summary/subtitle grounding)
  const { valid: groundedStories, invalid: failedGrounding } = verifyGrounding(
    rawMetaStories,
    sourceItemsById
  );

  const groundingFailures = failedGrounding.length;

  // Phase 3 (strict trust posture): ANY grounding failure drops the story
  // from the published dashboard.  No extractive fallback for partial_source_ids,
  // no soft-publish for ungrounded_claims.  Dropped stories are persisted
  // separately (rejection log) for offline analysis — never returned to clients.
  const groundingDropReasons = {};
  const rejectionRecords = [];
  const rejectedAt = new Date().toISOString();
  for (const ms of failedGrounding) {
    const reason = ms.groundingFailure ?? "unknown";
    groundingDropReasons[reason] = (groundingDropReasons[reason] ?? 0) + 1;
    rejectionRecords.push({
      meta_story_id: ms.meta_story_id ?? null,
      reason_code: reason,
      source_item_ids: Array.isArray(ms.source_item_ids) ? ms.source_item_ids : [],
      debug_payload: {
        title: ms.title ?? null,
        factual_claims_count: Array.isArray(ms.factual_claims) ? ms.factual_claims.length : 0,
        tags: ms.tags ?? null,
      },
      created_at: rejectedAt,
    });
  }
  const droppedUngroundedStoryCount = rejectionRecords.length;
  if (droppedUngroundedStoryCount > 0) {
    const breakdown = Object.entries(groundingDropReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    console.warn(
      `[pipeline.grounding] strict drop — ${droppedUngroundedStoryCount} story(ies) excluded (${breakdown})`
    );
    if (writeRejectionsFn) {
      try {
        await writeRejectionsFn(rejectionRecords);
      } catch (err) {
        console.warn(
          `[pipeline.grounding] rejection-log write failed: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }

  // 10. Build response stories (resolve source items, shape to schema).
  //     Only `groundedStories` (passed all grounding gates) reach this step.
  const stories = groundedStories.map((ms) => {
    const sourceItems = ms.source_item_ids
      .map((id) => sourceItemsById.get(id))
      .filter(Boolean);
    return buildStory(ms, sourceItems);
  });

  const payload = {
    contractVersion,
    stories,
  };

  const log = {
    totalItems: normalizedItems.length,
    poolCount: poolItems.length,
    recentCount: recentItems.length,
    geoHeldCount: geoHeldItems.length,
    relevantCount: relevantItems.length,
    relevantItemCount: relevantItems.length, // alias surfaced in `_meta.selection`
    metaStoryCount: stories.length,
    usedFallbackClustering,
    groundingFailures,
    // Phase 3 strict-grounding metrics
    droppedUngroundedStoryCount,
    groundingDropReasons,
    rejectionRecords, // exposed in log for testability; route persists via writeRejectionsFn
    normErrors: normErrors.length,
    selection: { ...selectionMeta, relevantItemCount: relevantItems.length },
  };

  return { payload, log };
}
