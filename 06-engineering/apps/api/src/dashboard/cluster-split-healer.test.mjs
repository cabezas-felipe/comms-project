// Unit tests for the post-cluster split healer (Slice 1). Pure module — no
// pipeline wiring, no network. These pin the narrow split policy: low
// token-overlap splits (geography stripped so a shared country can't mask it),
// disjoint single-source claim_evidence_map splits, and the passthrough paths.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveClusterSplitConfig,
  splitOverMergedClusters,
  mergeElectionEventBundles,
  resolveElectionBundleConfig,
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

// ─── Q3B: election-cycle theme bundling ──────────────────────────────────────

test("Q3B: same-cycle election pieces bundle while an unrelated event splits out", () => {
  // Three sources over-merged under a disjoint single-source claim map:
  //  - two SAME-CYCLE election pieces with LOW literal overlap (they share only
  //    the election-cycle tokens "presidential"/"election", everything else is
  //    distinct), and
  //  - one unrelated mine attack (no election token at all).
  // Without theme bundling this atomizes into THREE singles. With Q3B the two
  // election pieces bundle into ONE story (shared election-cycle signal) and the
  // mine attack still splits out → 2 stories, one of them a 2-source bundle.
  const electA = item("ea", "Colombia presidential election poll shows a tight national margin", [
    "Analysts weigh shifting sentiment among undecided districts.",
  ]);
  const electB = item("eb", "Colombia presidential election debate centers on tax reform", [
    "Moderators pressed contenders over foreign policy questions.",
  ]);
  const mineC = item("mc", "Armed group attacks Colombia gold mine, killing several workers", [
    "Authorities blame an illegal armed faction for the deadly assault.",
  ]);
  const story = metaStory({
    source_item_ids: ["ea", "eb", "mc"],
    factual_claims: ["claim ea", "claim eb", "claim mc"],
    claim_evidence_map: { "0": ["ea"], "1": ["eb"], "2": ["mc"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(electA, electB, mineC),
    SETTINGS,
    ON
  );

  // Two stories, not three: the election cycle is bundled, the mine split out.
  assert.equal(stories.length, 2, "election pieces must bundle, not atomize");
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(diagnostics.bundledStoryCount, 1, "exactly one multi-source bundle emitted");
  assert.equal(diagnostics.deferredCount, 0);

  const bundle = stories.find((s) => s.source_item_ids.length > 1);
  const single = stories.find((s) => s.source_item_ids.length === 1);
  assert.ok(bundle, "the election cycle must surface as one bundled story");
  assert.deepEqual(bundle.source_item_ids.slice().sort(), ["ea", "eb"], "both election pieces in the bundle");
  assert.deepEqual(single.source_item_ids, ["mc"], "the unrelated mine attack splits out alone");
});

test("Q3B: multi-item same-cycle election coverage is not atomized into singles", () => {
  // Three low-overlap presidential-election pieces (share only the election-cycle
  // tokens). They reunify into a single election component, so they are NOT
  // atomized into three single-source rows — the cluster stays one meta-story
  // (kept intact and flagged for deferred re-cluster, the existing conflict path
  // for a one-component reunification).
  const a = item("ea", "Colombia presidential election poll shows a tight national margin", [
    "Analysts weigh shifting sentiment among undecided districts.",
  ]);
  const b = item("eb", "Colombia presidential election debate centers on tax reform", [
    "Moderators pressed contenders over foreign policy questions.",
  ]);
  const c = item("ec", "Colombia presidential election ballot logistics finalized today", [
    "Officials prepared thousands of voting stations nationwide.",
  ]);
  const story = withId(
    metaStory({
      source_item_ids: ["ea", "eb", "ec"],
      factual_claims: ["claim ea", "claim eb", "claim ec"],
      claim_evidence_map: { "0": ["ea"], "1": ["eb"], "2": ["ec"] },
    }),
    "ms-election-cycle"
  );

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(a, b, c),
    SETTINGS,
    ON
  );

  assert.equal(stories.length, 1, "same-cycle election coverage must not atomize into singles");
  assert.equal(diagnostics.splitCount, 0);
  assert.equal(diagnostics.deferredCount, 1);
  assert.equal(diagnostics.deferReasons.ambiguous_overlap_conflict, 1);
  assert.deepEqual(stories[0].source_item_ids, ["ea", "eb", "ec"], "the one story owns all three election pieces");
});

test("Q3B: unrelated same-country events still split (no false theme edge)", () => {
  // Regression guard for the existing contract: an election piece and a mine
  // attack share only the country (stripped) and NO election-cycle token on the
  // mine side, so the theme edge must NOT fire — they still split into two.
  const elect = item("e1", "Colombia presidential election race tightens before the vote", [
    "Candidates crisscross the country ahead of the ballot.",
  ]);
  const mine = item("m1", "Armed group attacks Colombia gold mine, killing several workers", [
    "Authorities blame an illegal armed faction for the deadly assault.",
  ]);
  const story = metaStory({ source_item_ids: ["e1", "m1"] });

  const { stories, diagnostics } = splitOverMergedClusters(
    [story],
    mapOf(elect, mine),
    SETTINGS,
    ON
  );

  assert.equal(stories.length, 2, "unrelated events still split");
  assert.equal(diagnostics.splitCount, 1);
  assert.equal(diagnostics.bundledStoryCount, 0, "no bundle — the events are unrelated");
  assert.deepEqual(stories.map((s) => s.source_item_ids), [["e1"], ["m1"]]);
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

// ─── Phase 4.1: election same-event cross-cluster bundle merge ─────────────────

const BUNDLE_ON = { enabled: true, jaccardThreshold: 0.5 };

// A clustered election meta-story (one source per claim), shaped like the
// SEPARATE rows clustering emits when it fragments same-event coverage.
function electionStory(id, sourceIds) {
  return withId(
    metaStory({
      source_item_ids: sourceIds,
      tags: { topics: ["Elections"], keywords: ["election"], geographies: ["Colombia"] },
    }),
    id
  );
}

test("Phase 4.1 POSITIVE: same-event election coverage fragmented across clusters bundles into one", () => {
  // Two SEPARATE meta-stories about the SAME event (the presidential debate on
  // tax reform), as two wires would land them: high specific overlap once geo +
  // generic election tokens are stripped ({tax, reform, debate-specifics}).
  const a = item("d-en", "Colombia presidential debate: Petro and Gutierrez clash over tax reform", [
    "The two contenders sparred over the proposed tax reform plan.",
  ]);
  const b = item("d-es", "Petro, Gutierrez spar on tax reform in Colombia presidential debate", [
    "Tax reform dominated the sharpest exchanges between the candidates.",
  ]);
  const storyA = electionStory("ms-debate-a", ["d-en"]);
  const storyB = electionStory("ms-debate-b", ["d-es"]);

  const { stories, diagnostics } = mergeElectionEventBundles(
    [storyA, storyB],
    mapOf(a, b),
    SETTINGS,
    BUNDLE_ON
  );

  assert.equal(stories.length, 1, "the two same-event rows must bundle into one");
  assert.equal(diagnostics.mergedGroupCount, 1);
  assert.equal(diagnostics.mergedStoryCount, 2);
  assert.deepEqual(stories[0].source_item_ids.slice().sort(), ["d-en", "d-es"]);
  // Merged story stays grounded: every claim cites only merged sources.
  for (const ids of Object.values(stories[0].claim_evidence_map)) {
    for (const id of ids) assert.ok(["d-en", "d-es"].includes(id));
  }
});

test("Phase 4.1 NEGATIVE (facets): different facets of the same cycle stay separate", () => {
  // Same cycle, DIFFERENT events — they share only generic election vocabulary
  // (stripped), so specific overlap is low and they must NOT merge.
  const debate = item("f-debate", "Colombia presidential debate centers on tax reform", [
    "Candidates clashed over the proposed tax reform.",
  ]);
  const turnout = item("f-turnout", "Colombia election turnout expected to break records", [
    "Analysts watch participation across rural districts closely.",
  ]);
  const storyA = electionStory("ms-debate", ["f-debate"]);
  const storyB = electionStory("ms-turnout", ["f-turnout"]);

  const { stories, diagnostics } = mergeElectionEventBundles(
    [storyA, storyB],
    mapOf(debate, turnout),
    SETTINGS,
    BUNDLE_ON
  );

  assert.equal(stories.length, 2, "different facets of one cycle must not merge");
  assert.equal(diagnostics.mergedGroupCount, 0);
});

test("Phase 4.1 NEGATIVE (wrong-beat): a non-election story is never merged", () => {
  // Even with high token overlap, a non-election story is ineligible (no election
  // token). Guards against wrong-beat over-merge.
  const electN = item("e-n", "Colombia presidential election ballot rules updated for tax filings", [
    "The electoral authority revised ballot guidance on tax matters.",
  ]);
  const mineN = item("m-n", "Colombia tax authority updates corporate filing rules", [
    "The tax agency revised guidance on corporate tax filings.",
  ]);
  const storyA = electionStory("ms-elec", ["e-n"]);
  const storyB = withId(
    metaStory({ source_item_ids: ["m-n"], tags: { topics: ["Business"], keywords: [], geographies: ["Colombia"] } }),
    "ms-tax"
  );

  const { stories, diagnostics } = mergeElectionEventBundles(
    [storyA, storyB],
    mapOf(electN, mineN),
    SETTINGS,
    BUNDLE_ON
  );

  assert.equal(stories.length, 2, "non-election story is ineligible — no merge");
  assert.equal(diagnostics.mergedGroupCount, 0);
});

test("Phase 4.1 NEGATIVE (wrong-geo): a cross-country election is never merged into the configured-geo bundle", () => {
  // Two election stories with high specific overlap, but one names Colombia and
  // the other names Peru (no configured-geo token) → the cross-country one is
  // ineligible, so they stay separate (wrong-geo protection).
  const colombia = item("c-elec", "Colombia presidential debate centers on tax reform showdown", [
    "Candidates clashed over the tax reform showdown.",
  ]);
  const peru = item("p-elec", "Peru presidential debate centers on tax reform showdown", [
    "Contenders clashed over the tax reform showdown.",
  ], );
  // Peru item must NOT carry a Colombia geography signal.
  peru.geographies = ["Peru"];
  const storyA = electionStory("ms-co", ["c-elec"]);
  const storyB = withId(
    metaStory({ source_item_ids: ["p-elec"], tags: { topics: ["Elections"], keywords: ["election"], geographies: ["Peru"] } }),
    "ms-pe"
  );

  const { stories, diagnostics } = mergeElectionEventBundles(
    [storyA, storyB],
    mapOf(colombia, peru),
    SETTINGS,
    BUNDLE_ON
  );

  assert.equal(stories.length, 2, "cross-country election must not merge with configured-geo");
  assert.equal(diagnostics.mergedGroupCount, 0);
});

test("Phase 4.1 STABILITY: merge is deterministic and order-independent", () => {
  const a = item("s-a", "Colombia presidential debate: Petro and Gutierrez clash over tax reform", [
    "The two contenders sparred over the proposed tax reform plan.",
  ]);
  const b = item("s-b", "Petro, Gutierrez spar on tax reform in Colombia presidential debate", [
    "Tax reform dominated the sharpest exchanges between the candidates.",
  ]);
  const c = item("s-c", "Colombia election turnout expected to break records this cycle", [
    "Analysts watch participation across rural districts closely.",
  ]);
  const sA = electionStory("ms-a", ["s-a"]);
  const sB = electionStory("ms-b", ["s-b"]);
  const sC = electionStory("ms-c", ["s-c"]);

  const r1 = mergeElectionEventBundles([sA, sB, sC], mapOf(a, b, c), SETTINGS, BUNDLE_ON);
  const r2 = mergeElectionEventBundles([sB, sA, sC], mapOf(a, b, c), SETTINGS, BUNDLE_ON);

  // a+b bundle (same event), c stays alone → 2 stories both runs.
  assert.equal(r1.stories.length, 2);
  assert.equal(r2.stories.length, 2);
  const bundle1 = r1.stories.find((s) => s.source_item_ids.length === 2);
  const bundle2 = r2.stories.find((s) => s.source_item_ids.length === 2);
  // Same merged id and same source membership regardless of input order.
  assert.equal(bundle1.meta_story_id, bundle2.meta_story_id, "merged id is order-independent");
  assert.deepEqual(bundle1.source_item_ids.slice().sort(), ["s-a", "s-b"]);
  assert.deepEqual(bundle2.source_item_ids.slice().sort(), ["s-a", "s-b"]);
});

test("Phase 4.1: _reclusterCandidate stories pass through untouched (never merged)", () => {
  const a = item("r-a", "Colombia presidential debate centers on tax reform", ["Tax reform clash."]);
  const b = item("r-b", "Colombia presidential debate dominated by tax reform", ["Tax reform fight."]);
  const sA = { ...electionStory("ms-ra", ["r-a"]), _reclusterCandidate: true, _reclusterReason: "ambiguous_overlap_conflict" };
  const sB = electionStory("ms-rb", ["r-b"]);

  const { stories, diagnostics } = mergeElectionEventBundles([sA, sB], mapOf(a, b), SETTINGS, BUNDLE_ON);
  assert.equal(stories.length, 2, "a deferred candidate is never merged");
  assert.equal(diagnostics.mergedGroupCount, 0);
  assert.equal(stories[0]._reclusterCandidate, true, "flag preserved");
});

test("Phase 4.1: disabled config is a passthrough", () => {
  const a = item("x-a", "Colombia presidential debate centers on tax reform", ["Tax reform clash."]);
  const b = item("x-b", "Colombia presidential debate dominated by tax reform", ["Tax reform fight."]);
  const { stories, diagnostics } = mergeElectionEventBundles(
    [electionStory("ms-xa", ["x-a"]), electionStory("ms-xb", ["x-b"])],
    mapOf(a, b),
    SETTINGS,
    { enabled: false }
  );
  assert.equal(diagnostics.enabled, false);
  assert.equal(stories.length, 2);
  assert.equal(diagnostics.mergedGroupCount, 0);
});

test("resolveElectionBundleConfig honors env defaults and overrides", () => {
  const def = resolveElectionBundleConfig({});
  assert.equal(def.enabled, true);
  assert.equal(def.jaccardThreshold, 0.34);

  assert.equal(resolveElectionBundleConfig({ TEMPO_ELECTION_BUNDLE_ENABLED: "off" }).enabled, false);
  assert.equal(
    resolveElectionBundleConfig({ TEMPO_ELECTION_BUNDLE_JACCARD_THRESHOLD: "0.7" }).jaccardThreshold,
    0.7
  );
  const ov = resolveElectionBundleConfig({}, { enabled: false, jaccardThreshold: 0.6 });
  assert.equal(ov.enabled, false);
  assert.equal(ov.jaccardThreshold, 0.6);
  // Malformed threshold → default.
  assert.equal(
    resolveElectionBundleConfig({ TEMPO_ELECTION_BUNDLE_JACCARD_THRESHOLD: "xyz" }).jaccardThreshold,
    0.34
  );
});
