import { test } from "node:test";
import assert from "node:assert/strict";

const {
  scoreBeatFit,
  applyBeatFitFilter,
  evaluateRescue,
  evaluateSemanticGeoRescue,
  readBeatFitThreshold,
  readRescueLowerBound,
  readSemanticGeoRescueMin,
  BEAT_FIT_THRESHOLD,
  BEAT_FIT_VERSION,
  BEAT_FIT_RESCUE_REASON,
  SEMANTIC_GEO_RESCUE_REASON,
  DEFAULT_RESCUE_LOWER_BOUND,
  DEFAULT_SEMANTIC_GEO_RESCUE_MIN,
  RESCUE_MIN_STRONG_SIGNALS,
} = await import("./beat-fit-scorer.mjs");

// ─── shared fixtures ─────────────────────────────────────────────────────────

const COMMS_SETTINGS = {
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["migration", "sanctions"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["The Washington Post"],
  socialSources: [],
};

function makeRssItem(overrides = {}) {
  return {
    sourceId: "src-1",
    outlet: "The Washington Post — World",
    kind: "traditional",
    weight: 92,
    url: "https://example.com",
    minutesAgo: 30,
    headline: "",
    body: [""],
    topic: "",
    geographies: [],
    title: "",
    takeaway: "",
    summary: "",
    whyItMatters: "",
    whatChanged: "",
    ...overrides,
  };
}

// ─── version metadata ────────────────────────────────────────────────────────

test("BEAT_FIT_VERSION is a stable identifier", () => {
  assert.equal(typeof BEAT_FIT_VERSION, "string");
  assert.ok(BEAT_FIT_VERSION.length > 0);
});

test("BEAT_FIT_THRESHOLD defaults to MVP recall-first 0.20 (D-063)", () => {
  // D-063 lowered the gate from the legacy "balanced" 0.40 to a recall-first
  // 0.20 so priority WaPo stories (Ukraine ~0.38, China ~0.22, Rwanda ~0.20)
  // surface during the MVP learning phase. Pin the constant so a future
  // retune is intentional, not accidental.
  assert.equal(BEAT_FIT_THRESHOLD, 0.20);
});

test("readBeatFitThreshold: returns the default when both env vars are unset", () => {
  const prevTempo = process.env.TEMPO_BEAT_FIT_THRESHOLD;
  const prevLegacy = process.env.BEAT_FIT_THRESHOLD;
  delete process.env.TEMPO_BEAT_FIT_THRESHOLD;
  delete process.env.BEAT_FIT_THRESHOLD;
  try {
    assert.equal(readBeatFitThreshold(), BEAT_FIT_THRESHOLD);
  } finally {
    if (prevTempo !== undefined) process.env.TEMPO_BEAT_FIT_THRESHOLD = prevTempo;
    if (prevLegacy !== undefined) process.env.BEAT_FIT_THRESHOLD = prevLegacy;
  }
});

test("readBeatFitThreshold: honors a valid TEMPO_BEAT_FIT_THRESHOLD override", () => {
  const prev = process.env.TEMPO_BEAT_FIT_THRESHOLD;
  process.env.TEMPO_BEAT_FIT_THRESHOLD = "0.40";
  try {
    assert.equal(readBeatFitThreshold(), 0.40);
  } finally {
    if (prev !== undefined) process.env.TEMPO_BEAT_FIT_THRESHOLD = prev;
    else delete process.env.TEMPO_BEAT_FIT_THRESHOLD;
  }
});

test("readBeatFitThreshold: falls back to legacy BEAT_FIT_THRESHOLD when TEMPO_* is unset", () => {
  const prevTempo = process.env.TEMPO_BEAT_FIT_THRESHOLD;
  const prevLegacy = process.env.BEAT_FIT_THRESHOLD;
  delete process.env.TEMPO_BEAT_FIT_THRESHOLD;
  process.env.BEAT_FIT_THRESHOLD = "0.30";
  try {
    assert.equal(readBeatFitThreshold(), 0.30);
  } finally {
    if (prevTempo !== undefined) process.env.TEMPO_BEAT_FIT_THRESHOLD = prevTempo;
    if (prevLegacy !== undefined) process.env.BEAT_FIT_THRESHOLD = prevLegacy;
    else delete process.env.BEAT_FIT_THRESHOLD;
  }
});

test("readBeatFitThreshold: invalid values across both env vars fall back to default", () => {
  const prevTempo = process.env.TEMPO_BEAT_FIT_THRESHOLD;
  const prevLegacy = process.env.BEAT_FIT_THRESHOLD;
  const bad = ["banana", "-0.1", "0", "1.5", "NaN", ""];
  for (const v of bad) {
    if (v === "") {
      delete process.env.TEMPO_BEAT_FIT_THRESHOLD;
      delete process.env.BEAT_FIT_THRESHOLD;
    } else {
      process.env.TEMPO_BEAT_FIT_THRESHOLD = v;
      process.env.BEAT_FIT_THRESHOLD = v;
    }
    try {
      assert.equal(
        readBeatFitThreshold(),
        BEAT_FIT_THRESHOLD,
        `expected default for env value ${JSON.stringify(v)}`
      );
    } finally {
      if (prevTempo !== undefined) process.env.TEMPO_BEAT_FIT_THRESHOLD = prevTempo;
      else delete process.env.TEMPO_BEAT_FIT_THRESHOLD;
      if (prevLegacy !== undefined) process.env.BEAT_FIT_THRESHOLD = prevLegacy;
      else delete process.env.BEAT_FIT_THRESHOLD;
    }
  }
});

// ─── PAIRWISE REGRESSION (locked test pair from product spec) ────────────────
//
// The agreed canonical pair: an obvious INCLUDE (US foreign-policy story on
// the beat — sanctions + soft-geo) and an obvious EXCLUDE (Asia-region
// farmer/commodity framing). Whatever weight tuning is applied later, this
// pair MUST keep the directional outcome intact — otherwise the relevance
// posture has regressed.
//
// D-060: the actor signal is gone; the INCLUDE body now anchors on a
// configured keyword ("sanctions") so deterministic still clears 0.40
// without leaning on the legacy actor-cue list.

const INCLUDE_HEADLINE =
  "U.S. strikes two Iranian-flagged tankers as tensions continue amid ceasefire";
const INCLUDE_BODY = [
  "WASHINGTON — Officials confirmed two strikes on tankers in the Gulf of Oman.",
  "Treasury rolled out new sanctions targeting tanker operators alongside the strike.",
];
const EXCLUDE_HEADLINE =
  "Iran war is crushing Asia's farmers, threatening global food supply";

test("pairwise regression: US strikes story scores at or above threshold (INCLUDE)", () => {
  const item = makeRssItem({
    sourceId: "include",
    headline: INCLUDE_HEADLINE,
    body: INCLUDE_BODY,
  });
  const { score, reasonCodes } = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(
    score >= BEAT_FIT_THRESHOLD,
    `expected score ≥ ${BEAT_FIT_THRESHOLD}, got ${score} (codes: ${reasonCodes.join(",")})`
  );
  // Sanity on which signals fired (D-060: no actor cue; keyword + geo carry).
  assert.ok(reasonCodes.some((c) => c.startsWith("keyword_match")), "expected keyword match");
  assert.ok(
    reasonCodes.some((c) => c.startsWith("geo_text_match") || c === "geo_explicit_match"),
    "expected soft-geo match for US/Colombia"
  );
});

test("pairwise regression: Asia farmers/food-supply story scores below threshold (EXCLUDE)", () => {
  const item = makeRssItem({
    sourceId: "exclude",
    headline: EXCLUDE_HEADLINE,
    body: [
      "Wheat and grain prices have surged across Asia, hammering smallholder farmers.",
      "Global supply chains for staple commodities show fresh strain.",
    ],
  });
  const { score, reasonCodes } = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(
    score < BEAT_FIT_THRESHOLD,
    `expected score < ${BEAT_FIT_THRESHOLD}, got ${score} (codes: ${reasonCodes.join(",")})`
  );
  // D-060: off-beat penalty is gone; commodity-framing or noConfiguredSignal
  // remain the precision filters that catch this item.
  assert.ok(
    reasonCodes.some((c) => c.startsWith("commodity_framing") || c === "no_configured_signal"),
    "expected commodity-framing or no-signal floor"
  );
});

test("applyBeatFitFilter: pairwise — included contains the strike story, excluded contains farmers story", () => {
  const items = [
    makeRssItem({ sourceId: "include", headline: INCLUDE_HEADLINE, body: INCLUDE_BODY }),
    makeRssItem({ sourceId: "exclude", headline: EXCLUDE_HEADLINE, body: ["Asia's farmers face commodity stress."] }),
  ];
  const { included, excluded, summary } = applyBeatFitFilter(items, COMMS_SETTINGS);
  assert.equal(included.length, 1);
  assert.equal(included[0].sourceId, "include");
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].item.sourceId, "exclude");
  assert.equal(summary.includedCount, 1);
  assert.equal(summary.excludedCount, 1);
  assert.ok(
    Object.keys(summary.excludeReasonHistogram).length > 0,
    "histogram must record at least one exclude reason"
  );
});

