import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SNIPPETS,
  retrieveDoctrineSnippetsForStory,
} from "./why-doctrine-retrieval.mjs";

// ─── fixtures ────────────────────────────────────────────────────────────────

function snippet(id, overrides = {}) {
  return {
    id,
    topics: overrides.topics ?? [],
    geographies: overrides.geographies ?? [],
    keywords: overrides.keywords ?? [],
    body: overrides.body ?? `body for ${id}`,
    prov: overrides.prov ?? "test-fixture",
    ...(overrides.stateVariant !== undefined ? { stateVariant: overrides.stateVariant } : {}),
  };
}

function story(overrides = {}) {
  return {
    metaStoryId: "test-story",
    topic: overrides.topic,
    geographies: overrides.geographies ?? [],
    tags: {
      topics: overrides.tagsTopics ?? [],
      keywords: overrides.tagsKeywords ?? [],
      geographies: overrides.tagsGeographies ?? [],
    },
    ...overrides,
  };
}

// ─── eligibility: primary gate (topic OR geography overlap) ─────────────────

test("retrieval: includes snippet when story topic matches snippet.topics", () => {
  const snippets = [
    snippet("a", { topics: ["Diplomatic relations"] }),
    snippet("b", { topics: ["Migration policy"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations" }),
    snippets,
  });
  assert.deepEqual(result.map((s) => s.id), ["a"]);
});

test("retrieval: includes snippet when story.tags.topics matches snippet.topics", () => {
  const snippets = [
    snippet("a", { topics: ["Diplomatic relations"] }),
    snippet("b", { topics: ["Security cooperation"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ tagsTopics: ["Security cooperation"] }),
    snippets,
  });
  assert.deepEqual(result.map((s) => s.id), ["b"]);
});

test("retrieval: includes snippet when only geography overlap matches", () => {
  // Snippet has no topic overlap but shares geography — still eligible.
  const snippets = [
    snippet("a", { topics: ["Unrelated topic"], geographies: ["US"] }),
    snippet("b", { topics: ["Unrelated topic"], geographies: ["France"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ geographies: ["US"] }),
    snippets,
  });
  assert.deepEqual(result.map((s) => s.id), ["a"]);
});

test("retrieval: returns [] when neither topic nor geography overlaps", () => {
  const snippets = [
    snippet("a", { topics: ["Cooking"], geographies: ["France"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations", geographies: ["US"] }),
    snippets,
  });
  assert.deepEqual(result, []);
});

// ─── ranking: keyword overlap is the primary key ─────────────────────────────

test("retrieval: keyword overlap is the primary ranking key (higher comes first)", () => {
  const snippets = [
    snippet("topic-only", { topics: ["Diplomatic relations"], keywords: [] }),
    snippet("kw-2", { topics: ["Diplomatic relations"], keywords: ["ofac", "sanctions"] }),
    snippet("kw-1", { topics: ["Diplomatic relations"], keywords: ["ofac"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({
      topic: "Diplomatic relations",
      tagsKeywords: ["OFAC", "sanctions"],
    }),
    snippets,
  });
  // kw-2 wins (2 overlaps), kw-1 next (1), topic-only last (0).
  assert.deepEqual(result.map((s) => s.id), ["kw-2", "kw-1", "topic-only"]);
});

test("retrieval: keyword comparison is case-insensitive", () => {
  const snippets = [
    snippet("a", { topics: ["Diplomatic relations"], keywords: ["DEPORTATION"] }),
    snippet("b", { topics: ["Diplomatic relations"], keywords: ["other"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({
      topic: "Diplomatic relations",
      tagsKeywords: ["deportation"],
    }),
    snippets,
  });
  assert.equal(result[0].id, "a");
});

test("retrieval: no story keywords -> keyword boost is neutral (still ranks by geography)", () => {
  const snippets = [
    snippet("solo-geo", { topics: ["Diplomatic relations"], geographies: ["US"] }),
    snippet("dual-geo", { topics: ["Diplomatic relations"], geographies: ["US", "Colombia"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations", geographies: ["US", "Colombia"] }),
    snippets,
  });
  // Both kw=0 so geography overlap is the next tiebreaker.
  assert.deepEqual(result.map((s) => s.id), ["dual-geo", "solo-geo"]);
});

// ─── ranking: stateVariant boost ─────────────────────────────────────────────

test("retrieval: stateVariant match outranks a non-matching snippet at equal kw + geo", () => {
  const snippets = [
    snippet("plain", { topics: ["Diplomatic relations"], geographies: ["US"] }),
    snippet("steady", {
      topics: ["Diplomatic relations"],
      geographies: ["US"],
      stateVariant: "steady",
    }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations", geographies: ["US"] }),
    state: "steady",
    snippets,
  });
  assert.equal(result[0].id, "steady");
});

test("retrieval: stateVariant boost only applies when state matches", () => {
  const snippets = [
    snippet("plain", { topics: ["Diplomatic relations"], geographies: ["US"] }),
    snippet("intro", {
      topics: ["Diplomatic relations"],
      geographies: ["US"],
      stateVariant: "intro",
    }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations", geographies: ["US"] }),
    state: "evolving",
    snippets,
  });
  // No state match for either, deterministic tie-break by id asc: intro < plain.
  assert.deepEqual(result.map((s) => s.id), ["intro", "plain"]);
});

// ─── cap and determinism ─────────────────────────────────────────────────────

test("retrieval: caps to top-3 by default", () => {
  const snippets = [
    snippet("a", { topics: ["Diplomatic relations"] }),
    snippet("b", { topics: ["Diplomatic relations"] }),
    snippet("c", { topics: ["Diplomatic relations"] }),
    snippet("d", { topics: ["Diplomatic relations"] }),
    snippet("e", { topics: ["Diplomatic relations"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations" }),
    snippets,
  });
  assert.equal(result.length, 3);
});

test("retrieval: maxSnippets override is honored", () => {
  const snippets = [
    snippet("a", { topics: ["Diplomatic relations"] }),
    snippet("b", { topics: ["Diplomatic relations"] }),
    snippet("c", { topics: ["Diplomatic relations"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations" }),
    snippets,
    maxSnippets: 1,
  });
  assert.equal(result.length, 1);
});

test("retrieval: deterministic tie-break uses id ascending", () => {
  // All snippets have identical kw / geo / stateMatch scores; only id differs.
  const snippets = [
    snippet("c-snip", { topics: ["Diplomatic relations"] }),
    snippet("a-snip", { topics: ["Diplomatic relations"] }),
    snippet("b-snip", { topics: ["Diplomatic relations"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations" }),
    snippets,
  });
  assert.deepEqual(result.map((s) => s.id), ["a-snip", "b-snip", "c-snip"]);
});

// ─── malformed / edge-case input safety ──────────────────────────────────────

test("retrieval: returns [] for falsy story", () => {
  assert.deepEqual(retrieveDoctrineSnippetsForStory({ story: null }), []);
  assert.deepEqual(retrieveDoctrineSnippetsForStory({ story: undefined }), []);
  assert.deepEqual(retrieveDoctrineSnippetsForStory({}), []);
});

test("retrieval: returns [] for non-array snippets", () => {
  assert.deepEqual(
    retrieveDoctrineSnippetsForStory({ story: story({ topic: "Diplomatic relations" }), snippets: null }),
    []
  );
  assert.deepEqual(
    retrieveDoctrineSnippetsForStory({
      story: story({ topic: "Diplomatic relations" }),
      snippets: "not an array",
    }),
    []
  );
});

test("retrieval: skips malformed snippets (missing id) without throwing", () => {
  const snippets = [
    { topics: ["Diplomatic relations"], body: "no id" },
    snippet("good", { topics: ["Diplomatic relations"] }),
    null,
    "string-not-object",
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations" }),
    snippets,
  });
  assert.deepEqual(result.map((s) => s.id), ["good"]);
});

test("retrieval: handles snippets with missing topics/geographies/keywords arrays", () => {
  const snippets = [
    { id: "sparse", body: "x", topics: null, geographies: undefined, keywords: 5 },
    snippet("ok", { topics: ["Diplomatic relations"] }),
  ];
  const result = retrieveDoctrineSnippetsForStory({
    story: story({ topic: "Diplomatic relations" }),
    snippets,
  });
  // Sparse snippet has no eligible overlap; only `ok` returned.
  assert.deepEqual(result.map((s) => s.id), ["ok"]);
});

// ─── default corpus sanity ───────────────────────────────────────────────────

test("DEFAULT_SNIPPETS: loads the on-disk corpus and every entry has a string id", () => {
  assert.ok(Array.isArray(DEFAULT_SNIPPETS));
  assert.ok(DEFAULT_SNIPPETS.length >= 5, `expected >=5 default snippets, got ${DEFAULT_SNIPPETS.length}`);
  for (const s of DEFAULT_SNIPPETS) {
    assert.equal(typeof s.id, "string");
    assert.ok(s.id.length > 0);
    assert.equal(typeof s.body, "string");
  }
});

test("DEFAULT_SNIPPETS: retrieval against the live corpus returns 1..3 snippets for a canonical story", () => {
  const result = retrieveDoctrineSnippetsForStory({
    story: story({
      topic: "Diplomatic relations",
      geographies: ["US", "Colombia"],
      tagsKeywords: ["OFAC"],
    }),
    state: "intro",
  });
  assert.ok(result.length >= 1);
  assert.ok(result.length <= 3);
  // The intro-state posture snippet should appear when state="intro".
  assert.ok(result.some((s) => s.id === "doctrine.posture.intro"));
});
