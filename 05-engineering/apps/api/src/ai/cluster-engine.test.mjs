import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateMetaStoryId,
  verifyGrounding,
  gracefulFallbackClustering,
  extractiveSummary,
  clusterItems,
  metaStoryOutputSchema,
} from "./cluster-engine.mjs";
import { validateSmokeOutput, runClusterSmoke } from "./evals/cluster-smoke-core.mjs";
import { buildClusteringPrompt, CLUSTERING_PROMPT_VERSION } from "./prompts.mjs";

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

test("verifyGrounding: single claim → subtitle and summary both use that claim (C0)", () => {
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
  assert.equal(valid[0].subtitle, "Grounded claim from source.");
  // With a single claim, the joined summary equals that claim.  Closes the
  // ungrounded-prose bypass that J3b originally addressed.
  assert.equal(valid[0].summary, "Grounded claim from source.");
});

test("verifyGrounding: C0 — subtitle is first claim, summary joins all claims (≥2 → subtitle ≠ summary)", () => {
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
  assert.equal(valid[0].subtitle, "First grounded claim.");
  assert.equal(
    valid[0].summary,
    "First grounded claim. Second grounded claim.",
    "summary must be a deterministic join of all grounded claims"
  );
  assert.notEqual(
    valid[0].subtitle,
    valid[0].summary,
    "with ≥2 claims, subtitle and summary must differ"
  );
});

test("verifyGrounding: C0 summary normalizes whitespace and appends terminal punctuation", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const story = {
    meta_story_id: "x",
    source_item_ids: ["id-1"],
    summary: "ignored",
    subtitle: "ignored",
    factual_claims: ["  First   claim  ", "Second claim has period."],
    claim_evidence_map: { "0": ["id-1"], "1": ["id-1"] },
  };
  const { valid } = verifyGrounding([story], sourceItemsById);
  assert.equal(valid[0].subtitle, "First claim");
  assert.equal(
    valid[0].summary,
    "First claim. Second claim has period.",
    "joiner normalizes whitespace and ensures each claim ends with terminal punctuation"
  );
});

