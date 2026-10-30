// Unit tests for the pre-cluster relevance scorer (node:test). Pure + hermetic —
// no network, no provider keys, no DB. Pins the invariants Step 1.3 will rely on:
//   1. Headline family keys collapse case/punctuation/word-order variants.
//   2. The pool index is a stable single-pass set of corroboration stats.
//   3. Item fits are bounded [0,1] and surface a geo hard-fail for wrong geo.
//   4. An election-on-beat item outranks geo-noise peers; corroboration lifts
//      score over a singleton.
//   5. The comparator's tie-break sequence is deterministic down to sourceId.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeHeadlineFamilyKey,
  buildPreClusterPoolIndex,
  computeItemTopicKeywordGeoFit,
  computeBeatDensity,
  computePreClusterRelevanceScore,
  comparePreClusterRank,
  isElectionCycleItem,
  classifyElectionGeo,
} from "./pre-cluster-relevance.mjs";

const SETTINGS = Object.freeze({
  topics: ["election"],
  keywords: ["election"],
  geographies: ["Colombia"],
});

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    headline: "",
    body: ["Placeholder body."],
    geographies: [],
    url: "https://example.com",
    minutesAgo: 60,
    ...overrides,
  };
}

// ── 1. Headline family normalization ──────────────────────────────────────────

test("family key collapses case + punctuation variants to the same key", () => {
  const a = computeHeadlineFamilyKey({ headline: "Colombia Election Results Announced" });
  const b = computeHeadlineFamilyKey({ headline: "colombia, election... results -- announced!" });
  assert.equal(a, b);
  assert.ok(a.length > 0);
});

test("family key is word-order independent (sorted tokens)", () => {
  const a = computeHeadlineFamilyKey({ headline: "Colombia election results announced" });
  const b = computeHeadlineFamilyKey({ headline: "Announced: election results in Colombia" });
  assert.equal(a, b, "stopwords dropped + sorted tokens collapse word order");
});

test("family key prefers normalizedHeadline over raw headline", () => {
  const key = computeHeadlineFamilyKey({
    headline: "Elecciones en Colombia hoy",
    normalizedHeadline: "Colombia election today",
  });
  assert.equal(key, computeHeadlineFamilyKey({ headline: "Colombia election today" }));
});

test("empty / garbage / stopword-only headlines return empty key safely", () => {
  assert.equal(computeHeadlineFamilyKey({ headline: "" }), "");
  assert.equal(computeHeadlineFamilyKey({}), "");
  assert.equal(computeHeadlineFamilyKey({ headline: "!!! ... ,,, --" }), "");
  assert.equal(computeHeadlineFamilyKey({ headline: "the a an of to" }), "");
  assert.equal(computeHeadlineFamilyKey(null), "");
});

test("allowlisted 2-char tokens survive; other 2-char noise is dropped", () => {
  const key = computeHeadlineFamilyKey({ headline: "US election results" });
  assert.ok(key.split(" ").includes("us"), "meaningful 'us' retained");
  // "qz" is not an allowlisted abbreviation → dropped as short noise.
  const noisy = computeHeadlineFamilyKey({ headline: "qz election results" });
  assert.ok(!noisy.split(" ").includes("qz"), "random 2-char token dropped");
  assert.equal(noisy, computeHeadlineFamilyKey({ headline: "election results" }));
});

test("diacritics fold so accented/unaccented variants share a family key", () => {
  const accented = computeHeadlineFamilyKey({ headline: "Elección en Bogotá" });
  const plain = computeHeadlineFamilyKey({ headline: "Eleccion en Bogota" });
  assert.equal(accented, plain);
  assert.ok(accented.includes("eleccion") && accented.includes("bogota"));
});

// ── 2. Pool index correctness ─────────────────────────────────────────────────

test("pool index counts families and is stable on empty input", () => {
  const empty = buildPreClusterPoolIndex([], SETTINGS);
  assert.equal(empty.size, 0);
  assert.equal(empty.familyCounts.size, 0);
  assert.equal(empty.topicMatchCount, 0);
  assert.equal(empty.keywordMatchCount, 0);

  const nonArray = buildPreClusterPoolIndex(undefined, SETTINGS);
  assert.equal(nonArray.size, 0);
  assert.equal(nonArray.familyCounts.size, 0);
});

