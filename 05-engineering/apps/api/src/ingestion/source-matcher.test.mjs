import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForMatching,
  aliasAndNormalize,
  resolveSelectedSources,
  parseFallbackFeedIdsEnv,
  parseFallbackEnabledEnv,
  buildMatchedOutletSet,
  buildMatchedFeedIdSet,
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
  // Genuinely-unimplemented connector kind — exercises the unavailable-connector
  // path now that `social` has an implemented reader (Phase 1, Step 1.3).
  { id: "podcast-x", name: "The Daily Briefing Podcast", kind: "podcast", url: "https://podcast/daily", weight: 50, active: true },
];

// Snapshot mirroring the real data/source-feeds.json shape for the "embassy
// narrative" 7-outlet selection: each row carries a curated `publisher` brand,
// and — like production — most feed names embed the publisher EXCEPT the La
// Silla Vacía row, whose name is the bare section label "Silla Nacional".
// This is the exact shape that produced `matched=6/7 unmatched=1` before the
// publisher-field match landed.
const EMBASSY_MANIFEST = [
  { id: "wapo-politics", name: "The Washington Post — Politics", publisher: "The Washington Post", kind: "rss", url: "https://wapo/pol", weight: 95, active: true },
  { id: "reuters-world-americas", name: "Reuters — World (Americas)", publisher: "Reuters", kind: "rss", url: "https://reuters/am", weight: 92, active: true },
  { id: "ap-world-latin-america", name: "Associated Press — World (Latin America)", publisher: "Associated Press", kind: "rss", url: "https://ap/latam", weight: 90, active: true },
  { id: "ap-us-immigration", name: "Associated Press — U.S. (Immigration)", publisher: "Associated Press", kind: "rss", url: "https://ap/imm", weight: 90, active: true },
  { id: "bloomberg-politics-americas", name: "Bloomberg — Politics (Americas)", publisher: "Bloomberg", kind: "rss", url: "https://bbg/am", weight: 88, active: true },
  { id: "infobae-colombia", name: "Infobae - Colombia", publisher: "Infobae", kind: "rss", url: "https://infobae/co", weight: 80, active: true, lang: "es" },
  { id: "semana-politica", name: "Semana - Política", publisher: "Semana", kind: "rss", url: "https://semana/pol", weight: 80, active: true, lang: "es" },
  // The mismatch case: section-only name, publisher carried separately.
  { id: "silla-nacional", name: "Silla Nacional", publisher: "La Silla Vacía", kind: "rss", url: "https://silla/nac", weight: 80, active: true, lang: "es" },
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

// ─── B2: Source matching audit (7/7 outlets) ────────────────────────────────

test("B2: embassy-narrative 7-outlet selection resolves with zero unmatched (was 6/7)", () => {
  // Reproduces the embassy-narrative failure: publisher-level selection of all
  // seven outlets. Pre-fix, "La Silla Vacía" matched zero feeds because the only
  // La Silla Vacía row is named "Silla Nacional" (no embedded publisher) →
  // matched=6/7 unmatched=1. Curated publisher-field matching closes the gap.
  const selected = [
    "The Washington Post",
    "Reuters",
    "Associated Press",
    "Bloomberg",
    "Infobae",
    "Semana",
    "La Silla Vacía",
  ];
  const result = resolveSelectedSources({
    selectedSources: selected,
    manifestFeeds: EMBASSY_MANIFEST,
  });
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.selectedSourceCount, 7);
  assert.equal(result.matchedSourceCount, 7, "all 7 outlets must match");
  assert.deepEqual(result.unmatchedSelectedSources, [], "no unmatched selected sources");
  assert.equal(result.unavailableConnectorCount, 0);
  // The previously-unmatched La Silla Vacía feed is now in the matched set.
  assert.ok(
    result.matchedFeeds.some((f) => f.id === "silla-nacional"),
    "La Silla Vacía publisher selection must resolve to the silla-nacional feed"
  );
});

