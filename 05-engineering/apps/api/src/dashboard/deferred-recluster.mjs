// Deferred re-cluster executor (B2).
//
// B1 emits a deterministic, bounded `reclusterQueue` (≤2) of ambiguous
// over-merges that A3's split-healer DEFERRED rather than atomized. B2 runs —
// AFTER the fast Phase-1 snapshot write, fire-and-forget — a fresh clustering
// pass over ONLY each candidate's source set, grounds the result with the
// existing pipeline grounding, and patches the affected story slot in place.
//
// Locked B2 decisions encoded here:
//   - process up to 2 candidates, SEQUENTIALLY, 45s timeout each,
//   - patch the snapshot in place ONLY on a successful + grounded result,
//   - on failure/timeout/invalid: leave that candidate's slot untouched and
//     continue to the next (never abort the whole run, never blank the board),
//   - never exceed the A4 max-5 story cap (slot expansion is trimmed from the
//     R1 tail).
//
// This module is pure and deterministic given its injected deps (`clusterFn`,
// `verifyGroundingFn`, `now`) — no network, no snapshot I/O. The server wires it
// to the snapshot repo + cluster engine and owns the generation guard.

import { withTimeout } from "../ai/guardrails.mjs";
import { verifyGrounding } from "../ai/cluster-engine.mjs";
import { MAX_META_STORIES } from "./refresh-pipeline.mjs";

export const DEFERRED_RECLUSTER_TIMEOUT_MS = 45000;
export const DEFERRED_RECLUSTER_MAX = 2;

/**
 * Reconstruct cluster-input source items from a persisted snapshot story's
 * `sources`. The persisted shape uses `id` (not `sourceId`) and drops per-source
 * `topic`/`geographies`; we map `id → sourceId` and carry the parent story's
 * geographies/topic onto each item so grounding (ID-based) and any tag
 * derivation behave sanely. Deterministic; no model calls.
 */
export function reconstructSourceItems(story) {
  const sources = Array.isArray(story?.sources) ? story.sources : [];
  const parentGeographies = Array.isArray(story?.geographies) ? story.geographies : [];
  const parentTopic = typeof story?.topic === "string" ? story.topic : undefined;
  return sources
    .filter((s) => s && (typeof s.id === "string" || typeof s.sourceId === "string"))
    .map((s) => ({
      sourceId: s.sourceId ?? s.id,
      headline: s.headline,
      body: s.body,
      outlet: s.outlet,
      byline: s.byline,
      kind: s.kind,
      weight: s.weight,
      url: s.url,
      minutesAgo: s.minutesAgo,
      geographies: [...parentGeographies],
      ...(parentTopic ? { topic: parentTopic } : {}),
    }));
}

// Shape a grounded re-clustered meta-story back into the persisted story shape,
// carrying the parent story's presentation fields (geographies / whyItMatters /
// whatChanged / priority / topic) as conservative defaults — B2 re-derives only
// the clustering-authoritative narrative (title/subtitle/summary/tags) and the
// source membership; it does NOT re-run the why/what-changed writers.
function shapeReclusteredStory(metaStory, parentStory, itemsById) {
  const items = (Array.isArray(metaStory?.source_item_ids) ? metaStory.source_item_ids : [])
    .map((id) => itemsById.get(id))
    .filter(Boolean);
  const outletCount = new Set(items.map((i) => i.outlet).filter((o) => typeof o === "string" && o)).size;
  return {
    id: metaStory.meta_story_id,
    metaStoryId: metaStory.meta_story_id,
    title: metaStory.title,
    subtitle: metaStory.subtitle,
    geographies: Array.isArray(parentStory?.geographies) ? [...parentStory.geographies] : [],
    summary: metaStory.summary,
    whyItMatters: parentStory?.whyItMatters ?? "",
    whatChanged: parentStory?.whatChanged ?? "",
    priority: parentStory?.priority ?? "standard",
    outletCount,
    tags: metaStory.tags ?? parentStory?.tags ?? { topics: [], keywords: [], geographies: [] },
    sources: items.map((i) => ({
      id: i.sourceId,
      outlet: i.outlet,
      byline: i.byline,
      kind: i.kind,
      weight: i.weight,
      url: i.url,
      minutesAgo: i.minutesAgo,
      headline: i.headline,
      body: i.body,
    })),
    ...(typeof parentStory?.topic === "string" ? { topic: parentStory.topic } : {}),
  };
}

