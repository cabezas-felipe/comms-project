import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateMetaStoryId,
  verifyGrounding,
  gracefulFallbackClustering,
  extractiveSummary,
  clusterItems,
} from "./cluster-engine.mjs";

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    outlet: "Reuters",
    topic: "Diplomatic relations",
    geographies: ["US", "Colombia"],
    weight: 75,
    url: "https://example.com",
    minutesAgo: 30,
    headline: "Test headline",
    body: ["Test body."],
    kind: "traditional",
    ...overrides,
  };
}

const BASE_SETTINGS = {
  topics: ["Diplomatic relations"],
  keywords: ["OFAC"],
  geographies: ["US"],
  traditionalSources: ["Reuters"],
  socialSources: [],
};

// ─── generateMetaStoryId ──────────────────────────────────────────────────────

const EVIDENCE_A = {
  source_item_ids: ["src-a", "src-b"],
  tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
};
const EVIDENCE_B = {
  source_item_ids: ["src-c"],
  tags: { topics: ["Migration policy"], keywords: [], geographies: [] },
};

test("generateMetaStoryId: returns 16-char lowercase hex string", () => {
  const id = generateMetaStoryId(EVIDENCE_A);
  assert.ok(/^[0-9a-f]{16}$/.test(id), `expected 16-char hex, got: ${id}`);
});

test("generateMetaStoryId: same evidence → same ID (stable)", () => {
  assert.equal(generateMetaStoryId(EVIDENCE_A), generateMetaStoryId({ ...EVIDENCE_A }));
});

test("generateMetaStoryId: different evidence → different IDs (collision-resistant)", () => {
  assert.notEqual(generateMetaStoryId(EVIDENCE_A), generateMetaStoryId(EVIDENCE_B));
});

test("generateMetaStoryId: source_item_id order does not affect ID (sorted before hashing)", () => {
  const ms1 = { source_item_ids: ["src-b", "src-a"], tags: { topics: ["Diplomatic relations"] } };
  const ms2 = { source_item_ids: ["src-a", "src-b"], tags: { topics: ["Diplomatic relations"] } };
  assert.equal(generateMetaStoryId(ms1), generateMetaStoryId(ms2));
});

test("generateMetaStoryId: ID is stable regardless of title text (evidence-based, not title-based)", () => {
  const base = { source_item_ids: ["src-x"], tags: { topics: ["Diplomatic relations"] } };
  const withTitleA = { ...base, title: "Title A" };
  const withTitleB = { ...base, title: "Title B — completely different wording" };
  assert.equal(
    generateMetaStoryId(withTitleA),
    generateMetaStoryId(withTitleB),
    "changing title must not change meta_story_id"
  );
});

// ─── verifyGrounding ──────────────────────────────────────────────────────────

test("verifyGrounding: all valid IDs → valid", () => {
  const sourceItemsById = new Map([["id-1", makeItem()], ["id-2", makeItem({ sourceId: "id-2" })]]);
  const story = { meta_story_id: "x", source_item_ids: ["id-1", "id-2"], summary: "ok" };
  const { valid, invalid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 0);
});

test("verifyGrounding: all hallucinated IDs → invalid with no_valid_source_ids", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const story = { meta_story_id: "x", source_item_ids: ["fake-1", "fake-2"], summary: "hallucinated" };
  const { valid, invalid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid.length, 0);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].groundingFailure, "no_valid_source_ids");
});

test("verifyGrounding: some hallucinated IDs → invalid with partial_source_ids, valid IDs trimmed", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const story = { meta_story_id: "x", source_item_ids: ["id-1", "fake-1"], summary: "partial" };
  const { valid, invalid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid.length, 0);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].groundingFailure, "partial_source_ids");
  assert.deepEqual(invalid[0].source_item_ids, ["id-1"]);
});

test("verifyGrounding: mixed — some stories valid, some not", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const validStory = { meta_story_id: "good", source_item_ids: ["id-1"], summary: "ok" };
  const badStory = { meta_story_id: "bad", source_item_ids: ["fake"], summary: "bad" };
  const { valid, invalid } = verifyGrounding([validStory, badStory], sourceItemsById);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 1);
  assert.equal(valid[0].meta_story_id, "good");
  assert.equal(invalid[0].meta_story_id, "bad");
});

test("verifyGrounding: rejects story when a claim has no valid evidence (ungrounded_claims)", () => {
  const sourceItemsById = new Map([["real-id", makeItem()]]);
  const story = {
    meta_story_id: "x",
    source_item_ids: ["real-id"],
    summary: "Claim with hallucinated evidence.",
    factual_claims: ["Fabricated claim."],
    claim_evidence_map: { "0": ["hallucinated-id"] },
  };
  const { valid, invalid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid.length, 0);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].groundingFailure, "ungrounded_claims");
});

