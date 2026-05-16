import { test } from "node:test";
import assert from "node:assert/strict";

const {
  scoreBeatFit,
  applyBeatFitFilter,
  evaluateRescue,
  readRescueLowerBound,
  BEAT_FIT_THRESHOLD,
  BEAT_FIT_VERSION,
  BEAT_FIT_RESCUE_REASON,
  DEFAULT_RESCUE_LOWER_BOUND,
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

test("BEAT_FIT_THRESHOLD reflects 'balanced' posture (between 0.3 and 0.6)", () => {
  // Soft contract on the threshold so we notice if someone retunes it without
  // updating the pairwise regression.
  assert.ok(BEAT_FIT_THRESHOLD >= 0.3 && BEAT_FIT_THRESHOLD <= 0.6);
});

// ─── PAIRWISE REGRESSION (locked test pair from product spec) ────────────────
//
// The agreed canonical pair: an obvious INCLUDE (US foreign-policy actor on
// the beat) and an obvious EXCLUDE (Asia-region farmer/commodity framing).
// Whatever weight tuning is applied later, this pair MUST keep the directional
// outcome intact — otherwise the relevance posture has regressed.

const INCLUDE_HEADLINE =
  "U.S. strikes two Iranian-flagged tankers as tensions continue amid ceasefire";
const EXCLUDE_HEADLINE =
  "Iran war is crushing Asia's farmers, threatening global food supply";

test("pairwise regression: US strikes story scores at or above threshold (INCLUDE)", () => {
  const item = makeRssItem({
    sourceId: "include",
    headline: INCLUDE_HEADLINE,
    body: [
      "WASHINGTON — The Pentagon confirmed two strikes on tankers in the Gulf of Oman.",
      "The State Department signaled the move was consistent with the existing ceasefire framework.",
    ],
  });
  const { score, reasonCodes } = scoreBeatFit(item, COMMS_SETTINGS);
  assert.ok(
    score >= BEAT_FIT_THRESHOLD,
    `expected score ≥ ${BEAT_FIT_THRESHOLD}, got ${score} (codes: ${reasonCodes.join(",")})`
  );
  // Sanity on which signals fired.
  assert.ok(reasonCodes.some((c) => c.startsWith("actor_match")), "expected actor cue");
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
  assert.ok(
    reasonCodes.some((c) => c.startsWith("geo_offbeat") || c.startsWith("commodity_framing") || c === "no_configured_signal"),
    "expected at least one penalty/floor reason code"
  );
});

test("applyBeatFitFilter: pairwise — included contains the strike story, excluded contains farmers story", () => {
  const items = [
    makeRssItem({ sourceId: "include", headline: INCLUDE_HEADLINE }),
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
    makeRssItem({ sourceId: "i", headline: INCLUDE_HEADLINE }),
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
    actor: 0,
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
  assert.ok(
    DEFAULT_RESCUE_LOWER_BOUND > 0 && DEFAULT_RESCUE_LOWER_BOUND < BEAT_FIT_THRESHOLD,
    "default lower bound must be strictly inside (0, threshold)"
  );
  assert.equal(typeof RESCUE_MIN_STRONG_SIGNALS, "number");
  assert.ok(RESCUE_MIN_STRONG_SIGNALS >= 3, "rescue rule is FP-first: require at least 3 signals");
});

test("evaluateRescue: rescues when score is in band, ≥3 signals fire, and no penalty is present", () => {
  // Synthetic: pretend the scorer produced a score of 0.38 with three positive
  // signals (topic + actor + keyword) and zero penalties. Real-world scoring
  // won't usually land here under current weights — the test isolates the
  // rescue rule itself, not the scoring math.
  const breakdown = makeBreakdown({ topic: 0.30, actor: 0.25, keyword: 0.20 });
  const reasonCodes = ["topic_match:diplomatic relations", "actor_match:u.s.", "keyword_match:migration"];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes);
  assert.equal(outcome.rescued, true, "in-band item with 3 signals and no penalty must rescue");
  assert.equal(outcome.inBand, true);
  assert.equal(outcome.strongSignals, 3);
  assert.equal(outcome.blockedBy, null);
});

test("evaluateRescue: does not rescue an in-band item with only 1–2 signals", () => {
  // Two strong signals (topic + keyword). Score in band but evidence too thin.
  const breakdown = makeBreakdown({ topic: 0.30, keyword: 0.20 });
  const reasonCodes = ["topic_match:diplomatic relations", "keyword_match:migration"];
  const outcome = evaluateRescue(0.37, breakdown, reasonCodes);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, true);
  assert.equal(outcome.strongSignals, 2);
  assert.equal(outcome.blockedBy, "insufficient_signals");
});