// ─── strict-empty behavior ───────────────────────────────────────────────────

test("strict-empty: when every candidate fails threshold, included is []", () => {
  const items = [
    makeRssItem({ sourceId: "x1", headline: "Local pet adoption fair this weekend" }),
    makeRssItem({ sourceId: "x2", headline: "Tech reviewers test new wireless earbuds" }),
    makeRssItem({ sourceId: "x3", headline: "Sports teams gear up for playoff push" }),
  ];
  const { included, excluded, summary } = applyBeatFitFilter(items, COMMS_SETTINGS);
  assert.equal(included.length, 0, "no items should clear the threshold");
  assert.equal(excluded.length, 3);
  assert.equal(summary.includedCount, 0);
  assert.equal(summary.excludedCount, 3);
});

// ─── individual signal tests ─────────────────────────────────────────────────

test("topic match contributes to score", () => {
  const item = makeRssItem({
    headline: "Generic headline",
    body: ["Generic body."],
    topic: "Diplomatic relations",
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(result.breakdown.topic > 0, "topic component should fire on canonical match");
  assert.ok(result.reasonCodes.some((c) => c.startsWith("topic_match")));
});

test("keyword token match (whole-word) fires", () => {
  const item = makeRssItem({
    headline: "Treasury imposes new sanctions on tanker operators",
    body: [""],
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(result.breakdown.keyword > 0);
  assert.ok(result.reasonCodes.some((c) => c.startsWith("keyword_match")));
});

test("soft-geo: text mention of 'U.S.' counts as US match even when item.geographies is empty", () => {
  const item = makeRssItem({
    headline: "U.S. brokers diplomatic deal in regional summit",
    geographies: [],
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(result.breakdown.geoMatch > 0, "soft-geo must accept 'U.S.' lexical mention");
});

test("explicit geographies array overrides text-based detection", () => {
  const item = makeRssItem({
    headline: "Bilateral statement issued today",
    geographies: ["Colombia"],
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(result.breakdown.geoMatch > 0);
  assert.ok(result.reasonCodes.includes("geo_explicit_match"));
});

test("off-beat geo penalty does NOT apply when explicit geo overlap exists", () => {
  // Story mentions Asia (off-beat region) but is geo-tagged as US-relevant.
  // Soft-geo policy: penalty must not stack on top of an explicit match.
  const item = makeRssItem({
    headline: "U.S. policy shifts on Asia trade",
    body: ["The new framework affects relations across the Indo-Pacific."],
    geographies: ["US"],
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(!result.reasonCodes.some((c) => c.startsWith("geo_offbeat")));
});

test("commodity framing penalty fires when no policy actor present", () => {
  const item = makeRssItem({
    headline: "Wheat farmers face higher fertilizer prices",
    body: ["The commodity squeeze continues into harvest season."],
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(result.reasonCodes.some((c) => c.startsWith("commodity_framing")));
});

test("no-signal floor applied when nothing matches", () => {
  const item = makeRssItem({
    headline: "Generic celebrity news of the day",
    body: ["A celebrity did a thing."],
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(result.reasonCodes.includes("no_configured_signal"));
  assert.ok(result.score < BEAT_FIT_THRESHOLD);
});

test("recency contributes positively for fresh items, less for stale", () => {
  const fresh = scoreBeatFit(
    makeRssItem({ headline: "U.S. announces policy update", minutesAgo: 5 }),
    COMMS_SETTINGS
  );
  const stale = scoreBeatFit(
    makeRssItem({ headline: "U.S. announces policy update", minutesAgo: 1400 }),
    COMMS_SETTINGS
  );
  assert.ok(fresh.score > stale.score, "fresh item should outscore stale item");
});

// ─── output contract ─────────────────────────────────────────────────────────

test("scoreBeatFit always returns score in [0, 1]", () => {
  const evil = makeRssItem({
    headline: "Asia farmers commodity wheat soy livestock crops harvest fertilizer",
  });
  const result = scoreBeatFit(evil, COMMS_SETTINGS);
  assert.ok(result.score >= 0 && result.score <= 1, `score ${result.score} out of bounds`);
});

test("applyBeatFitFilter exposes threshold, includedCount, excludedCount, histogram", () => {
  const { summary } = applyBeatFitFilter([makeRssItem()], COMMS_SETTINGS);
  assert.equal(typeof summary.threshold, "number");
  assert.equal(typeof summary.includedCount, "number");
  assert.equal(typeof summary.excludedCount, "number");
  assert.equal(typeof summary.excludeReasonHistogram, "object");
});

test("included items carry beatFitScore and beatFitReasonCodes for downstream use", () => {
  const items = [
    makeRssItem({ sourceId: "i", headline: INCLUDE_HEADLINE, body: INCLUDE_BODY }),
  ];
  const { included } = applyBeatFitFilter(items, COMMS_SETTINGS);
  assert.equal(included.length, 1);
  assert.equal(typeof included[0].beatFitScore, "number");
  assert.ok(Array.isArray(included[0].beatFitReasonCodes));
});

// ─── Phase 1 borderline-rescue guardrail ─────────────────────────────────────
//
// These tests validate that items scoring just below the main threshold can
// still pass via the rescue path when they show strong multi-signal evidence
// and carry no major penalty. Rescue must NOT loosen global precision: any
// penalty disqualifies, and at least RESCUE_MIN_STRONG_SIGNALS (3) distinct
// positive signals are required.
//
// Helper-level tests (evaluateRescue) use synthetic breakdown/reasonCodes so
// they exercise the rescue rule independently of the scorer math. Integration
// tests through applyBeatFitFilter use the actual scorer with opts overrides
// to construct a real rescue-eligible scenario.

function makeBreakdown(overrides = {}) {
  return {
    topic: 0,
    keyword: 0,
    geoMatch: 0,
    recency: 0,
    ...overrides,
  };
}

test("rescue constants are exported and consistent", () => {
  assert.equal(typeof BEAT_FIT_RESCUE_REASON, "string");
  assert.ok(BEAT_FIT_RESCUE_REASON.length > 0);
  assert.equal(typeof DEFAULT_RESCUE_LOWER_BOUND, "number");
  assert.ok(DEFAULT_RESCUE_LOWER_BOUND > 0, "default lower bound must be positive");
  // D-063: with the default threshold lowered to 0.20, the static constant
  // (0.35) is no longer strictly below the threshold. `readRescueLowerBound`
  // is now threshold-aware and clamps to keep the band non-empty — covered by
  // a dedicated test below.
  assert.equal(typeof RESCUE_MIN_STRONG_SIGNALS, "number");
  assert.ok(RESCUE_MIN_STRONG_SIGNALS >= 3, "rescue rule is FP-first: require at least 3 signals");
});

test("readRescueLowerBound: stays strictly below the active threshold when threshold is 0.20 (D-063)", () => {
  // The historical DEFAULT_RESCUE_LOWER_BOUND (0.35) is no longer inside the
  // band when the active threshold is 0.20. The reader must clamp the
  // fallback to keep [lowerBound, threshold) non-empty, otherwise rescue
  // becomes unreachable.
  const prevTempo = process.env.TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND;
  const prevLegacy = process.env.BEAT_FIT_RESCUE_LOWER_BOUND;
  delete process.env.TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND;
  delete process.env.BEAT_FIT_RESCUE_LOWER_BOUND;
  try {
    const bound = readRescueLowerBound(0.20);
    assert.ok(bound > 0, "lower bound must be positive");
    assert.ok(bound < 0.20, `lower bound ${bound} must be strictly less than threshold 0.20`);
    // Specific clamp contract: max(0.05, threshold - 0.05) → 0.15 at 0.20
    // (allowing for FP rounding on the subtraction).
    assert.ok(Math.abs(bound - 0.15) < 1e-9, `expected ~0.15, got ${bound}`);
  } finally {
    if (prevTempo !== undefined) process.env.TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND = prevTempo;
    if (prevLegacy !== undefined) process.env.BEAT_FIT_RESCUE_LOWER_BOUND = prevLegacy;
  }
});

// The rescue-band evaluation tests exercise the FP-first rescue rule around a
// 0.40 threshold + 0.35 lower bound (the legacy precision-first band).
// D-063 lowered the default to 0.20, so these tests pass the explicit
// threshold/rescueLowerBound opts to keep testing the rescue logic on the
// band shape it was designed for.
const LEGACY_BAND = Object.freeze({ threshold: 0.40, rescueLowerBound: 0.35 });

test("evaluateRescue: rescues when score is in band, all 3 core signals fire, and no penalty is present", () => {
  // Synthetic: pretend the scorer produced a score of 0.38 with all three
  // remaining core signals (topic + keyword + geo) firing and zero penalties.
  // D-060 removed the actor signal; the rescue tally is now 3-of-3.
  const breakdown = makeBreakdown({ topic: 0.30, keyword: 0.25, geoMatch: 0.20 });
  const reasonCodes = ["topic_match:diplomatic relations", "keyword_match:migration", "geo_explicit_match"];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes, LEGACY_BAND);
  assert.equal(outcome.rescued, true, "in-band item with all 3 core signals and no penalty must rescue");
  assert.equal(outcome.inBand, true);
  assert.equal(outcome.strongSignals, 3);
  assert.equal(outcome.blockedBy, null);
});

test("evaluateRescue: does not rescue an in-band item with only 1–2 signals", () => {
  // Two strong signals (topic + keyword). Score in band but evidence too thin.
  const breakdown = makeBreakdown({ topic: 0.30, keyword: 0.25 });
  const reasonCodes = ["topic_match:diplomatic relations", "keyword_match:migration"];
  const outcome = evaluateRescue(0.37, breakdown, reasonCodes, LEGACY_BAND);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, true);
  assert.equal(outcome.strongSignals, 2);
  assert.equal(outcome.blockedBy, "insufficient_signals");
});

test("evaluateRescue: does not rescue when any major penalty is present, even with all core signals", () => {
  // All three remaining core signals AND a commodity-framing penalty. The
  // penalty's whole job is to flag structural misalignment; rescue must
  // respect that. (D-060 removed the off-beat-region penalty.)
  const breakdown = makeBreakdown({
    topic: 0.30,
    keyword: 0.25,
    geoMatch: 0.20,
    pureCommodity: -0.15,
  });
  const reasonCodes = [
    "topic_match:diplomatic relations",
    "keyword_match:migration",
    "geo_explicit_match",
    "commodity_framing:wheat",
  ];
  const outcome = evaluateRescue(0.37, breakdown, reasonCodes, LEGACY_BAND);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, true);
  assert.equal(outcome.blockedBy, "major_penalty");
});

test("evaluateRescue: pureCommodity penalty also blocks rescue", () => {
  const breakdown = makeBreakdown({
    topic: 0.30,
    keyword: 0.25,
    geoMatch: 0.20,
    pureCommodity: -0.15,
  });
  const reasonCodes = [
    "topic_match:diplomatic relations",
    "keyword_match:migration",
    "geo_explicit_match",
    "commodity_framing:wheat",
  ];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes, LEGACY_BAND);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.blockedBy, "major_penalty");
});

test("evaluateRescue: noConfiguredSignal floor blocks rescue", () => {
  const breakdown = makeBreakdown({ noConfiguredSignal: -0.20 });
  const outcome = evaluateRescue(0.38, breakdown, ["no_configured_signal"], LEGACY_BAND);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.blockedBy, "major_penalty");
});

test("evaluateRescue: score at or above threshold is reported as out-of-band (rescue not applicable)", () => {
  const breakdown = makeBreakdown({ topic: 0.30, keyword: 0.25, geoMatch: 0.20 });
  const outcome = evaluateRescue(0.42, breakdown, ["topic_match", "keyword_match", "geo_explicit_match"], LEGACY_BAND);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, false);
});

test("evaluateRescue: score below the lower bound is reported as out-of-band", () => {
  const breakdown = makeBreakdown({ topic: 0.30, keyword: 0.25, geoMatch: 0.20 });
  const outcome = evaluateRescue(0.20, breakdown, ["topic_match", "keyword_match", "geo_explicit_match"], LEGACY_BAND);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, false);
});

test("evaluateRescue: recency_fresh does NOT count toward the strong-signal tally (FP-first)", () => {
  // Two core signals (keyword + geo) plus recency_fresh — recency still
  // contributes to the score, but rescue eligibility is based on the three
  // core alignment signals only (D-060 removed actor). A thinly-aligned
  // breaking story must not sneak past the gate just because it is fresh.
  const breakdown = makeBreakdown({ keyword: 0.25, geoMatch: 0.20, recency: 0.10 });
  const reasonCodes = ["keyword_match:migration", "geo_explicit_match", "recency_fresh"];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes, LEGACY_BAND);
  assert.equal(outcome.rescued, false, "recency_fresh must not push a 2-signal item over the rescue bar");
  assert.equal(outcome.strongSignals, 2);
  assert.equal(outcome.blockedBy, "insufficient_signals");
});

test("evaluateRescue: all 3 core signals with no penalty rescue even when recency is stale", () => {
  // topic + keyword + geo fire; recency_fresh is absent (item is old). Proves
  // the rescue tally depends only on the three core signals (D-060 removed
  // actor; the bar is now 3-of-3, not 3-of-4).
  const breakdown = makeBreakdown({ topic: 0.30, keyword: 0.25, geoMatch: 0.20 });
  const reasonCodes = [
    "topic_match:diplomatic relations",
    "keyword_match:migration",
    "geo_explicit_match",
    "recency_stale",
  ];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes, LEGACY_BAND);
  assert.equal(outcome.rescued, true);
  assert.equal(outcome.strongSignals, 3);
  assert.equal(outcome.blockedBy, null);
});

test("evaluateRescue: honors a custom rescueLowerBound and threshold via opts", () => {
  const breakdown = makeBreakdown({ topic: 0.30, keyword: 0.25, geoMatch: 0.20 });
  const reasonCodes = ["topic_match", "keyword_match", "geo_explicit_match"];
  const outcome = evaluateRescue(0.55, breakdown, reasonCodes, {
    threshold: 0.60,
    rescueLowerBound: 0.50,
  });
  assert.equal(outcome.rescued, true);
  assert.equal(outcome.inBand, true);
});

// ─── env var configuration ───────────────────────────────────────────────────
//
// Precedence (highest first):
//   1. TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND   (repo-convention primary)
//   2. BEAT_FIT_RESCUE_LOWER_BOUND         (legacy fallback, kept for back-compat)
//   3. DEFAULT_RESCUE_LOWER_BOUND
// Each candidate is validated independently; invalid values are skipped so a
// typo in the primary does not silently shadow a working legacy value.

function withRescueEnv(setup, fn) {
  const originals = {
    primary: process.env.TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND,
    legacy: process.env.BEAT_FIT_RESCUE_LOWER_BOUND,
  };
  const apply = (key, val) => {
    const envKey = key === "primary" ? "TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND" : "BEAT_FIT_RESCUE_LOWER_BOUND";
    if (val === undefined) delete process.env[envKey];
    else process.env[envKey] = val;
  };
  apply("primary", setup.primary);
  apply("legacy", setup.legacy);
  try {
    fn();
  } finally {
    apply("primary", originals.primary);
    apply("legacy", originals.legacy);
  }
}

// Env-precedence tests pass the legacy threshold (0.40) explicitly so the
// (0, threshold) validation matches the bound values these cases were written
// for. The threshold-aware fallback at the new 0.20 default has its own test
// near the rescue-constants block above.
test("readRescueLowerBound: returns default when both env vars are unset", () => {
  withRescueEnv({ primary: undefined, legacy: undefined }, () => {
    assert.equal(readRescueLowerBound(0.40), DEFAULT_RESCUE_LOWER_BOUND);
  });
});

test("readRescueLowerBound: honors a valid TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND override", () => {
  withRescueEnv({ primary: "0.33", legacy: undefined }, () => {
    assert.equal(readRescueLowerBound(0.40), 0.33);
  });
});

test("readRescueLowerBound: falls back to legacy BEAT_FIT_RESCUE_LOWER_BOUND when TEMPO_* is unset", () => {
  withRescueEnv({ primary: undefined, legacy: "0.32" }, () => {
    assert.equal(readRescueLowerBound(0.40), 0.32);
  });
});

test("readRescueLowerBound: TEMPO_* wins precedence when both are set", () => {
  withRescueEnv({ primary: "0.36", legacy: "0.32" }, () => {
    assert.equal(readRescueLowerBound(0.40), 0.36);
  });
});

test("readRescueLowerBound: invalid TEMPO_* with valid legacy falls through to legacy (no silent shadowing)", () => {
  withRescueEnv({ primary: "banana", legacy: "0.34" }, () => {
    assert.equal(readRescueLowerBound(0.40), 0.34);
  });
});

test("readRescueLowerBound: invalid values across both env vars fall back to default", () => {
  const bad = ["banana", "-0.1", "0", "0.40", "0.99", "NaN", ""];
  for (const v of bad) {
    withRescueEnv({ primary: v, legacy: v }, () => {
      assert.equal(
        readRescueLowerBound(0.40),
        DEFAULT_RESCUE_LOWER_BOUND,
        `expected default for env value ${JSON.stringify(v)}`
      );
    });
  }
});

// ─── applyBeatFitFilter integration ──────────────────────────────────────────

test("applyBeatFitFilter: baseline above-threshold item passes normally (no rescue marker)", () => {
  // Pairwise INCLUDE story scores well above threshold — must NOT be flagged
  // as rescued.
  const items = [makeRssItem({ sourceId: "include", headline: INCLUDE_HEADLINE, body: INCLUDE_BODY })];
  const { included, summary } = applyBeatFitFilter(items, COMMS_SETTINGS);
  assert.equal(included.length, 1);
  assert.equal(included[0].beatFitRescued, undefined, "normal pass must not carry rescue flag");
  assert.ok(
    !included[0].beatFitReasonCodes.includes(BEAT_FIT_RESCUE_REASON),
    "normal pass must not include the rescue reason code"
  );
  assert.equal(summary.rescuedCount, 0);
});

test("applyBeatFitFilter: item well below the rescue band is still excluded", () => {
  // Generic celebrity item triggers only the no-signal floor — score well
  // under the rescue lower bound.
  const items = [
    makeRssItem({ sourceId: "low", headline: "Generic celebrity news of the day" }),
  ];
  const { included, excluded } = applyBeatFitFilter(items, COMMS_SETTINGS);
  assert.equal(included.length, 0);
  assert.equal(excluded.length, 1);
  assert.ok(excluded[0].score < DEFAULT_RESCUE_LOWER_BOUND);
  assert.ok(
    !excluded[0].reasonCodes.includes(BEAT_FIT_RESCUE_REASON),
    "below-band exclusion must not carry rescue reason"
  );
});

test("applyBeatFitFilter: rescued item carries beatFitRescued flag and rescue reason code (synthetic band via opts)", () => {
  // Fires the three remaining core signals (D-060 removed actor): topic
  // (item.topic === "Diplomatic relations") + keyword (migration in headline)
  // + geo (explicit Colombia). Recency contributes to the SCORE but is
  // intentionally NOT part of the rescue tally. Threshold pushed above the
  // natural score so the item lands in the rescue band, exercising the
  // multisignal rescue end-to-end without monkey-patching the scorer.
  const item = makeRssItem({
    sourceId: "rescue-ok",
    headline: "Migration framework announced today",
    topic: "Diplomatic relations",
    geographies: ["Colombia"],
    minutesAgo: 1440,
  });
  const { included, summary } = applyBeatFitFilter(
    [item],
    COMMS_SETTINGS,
    { threshold: 0.80, rescueLowerBound: 0.30 }
  );
  assert.equal(included.length, 1);
  assert.equal(included[0].beatFitRescued, true);
  assert.ok(
    included[0].beatFitReasonCodes.includes(BEAT_FIT_RESCUE_REASON),
    "rescued item must carry rescue_borderline_multisignal reason code"
  );
  assert.equal(summary.rescuedCount, 1);
  assert.equal(summary.includedCount, 1);
  assert.equal(summary.rescueLowerBound, 0.30);
  assert.equal(summary.rescueBlockedPenaltyCount, 0);
  assert.equal(summary.rescueBlockedInsufficientSignalsCount, 0);
});

test("applyBeatFitFilter: in-band item with only 1–2 signals is excluded and annotated as rescue-blocked", () => {
  // topic-only item with fresh recency. Under raised threshold it sits in
  // the rescue band but fires only 1 core strong signal (topic). Recency
  // still boosts score, but it does NOT count toward rescue qualification.
  // so rescue must reject.
  const item = makeRssItem({
    sourceId: "thin",
    headline: "Generic headline",
    body: ["Generic body."],
    topic: "Diplomatic relations",
    geographies: [],
    minutesAgo: 5,
  });
  const { included, excluded, summary } = applyBeatFitFilter(
    [item],
    COMMS_SETTINGS,
    { threshold: 0.60, rescueLowerBound: 0.30 }
  );
  assert.equal(included.length, 0);
  assert.equal(excluded.length, 1);
  assert.ok(
    excluded[0].reasonCodes.includes("rescue_blocked_insufficient_signals"),
    "in-band exclusion must be annotated with rescue_blocked_insufficient_signals"
  );
  assert.equal(summary.rescueBlockedInsufficientSignalsCount, 1);
  assert.equal(summary.rescueBlockedPenaltyCount, 0);
});

test("applyBeatFitFilter: in-band item with major penalty is excluded and annotated as rescue-blocked-penalty", () => {
  // Item triggers all three remaining core signals (topic + keyword + geo)
  // but the commodity-framing penalty (D-060: kept by Point 7) vetoes the
  // rescue. Threshold is pushed above the natural score so the item lands
  // in the rescue band.
  const item = makeRssItem({
    sourceId: "penalized",
    headline: "Migration sanctions across Colombian farmlands",
    body: [
      "Wheat and grain prices have surged; commodity stress continues among farmers.",
    ],
    topic: "Diplomatic relations",
    geographies: ["Colombia"],
    minutesAgo: 5,
  });
  const { included, excluded, summary } = applyBeatFitFilter(
    [item],
    COMMS_SETTINGS,
    { threshold: 0.80, rescueLowerBound: 0.30 }
  );
  // Score will be well inside [0.30, 0.80) — three core signals fire, but
  // the commodity-framing penalty triggers the veto. (D-060 removed the
  // off-beat-region penalty.)
  assert.equal(included.length, 0, "penalty must block rescue");
  assert.equal(excluded.length, 1);
  assert.ok(
    excluded[0].reasonCodes.some((c) => c.startsWith("commodity_framing")),
    "expected commodity-framing penalty to have fired"
  );
  assert.ok(
    excluded[0].reasonCodes.includes("rescue_blocked_penalty"),
    "in-band exclusion with penalty must be annotated rescue_blocked_penalty"
  );
  assert.equal(summary.rescueBlockedPenaltyCount, 1);
  assert.equal(summary.rescueBlockedInsufficientSignalsCount, 0);
});

test("applyBeatFitFilter: summary exposes rescueLowerBound, rescuedCount, and rescue-blocked counters", () => {
  const { summary } = applyBeatFitFilter([makeRssItem()], COMMS_SETTINGS);
  assert.equal(typeof summary.rescueLowerBound, "number");
  assert.equal(typeof summary.rescuedCount, "number");
  assert.equal(typeof summary.rescueBlockedPenaltyCount, "number");
  assert.equal(typeof summary.rescueBlockedInsufficientSignalsCount, "number");
  assert.equal(summary.rescuedCount, 0, "no rescues expected for the default empty fixture");
  // Default fixture scores well under the rescue lower bound — neither
  // rescue path is even attempted, so both blocked counters stay at 0.
  assert.equal(summary.rescueBlockedPenaltyCount, 0);
  assert.equal(summary.rescueBlockedInsufficientSignalsCount, 0);
});

// ─── Phase 1 anti-regression invariants ──────────────────────────────────────
//
// Consolidated lock tests for the rescue rule. These are deliberately broad
// (table-driven) so a regression in ANY of the invariants below produces a
// clear, specific failure — not a vague "one of the rescue tests broke":
//
//   I1. Rescue band is half-open [lowerBound, threshold). The lower edge
//       qualifies; the upper edge does not.
//   I2. The three CORE signals are exactly {topic, keyword, geoMatch} (D-060
//       removed actor). All 3 with no penalty rescue.
//   I3. recency_fresh never substitutes for a core signal — 2 core + recency
//       must NOT rescue, no matter how strong recency is.
//   I4. Each remaining major penalty (pureCommodity / noConfiguredSignal)
//       independently blocks rescue even with all core signals. (D-060
//       removed offBeatGeo.)
//   I5. Above-threshold items take the normal pass path and never carry the
//       rescue flag or reason code (baseline threshold behavior unchanged).

const CORE_SIGNAL_WEIGHTS = Object.freeze({
  topic: 0.30,
  keyword: 0.25,
  geoMatch: 0.20,
});
const CORE_SIGNALS = Object.freeze(["topic", "keyword", "geoMatch"]);

function breakdownWith(coreNames) {
  const b = makeBreakdown();
  for (const name of coreNames) b[name] = CORE_SIGNAL_WEIGHTS[name];
  return b;
}

test("invariant I1: rescue band is half-open [lowerBound, threshold)", () => {
  // Three core signals + no penalty so the only thing under test is the band.
  const breakdown = breakdownWith(["topic", "keyword", "geoMatch"]);
  const reasonCodes = ["topic_match", "keyword_match", "geo_explicit_match"];
  const opts = { threshold: 0.50, rescueLowerBound: 0.30 };

  // Lower edge: a score exactly at the lower bound qualifies as in-band.
  assert.equal(
    evaluateRescue(0.30, breakdown, reasonCodes, opts).rescued,
    true,
    "score === rescueLowerBound must qualify (inclusive lower bound)"
  );
  // Just below: out of band.
  assert.equal(
    evaluateRescue(0.2999, breakdown, reasonCodes, opts).inBand,
    false,
    "score just below rescueLowerBound is out of band"
  );
  // Just under threshold: still in band.
  assert.equal(
    evaluateRescue(0.4999, breakdown, reasonCodes, opts).rescued,
    true,
    "score just below threshold is in band"
  );
  // Upper edge: a score exactly at the threshold is NOT in the rescue band —
  // it takes the normal pass path instead.
  assert.equal(
    evaluateRescue(0.50, breakdown, reasonCodes, opts).inBand,
    false,
    "score === threshold is out of the rescue band (exclusive upper bound)"
  );
});

test("invariant I2: all 3-of-3 core signals rescue (no penalty, in band)", () => {
  // D-060 collapsed the rescue tally from 3-of-4 to 3-of-3. All three core
  // signals must fire for the rescue to admit. Test under the legacy band
  // so the score-vs-band setup remains stable (see LEGACY_BAND above).
  const breakdown = breakdownWith(CORE_SIGNALS);
  const reasonCodes = CORE_SIGNALS.map((s) => `${s}_match`);
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes, LEGACY_BAND);
  assert.equal(outcome.rescued, true, "all 3 core signals must rescue when in band with no penalty");
  assert.equal(outcome.strongSignals, 3);
  assert.equal(outcome.blockedBy, null);

  // Each 2-of-3 omission must fail (insufficient_signals).
  for (let omitIdx = 0; omitIdx < CORE_SIGNALS.length; omitIdx++) {
    const present = CORE_SIGNALS.filter((_, i) => i !== omitIdx);
    const partial = breakdownWith(present);
    const partialOutcome = evaluateRescue(
      0.38,
      partial,
      present.map((s) => `${s}_match`),
      LEGACY_BAND
    );
    assert.equal(
      partialOutcome.rescued,
      false,
      `omitting ${CORE_SIGNALS[omitIdx]} — remaining 2 core signals must NOT rescue (3-of-3 contract)`
    );
    assert.equal(partialOutcome.blockedBy, "insufficient_signals");
  }
});

test("invariant I3: recency_fresh never substitutes for a missing core signal", () => {
  // Every 2-of-3 core combination paired with recency_fresh must fail rescue.
  // Recency contributes to the SCORE (held in band here) but not to the tally.
  for (let i = 0; i < CORE_SIGNALS.length; i++) {
    for (let j = i + 1; j < CORE_SIGNALS.length; j++) {
      const present = [CORE_SIGNALS[i], CORE_SIGNALS[j]];
      const breakdown = breakdownWith(present);
      breakdown.recency = 0.10; // maximum recency contribution
      const reasonCodes = [...present.map((s) => `${s}_match`), "recency_fresh"];
      const outcome = evaluateRescue(0.38, breakdown, reasonCodes, LEGACY_BAND);
      assert.equal(
        outcome.rescued,
        false,
        `2 core (${present.join("+")}) + recency_fresh must NOT rescue`
      );
      assert.equal(outcome.strongSignals, 2);
      assert.equal(outcome.blockedBy, "insufficient_signals");
    }
  }
});

test("invariant I4: each major penalty independently blocks rescue", () => {
  // All core signals fire (would normally rescue). Each remaining penalty in
  // turn vetoes — proving the veto is independent and not coincidental on any
  // one penalty type. (D-060 removed the off-beat-region penalty.)
  const baseBreakdown = breakdownWith(CORE_SIGNALS);
  const baseCodes = CORE_SIGNALS.map((s) => `${s}_match`);
  const penalties = [
    { name: "pureCommodity", value: -0.15, code: "commodity_framing:wheat" },
    { name: "noConfiguredSignal", value: -0.20, code: "no_configured_signal" },
  ];
  for (const p of penalties) {
    const breakdown = { ...baseBreakdown, [p.name]: p.value };
    const outcome = evaluateRescue(0.37, breakdown, [...baseCodes, p.code], LEGACY_BAND);
    assert.equal(
      outcome.rescued,
      false,
      `${p.name} must independently block rescue`
    );
    assert.equal(outcome.blockedBy, "major_penalty");
  }
});

test("invariant I5: above-threshold pass-through is unchanged (no rescue flag, no rescue reason)", () => {
  // Locks baseline threshold behavior: a clearly-above-threshold item must
  // take the normal pass path. The rescue mechanism must not retroactively
  // tag normal passes.
  const item = makeRssItem({
    sourceId: "normal-pass",
    headline: INCLUDE_HEADLINE,
    body: INCLUDE_BODY,
  });
  const { included, summary } = applyBeatFitFilter([item], COMMS_SETTINGS);
  assert.equal(included.length, 1);
  assert.ok(included[0].beatFitScore >= BEAT_FIT_THRESHOLD);
  assert.equal(included[0].beatFitRescued, undefined, "normal pass must not carry rescue flag");
  assert.ok(
    !included[0].beatFitReasonCodes.includes(BEAT_FIT_RESCUE_REASON),
    "normal pass must not include the rescue reason code"
  );
  assert.equal(summary.rescuedCount, 0);
});

// ─── Semantic intent blending (Option A) ─────────────────────────────────────
//
// The deterministic scorer keeps its full reason-code surface; the blend just
// rewrites the final score and adds extra trace codes so an operator can spot
// when semantic moved the needle.

test("scoreBeatFit: no semanticIntentScore on item → deterministic score is unchanged", () => {
  const item = makeRssItem({
    sourceId: "no-semantic",
    headline: INCLUDE_HEADLINE,
    body: INCLUDE_BODY,
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.equal(result.blendApplied, false);
  assert.equal(result.semanticIntentScore, null);
  assert.equal(result.score, result.deterministicScore);
  assert.ok(
    !result.reasonCodes.some((c) => c.startsWith("semantic_intent_")),
    "no semantic input → no semantic reason codes"
  );
});

test("scoreBeatFit: blend = deterministic * 0.65 + semantic * 0.35 to within rounding", () => {
  const item = makeRssItem({
    sourceId: "blended",
    headline: INCLUDE_HEADLINE,
    body: INCLUDE_BODY,
    semanticIntentScore: 0.5,
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.equal(result.blendApplied, true);
  const expected = result.deterministicScore * 0.65 + 0.5 * 0.35;
  assert.ok(
    Math.abs(result.score - expected) < 1e-9,
    `expected ${expected}, got ${result.score}`
  );
  assert.equal(result.breakdown.deterministicWeighted, result.deterministicScore * 0.65);
  assert.equal(result.breakdown.semanticIntentWeighted, 0.5 * 0.35);
  assert.ok(result.reasonCodes.some((c) => c.startsWith("semantic_intent_score:")));
});

test("scoreBeatFit: blend stays in [0, 1] even when both inputs are at extremes", () => {
  const item = makeRssItem({
    headline: "Asia farmers wheat soy livestock fertilizer commodity",
    semanticIntentScore: 1,
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(result.score >= 0 && result.score <= 1);
});

test("scoreBeatFit: out-of-range semanticIntentScore is clamped before blending", () => {
  const r1 = scoreBeatFit(
    makeRssItem({ headline: INCLUDE_HEADLINE, semanticIntentScore: 5 }),
    COMMS_SETTINGS
  );
  const r2 = scoreBeatFit(
    makeRssItem({ headline: INCLUDE_HEADLINE, semanticIntentScore: -2 }),
    COMMS_SETTINGS
  );
  assert.equal(r1.semanticIntentScore, 1);
  assert.equal(r2.semanticIntentScore, 0);
});

test("scoreBeatFit: non-finite semantic input is ignored (treated as missing)", () => {
  const result = scoreBeatFit(
    makeRssItem({ headline: INCLUDE_HEADLINE, semanticIntentScore: Number.NaN }),
    COMMS_SETTINGS
  );
  assert.equal(result.blendApplied, false);
  assert.equal(result.semanticIntentScore, null);
});

test("scoreBeatFit: semanticBlendEnabled=false bypasses blend even when score is present", () => {
  const result = scoreBeatFit(
    makeRssItem({ headline: INCLUDE_HEADLINE, semanticIntentScore: 0.95 }),
    COMMS_SETTINGS,
    { semanticBlendEnabled: false }
  );
  assert.equal(result.blendApplied, false);
  assert.equal(result.score, result.deterministicScore);
});

test("scoreBeatFit: strong semantic score adds 'semantic_intent_strong' reason code", () => {
  const result = scoreBeatFit(
    makeRssItem({ headline: INCLUDE_HEADLINE, semanticIntentScore: 0.8 }),
    COMMS_SETTINGS
  );
  assert.ok(result.reasonCodes.includes("semantic_intent_strong"));
});

test("scoreBeatFit: weak-deterministic + strong semantic → 'semantic_intent_lift_over_threshold' code", () => {
  // Sub-threshold deterministic baseline (single keyword hit + recency) gets
  // lifted across the threshold by a strong semantic input. Pinning the lift
  // arithmetic here so a refactor of either component surfaces immediately.
  // D-063 lowered the default threshold to 0.20; pass the legacy 0.40 gate
  // explicitly so the deterministic baseline ~0.30 remains sub-threshold and
  // the lift mechanism is what's actually under test.
  const item = makeRssItem({
    sourceId: "weak-det-strong-sem",
    // Single configured keyword fires (+0.25) and recency adds ~0.10 — total
    // deterministic ~0.35, below the legacy 0.40 threshold.
    headline: "Sanctions update issued today by an unnamed authority",
    body: [""],
    topic: "Other",
    geographies: [],
    minutesAgo: 30,
    semanticIntentScore: 0.95,
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS, { threshold: 0.40 });
  assert.ok(
    result.deterministicScore < 0.40,
    `expected deterministic ${result.deterministicScore} < 0.40`
  );
  assert.ok(
    result.score >= 0.40,
    `expected blended ${result.score} >= 0.40`
  );
  assert.ok(result.reasonCodes.includes("semantic_intent_lift_over_threshold"));
});

test("scoreBeatFit: lift reason code tracks the active runtime threshold (D-063)", () => {
  // Same fixture, but at the new MVP default threshold of 0.20 the
  // deterministic baseline already clears the gate — so semantic 'lift' is
  // not over-threshold anymore and the reason code must NOT fire. This
  // confirms the lift annotation compares against the active threshold, not
  // the static BEAT_FIT_THRESHOLD constant alone.
  const item = makeRssItem({
    sourceId: "no-lift-at-low-threshold",
    headline: "Sanctions update issued today by an unnamed authority",
    body: [""],
    topic: "Other",
    geographies: [],
    minutesAgo: 30,
    semanticIntentScore: 0.95,
  });
  const result = scoreBeatFit(item, COMMS_SETTINGS, { threshold: 0.20 });
  assert.ok(result.deterministicScore >= 0.20, "deterministic baseline already at/above 0.20");
  assert.ok(!result.reasonCodes.includes("semantic_intent_lift_over_threshold"));
});

test("applyBeatFitFilter: semantic blend rollup counts lift / missing across the batch", () => {
  // Lift mechanism is calibrated against the legacy 0.40 gate; pass the
  // threshold explicitly so the rollup keeps testing what it was written for.
  const items = [
    // No semantic on the item → blend missing.
    makeRssItem({
      sourceId: "no-semantic",
      headline: INCLUDE_HEADLINE,
      body: INCLUDE_BODY,
    }),
    // Single keyword (+0.25) + recency lift (~0.10) → ~0.35 deterministic
    // (below 0.40 threshold). Strong semantic crosses the 0.40 line — counted
    // as both blend-applied and a lift.
    makeRssItem({
      sourceId: "lift",
      headline: "Sanctions update issued today by an unnamed authority",
      body: [""],
      topic: "Other",
      geographies: [],
      minutesAgo: 30,
      semanticIntentScore: 0.98,
    }),
  ];
  const { summary } = applyBeatFitFilter(items, COMMS_SETTINGS, { threshold: 0.40 });
  assert.equal(summary.semanticBlendEnabled, true);
  assert.equal(summary.semanticBlendMissingCount, 1);
  assert.equal(summary.semanticBlendAppliedCount, 1);
  assert.ok(summary.semanticLiftOverThresholdCount >= 1);
});

test("applyBeatFitFilter: opts.semanticBlendEnabled=false short-circuits blending across the batch", () => {
  // Single keyword + recency = ~0.35 deterministic; semantic 0.99 would lift
  // it past the legacy 0.40 threshold under the default blend. With the
  // kill-switch opt set, blending is bypassed and the item stays excluded.
  // D-063: pass the legacy threshold explicitly — the new 0.20 default would
  // admit the deterministic baseline outright, making the kill-switch a no-op
  // for the inclusion check.
  const items = [
    makeRssItem({
      sourceId: "would-lift",
      headline: "Sanctions update issued today by an unnamed authority",
      body: [""],
      topic: "Other",
      geographies: [],
      minutesAgo: 30,
      semanticIntentScore: 0.99,
    }),
  ];
  const { included, summary } = applyBeatFitFilter(items, COMMS_SETTINGS, {
    semanticBlendEnabled: false,
    threshold: 0.40,
  });
  assert.equal(summary.semanticBlendEnabled, false);
  assert.equal(summary.semanticBlendAppliedCount, 0);
  assert.equal(included.length, 0);
});

// ─── D-059 + D-062 (PR4): rescue_semantic_geo — uncapped, narrow ─────────────
//
// New rescue path for below-threshold items with strong semantic + configured
// geo + no major penalty. Coexists with the existing borderline-multisignal
// rescue (which still wins when both qualify so prior outcomes are stable).
// **Uncapped** per the D-062 amendment.
//
// Settings tailored for these tests: configured geo is Nigeria, with topic/
// keyword terms intentionally chosen to avoid accidental lexical matches.
// This keeps deterministic scoring low enough that semantic-geo rescue logic
// is exercised directly instead of passing through normal threshold logic.
const P4_SETTINGS = {
  topics: ["Terrorism"],
  keywords: ["sanctions"],
  geographies: ["Nigeria"],
  traditionalSources: ["The Washington Post"],
  socialSources: [],
};

function makeBreakdownSG(overrides = {}) {
  // Minimal breakdown shape sufficient for evaluateSemanticGeoRescue; missing
  // bonus fields default to 0 (no signal), missing penalties default to 0
  // (no penalty). D-060: actor field removed.
  return {
    topic: 0,
    keyword: 0,
    geoMatch: 0,
    recency: 0,
    ...overrides,
  };
}

test("D-059: rescue_semantic_geo constants are exported and consistent", () => {
  assert.equal(typeof SEMANTIC_GEO_RESCUE_REASON, "string");
  assert.equal(SEMANTIC_GEO_RESCUE_REASON, "rescue_semantic_geo");
  assert.equal(typeof DEFAULT_SEMANTIC_GEO_RESCUE_MIN, "number");
  assert.ok(
    DEFAULT_SEMANTIC_GEO_RESCUE_MIN > 0 && DEFAULT_SEMANTIC_GEO_RESCUE_MIN <= 1,
    "semantic floor must sit inside (0, 1]"
  );
});

// D-063: helper tests below were authored against the legacy 0.40 threshold;
// the path only fires for below-threshold scores, so pass it explicitly so
// score 0.32 stays below-threshold under the new MVP default (0.20).
const LEGACY_SG_THRESHOLD = 0.40;

test("D-059: evaluateSemanticGeoRescue rescues when below threshold + semantic≥0.60 + geo + no penalty", () => {
  const outcome = evaluateSemanticGeoRescue({
    score: 0.32,
    semanticIntentScore: 0.65,
    breakdown: makeBreakdownSG({ geoMatch: 0.15 }),
    threshold: LEGACY_SG_THRESHOLD,
  });
  assert.equal(outcome.rescued, true);
  assert.equal(outcome.belowThreshold, true);
  assert.equal(outcome.hasStrongSemantic, true);
  assert.equal(outcome.hasGeoMatch, true);
  assert.equal(outcome.blockedBy, null);
});

test("D-059: evaluateSemanticGeoRescue does NOT require multisignal band — works below rescueLowerBound", () => {
  // Crucial vs. borderline rescue: an item at 0.32 (below the 0.35 multisignal
  // band) with strong semantic + geo + no penalty still qualifies. This is the
  // canonical "Nigeria 0.32 + semantic 0.65" case from the strategy doc.
  const outcome = evaluateSemanticGeoRescue({
    score: 0.32,
    semanticIntentScore: 0.65,
    breakdown: makeBreakdownSG({ geoMatch: 0.15 }),
    threshold: LEGACY_SG_THRESHOLD,
  });
  assert.equal(outcome.rescued, true);
});

test("D-059: evaluateSemanticGeoRescue blocked when geo did not fire (blockedBy: 'geo_gate')", () => {
  // Strong semantic + below threshold + no penalty + no geo → geo-gate block.
  // This is the exact diagnostic the eval suite (case 11) asserts on.
  const outcome = evaluateSemanticGeoRescue({
    score: 0.32,
    semanticIntentScore: 0.68,
    breakdown: makeBreakdownSG({ keyword: 0.20 }),
    threshold: LEGACY_SG_THRESHOLD,
  });
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.hasStrongSemantic, true);
  assert.equal(outcome.hasGeoMatch, false);
  assert.equal(outcome.blockedBy, "geo_gate");
});

test("D-059: evaluateSemanticGeoRescue blocked by major penalty even when semantic + geo qualify", () => {
  // Each remaining major penalty independently vetoes the rescue. D-060
  // removed the off-beat-region penalty; pureCommodity + noConfiguredSignal
  // remain.
  for (const penalty of ["pureCommodity", "noConfiguredSignal"]) {
    const outcome = evaluateSemanticGeoRescue({
      score: 0.32,
      semanticIntentScore: 0.70,
      breakdown: makeBreakdownSG({ geoMatch: 0.15, [penalty]: -0.20 }),
      threshold: LEGACY_SG_THRESHOLD,
    });
    assert.equal(outcome.rescued, false, `${penalty} must veto rescue`);
    assert.equal(outcome.blockedBy, "major_penalty");
  }
});

test("D-059: evaluateSemanticGeoRescue blocked when semantic is below the configured floor", () => {
  // Geo fired but semantic was below 0.60 — flagged distinctly as "weak_semantic"
  // so an operator tuning the floor knows which side of the gate hit.
  const outcome = evaluateSemanticGeoRescue({
    score: 0.32,
    semanticIntentScore: 0.55,
    breakdown: makeBreakdownSG({ geoMatch: 0.15 }),
    threshold: LEGACY_SG_THRESHOLD,
  });
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.hasGeoMatch, true);
  assert.equal(outcome.hasStrongSemantic, false);
  assert.equal(outcome.blockedBy, "weak_semantic");
});

test("D-059: evaluateSemanticGeoRescue blocked when score is already above threshold", () => {
  // Above-threshold items take the normal pass path elsewhere; the rescue
  // helper reports them as out-of-scope rather than rescuing them.
  const outcome = evaluateSemanticGeoRescue({
    score: 0.42,
    semanticIntentScore: 0.99,
    breakdown: makeBreakdownSG({ geoMatch: 0.15 }),
  });
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.belowThreshold, false);
  assert.equal(outcome.blockedBy, "above_threshold");
});

test("D-059: evaluateSemanticGeoRescue treats null/missing semanticIntentScore as weak", () => {
  for (const missing of [null, undefined, Number.NaN]) {
    const outcome = evaluateSemanticGeoRescue({
      score: 0.32,
      semanticIntentScore: missing,
      breakdown: makeBreakdownSG({ geoMatch: 0.15 }),
      threshold: LEGACY_SG_THRESHOLD,
    });
    assert.equal(outcome.rescued, false, `${String(missing)} must not rescue`);
    assert.equal(outcome.blockedBy, "weak_semantic");
  }
});

test("D-059: evaluateSemanticGeoRescue honors a custom semantic floor via opts.minSemantic", () => {
  const outcome = evaluateSemanticGeoRescue({
    score: 0.32,
    semanticIntentScore: 0.55,
    breakdown: makeBreakdownSG({ geoMatch: 0.15 }),
    threshold: LEGACY_SG_THRESHOLD,
    minSemantic: 0.50,
  });
  assert.equal(outcome.rescued, true, "lowering the floor below 0.55 must admit");
});

test("D-059: readSemanticGeoRescueMin returns the default when env is unset", () => {
  const prevTempo = process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  const prevLegacy = process.env.BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  delete process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  delete process.env.BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  try {
    assert.equal(readSemanticGeoRescueMin(), DEFAULT_SEMANTIC_GEO_RESCUE_MIN);
  } finally {
    if (prevTempo !== undefined)
      process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN = prevTempo;
    if (prevLegacy !== undefined)
      process.env.BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN = prevLegacy;
  }
});

test("D-059: readSemanticGeoRescueMin honors valid override + falls back on bad value", () => {
  const prev = process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN = "0.55";
  try {
    assert.equal(readSemanticGeoRescueMin(), 0.55);
  } finally {
    if (prev !== undefined)
      process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN = prev;
    else delete process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  }
  const prev2 = process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN = "banana";
  try {
    assert.equal(readSemanticGeoRescueMin(), DEFAULT_SEMANTIC_GEO_RESCUE_MIN);
  } finally {
    if (prev2 !== undefined)
      process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN = prev2;
    else delete process.env.TEMPO_BEAT_FIT_SEMANTIC_GEO_RESCUE_MIN;
  }
});

// ─── applyBeatFitFilter integration: rescue_semantic_geo ─────────────────────

test("D-059 wiring: applyBeatFitFilter rescues an item via the semantic-geo path with rescueReason exposed", () => {
  // Item carries explicit geo Nigeria (so geoMatch fires) but no configured
  // topic/keyword in text. Deterministic = geo only (post-D-060 weight 0.20);
  // stale recency so blended score stays below 0.40 with semantic 0.65.
  // D-063: the new MVP default 0.20 would admit this item outright — the
  // semantic-geo path only fires below-threshold, so pass the legacy 0.40
  // threshold to keep the rescue mechanism under test.
  const item = makeRssItem({
    sourceId: "sg-rescue",
    headline: "Background piece on the Sahel region",
    body: ["A long-form analysis of regional dynamics in West Africa without any configured signal terms."],
    geographies: ["Nigeria"],
    minutesAgo: 1440,
    semanticIntentScore: 0.65,
  });
  const { included, summary } = applyBeatFitFilter([item], P4_SETTINGS, { threshold: 0.40 });
  assert.equal(included.length, 1, "semantic-geo path must admit the item");
  assert.equal(included[0].beatFitRescued, true);
  assert.equal(included[0].beatFitRescueReason, "rescue_semantic_geo");
  assert.ok(
    included[0].beatFitReasonCodes.includes("rescue_semantic_geo"),
    "reasonCodes must include the rescue_semantic_geo annotation"
  );
  assert.equal(summary.rescuedSemanticGeoCount, 1);
  assert.equal(summary.rescuedBorderlineCount, 0);
  assert.equal(summary.rescuedCount, 1, "union count matches");
});

test("D-059 wiring: applyBeatFitFilter blocks semantic-geo rescue on geo mismatch and annotates rescue_blocked_geo_gate", () => {
  // Same shape as above but the item's geo is NOT in settings.geographies
  // and no configured geo phrase appears in text. We DO need a non-geo
  // positive signal so the noConfiguredSignal penalty (a major penalty)
  // doesn't preempt the geo-gate diagnosis. The "sanctions" keyword fires
  // via headline; stale minutesAgo keeps blended score below threshold.
  const item = makeRssItem({
    sourceId: "sg-geo-mismatch",
    headline: "Background piece on France sanctions enforcement",
    body: ["A piece set entirely in France with no other configured signal terms."],
    geographies: ["France"],
    minutesAgo: 1440,
    semanticIntentScore: 0.65,
  });
  const { included, excluded, summary } = applyBeatFitFilter([item], P4_SETTINGS, { threshold: 0.40 });
  assert.equal(included.length, 0);
  assert.equal(excluded.length, 1);
  assert.ok(
    excluded[0].reasonCodes.includes("rescue_blocked_geo_gate"),
    `geo-mismatch exclusion must carry rescue_blocked_geo_gate, got ${JSON.stringify(excluded[0].reasonCodes)}`
  );
  assert.equal(summary.rescueBlockedGeoGateCount, 1);
  assert.equal(summary.rescuedSemanticGeoCount, 0);
});

test("D-059 wiring: major penalty blocks semantic-geo rescue (does not slip past commodity)", () => {
  // Strong semantic + geo + commodity penalty → must fail. The penalty's job
  // is to flag structural misalignment regardless of semantic confidence.
  const item = makeRssItem({
    sourceId: "sg-commodity-block",
    headline: "Nigerian farmers face fertilizer crunch",
    body: ["Wheat and grain prices have surged; commodity stress continues across the region."],
    geographies: ["Nigeria"],
    minutesAgo: 30,
    semanticIntentScore: 0.80,
  });
  const { included, excluded } = applyBeatFitFilter([item], P4_SETTINGS, { threshold: 0.40 });
  assert.equal(included.length, 0, "commodity penalty must veto semantic-geo rescue");
  assert.equal(excluded.length, 1);
  assert.ok(
    excluded[0].reasonCodes.some((c) => c.startsWith("commodity_framing")),
    "commodity_framing reason code must be present"
  );
});

test("D-062 wiring: semantic-geo rescue is UNCAPPED — 3 eligible candidates all rescue", () => {
  // Three independent below-threshold items, each with strong semantic +
  // explicit Nigeria geo + no penalty. Pre-amendment the cap was 2; D-062
  // removed it so all 3 must admit.
  const items = Array.from({ length: 3 }, (_, i) =>
    makeRssItem({
      sourceId: `sg-batch-${i}`,
      headline: `Analysis piece ${i} on the Sahel region`,
      body: [`Long-form regional analysis ${i} without configured signal terms.`],
      geographies: ["Nigeria"],
      // Stale recency keeps deterministic = 0.20 (geo only post-D-060) so
      // blended score stays below 0.40 even at semantic 0.65.
      minutesAgo: 1440,
      // Slightly different semantic scores so the items are distinguishable
      // but all clear the 0.60 floor.
      semanticIntentScore: 0.61 + i * 0.02,
    })
  );
  const { included, summary } = applyBeatFitFilter(items, P4_SETTINGS, { threshold: 0.40 });
  assert.equal(included.length, 3, "all three eligible candidates must rescue (uncapped)");
  assert.equal(summary.rescuedSemanticGeoCount, 3);
  assert.equal(summary.rescuedCount, 3);
  for (const it of included) {
    assert.equal(it.beatFitRescued, true);
    assert.equal(it.beatFitRescueReason, "rescue_semantic_geo");
  }
  // Negative regression guard: no cap-exceeded counter or reason code remains.
  assert.equal("rescue_semantic_geo_cap_exceeded" in summary, false);
  assert.equal("semanticGeoRescueCapExceededCount" in summary, false);
});

test("D-062 wiring: scaling further does not exhibit any cap (10 eligible → 10 rescued)", () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    makeRssItem({
      sourceId: `sg-many-${i}`,
      headline: `Analysis piece ${i} on the Sahel region`,
      body: [`Long-form regional analysis ${i} without configured signal terms.`],
      geographies: ["Nigeria"],
      minutesAgo: 1440,
      semanticIntentScore: 0.65,
    })
  );
  const { included, summary } = applyBeatFitFilter(items, P4_SETTINGS, { threshold: 0.40 });
  assert.equal(included.length, 10);
  assert.equal(summary.rescuedSemanticGeoCount, 10);
});

test("D-059 wiring: borderline multisignal rescue still works and reports its own rescueReason", () => {
  // Lift the threshold + drop the lower bound so the natural-score candidate
  // (which fires topic + keyword + explicit geo) lands inside the band. No
  // semantic input on the item so the only path that admits is borderline-
  // multisignal — confirming backward compatibility. Stale recency keeps
  // det < raised threshold (0.80) while still ≥ rescueLowerBound (0.30).
  const item = makeRssItem({
    sourceId: "borderline-still-works",
    headline: "Migration framework announced today",
    topic: "Diplomatic relations",
    geographies: ["Colombia"],
    minutesAgo: 1440,
  });
  const { included, summary } = applyBeatFitFilter(
    [item],
    COMMS_SETTINGS,
    { threshold: 0.80, rescueLowerBound: 0.30 }
  );
  assert.equal(included.length, 1);
  assert.equal(included[0].beatFitRescued, true);
  assert.equal(included[0].beatFitRescueReason, BEAT_FIT_RESCUE_REASON);
  assert.ok(included[0].beatFitReasonCodes.includes(BEAT_FIT_RESCUE_REASON));
  assert.equal(summary.rescuedBorderlineCount, 1);
  assert.equal(summary.rescuedSemanticGeoCount, 0);
});

test("D-059 wiring: when both rescue paths qualify, borderline-multisignal wins (back-compat)", () => {
  // Same item as above but ALSO carrying a strong semantic score that would
  // qualify for semantic-geo. The borderline path runs first so the older
  // rescue reason persists — items that used to surface via multisignal stay
  // labeled that way.
  const item = makeRssItem({
    sourceId: "both-paths-qualify",
    headline: "Migration framework announced today",
    topic: "Diplomatic relations",
    geographies: ["Colombia"],
    minutesAgo: 1440,
    semanticIntentScore: 0.75,
  });
  const { included } = applyBeatFitFilter(
    [item],
    COMMS_SETTINGS,
    { threshold: 0.80, rescueLowerBound: 0.30 }
  );
  assert.equal(included.length, 1);
  assert.equal(
    included[0].beatFitRescueReason,
    BEAT_FIT_RESCUE_REASON,
    "borderline-multisignal must win when both qualify"
  );
});

test("D-059 wiring: summary surfaces semanticGeoRescueMin + path-split rescue counts", () => {
  const { summary } = applyBeatFitFilter(
    [makeRssItem()],
    COMMS_SETTINGS
  );
  // Shape pin so a future refactor doesn't silently drop the new fields.
  assert.equal(typeof summary.semanticGeoRescueMin, "number");
  assert.equal(typeof summary.rescuedBorderlineCount, "number");
  assert.equal(typeof summary.rescuedSemanticGeoCount, "number");
  assert.equal(typeof summary.rescueBlockedGeoGateCount, "number");
  assert.equal(typeof summary.rescueBlockedWeakSemanticCount, "number");
  // Default fixture is exclusionary, no rescues fire.
  assert.equal(summary.rescuedBorderlineCount, 0);
  assert.equal(summary.rescuedSemanticGeoCount, 0);
});

test("D-059 wiring: an above-threshold normal pass does NOT carry beatFitRescueReason", () => {
  // Lock the contract: rescueReason is for rescue paths only. Normal passes
  // must remain unmarked so a downstream consumer reading the field can use
  // its presence as a rescued-vs-passed discriminator.
  const item = makeRssItem({
    sourceId: "normal-pass",
    headline: INCLUDE_HEADLINE,
    body: INCLUDE_BODY,
  });
  const { included } = applyBeatFitFilter([item], COMMS_SETTINGS);
  assert.equal(included.length, 1);
  assert.equal(included[0].beatFitRescued, undefined);
  assert.equal(included[0].beatFitRescueReason, undefined);
});

// ─── D-064: URL in joinText + alias-aware geoTextMatches ─────────────────────

const D064_SETTINGS = {
  topics: ["Diplomatic relations"],
  keywords: ["sanctions"],
  geographies: ["China", "US"],
  traditionalSources: ["The Washington Post"],
  socialSources: [],
};

test("scoreBeatFit (B2): url-only keyword match contributes when headline/body do not mention it", () => {
  // Body/headline are deliberately neutral; only the URL contains the keyword.
  const item = makeRssItem({
    sourceId: "url-only-kw",
    headline: "Officials gather for talks",
    body: ["Generic context, no keyword terms here."],
    geographies: [],
    topic: "",
    url: "https://example.com/world/sanctions-update",
  });
  const settings = { ...D064_SETTINGS, geographies: ["US"], topics: [] };
  const { breakdown, reasonCodes } = scoreBeatFit(item, settings);
  assert.ok(breakdown.keyword > 0, "URL token 'sanctions' must contribute keyword score");
  assert.ok(reasonCodes.some((c) => c.startsWith("keyword_match")));
});

test("scoreBeatFit (B3): url-only Beijing path drives geoMatch when China is configured", () => {
  // No body/headline mention of China; geographies empty; only URL path
  // contains "beijing". With alias-aware geoTextMatches the geoMatch fires.
  const item = makeRssItem({
    sourceId: "url-only-geo",
    headline: "Trade talks resume in the region",
    body: ["No country name in body."],
    geographies: [],
    topic: "",
    url: "https://www.washingtonpost.com/world/2026/05/16/beijing-summit/",
  });
  const settings = { ...D064_SETTINGS, topics: [], keywords: [] };
  const { breakdown, reasonCodes } = scoreBeatFit(item, settings);
  assert.ok(breakdown.geoMatch > 0, "URL path /beijing/ must drive geoMatch via GEOGRAPHY_ALIASES");
  assert.ok(reasonCodes.some((c) => c.startsWith("geo_text_match:china")));
});

test("scoreBeatFit (B3): existing US synonym path still works ('United States' in text + geo 'US')", () => {
  const item = makeRssItem({
    sourceId: "us-text",
    headline: "United States announces measures",
    body: ["Officials briefed allies on the response."],
    geographies: [],
    topic: "",
    url: "https://example.com/article",
  });
  const settings = { ...D064_SETTINGS, topics: [], keywords: [], geographies: ["US"] };
  const { breakdown, reasonCodes } = scoreBeatFit(item, settings);
  assert.ok(breakdown.geoMatch > 0, "US synonym path must continue to fire");
  assert.ok(reasonCodes.some((c) => c.startsWith("geo_text_match:us")));
});

test("scoreBeatFit (B3): unconfigured alias canonical does NOT match (settings gate honored)", () => {
  // Body mentions Beijing but China is NOT configured. The alias must not
  // contribute via any configured geo.
  const item = makeRssItem({
    sourceId: "alias-no-gate",
    headline: "Officials in Beijing meet",
    body: ["Talks continue."],
    geographies: [],
    topic: "",
    url: "https://example.com/article",
  });
  const settings = { ...D064_SETTINGS, geographies: ["US"], topics: [], keywords: [] };
  const { breakdown } = scoreBeatFit(item, settings);
  assert.equal(breakdown.geoMatch, 0, "Beijing must not lift geoMatch when China is absent from settings");
});

test("scoreBeatFit (B2 regression): item with no url behaves unchanged", () => {
  // Pin: removing `url` from the fixture must not change deterministic score
  // (URL is purely additive evidence when present).
  const baseSettings = { ...D064_SETTINGS, topics: [], geographies: ["US"], keywords: ["sanctions"] };
  const withoutUrl = makeRssItem({
    sourceId: "no-url",
    headline: "U.S. expands sanctions program",
    body: ["Treasury announced new designations."],
    geographies: [],
    topic: "",
    url: "",
  });
  const { deterministicScore } = scoreBeatFit(withoutUrl, baseSettings);
  assert.ok(deterministicScore > 0, "non-URL signals still score");
});
