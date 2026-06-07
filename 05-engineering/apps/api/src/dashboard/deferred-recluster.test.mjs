// Unit tests for the deferred re-cluster executor (B2). Pure module — injected
// clusterFn + real pipeline grounding, no network, no snapshot I/O.

import test from "node:test";
import assert from "node:assert/strict";

import {
  executeDeferredRecluster,
  reconstructSourceItems,
  DEFERRED_RECLUSTER_MAX,
  DEFERRED_RECLUSTER_TIMEOUT_MS,
} from "./deferred-recluster.mjs";

const SETTINGS = { topics: ["Diplomatic relations"], keywords: [], geographies: ["Colombia"] };
const MODEL = "mock-anthropic-haiku";

// Build a persisted snapshot story with the given source ids.
function snapStory(metaStoryId, sourceIds, extra = {}) {
  return {
    id: metaStoryId,
    metaStoryId,
    title: `Title ${metaStoryId}`,
    subtitle: "subtitle",
    summary: "summary",
    geographies: ["Colombia"],
    whyItMatters: "why copy",
    whatChanged: "what changed copy",
    priority: "standard",
    outletCount: sourceIds.length,
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["Colombia"] },
    sources: sourceIds.map((id, i) => ({
      id,
      outlet: `Outlet${i}`,
      byline: "Byline",
      kind: "traditional",
      weight: 75,
      url: `https://example.com/${id}`,
      minutesAgo: 30,
      headline: `Headline ${id}`,
      body: ["body line"],
    })),
    topic: "Diplomatic relations",
  };
}

// clusterFn stubs (return cluster-engine-shaped meta-stories grounded by sourceId).
const clusterConfirm = async (items) => {
  const ids = items.map((i) => i.sourceId);
  return [{
    meta_story_id: "reclustered-single",
    title: "Re-clustered single story",
    subtitle: "s",
    summary: "sum",
    source_item_ids: ids,
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["A grounded claim."],
    claim_evidence_map: { "0": ids }, // corroborated across both → one story
  }];
};
const clusterSplit = async (items) =>
  items.map((it, i) => ({
    meta_story_id: `split-${i}`,
    title: `Split story ${i}`,
    subtitle: "s",
    summary: "sum",
    source_item_ids: [it.sourceId],
    tags: { topics: [], keywords: [], geographies: [] },
    factual_claims: ["A grounded claim."],
    claim_evidence_map: { "0": [it.sourceId] },
  }));
const clusterThrow = async () => { throw new Error("provider boom"); };
const clusterHang = () => new Promise(() => {});
const clusterUngrounded = async () => [{
  meta_story_id: "bad",
  title: "t",
  subtitle: "s",
  summary: "sum",
  source_item_ids: ["nonexistent-id"],
  tags: { topics: [], keywords: [], geographies: [] },
  factual_claims: ["claim"],
  claim_evidence_map: { "0": ["nonexistent-id"] },
}];

test("reconstructSourceItems maps persisted sources → cluster-input shape", () => {
  const story = snapStory("ms-1", ["s1", "s2"]);
  const items = reconstructSourceItems(story);
  assert.equal(items.length, 2);
  assert.equal(items[0].sourceId, "s1");
  assert.equal(items[0].headline, "Headline s1");
  assert.deepEqual(items[0].geographies, ["Colombia"]);
  assert.equal(items[0].topic, "Diplomatic relations");
});

test("happy path (confirm): candidate re-clusters to one story, patched in place 1:1", async () => {
  const stories = [snapStory("keep-a", ["a1"]), snapStory("cand", ["c1", "c2"])];
  const queue = [{ metaStoryId: "cand", suspicionScore: 124 }];

  const { stories: out, mutated, diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn: clusterConfirm,
  });

  assert.equal(mutated, true);
  assert.equal(out.length, 2, "story count unchanged on a 1:1 confirm");
  assert.equal(out[0].metaStoryId, "keep-a", "unrelated story preserved + ordered");
  assert.equal(out[1].metaStoryId, "reclustered-single", "affected slot replaced in place");
  assert.deepEqual(out[1].sources.map((s) => s.id), ["c1", "c2"]);
  // Carried-over presentation fields from the parent slot.
  assert.equal(out[1].whyItMatters, "why copy");
  assert.equal(diagnostics.status, "completed");
  assert.equal(diagnostics.attempted, 1);
  assert.equal(diagnostics.succeeded, 1);
  assert.equal(diagnostics.candidates[0].outcome, "confirmed");
  assert.equal(diagnostics.candidates[0].splitInto, 1);
});

