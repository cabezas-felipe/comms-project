import { test } from "node:test";
import assert from "node:assert/strict";

const {
  SEMANTIC_BEAT_FIT_VERSION,
  SEMANTIC_BLEND_DETERMINISTIC,
  SEMANTIC_BLEND_SEMANTIC,
  resolveSemanticBeatFitConfig,
  buildIntentProfileText,
  buildItemCanonicalText,
  cosineSimilarity,
  normalizeCosineToScore,
  createProfileEmbeddingCache,
  profileCacheKey,
  computeSemanticBeatFitScores,
  attachSemanticScores,
  PROFILE_AXIS_ORDER,
  profileAxisNames,
} = await import("./semantic-beat-fit.mjs");

// ─── shared helpers ──────────────────────────────────────────────────────────

const SETTINGS = {
  topics: ["Terrorism", "Diplomatic relations"],
  keywords: ["terrorism", "sanctions"],
  geographies: ["US", "Nigeria"],
  onboardingNarrative: "I track terrorism incidents and bilateral diplomacy.",
};

function makeItem(overrides = {}) {
  return {
    sourceId: overrides.sourceId ?? "src-1",
    outlet: "Reuters",
    minutesAgo: 30,
    headline: "Test headline",
    body: ["Test body."],
    topic: "Other",
    geographies: [],
    ...overrides,
  };
}

// Token-bag embedding stub: stable, no randomness, lets tests pin which
// items are "semantically close" to the profile without a real API. Each
// text is mapped to a fixed-dimension vector by counting occurrences of a
// curated token list — items that share more tokens with the profile end
// up with higher cosine similarity.
const STUB_TOKENS = [
  "terrorism",
  "isis",
  "militant",
  "attack",
  "sanctions",
  "diplomatic",
  "bilateral",
  "nigeria",
  "us",
  "petro",
  "tanker",
  "fertilizer",
  "wheat",
  "celebrity",
];

function tokenBagEmbed(text) {
  const lower = String(text ?? "").toLowerCase();
  return STUB_TOKENS.map((tok) => {
    const re = new RegExp(`\\b${tok}\\b`, "g");
    const matches = lower.match(re);
    return matches ? matches.length : 0;
  });
}

function stubEmbedFn() {
  return async (texts) => texts.map(tokenBagEmbed);
}

// ─── constants ───────────────────────────────────────────────────────────────

test("semantic blend weights sum to 1.0", () => {
  assert.ok(Math.abs(SEMANTIC_BLEND_DETERMINISTIC + SEMANTIC_BLEND_SEMANTIC - 1.0) < 1e-9);
  assert.equal(SEMANTIC_BLEND_DETERMINISTIC, 0.65);
  assert.equal(SEMANTIC_BLEND_SEMANTIC, 0.35);
});

test("SEMANTIC_BEAT_FIT_VERSION is a stable identifier", () => {
  assert.equal(typeof SEMANTIC_BEAT_FIT_VERSION, "string");
  assert.ok(SEMANTIC_BEAT_FIT_VERSION.length > 0);
});

// ─── normalizeCosineToScore ──────────────────────────────────────────────────

test("normalizeCosineToScore maps [-1, 1] to [0, 1]", () => {
  assert.equal(normalizeCosineToScore(-1), 0);
  assert.equal(normalizeCosineToScore(0), 0.5);
  assert.equal(normalizeCosineToScore(1), 1);
  assert.equal(normalizeCosineToScore(0.5), 0.75);
});

test("normalizeCosineToScore clamps out-of-range and rejects non-finite", () => {
  assert.equal(normalizeCosineToScore(2), 1);
  assert.equal(normalizeCosineToScore(-2), 0);
  assert.equal(normalizeCosineToScore(Number.NaN), 0);
  assert.equal(normalizeCosineToScore("0.5"), 0);
});

// ─── cosineSimilarity ────────────────────────────────────────────────────────

test("cosineSimilarity: identical vectors → 1.0", () => {
  const v = [1, 2, 3];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
});

