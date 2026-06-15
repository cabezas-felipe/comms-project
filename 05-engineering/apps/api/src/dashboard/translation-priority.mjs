// Cold-start translation priority ranking (Plan Step A4).
//
// A tiny, PURE, deterministic helper that orders candidate items by how much
// they deserve a (budget-limited) translation pass on a cold-start refresh. It
// does NOT translate, does NOT enforce any cap, and does NOT touch the pipeline
// — it only ranks. The A5 wiring step consumes this order and applies the
// cold-start translation caps (`translationMaxItems` / `translationMaxMs`); cap
// enforcement deliberately lives there, not here.
//
// Ranking reuses the existing pre-cluster relevance primitives verbatim — the
// same item-level proxies (topic / keyword / geo fit, headline-family
// corroboration, beat-fit, freshness, Decision-5C election shaping) the
// cluster-input cap already uses to decide which items survive. Translating the
// items most likely to survive (and matter to) clustering first is the whole
// point, so mirroring that survival ordering keeps the two stages coherent with
// zero new scoring logic to drift.
//
// Cost: ONE O(n) pool-index build + one O(1) score per item + one O(n log n)
// sort. No LLM call, DB read, or network I/O.

import {
  buildPreClusterPoolIndex,
  computePreClusterRelevanceScore,
  comparePreClusterRank,
} from "./pre-cluster-relevance.mjs";

/**
 * Score every item for translation priority and return them paired with their
 * score record, sorted highest-priority-first. Exposed (alongside the clean
 * public API below) so tests — and future observability — can see the scores
 * and tie-break keys, not just the resulting order.
 *
 * Pure: builds the score records against a fresh pool index and never mutates
 * the input array or any item. The returned wrappers reference the ORIGINAL
 * item objects (no clone), so callers must treat the items as read-only.
 *
 * @param {Array} items — candidate items (normalized source items)
 * @param {object} settings — user settings (topics / keywords / geographies)
 * @returns {Array<{ item: object, score: object }>} sorted, highest-priority-first
 */
export function scoreItemsForTranslation(items, settings) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  // ONE pool scan shared by every per-item score (corroboration needs the
  // pool-level headline-family counts). Built over the same `list` we rank.
  const poolIndex = buildPreClusterPoolIndex(list, settings);

  // Pair each original item with its (pure) score record. `list.map` yields a
  // NEW array, so the caller's input array is never reordered in place.
  const scored = list.map((item) => ({
    item,
    score: computePreClusterRelevanceScore(item, settings, poolIndex),
  }));

  // Sort highest-priority-first. `comparePreClusterRank` is a total,
  // deterministic descending comparator whose tie-break chain is exactly the
  // pre-cluster survival intent: preClusterScore → corroboration → beatFit →
  // freshness (minutesAgo) → sourceId (final stable tie-break). Because the
  // chain terminates in sourceId, the order is fully determined for distinct
  // sourceIds regardless of the engine's sort stability.
  scored.sort((a, b) => comparePreClusterRank(a.score, b.score));
  return scored;
}

/**
 * Rank items for cold-start translation, highest-priority-first.
 *
 * Pure and deterministic: returns a NEW array and never mutates the input array
 * or any item object. Empty / non-array input yields `[]`.
 *
 * @param {Array} items — candidate items
 * @param {object} settings — user settings
 * @param {object} [opts] — reserved for the A5 wiring step (e.g. budget hints).
 *   Accepted for forward-compatibility; this helper applies NO cap or cutoff —
 *   it ranks the full set and leaves enforcement to the caller.
 * @returns {Array} a new array of the same items, ordered highest-priority-first
 */
export function rankItemsForTranslation(items, settings, opts = {}) {
  void opts; // reserved (A5); intentionally unused here — no cap enforcement.
  return scoreItemsForTranslation(items, settings).map((entry) => entry.item);
}
