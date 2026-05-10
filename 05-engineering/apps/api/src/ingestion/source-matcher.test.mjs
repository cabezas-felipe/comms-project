import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForMatching,
  aliasAndNormalize,
  resolveSelectedSources,
  parseFallbackFeedIdsEnv,
  parseFallbackEnabledEnv,
  buildMatchedOutletSet,
  filterItemsToMatchedFeeds,
  FALLBACK_REASON,
  SELECTION_MODE,
} from "./source-matcher.mjs";

const MANIFEST = [
  { id: "wapo-politics", name: "The Washington Post — Politics", kind: "rss", url: "https://wapo/pol", weight: 95, active: true },
  { id: "wapo-world", name: "The Washington Post — World", kind: "rss", url: "https://wapo/world", weight: 92, active: true },
  { id: "wapo-business", name: "The Washington Post — Business", kind: "rss", url: "https://wapo/biz", weight: 90, active: true },
  { id: "nyt-politics", name: "The New York Times — Politics", kind: "rss", url: "https://nyt/pol", weight: 95, active: true },
  { id: "social-x", name: "@latamwatcher", kind: "social", url: "https://twitter.com/latamwatcher", weight: 60, active: true },
];

// ─── normalizeForMatching ────────────────────────────────────────────────────

test("normalizeForMatching: lowercases and drops 'the' prefix", () => {
  assert.equal(normalizeForMatching("The Washington Post"), "washington post");
});

test("normalizeForMatching: replaces dashes and punctuation with spaces, collapses runs", () => {
  assert.equal(normalizeForMatching("The Washington Post — Politics"), "washington post politics");
  assert.equal(normalizeForMatching("El Tiempo / Política"), "el tiempo política");
});

test("normalizeForMatching: idempotent", () => {
  const a = normalizeForMatching("The Washington Post — Politics");
  const b = normalizeForMatching(a);
  assert.equal(a, b);
});

// ─── aliasAndNormalize ───────────────────────────────────────────────────────

test("aliasAndNormalize: applies repo alias map then normalizes", () => {
  assert.equal(aliasAndNormalize("nyt"), "new york times");
  assert.equal(aliasAndNormalize("ny times"), "new york times");
});

test("aliasAndNormalize: passes through unaliased names", () => {
  assert.equal(aliasAndNormalize("Washington Post"), "washington post");
});

test("aliasAndNormalize: respects injected alias map (Supabase canonical wins)", () => {
  const customMap = { "wapo": "Washington Post" };
  assert.equal(aliasAndNormalize("WaPo", customMap), "washington post");
});

// ─── resolveSelectedSources: strict matching ────────────────────────────────

test("resolveSelectedSources: publisher-level selection matches all section feeds", () => {
  const result = resolveSelectedSources({
    selectedSources: ["Washington Post"],
    manifestFeeds: MANIFEST,
  });
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(
    result.matchedFeeds.map((f) => f.id).sort(),
    ["wapo-business", "wapo-politics", "wapo-world"]
  );
  assert.equal(result.matchedSourceCount, 1);
  assert.equal(result.selectedSourceCount, 1);
  assert.equal(result.unmatchedSelectedSources.length, 0);
  assert.equal(result.unavailableConnectorCount, 0);
});

test("resolveSelectedSources: alias resolution → canonical name → match", () => {
  const result = resolveSelectedSources({
    selectedSources: ["NYT"], // alias → "New York Times"
    manifestFeeds: MANIFEST,
  });
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  assert.deepEqual(result.matchedFeeds.map((f) => f.id), ["nyt-politics"]);
});

test("resolveSelectedSources: deduplicates feeds when multiple selections converge on same feed", () => {
  const result = resolveSelectedSources({
    selectedSources: ["Washington Post", "WaPo Politics", "Washington Post"],
    manifestFeeds: MANIFEST,
    aliasMap: { "wapo politics": "Washington Post — Politics" },
  });
  // 3 selections collapsed to 2 unique (case-insensitive); they all hit the WaPo feeds.
  // No double-counting in matchedFeeds.
  const ids = result.matchedFeeds.map((f) => f.id).sort();
  assert.deepEqual(ids, ["wapo-business", "wapo-politics", "wapo-world"]);
});

// ─── resolveSelectedSources: unmatched / unavailable connector ──────────────

test("resolveSelectedSources: name not in manifest → unmatchedSelectedSources", () => {
  const result = resolveSelectedSources({
    selectedSources: ["Washington Post", "Made-Up Outlet"],
    manifestFeeds: MANIFEST,
  });
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  assert.deepEqual(result.unmatchedSelectedSources, ["Made-Up Outlet"]);
  assert.equal(result.matchedSourceCount, 1);
  assert.equal(result.selectedSourceCount, 2);
});