test("verifyGrounding: passes claim-level when all claims have valid evidence", () => {
  const sourceItemsById = new Map([["id-1", makeItem()], ["id-2", makeItem({ sourceId: "id-2" })]]);
  const story = {
    meta_story_id: "x",
    source_item_ids: ["id-1", "id-2"],
    summary: "Both claims grounded.",
    factual_claims: ["Claim A.", "Claim B."],
    claim_evidence_map: { "0": ["id-1"], "1": ["id-2"] },
  };
  const { valid, invalid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 0);
});

test("verifyGrounding: empty factual_claims bypasses claim-level check", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const story = {
    meta_story_id: "x",
    source_item_ids: ["id-1"],
    summary: "ok",
    factual_claims: [],
    claim_evidence_map: {},
  };
  const { valid, invalid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 0);
});

test("verifyGrounding: replaces summary with first factual_claim only — J3b (closes ungrounded-prose bypass)", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const story = {
    meta_story_id: "x",
    source_item_ids: ["id-1"],
    summary: "Model prose with an extra ungrounded assertion beyond the claims.",
    subtitle: "LLM subtitle with potential ungrounded context.",
    factual_claims: ["Grounded claim from source."],
    claim_evidence_map: { "0": ["id-1"] },
  };
  const { valid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid.length, 1);
  assert.equal(
    valid[0].summary,
    "Grounded claim from source.",
    "summary must be replaced with first verified claim only (J3b)"
  );
});

test("verifyGrounding: replaces subtitle with first factual_claim", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const story = {
    meta_story_id: "x",
    source_item_ids: ["id-1"],
    summary: "ok",
    subtitle: "LLM subtitle.",
    factual_claims: ["First grounded claim.", "Second grounded claim."],
    claim_evidence_map: { "0": ["id-1"], "1": ["id-1"] },
  };
  const { valid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid[0].subtitle, "First grounded claim.", "subtitle must be replaced with first claim");
  assert.equal(
    valid[0].summary,
    "First grounded claim.",
    "J3b: summary uses first claim only, not a join of all claims"
  );
});

test("verifyGrounding: keeps original summary/subtitle when factual_claims is empty", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const story = {
    meta_story_id: "x",
    source_item_ids: ["id-1"],
    summary: "Original summary.",
    subtitle: "Original subtitle.",
    factual_claims: [],
    claim_evidence_map: {},
  };
  const { valid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid[0].summary, "Original summary.");
  assert.equal(valid[0].subtitle, "Original subtitle.");
});

test("verifyGrounding: no_valid_source_ids gate fires before claim-level check", () => {
  const sourceItemsById = new Map([["real-id", makeItem()]]);
  // Story has hallucinated source IDs and a claim — source gate fires first
  const story = {
    meta_story_id: "x",
    source_item_ids: ["fake-id"],
    summary: "Hallucinated.",
    factual_claims: ["A claim."],
    claim_evidence_map: { "0": ["real-id"] },
  };
  const { valid, invalid } = verifyGrounding([story], sourceItemsById);
  assert.equal(invalid[0].groundingFailure, "no_valid_source_ids");
});

// ─── extractiveSummary ────────────────────────────────────────────────────────

test("extractiveSummary: builds summary from headlines", () => {
  const items = [makeItem({ headline: "Headline A" }), makeItem({ headline: "Headline B" })];
  const summary = extractiveSummary("Test Title", items);
  assert.ok(summary.includes("Test Title"));
  assert.ok(summary.includes("Headline A"));
  assert.ok(summary.includes("Headline B"));
});

test("extractiveSummary: caps at 3 headlines", () => {
  const items = Array.from({ length: 5 }, (_, i) => makeItem({ headline: `H${i}` }));
  const summary = extractiveSummary("T", items);
  assert.ok(!summary.includes("H3"), "fourth headline must not appear");
  assert.ok(!summary.includes("H4"), "fifth headline must not appear");
});

// ─── gracefulFallbackClustering ───────────────────────────────────────────────

test("gracefulFallbackClustering: groups items by topic", () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Diplomatic relations" }),
    makeItem({ sourceId: "b", topic: "Migration policy" }),
    makeItem({ sourceId: "c", topic: "Diplomatic relations" }),
  ];
  const stories = gracefulFallbackClustering(items, BASE_SETTINGS);
  assert.equal(stories.length, 2);
  const dipStory = stories.find((s) => s.tags.topics[0] === "Diplomatic relations");
  assert.ok(dipStory);
  assert.equal(dipStory.source_item_ids.length, 2);
});

test("gracefulFallbackClustering: caps at 5 meta-stories", () => {
  const topics = ["A", "B", "C", "D", "E", "F"];
  const items = topics.map((t, i) => makeItem({ sourceId: `s${i}`, topic: t }));
  const stories = gracefulFallbackClustering(items, BASE_SETTINGS);
  assert.ok(stories.length <= 5);
});