test("pool index aggregates same-family peers and topic/keyword hits", () => {
  const items = [
    makeItem({ sourceId: "a", headline: "Colombia election results announced" }),
    makeItem({ sourceId: "b", headline: "Election results announced in Colombia" }),
    makeItem({ sourceId: "c", headline: "Bogota weather forecast for the weekend" }),
  ];
  const index = buildPreClusterPoolIndex(items, SETTINGS);
  assert.equal(index.size, 3);

  const familyKey = computeHeadlineFamilyKey(items[0]);
  assert.equal(index.familyCounts.get(familyKey), 2, "a and b share one family");
  // The two election items hit topic + keyword; the weather item hits neither.
  assert.equal(index.topicMatchCount, 2);
  assert.equal(index.keywordMatchCount, 2);
});

test("beat density saturates and counts only peers (not self)", () => {
  const singleton = makeItem({ sourceId: "x", headline: "Unique Colombia election overnight tabulation downtown" });
  const idxSingle = buildPreClusterPoolIndex([singleton], SETTINGS);
  assert.equal(computeBeatDensity(singleton, idxSingle), 0, "no peers → 0");

  const fam = (n) => makeItem({ sourceId: `f${n}`, headline: "Colombia election results announced" });
  const small = buildPreClusterPoolIndex([fam(1), fam(2)], SETTINGS); // 1 peer
  const big = buildPreClusterPoolIndex([fam(1), fam(2), fam(3), fam(4), fam(5)], SETTINGS); // 4 peers
  const dSmall = computeBeatDensity(fam(1), small);
  const dBig = computeBeatDensity(fam(1), big);
  assert.ok(dSmall > 0 && dSmall < 1);
  assert.ok(dBig > dSmall, "more peers → higher density");
  assert.ok(dBig < 1, "saturates below 1");
});

// ── 3. Fit computation ────────────────────────────────────────────────────────

test("fits are bounded [0,1] and boosted for on-beat matching text", () => {
  const onBeat = makeItem({
    headline: "Colombia election results announced",
    topic: "election",
    geographies: ["Colombia"],
  });
  const fit = computeItemTopicKeywordGeoFit(onBeat, SETTINGS);
  for (const v of [fit.topicFit, fit.keywordFit, fit.geoFit]) {
    assert.ok(v >= 0 && v <= 1, "fit in [0,1]");
  }
  assert.equal(fit.topicFit, 1, "topic tag + text both match");
  assert.equal(fit.keywordFit, 1, "election keyword matches");
  assert.equal(fit.geoFit, 1, "explicit Colombia geo match");
  assert.equal(fit.hardFail, false);
});

test("wrong-geo item lowers geo fit and surfaces a hard-fail signal", () => {
  const offGeo = makeItem({
    headline: "Kenya election results announced",
    geographies: ["Kenya"],
  });
  const fit = computeItemTopicKeywordGeoFit(offGeo, SETTINGS);
  assert.equal(fit.geoFit, 0, "no configured-geo evidence → 0");
  assert.equal(fit.hardFail, true, "explicit geo conflict hard-fails");
  assert.equal(fit.geoReason, "explicit_conflict");
});

// ── 4. Score behavior ─────────────────────────────────────────────────────────

test("election-on-beat item outranks same-geo weather/volcano noise", () => {
  const election = makeItem({
    sourceId: "elec",
    headline: "Colombia election results announced",
    topic: "election",
    geographies: ["Colombia"],
    minutesAgo: 60,
  });
  // Same geography + same freshness so geo/recency are NOT the differentiator —
  // only the configured beat (topic/keyword) separates them.
  const volcano = makeItem({
    sourceId: "volc",
    headline: "Volcano eruption alert issued for Colombia region",
    topic: "natural disaster",
    geographies: ["Colombia"],
    minutesAgo: 60,
  });
  const pool = [election, volcano];
  const index = buildPreClusterPoolIndex(pool, SETTINGS);
  const sElection = computePreClusterRelevanceScore(election, SETTINGS, index);
  const sVolcano = computePreClusterRelevanceScore(volcano, SETTINGS, index);
  assert.ok(
    sElection.preClusterScore > sVolcano.preClusterScore,
    `election (${sElection.preClusterScore}) should beat volcano (${sVolcano.preClusterScore})`
  );
  assert.equal(sElection.components.entityFit, 0, "entity term is 0 pre-cluster");
});

