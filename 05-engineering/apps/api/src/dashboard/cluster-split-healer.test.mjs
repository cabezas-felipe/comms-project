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
  // Story 1: low overlap → low_token_overlap.
  const a = item("a", "Colombia coffee harvest forecast", ["Coffee yields rise."]);
  const b = item("b", "Colombia volcano eruption warning", ["Seismic tremors prompt evacuation."]);
  const lowOverlap = metaStory({ source_item_ids: ["a", "b"] });

  // Story 2: high overlap (so low_token_overlap does NOT fire) but disjoint
  // single-source claim evidence → disjoint_claim_evidence.
  const c = item("c", "Colombia tax reform protest grips capital", ["Tax reform protest spreads downtown."]);
  const d = item("d", "Colombia tax reform protest grips capital again", ["Tax reform protest spreads downtown today."]);
  const disjoint = metaStory({
    source_item_ids: ["c", "d"],
    factual_claims: ["claim c", "claim d"],
    claim_evidence_map: { "0": ["c"], "1": ["d"] },
  });

  // Story 3: high overlap + corroborated evidence → no split.
  const noSplit = metaStory({
    source_item_ids: ["c", "d"],
    factual_claims: ["shared claim"],
    claim_evidence_map: { "0": ["c", "d"] },
  });

  const { stories, diagnostics } = splitOverMergedClusters(
    [lowOverlap, disjoint, noSplit],
    mapOf(a, b, c, d),
    SETTINGS,
    ON
  );

  assert.equal(diagnostics.inputCount, 3);
  assert.equal(diagnostics.splitCount, 2);
  assert.equal(diagnostics.splitReasons.low_token_overlap, 1);
  assert.equal(diagnostics.splitReasons.disjoint_claim_evidence, 1);
  // 2 split stories → 2 each + 1 untouched = 5.
  assert.equal(diagnostics.outputCount, 5);
  assert.equal(stories.length, 5);
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