test("gracefulFallbackClustering: caps at 5 items per meta-story", () => {
  const items = Array.from({ length: 8 }, (_, i) =>
    makeItem({ sourceId: `s${i}`, topic: "Diplomatic relations" })
  );
  const stories = gracefulFallbackClustering(items, BASE_SETTINGS);
  assert.equal(stories.length, 1);
  assert.ok(stories[0].source_item_ids.length <= 5);
});

// ─── clusterItems (mock provider) ────────────────────────────────────────────

test("clusterItems: mock provider returns stories grouped by topic", async () => {
  const items = [
    makeItem({ sourceId: "a", topic: "Diplomatic relations" }),
    makeItem({ sourceId: "b", topic: "Migration policy" }),
  ];
  const stories = await clusterItems(items, BASE_SETTINGS, "mock-anthropic-haiku");
  assert.ok(stories.length >= 1);
  assert.ok(stories.length <= 5);
  for (const s of stories) {
    assert.ok(typeof s.meta_story_id === "string" && s.meta_story_id.length > 0);
    assert.ok(typeof s.title === "string");
    assert.ok(Array.isArray(s.source_item_ids) && s.source_item_ids.length > 0);
    assert.ok(s.source_item_ids.length <= 5);
    assert.ok(Array.isArray(s.factual_claims) && s.factual_claims.length > 0, "mock must include factual_claims");
    assert.ok(s.claim_evidence_map && typeof s.claim_evidence_map === "object", "mock must include claim_evidence_map");
    for (let i = 0; i < s.factual_claims.length; i++) {
      const evidence = s.claim_evidence_map[String(i)];
      assert.ok(Array.isArray(evidence) && evidence.length > 0, `claim ${i} must have evidence`);
    }
  }
});

test("clusterItems: returns empty array for empty input", async () => {
  const stories = await clusterItems([], BASE_SETTINGS, "mock-anthropic-haiku");
  assert.equal(stories.length, 0);
});

test("clusterItems: throws when anthropic model requested but API key absent", async () => {
  const savedKey = process.env.TEMPO_ANTHROPIC_API_KEY;
  const savedAlt = process.env.ANTHROPIC_API_KEY;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => clusterItems([makeItem()], BASE_SETTINGS, "anthropic:claude-haiku-4-5-20251001"),
      /TEMPO_ANTHROPIC_API_KEY/
    );
  } finally {
    if (savedKey !== undefined) process.env.TEMPO_ANTHROPIC_API_KEY = savedKey;
    if (savedAlt !== undefined) process.env.ANTHROPIC_API_KEY = savedAlt;
  }
});

// ─── M2: N2 Sonnet routing on refresh path ───────────────────────────────────
//
// The mock branch swallows missing keys silently; only the real Anthropic
// branch surfaces `TEMPO_ANTHROPIC_API_KEY`.  Asserting that error with the
// N2 SKU is the contract proof that refresh would invoke the real cluster
// path when the env is set in staging/prototype.

test("clusterItems: N2 Sonnet env takes real Anthropic path (proven via missing-key error)", async () => {
  const savedKey = process.env.TEMPO_ANTHROPIC_API_KEY;
  const savedAlt = process.env.ANTHROPIC_API_KEY;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => clusterItems([makeItem()], BASE_SETTINGS, "anthropic:claude-sonnet-4-6"),
      /TEMPO_ANTHROPIC_API_KEY/
    );
  } finally {
    if (savedKey !== undefined) process.env.TEMPO_ANTHROPIC_API_KEY = savedKey;
    if (savedAlt !== undefined) process.env.ANTHROPIC_API_KEY = savedAlt;
  }
});

test("clusterItems: TEMPO_AI_MOCK_ONLY=true forces mock even for Sonnet env (CI safety)", async () => {
  const savedKey = process.env.TEMPO_ANTHROPIC_API_KEY;
  const savedAlt = process.env.ANTHROPIC_API_KEY;
  const savedMock = process.env.TEMPO_AI_MOCK_ONLY;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  try {
    // No key set; if this hit the real path it would reject — mock branch must absorb it.
    const stories = await clusterItems(
      [makeItem({ sourceId: "m1" })],
      BASE_SETTINGS,
      "anthropic:claude-sonnet-4-6"
    );
    assert.ok(Array.isArray(stories) && stories.length >= 1);
  } finally {
    if (savedKey !== undefined) process.env.TEMPO_ANTHROPIC_API_KEY = savedKey;
    if (savedAlt !== undefined) process.env.ANTHROPIC_API_KEY = savedAlt;
    if (savedMock !== undefined) process.env.TEMPO_AI_MOCK_ONLY = savedMock;
    else delete process.env.TEMPO_AI_MOCK_ONLY;
  }
});
