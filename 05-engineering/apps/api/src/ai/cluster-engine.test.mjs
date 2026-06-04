import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateMetaStoryId,
  verifyGrounding,
  gracefulFallbackClustering,
  extractiveSummary,
  clusterItems,
  resolveClusterTimeoutMs,
  CLUSTER_TIMEOUT_MS_DEFAULT,
  metaStoryOutputSchema,
  parseClusteringResponse,
  safeTrimRepair,
  readClusteringRepairDiagnostics,
  clusterWithAnthropic,
  deriveClusterObs,
  formatClusterObsLine,
  CLUSTER_MAX_TOKENS,
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

// ─── Slice 4: clustering timeout override (interactive fast-path) ────────────

test("resolveClusterTimeoutMs: explicit override wins; else env; else default", () => {
  const saved = process.env.TEMPO_AI_CLUSTER_TIMEOUT_MS;
  try {
    delete process.env.TEMPO_AI_CLUSTER_TIMEOUT_MS;
    // No override, no env → default.
    assert.equal(resolveClusterTimeoutMs(undefined), CLUSTER_TIMEOUT_MS_DEFAULT);
    // A valid override always wins (Slice 4 interactive fast-path passes this).
    assert.equal(resolveClusterTimeoutMs(20000), 20000);
    // Invalid overrides fall through to env/default.
    process.env.TEMPO_AI_CLUSTER_TIMEOUT_MS = "45000";
    assert.equal(resolveClusterTimeoutMs(0), 45000, "0 → ignore override, use env");
    assert.equal(resolveClusterTimeoutMs(-1), 45000, "negative → ignore override, use env");
    assert.equal(resolveClusterTimeoutMs(NaN), 45000, "NaN → ignore override, use env");
    // Override still wins over env when valid.
    assert.equal(resolveClusterTimeoutMs(10000), 10000);
  } finally {
    if (saved !== undefined) process.env.TEMPO_AI_CLUSTER_TIMEOUT_MS = saved;
    else delete process.env.TEMPO_AI_CLUSTER_TIMEOUT_MS;
  }
});

