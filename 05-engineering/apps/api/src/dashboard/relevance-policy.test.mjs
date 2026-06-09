// Unit tests for the relevance policy module (node:test). Pure + hermetic — no
// network, no provider keys. Pins the two invariants the pipeline relies on:
//   1. The recall-widen regex stays English-only (the translation boundary), so
//      an untranslated Spanish item cannot bypass the translation gate.
//   2. `scoreGeoFit` hard-fails ONLY on an unambiguous explicit geo conflict.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RELEVANCE_LEXICON,
  lexiconClusterFor,
  buildKeywordMatchRegex,
  scoreKeywordFit,
  scoreTopicFit,
  topicMatchesSettings,
  expandTopicLabels,
  scoreGeoFit,
} from "./relevance-policy.mjs";

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    headline: "",
    body: ["Placeholder body."],
    geographies: [],
    url: "https://example.com",
    ...overrides,
  };
}

// ── Lexicon shape ─────────────────────────────────────────────────────────────

test("lexicon clusters are discrete: election does not pull in candidate/campaign", () => {
  const election = lexiconClusterFor("election");
  assert.ok(election, "election resolves to a cluster");
  assert.ok(!election.en.includes("candidate"), "election cluster must not include candidate");
  assert.ok(!election.en.includes("campaign"), "election cluster must not include campaign");
  // candidate / campaign are their OWN clusters.
  assert.equal(lexiconClusterFor("candidate")?.key, "candidate");
  assert.equal(lexiconClusterFor("campaign")?.key, "campaign");
});

test("lexiconClusterFor resolves via key, English form, and Spanish form", () => {
  assert.equal(lexiconClusterFor("elections")?.key, "election");
  assert.equal(lexiconClusterFor("elecciones")?.key, "election");
  assert.equal(lexiconClusterFor("segunda vuelta")?.key, "runoff");
  assert.equal(lexiconClusterFor("not-a-term"), null);
  assert.equal(lexiconClusterFor(""), null);
});

test("RELEVANCE_LEXICON is frozen and well-formed", () => {
  assert.ok(Object.isFrozen(RELEVANCE_LEXICON));
  for (const c of RELEVANCE_LEXICON) {
    assert.ok(typeof c.key === "string" && c.key.length > 0);
    assert.ok(Array.isArray(c.en) && c.en.length > 0);
    assert.ok(Array.isArray(c.es));
  }
});

// ── buildKeywordMatchRegex: morphological widen, English-only ─────────────────

test("buildKeywordMatchRegex widens to English morphological variants", () => {
  const re = buildKeywordMatchRegex({ keywords: ["election"] });
  assert.ok(re.test("the election was close"));
  assert.ok(re.test("regional elections approach"), "plural variant matches");
  // A non-homograph cluster widens its derived English forms too.
  const mig = buildKeywordMatchRegex({ keywords: ["migration"] });
  assert.ok(mig.test("a migrant caravan"), "derived variant matches");
  assert.ok(mig.test("immigration debate"), "derived variant matches");
});

test("buildKeywordMatchRegex does NOT include Spanish forms (translation boundary)", () => {
  const re = buildKeywordMatchRegex({ keywords: ["election"] });
  // The Spanish surface form must not match — recall reads normalized English,
  // and admitting "elecciones" here would bypass the translation gate.
  assert.ok(!re.test("las elecciones regionales se acercan"));
  assert.ok(!re.test("la migración crece"));
});

test("buildKeywordMatchRegex excludes EN↔ES homographs from the recall regex", () => {
  // "electoral" is spelled identically in English and Spanish; including it would
  // let an untranslated Spanish item ("sondeo electoral") bypass translation.
  const re = buildKeywordMatchRegex({ keywords: ["election"] });
  assert.ok(!re.test("un nuevo sondeo electoral"));
  // But the scoring path (language-agnostic) still credits the homograph.
  assert.equal(scoreKeywordFit("un nuevo sondeo electoral", { keywords: ["election"] }).score, 1);
});

test("buildKeywordMatchRegex keeps exact behavior for non-lexicon keywords", () => {
  const re = buildKeywordMatchRegex({ keywords: ["Ebola"] });
  assert.ok(re.test("a new Ebola outbreak"));
  assert.ok(!re.test("ebolavirus"), "whole-word boundary preserved (no substring match)");
});

test("buildKeywordMatchRegex returns null when no usable keyword", () => {
  assert.equal(buildKeywordMatchRegex({ keywords: [] }), null);
  assert.equal(buildKeywordMatchRegex({ keywords: ["   "] }), null);
  assert.equal(buildKeywordMatchRegex({}), null);
});

test("election keyword regex does not match candidate/campaign text", () => {
  // Guards the dual-beat geo-only recall signal: an item that only mentions
  // candidates/campaign (no election token) must NOT match the election keyword.
  const re = buildKeywordMatchRegex({ keywords: ["election", "elections", "ballot"] });
  assert.ok(!re.test("candidates make a final push during the campaign"));
});

