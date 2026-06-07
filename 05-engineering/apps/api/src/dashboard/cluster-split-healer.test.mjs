// Unit tests for the post-cluster split healer (Slice 1). Pure module — no
// pipeline wiring, no network. These pin the narrow split policy: low
// token-overlap splits (geography stripped so a shared country can't mask it),
// disjoint single-source claim_evidence_map splits, and the passthrough paths.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveClusterSplitConfig,
  splitOverMergedClusters,
} from "./cluster-split-healer.mjs";

const SETTINGS = { geographies: ["Colombia"] };

// Always-on config for the split-behavior tests (independent of env).
const ON = { enabled: true, jaccardThreshold: 0.15 };

function item(sourceId, headline, body = []) {
  return { sourceId, headline, body, outlet: "Outlet", geographies: ["Colombia"] };
}

function mapOf(...items) {
  return new Map(items.map((it) => [it.sourceId, it]));
}

// Helper to build a clustered meta-story shaped like cluster-engine output.
function metaStory({ source_item_ids, factual_claims, claim_evidence_map, tags }) {
  return {
    title: "Colombia Developments",
    subtitle: "Recent developments in colombia.",
    source_item_ids,
    summary: "merged",
    tags: tags ?? { topics: ["Colombia"], keywords: [], geographies: ["Colombia"] },
    factual_claims: factual_claims ?? source_item_ids.map((_, i) => `claim ${i}`),
    claim_evidence_map:
      claim_evidence_map ??
      Object.fromEntries(source_item_ids.map((id, i) => [String(i), [id]])),
  };
}

test("splits a Colombia election + Colombia mine-attack over-merge into 2 stories", () => {
  const a = item("a", "Colombia presidential candidates clash in final election debate", [
    "Voters head to the polls next month to choose a new president.",
  ]);
  const b = item("b", "Armed group attacks Colombia gold mine, killing several workers", [
    "Authorities blame an illegal armed faction for the deadly assault.",
  ]);
  const story = metaStory({ source_item_ids: ["a", "b"] });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(a, b),
    SETTINGS,
    ON
  );

  assert.equal(stories.length, 2);
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(diagnostics.splitReasons.low_token_overlap, 1);
  assert.deepEqual(
    stories.map((s) => s.source_item_ids),
    [["a"], ["b"]]
  );
  // Titles carried from source headlines; deterministic IDs differ.
  assert.equal(stories[0].title, a.headline);
  assert.equal(stories[1].title, b.headline);
  assert.notEqual(stories[0].meta_story_id, stories[1].meta_story_id);
  assert.deepEqual(stories[0].claim_evidence_map, { "0": ["a"] });
});