test("clusterItems: accepts a 4th opts arg without breaking the mock path (backward compatible)", async () => {
  const items = [makeItem({ sourceId: "to-1", topic: "Diplomatic relations" })];
  // Passing an explicit timeout override must not disturb the mock provider
  // path (it never makes a timed call) — proves the new arg is additive.
  const stories = await clusterItems(items, BASE_SETTINGS, "mock-anthropic-haiku", { timeoutMs: 20000 });
  assert.ok(stories.length >= 1);
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

test("CLUSTERING_PROMPT_VERSION is cluster-v3", () => {
  assert.equal(CLUSTERING_PROMPT_VERSION, "cluster-v3");
});

// ─── Slice 15: English-output guardrail for non-English sources ───────────────

test("buildClusteringPrompt: requires English output even for non-English sources", () => {
  const prompt = buildClusteringPrompt([makeItem({ sourceId: "src-1" })], BASE_SETTINGS);
  assert.match(prompt, /Write ALL output in English/);
  assert.match(prompt, /title, subtitle, summary, and factual_claims MUST be written in English/);
});

test("buildClusteringPrompt: feeds normalized English evidence for Spanish items (dual-text)", () => {
  // Spanish original headline/body + Slice 14 normalized English fields. The
  // prompt must surface the English normalization, not the raw Spanish.
  const spanishItem = makeItem({
    sourceId: "es-mig-1",
    lang: "es",
    headline: "La migración crece en la frontera norte",
    body: ["Las autoridades reportan un aumento sostenido de la migración."],
    normalizedHeadline: "Migration rises at the northern border",
    normalizedBody: ["Authorities report a sustained increase in migration."],
  });
  const prompt = buildClusteringPrompt([spanishItem], BASE_SETTINGS);
  // Normalized English evidence is what the model sees.
  assert.match(prompt, /Migration rises at the northern border/);
  assert.match(prompt, /Authorities report a sustained increase in migration/);
  // The raw Spanish headline/body must NOT be the evidence surface.
  assert.doesNotMatch(prompt, /La migración crece en la frontera norte/);
});

test("buildClusteringPrompt: English items still use their original text (no-op fallback)", () => {
  const prompt = buildClusteringPrompt(
    [makeItem({ sourceId: "en-1", headline: "Reuters reports new sanctions", body: ["Details follow."] })],
    BASE_SETTINGS
  );
  assert.match(prompt, /Reuters reports new sanctions/);
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

// ─── C2: clustering JSON resilience (safe-trim repair) ───────────────────────

const VALID_CLUSTER_OBJECT = {
  meta_stories: [
    {
      title: "Diplomatic Relations Developments",
      subtitle: "Recent diplomatic updates.",
      source_item_ids: ["src-1"],
      summary: "Diplomatic relations updates tracked.",
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      factual_claims: ["Reuters reports a diplomatic meeting."],
      claim_evidence_map: { "0": ["src-1"] },
    },
  ],
};
const VALID_CLUSTER_JSON = JSON.stringify(VALID_CLUSTER_OBJECT);

test("C2 parse: plain valid JSON parses with NO repair attempted", () => {
  const { stories, repair } = parseClusteringResponse(VALID_CLUSTER_JSON);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].title, "Diplomatic Relations Developments");
  assert.ok(/^[0-9a-f]{16}$/.test(stories[0].meta_story_id), "meta_story_id assigned");
  assert.equal(repair.attempted, false);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.failureReason, null);
});

test("C2 parse: markdown-fenced JSON succeeds via the single safe-trim repair", () => {
  const fenced = "```json\n" + VALID_CLUSTER_JSON + "\n```";
  const { stories, repair } = parseClusteringResponse(fenced);
  assert.equal(stories.length, 1);
  assert.equal(repair.attempted, true, "strict parse fails on the backticks → repair runs");
  assert.equal(repair.succeeded, true);
  assert.equal(repair.failureReason, null);
});

test("C2 parse: extra prefix/suffix prose succeeds via safe outer-JSON extraction", () => {
  const wrapped =
    "Here is the clustering output you asked for:\n\n" +
    VALID_CLUSTER_JSON +
    "\n\nLet me know if you need anything else.";
  const { stories, repair } = parseClusteringResponse(wrapped);
  assert.equal(stories.length, 1);
  assert.equal(repair.attempted, true);
  assert.equal(repair.succeeded, true);
  assert.equal(repair.failureReason, null);
});

test("C2 parse: truly malformed JSON still throws after one repair attempt (fail-closed)", () => {
  // Outer region isolates to `{ "meta_stories": [ {bad json} ] }` — bounded but
  // still invalid JSON because safe-trim never rewrites content (no quote/comma
  // surgery), so JSON.parse on the isolated region throws a SyntaxError.
  const broken = "```json\n{ \"meta_stories\": [ {bad json} ] }\n```";
  let thrown = null;
  assert.throws(
    () => parseClusteringResponse(broken),
    (err) => {
      thrown = err;
      return /parse failed after safe-trim repair/i.test(err.message);
    }
  );
  // Diagnostics ride along on the thrown error for the pipeline to surface.
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.attempted, true);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.failureReason, "json_parse_error");
});

test("C2 parse: schema-valid JSON shape but contract violation fails with schema reason", () => {
  // Well-formed JSON, but `meta_stories` is missing → zod schema rejects. Repair
  // can't help (it never rewrites content), so it fails with a schema reason.
  const wrongShape = "```json\n" + JSON.stringify({ stories: [] }) + "\n```";
  let thrown = null;
  assert.throws(
    () => parseClusteringResponse(wrongShape),
    (err) => {
      thrown = err;
      return true;
    }
  );
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.attempted, true);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.failureReason, "schema_validation_error");
});

test("C2 parse: response with no JSON region fails with no_json_region", () => {
  let thrown = null;
  assert.throws(
    () => parseClusteringResponse("I could not produce any clusters this run."),
    (err) => {
      thrown = err;
      return /no JSON region/i.test(err.message);
    }
  );
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.attempted, true);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.failureReason, "no_json_region");
});