test("resolveSelectedSources: source matched but only via unimplemented connector → unavailable", () => {
  const result = resolveSelectedSources({
    selectedSources: ["@latamwatcher"], // matches social row only
    manifestFeeds: MANIFEST,
  });
  // No RSS connector for @latamwatcher → empty matched, fallback path
  assert.equal(result.mode, SELECTION_MODE.FALLBACK);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReason, FALLBACK_REASON.ALL_UNAVAILABLE_CONNECTORS);
  assert.equal(result.unavailableConnectorCount, 1);
  assert.deepEqual(result.unavailableConnectorSources, ["@latamwatcher"]);
});

// ─── resolveSelectedSources: fallback baseline ──────────────────────────────

test("resolveSelectedSources: empty selection + fallback enabled → fallback feeds returned", () => {
  const result = resolveSelectedSources({
    selectedSources: [],
    manifestFeeds: MANIFEST,
    fallbackFeedIds: ["wapo-politics", "nyt-politics"],
  });
  assert.equal(result.mode, SELECTION_MODE.FALLBACK);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReason, FALLBACK_REASON.NO_SELECTED_SOURCES);
  assert.deepEqual(
    result.matchedFeeds.map((f) => f.id).sort(),
    ["nyt-politics", "wapo-politics"]
  );
});

test("resolveSelectedSources: all selections unmatched → ALL_UNMATCHED reason", () => {
  const result = resolveSelectedSources({
    selectedSources: ["No Such Outlet", "Also Fake"],
    manifestFeeds: MANIFEST,
    fallbackFeedIds: ["wapo-politics"],
  });
  assert.equal(result.mode, SELECTION_MODE.FALLBACK);
  assert.equal(result.fallbackReason, FALLBACK_REASON.ALL_UNMATCHED);
  assert.equal(result.unmatchedSelectedSources.length, 2);
  assert.deepEqual(result.matchedFeeds.map((f) => f.id), ["wapo-politics"]);
});

test("resolveSelectedSources: fallback disabled → no fallback feeds, mode strict, reason=fallback_disabled", () => {
  const result = resolveSelectedSources({
    selectedSources: [],
    manifestFeeds: MANIFEST,
    fallbackFeedIds: ["wapo-politics"],
    fallbackEnabled: false,
  });
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.fallbackReason, FALLBACK_REASON.FALLBACK_DISABLED);
  assert.equal(result.matchedFeeds.length, 0);
});

test("resolveSelectedSources: fallback list excludes non-RSS feed IDs", () => {
  const result = resolveSelectedSources({
    selectedSources: [],
    manifestFeeds: MANIFEST,
    fallbackFeedIds: ["social-x", "wapo-politics"], // social-x is non-rss, must be excluded
  });
  assert.deepEqual(result.matchedFeeds.map((f) => f.id), ["wapo-politics"]);
});

test("resolveSelectedSources: fallback baseline is NOT hardcoded to a single publisher", () => {
  // The matcher must fetch the configured fallback IDs verbatim — we explicitly
  // verify no implicit "WaPo always" hardcoding by passing a non-WaPo fallback.
  const result = resolveSelectedSources({
    selectedSources: [],
    manifestFeeds: MANIFEST,
    fallbackFeedIds: ["nyt-politics"],
  });
  assert.equal(result.mode, SELECTION_MODE.FALLBACK);
  assert.deepEqual(result.matchedFeeds.map((f) => f.id), ["nyt-politics"]);
});

// ─── env helpers ─────────────────────────────────────────────────────────────

test("parseFallbackFeedIdsEnv: comma-split, trim, drop empties", () => {
  assert.deepEqual(parseFallbackFeedIdsEnv("a,b , c"), ["a", "b", "c"]);
  assert.deepEqual(parseFallbackFeedIdsEnv(""), []);
  assert.deepEqual(parseFallbackFeedIdsEnv(undefined), []);
});

test("parseFallbackEnabledEnv: defaults to true, only explicit 'false' disables", () => {
  assert.equal(parseFallbackEnabledEnv(undefined), true);
  assert.equal(parseFallbackEnabledEnv("true"), true);
  assert.equal(parseFallbackEnabledEnv("FALSE"), false);
  assert.equal(parseFallbackEnabledEnv("false"), false);
});

// ─── outlet filter helpers ───────────────────────────────────────────────────

test("buildMatchedOutletSet + filterItemsToMatchedFeeds: filters items to selected outlets only", () => {
  const matched = [MANIFEST[0], MANIFEST[1]]; // wapo-politics + wapo-world
  const set = buildMatchedOutletSet(matched);
  const items = [
    { sourceId: "a", outlet: "The Washington Post — Politics" },
    { sourceId: "b", outlet: "The Washington Post — World" },
    { sourceId: "c", outlet: "The New York Times — Politics" },
  ];
  const filtered = filterItemsToMatchedFeeds(items, set);
  assert.deepEqual(filtered.map((i) => i.sourceId), ["a", "b"]);
});

test("filterItemsToMatchedFeeds: empty set returns empty (strict empty when selection failed)", () => {
  assert.deepEqual(filterItemsToMatchedFeeds([{ outlet: "x" }], new Set()), []);
});

