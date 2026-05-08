// Refresh watermark — Phase 4 hardening.
//
// A deterministic 16-char hash over the candidate clustering set.  Used to
// short-circuit refreshes that would re-run identical work: if the watermark
// matches the previously persisted one, we skip clustering/grounding/locks/
// rejection writes entirely and re-serve the existing snapshot.
//
// Composition (locked by Phase 4 spec):
//   - sorted candidate sourceIds (deduped)
//   - candidate count
//   - min/max published-time bucket (hour-granular bucket derived from
//     `now - minutesAgo` so the value is stable across refresh-time drift —
//     the same article computed at T and T+5min produces the same bucket
//     because minutesAgo and now both shift together)
//   - sorted selected feed IDs

import { createHash } from "node:crypto";

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {Array}    opts.candidateItems       — items that would feed clustering
 * @param {string[]} [opts.selectedFeedIds]    — manifest feed IDs in the user's selection
 * @param {number}   [opts.now]                — Date.now() override for tests
 * @returns {{
 *   watermark: string,
 *   candidateCount: number,
 *   selectedFeedCount: number,
 *   minPubBucket: number | null,
 *   maxPubBucket: number | null,
 * }}
 */
export function computeWatermark({ candidateItems = [], selectedFeedIds = [], now = Date.now() } = {}) {
  const ids = Array.isArray(candidateItems)
    ? [...new Set(candidateItems.map((i) => String(i?.sourceId ?? "")).filter(Boolean))].sort()
    : [];

  const feedIds = Array.isArray(selectedFeedIds)
    ? [...new Set(selectedFeedIds.map(String).filter(Boolean))].sort()
    : [];

  let minBucket = null;
  let maxBucket = null;
  if (Array.isArray(candidateItems) && candidateItems.length > 0) {
    const buckets = candidateItems
      .map((i) => {
        const m = Number(i?.minutesAgo);
        if (!Number.isFinite(m) || m < 0) return null;
        const pubMs = now - m * 60_000;
        return Math.floor(pubMs / HOUR_MS);
      })
      .filter((b) => b !== null);
    if (buckets.length > 0) {
      minBucket = Math.min(...buckets);
      maxBucket = Math.max(...buckets);
    }
  }

  const signature = JSON.stringify({
    ids,
    count: ids.length,
    min: minBucket,
    max: maxBucket,
    feedIds,
  });

  const watermark = createHash("sha256").update(signature).digest("hex").slice(0, 16);
  return {
    watermark,
    candidateCount: ids.length,
    selectedFeedCount: feedIds.length,
    minPubBucket: minBucket,
    maxPubBucket: maxBucket,
  };
}

/**
 * Convenience predicate.  Returns true when both sides are present, equal
 * strings.  Null/undefined on either side returns false (forcing full run).
 */
export function watermarksMatch(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length > 0 && a === b;
}