test("B2: La Silla Vacía resolves via curated publisher field, not the section name", () => {
  // Pin the root-cause fix in isolation: the feed NAME ("Silla Nacional") does
  // not contain the needle ("la silla vacía"); only the curated `publisher`
  // brand does. This must match — and a feed WITHOUT the publisher field must
  // still NOT match (proving we match the curated field, not fuzzy on tokens).
  const withPublisher = resolveSelectedSources({
    selectedSources: ["La Silla Vacía"],
    manifestFeeds: [EMBASSY_MANIFEST.find((f) => f.id === "silla-nacional")],
  });
  assert.deepEqual(withPublisher.matchedFeeds.map((f) => f.id), ["silla-nacional"]);
  assert.equal(withPublisher.unmatchedSelectedSources.length, 0);

  const noPublisher = resolveSelectedSources({
    selectedSources: ["La Silla Vacía"],
    manifestFeeds: [{ id: "silla-nacional", name: "Silla Nacional", kind: "rss", url: "https://silla/nac", weight: 80, active: true }],
  });
  assert.deepEqual(noPublisher.unmatchedSelectedSources, ["La Silla Vacía"]);
});

test("B2: AP naming variants map correctly under curated aliases", () => {
  // "AP" / "AP News" alias → "Associated Press"; "The Associated Press" drops
  // the leading article in normalization. All resolve to the AP feeds via the
  // curated alias map + publisher/name match — no fuzzy logic.
  for (const variant of ["AP", "AP News", "Associated Press", "The Associated Press", "associated press"]) {
    const result = resolveSelectedSources({
      selectedSources: [variant],
      manifestFeeds: EMBASSY_MANIFEST,
    });
    assert.equal(result.unmatchedSelectedSources.length, 0, `"${variant}" should match`);
    assert.deepEqual(
      result.matchedFeeds.map((f) => f.id).sort(),
      ["ap-us-immigration", "ap-world-latin-america"],
      `"${variant}" must resolve to both AP section feeds`
    );
  }
});

test("B2: Spanish outlet naming + diacritics variants map correctly under curated aliases", () => {
  // Accent-dropped, article-prefixed, and qualified variants all fold onto the
  // canonical publisher via the curated alias map, then match the feed's
  // publisher/name. Diacritics must not be required for a match.
  const cases = [
    { input: "La Silla Vacia", id: "silla-nacional" },   // accent dropped
    { input: "la silla vacía", id: "silla-nacional" },   // lowercase + accent
    { input: "Silla Nacional", id: "silla-nacional" },   // legacy section spelling → alias → La Silla Vacía
    { input: "Revista Semana", id: "semana-politica" },  // qualified → Semana
    { input: "Infobae Colombia", id: "infobae-colombia" }, // qualified → Infobae
  ];
  for (const { input, id } of cases) {
    const result = resolveSelectedSources({
      selectedSources: [input],
      manifestFeeds: EMBASSY_MANIFEST,
    });
    assert.equal(result.unmatchedSelectedSources.length, 0, `"${input}" should match`);
    assert.ok(
      result.matchedFeeds.some((f) => f.id === id),
      `"${input}" must resolve to feed ${id}`
    );
  }
});

