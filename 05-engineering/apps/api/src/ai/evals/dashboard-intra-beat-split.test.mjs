// Dashboard Intra-Beat Split — regression test (node:test).
//
// Wired as `npm run eval:dashboard-intra-beat-split`. Hermetic: the core stubs
// clustering (intentionally over-merging) and runs recall in keyword mode, so
// no provider keys / network are needed. Locks the exact failure mode the
// cluster-split healer fixes: same-country UNRELATED events (Colombia election
// + mine attack) must end as SEPARATE meta-stories, while a same-event pair
// must stay merged (no over-split).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLOMBIA_UNRELATED_ITEMS,
  COLOMBIA_SAME_EVENT_ITEMS,
  runIntraBeatSplit,
  runIntraBeatControl,
} from "./dashboard-intra-beat-split-core.mjs";

const UNRELATED_IDS = COLOMBIA_UNRELATED_ITEMS.map((i) => i.sourceId);
const SAME_EVENT_IDS = COLOMBIA_SAME_EVENT_ITEMS.map((i) => i.sourceId);

// ── Scenario A: unrelated same-country events get split ──────────────────────

test("Scenario A: merged Colombia election + mine become 2 distinct stories (healer ON)", async () => {
  const { payload, clusterInput } = await runIntraBeatSplit();
  const stories = payload?.stories ?? [];

  // Sanity: recall delivered BOTH unrelated items to clustering (so the stub
  // really merged two stories, not one) — guards against an upstream drop
  // silently turning this into a 1-item passthrough.
  const inputIds = clusterInput.map((i) => i.sourceId).sort();
  assert.deepEqual(inputIds, [...UNRELATED_IDS].sort(), "both unrelated items must reach clustering");

  // The over-merged cluster is split back into one story per source item.
  assert.equal(stories.length, 2, `expected 2 split stories, got ${stories.length}`);

  // Distinct meta-stories with disjoint, single-source evidence sets.
  const ids = stories.map((s) => s.metaStoryId);
  assert.notEqual(ids[0], ids[1], "split stories must have distinct metaStoryIds");
  const srcSets = stories.map((s) => s.sources.map((src) => src.id).sort());
  for (const set of srcSets) {
    assert.equal(set.length, 1, "each split story owns exactly one source item");
  }
  const allShipped = srcSets.flat().sort();
  assert.deepEqual(allShipped, [...UNRELATED_IDS].sort(), "every original source surfaces, once");

  // Titles read as the two distinct events (election vs mine attack).
  const titles = stories.map((s) => s.title).join(" || ");
  assert.match(titles, /election/i, "an election story must surface");
  assert.match(titles, /mine/i, "a mine-attack story must surface");
});

// ── Scenario B: a genuine same-event pair stays merged ───────────────────────

test("Scenario B: same-event election pair stays a single story (no over-split)", async () => {
  const { payload, clusterInput } = await runIntraBeatControl();
  const stories = payload?.stories ?? [];

  const inputIds = clusterInput.map((i) => i.sourceId).sort();
  assert.deepEqual(inputIds, [...SAME_EVENT_IDS].sort(), "both same-event items must reach clustering");

  assert.equal(stories.length, 1, `expected the pair to stay merged, got ${stories.length} stories`);
  const merged = stories[0];
  const mergedSrcIds = merged.sources.map((s) => s.id).sort();
  assert.deepEqual(mergedSrcIds, [...SAME_EVENT_IDS].sort(), "the merged story owns both source items");
});

// ── Scenario C: split diagnostics are present and counted correctly ──────────

test("Scenario C: log.clusterSplit diagnostics reflect split activity per scenario", async () => {
  const split = await runIntraBeatSplit();
  const control = await runIntraBeatControl();

  // Diagnostics surface exists on both runs.
  assert.ok(split.log?.clusterSplit, "Scenario A: log.clusterSplit present");
  assert.ok(control.log?.clusterSplit, "Scenario B: log.clusterSplit present");

  // Healer is on by default in both runs.
  assert.equal(split.log.clusterSplit.enabled, true);
  assert.equal(control.log.clusterSplit.enabled, true);

  // Scenario A split exactly one over-merged cluster; Scenario B split none.
  assert.ok(split.log.clusterSplit.splitCount >= 1, "Scenario A: splitCount >= 1");
  assert.equal(control.log.clusterSplit.splitCount, 0, "Scenario B: splitCount === 0");

  // The split was attributed to the low-token-overlap path (geography stripped,
  // unrelated vocabulary) — the signal this harness protects.
  assert.ok(
    split.log.clusterSplit.splitReasons.low_token_overlap >= 1,
    "Scenario A: split credited to low_token_overlap"
  );
});