test("C2 safeTrimRepair: structural-trim only — strips fences, isolates outer region, no content rewrite", () => {
  // Strips fences + isolates the outermost object region.
  assert.equal(
    safeTrimRepair("```json\n{\"a\":1}\n```"),
    '{"a":1}'
  );
  // Prefix/suffix prose trimmed down to the bounded region.
  assert.equal(
    safeTrimRepair("prefix {\"a\":1} suffix"),
    '{"a":1}'
  );
  // Top-level array region isolated symmetrically.
  assert.equal(safeTrimRepair("```\n[1, 2, 3]\n```"), "[1, 2, 3]");
  // No JSON region → null (repair cannot proceed).
  assert.equal(safeTrimRepair("no json at all"), null);
  assert.equal(safeTrimRepair("   "), null);
  // Content inside the region is preserved verbatim — trailing comma is NOT
  // rewritten (proves we do not do comma/quote surgery).
  assert.equal(safeTrimRepair("{\"a\":1,}"), '{"a":1,}');
});

test("C2 readClusteringRepairDiagnostics: defaults to no-repair for plain arrays/objects", () => {
  // Slice 3 extends the normalized shape with rawFailureClass / schemaErrorBucket
  // / coercion — all null on the no-repair default.
  const expected = {
    attempted: false,
    succeeded: false,
    failureReason: null,
    rawFailureClass: null,
    schemaErrorBucket: null,
    coercion: null,
  };
  assert.deepEqual(readClusteringRepairDiagnostics([]), expected);
  assert.deepEqual(readClusteringRepairDiagnostics(null), expected);
});

test("C2 clusterItems (mock provider): attaches no-repair diagnostics", async () => {
  const items = [makeItem({ sourceId: "src-1" })];
  const stories = await clusterItems(items, BASE_SETTINGS, "mock-anthropic-haiku");
  // Mock path never parses LLM text, so repair diagnostics read as defaults.
  const repair = readClusteringRepairDiagnostics(stories);
  assert.equal(repair.attempted, false);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.failureReason, null);
});

// ─── Slice 3: clustering structured-output hardening ─────────────────────────
//
// Builds a contract-valid meta-story array so each case isolates exactly the
// malformation under test.

function validMetaStory(overrides = {}) {
  return {
    title: "Diplomatic Relations Developments",
    subtitle: "Recent diplomatic updates.",
    source_item_ids: ["src-1"],
    summary: "Diplomatic relations updates tracked.",
    tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    factual_claims: ["Reuters reports a diplomatic meeting."],
    claim_evidence_map: { "0": ["src-1"] },
    ...overrides,
  };
}

test("Slice 3: valid structured output passes with no repair and no diagnostics noise", () => {
  const { stories, repair } = parseClusteringResponse(VALID_CLUSTER_JSON);
  assert.equal(stories.length, 1);
  // Every Slice 3 field is inert on the clean happy path.
  assert.equal(repair.attempted, false);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.failureReason, null);
  assert.equal(repair.rawFailureClass, null);
  assert.equal(repair.schemaErrorBucket, null);
  assert.equal(repair.coercion, null);
});

test("Slice 3 repairable: bare top-level array is wrapped within strict bounds (coercion=array_wrap)", () => {
  // The model emitted the meta-stories array directly, without the
  // `{ meta_stories: [...] }` envelope.  Strict parse fails (schema), the
  // single repair pass wraps the array, and validation then passes — no
  // fabricated content, every element still validated.
  const bareArray = JSON.stringify([validMetaStory()]);
  const { stories, repair } = parseClusteringResponse(bareArray);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].title, "Diplomatic Relations Developments");
  assert.ok(/^[0-9a-f]{16}$/.test(stories[0].meta_story_id), "meta_story_id assigned");
  assert.equal(repair.attempted, true);
  assert.equal(repair.succeeded, true);
  assert.equal(repair.coercion, "array_wrap", "bare array recovered via array_wrap coercion");
  // The raw output was schema-invalid (a bare array, not the envelope object).
  assert.equal(repair.rawFailureClass, "schema_validation_error");
  assert.equal(repair.failureReason, null, "no terminal failure — repair succeeded");
});

