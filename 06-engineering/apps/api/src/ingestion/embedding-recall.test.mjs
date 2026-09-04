import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECALL_MODE,
  resolveRecallConfig,
  buildProfileText,
  buildItemText,
  cosineSimilarity,
  runEmbeddingRecall,
  summarizeProfileContent,
} from "./embedding-recall.mjs";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    outlet: "Reuters",
    headline: "Test Headline",
    body: ["Test body."],
    minutesAgo: 30,
    ...overrides,
  };
}

const BASE_SETTINGS = {
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["OFAC", "sanctions"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["Reuters"],
  socialSources: [],
};

const HYBRID_CONFIG = Object.freeze({
  mode: RECALL_MODE.HYBRID_STRICT,
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

// Deterministic stub embedder.  The first text gets a profile-flavored vector;
// each item text gets a vector based on whether it contains a "signal" token.
// Cosine ranks the matching items above non-matching items reliably.
function makeStubEmbedder({ signalTokens = ["us", "colombia", "ofac"], throwOnCall = null } = {}) {
  return async (texts) => {
    if (throwOnCall) throw throwOnCall;
    return texts.map((t) => {
      const lower = String(t).toLowerCase();
      const matches = signalTokens.filter((tok) => lower.includes(tok)).length;
      // Two-dim vector: [signal_strength, length]
      return [matches, Math.min(lower.length, 1000) / 1000];
    });
  };
}

// ─── resolveRecallConfig ──────────────────────────────────────────────────────

test("resolveRecallConfig: defaults to hybrid_strict with documented K/M/model", () => {
  const prevMode = process.env.TEMPO_RECALL_MODE;
  const prevK = process.env.TEMPO_EMBED_TOP_K;
  const prevM = process.env.TEMPO_EMBED_MAX_ITEMS;
  const prevModel = process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
  delete process.env.TEMPO_RECALL_MODE;
  delete process.env.TEMPO_EMBED_TOP_K;
  delete process.env.TEMPO_EMBED_MAX_ITEMS;
  delete process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
  try {
    const cfg = resolveRecallConfig();
    assert.equal(cfg.mode, "hybrid_strict");
    assert.equal(cfg.embedTopK, 80);
    assert.equal(cfg.embedMaxItems, 250);
    assert.equal(cfg.embeddingModel, "text-embedding-3-small");
  } finally {
    if (prevMode === undefined) delete process.env.TEMPO_RECALL_MODE; else process.env.TEMPO_RECALL_MODE = prevMode;
    if (prevK === undefined) delete process.env.TEMPO_EMBED_TOP_K; else process.env.TEMPO_EMBED_TOP_K = prevK;
    if (prevM === undefined) delete process.env.TEMPO_EMBED_MAX_ITEMS; else process.env.TEMPO_EMBED_MAX_ITEMS = prevM;
    if (prevModel === undefined) delete process.env.TEMPO_OPENAI_EMBEDDING_MODEL; else process.env.TEMPO_OPENAI_EMBEDDING_MODEL = prevModel;
  }
});

test("resolveRecallConfig: explicit keyword mode is honored", () => {
  const prev = process.env.TEMPO_RECALL_MODE;
  process.env.TEMPO_RECALL_MODE = "keyword";
  try {
    assert.equal(resolveRecallConfig().mode, "keyword");
  } finally {
    if (prev === undefined) delete process.env.TEMPO_RECALL_MODE; else process.env.TEMPO_RECALL_MODE = prev;
  }
});

test("resolveRecallConfig: unknown mode falls through to hybrid_strict (safer default)", () => {
  const prev = process.env.TEMPO_RECALL_MODE;
  process.env.TEMPO_RECALL_MODE = "experimental";
  try {
    assert.equal(resolveRecallConfig().mode, "hybrid_strict");
  } finally {
    if (prev === undefined) delete process.env.TEMPO_RECALL_MODE; else process.env.TEMPO_RECALL_MODE = prev;
  }
});

// ─── buildProfileText / buildItemText ─────────────────────────────────────────

test("buildProfileText: composes topics, keywords, geographies, sources, narrative in order", () => {
  const text = buildProfileText({
    ...BASE_SETTINGS,
    onboardingNarrative: "I cover bilateral US-Colombia comms.",
  });
  assert.match(text, /Topics: Diplomatic relations, Migration policy/);
  assert.match(text, /Keywords: OFAC, sanctions/);
  assert.match(text, /Geographies: US, Colombia/);
  assert.match(text, /Sources: Reuters/);
  assert.match(text, /Beat narrative: I cover bilateral US-Colombia comms\./);
});

test("buildProfileText: returns empty string for empty settings (fallback handled by recall stage)", () => {
  assert.equal(buildProfileText({}), "");
  assert.equal(buildProfileText(null), "");
});

test("buildItemText: uses real ingested fields only (outlet, headline, body)", () => {
  const t = buildItemText({
    outlet: "Reuters",
    headline: "U.S. weighs new tariffs",
    body: ["Treasury issued draft language today."],
  });
  assert.match(t, /Reuters/);
  assert.match(t, /U\.S\. weighs new tariffs/);
  assert.match(t, /Treasury issued draft language today\./);
});

// ─── cosineSimilarity ────────────────────────────────────────────────────────

test("cosineSimilarity: identical vectors → 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosineSimilarity: orthogonal vectors → 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: zero vector returns 0 (no NaN leak)", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

// ─── runEmbeddingRecall ──────────────────────────────────────────────────────

test("runEmbeddingRecall: keyword mode bypasses embedFn entirely", async () => {
  let embedCalls = 0;
  const embedFn = async () => { embedCalls++; return []; };
  const candidate = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  const keyword = [candidate[0]];
  const result = await runEmbeddingRecall({
    candidateItems: candidate,
    settings: BASE_SETTINGS,
    keywordRecallItems: keyword,
    embedFn,
    config: { ...HYBRID_CONFIG, mode: RECALL_MODE.KEYWORD },
  });
  assert.equal(embedCalls, 0, "embedFn must NOT be invoked under keyword mode");
  assert.deepEqual(result.items.map((i) => i.sourceId), ["a"]);
  assert.equal(result.diagnostics.mode, "keyword");
});

test("runEmbeddingRecall: hybrid_strict widens recall via semantic match (item without keyword still passes)", async () => {
  // Keyword recall picks up only "kw-hit". Embedding picks up "no-kw-but-semantic"
  // because its text contains a configured geo signal even though no exact keyword.
  const items = [
    makeItem({ sourceId: "kw-hit", headline: "OFAC ruling on sanctions" }),
    makeItem({ sourceId: "no-kw-but-semantic", headline: "U.S. and Colombia coordinate response" }),
    makeItem({ sourceId: "off-topic", headline: "Local sports recap" }),
  ];
  const keywordRecall = [items[0]];

  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: keywordRecall,
    embedFn: makeStubEmbedder(),
    config: { ...HYBRID_CONFIG, embedTopK: 2 },
  });

  const ids = result.items.map((i) => i.sourceId);
  assert.ok(ids.includes("kw-hit"), "keyword recall items preserved");
  assert.ok(ids.includes("no-kw-but-semantic"), "semantic-only candidate widened in via embedding");
  assert.equal(result.diagnostics.mode, "hybrid_strict");
  assert.equal(result.diagnostics.embeddedCount, 3);
  assert.equal(result.diagnostics.similarityKept, 2);
  assert.equal(result.diagnostics.degraded, false);
  assert.equal(result.diagnostics.degraded_reason, null);
});

// ─── Similarity floor (Slice 1) ───────────────────────────────────────────────

// Deterministic embedder with explicit, controllable cosine scores: profile
// vector is [1, 0]; each item's vector is chosen by a marker in its text so we
// can assert exactly which semantic-only candidates clear the floor.
//   strongmatch → [1, 0]   → cosine 1.00 (passes any floor < 1)
//   weakmatch   → [0.1, 1] → cosine ≈ 0.0995 (below any tested floor)
//   (other)     → [0, 1]   → cosine 0.00
function makeFloorEmbedder() {
  return async (texts) =>
    texts.map((t, idx) => {
      if (idx === 0) return [1, 0]; // profile vector
      const lower = String(t).toLowerCase();
      if (lower.includes("strongmatch")) return [1, 0];
      if (lower.includes("weakmatch")) return [0.1, 1];
      return [0, 1];
    });
}

test("runEmbeddingRecall: similarity floor excludes weak semantic-only candidates, counts them", async () => {
  const items = [
    makeItem({ sourceId: "kw-hit", headline: "OFAC sanctions ruling" }),
    makeItem({ sourceId: "strong", headline: "strongmatch semantic neighbor" }),
    makeItem({ sourceId: "weak", headline: "weakmatch barely related" }),
  ];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: [items[0]],
    embedFn: makeFloorEmbedder(),
    config: { ...HYBRID_CONFIG, embedTopK: 5, minSimilarity: 0.4 },
  });
  const ids = result.items.map((i) => i.sourceId).sort();
  assert.deepEqual(ids, ["kw-hit", "strong"], "weak semantic-only candidate excluded by floor");
  assert.equal(result.diagnostics.minSimilarityThreshold, 0.4);
  assert.equal(result.diagnostics.similarityRejected, 1, "the one below-floor semantic-only item is counted");
});

