import { test } from "node:test";
import assert from "node:assert/strict";

const {
  scoreBeatFit,
  applyBeatFitFilter,
  BEAT_FIT_THRESHOLD,
  BEAT_FIT_VERSION,
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
