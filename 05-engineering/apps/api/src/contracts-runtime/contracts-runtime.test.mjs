// Behavioral tests for the runtime-local contracts module.  These mirror the
// existing `@tempo/contracts` test suite (`packages/contracts/src/*.test.ts`)
// in plain Node so they run without a TypeScript build step, and so they fail
// fast if the API's runtime-safe copy drifts in behavior.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSION,
  geographySchema,
  topicSchema,
  sourceSchema,
  storySchema,
  storyTagsSchema,
  dashboardPayloadSchema,
  settingsPayloadSchema,
  normalizeTopicLabel,
  normalizeKeywordLabel,
  normalizeSourceName,
  normalizeSourceIdentity,
  TOPIC_SYNONYMS,
  KEYWORD_SYNONYMS,
  SOURCE_NAME_ALIASES,
  classifySources,
  GEOGRAPHY_ALIASES,
  GEOGRAPHY_SYNONYMS,
  resolveGeographyAlias,
  stripKeywordsMatchingGeographies,
} from "./index.mjs";

const minimalSource = {
  id: "src1",
  outlet: "Example",
  kind: "traditional",
  weight: 80,
  url: "https://example.com",
  minutesAgo: 10,
  headline: "Headline",
  body: ["Paragraph one."],
};

const minimalStory = {
  id: "s1",
  title: "Title",
  // Meta-story fields PR (Prompt 1): `subtitle` required; `takeaway` removed.
  subtitle: "Subtitle.",
  geographies: ["US"],
  topic: "Diplomatic relations",
  summary: "Sum",
  whyItMatters: "Why",
  whatChanged: "What",
  priority: "standard",
  outletCount: 2,
  tags: { topics: [], keywords: [], geographies: [] },
  sources: [minimalSource],
};

test("CONTRACT_VERSION pins the meta-story-fields PR string", () => {
  assert.equal(CONTRACT_VERSION, "2026-05-19-meta-story-fields");
});

test("geographySchema accepts US and Colombia, rejects others", () => {
  assert.ok(geographySchema.safeParse("US").success);
  assert.ok(geographySchema.safeParse("Colombia").success);
  assert.ok(!geographySchema.safeParse("Mexico").success);
});

test("topicSchema accepts the three Phase-1 topics", () => {
  for (const t of ["Diplomatic relations", "Migration policy", "Security cooperation"]) {
    assert.ok(topicSchema.safeParse(t).success, `expected ${t} to parse`);
  }
  assert.ok(!topicSchema.safeParse("Energy policy").success);
});

test("sourceSchema accepts a valid source, rejects empty url", () => {
  assert.equal(sourceSchema.parse(minimalSource).id, "src1");
  assert.throws(() => sourceSchema.parse({ ...minimalSource, url: "" }));
});

test("storySchema accepts minimal story; rejects missing tags", () => {
  const parsed = storySchema.parse(minimalStory);
  assert.equal(parsed.id, "s1");
  const { tags: _omitted, ...withoutTags } = minimalStory;
  assert.throws(() => storySchema.parse(withoutTags));
});

test("storySchema accepts an empty tags object (no evidence on any axis)", () => {
  const parsed = storySchema.parse({
    ...minimalStory,
    tags: { topics: [], keywords: [], geographies: [] },
  });
  assert.deepEqual(parsed.tags, { topics: [], keywords: [], geographies: [] });
});

test("storySchema accepts a story without a canonical topic", () => {
  const { topic: _omitted, ...withoutTopic } = minimalStory;
  const parsed = storySchema.parse(withoutTopic);
  assert.equal(parsed.topic, undefined);
});

test("storyTagsSchema requires the three axes", () => {
  assert.ok(storyTagsSchema.safeParse({ topics: [], keywords: [], geographies: [] }).success);
  assert.ok(!storyTagsSchema.safeParse({ topics: [], keywords: [] }).success);
});

test("dashboardPayloadSchema validates the contract version literal", () => {
  assert.ok(
    dashboardPayloadSchema.safeParse({
      contractVersion: CONTRACT_VERSION,
      stories: [storySchema.parse(minimalStory)],
    }).success
  );
  assert.ok(
    !dashboardPayloadSchema.safeParse({
      contractVersion: "2024-01-01-wrong",
      stories: [],
    }).success
  );
});

test("settingsPayloadSchema accepts a complete settings payload", () => {
  const parsed = settingsPayloadSchema.parse({
    contractVersion: CONTRACT_VERSION,
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
    traditionalSources: ["NYT"],
    socialSources: ["@handle"],
  });
  assert.deepEqual(parsed.traditionalSources, ["NYT"]);
});