test("runEmbeddingRecall: keyword hit below the similarity floor still passes (keyword path unchanged)", async () => {
  // `kw-low` is a keyword recall hit but its embedding cosine is 0 (below the
  // floor).  It must still appear — keyword/topic hits always pass regardless
  // of semantic score — and must NOT be counted as similarityRejected.
  const items = [
    makeItem({ sourceId: "kw-low", headline: "plain keyword headline" }),
    makeItem({ sourceId: "weak", headline: "weakmatch off-beat" }),
  ];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: [items[0]],
    embedFn: makeFloorEmbedder(),
    config: { ...HYBRID_CONFIG, embedTopK: 5, minSimilarity: 0.4 },
  });
  const ids = result.items.map((i) => i.sourceId).sort();
  assert.deepEqual(ids, ["kw-low"], "keyword hit survives despite low cosine; weak semantic-only dropped");
  assert.equal(result.diagnostics.similarityRejected, 1, "only the semantic-only weak item is rejected");
});

test("runEmbeddingRecall: minSimilarity=0 admits all top-K (floor disabled)", async () => {
  const items = [
    makeItem({ sourceId: "kw-hit", headline: "OFAC sanctions ruling" }),
    makeItem({ sourceId: "weak", headline: "weakmatch barely related" }),
  ];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: [items[0]],
    embedFn: makeFloorEmbedder(),
    config: { ...HYBRID_CONFIG, embedTopK: 5, minSimilarity: 0 },
  });
  const ids = result.items.map((i) => i.sourceId).sort();
  assert.deepEqual(ids, ["kw-hit", "weak"], "floor of 0 lets the weak semantic-only item through");
  assert.equal(result.diagnostics.similarityRejected, 0);
});