test("B2: unknown source stays unmatched — strict policy still enforced (no fuzzy fallback)", () => {
  // A plausible-but-unknown outlet must NOT match any feed. This proves the
  // publisher-field addition did not loosen the policy into approximate/fuzzy
  // matching: "El Espectador" shares tokens with nothing curated and stays out.
  const result = resolveSelectedSources({
    selectedSources: ["The Washington Post", "El Espectador"],
    manifestFeeds: EMBASSY_MANIFEST,
  });
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  assert.deepEqual(result.unmatchedSelectedSources, ["El Espectador"]);
  assert.equal(result.matchedSourceCount, 1);
  assert.equal(result.selectedSourceCount, 2);
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

test("resolveSelectedSources: social row now matches (social is an implemented connector — Step 1.3)", () => {
  const result = resolveSelectedSources({
    selectedSources: ["@latamwatcher"], // matches the social row
    manifestFeeds: MANIFEST,
  });
  // `social` joined `rss` as an implemented connector kind → strict match.
  assert.equal(result.mode, SELECTION_MODE.STRICT);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.matchedFeeds.map((f) => f.id), ["social-x"]);
  assert.equal(result.unavailableConnectorCount, 0);
  assert.deepEqual(result.unavailableConnectorSources, []);
});

test("resolveSelectedSources: source matched but only via unimplemented connector → unavailable", () => {
  const result = resolveSelectedSources({
    selectedSources: ["The Daily Briefing Podcast"], // matches the podcast row only
    manifestFeeds: MANIFEST,
  });
  // No implemented connector for the `podcast` kind → empty matched, fallback path.
  assert.equal(result.mode, SELECTION_MODE.FALLBACK);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReason, FALLBACK_REASON.ALL_UNAVAILABLE_CONNECTORS);
  assert.equal(result.unavailableConnectorCount, 1);
  assert.deepEqual(result.unavailableConnectorSources, ["The Daily Briefing Podcast"]);
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

test("resolveSelectedSources: fallback list excludes unimplemented-connector feed IDs", () => {
  const result = resolveSelectedSources({
    selectedSources: [],
    manifestFeeds: MANIFEST,
    fallbackFeedIds: ["podcast-x", "wapo-politics"], // podcast-x has no implemented connector, must be excluded
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

// ─── Feed-id index + matching (live-mode robustness) ────────────────────────

test("buildMatchedFeedIdSet: collects ids of matched feeds, ignores empties", () => {
  const set = buildMatchedFeedIdSet([
    { id: "wapo-politics", name: "The Washington Post — Politics" },
    { id: "wapo-world",    name: "The Washington Post — World" },
    { id: "",              name: "Empty Id" },        // dropped
    { name: "No Id" },                                 // dropped
    null,                                              // dropped
  ]);
  assert.deepEqual([...set].sort(), ["wapo-politics", "wapo-world"]);
});

test("filterItemsToMatchedFeeds: live items match by feedId even when outlet name diverges from matched feed name", () => {
  // Reproduces the user e06d512d production drop-to-zero:
  //   matchedFeedIds = [wapo-politics, wapo-world, ...] (5 WaPo feeds)
  //   afterSourceSelection = 0
  //
  // Modeled cause: the matcher's manifest snapshot exposes section-level
  // canonical names (e.g. from source-feeds.json), but the live feed-reader
  // fetched items via a manifest snapshot whose canonical_name resolved to
  // the publisher form ("The Washington Post").  Both snapshots agree on
  // `feed.id`, but the outlet-name strings disagree after normalization.
  // Pre-fix path used outlet-only matching → set={"washington post politics",
  // "washington post world", ...} but item.outlet="The Washington Post" →
  // normalized "washington post" — and "washington post politics" doesn't
  // include "washington post" backwards (item-in-feed match) hits, but
  // bidirectional check actually does pass…
  //
  // Pin the harder case: a live item whose normalized outlet does NOT
  // bidirectionally match any of the section-level matched outlets — only
  // feedId-based matching will save it.
  const matchedFeeds = [
    { id: "wapo-politics", name: "The Washington Post — Politics", kind: "rss", weight: 95, active: true },
    { id: "wapo-world",    name: "The Washington Post — World",    kind: "rss", weight: 92, active: true },
  ];
  const items = [
    // Live RSS item: feedId from manifest, outlet emitted from a divergent
    // canonical name shape (e.g. "WashingtonPost.com" — no space).  Outlet
    // alone does NOT substring-match either matched feed's normalized form.
    { sourceId: "live-item-1", feedId: "wapo-politics", outlet: "WashingtonPost.com" },
    { sourceId: "live-item-2", feedId: "wapo-world",    outlet: "WashingtonPost.com" },
    // Unrelated live item with a feedId outside the matched set: still drops.
    { sourceId: "unrelated",   feedId: "bbc-world",     outlet: "BBC" },
  ];
  const keys = {
    feedIds: buildMatchedFeedIdSet(matchedFeeds),
    outlets: buildMatchedOutletSet(matchedFeeds),
  };
  const filtered = filterItemsToMatchedFeeds(items, keys);
  assert.deepEqual(
    filtered.map((i) => i.sourceId).sort(),
    ["live-item-1", "live-item-2"],
    "items must be matched by stable feedId even when outlet-name normalization diverges"
  );
});

test("filterItemsToMatchedFeeds: feedId match still strict-empty when matched feeds is empty", () => {
  const keys = {
    feedIds: buildMatchedFeedIdSet([]),
    outlets: buildMatchedOutletSet([]),
  };
  const items = [{ sourceId: "x", feedId: "wapo-politics", outlet: "The Washington Post" }];
  assert.deepEqual(
    filterItemsToMatchedFeeds(items, keys),
    [],
    "no matched feeds → empty result regardless of item shape (strict-empty preserved)"
  );
});

test("filterItemsToMatchedFeeds: outlet fallback still applies for fixture items with no feedId", () => {
  // Fixture-shaped items (no feedId) must continue to match via the legacy
  // bidirectional outlet substring path.  This is the property that lets
  // hand-crafted test rawItems pass through without us having to retrofit a
  // feedId on every fixture.
  const matchedFeeds = [
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", weight: 80, active: true },
  ];
  const keys = {
    feedIds: buildMatchedFeedIdSet(matchedFeeds),
    outlets: buildMatchedOutletSet(matchedFeeds),
  };
  const filtered = filterItemsToMatchedFeeds(
    [
      { sourceId: "fixture-pub", outlet: "Reuters" },          // no feedId, publisher form
      { sourceId: "fixture-sec", outlet: "Reuters — World News" }, // no feedId, section form
      { sourceId: "fixture-x",   outlet: "BBC" },
    ],
    keys
  );
  assert.deepEqual(filtered.map((i) => i.sourceId).sort(), ["fixture-pub", "fixture-sec"]);
});

test("filterItemsToMatchedFeeds: legacy Set signature still works (backward compat)", () => {
  // External callers that still pass a plain Set (the pre-fix signature) get
  // the same outlet-only behavior as before — we did not break the contract.
  const set = buildMatchedOutletSet([MANIFEST[0]]); // wapo-politics
  const items = [
    { sourceId: "a", outlet: "The Washington Post — Politics" },
    { sourceId: "b", outlet: "BBC" },
  ];
  const filtered = filterItemsToMatchedFeeds(items, set);
  assert.deepEqual(filtered.map((i) => i.sourceId), ["a"]);
});

test("filterItemsToMatchedFeeds: feedId match precedes outlet — wrong outlet but right id still passes", () => {
  // Defends against a future refactor that might inadvertently invert the
  // precedence (outlet first → reject before checking id).  Pin id-first
  // semantics so a name-string surprise can't override the stable id.
  const matchedFeeds = [
    { id: "wapo-politics", name: "The Washington Post — Politics", kind: "rss", weight: 95, active: true },
  ];
  const keys = {
    feedIds: buildMatchedFeedIdSet(matchedFeeds),
    outlets: buildMatchedOutletSet(matchedFeeds),
  };
  const items = [
    { sourceId: "weird-outlet", feedId: "wapo-politics", outlet: "ZZ Top Daily" }, // outlet bears zero relation
  ];
  const filtered = filterItemsToMatchedFeeds(items, keys);
  assert.equal(filtered.length, 1, "feedId is authoritative — outlet drift cannot drop a matched-id item");
});

test("buildMatchedOutletSet: falls back to feed.id when name is missing (parity with mapEntry)", () => {
  // Pre-fix the helper skipped any feed with falsy `name`, but `mapEntry`
  // emits items with `outlet=feed.id` in that case — leading to a set that
  // could never contain those items' outlets.  Pin the parity so a future
  // refactor can't reintroduce the asymmetry.
  const set = buildMatchedOutletSet([
    { id: "wapo-politics", name: "" }, // empty name → fallback to id
    { id: "wapo-world", name: null },  // null name → fallback to id
    { id: "with-name", name: "Reuters" },
  ]);
  assert.deepEqual(
    [...set].sort(),
    ["reuters", "wapo politics", "wapo world"]
  );
});