test("cosineSimilarity: orthogonal vectors → 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: zero/missing vectors safely return 0", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity(null, [1]), 0);
  assert.equal(cosineSimilarity([1], null), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

// ─── text builders ───────────────────────────────────────────────────────────

test("buildIntentProfileText composes all axes into a single intent paragraph", () => {
  const text = buildIntentProfileText(SETTINGS);
  assert.match(text, /Terrorism/);
  assert.match(text, /sanctions/);
  assert.match(text, /Nigeria/);
  assert.match(text, /I track terrorism incidents/);
});

test("buildIntentProfileText returns empty string when no signal", () => {
  assert.equal(buildIntentProfileText({}), "");
  assert.equal(buildIntentProfileText({ topics: [], keywords: [] }), "");
  assert.equal(buildIntentProfileText(null), "");
});

// ─── D-058 (PR3): narrative-first profile ordering ───────────────────────────
//
// The semantic profile leads with the onboarding narrative when present so the
// embedding model anchors on user intent before the chip-list axes. The blend
// formula and threshold are intentionally untouched in this PR (those are
// Point 5 + Point 6 territory).

test("D-058: buildIntentProfileText emits narrative FIRST when narrative is present", () => {
  const text = buildIntentProfileText(SETTINGS);
  const idxNarrative = text.indexOf("Beat narrative:");
  const idxTopics = text.indexOf("I monitor news about");
  const idxKeywords = text.indexOf("Specific topics I care about:");
  const idxGeos = text.indexOf("Geographic focus:");
  assert.ok(idxNarrative >= 0, "narrative segment must be present");
  assert.ok(idxTopics > idxNarrative, "topics must follow narrative");
  assert.ok(idxKeywords > idxTopics, "keywords must follow topics");
  assert.ok(idxGeos > idxKeywords, "geographies must follow keywords");
  assert.ok(text.startsWith("Beat narrative:"), "profile must start with the narrative segment");
});

test("D-058: buildIntentProfileText keeps narrative when chip axes are empty", () => {
  const text = buildIntentProfileText({
    topics: [],
    keywords: [],
    geographies: [],
    onboardingNarrative: "I cover terrorism in West Africa for a State Department audience.",
  });
  assert.ok(text.startsWith("Beat narrative:"));
  assert.match(text, /West Africa/);
  // No spurious axis segments when their inputs are empty.
  assert.equal(text.includes("I monitor news about"), false);
  assert.equal(text.includes("Specific topics I care about:"), false);
  assert.equal(text.includes("Geographic focus:"), false);
});

test("D-058: buildIntentProfileText silently falls back to axes when narrative is empty/null", () => {
  // Three flavors of "no narrative": missing key, empty string, whitespace.
  // Each must still produce a non-empty profile when other axes carry signal,
  // and that profile must start with the topic segment (next-in-order).
  for (const variant of [
    { topics: ["Terrorism"], keywords: ["sanctions"], geographies: ["US"] },
    { topics: ["Terrorism"], keywords: ["sanctions"], geographies: ["US"], onboardingNarrative: "" },
    { topics: ["Terrorism"], keywords: ["sanctions"], geographies: ["US"], onboardingNarrative: "   " },
  ]) {
    const text = buildIntentProfileText(variant);
    assert.ok(text.length > 0, "missing narrative must not silently zero the profile");
    assert.ok(text.startsWith("I monitor news about"), "topic axis leads when narrative is absent");
    assert.equal(text.includes("Beat narrative:"), false, "no narrative segment when input is empty");
  }
});

test("D-058: buildIntentProfileText DOES NOT silently drop a non-empty narrative", () => {
  // Regression guard: if a future refactor reorders or strips the narrative
  // segment when other axes are very large, this test catches it.
  const fatSettings = {
    topics: Array.from({ length: 24 }, (_, i) => `Topic ${i}`),
    keywords: Array.from({ length: 24 }, (_, i) => `kw${i}`),
    geographies: Array.from({ length: 24 }, (_, i) => `Geo${i}`),
    onboardingNarrative: "Narrative must survive a heavy chip-list payload.",
  };
  const text = buildIntentProfileText(fatSettings);
  assert.ok(text.includes("Narrative must survive"), "narrative survives next to large chip lists");
  assert.ok(text.startsWith("Beat narrative:"), "narrative still leads even with heavy chip axes");
});

test("D-058: PROFILE_AXIS_ORDER pins the documented narrative-first ordering", () => {
  assert.deepEqual(Array.from(PROFILE_AXIS_ORDER), [
    "narrative",
    "topics",
    "keywords",
    "geographies",
  ]);
});

test("D-058: profileAxisNames reports the axes that actually contributed, in order", () => {
  assert.deepEqual(profileAxisNames(SETTINGS), [
    "narrative",
    "topics",
    "keywords",
    "geographies",
  ]);
  assert.deepEqual(
    profileAxisNames({ topics: ["A"], keywords: ["b"], geographies: ["C"] }),
    ["topics", "keywords", "geographies"],
    "missing narrative → axes skip it but stay ordered"
  );
  assert.deepEqual(
    profileAxisNames({ onboardingNarrative: "narrative only" }),
    ["narrative"],
    "narrative-only profile reports just narrative"
  );
  assert.deepEqual(profileAxisNames({}), [], "empty settings → empty list");
  assert.deepEqual(profileAxisNames(null), [], "null settings → empty list");
});

test("D-058: profile cache key is invariant under segment-order changes for the same settings", () => {
  // The cache key hashes the cleaned settings fields, NOT the assembled
  // profile text — so reordering segments inside buildIntentProfileText must
  // never invalidate the cache for identical settings. This guards the
  // narrative-first reorder against accidental cache churn.
  const before = profileCacheKey(SETTINGS, "text-embedding-3-large");
  const sameSettings = { ...SETTINGS };
  const after = profileCacheKey(sameSettings, "text-embedding-3-large");
  assert.equal(before, after);
});

test("D-058: blend weights and version remain unchanged in this PR", () => {
  // Lock the contract: PR3 is profile-shape only. Any change to the blend
  // weights is Point 5/Point 6 territory and must be a separate decision.
  assert.equal(SEMANTIC_BLEND_DETERMINISTIC, 0.65);
  assert.equal(SEMANTIC_BLEND_SEMANTIC, 0.35);
  assert.equal(SEMANTIC_BEAT_FIT_VERSION, "semantic-beat-fit-v1");
});

test("buildItemCanonicalText joins headline+subtitle+body and caps length", () => {
  const item = {
    headline: "Headline",
    subtitle: "Subtitle",
    body: ["Body sentence one.", "Body sentence two."],
  };
  const text = buildItemCanonicalText(item, 1000);
  assert.match(text, /Headline/);
  assert.match(text, /Subtitle/);
  assert.match(text, /Body sentence/);
  const truncated = buildItemCanonicalText(item, 5);
  assert.equal(truncated.length, 5);
});

// ─── resolveSemanticBeatFitConfig ────────────────────────────────────────────

test("resolveSemanticBeatFitConfig defaults to enabled with text-embedding-3-large", () => {
  const cfg = resolveSemanticBeatFitConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.killSwitch, false);
  assert.equal(cfg.model, "text-embedding-3-large");
  assert.ok(cfg.timeoutMs >= 1);
});