test("evaluateRescue: does not rescue when any major penalty is present, even with ≥3 signals", () => {
  // Three positive signals AND an off-beat-geo penalty. The penalty's whole
  // job is to flag structural misalignment; rescue must respect that.
  const breakdown = makeBreakdown({
    topic: 0.30,
    actor: 0.25,
    keyword: 0.20,
    offBeatGeo: -0.30,
  });
  const reasonCodes = [
    "topic_match:diplomatic relations",
    "actor_match:u.s.",
    "keyword_match:migration",
    "geo_offbeat:asia",
  ];
  const outcome = evaluateRescue(0.37, breakdown, reasonCodes);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, true);
  assert.equal(outcome.blockedBy, "major_penalty");
});

test("evaluateRescue: pureCommodity penalty also blocks rescue", () => {
  const breakdown = makeBreakdown({
    topic: 0.30,
    keyword: 0.20,
    geoMatch: 0.15,
    pureCommodity: -0.15,
  });
  const reasonCodes = [
    "topic_match:diplomatic relations",
    "keyword_match:migration",
    "geo_explicit_match",
    "commodity_framing:wheat",
  ];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.blockedBy, "major_penalty");
});

test("evaluateRescue: noConfiguredSignal floor blocks rescue", () => {
  const breakdown = makeBreakdown({ noConfiguredSignal: -0.20 });
  const outcome = evaluateRescue(0.38, breakdown, ["no_configured_signal"]);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.blockedBy, "major_penalty");
});

test("evaluateRescue: score at or above threshold is reported as out-of-band (rescue not applicable)", () => {
  const breakdown = makeBreakdown({ topic: 0.30, actor: 0.25, keyword: 0.20 });
  const outcome = evaluateRescue(0.42, breakdown, ["topic_match", "actor_match", "keyword_match"]);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, false);
});

test("evaluateRescue: score below the lower bound is reported as out-of-band", () => {
  const breakdown = makeBreakdown({ topic: 0.30, actor: 0.25, keyword: 0.20 });
  const outcome = evaluateRescue(0.20, breakdown, ["topic_match", "actor_match", "keyword_match"]);
  assert.equal(outcome.rescued, false);
  assert.equal(outcome.inBand, false);
});

test("evaluateRescue: recency_fresh does NOT count toward the strong-signal tally (FP-first)", () => {
  // Two core signals (keyword + geo) plus recency_fresh — recency still
  // contributes to the score, but rescue eligibility is based on the four
  // core alignment signals only. A thinly-aligned breaking story must not
  // sneak past the gate just because it is fresh.
  const breakdown = makeBreakdown({ keyword: 0.20, geoMatch: 0.15, recency: 0.10 });
  const reasonCodes = ["keyword_match:migration", "geo_explicit_match", "recency_fresh"];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes);
  assert.equal(outcome.rescued, false, "recency_fresh must not push a 2-signal item over the rescue bar");
  assert.equal(outcome.strongSignals, 2);
  assert.equal(outcome.blockedBy, "insufficient_signals");
});

test("evaluateRescue: three core signals with no penalty rescue even when recency is stale", () => {
  // topic + actor + keyword fire; recency_fresh is absent (item is old).
  // Proves the rescue tally depends only on the four core signals.
  const breakdown = makeBreakdown({ topic: 0.30, actor: 0.25, keyword: 0.20 });
  const reasonCodes = [
    "topic_match:diplomatic relations",
    "actor_match:u.s.",
    "keyword_match:migration",
    "recency_stale",
  ];
  const outcome = evaluateRescue(0.38, breakdown, reasonCodes);
  assert.equal(outcome.rescued, true);
  assert.equal(outcome.strongSignals, 3);
  assert.equal(outcome.blockedBy, null);
});