test("happy path (split): candidate re-clusters into 2 stories, slot expands in place", async () => {
  const stories = [snapStory("cand", ["c1", "c2"]), snapStory("keep-b", ["b1"])];
  const queue = [{ metaStoryId: "cand" }];

  const { stories: out, mutated, diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn: clusterSplit,
  });

  assert.equal(mutated, true);
  assert.equal(out.length, 3, "slot expanded 1 → 2; unrelated story still present");
  assert.deepEqual(out.map((s) => s.metaStoryId), ["split-0", "split-1", "keep-b"]);
  assert.equal(diagnostics.candidates[0].outcome, "split");
  assert.equal(diagnostics.candidates[0].splitInto, 2);
  assert.deepEqual(diagnostics.candidates[0].newMetaStoryIds, ["split-0", "split-1"]);
});

test("D2 write-boundary guard: a parent story with kind 'rss' yields patched sources with contract-safe kinds", async () => {
  // Simulate a legacy / regressed parent snapshot whose sources carry the
  // ingestion kind "rss". The patched (split) stories must project only the
  // contract kinds "traditional" | "social".
  const parent = {
    ...snapStory("legacy", ["r1", "r2"]),
    sources: [
      { id: "r1", outlet: "Reuters", byline: "B", kind: "rss", weight: 75, url: "https://e/r1", minutesAgo: 30, headline: "H r1", body: ["b"] },
      { id: "r2", outlet: "@handle", byline: "B", kind: "social", weight: 60, url: "https://e/r2", minutesAgo: 31, headline: "H r2", body: ["b"] },
    ],
  };
  const { stories: out, mutated } = await executeDeferredRecluster({
    queue: [{ metaStoryId: "legacy" }],
    stories: [parent],
    settings: SETTINGS,
    clusterModel: MODEL,
    clusterFn: clusterSplit,
  });

  assert.equal(mutated, true);
  const kinds = out.flatMap((s) => s.sources.map((src) => src.kind));
  assert.ok(kinds.length > 0, "patched stories must carry sources");
  assert.ok(
    kinds.every((k) => k === "traditional" || k === "social"),
    `patched sources must only carry contract kinds, saw: ${JSON.stringify(kinds)}`
  );
  // "rss" → "traditional"; "social" passes through (one each).
  assert.deepEqual([...kinds].sort(), ["social", "traditional"]);
});

test("timeout: candidate is not patched, next candidate still attempted (sequential)", async () => {
  const stories = [snapStory("slow", ["s1"]), snapStory("fast", ["f1", "f2"])];
  const queue = [{ metaStoryId: "slow" }, { metaStoryId: "fast" }];
  // First candidate hangs (→ timeout), second succeeds.
  const clusterFn = (items, ...rest) =>
    items.some((i) => i.sourceId === "s1") ? clusterHang() : clusterConfirm(items, ...rest);

  const { stories: out, mutated, diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn, timeoutMs: 25,
  });

  assert.equal(mutated, true, "the second candidate still patches despite the first timing out");
  // "slow" slot untouched; "fast" slot replaced.
  assert.equal(out[0].metaStoryId, "slow");
  assert.equal(out[1].metaStoryId, "reclustered-single");
  assert.equal(diagnostics.timedOut, 1);
  assert.equal(diagnostics.succeeded, 1);
  assert.equal(diagnostics.attempted, 2);
  assert.equal(diagnostics.status, "partial_failure");
  assert.equal(diagnostics.candidates[0].outcome, "timeout");
  assert.equal(diagnostics.candidates[1].outcome, "confirmed");
});