test("resolveSemanticBeatFitConfig: kill switch wins over enabled", () => {
  const cfg = resolveSemanticBeatFitConfig({
    TEMPO_SEMANTIC_BEAT_FIT_KILL_SWITCH: "true",
    TEMPO_SEMANTIC_BEAT_FIT_ENABLED: "true",
  });
  assert.equal(cfg.killSwitch, true);
  assert.equal(cfg.enabled, false);
});

test("resolveSemanticBeatFitConfig: TEMPO_SEMANTIC_BEAT_FIT_ENABLED=false disables", () => {
  const cfg = resolveSemanticBeatFitConfig({ TEMPO_SEMANTIC_BEAT_FIT_ENABLED: "false" });
  assert.equal(cfg.enabled, false);
});

test("resolveSemanticBeatFitConfig: overrides win over env", () => {
  const cfg = resolveSemanticBeatFitConfig(
    { TEMPO_SEMANTIC_BEAT_FIT_ENABLED: "true" },
    { enabled: false }
  );
  assert.equal(cfg.enabled, false);
});

// ─── profile cache ───────────────────────────────────────────────────────────

test("profileCacheKey is stable across order/casing variations", () => {
  const a = profileCacheKey(
    { topics: ["Terrorism", "Migration"], keywords: ["sanctions"], geographies: ["US"], onboardingNarrative: "x" },
    "model-1"
  );
  const b = profileCacheKey(
    { topics: ["migration", "TERRORISM"], keywords: ["sanctions"], geographies: ["us"], onboardingNarrative: "x" },
    "model-1"
  );
  assert.equal(a, b);
});