test("resolveRecallConfig: minSimilarity defaults to 0.35 and honors env override / clamps invalid", () => {
  const prev = process.env.TEMPO_EMBED_MIN_SIMILARITY;
  try {
    delete process.env.TEMPO_EMBED_MIN_SIMILARITY;
    assert.equal(resolveRecallConfig().minSimilarity, 0.35, "default floor is 0.35");
    process.env.TEMPO_EMBED_MIN_SIMILARITY = "0.6";
    assert.equal(resolveRecallConfig().minSimilarity, 0.6, "env override honored");
    process.env.TEMPO_EMBED_MIN_SIMILARITY = "1.5"; // out of [0,1] → fallback
    assert.equal(resolveRecallConfig().minSimilarity, 0.35, "out-of-range falls back to default");
    process.env.TEMPO_EMBED_MIN_SIMILARITY = "0"; // valid: disables floor
    assert.equal(resolveRecallConfig().minSimilarity, 0, "explicit 0 is honored");
  } finally {
    if (prev === undefined) delete process.env.TEMPO_EMBED_MIN_SIMILARITY;
    else process.env.TEMPO_EMBED_MIN_SIMILARITY = prev;
  }
});

test("runEmbeddingRecall: union dedups when keyword item is also a top-K semantic match", async () => {
  const item = makeItem({ sourceId: "shared", headline: "U.S. OFAC update" });
  const result = await runEmbeddingRecall({
    candidateItems: [item],
    settings: BASE_SETTINGS,
    keywordRecallItems: [item],
    embedFn: makeStubEmbedder(),
    config: HYBRID_CONFIG,
  });
  const ids = result.items.map((i) => i.sourceId);
  assert.deepEqual(ids, ["shared"], "shared sourceId must appear exactly once after union");
});