// ── scoreKeywordFit: language-agnostic scoring (Spanish forms in scope) ───────

test("scoreKeywordFit hits English and Spanish surface forms", () => {
  const settings = { keywords: ["election"] };
  assert.equal(scoreKeywordFit("the election results", settings).score, 1);
  assert.equal(scoreKeywordFit("las elecciones de mañana", settings).score, 1);
  assert.equal(scoreKeywordFit("unrelated text", settings).score, 0);
});

test("scoreKeywordFit returns the matched fraction over configured keywords", () => {
  const settings = { keywords: ["election", "Ebola", "security"] };
  const r = scoreKeywordFit("the election and security situation", settings);
  assert.equal(r.hits, 2);
  assert.ok(Math.abs(r.score - 2 / 3) < 1e-9);
  assert.deepEqual(r.matched.sort(), ["election", "security"]);
});

test("scoreKeywordFit: segunda vuelta widens the runoff keyword", () => {
  const r = scoreKeywordFit("se define en la segunda vuelta", { keywords: ["runoff"] });
  assert.equal(r.score, 1);
});

test("scoreKeywordFit handles empty settings", () => {
  assert.deepEqual(scoreKeywordFit("anything", { keywords: [] }), { score: 0, matched: [], hits: 0 });
});

// ── topic fit ─────────────────────────────────────────────────────────────────

test("topicMatchesSettings matches exact canonical and lexicon siblings", () => {
  const settings = { topics: ["Elections"] };
  assert.ok(topicMatchesSettings("Elections", settings), "exact label");
  assert.ok(topicMatchesSettings("election", settings), "lexicon sibling (case-insensitive)");
  assert.ok(!topicMatchesSettings("Markets", settings), "unrelated topic does not match");
  assert.ok(!topicMatchesSettings("Elections", { topics: [] }), "no topics → no match");
});

test("expandTopicLabels includes EN + ES sibling forms", () => {
  const set = expandTopicLabels({ topics: ["Elections"] });
  assert.ok(set.has("elections"));
  assert.ok(set.has("electoral"));
  assert.ok(set.has("elecciones"));
});

test("scoreTopicFit scores text against configured topics", () => {
  const settings = { topics: ["Elections", "Security"] };
  const r = scoreTopicFit("coverage of the elections", settings);
  assert.equal(r.hits, 1);
  assert.ok(Math.abs(r.score - 0.5) < 1e-9);
});

// ── scoreGeoFit ───────────────────────────────────────────────────────────────

const GEO_SETTINGS = { geographies: ["Colombia"] };

test("scoreGeoFit: no configured geographies is never a hard-fail", () => {
  const r = scoreGeoFit(makeItem({ geographies: ["Venezuela"] }), { geographies: [] });
  assert.equal(r.hardFail, false);
  assert.equal(r.category, "no_configured_geo");
});

test("scoreGeoFit: explicit field overlap scores 1.0, no hard-fail", () => {
  const r = scoreGeoFit(makeItem({ geographies: ["Colombia"] }), GEO_SETTINGS);
  assert.equal(r.hardFail, false);
  assert.equal(r.score, 1);
  assert.equal(r.reason, "explicit_match");
});

test("scoreGeoFit: explicit conflict with no textual evidence hard-fails", () => {
  const r = scoreGeoFit(
    makeItem({ geographies: ["Venezuela"], headline: "Caracas update", body: ["A Venezuela story."] }),
    GEO_SETTINGS
  );
  assert.equal(r.hardFail, true);
  assert.equal(r.score, 0);
  assert.equal(r.reason, "explicit_conflict");
});

test("scoreGeoFit: conflict tag but configured geo named in text does NOT hard-fail", () => {
  const r = scoreGeoFit(
    makeItem({ geographies: ["Venezuela"], headline: "Border tensions", body: ["Colombia weighs in."] }),
    GEO_SETTINGS
  );
  assert.equal(r.hardFail, false);
  assert.equal(r.reason, "geo_text_match:Colombia");
});

test("scoreGeoFit: demonym mention gives partial credit and blocks hard-fail", () => {
  // "Kenyan" does not match the \bKenya\b token boundary (per the dual-beat
  // fixture note), so the lexical path misses and the demonym path is exercised.
  const r = scoreGeoFit(
    makeItem({ geographies: ["Uganda"], headline: "Kenyan officials respond", body: ["No country named."] }),
    { geographies: ["Kenya"] }
  );
  assert.equal(r.hardFail, false);
  assert.equal(r.score, 0.7);
  assert.equal(r.reason, "geo_demonym_match:Kenya");
});

test("scoreGeoFit: implicit geo (no tags, no mention) is ambiguous, not a hard-fail", () => {
  const r = scoreGeoFit(makeItem({ geographies: [], headline: "Markets edge higher" }), GEO_SETTINGS);
  assert.equal(r.hardFail, false);
  assert.equal(r.score, 0.5);
  assert.equal(r.category, "implicit_geo");
});