test("evaluateRescue: honors a custom rescueLowerBound and threshold via opts", () => {
  const breakdown = makeBreakdown({ topic: 0.30, actor: 0.25, keyword: 0.20 });
  const reasonCodes = ["topic_match", "actor_match", "keyword_match"];
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

test("readRescueLowerBound: returns default when both env vars are unset", () => {
  withRescueEnv({ primary: undefined, legacy: undefined }, () => {
    assert.equal(readRescueLowerBound(), DEFAULT_RESCUE_LOWER_BOUND);
  });
});

test("readRescueLowerBound: honors a valid TEMPO_BEAT_FIT_RESCUE_LOWER_BOUND override", () => {
  withRescueEnv({ primary: "0.33", legacy: undefined }, () => {
    assert.equal(readRescueLowerBound(), 0.33);
  });
});

test("readRescueLowerBound: falls back to legacy BEAT_FIT_RESCUE_LOWER_BOUND when TEMPO_* is unset", () => {
  withRescueEnv({ primary: undefined, legacy: "0.32" }, () => {
    assert.equal(readRescueLowerBound(), 0.32);
  });
});

test("readRescueLowerBound: TEMPO_* wins precedence when both are set", () => {
  withRescueEnv({ primary: "0.36", legacy: "0.32" }, () => {
    assert.equal(readRescueLowerBound(), 0.36);
  });
});

test("readRescueLowerBound: invalid TEMPO_* with valid legacy falls through to legacy (no silent shadowing)", () => {
  withRescueEnv({ primary: "banana", legacy: "0.34" }, () => {
    assert.equal(readRescueLowerBound(), 0.34);
  });
});

test("readRescueLowerBound: invalid values across both env vars fall back to default", () => {
  const bad = ["banana", "-0.1", "0", "0.40", "0.99", "NaN", ""];
  for (const v of bad) {
    withRescueEnv({ primary: v, legacy: v }, () => {
      assert.equal(
        readRescueLowerBound(),
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
  const items = [makeRssItem({ sourceId: "include", headline: INCLUDE_HEADLINE })];
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
  // Fires THREE core signals — topic (Diplomatic relations) + keyword
  // (migration) + geo (explicit Colombia). Recency may also fire (and
  // contributes to the SCORE) but it is intentionally NOT part of the rescue
  // tally — qualification rests on core signals alone. Threshold is pushed
  // above the natural score so the item lands in the rescue band, exercising
  // the rescue path end-to-end without monkey-patching the scorer.
  const item = makeRssItem({
    sourceId: "rescue-ok",
    headline: "Migration framework announced today",
    topic: "Diplomatic relations",
    geographies: ["Colombia"],
    minutesAgo: 30,
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
  // Item triggers topic + actor + keyword cues but the only actor cue
  // ("Treasury") is NOT a geo synonym, so geo never fires while "Asia"
  // triggers the offBeatGeo penalty. Three strong signals fire but the
  // penalty must veto rescue.
  const item = makeRssItem({
    sourceId: "penalized",
    headline: "Treasury imposes migration sanctions across Asia",
    body: ["Coverage continues across Asia."],
    topic: "Diplomatic relations",
    geographies: [],
    minutesAgo: 5,
  });
  const { included, excluded, summary } = applyBeatFitFilter(
    [item],
    COMMS_SETTINGS,
    { threshold: 0.80, rescueLowerBound: 0.30 }
  );
  // Score will be well inside [0.30, 0.80) — topic + actor + keyword fire,
  // offBeatGeo penalty applies because no US/Colombia overlap.
  assert.equal(included.length, 0, "penalty must block rescue");
  assert.equal(excluded.length, 1);
  assert.ok(
    excluded[0].reasonCodes.some((c) => c.startsWith("geo_offbeat")),
    "expected offbeat-geo penalty to have fired"
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