test("runEmbeddingRecall: embedFn throws + keyword hits present → lexical fallback (degraded, not strict-empty)", async () => {
  // Updated policy: when lexical recall has items, an embedding failure
  // surfaces them (with `keywordFallbackAfterEmbeddingFailure: true`) rather
  // than zeroing the run.  Trust protections still hold — every returned
  // item already passed source/topic/keyword gates; embeddings only widen.
  const items = [makeItem({ sourceId: "a", headline: "OFAC update" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: items,
    embedFn: makeStubEmbedder({ throwOnCall: new Error("provider 500") }),
    config: HYBRID_CONFIG,
  });
  assert.deepEqual(result.items.map((i) => i.sourceId), ["a"]);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_error_fail_closed");
  assert.equal(result.diagnostics.keywordFallbackAfterEmbeddingFailure, true);
});

test("runEmbeddingRecall: embedFn throws + keyword EMPTY → strict-empty (no fallback target)", async () => {
  // When lexical recall is empty there's nothing to fall back to — keep the
  // run honest with strict-empty rather than synthesizing items.
  const result = await runEmbeddingRecall({
    candidateItems: [makeItem()],
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn: makeStubEmbedder({ throwOnCall: new Error("provider 500") }),
    config: HYBRID_CONFIG,
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_error_fail_closed");
  assert.equal(result.diagnostics.keywordFallbackAfterEmbeddingFailure, undefined);
  assert.equal(result.diagnostics.unionCount, 0);
  assert.equal(result.diagnostics.finalRelevant, 0);
});

test("runEmbeddingRecall: surfaces 'timeout' reason for AbortError-style errors", async () => {
  const result = await runEmbeddingRecall({
    candidateItems: [makeItem()],
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn: makeStubEmbedder({ throwOnCall: new Error("request timed out after 8000ms") }),
    config: HYBRID_CONFIG,
  });
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_timeout_fail_closed");
});

test("runEmbeddingRecall: wrong-shaped embed response → strict-empty when keyword recall is empty", async () => {
  const result = await runEmbeddingRecall({
    candidateItems: [makeItem(), makeItem({ sourceId: "b" })],
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn: async () => [[1, 2]], // 1 vector for 3 inputs (profile + 2 items)
    config: HYBRID_CONFIG,
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_invalid_response_fail_closed");
});

test("runEmbeddingRecall: wrong-shaped embed response + keyword hits → lexical fallback", async () => {
  const items = [makeItem({ sourceId: "a", headline: "OFAC update" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: items,
    embedFn: async () => [[1, 2]], // wrong shape
    config: HYBRID_CONFIG,
  });
  assert.deepEqual(result.items.map((i) => i.sourceId), ["a"]);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_invalid_response_fail_closed");
  assert.equal(result.diagnostics.keywordFallbackAfterEmbeddingFailure, true);
});

test("runEmbeddingRecall: missing embedFn + keyword hits → lexical fallback (degraded)", async () => {
  // Updated policy: when lexical recall has items, missing embedFn surfaces
  // them with diagnostics flag.  Strict-empty is reserved for the cases
  // where lexical also has nothing to offer.
  const items = [makeItem({ sourceId: "a" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: items,
    embedFn: null,
    config: HYBRID_CONFIG,
  });
  assert.deepEqual(result.items.map((i) => i.sourceId), ["a"]);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_unavailable_fail_closed");
  assert.equal(result.diagnostics.keywordFallbackAfterEmbeddingFailure, true);
});

test("runEmbeddingRecall: missing embedFn + keyword EMPTY → strict-empty", async () => {
  const result = await runEmbeddingRecall({
    candidateItems: [makeItem()],
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn: null,
    config: HYBRID_CONFIG,
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_unavailable_fail_closed");
  assert.equal(result.diagnostics.keywordFallbackAfterEmbeddingFailure, undefined);
});

test("runEmbeddingRecall: empty candidate pool propagates empty (no embedFn invocation)", async () => {
  let calls = 0;
  const embedFn = async () => { calls++; return []; };
  const result = await runEmbeddingRecall({
    candidateItems: [],
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn,
    config: HYBRID_CONFIG,
  });
  assert.deepEqual(result.items, []);
  assert.equal(calls, 0);
  assert.equal(result.diagnostics.embeddedCount, 0);
});

// E3b (M5): an empty profile is no longer a fail-closed event.  Without a
// profile vector we can't run semantic widen, but the lexical hits already
// passed real topic/keyword/geo gates — passing them through is the legacy
// product on a profile-less run, not speculation.  The diagnostic
// `empty_profile_text_lexical_only` keeps the cliff visible without
// conflating it with embedding provider failure (which still sets
// `keywordFallbackAfterEmbeddingFailure`).

test("runEmbeddingRecall: empty profile text → lexical-only pass-through (E3b)", async () => {
  let calls = 0;
  const embedFn = async () => { calls++; return []; };
  const items = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: {}, // no topics/keywords/geos/sources/narrative
    keywordRecallItems: items,
    embedFn,
    config: HYBRID_CONFIG,
  });
  assert.equal(calls, 0, "embedFn must not be invoked when profile text is empty");
  // Lexical hits pass through unchanged (no semantic widen).
  assert.deepEqual(result.items.map((i) => i.sourceId), ["a", "b"]);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "empty_profile_text_lexical_only");
  assert.equal(result.diagnostics.embeddedCount, 0);
  assert.equal(result.diagnostics.similarityKept, 0);
  assert.equal(result.diagnostics.keywordRecallCount, 2);
  assert.equal(result.diagnostics.unionCount, 2);
  assert.equal(result.diagnostics.finalRelevant, 2);
  // E3b is NOT an embedding failure — the embedding-failure flag must stay off
  // so operators can distinguish "no profile" from "embedding cliff".
  assert.notEqual(
    result.diagnostics.keywordFallbackAfterEmbeddingFailure,
    true,
    "empty profile is not an embedding failure — flag must not be set"
  );
});

test("runEmbeddingRecall: empty profile + empty keyword recall → strict empty with lexical-only diagnostic (E3b)", async () => {
  let calls = 0;
  const embedFn = async () => { calls++; return []; };
  const result = await runEmbeddingRecall({
    candidateItems: [makeItem({ sourceId: "a" })],
    settings: {},
    keywordRecallItems: [],
    embedFn,
    config: HYBRID_CONFIG,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "empty_profile_text_lexical_only");
  assert.equal(result.diagnostics.keywordRecallCount, 0);
  assert.equal(result.diagnostics.unionCount, 0);
  assert.equal(result.diagnostics.finalRelevant, 0);
  assert.notEqual(result.diagnostics.keywordFallbackAfterEmbeddingFailure, true);
});

test("runEmbeddingRecall: caps candidate pool at embedMaxItems before embedding", async () => {
  let receivedTextsLength = 0;
  const embedFn = async (texts) => {
    receivedTextsLength = texts.length;
    return texts.map(() => [1, 0]); // dummy uniform vectors
  };
  const items = Array.from({ length: 10 }, (_, i) => makeItem({ sourceId: `src-${i}` }));
  await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn,
    config: { ...HYBRID_CONFIG, embedMaxItems: 3, embedTopK: 10 },
  });
  // 1 profile + 3 items (capped from 10) = 4 inputs
  assert.equal(receivedTextsLength, 4);
});

test("runEmbeddingRecall: tied cosine scores resolve deterministically by input order then sourceId", async () => {
  // Three items embed to the same vector → cosine ties.  Selection must
  // honor input order first, then sourceId — never depend on V8's hidden
  // sort ordering.
  const items = [
    makeItem({ sourceId: "z-last", headline: "same" }),
    makeItem({ sourceId: "a-first", headline: "same" }),
    makeItem({ sourceId: "m-mid", headline: "same" }),
  ];
  const embedFn = async (texts) => texts.map(() => [1, 0]); // every vector identical
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn,
    config: { ...HYBRID_CONFIG, embedTopK: 2 },
  });
  // Top-2 must be the first two by input order — not the alphabetically
  // earliest sourceIds — because seq dominates over sourceId tiebreak.
  assert.deepEqual(result.items.map((i) => i.sourceId), ["z-last", "a-first"]);
});

test("runEmbeddingRecall: applies embedTopK cap to semantic candidates", async () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    makeItem({ sourceId: `s-${i}`, headline: i < 3 ? "U.S. ofac update" : "unrelated story" })
  );
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: [],
    embedFn: makeStubEmbedder(),
    config: { ...HYBRID_CONFIG, embedTopK: 2 },
  });
  assert.equal(result.diagnostics.similarityKept, 2);
  assert.equal(result.items.length, 2);
});