/**
 * Execute the deferred re-cluster over a B1 queue against a set of snapshot
 * stories. Returns the (possibly patched) stories, a `mutated` flag, and
 * additive diagnostics. Pure given its injected deps.
 *
 * @param {object}   opts
 * @param {Array}    opts.queue              — B1 reclusterQueue items ({ metaStoryId, ... })
 * @param {Array}    opts.stories            — current snapshot stories (R1-ordered)
 * @param {object}   opts.settings
 * @param {string}   opts.clusterModel
 * @param {Function} opts.clusterFn          — (items, settings, model, { timeoutMs }) => Promise<metaStories>
 * @param {Function} [opts.verifyGroundingFn]— defaults to the pipeline grounding
 * @param {number}   [opts.timeoutMs]        — per-candidate timeout (default 45000)
 * @param {number}   [opts.maxCandidates]    — defensive cap (default 2)
 * @param {Function} [opts.now]              — clock injection for deterministic latency
 * @returns {Promise<{ stories: Array, mutated: boolean, diagnostics: object }>}
 */
export async function executeDeferredRecluster({
  queue = [],
  stories = [],
  settings,
  clusterModel,
  clusterFn,
  verifyGroundingFn = verifyGrounding,
  timeoutMs = DEFERRED_RECLUSTER_TIMEOUT_MS,
  maxCandidates = DEFERRED_RECLUSTER_MAX,
  now = () => Date.now(),
}) {
  const startedAt = now();
  let patched = Array.isArray(stories) ? stories.slice() : [];
  const candidates = [];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let timedOut = 0;
  let mutated = false;

  const toProcess = (Array.isArray(queue) ? queue : []).slice(0, Math.max(0, maxCandidates));

  for (const cand of toProcess) {
    const metaStoryId = cand?.metaStoryId ?? null;
    const candStartedAt = now();
    const idx = patched.findIndex((s) => (s?.metaStoryId ?? s?.id) === metaStoryId);

    // The candidate's slot may have been trimmed by the A4 cap or replaced by a
    // newer refresh — nothing to patch. Not an "attempt" (no cluster call).
    if (idx === -1 || !metaStoryId) {
      candidates.push({ metaStoryId, outcome: "not_found", latencyMs: 0 });
      failed += 1;
      continue;
    }

    const parentStory = patched[idx];
    const sourceItems = reconstructSourceItems(parentStory);
    const itemsById = new Map(sourceItems.map((it) => [it.sourceId, it]));

    attempted += 1;
    let result;
    try {
      result = await withTimeout(
        () => Promise.resolve(clusterFn(sourceItems, settings, clusterModel, { timeoutMs })),
        timeoutMs,
        `deferred re-cluster timed out (${metaStoryId})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timed out|timeout|abort/i.test(msg);
      if (isTimeout) timedOut += 1;
      else failed += 1;
      candidates.push({
        metaStoryId,
        outcome: isTimeout ? "timeout" : "error",
        reason: msg,
        latencyMs: now() - candStartedAt,
      });
      continue; // snapshot slot untouched for this candidate
    }

    const metaStories = Array.isArray(result) ? result : [];
    if (metaStories.length === 0) {
      failed += 1;
      candidates.push({ metaStoryId, outcome: "empty", latencyMs: now() - candStartedAt });
      continue;
    }

    const grounded = verifyGroundingFn(metaStories, itemsById);
    const valid = Array.isArray(grounded?.valid) ? grounded.valid : [];
    if (valid.length === 0) {
      failed += 1;
      candidates.push({ metaStoryId, outcome: "ungrounded", latencyMs: now() - candStartedAt });
      continue;
    }

    const shaped = valid.map((ms) => shapeReclusteredStory(ms, parentStory, itemsById));
    // Patch ONLY the affected slot, in place: replace the one parent story with
    // the shaped grounded result (1:1 confirm/clean, or N-way split expansion).
    patched.splice(idx, 1, ...shaped);
    mutated = true;
    succeeded += 1;
    candidates.push({
      metaStoryId,
      outcome: shaped.length > 1 ? "split" : "confirmed",
      splitInto: shaped.length,
      newMetaStoryIds: shaped.map((s) => s.metaStoryId),
      latencyMs: now() - candStartedAt,
    });
  }

  // A4 invariant: a split can grow the set past the max-5 cap. Trim from the
  // R1 tail (lowest-priority) so the cap is never exceeded.
  let cappedToMax = false;
  if (patched.length > MAX_META_STORIES) {
    patched = patched.slice(0, MAX_META_STORIES);
    cappedToMax = true;
  }

  const status =
    attempted === 0
      ? "noop"
      : failed + timedOut > 0
        ? succeeded > 0
          ? "partial_failure"
          : "failed"
        : "completed";

  return {
    stories: patched,
    mutated,
    diagnostics: {
      enabled: true,
      totalQueued: Array.isArray(queue) ? queue.length : 0,
      attempted,
      succeeded,
      failed,
      timedOut,
      candidates,
      cappedToMax,
      totalLatencyMs: now() - startedAt,
      status,
    },
  };
}