test("profileCacheKey changes when model changes", () => {
  const a = profileCacheKey(SETTINGS, "model-1");
  const b = profileCacheKey(SETTINGS, "model-2");
  assert.notEqual(a, b);
});

test("createProfileEmbeddingCache evicts the oldest entry past the limit", () => {
  const cache = createProfileEmbeddingCache(2);
  cache.set("a", [1]);
  cache.set("b", [2]);
  cache.set("c", [3]);
  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(cache.get("b"), [2]);
  assert.deepEqual(cache.get("c"), [3]);
});

// ─── computeSemanticBeatFitScores ────────────────────────────────────────────

test("disabled by flag → returns empty scores + degraded reason", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: false }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.scoresBySourceId.size, 0);
  assert.equal(result.diagnostics.enabled, false);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degradedReason, "disabled_by_flag");
});

test("kill switch active → returns empty scores with kill_switch_active reason", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { killSwitch: true, enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.killSwitchActive, true);
  assert.equal(result.diagnostics.degradedReason, "kill_switch_active");
});

test("missing embedFn → degraded reason embed_fn_unavailable, never throws", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: SETTINGS,
    embedFn: null,
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.degradedReason, "embed_fn_unavailable");
  assert.equal(result.scoresBySourceId.size, 0);
});

test("empty profile text → degraded reason empty_profile_text", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: { topics: [], keywords: [], geographies: [] },
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.degradedReason, "empty_profile_text");
});

test("empty items → returns empty scores without degraded flag", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [],
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.scoresBySourceId.size, 0);
  assert.equal(result.diagnostics.degraded, false);
});

test("scores all items and surfaces per-bucket distribution + mean", async () => {
  const items = [
    makeItem({
      sourceId: "isis-nigeria",
      headline: "ISIS militants attack village in Nigeria, dozens killed",
      body: ["Witnesses described the attack."],
    }),
    makeItem({
      sourceId: "celebrity-news",
      headline: "Celebrity buys yacht",
      body: ["Tabloid coverage of celebrity excess."],
    }),
  ];
  const result = await computeSemanticBeatFitScores({
    items,
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.scoredCount, 2);
  assert.equal(result.scoresBySourceId.size, 2);
  const isisScore = result.scoresBySourceId.get("isis-nigeria");
  const celebScore = result.scoresBySourceId.get("celebrity-news");
  assert.ok(isisScore > celebScore, `ISIS/Nigeria (${isisScore}) must outscore celebrity (${celebScore})`);
  assert.equal(typeof result.diagnostics.meanScore, "number");
  const bucketSum = Object.values(result.diagnostics.scoreBuckets).reduce((a, b) => a + b, 0);
  assert.equal(bucketSum, 2, "every score must land in exactly one bucket");
});

test("provider error → degraded reason embedding_error, no throw", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: SETTINGS,
    embedFn: async () => {
      throw new Error("provider 500");
    },
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.degradedReason, "embedding_error");
  assert.equal(result.scoresBySourceId.size, 0);
});

test("provider timeout → degraded reason embedding_timeout", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: SETTINGS,
    embedFn: async () => {
      throw new Error("request timed out after 4000ms");
    },
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.degradedReason, "embedding_timeout");
});

test("invalid vector response → degraded reason embedding_invalid_response", async () => {
  const result = await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: SETTINGS,
    embedFn: async () => "not-an-array",
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.degradedReason, "embedding_invalid_response");
});

test("profile cache: second run with same settings hits cache and skips profile embed", async () => {
  let calls = 0;
  const embedFn = async (texts) => {
    calls++;
    return texts.map(tokenBagEmbed);
  };
  const cache = createProfileEmbeddingCache();
  const r1 = await computeSemanticBeatFitScores({
    items: [makeItem({ sourceId: "a" })],
    settings: SETTINGS,
    embedFn,
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: cache,
  });
  const r2 = await computeSemanticBeatFitScores({
    items: [makeItem({ sourceId: "b" })],
    settings: SETTINGS,
    embedFn,
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: cache,
  });
  assert.equal(r1.diagnostics.profileCacheHit, false);
  assert.equal(r2.diagnostics.profileCacheHit, true);
  // First call embedded [profile, item], second only [item].
  assert.equal(calls, 2);
});