// ─── WaPo Iran/oil regression fixtures ───────────────────────────────────────
//
// Based on a real false-empty observed in production: a WaPo story
// "Gulf nations hoped to move beyond oil. The Iran war made that much harder"
// matched no canonical topic enum and the user's `topic` field on the item
// was empty (RSS items don't carry a Tempo topic), so the keyword regex was
// the only escape hatch.  These tests pin that the lexical gate alone catches
// it and that an embedding failure does NOT collapse the run to zero.

const WAPO_IRAN_SETTINGS = Object.freeze({
  topics: ["Diplomatic relations", "Trade policy", "Energy trade", "Agricultural trade"],
  keywords: ["oil", "petroleum", "agriculture", "sanctions", "trade"],
  geographies: ["US", "Iran"],
  traditionalSources: ["Washington Post"],
  socialSources: [],
});

const WAPO_IRAN_ITEM = Object.freeze({
  sourceId: "wapo-gulf-iran-oil",
  outlet: "The Washington Post — World",
  // Item topic is empty (typical for RSS); recall must rely on keyword regex.
  topic: "",
  headline: "Gulf nations hoped to move beyond oil. The Iran war made that much harder.",
  body: [
    "Sanctions and military strikes have rerouted petroleum trade across the Gulf, " +
    "with U.S. allies recalibrating their long-term energy posture.",
  ],
  geographies: [],
  url: "https://www.washingtonpost.com/world/2026/01/01/gulf-iran-oil",
  weight: 88,
  kind: "traditional",
  byline: "Test Reporter",
  minutesAgo: 30,
});