test("Slice 3 repairable: fenced bare array recovers via trim + array_wrap, raw class captured", () => {
  const fencedBareArray = "```json\n" + JSON.stringify([validMetaStory()]) + "\n```";
  const { stories, repair } = parseClusteringResponse(fencedBareArray);
  assert.equal(stories.length, 1);
  assert.equal(repair.succeeded, true);
  assert.equal(repair.coercion, "array_wrap");
  // Fences make the raw text a JSON syntax error before the array is reached.
  assert.equal(repair.rawFailureClass, "json_parse_error");
});

test("Slice 3 raw-class capture: fenced valid object records rawFailureClass even though repair succeeds", () => {
  const fenced = "```json\n" + VALID_CLUSTER_JSON + "\n```";
  const { stories, repair } = parseClusteringResponse(fenced);
  assert.equal(stories.length, 1);
  assert.equal(repair.succeeded, true);
  assert.equal(repair.coercion, null, "object envelope needs no structural coercion");
  assert.equal(repair.rawFailureClass, "json_parse_error", "raw fences are a JSON syntax failure");
});

test("Slice 3 empty: whitespace-only response classifies as empty_response and fails closed", () => {
  let thrown = null;
  assert.throws(
    () => parseClusteringResponse("   \n  "),
    (err) => { thrown = err; return /empty response/i.test(err.message); }
  );
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.attempted, true);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.rawFailureClass, "empty_response");
  assert.equal(repair.failureReason, "no_json_region");
});

test("Slice 3 schema bucket: missing meta_stories → missing_meta_stories", () => {
  const wrongShape = JSON.stringify({ stories: [] });
  let thrown = null;
  assert.throws(() => parseClusteringResponse(wrongShape), (err) => { thrown = err; return true; });
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.failureReason, "schema_validation_error");
  assert.equal(repair.rawFailureClass, "schema_validation_error");
  assert.equal(repair.schemaErrorBucket, "missing_meta_stories");
});

test("Slice 3 schema bucket: more than 5 meta-stories → too_many_meta_stories", () => {
  const tooMany = JSON.stringify({ meta_stories: Array.from({ length: 6 }, () => validMetaStory()) });
  let thrown = null;
  assert.throws(() => parseClusteringResponse(tooMany), (err) => { thrown = err; return true; });
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.schemaErrorBucket, "too_many_meta_stories");
  assert.equal(repair.succeeded, false);
});

test("Slice 3 schema bucket: empty source_item_ids → empty_source_item_ids", () => {
  const emptyIds = JSON.stringify({ meta_stories: [validMetaStory({ source_item_ids: [] })] });
  let thrown = null;
  assert.throws(() => parseClusteringResponse(emptyIds), (err) => { thrown = err; return true; });
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.schemaErrorBucket, "empty_source_item_ids");
});

test("Slice 3 schema bucket: too many source_item_ids → too_many_source_item_ids", () => {
  const tooManyIds = JSON.stringify({
    meta_stories: [validMetaStory({ source_item_ids: ["a", "b", "c", "d", "e", "f"] })],
  });
  let thrown = null;
  assert.throws(() => parseClusteringResponse(tooManyIds), (err) => { thrown = err; return true; });
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.schemaErrorBucket, "too_many_source_item_ids");
});

test("Slice 3 continuity contract: malformed output throws a non-timeout error carrying diagnostics", () => {
  // The pipeline classifies any clustering throw whose message does NOT match
  // its timeout regex as `error` (Slice 1 continuity gate needs a non-null
  // clusteringFailureReason).  Assert the parser's terminal error message
  // never trips the timeout heuristic and always rides repair diagnostics.
  const broken = "```json\n{ \"meta_stories\": [ {bad json} ] }\n```";
  let thrown = null;
  assert.throws(() => parseClusteringResponse(broken), (err) => { thrown = err; return true; });
  assert.doesNotMatch(thrown.message, /timed out|timeout|abort/i, "must not look like a timeout");
  const repair = readClusteringRepairDiagnostics(thrown);
  assert.equal(repair.attempted, true);
  assert.equal(repair.succeeded, false);
  assert.equal(repair.failureReason, "json_parse_error");
});