// ─── Inactive-row gating ─────────────────────────────────────────────────────

test("resolveSelectedSources: feeds with active=false are excluded from matchedFeeds", () => {
  // Operator kill switch: a manifest row whose `active` flag is explicitly
  // false must not surface as a selectable match even when the user's
  // selection name resolves to it via alias + substring.  This is the
  // ingestion-side mirror of the feed-reader's `filterFeeds` skip path.
  const manifest = [
    { id: "wapo-pol", name: "The Washington Post — Politics", kind: "rss", url: "https://wapo/pol", weight: 95, active: true },
    { id: "wapo-world-off", name: "The Washington Post — World", kind: "rss", url: "https://wapo/world", weight: 92, active: false },
    { id: "wapo-biz", name: "The Washington Post — Business", kind: "rss", url: "https://wapo/biz", weight: 90, active: true },
  ];
  const result = resolveSelectedSources({
    selectedSources: ["Washington Post"],
    manifestFeeds: manifest,
  });
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  const ids = result.matchedFeeds.map((f) => f.id).sort();
  assert.deepEqual(ids, ["wapo-biz", "wapo-pol"], "inactive WaPo World row must be filtered out");
});

test("resolveSelectedSources: feeds with active omitted (undefined) remain eligible", () => {
  // Backward-compat: legacy fixtures and pre-active-flag rows have no
  // `active` field at all.  `undefined !== false`, so they pass the gate
  // unchanged — pinning this prevents a future refactor from accidentally
  // requiring `active === true` and breaking every legacy manifest.
  const manifest = [
    { id: "no-flag", name: "The Washington Post — Politics", kind: "rss", url: "https://wapo/pol", weight: 95 /* active omitted */ },
    { id: "explicit-true", name: "The Washington Post — World", kind: "rss", url: "https://wapo/world", weight: 92, active: true },
  ];
  const result = resolveSelectedSources({
    selectedSources: ["Washington Post"],
    manifestFeeds: manifest,
  });
  const ids = result.matchedFeeds.map((f) => f.id).sort();
  assert.deepEqual(ids, ["explicit-true", "no-flag"]);
});

test("resolveSelectedSources: only-inactive matches → unavailable bucket (not silent drop)", () => {
  // When the only matching feed is inactive, the user-facing surface treats
  // it the same as "no implemented connector" — the source name lands in
  // `unavailableConnectorSources` so the operator can still reason about
  // why their selection produced nothing.  Avoids a silent drop where the
  // selection would otherwise look "valid but empty".
  const manifest = [
    { id: "only-row", name: "El Tiempo", kind: "rss", url: "https://eltiempo", weight: 80, active: false },
  ];
  const result = resolveSelectedSources({
    selectedSources: ["El Tiempo"],
    manifestFeeds: manifest,
  });
  assert.equal(result.mode, SELECTION_MODE.FALLBACK);
  assert.equal(result.fallbackReason, FALLBACK_REASON.ALL_UNAVAILABLE_CONNECTORS);
  assert.deepEqual(result.unavailableConnectorSources, ["El Tiempo"]);
  assert.equal(result.matchedFeeds.length, 0);
});

test("resolveSelectedSources: fallback baseline excludes inactive feed IDs", () => {
  // The kill switch must hold across the fallback path too — otherwise an
  // operator who flipped a feed off via `active=false` would still see it
  // surface when fallback engages, defeating the kill switch.
  const manifest = [
    { id: "fallback-on", name: "The Washington Post — Politics", kind: "rss", url: "https://wapo/pol", weight: 95, active: true },
    { id: "fallback-off", name: "The Washington Post — Sports", kind: "rss", url: "https://wapo/sports", weight: 80, active: false },
  ];
  const result = resolveSelectedSources({
    selectedSources: [], // forces fallback
    manifestFeeds: manifest,
    fallbackFeedIds: ["fallback-on", "fallback-off"],
  });
  assert.equal(result.mode, SELECTION_MODE.FALLBACK);
  assert.deepEqual(result.matchedFeeds.map((f) => f.id), ["fallback-on"]);
});

test("filterItemsToMatchedFeeds: publisher-only item outlet matches section-level feed name", () => {
  // Live RSS items have outlet=feed.name, but legacy fixtures often store the publisher only.
  // Bidirectional substring match handles both.
  const matched = [MANIFEST[0], MANIFEST[1]]; // wapo-politics + wapo-world
  const set = buildMatchedOutletSet(matched);
  const items = [
    { sourceId: "publisher-only", outlet: "Washington Post" },         // publisher → matches section feed
    { sourceId: "section-form", outlet: "The Washington Post — World" }, // section → exact match
    { sourceId: "unrelated", outlet: "BBC" },
  ];
  const filtered = filterItemsToMatchedFeeds(items, set);
  assert.deepEqual(
    filtered.map((i) => i.sourceId).sort(),
    ["publisher-only", "section-form"]
  );
});