test("WaPo Iran/oil: keyword recall alone catches the lexical hit (no item topic, regex via 'oil'/'petroleum')", async () => {
  // Sanity-check that the lexical contract holds: even with an empty item.topic,
  // a WaPo story whose headline contains a configured keyword surfaces.  This
  // pins the regression on keyword-based recall.
  const { applyTopicKeywordFilter } = await import("../dashboard/refresh-pipeline.mjs");
  const passed = applyTopicKeywordFilter([WAPO_IRAN_ITEM], WAPO_IRAN_SETTINGS);
  assert.equal(passed.length, 1, "WaPo Iran/oil headline must match keywords 'oil' and 'petroleum'");
  assert.equal(passed[0].sourceId, "wapo-gulf-iran-oil");
});

test("WaPo Iran/oil: embedding failure with lexical hit → lexical-fallback (degraded), not hard-empty", async () => {
  // The bug we are guarding against: a refresh that hit an embedding timeout
  // and collapsed the dashboard to zero stories despite obvious lexical hits.
  // With the strict-spec policy this stays an empty-state — but the spec for
  // this slice softens it to "preserve lexical hits when embeddings fail".
  const lexicalHits = [WAPO_IRAN_ITEM];
  const result = await runEmbeddingRecall({
    candidateItems: [WAPO_IRAN_ITEM],
    settings: WAPO_IRAN_SETTINGS,
    keywordRecallItems: lexicalHits,
    embedFn: makeStubEmbedder({ throwOnCall: new Error("provider timed out after 8000ms") }),
    config: HYBRID_CONFIG,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].sourceId, "wapo-gulf-iran-oil");
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_timeout_fail_closed");
  assert.equal(result.diagnostics.keywordFallbackAfterEmbeddingFailure, true);
  assert.equal(result.diagnostics.unionCount, 1);
  assert.equal(result.diagnostics.finalRelevant, 1);
});

test("WaPo Iran/oil: items returned in lexical fallback are real ingested items (no fabrication)", async () => {
  // Trust invariant: the fallback path must never synthesize content.  Every
  // returned item must carry the original sourceId and url from the ingest.
  const result = await runEmbeddingRecall({
    candidateItems: [WAPO_IRAN_ITEM],
    settings: WAPO_IRAN_SETTINGS,
    keywordRecallItems: [WAPO_IRAN_ITEM],
    embedFn: null, // missing embedFn
    config: HYBRID_CONFIG,
  });
  assert.equal(result.items.length, 1);
  const out = result.items[0];
  assert.equal(out.sourceId, WAPO_IRAN_ITEM.sourceId);
  assert.equal(out.url, WAPO_IRAN_ITEM.url);
  assert.equal(out.outlet, WAPO_IRAN_ITEM.outlet);
  assert.equal(out.headline, WAPO_IRAN_ITEM.headline);
  // The lexical fallback must never invent a topic or summary.
  assert.equal(out.topic, "");
});