test("settingsPayloadSchema rejects a payload missing the topics field", () => {
  const result = settingsPayloadSchema.safeParse({
    contractVersion: CONTRACT_VERSION,
    keywords: ["OFAC"],
    geographies: ["US"],
    traditionalSources: ["NYT"],
    socialSources: ["@handle"],
  });
  assert.ok(!result.success);
});

// ── label normalization ────────────────────────────────────────────────────

test("normalizeTopicLabel resolves bilateral relations to canonical", () => {
  assert.equal(normalizeTopicLabel("bilateral relations"), "Diplomatic relations");
  assert.equal(normalizeTopicLabel("Bilateral Relations"), "Diplomatic relations");
});

test("normalizeTopicLabel returns trimmed input when unknown", () => {
  assert.equal(normalizeTopicLabel("  Some Novel Topic  "), "Some Novel Topic");
});

test("normalizeKeywordLabel collapses plural forms", () => {
  assert.equal(normalizeKeywordLabel("outbreaks"), "outbreak");
  assert.equal(normalizeKeywordLabel("VACCINES"), "vaccine");
});

test("normalizeSourceName resolves the canonical NYT spelling", () => {
  assert.equal(normalizeSourceName("  nyt  "), "New York Times");
  assert.equal(normalizeSourceName("The Hill"), "The Hill");
});

test("normalizeSourceIdentity collapses case + whitespace but not aliases", () => {
  assert.equal(normalizeSourceIdentity("  Reuters  "), normalizeSourceIdentity("reuters"));
  assert.equal(
    normalizeSourceIdentity("The  New   York    Times"),
    "the new york times"
  );
  assert.notEqual(
    normalizeSourceIdentity("NYT"),
    normalizeSourceIdentity("The New York Times")
  );
});

test("synonym/alias maps preserve their authoring shape", () => {
  assert.equal(TOPIC_SYNONYMS["bilateral relations"], "Diplomatic relations");
  assert.equal(KEYWORD_SYNONYMS["outbreaks"], "outbreak");
  assert.equal(SOURCE_NAME_ALIASES["nyt"], "New York Times");
});

// ── source classification ──────────────────────────────────────────────────

test("classifySources splits, trims, and dedupes mixed input", () => {
  const { traditionalSources, socialSources } = classifySources([
    "Reuters",
    "@latamwatcher",
    "NYT",
    "Twitter News",
    "  reuters  ",
    "@LATAMWATCHER",
  ]);
  assert.deepEqual(traditionalSources, ["Reuters", "NYT"]);
  assert.deepEqual(socialSources, ["@latamwatcher", "Twitter News"]);
});

test("classifySources skips blank input and treats x.com/youtube as social", () => {
  const { traditionalSources, socialSources } = classifySources([
    "", "   ", "x.com/news", "YouTube creator",
  ]);
  assert.deepEqual(traditionalSources, []);
  assert.equal(socialSources.length, 2);
});

// ── geography aliases ──────────────────────────────────────────────────────

test("GEOGRAPHY_ALIASES keys are lowercase and include canonical examples", () => {
  for (const key of Object.keys(GEOGRAPHY_ALIASES)) {
    assert.equal(key, key.toLowerCase());
  }
  assert.equal(GEOGRAPHY_ALIASES["beijing"], "China");
  assert.equal(GEOGRAPHY_ALIASES["montevideo"], "Latin America");
});

test("resolveGeographyAlias gates emission on settings vocabulary", () => {
  assert.equal(resolveGeographyAlias("Beijing", ["China", "US"]), "China");
  assert.equal(resolveGeographyAlias("Beijing", ["china", "us"]), "china");
  assert.equal(resolveGeographyAlias("BEIJING", ["China"]), "China");
  assert.equal(resolveGeographyAlias("Beijing", ["US", "Colombia"]), null);
  assert.equal(resolveGeographyAlias("Atlantis", ["China", "US"]), null);
  assert.equal(resolveGeographyAlias("Beijing", ["Beijing"]), null);
  assert.equal(resolveGeographyAlias("", ["China"]), null);
  assert.equal(resolveGeographyAlias(null, ["China"]), null);
  assert.equal(resolveGeographyAlias("Beijing", []), null);
});