test("error: candidate failure leaves its slot untouched, recorded with reason", async () => {
  const stories = [snapStory("cand", ["c1", "c2"])];
  const queue = [{ metaStoryId: "cand" }];

  const { stories: out, mutated, diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn: clusterThrow,
  });

  assert.equal(mutated, false);
  assert.deepEqual(out, stories, "snapshot untouched on failure");
  assert.equal(diagnostics.failed, 1);
  assert.equal(diagnostics.status, "failed");
  assert.equal(diagnostics.candidates[0].outcome, "error");
  assert.match(diagnostics.candidates[0].reason, /provider boom/);
});

test("ungrounded result is rejected (no mutation)", async () => {
  const stories = [snapStory("cand", ["c1", "c2"])];
  const queue = [{ metaStoryId: "cand" }];

  const { mutated, diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn: clusterUngrounded,
  });

  assert.equal(mutated, false);
  assert.equal(diagnostics.candidates[0].outcome, "ungrounded");
  assert.equal(diagnostics.succeeded, 0);
});

test("not_found: a queued metaStoryId absent from the snapshot is a no-op for that slot", async () => {
  const stories = [snapStory("present", ["p1"])];
  const queue = [{ metaStoryId: "missing" }];

  const { mutated, diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn: clusterConfirm,
  });

  assert.equal(mutated, false);
  assert.equal(diagnostics.attempted, 0, "no cluster call for an absent slot");
  assert.equal(diagnostics.candidates[0].outcome, "not_found");
});

test("bounded execution: never processes more than 2 candidates", async () => {
  const stories = [snapStory("a", ["a1", "a2"]), snapStory("b", ["b1", "b2"]), snapStory("c", ["c1", "c2"])];
  const queue = [{ metaStoryId: "a" }, { metaStoryId: "b" }, { metaStoryId: "c" }];
  let calls = 0;
  const clusterFn = (items, ...rest) => { calls += 1; return clusterConfirm(items, ...rest); };

  const { diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn,
  });

  assert.equal(DEFERRED_RECLUSTER_MAX, 2);
  assert.equal(calls, 2, "third queued candidate must not be clustered");
  assert.equal(diagnostics.attempted, 2);
  assert.equal(diagnostics.candidates.length, 2);
  assert.ok(!diagnostics.candidates.some((c) => c.metaStoryId === "c"));
});

test("no queue: executor is a no-op with sane diagnostics", async () => {
  const stories = [snapStory("a", ["a1"])];
  const { stories: out, mutated, diagnostics } = await executeDeferredRecluster({
    queue: [], stories, settings: SETTINGS, clusterModel: MODEL, clusterFn: clusterConfirm,
  });

  assert.equal(mutated, false);
  assert.deepEqual(out, stories);
  assert.equal(diagnostics.status, "noop");
  assert.equal(diagnostics.attempted, 0);
  assert.equal(diagnostics.totalQueued, 0);
  assert.deepEqual(diagnostics.candidates, []);
});

test("A4 invariant: a split that overflows the max-5 cap is trimmed from the R1 tail", async () => {
  // 5 stories; re-cluster the FIRST into 3 → 7 → trimmed back to 5.
  const stories = [
    snapStory("cand", ["c1", "c2", "c3"]),
    snapStory("k1", ["x1"]),
    snapStory("k2", ["x2"]),
    snapStory("k3", ["x3"]),
    snapStory("k4", ["x4"]),
  ];
  const queue = [{ metaStoryId: "cand" }];

  const { stories: out, diagnostics } = await executeDeferredRecluster({
    queue, stories, settings: SETTINGS, clusterModel: MODEL, clusterFn: clusterSplit,
  });

  assert.equal(out.length, 5, "never exceeds the A4 max-5 cap");
  assert.equal(diagnostics.cappedToMax, true);
  // The 3 split children took the head slot; the tail (k4) was trimmed.
  assert.deepEqual(out.map((s) => s.metaStoryId), ["split-0", "split-1", "split-2", "k1", "k2"]);
});

test("default per-candidate timeout is 45s", () => {
  assert.equal(DEFERRED_RECLUSTER_TIMEOUT_MS, 45000);
});