// ─── Phase 3: buildProfileText hygiene ───────────────────────────────────────

test("buildProfileText: drops whitespace-only entries within an axis", () => {
  // Phase 1 hygiene normally strips these before persistence, but the recall
  // stage must be defensive — a malformed settings row should not emit a
  // heading like "Topics:    , Migration policy".
  const text = buildProfileText({
    topics: ["", "  ", "Migration policy"],
    keywords: ["\t", "OFAC"],
    geographies: [],
    traditionalSources: ["   "],
    socialSources: [],
  });
  assert.match(text, /Topics: Migration policy/);
  assert.match(text, /Keywords: OFAC/);
  // No "Geographies:" / "Sources:" line — those axes contributed nothing.
  assert.doesNotMatch(text, /Geographies:/);
  assert.doesNotMatch(text, /Sources:/);
});

test("buildProfileText: returns empty string when every axis is whitespace-only", () => {
  const text = buildProfileText({
    topics: [""],
    keywords: ["  ", "\t"],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
    onboardingNarrative: "   ",
  });
  assert.equal(text, "");
});

test("buildProfileText: ignores non-string entries defensively", () => {
  const text = buildProfileText({
    // The schema enforces strings at the API boundary, but the recall stage
    // is downstream of several layers and could receive shapes it doesn't
    // own.  Non-strings must be dropped silently rather than crashing the
    // join with a "[object Object]" leak.
    topics: [42, null, undefined, "Migration policy"],
    keywords: [],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
  });
  assert.equal(text, "Topics: Migration policy");
});

// ─── Phase 3: summarizeProfileContent (sparseness observability) ─────────────

test("summarizeProfileContent: counts axes that contributed", () => {
  const s = summarizeProfileContent(BASE_SETTINGS);
  // BASE_SETTINGS = topics + keywords + geographies + sources (no narrative)
  assert.equal(s.profileAxes, 4);
  assert.deepEqual(s.profileAxisNames, ["topics", "keywords", "geographies", "sources"]);
  assert.ok(s.profileTextLength > 0);
  assert.equal(s.profileText, buildProfileText(BASE_SETTINGS));
});

test("summarizeProfileContent: empty settings → axes=0, text empty", () => {
  const s = summarizeProfileContent({});
  assert.equal(s.profileAxes, 0);
  assert.deepEqual(s.profileAxisNames, []);
  assert.equal(s.profileText, "");
  assert.equal(s.profileTextLength, 0);
});

test("summarizeProfileContent: single-axis sparse profile → axes=1, only that name listed", () => {
  // Sparse-profile signature: operators reading `_meta.recall.profileAxes=1`
  // know the semantic widen is running against a degenerate single-axis
  // embedding (e.g. just sources), which often produces low-confidence
  // top-K matches.  This is observability, not a behavior gate.
  const s = summarizeProfileContent({
    topics: [],
    keywords: [],
    geographies: [],
    traditionalSources: ["Reuters"],
    socialSources: [],
  });
  assert.equal(s.profileAxes, 1);
  assert.deepEqual(s.profileAxisNames, ["sources"]);
});

test("summarizeProfileContent: narrative-only profile is counted (axis=narrative)", () => {
  const s = summarizeProfileContent({
    topics: [],
    keywords: [],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
    onboardingNarrative: "I cover US-Colombia bilateral comms.",
  });
  assert.equal(s.profileAxes, 1);
  assert.deepEqual(s.profileAxisNames, ["narrative"]);
});

// ─── Phase 3: recall diagnostics surface profileAxes on every return path ────