test("corroborated election family scores above an identical-beat singleton", () => {
  // Three outlets carrying the SAME election story (same family key) + one
  // election singleton with a unique headline. Topic/keyword/geo fits are equal
  // across all four, so corroboration (beat density) is the only differentiator.
  const corro = (n) =>
    makeItem({
      sourceId: `c${n}`,
      headline: "Colombia election results announced",
      topic: "election",
      geographies: ["Colombia"],
      minutesAgo: 60,
    });
  const singleton = makeItem({
    sourceId: "single",
    headline: "Colombia election overnight ballot tabulation underway downtown",
    topic: "election",
    geographies: ["Colombia"],
    minutesAgo: 60,
  });
  const pool = [corro(1), corro(2), corro(3), singleton];
  const index = buildPreClusterPoolIndex(pool, SETTINGS);

  const sCorro = computePreClusterRelevanceScore(corro(1), SETTINGS, index);
  const sSingle = computePreClusterRelevanceScore(singleton, SETTINGS, index);
  assert.ok(sCorro.components.corroboration > 0, "corroborated item has density");
  assert.equal(sSingle.components.corroboration, 0, "singleton has no peers");
  assert.ok(
    sCorro.preClusterScore > sSingle.preClusterScore,
    "corroboration lifts the family member above the singleton"
  );
});

// ── 4b. Decision 5C: cross-country election ranking ───────────────────────────

test("election-cycle detection fires bilingually on topic/text, not on noise", () => {
  assert.equal(isElectionCycleItem({ headline: "Colombia election results" }), true);
  assert.equal(isElectionCycleItem({ headline: "Resultados de las elecciones" }), true);
  assert.equal(isElectionCycleItem({ topic: "presidential", headline: "rally today" }), true);
  assert.equal(isElectionCycleItem({ headline: "Volcano eruption alert near Bogota" }), false);
});

test("classifyElectionGeo splits configured-geo vs cross-country vs non-election", () => {
  assert.equal(
    classifyElectionGeo(
      makeItem({ headline: "Colombia election results", geographies: ["Colombia"] }),
      SETTINGS
    ),
    "configuredGeoElection"
  );
  assert.equal(
    classifyElectionGeo(
      makeItem({ headline: "Peru election results", geographies: ["Peru"] }),
      SETTINGS
    ),
    "crossCountryElection"
  );
  assert.equal(
    classifyElectionGeo(
      makeItem({ headline: "Volcano alert", geographies: ["Colombia"] }),
      SETTINGS
    ),
    "nonElection"
  );
});

test("configured-geo election outranks a cross-country election", () => {
  const colombia = makeItem({
    sourceId: "co",
    headline: "Colombia election results announced",
    topic: "election",
    geographies: ["Colombia"],
    minutesAgo: 60,
  });
  const peru = makeItem({
    sourceId: "pe",
    headline: "Peru election results announced",
    topic: "election",
    geographies: ["Peru"],
    minutesAgo: 60,
  });
  const index = buildPreClusterPoolIndex([colombia, peru], SETTINGS);
  const sCo = computePreClusterRelevanceScore(colombia, SETTINGS, index);
  const sPe = computePreClusterRelevanceScore(peru, SETTINGS, index);

  assert.equal(sCo.electionGeoClass, "configuredGeoElection");
  assert.equal(sPe.electionGeoClass, "crossCountryElection");
  assert.ok(sCo.components.electionGeoBoost > 0, "configured geo lifts");
  assert.ok(sPe.components.electionGeoBoost < 0, "cross-country dampens");
  assert.ok(
    sCo.preClusterScore > sPe.preClusterScore,
    `Colombia (${sCo.preClusterScore}) should outrank Peru (${sPe.preClusterScore})`
  );
  // And the comparator agrees on final ordering.
  assert.ok(comparePreClusterRank(sCo, sPe) < 0);
});