// ─── Step 2: structured-path observability ([cluster-engine.obs]) ────────────
//
// Deterministic, offline coverage of the three execution paths via an injected
// fake Anthropic client (no network), plus pure-helper coverage. Each path must
// emit exactly one `[cluster-engine.obs]` line with the documented fields.

// Reuses the schema-valid `VALID_CLUSTER_JSON` envelope declared earlier in
// this file (passes clusteringOutputSchema).

// Fake Anthropic client: messages.create resolves to the canned message.
function fakeAnthropic(message) {
  return { messages: { create: async () => message } };
}

function anthropicTextMessage(text, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

// Run fn with console.log/error captured; returns { result, error, lines }.
async function withConsoleCapture(fn) {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const lines = [];
  console.log = (...a) => lines.push({ stream: "log", text: a.join(" ") });
  console.error = (...a) => lines.push({ stream: "error", text: a.join(" ") });
  console.warn = () => {}; // silence repair-path warnings; not under test here
  let result, error;
  try {
    result = await fn();
  } catch (err) {
    error = err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  return { result, error, lines };
}

function obsLines(lines) {
  return lines.filter((l) => l.text.startsWith("[cluster-engine.obs]"));
}

// — pure helpers —

test("deriveClusterObs: structured success (no repair attempted)", () => {
  const o = deriveClusterObs({ attempted: false, succeeded: false });
  assert.deepEqual(o, { mode: "structured", result: "ok", errorClass: null });
});

test("deriveClusterObs: legacy fallback success carries fallbackTo + raw class", () => {
  const o = deriveClusterObs({
    attempted: true,
    succeeded: true,
    rawFailureClass: "json_parse_error",
  });
  assert.deepEqual(o, {
    mode: "legacy",
    result: "fallback",
    errorClass: "json_parse_error",
    fallbackTo: "legacy",
  });
});

test("deriveClusterObs: terminal failure → result=fail, no fallbackTo", () => {
  const o = deriveClusterObs({
    attempted: true,
    succeeded: false,
    failureReason: "no_json_region",
    rawFailureClass: "json_parse_error",
  });
  assert.equal(o.mode, "legacy");
  assert.equal(o.result, "fail");
  assert.equal(o.errorClass, "no_json_region");
  assert.equal(o.fallbackTo, undefined);
});

test("formatClusterObsLine: stable key order; renders null; omits absent fallbackTo", () => {
  const line = formatClusterObsLine({
    mode: "structured",
    result: "ok",
    model: "claude-haiku-4-5",
    maxTokens: 2048,
    stopReason: null,
    errorClass: null,
  });
  assert.equal(
    line,
    "[cluster-engine.obs] mode=structured result=ok model=claude-haiku-4-5 maxTokens=2048 stopReason=null errorClass=null"
  );
});

test("formatClusterObsLine: includes fallbackTo when set", () => {
  const line = formatClusterObsLine({
    mode: "legacy",
    result: "fallback",
    model: "m",
    maxTokens: 2048,
    stopReason: "end_turn",
    errorClass: "json_parse_error",
    fallbackTo: "legacy",
  });
  assert.match(line, /fallbackTo=legacy$/);
});

// — integration via injected client: the three paths —

test("obs path 1: structured success emits one ok line on stdout", async () => {
  const { result, error, lines } = await withConsoleCapture(() =>
    clusterWithAnthropic({
      apiKey: "test",
      model: "claude-haiku-4-5",
      items: [makeItem()],
      settings: BASE_SETTINGS,
      client: fakeAnthropic(anthropicTextMessage(VALID_CLUSTER_JSON)),
    })
  );
  assert.equal(error, undefined, "structured success must not throw");
  assert.ok(Array.isArray(result) && result.length === 1, "returns parsed stories");
  const obs = obsLines(lines);
  assert.equal(obs.length, 1, "exactly one obs line");
  assert.equal(obs[0].stream, "log", "success goes to stdout");
  assert.match(obs[0].text, /mode=structured/);
  assert.match(obs[0].text, /result=ok/);
  assert.match(obs[0].text, /model=claude-haiku-4-5/);
  assert.match(obs[0].text, new RegExp(`maxTokens=${CLUSTER_MAX_TOKENS}`));
  assert.match(obs[0].text, /stopReason=end_turn/);
  assert.match(obs[0].text, /errorClass=null/);
  assert.doesNotMatch(obs[0].text, /fallbackTo/, "no fallbackTo on the structured path");
});

test("obs path 2: structured fails → legacy repair succeeds → fallback line", async () => {
  // Markdown-fenced JSON fails the strict parse (SyntaxError) then recovers via
  // the safe-trim repair pass → mode=legacy result=fallback fallbackTo=legacy.
  const fenced = "```json\n" + VALID_CLUSTER_JSON + "\n```";
  const { result, error, lines } = await withConsoleCapture(() =>
    clusterWithAnthropic({
      apiKey: "test",
      model: "claude-haiku-4-5",
      items: [makeItem()],
      settings: BASE_SETTINGS,
      client: fakeAnthropic(anthropicTextMessage(fenced)),
    })
  );
  assert.equal(error, undefined, "recovered path must not throw");
  assert.ok(Array.isArray(result) && result.length === 1, "returns recovered stories");
  const obs = obsLines(lines);
  assert.equal(obs.length, 1, "exactly one obs line");
  assert.equal(obs[0].stream, "log", "recovery goes to stdout");
  assert.match(obs[0].text, /mode=legacy/);
  assert.match(obs[0].text, /result=fallback/);
  assert.match(obs[0].text, /errorClass=json_parse_error/);
  assert.match(obs[0].text, /fallbackTo=legacy/);
});

test("obs path 3: both paths fail → terminal fail line on stderr; rethrows", async () => {
  // Non-JSON text: strict parse fails AND safe-trim finds no JSON region.
  const { result, error, lines } = await withConsoleCapture(() =>
    clusterWithAnthropic({
      apiKey: "test",
      model: "claude-haiku-4-5",
      items: [makeItem()],
      settings: BASE_SETTINGS,
      client: fakeAnthropic(anthropicTextMessage("totally not json at all")),
    })
  );
  assert.ok(error instanceof Error, "terminal failure must rethrow");
  assert.equal(result, undefined);
  const obs = obsLines(lines);
  assert.equal(obs.length, 1, "exactly one obs line");
  assert.equal(obs[0].stream, "error", "failure goes to stderr");
  assert.match(obs[0].text, /result=fail/);
  assert.match(obs[0].text, /errorClass=no_json_region/);
  assert.doesNotMatch(obs[0].text, /fallbackTo/, "no fallbackTo on terminal failure");
});

test("obs: empty model response → structured fail (errorClass=empty_response)", async () => {
  const { error, lines } = await withConsoleCapture(() =>
    clusterWithAnthropic({
      apiKey: "test",
      model: "claude-haiku-4-5",
      items: [makeItem()],
      settings: BASE_SETTINGS,
      client: fakeAnthropic(anthropicTextMessage("   ")),
    })
  );
  assert.ok(error instanceof Error, "empty response must throw");
  const obs = obsLines(lines);
  assert.equal(obs.length, 1, "exactly one obs line");
  assert.equal(obs[0].stream, "error");
  assert.match(obs[0].text, /mode=structured/);
  assert.match(obs[0].text, /result=fail/);
  assert.match(obs[0].text, /errorClass=empty_response/);
});

test("obs: stopReason renders null when the provider omits it", async () => {
  const { lines } = await withConsoleCapture(() =>
    clusterWithAnthropic({
      apiKey: "test",
      model: "m",
      items: [makeItem()],
      settings: BASE_SETTINGS,
      client: fakeAnthropic(anthropicTextMessage(VALID_CLUSTER_JSON, null)),
    })
  );
  const obs = obsLines(lines);
  assert.equal(obs.length, 1);
  assert.match(obs[0].text, /stopReason=null/);
});