test("does NOT split two same-event election stories with high token overlap", () => {
  const a = item("a", "Colombia presidential election debate draws record viewers", [
    "The presidential debate covered tax reform and security policy.",
  ]);
  const b = item("b", "Colombia presidential election debate sparks tax reform clash", [
    "Candidates argued over tax reform and security during the debate.",
  ]);
  // Shared (corroborated) evidence so the disjoint-claim path cannot fire.
  const story = metaStory({
    source_item_ids: ["a", "b"],
    factual_claims: ["Candidates debated tax reform and security"],
    claim_evidence_map: { "0": ["a", "b"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(a, b),
    SETTINGS,
    ON
  );

  assert.equal(stories.length, 1);
  assert.equal(diagnostics.splitCount, 0);
  assert.strictEqual(stories[0], story); // untouched passthrough
});

test("passthrough for a single-source meta-story", () => {
  const a = item("a", "Colombia mine attack leaves workers dead", ["body line"]);
  const story = metaStory({ source_item_ids: ["a"] });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(a),
    SETTINGS,
    ON
  );

  assert.equal(stories.length, 1);
  assert.equal(diagnostics.splitCount, 0);
  assert.strictEqual(stories[0], story);
});

test("geography-only overlap still splits (shared country token does not block split)", () => {
  // The ONLY shared token is the country name; everything else is disjoint.
  const a = item("a", "Colombia coffee harvest forecast", ["Coffee yields expected to rise."]);
  const b = item("b", "Colombia volcano eruption warning", ["Seismic tremors prompt evacuation alerts."]);
  const story = metaStory({ source_item_ids: ["a", "b"] });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(a, b),
    SETTINGS,
    ON
  );

  assert.equal(stories.length, 2);
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(diagnostics.splitReasons.low_token_overlap, 1);
});

test("corroboration guard: low overlap but corroborated claim evidence does NOT split", () => {
  // Two articles about the SAME beat that happen to share few literal tokens
  // (one headlined around "ballot/vote", the other around "campaign/rally").
  // Token overlap is below threshold, but the clustering stage corroborated
  // them under a single shared claim ({"0": [a, b]}) — that is a legitimate
  // single story and must survive the low-overlap path.
  const a = item("a", "Colombia presidential ballot race tightens before the vote", [
    "Candidates crisscross the country ahead of the decision.",
  ]);
  const b = item("b", "Colombians rally as campaign enters its closing weekend", [
    "Crowds gathered for the final push.",
  ]);
  const story = metaStory({
    source_item_ids: ["a", "b"],
    factual_claims: ["Colombia heads toward a decisive presidential vote"],
    claim_evidence_map: { "0": ["a", "b"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(a, b),
    SETTINGS,
    ON
  );

  assert.equal(stories.length, 1, "corroborated low-overlap cluster must not split");
  assert.equal(diagnostics.splitCount, 0);
  assert.strictEqual(stories[0], story);
});

test("disabled config returns passthrough with diagnostics.enabled=false", () => {
  const a = item("a", "Colombia coffee harvest forecast", ["Coffee yields expected to rise."]);
  const b = item("b", "Colombia volcano eruption warning", ["Seismic tremors prompt evacuation."]);
  const story = metaStory({ source_item_ids: ["a", "b"] });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(a, b),
    SETTINGS,
    { enabled: false, jaccardThreshold: 0.15 }
  );

  assert.equal(diagnostics.enabled, false);
  assert.equal(stories.length, 1);
  assert.equal(diagnostics.splitCount, 0);
  assert.equal(diagnostics.outputCount, 1);
  assert.strictEqual(stories[0], story);
});

test("diagnostics counters reflect splitCount and both splitReasons", () => {
  // Story 1: low overlap → low_token_overlap (English items, atomized).
  const a = item("a", "Colombia coffee harvest forecast", ["Coffee yields rise."]);
  const b = item("b", "Colombia volcano eruption warning", ["Seismic tremors prompt evacuation."]);
  const lowOverlap = metaStory({ source_item_ids: ["a", "b"] });

  // Story 2: disjoint single-source claim evidence with PARTIAL text overlap —
  // c & d are the same tax-reform protest (high overlap), e is an unrelated
  // earthquake (low overlap). low_token_overlap does NOT fire (c-d overlap), so
  // the reason is disjoint_claim_evidence; A3 bundling groups [c,d] together and
  // leaves [e] separate → 2 stories (one bundle + one singleton), not 3 atoms.
  const c = item("c", "Colombia tax reform protest grips capital", ["Tax reform protest spreads downtown."]);
  const d = item("d", "Colombia tax reform protest grips the capital again", ["Tax reform protest spreads downtown today."]);
  const e = item("e", "Colombia earthquake damages coastal bridge", ["A strong quake severed a key coastal bridge."]);
  const disjoint = metaStory({
    source_item_ids: ["c", "d", "e"],
    factual_claims: ["claim c", "claim d", "claim e"],
    claim_evidence_map: { "0": ["c"], "1": ["d"], "2": ["e"] },
  });

  // Story 3: high overlap + corroborated evidence → no split.
  const noSplit = metaStory({
    source_item_ids: ["c", "d"],
    factual_claims: ["shared claim"],
    claim_evidence_map: { "0": ["c", "d"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters(
    [lowOverlap, disjoint, noSplit],
    mapOf(a, b, c, d, e),
    SETTINGS,
    ON
  );

  assert.equal(diagnostics.inputCount, 3);
  assert.equal(diagnostics.splitCount, 2);
  assert.equal(diagnostics.splitReasons.low_token_overlap, 1);
  assert.equal(diagnostics.splitReasons.disjoint_claim_evidence, 1);
  // Story 1 → 2 atoms; Story 2 → bundle[c,d] + [e] = 2; Story 3 untouched = 1.
  assert.equal(diagnostics.outputCount, 5);
  assert.equal(stories.length, 5);
  // A3 bundling: exactly one emitted story is a multi-source bundle ([c,d]).
  assert.equal(diagnostics.bundledStoryCount, 1);
  const bundle = stories.find((s) => s.source_item_ids.length === 2 && s.source_item_ids.includes("c"));
  assert.ok(bundle, "the [c,d] bundle must be one emitted story, not two atoms");
  assert.deepEqual(bundle.source_item_ids, ["c", "d"]);
});

test("A1: split story title/subtitle/summary derive from normalized English evidence", () => {
  // Two Spanish items that were translated upstream: originals stay Spanish,
  // normalized* carry the English evidence. The split path must emit English.
  const a = {
    ...item("a", "Colombia: precios del café suben", ["Los caficultores esperan mejores cosechas."]),
    lang: "es",
    normalizedHeadline: "Colombia coffee prices rise",
    normalizedBody: ["Growers expect better harvests."],
    _translation: { needed: true, applied: true, failed: false, fromCache: false, reason: null, lang: "es" },
  };
  const b = {
    ...item("b", "Alerta por erupción de volcán en Colombia", ["Temblores sísmicos motivan evacuaciones."]),
    lang: "es",
    normalizedHeadline: "Colombia volcano eruption warning",
    normalizedBody: ["Seismic tremors prompt evacuations."],
    _translation: { needed: true, applied: true, failed: false, fromCache: false, reason: null, lang: "es" },
  };
  const story = metaStory({ source_item_ids: ["a", "b"] });

  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(a, b), SETTINGS, ON);

  assert.equal(stories.length, 2);
  assert.equal(diagnostics.splitCount, 1);
  // Titles use the normalized English headline, not the Spanish original.
  assert.equal(stories[0].title, "Colombia coffee prices rise");
  assert.equal(stories[1].title, "Colombia volcano eruption warning");
  // Subtitle/summary/factual_claims all flow from the normalized evidence.
  assert.equal(stories[0].subtitle, "Growers expect better harvests.");
  assert.equal(stories[0].summary, "Colombia coffee prices rise. Growers expect better harvests.");
  assert.deepEqual(stories[0].factual_claims, ["Colombia coffee prices rise"]);
});

test("A1: with no normalization, split story falls back to original headline/body", () => {
  // No normalized* fields present → readers return the originals unchanged.
  const a = item("a", "Colombia coffee harvest forecast", ["Coffee yields expected to rise."]);
  const b = item("b", "Colombia volcano eruption warning", ["Seismic tremors prompt evacuation alerts."]);
  const story = metaStory({ source_item_ids: ["a", "b"] });

  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(a, b), SETTINGS, ON);

  assert.equal(stories.length, 2);
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(stories[0].title, a.headline);
  assert.equal(stories[1].title, b.headline);
  assert.equal(stories[0].subtitle, "Coffee yields expected to rise.");
  assert.equal(stories[0].summary, "Colombia coffee harvest forecast. Coffee yields expected to rise.");
  assert.deepEqual(stories[0].factual_claims, [a.headline]);
});

// ─── A3: tightened triggers, ambiguous-defer, and bundling ───────────────────

// A non-English (untranslated) item: original Spanish text, no normalized*.
function esItem(sourceId, headline, body = []) {
  return { ...item(sourceId, headline, body), lang: "es" };
}
// A successfully-translated ES item: Spanish originals + normalized English.
function translatedItem(sourceId, esHeadline, esBody, enHeadline, enBody) {
  return {
    ...item(sourceId, esHeadline, esBody),
    lang: "es",
    normalizedHeadline: enHeadline,
    normalizedBody: enBody,
    _translation: { needed: true, applied: true, failed: false, fromCache: false, reason: null, lang: "es" },
  };
}
// Attach a stable meta_story_id (needed to assert reclusterCandidateIds).
function withId(metaStoryObj, id) {
  return { ...metaStoryObj, meta_story_id: id };
}

test("A3: disjoint_claim_evidence still splits (high-confidence trigger, English bundling)", () => {
  // Three English sources under a disjoint single-source claim map: two cover
  // the same protest (overlap), one is an unrelated earthquake. low_token_overlap
  // does NOT fire (the protest pair overlaps), so the disjoint claim map drives
  // the split; A3 bundling keeps the two protest sources together → 2 stories.
  const a = item("a", "Colombia tax reform protest grips capital", ["Tax reform protest spreads downtown."]);
  const b = item("b", "Colombia tax reform protest grips the capital again", ["Tax reform protest spreads downtown today."]);
  const c = item("c", "Colombia earthquake damages coastal bridge", ["A strong quake severed a key coastal bridge."]);
  const story = metaStory({
    source_item_ids: ["a", "b", "c"],
    factual_claims: ["claim a", "claim b", "claim c"],
    claim_evidence_map: { "0": ["a"], "1": ["b"], "2": ["c"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(a, b, c), SETTINGS, ON);

  assert.equal(stories.length, 2);
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(diagnostics.splitReasons.disjoint_claim_evidence, 1);
  assert.equal(diagnostics.bundledStoryCount, 1);
  assert.equal(diagnostics.deferredCount, 0);
  const bundle = stories.find((s) => s.source_item_ids.length > 1);
  assert.deepEqual(bundle.source_item_ids, ["a", "b"]);
});

test("A3: low_token_overlap splits when computed from NORMALIZED ENGLISH evidence", () => {
  // Two translated ES items whose ENGLISH evidence is genuinely unrelated.
  // The overlap is scored on normalized English (not raw Spanish), so the
  // low-overlap split fires and the reason is low_token_overlap.
  const a = translatedItem(
    "a",
    "Colombia: precios del café suben",
    ["Los caficultores esperan mejores cosechas."],
    "Colombia coffee prices climb",
    ["Growers expect better harvests."]
  );
  const b = translatedItem(
    "b",
    "Alerta por erupción de volcán en Colombia",
    ["Temblores sísmicos motivan evacuaciones."],
    "Colombia volcano eruption warning",
    ["Seismic tremors prompt evacuations."]
  );
  // Non-disjoint, non-corroborated claim map so ONLY the low-overlap path can act.
  const story = metaStory({
    source_item_ids: ["a", "b"],
    factual_claims: ["claim a"],
    claim_evidence_map: { "0": ["a"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(a, b), SETTINGS, ON);

  assert.equal(stories.length, 2);
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(diagnostics.splitReasons.low_token_overlap, 1);
  // Titles are the normalized English headlines.
  assert.equal(stories[0].title, "Colombia coffee prices climb");
  assert.equal(stories[1].title, "Colombia volcano eruption warning");
});

test("A3: ambiguous defer — low overlap on UN-normalized non-English text is NOT split", () => {
  // Two Spanish items, NOT translated (no normalized*), unrelated topics, and a
  // claim map that is neither disjoint nor corroborated. The raw-text overlap is
  // low, but we cannot trust it (cross-language) — so the cluster is preserved
  // and flagged for the Phase-2 deferred re-cluster, never atomized in Phase 1.
  const a = esItem("a", "Colombia: cosecha de café en alza", ["Los rendimientos del café aumentan."]);
  const b = esItem("b", "Alerta de erupción volcánica en Colombia", ["Temblores sísmicos provocan evacuaciones."]);
  const story = withId(
    metaStory({
      source_item_ids: ["a", "b"],
      factual_claims: ["claim a"],
      claim_evidence_map: { "0": ["a"] },
    }),
    "ms-ambiguous"
  );

  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(a, b), SETTINGS, ON);

  assert.equal(stories.length, 1, "ambiguous un-normalized cluster must not split");
  assert.equal(diagnostics.splitCount, 0);
  assert.equal(diagnostics.deferredCount, 1);
  assert.equal(diagnostics.deferReasons.ambiguous_unnormalized_overlap, 1);
  assert.equal(stories[0]._reclusterCandidate, true);
  assert.equal(stories[0]._reclusterReason, "ambiguous_unnormalized_overlap");
  assert.deepEqual(diagnostics.reclusterCandidateIds, ["ms-ambiguous"]);
  // The original source set is preserved (not atomized).
  assert.deepEqual(stories[0].source_item_ids, ["a", "b"]);
});

test("A3: ambiguous defer — disjoint claim map but text reunifies (overlap conflict)", () => {
  // Near-duplicate English articles under a disjoint single-source claim map.
  // The claim map says "independent" but the text bundles into one component —
  // conflicting signals → defer, do NOT atomize into 2.
  const c = item("c", "Colombia tax reform protest grips capital", ["Tax reform protest spreads downtown."]);
  const d = item("d", "Colombia tax reform protest grips the capital again", ["Tax reform protest spreads downtown today."]);
  const story = withId(
    metaStory({
      source_item_ids: ["c", "d"],
      factual_claims: ["claim c", "claim d"],
      claim_evidence_map: { "0": ["c"], "1": ["d"] },
    }),
    "ms-conflict"
  );

  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(c, d), SETTINGS, ON);

  assert.equal(stories.length, 1, "conflicting-signal cluster must not atomize");
  assert.equal(diagnostics.splitCount, 0);
  assert.equal(diagnostics.deferredCount, 1);
  assert.equal(diagnostics.deferReasons.ambiguous_overlap_conflict, 1);
  assert.equal(stories[0]._reclusterCandidate, true);
  assert.equal(stories[0]._reclusterReason, "ambiguous_overlap_conflict");
  assert.deepEqual(diagnostics.reclusterCandidateIds, ["ms-conflict"]);
});

test("A3: disjoint split is language-independent (non-English still splits, no defer)", () => {
  // Disjoint claim map is structural (ID-based), so it splits even for
  // un-normalized non-English evidence — bundling falls back to raw overlap.
  const a = esItem("a", "Colombia: cosecha de café en alza", ["Los rendimientos del café aumentan."]);
  const b = esItem("b", "Alerta de erupción volcánica en Colombia", ["Temblores sísmicos provocan evacuaciones."]);
  const story = metaStory({
    source_item_ids: ["a", "b"],
    factual_claims: ["claim a", "claim b"],
    claim_evidence_map: { "0": ["a"], "1": ["b"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(a, b), SETTINGS, ON);

  assert.equal(stories.length, 2);
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(diagnostics.splitReasons.disjoint_claim_evidence, 1);
  assert.equal(diagnostics.deferredCount, 0);
});

test("A3: diagnostics shape is additive — Slice 2 fields preserved alongside new fields", () => {
  const a = item("a", "Colombia coffee harvest forecast", ["Coffee yields rise."]);
  const b = item("b", "Colombia volcano eruption warning", ["Seismic tremors prompt evacuation."]);
  const story = metaStory({ source_item_ids: ["a", "b"] });

  const { diagnostics } = splitOverMergedClusters([story], mapOf(a, b), SETTINGS, ON);

  // Existing Slice 2 shape (what the pipeline tests rely on) is unchanged.
  assert.equal(typeof diagnostics.enabled, "boolean");
  assert.equal(typeof diagnostics.inputCount, "number");
  assert.equal(typeof diagnostics.outputCount, "number");
  assert.equal(typeof diagnostics.splitCount, "number");
  assert.deepEqual(Object.keys(diagnostics.splitReasons).sort(), [
    "disjoint_claim_evidence",
    "low_token_overlap",
  ]);
  // A3 additive fields present.
  assert.equal(typeof diagnostics.deferredCount, "number");
  assert.equal(typeof diagnostics.bundledStoryCount, "number");
  assert.ok(Array.isArray(diagnostics.reclusterCandidateIds));
  assert.deepEqual(Object.keys(diagnostics.deferReasons).sort(), [
    "ambiguous_overlap_conflict",
    "ambiguous_unnormalized_overlap",
  ]);
});

test("A3 hardening: a missing source-item lookup carries NO English evidence (no low-overlap split)", () => {
  // One valid English item + one source_item_id that is absent from the lookup
  // (getItem → undefined). The claim map is non-disjoint / non-corroborated, so
  // the ONLY split path available is low_token_overlap — which requires every
  // source to carry usable English evidence. The missing lookup must NOT count
  // as English (the bug: `!isNonEnglishItem(undefined)` read as truthy), so the
  // all-English gate fails and the cluster is NOT atomized by low-overlap; it
  // follows the ambiguous-defer path instead.
  const a = item("a", "Colombia coffee harvest forecast", ["Coffee yields expected to rise."]);
  const story = withId(
    metaStory({
      source_item_ids: ["a", "missing-id"],
      factual_claims: ["claim a"],
      claim_evidence_map: { "0": ["a"] },
    }),
    "ms-missing"
  );

  // Note: `mapOf(a)` deliberately omits "missing-id" → getItem("missing-id") is undefined.
  const { stories, diagnostics } = splitOverMergedClusters([story], mapOf(a), SETTINGS, ON);

  assert.equal(stories.length, 1, "missing-lookup cluster must not be split by low-overlap");
  assert.equal(diagnostics.splitCount, 0);
  assert.equal(diagnostics.splitReasons.low_token_overlap, 0);
  // Falls through to the defer path (not all-English) rather than atomizing.
  assert.equal(diagnostics.deferredCount, 1);
  assert.equal(diagnostics.deferReasons.ambiguous_unnormalized_overlap, 1);
  assert.deepEqual(diagnostics.reclusterCandidateIds, ["ms-missing"]);
});

test("resolveClusterSplitConfig honors env defaults and overrides", () => {
  const def = resolveClusterSplitConfig({});
  assert.equal(def.enabled, true);
  assert.equal(def.jaccardThreshold, 0.15);

  const off = resolveClusterSplitConfig({ TEMPO_CLUSTER_SPLIT_HEALER_ENABLED: "false" });
  assert.equal(off.enabled, false);

  const tuned = resolveClusterSplitConfig({ TEMPO_CLUSTER_SPLIT_JACCARD_THRESHOLD: "0.4" });
  assert.equal(tuned.jaccardThreshold, 0.4);

  const ov = resolveClusterSplitConfig({}, { enabled: false, jaccardThreshold: 0.25 });
  assert.equal(ov.enabled, false);
  assert.equal(ov.jaccardThreshold, 0.25);

  // Malformed threshold falls back to default.
  assert.equal(
    resolveClusterSplitConfig({ TEMPO_CLUSTER_SPLIT_JACCARD_THRESHOLD: "abc" }).jaccardThreshold,
    0.15
  );
});