test("resolveGeographyAlias (D-064a): canonical 'United States' resolves to configured 'US' via GEOGRAPHY_SYNONYMS", () => {
  // The alias map points "washington" → "United States" but real users
  // typically configure the short form "US". The resolver now matches via the
  // synonym table and returns the user's spelling.
  assert.equal(resolveGeographyAlias("washington", ["US"]), "US");
  assert.equal(resolveGeographyAlias("Washington", ["us"]), "us");
  assert.equal(resolveGeographyAlias("New York", ["US"]), "US");
  assert.equal(resolveGeographyAlias("Los Angeles", ["US"]), "US");
  // Existing exact-canonical path still wins ahead of the synonym path.
  assert.equal(resolveGeographyAlias("Washington", ["United States", "US"]), "United States");
});

test("resolveGeographyAlias (D-064a): non-synonym configs still return null", () => {
  // "Washington" → "United States"; "Colombia" has no synonym overlap with
  // "United States", so the gate still fails when the user hasn't opted in.
  assert.equal(resolveGeographyAlias("Washington", ["Colombia"]), null);
  // Beijing → China; "US" synonyms don't include China.
  assert.equal(resolveGeographyAlias("Beijing", ["US"]), null);
});

// ── stripKeywordsMatchingGeographies (D-064) ───────────────────────────────

test("GEOGRAPHY_SYNONYMS includes the canonical MVP geographies", () => {
  // Sanity: helper depends on these surface forms existing.
  assert.ok(Array.isArray(GEOGRAPHY_SYNONYMS.US));
  assert.ok(GEOGRAPHY_SYNONYMS.US.includes("United States"));
  assert.ok(GEOGRAPHY_SYNONYMS.US.includes("USA"));
  assert.ok(GEOGRAPHY_SYNONYMS.US.includes("U.S."));
});

test("stripKeywordsMatchingGeographies removes exact geo matches (case-insensitive)", () => {
  assert.deepEqual(
    stripKeywordsMatchingGeographies(
      ["China", "russia", "Ukraine", "war", "trade"],
      ["China", "Russia", "Ukraine", "US"]
    ),
    ["war", "trade"]
  );
});

test("stripKeywordsMatchingGeographies removes GEOGRAPHY_SYNONYMS surface forms", () => {
  assert.deepEqual(
    stripKeywordsMatchingGeographies(
      ["United States", "U.S.", "USA", "sanctions"],
      ["US"]
    ),
    ["sanctions"]
  );
});

test("stripKeywordsMatchingGeographies removes GEOGRAPHY_ALIASES that resolve to a configured geo", () => {
  // City aliases are geo signal, not thematic keywords.
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["Bogotá", "diplomacy"], ["Colombia"]),
    ["diplomacy"]
  );
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["Moscow", "sanctions"], ["Russia"]),
    ["sanctions"]
  );
});

test("stripKeywordsMatchingGeographies leaves thematic keywords untouched", () => {
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["sanctions", "OFAC"], ["US"]),
    ["sanctions", "OFAC"]
  );
});

test("stripKeywordsMatchingGeographies is a no-op when geographies is empty", () => {
  // Direction is keywords → geographies only — never the reverse.
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["China", "trade"], []),
    ["China", "trade"]
  );
});

test("stripKeywordsMatchingGeographies handles unconfigured aliases (Beijing keyword + no China geo)", () => {
  // Alias whose canonical isn't configured → not stripped (helper is gated on
  // settings.geographies, same as resolveGeographyAlias).
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["Beijing", "trade"], ["US"]),
    ["Beijing", "trade"]
  );
});

test("stripKeywordsMatchingGeographies returns a fresh array (does not mutate input)", () => {
  const input = ["China", "trade"];
  const result = stripKeywordsMatchingGeographies(input, ["China"]);
  assert.deepEqual(input, ["China", "trade"], "input must not be mutated");
  assert.notEqual(result, input, "must return a new array");
});

test("stripKeywordsMatchingGeographies (D-064a): strips US-city aliases when settings use short-form 'US'", () => {
  // Cross-check with synonym-aware resolveGeographyAlias — a user who
  // configured short-form "US" still gets city aliases (Washington, New York)
  // stripped from keywords, even though the alias canonical is "United States".
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["Washington", "diplomacy"], ["US"]),
    ["diplomacy"]
  );
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["New York", "trade"], ["US"]),
    ["trade"]
  );
});

test("stripKeywordsMatchingGeographies tolerates non-string / blank entries", () => {
  assert.deepEqual(
    stripKeywordsMatchingGeographies(["China", "", null, 42, "  ", "trade"], ["China"]),
    ["trade"]
  );
});