test("verifyGrounding: C0 summary is capped near 500 chars without breaking mid-word", () => {
  const sourceItemsById = new Map([["id-1", makeItem()]]);
  const longClaim = "This is a long grounded sentence that fills space. ".repeat(20).trim();
  const story = {
    meta_story_id: "x",
    source_item_ids: ["id-1"],
    summary: "ignored",
    subtitle: "ignored",
    factual_claims: [longClaim],
    claim_evidence_map: { "0": ["id-1"] },
  };
  const { valid } = verifyGrounding([story], sourceItemsById);
  assert.ok(
    valid[0].summary.length <= 500,
    `summary should be capped, got ${valid[0].summary.length} chars`
  );
  assert.ok(
    !/\w$/.test(valid[0].summary) || valid[0].summary.endsWith("."),
    "summary should not end mid-word"
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

// ─── M8: cluster shape smoke — schema lock + diagnostic helper ───────────────
// Locks the contract the M8 smoke runner depends on, exercised on the mock
// path so the test suite can run without an Anthropic key.

test("M8 shape lock: mock clusterItems output passes metaStoryOutputSchema", async () => {
  const items = [
    makeItem({ sourceId: "lock-a", topic: "Diplomatic relations" }),
    makeItem({ sourceId: "lock-b", topic: "Migration policy" }),
  ];
  const stories = await clusterItems(items, BASE_SETTINGS, "mock-anthropic-haiku");
  assert.ok(stories.length >= 1, "mock must produce at least one story for two-topic input");
  for (const story of stories) {
    const parsed = metaStoryOutputSchema.safeParse(story);
    assert.ok(
      parsed.success,
      `meta-story must validate against metaStoryOutputSchema — got ${JSON.stringify(parsed.error?.errors)}`
    );
  }
});

test("M8 shape lock: validateSmokeOutput passes on mock clusterItems output", async () => {
  const items = [
    makeItem({ sourceId: "vs-a", topic: "Diplomatic relations" }),
    makeItem({ sourceId: "vs-b", topic: "Migration policy" }),
  ];
  const stories = await clusterItems(items, BASE_SETTINGS, "mock-anthropic-haiku");
  const known = new Set(items.map((i) => i.sourceId));
  const { ok, failures } = validateSmokeOutput(stories, known);
  assert.equal(ok, true, `validateSmokeOutput must pass on healthy mock output: ${failures.join("; ")}`);
  assert.deepEqual(failures, []);
});

test("M8 shape lock: validateSmokeOutput flags hallucinated source_item_ids", () => {
  const stories = [
    {
      meta_story_id: "abc123",
      title: "T",
      subtitle: "S",
      summary: "Sm",
      source_item_ids: ["known-1", "ghost-id"],
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: [] },
      factual_claims: ["claim 0"],
      claim_evidence_map: { "0": ["known-1"] },
    },
  ];
  const { ok, failures } = validateSmokeOutput(stories, new Set(["known-1"]));
  assert.equal(ok, false);
  assert.ok(
    failures.some((f) => f.includes("ghost-id")),
    `expected failure to name 'ghost-id', got ${JSON.stringify(failures)}`
  );
});

test("M8 shape lock: validateSmokeOutput flags empty arrays and missing meta_story_id", () => {
  const empty = validateSmokeOutput([], new Set(["known-1"]));
  assert.equal(empty.ok, false);
  assert.ok(empty.failures[0].includes("0 meta-stories"));

  const missingId = validateSmokeOutput(
    [
      {
        title: "T",
        subtitle: "S",
        summary: "Sm",
        source_item_ids: ["known-1"],
        tags: { topics: [], keywords: [], geographies: [] },
        factual_claims: ["c"],
        claim_evidence_map: { "0": ["known-1"] },
        // no meta_story_id
      },
    ],
    new Set(["known-1"])
  );
  assert.equal(missingId.ok, false);
  assert.ok(missingId.failures.some((f) => f.includes("meta_story_id")));
});

test("M8 shape lock: validateSmokeOutput flags schema violations (empty title)", () => {
  const stories = [
    {
      meta_story_id: "id-1",
      title: "", // schema requires min(1)
      subtitle: "S",
      summary: "Sm",
      source_item_ids: ["known-1"],
      tags: { topics: [], keywords: [], geographies: [] },
      factual_claims: ["c"],
      claim_evidence_map: { "0": ["known-1"] },
    },
  ];
  const { ok, failures } = validateSmokeOutput(stories, new Set(["known-1"]));
  assert.equal(ok, false);
  assert.ok(failures.some((f) => f.includes("title")));
});

// ─── M8 architecture: pure orchestrator + no-side-effects-on-import lock ────
// Locks the contract that smoke logic is testable without firing CLI side
// effects.  If a future refactor reintroduces top-level `main()` in the
// runner, or removes the direct-execution guard, the import-side test below
// will surface it (the test's own console output stays clean).

test("M8 architecture: runClusterSmoke returns structured result on healthy clusterFn", async () => {
  const fakeStories = [
    {
      meta_story_id: "fake-1",
      title: "Fake title",
      subtitle: "Fake subtitle",
      summary: "Fake summary",
      source_item_ids: ["smoke-src-1", "smoke-src-2"],
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["claim 0"],
      claim_evidence_map: { "0": ["smoke-src-1"] },
    },
  ];
  const calls = [];
  const clusterFn = async (items, settings, model) => {
    calls.push({ itemCount: items.length, model });
    return fakeStories;
  };
  const result = await runClusterSmoke({ clusterFn, model: "fake-model" });
  assert.equal(result.ok, true, `failures: ${result.failures.join("; ")}`);
  assert.equal(result.error, null);
  assert.deepEqual(result.failures, []);
  assert.equal(result.stories.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "fake-model");
  assert.equal(calls[0].itemCount, 3, "runClusterSmoke must pass the canonical 3-item fixture");
});

test("M8 architecture: runClusterSmoke captures clusterFn throws as structured error (no rethrow)", async () => {
  const clusterFn = async () => {
    throw new Error("simulated provider failure");
  };
  const result = await runClusterSmoke({ clusterFn, model: "fake-model" });
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /simulated provider failure/);
  assert.equal(result.stories, null);
  assert.deepEqual(result.failures, []);
});

test("M8 architecture: importing run-cluster-smoke.mjs does not invoke main()", async () => {
  // Capture console.log/error to detect any banner/PASS/FAIL chatter that
  // would indicate main() fired on import.  Also assert that env wasn't
  // mutated by dotenv (the runner now loads .env only inside main()).
  const originalLog = console.log;
  const originalError = console.error;
  const logged = [];
  console.log = (...args) => logged.push({ stream: "log", args });
  console.error = (...args) => logged.push({ stream: "error", args });
  const envBefore = process.env.TEMPO_AI_CLUSTER_MODEL;
  try {
    // Cache-bust so node's ESM loader doesn't return a previously-imported
    // copy whose side effects (if any) already fired during a prior test run.
    await import(`./evals/run-cluster-smoke.mjs?nosideeffects=${Date.now()}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(
    logged,
    [],
    `importing the runner must not log; observed: ${JSON.stringify(logged)}`
  );
  // dotenv would set TEMPO_AI_CLUSTER_MODEL from .env if it ran; the runner
  // defers dotenv.config() into main(), so the env value is whatever the
  // test process started with.
  assert.equal(
    process.env.TEMPO_AI_CLUSTER_MODEL,
    envBefore,
    "importing the runner must not mutate process.env via dotenv"
  );
});

// ─── Clustering prompt (Slice 3: cluster-v2 anti-over-merge guidance) ─────────

test("CLUSTERING_PROMPT_VERSION is cluster-v2", () => {
  assert.equal(CLUSTERING_PROMPT_VERSION, "cluster-v2");
});

test("buildClusteringPrompt: includes anti-over-merge guidance (Slice 3)", () => {
  const items = [
    makeItem({
      sourceId: "co-election",
      geographies: ["Colombia"],
      headline: "Colombia presidential election debate draws record viewers",
      body: ["Candidates clashed over tax reform and security."],
    }),
    makeItem({
      sourceId: "co-mine",
      geographies: ["Colombia"],
      headline: "Armed group attacks Colombia gold mine, killing workers",
      body: ["Authorities blame an illegal armed faction."],
    }),
  ];
  const prompt = buildClusteringPrompt(items, BASE_SETTINGS);

  // Shared geography alone must not justify a merge.
  assert.match(prompt, /Shared geography alone is NOT enough to merge/);
  // Unrelated event types stay separate (the election vs accident vs outbreak case).
  assert.match(prompt, /Do NOT merge unrelated event types/);
  assert.match(prompt, /election.*industrial accident.*disease outbreak/i);
  // Bias toward separate meta-stories for distinct events in the same country.
  assert.match(prompt, /Prefer separate meta-stories when events are distinct/);
});

test("buildClusteringPrompt: retains the JSON contract and grounded-evidence rules", () => {
  const prompt = buildClusteringPrompt([makeItem({ sourceId: "src-1" })], BASE_SETTINGS);

  // JSON-only output contract + shape.
  assert.match(prompt, /Return ONLY valid JSON matching this exact structure/);
  assert.match(prompt, /meta_stories/);
  assert.match(prompt, /source_item_ids/);
  // sourceId constraints.
  assert.match(prompt, /Every sourceId you reference MUST appear verbatim in the article list/);
  assert.match(prompt, /reference at least 1 sourceId/);
  assert.match(prompt, /maximum 5 sourceIds/);
  // Grounded-evidence rules unchanged.
  assert.match(prompt, /factual_claims/);
  assert.match(prompt, /claim_evidence_map/);
  assert.match(prompt, /Every claim MUST be backed by at least one sourceId/);
});
