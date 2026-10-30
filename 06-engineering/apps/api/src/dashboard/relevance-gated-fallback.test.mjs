import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRelevanceGatedFallbackStories } from "./relevance-gated-fallback.mjs";

// Strict gate settings: one topic (lexicon cluster "election") + one keyword.
const SETTINGS = {
  topics: ["election"],
  keywords: ["sanctions"],
  geographies: ["Colombia"],
};

// Minimal item factory matching the candidate-item shape the pipeline uses.
function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    topic: "News",
    outlet: "Reuters",
    geographies: ["Colombia"],
    minutesAgo: 30,
    headline: "Generic headline",
    body: ["Generic body."],
    ...overrides,
  };
}

// ── A) Strict eligibility ─────────────────────────────────────────────────────

test("topic fit but no keyword fit is excluded", () => {
  const items = [makeItem({ sourceId: "a", headline: "Election day approaches" })];
  const { stories, diagnostics } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.equal(stories.length, 0);
  assert.equal(diagnostics.excludedReasons.no_keyword_fit, 1);
  assert.equal(diagnostics.excludedReasons.no_topic_fit, 0);
});

test("keyword fit but no topic fit is excluded", () => {
  const items = [makeItem({ sourceId: "b", headline: "New sanctions imposed today" })];
  const { stories, diagnostics } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.equal(stories.length, 0);
  assert.equal(diagnostics.excludedReasons.no_topic_fit, 1);
  assert.equal(diagnostics.excludedReasons.no_keyword_fit, 0);
});

test("item with both topic and keyword fit is eligible", () => {
  const items = [makeItem({ sourceId: "c", headline: "Election sanctions announced" })];
  const { stories, diagnostics } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.equal(stories.length, 1);
  assert.equal(diagnostics.eligibleCount, 1);
  assert.equal(diagnostics.outputCount, 1);
});

test("excluded-wrapper shape (not a beat-fit survivor) is rejected defensively", () => {
  // An accidentally-passed `applyBeatFitFilter` excluded wrapper.
  const items = [{ item: makeItem(), excludeReason: "below_threshold", sourceId: "x" }];
  const { stories, diagnostics } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.equal(stories.length, 0);
  assert.equal(diagnostics.excludedReasons.not_beat_fit_included, 1);
});

test("item missing a usable sourceId is excluded", () => {
  const items = [makeItem({ sourceId: "", headline: "Election sanctions announced" })];
  const { diagnostics } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.equal(diagnostics.excludedReasons.missing_source_id, 1);
});

// ── B) Deterministic ordering and cap ─────────────────────────────────────────

function makeEligiblePool(n) {
  return Array.from({ length: n }, (_, i) =>
    makeItem({
      sourceId: `src-${i}`,
      headline: `Election sanctions update ${i}`,
      minutesAgo: i * 10, // vary freshness so ordering is exercised
    })
  );
}

test("ordering is deterministic across runs", () => {
  const items = makeEligiblePool(7);
  const run1 = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  const run2 = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.deepEqual(
    run1.stories.map((s) => s.meta_story_id),
    run2.stories.map((s) => s.meta_story_id)
  );
});

test("capped at 5 stories by default", () => {
  const items = makeEligiblePool(7);
  const { stories, diagnostics } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.equal(stories.length, 5);
  assert.equal(diagnostics.eligibleCount, 7);
  assert.equal(diagnostics.outputCount, 5);
  assert.equal(diagnostics.excludedReasons.over_cap, 2);
});

test("maxStories override is honored", () => {
  const items = makeEligiblePool(7);
  const { stories } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS, maxStories: 3 });
  assert.equal(stories.length, 3);
});

// ── C) Output shape ───────────────────────────────────────────────────────────

test("stories are singletons with a deterministic meta_story_id and no generic bucket phrasing", () => {
  const items = [
    makeItem({ sourceId: "c", outlet: "El Tiempo", headline: "Election sanctions announced" }),
  ];
  const { stories } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  const [story] = stories;

  assert.equal(story.source_item_ids.length, 1);
  assert.equal(story.source_item_ids[0], "c");
  assert.equal(typeof story.meta_story_id, "string");
  assert.ok(story.meta_story_id.length > 0);

  // Schema-shaped fields present.
  assert.ok(Array.isArray(story.factual_claims) && story.factual_claims.length >= 1);
  assert.deepEqual(story.claim_evidence_map, { "0": ["c"] });

  // No "General Updates" / "<Topic> Updates" style bucket phrasing.
  const blob = `${story.title} ${story.subtitle} ${story.summary}`;
  assert.doesNotMatch(blob, /general updates/i);
  assert.doesNotMatch(blob, /\bUpdates\b/);
});

test("tags are grounded in the source item + settings", () => {
  const items = [makeItem({ sourceId: "c", headline: "Election sanctions announced", geographies: ["Colombia", "France"] })];
  const { stories } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  const [story] = stories;
  // Geography tags intersected with the configured set (France dropped).
  assert.deepEqual(story.tags.geographies, ["Colombia"]);
  assert.ok(story.tags.keywords.includes("sanctions"));
});

// ── D) Diagnostics ────────────────────────────────────────────────────────────

test("diagnostics counts match input/eligible/output and bucket exclusions", () => {
  const items = [
    makeItem({ sourceId: "a", headline: "Election day approaches" }),      // no keyword
    makeItem({ sourceId: "b", headline: "New sanctions imposed today" }),  // no topic
    makeItem({ sourceId: "c", headline: "Election sanctions announced" }), // eligible
    { item: makeItem(), excludeReason: "x", sourceId: "d" },               // not beat-fit
  ];
  const { diagnostics } = buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.equal(diagnostics.inputCount, 4);
  assert.equal(diagnostics.eligibleCount, 1);
  assert.equal(diagnostics.outputCount, 1);
  assert.equal(diagnostics.excludedReasons.no_keyword_fit, 1);
  assert.equal(diagnostics.excludedReasons.no_topic_fit, 1);
  assert.equal(diagnostics.excludedReasons.not_beat_fit_included, 1);
});

test("excludedReasons always exposes every bucket key", () => {
  const { diagnostics } = buildRelevanceGatedFallbackStories({ items: [], settings: SETTINGS });
  assert.deepEqual(Object.keys(diagnostics.excludedReasons).sort(), [
    "missing_source_id",
    "no_keyword_fit",
    "no_topic_fit",
    "not_beat_fit_included",
    "over_cap",
  ]);
  assert.equal(diagnostics.inputCount, 0);
  assert.equal(diagnostics.outputCount, 0);
});

// ── E) Purity ─────────────────────────────────────────────────────────────────

test("input array and items are not mutated", () => {
  const items = makeEligiblePool(6);
  const before = structuredClone(items);
  // Deep-freeze so any in-place mutation would throw.
  for (const it of items) Object.freeze(it);
  Object.freeze(items);
  buildRelevanceGatedFallbackStories({ items, settings: SETTINGS });
  assert.deepEqual(items, before);
});

test("stable with non-array / empty input", () => {
  const a = buildRelevanceGatedFallbackStories({ items: undefined, settings: SETTINGS });
  assert.equal(a.stories.length, 0);
  assert.equal(a.diagnostics.inputCount, 0);
});