test("maxItems caps the candidate pool deterministically", async () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    makeItem({ sourceId: `s-${i}`, headline: `headline ${i} terrorism` })
  );
  const result = await computeSemanticBeatFitScores({
    items,
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: true, maxItems: 3 }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.scoredCount, 3);
  assert.ok(result.scoresBySourceId.has("s-0"));
  assert.ok(result.scoresBySourceId.has("s-1"));
  assert.ok(result.scoresBySourceId.has("s-2"));
});

test("items with no usable text are skipped without rejecting the whole batch", async () => {
  const items = [
    makeItem({ sourceId: "good", headline: "Terrorism in Nigeria" }),
    makeItem({ sourceId: "empty", headline: "", body: [""] }),
  ];
  const result = await computeSemanticBeatFitScores({
    items,
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(result.diagnostics.scoredCount, 1);
  assert.equal(result.diagnostics.skippedCount, 1);
  assert.ok(result.scoresBySourceId.has("good"));
  assert.ok(!result.scoresBySourceId.has("empty"));
});

// ─── attachSemanticScores ────────────────────────────────────────────────────

test("attachSemanticScores: writes semanticIntentScore from map, null when absent", () => {
  const items = [makeItem({ sourceId: "a" }), makeItem({ sourceId: "b" })];
  const scores = new Map([["a", 0.82]]);
  const out = attachSemanticScores(items, scores);
  assert.equal(out[0].semanticIntentScore, 0.82);
  assert.equal(out[1].semanticIntentScore, null);
});

test("attachSemanticScores: empty map preserves any pre-existing semanticIntentScore", () => {
  const items = [{ sourceId: "x", semanticIntentScore: 0.55 }];
  const out = attachSemanticScores(items, new Map());
  assert.equal(out[0].semanticIntentScore, 0.55);
});

test("attachSemanticScores returns new objects, does not mutate inputs", () => {
  const item = makeItem({ sourceId: "z" });
  const out = attachSemanticScores([item], new Map([["z", 0.42]]));
  assert.notEqual(out[0], item);
  assert.equal(item.semanticIntentScore, undefined);
});

// ─── polish: abort listener cleanup + no-op short-circuit ────────────────────
//
// The internal `runWithTimeout` helper is exercised through the public API
// (it is not exported). These tests pin the observable behavior:
//   1. Successful + failed embed paths must remove the abort listener from
//      the caller-provided signal — long-lived signals (refresh-wide) would
//      otherwise accumulate stale listeners across pipeline stages.
//   2. When every item produces empty canonical text, the function must NOT
//      invoke `embedFn` at all (no profile-only call) — keeps cost and tail
//      latency at zero on degenerate refreshes.

// Minimal AbortSignal mock that tracks listener bookkeeping. Mirrors the
// surface `runWithTimeout` actually uses: `aborted`, `addEventListener`,
// `removeEventListener`. Does not aim for full DOM AbortSignal fidelity.
function mockSignal() {
  const listeners = new Map(); // type → Set<fn>
  return {
    aborted: false,
    addListenerCalls: 0,
    removeListenerCalls: 0,
    addEventListener(type, fn) {
      this.addListenerCalls += 1;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this.removeListenerCalls += 1;
      listeners.get(type)?.delete(fn);
    },
    activeListenerCount(type = "abort") {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

test("runWithTimeout (via computeSemanticBeatFitScores): abort listener is removed on successful path", async () => {
  const signal = mockSignal();
  await computeSemanticBeatFitScores({
    items: [makeItem({ headline: "Terrorism in Nigeria" })],
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
    signal,
  });
  assert.equal(signal.addListenerCalls, 1, "exactly one abort listener was registered");
  assert.equal(signal.removeListenerCalls, 1, "the abort listener must be removed on resolve");
  assert.equal(signal.activeListenerCount("abort"), 0, "no stale listeners remain");
});

test("runWithTimeout (via computeSemanticBeatFitScores): abort listener is removed on provider error", async () => {
  const signal = mockSignal();
  await computeSemanticBeatFitScores({
    items: [makeItem()],
    settings: SETTINGS,
    embedFn: async () => {
      throw new Error("provider 500");
    },
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
    signal,
  });
  assert.equal(signal.activeListenerCount("abort"), 0, "rejection path must also clean up");
  assert.equal(signal.removeListenerCalls, signal.addListenerCalls);
});

test("runWithTimeout (via computeSemanticBeatFitScores): repeated runs do not accumulate stale listeners on a shared signal", async () => {
  // The realistic shape: one signal carried across multiple stage invocations
  // (refresh-wide abort). Without explicit removal each run leaked a listener.
  const signal = mockSignal();
  const cache = createProfileEmbeddingCache();
  for (let i = 0; i < 5; i++) {
    await computeSemanticBeatFitScores({
      items: [makeItem({ sourceId: `s-${i}`, headline: "Sanctions update" })],
      settings: SETTINGS,
      embedFn: stubEmbedFn(),
      config: resolveSemanticBeatFitConfig({}, { enabled: true }),
      profileCache: cache,
      signal,
    });
  }
  assert.equal(signal.activeListenerCount("abort"), 0, "no listener should remain after N runs");
  assert.equal(signal.addListenerCalls, signal.removeListenerCalls);
});

test("runWithTimeout (via computeSemanticBeatFitScores): already-aborted signal short-circuits without leaking a listener", async () => {
  const signal = mockSignal();
  signal.aborted = true;
  const result = await computeSemanticBeatFitScores({
    items: [makeItem({ headline: "Terrorism in Nigeria" })],
    settings: SETTINGS,
    embedFn: stubEmbedFn(),
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
    signal,
  });
  // The short-circuit path does not register a listener at all.
  assert.equal(signal.addListenerCalls, 0);
  assert.equal(signal.activeListenerCount("abort"), 0);
  assert.equal(result.diagnostics.degraded, true);
  // The aborted-before-start path rejects with "aborted", which the
  // diagnostic classifier maps to `embedding_timeout` (cancellation-class).
  assert.equal(result.diagnostics.degradedReason, "embedding_timeout");
});

test("computeSemanticBeatFitScores: all-empty candidate texts → embedFn is never called", async () => {
  // No usable canonical text on any item — even the profile vector should not
  // be fetched, since there's nothing to score against it.
  let calls = 0;
  const embedFn = async (texts) => {
    calls += 1;
    return texts.map(() => [0, 0]);
  };
  const result = await computeSemanticBeatFitScores({
    items: [
      makeItem({ sourceId: "empty-1", headline: "", body: [""] }),
      makeItem({ sourceId: "empty-2", headline: "   ", body: ["   "] }),
    ],
    settings: SETTINGS,
    embedFn,
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(),
  });
  assert.equal(calls, 0, "embedFn must not be invoked when every item is empty-text");
  assert.equal(result.scoresBySourceId.size, 0);
  assert.equal(result.diagnostics.scoredCount, 0);
  assert.equal(result.diagnostics.skippedCount, 2, "both items counted as skipped");
  assert.equal(result.diagnostics.degraded, false, "not a degraded state — just no work");
  assert.equal(typeof result.diagnostics.latencyMs, "number");
  assert.equal(typeof result.diagnostics.profileCacheSize, "number");
});

test("computeSemanticBeatFitScores: all-empty texts skips embedFn even when profile cache is empty", async () => {
  // Reinforces the polish: previously the early-return only fired when the
  // profile vector was already cached. With no cache entry, the legacy code
  // path embedded the profile alone — wasted call.
  let calls = 0;
  const embedFn = async (texts) => {
    calls += 1;
    return texts.map(() => [0, 0]);
  };
  await computeSemanticBeatFitScores({
    items: [makeItem({ sourceId: "empty", headline: "", body: [""] })],
    settings: SETTINGS,
    embedFn,
    config: resolveSemanticBeatFitConfig({}, { enabled: true }),
    profileCache: createProfileEmbeddingCache(), // empty cache on entry
  });
  assert.equal(calls, 0, "no embedFn call should happen even on a cold profile cache");
});