test("cross-country election is deprioritized but still beats non-election noise", () => {
  const peru = makeItem({
    sourceId: "pe",
    headline: "Peru election results announced",
    topic: "election",
    geographies: ["Peru"],
    minutesAgo: 60,
  });
  // Clear non-election noise that even matches the configured geography.
  const noise = makeItem({
    sourceId: "noise",
    headline: "Colombia coffee harvest forecast improves",
    topic: "agriculture",
    geographies: ["Colombia"],
    minutesAgo: 60,
  });
  const index = buildPreClusterPoolIndex([peru, noise], SETTINGS);
  const sPe = computePreClusterRelevanceScore(peru, SETTINGS, index);
  const sNoise = computePreClusterRelevanceScore(noise, SETTINGS, index);

  assert.ok(sPe.preClusterScore > 0, "cross-country election remains meaningful (>0)");
  assert.ok(
    sPe.preClusterScore > sNoise.preClusterScore,
    "election relevance survives the penalty and outranks off-beat noise"
  );
});

test("thin pool of cross-country elections still scores/ranks (not excluded)", () => {
  const items = [
    makeItem({ sourceId: "pe", headline: "Peru election results", topic: "election", geographies: ["Peru"], minutesAgo: 30 }),
    makeItem({ sourceId: "br", headline: "Brazil election runoff", topic: "election", geographies: ["Brazil"], minutesAgo: 90 }),
    makeItem({ sourceId: "mx", headline: "Mexico presidential vote", topic: "election", geographies: ["Mexico"], minutesAgo: 200 }),
  ];
  const index = buildPreClusterPoolIndex(items, SETTINGS);
  const scored = items.map((it) => computePreClusterRelevanceScore(it, SETTINGS, index));
  for (const s of scored) {
    assert.equal(s.electionGeoClass, "crossCountryElection");
    assert.ok(s.preClusterScore > 0, "cross-country item still has a positive, rankable score");
  }
  // They sort deterministically (here: by freshness, since other signals tie).
  const order = [...scored].sort(comparePreClusterRank).map((s) => s.sourceId);
  assert.deepEqual(order, ["pe", "br", "mx"]);
});

// ── 5. Comparator determinism ─────────────────────────────────────────────────

test("comparator orders by score, then corroboration, beatFit, freshness, sourceId", () => {
  const base = {
    preClusterScore: 5,
    corroborationScore: 0.5,
    beatFitScore: 0.5,
    minutesAgo: 100,
    sourceId: "m",
  };
  // Higher score wins outright.
  assert.ok(comparePreClusterRank({ ...base, preClusterScore: 6 }, base) < 0);
  // Equal score → higher corroboration wins.
  assert.ok(
    comparePreClusterRank({ ...base, corroborationScore: 0.9 }, base) < 0
  );
  // Equal score + corroboration → higher beatFit wins.
  assert.ok(comparePreClusterRank({ ...base, beatFitScore: 0.9 }, base) < 0);
  // Equal above → fresher (lower minutesAgo) wins.
  assert.ok(comparePreClusterRank({ ...base, minutesAgo: 10 }, base) < 0);
});

test("exact ties break by sourceId ascending for a stable sort", () => {
  const a = { preClusterScore: 5, corroborationScore: 0.5, beatFitScore: 0.5, minutesAgo: 100, sourceId: "aaa" };
  const b = { ...a, sourceId: "bbb" };
  assert.ok(comparePreClusterRank(a, b) < 0, "aaa before bbb");
  assert.ok(comparePreClusterRank(b, a) > 0);
  assert.equal(comparePreClusterRank(a, { ...a }), 0, "identical keys compare equal");

  // End-to-end: a shuffled set sorts deterministically.
  const keys = [b, a, { ...a, sourceId: "ccc" }];
  const sorted = [...keys].sort(comparePreClusterRank).map((k) => k.sourceId);
  assert.deepEqual(sorted, ["aaa", "bbb", "ccc"]);
});
