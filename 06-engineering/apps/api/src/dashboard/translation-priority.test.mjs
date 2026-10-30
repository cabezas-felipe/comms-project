// Unit tests for the cold-start translation priority ranker (node:test). Pure +
// hermetic — no network, no provider keys, no DB. Pins the A4 contract:
//   A. empty input → empty output
//   B. all items preserved + order is deterministic across repeated runs
//   C. a higher pre-cluster-relevance item ranks above a lower one
//   D. ties break deterministically (freshness then sourceId)
//   E. input array and item objects are never mutated

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rankItemsForTranslation,
  scoreItemsForTranslation,
} from "./translation-priority.mjs";

const SETTINGS = Object.freeze({
  topics: ["election"],
  keywords: ["election"],
  geographies: ["Colombia"],
});

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    headline: "",
    body: ["Placeholder body."],
    geographies: [],
    url: "https://example.com",
    minutesAgo: 60,
    ...overrides,
  };
}

// On-beat, high-relevance item: configured topic + keyword + geography.
function onBeat(overrides = {}) {
  return makeItem({
    headline: "Colombia election results announced",
    topic: "election",
    geographies: ["Colombia"],
    minutesAgo: 30,
    ...overrides,
  });
}

// Off-beat, low-relevance item: no topic/keyword/geo fit at all.
function offBeat(overrides = {}) {
  return makeItem({
    headline: "Weather forecast cloudy skies this weekend",
    topic: "weather",
    geographies: [],
    minutesAgo: 30,
    ...overrides,
  });
}

// ── A. empty input ────────────────────────────────────────────────────────────

test("A: empty array input → empty array output", () => {
  assert.deepEqual(rankItemsForTranslation([], SETTINGS), []);
  assert.deepEqual(scoreItemsForTranslation([], SETTINGS), []);
});

test("A: non-array input is handled safely → empty array", () => {
  assert.deepEqual(rankItemsForTranslation(null, SETTINGS), []);
  assert.deepEqual(rankItemsForTranslation(undefined, SETTINGS), []);
});

// ── B. preservation + determinism ─────────────────────────────────────────────

test("B: preserves every item exactly once (no drops, no duplicates)", () => {
  const items = [
    onBeat({ sourceId: "a" }),
    offBeat({ sourceId: "b" }),
    onBeat({ sourceId: "c", minutesAgo: 200 }),
    offBeat({ sourceId: "d", minutesAgo: 5 }),
  ];
  const ranked = rankItemsForTranslation(items, SETTINGS);
  assert.equal(ranked.length, items.length, "length is preserved");
  assert.deepEqual(
    [...ranked.map((i) => i.sourceId)].sort(),
    [...items.map((i) => i.sourceId)].sort(),
    "the exact set of items is preserved (set-equal)"
  );
  // Each returned entry is one of the original item references (no clones).
  for (const r of ranked) assert.ok(items.includes(r), "returns original item refs");
});

test("B: order is deterministic across repeated runs", () => {
  const items = [
    offBeat({ sourceId: "d", minutesAgo: 5 }),
    onBeat({ sourceId: "a" }),
    onBeat({ sourceId: "c", minutesAgo: 200 }),
    offBeat({ sourceId: "b" }),
  ];
  const first = rankItemsForTranslation(items, SETTINGS).map((i) => i.sourceId);
  const second = rankItemsForTranslation(items, SETTINGS).map((i) => i.sourceId);
  const third = rankItemsForTranslation([...items], SETTINGS).map((i) => i.sourceId);
  assert.deepEqual(first, second, "same input → identical order");
  assert.deepEqual(first, third, "shallow-copied input → identical order");
});

// ── C. relevance ordering ─────────────────────────────────────────────────────

test("C: a higher pre-cluster-relevance item ranks above a lower one", () => {
  const high = onBeat({ sourceId: "high" });
  const low = offBeat({ sourceId: "low" });
  // Feed low-first so a correct result cannot be an accident of input order.
  const ranked = rankItemsForTranslation([low, high], SETTINGS);
  assert.equal(ranked[0].sourceId, "high", "on-beat item ranks first");
  assert.equal(ranked[1].sourceId, "low");

  // Cross-check the underlying scores via the companion helper.
  const scored = scoreItemsForTranslation([low, high], SETTINGS);
  const byId = Object.fromEntries(scored.map((s) => [s.item.sourceId, s.score.preClusterScore]));
  assert.ok(
    byId.high > byId.low,
    `on-beat score (${byId.high}) must exceed off-beat score (${byId.low})`
  );
});

// ── D. deterministic tie-breaks ───────────────────────────────────────────────

test("D: an exact content tie breaks by sourceId ascending", () => {
  // Identical scoring content + identical minutesAgo → score, corroboration,
  // beatFit, and freshness all tie; only the sourceId tie-break decides. (They
  // share a headline family, so both get the same corroboration — still a tie.)
  const items = [
    onBeat({ sourceId: "ccc" }),
    onBeat({ sourceId: "aaa" }),
    onBeat({ sourceId: "bbb" }),
  ];
  const order = rankItemsForTranslation(items, SETTINGS).map((i) => i.sourceId);
  assert.deepEqual(order, ["aaa", "bbb", "ccc"], "exact ties resolve sourceId-ascending");
});

test("D: freshness breaks a tie before sourceId (fresher wins even with a later id)", () => {
  // Same scoring content, differ only in freshness. The fresher item carries the
  // alphabetically LATER sourceId, so if freshness did not outrank sourceId the
  // order would flip — this proves the tie-break precedence.
  const fresher = onBeat({ sourceId: "zzz", minutesAgo: 5 });
  const staler = onBeat({ sourceId: "aaa", minutesAgo: 600 });
  const order = rankItemsForTranslation([staler, fresher], SETTINGS).map((i) => i.sourceId);
  assert.deepEqual(order, ["zzz", "aaa"], "fresher item ranks first despite the later sourceId");
});

// ── E. input immutability ─────────────────────────────────────────────────────

test("E: input array and item objects are not mutated", () => {
  const items = [
    onBeat({ sourceId: "a" }),
    offBeat({ sourceId: "b", minutesAgo: 5 }),
    onBeat({ sourceId: "c", minutesAgo: 200 }),
  ];
  const arraySnapshot = [...items]; // references, in original order
  const deepSnapshot = JSON.parse(JSON.stringify(items)); // values

  const ranked = rankItemsForTranslation(items, SETTINGS);

  // The input array itself keeps its original element order (not sorted in place).
  assert.deepEqual(items, arraySnapshot, "input array order is unchanged");
  for (let i = 0; i < items.length; i++) {
    assert.equal(items[i], arraySnapshot[i], `input[${i}] is the same reference`);
  }
  // No item object was mutated (deep value equality vs the pre-run snapshot).
  assert.deepEqual(JSON.parse(JSON.stringify(items)), deepSnapshot, "item objects unchanged");
  // The result is a distinct array from the input.
  assert.notEqual(ranked, items, "returns a new array, not the input array");
});