test("runEmbeddingRecall: diagnostics surface profileAxes on the full-run (hybrid_strict) path", async () => {
  const items = [makeItem({ sourceId: "a", headline: "OFAC update" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: items,
    embedFn: makeStubEmbedder(),
    config: HYBRID_CONFIG,
  });
  assert.equal(result.diagnostics.profileAxes, 4);
  assert.deepEqual(result.diagnostics.profileAxisNames, [
    "topics",
    "keywords",
    "geographies",
    "sources",
  ]);
  assert.ok(result.diagnostics.profileTextLength > 0);
});

test("runEmbeddingRecall: diagnostics surface profileAxes on the keyword-mode bypass path", async () => {
  // Keyword mode skips embedding entirely, but the diagnostic surface must
  // be the same shape so `_meta.recall` doesn't shrink on a mode toggle.
  const items = [makeItem({ sourceId: "a" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: items,
    embedFn: async () => [],
    config: { ...HYBRID_CONFIG, mode: RECALL_MODE.KEYWORD },
  });
  assert.equal(result.diagnostics.profileAxes, 4);
  assert.deepEqual(result.diagnostics.profileAxisNames, [
    "topics",
    "keywords",
    "geographies",
    "sources",
  ]);
  assert.equal(result.diagnostics.mode, "keyword");
});

test("runEmbeddingRecall: diagnostics surface profileAxes=0 on the empty-profile lexical-only path", async () => {
  // E3b path: empty profile is degraded (lexical-only) but profileAxes must
  // be 0 — the formal invariant for the empty-profile branch.
  const items = [makeItem({ sourceId: "a" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: {},
    keywordRecallItems: items,
    embedFn: async () => [],
    config: HYBRID_CONFIG,
  });
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "empty_profile_text_lexical_only");
  assert.equal(result.diagnostics.profileAxes, 0);
  assert.deepEqual(result.diagnostics.profileAxisNames, []);
  assert.equal(result.diagnostics.profileTextLength, 0);
});

test("runEmbeddingRecall: diagnostics surface profileAxes on a fail-closed lexical-fallback path", async () => {
  // Provider failure with lexical hits → lexical fallback (degraded).
  // profileAxes must still reflect what the profile WOULD have looked like
  // so operators can disentangle "thin profile" from "provider cliff".
  const items = [makeItem({ sourceId: "a", headline: "OFAC update" })];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: items,
    embedFn: makeStubEmbedder({ throwOnCall: new Error("provider 500") }),
    config: HYBRID_CONFIG,
  });
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degraded_reason, "embedding_error_fail_closed");
  assert.equal(result.diagnostics.profileAxes, 4);
});

test("runEmbeddingRecall: profileAxes=1 + degraded:false documents the sparse-profile signature", async () => {
  // The sparse-but-valid case: a profile with only one axis still runs end
  // to end (no behavior gate), but `profileAxes=1` lets ops see WHY semantic
  // widen might be producing low-confidence top-K matches.
  const items = [makeItem({ sourceId: "a", headline: "Reuters reporting" })];
  const sparseSettings = {
    topics: [],
    keywords: [],
    geographies: [],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: sparseSettings,
    keywordRecallItems: [],
    embedFn: makeStubEmbedder(),
    config: HYBRID_CONFIG,
  });
  // Behavior unchanged: still runs the embedder, still returns a result.
  assert.equal(result.diagnostics.profileAxes, 1);
  assert.deepEqual(result.diagnostics.profileAxisNames, ["sources"]);
  // No degraded flag — sparse is not a failure.
  assert.equal(result.diagnostics.degraded, false);
  assert.equal(result.diagnostics.degraded_reason, null);
});

// ─── Phase 3: post-union invariant ───────────────────────────────────────────

test("runEmbeddingRecall: post-union finalRelevant equals merged set size (no double count)", async () => {
  // Invariant: `finalRelevant` is the size of the merged set, which equals
  // `unionCount`.  A drift between the two would mean the funnel and the
  // recall diagnostics are quietly disagreeing about how many items reached
  // beat-fit.
  const items = [
    makeItem({ sourceId: "kw-1", headline: "OFAC sanctions update" }),
    makeItem({ sourceId: "sem-1", headline: "U.S. and Colombia coordinate" }),
    makeItem({ sourceId: "off", headline: "Local sports" }),
  ];
  const result = await runEmbeddingRecall({
    candidateItems: items,
    settings: BASE_SETTINGS,
    keywordRecallItems: [items[0]],
    embedFn: makeStubEmbedder(),
    config: { ...HYBRID_CONFIG, embedTopK: 2 },
  });
  assert.equal(result.items.length, result.diagnostics.unionCount);
  assert.equal(result.diagnostics.finalRelevant, result.diagnostics.unionCount);
});
