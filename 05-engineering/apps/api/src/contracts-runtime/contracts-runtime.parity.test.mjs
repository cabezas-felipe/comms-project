// Parity test: the runtime-local contract module must stay behaviorally
// equivalent to `@tempo/contracts`.  Imports both modules and asserts the
// same inputs yield the same outputs across every exported surface the API
// runtime touches.
//
// CI (`process.env.CI === "true"`) requires `@tempo/contracts` to be
// buildable/importable — a failed import fails the test run so parity drift
// or build regressions cannot slip through. Local runs (non-CI) keep the
// friendly skip so contributors who haven't built `packages/contracts/dist`
// yet still get a green `npm run test --workspace=@tempo/api`.

import assert from "node:assert/strict";
import test from "node:test";

import * as local from "./index.mjs";

let published;
let importError;
try {
  published = await import("@tempo/contracts");
} catch (err) {
  if (
    err &&
    (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")
  ) {
    importError = err;
  } else {
    throw err;
  }
}

if (importError) {
  if (process.env.CI === "true") {
    test("contracts-runtime parity requires @tempo/contracts in CI", () => {
      assert.fail(
        "CI requires `@tempo/contracts` to be buildable/importable for parity checks. " +
          "Build the workspace package (`npm run build --workspace=@tempo/contracts`) " +
          `before running tests. Underlying import error: ${importError.message}`
      );
    });
  } else {
    test("contracts-runtime parity skipped (@tempo/contracts dist not built)", (t) => {
      t.skip(
        "Run `npm run build --workspace=@tempo/contracts` to enable the parity comparison."
      );
    });
  }
}

if (published) {
  test("CONTRACT_VERSION matches between runtime-local and @tempo/contracts", () => {
    assert.equal(local.CONTRACT_VERSION, published.CONTRACT_VERSION);
  });

  test("alias / synonym maps are deeply equal", () => {
    assert.deepEqual(local.TOPIC_SYNONYMS, published.TOPIC_SYNONYMS);
    assert.deepEqual(local.KEYWORD_SYNONYMS, published.KEYWORD_SYNONYMS);
    assert.deepEqual(local.SOURCE_NAME_ALIASES, published.SOURCE_NAME_ALIASES);
    assert.deepEqual(local.GEOGRAPHY_ALIASES, published.GEOGRAPHY_ALIASES);
  });

  // ── normalizer parity (exhaustive on known synonym keys + a few extras) ───
  const normalizerFixtures = {
    normalizeTopicLabel: [
      ...Object.keys(published.TOPIC_SYNONYMS),
      "Bilateral Relations",
      "  bilateral relations  ",
      "Brand New Topic",
      "",
    ],
    normalizeKeywordLabel: [
      ...Object.keys(published.KEYWORD_SYNONYMS),
      "Outbreaks",
      "BORDER PRESSURE",
      "unknown keyword",
    ],
    normalizeSourceName: [
      ...Object.keys(published.SOURCE_NAME_ALIASES),
      "  nyt  ",
      "Reuters",
      "Unknown Outlet",
    ],
    normalizeSourceIdentity: [
      "Reuters",
      "  Reuters  ",
      "REUTERS",
      "The  New   York    Times",
      "@handle",
      "@HANDLE",
    ],
  };

  for (const [fn, inputs] of Object.entries(normalizerFixtures)) {
    for (const input of inputs) {
      test(`${fn}(${JSON.stringify(input)}) parity`, () => {
        assert.equal(local[fn](input), published[fn](input));
      });
    }
  }

  // ── classifySources parity ───────────────────────────────────────────────
  const classifyFixtures = [
    [],
    ["Reuters", "NYT"],
    ["@latamwatcher", "@nytimes"],
    ["Washington Post", "El Tiempo", "Le Monde"],
    ["twitter.com/feed", "X.com/breaks", "YouTube creator"],
    ["", "   ", "\t"],
    ["Reuters", "reuters", "REUTERS"],
    ["Reuters", "@foo", "nyt", "Reuters", "@FOO", "NYT"],
    ["  Reuters  ", "\tNYT\t"],
  ];

  for (const input of classifyFixtures) {
    test(`classifySources(${JSON.stringify(input)}) parity`, () => {
      assert.deepEqual(local.classifySources(input), published.classifySources(input));
    });
  }

  // ── resolveGeographyAlias parity ─────────────────────────────────────────
  const geoFixtures = [
    ["Beijing", ["China", "US"]],
    ["Beijing", ["china", "us"]],
    ["BEIJING", ["China"]],
    ["  beijing  ", ["China"]],
    ["Beijing", ["US", "Colombia"]],
    ["Atlantis", ["China", "US"]],
    ["Beijing", ["Beijing"]],
    ["", ["China"]],
    ["Beijing", []],
    ["Montevideo", ["Latin America"]],
    ["sao paulo", ["Brazil"]],
  ];

  for (const [token, settings] of geoFixtures) {
    test(`resolveGeographyAlias(${JSON.stringify(token)}, ${JSON.stringify(settings)}) parity`, () => {
      assert.equal(
        local.resolveGeographyAlias(token, settings),
        published.resolveGeographyAlias(token, settings)
      );
    });
  }

  // ── schema accept/reject parity on representative payloads ───────────────
  const validSource = {
    id: "src1",
    outlet: "Example",
    kind: "traditional",
    weight: 80,
    url: "https://example.com",
    minutesAgo: 10,
    headline: "Headline",
    body: ["Paragraph one."],
  };
  const validStory = {
    id: "s1",
    title: "Title",
    geographies: ["US"],
    topic: "Diplomatic relations",
    takeaway: "Take",
    summary: "Sum",
    whyItMatters: "Why",
    whatChanged: "What",
    priority: "standard",
    outletCount: 2,
    tags: { topics: [], keywords: [], geographies: [] },
    sources: [validSource],
  };
  const validSettings = {
    contractVersion: published.CONTRACT_VERSION,
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
    traditionalSources: ["NYT"],
    socialSources: ["@handle"],
  };
  const validDashboard = {
    contractVersion: published.CONTRACT_VERSION,
    stories: [validStory],
  };

  const schemaCases = [
    ["sourceSchema", validSource, true],
    ["sourceSchema", { ...validSource, url: "" }, false],
    ["storySchema", validStory, true],
    ["storySchema", { ...validStory, tags: undefined }, false],
    ["dashboardPayloadSchema", validDashboard, true],
    [
      "dashboardPayloadSchema",
      { ...validDashboard, contractVersion: "wrong" },
      false,
    ],
    ["settingsPayloadSchema", validSettings, true],
    [
      "settingsPayloadSchema",
      { ...validSettings, contractVersion: "wrong" },
      false,
    ],
  ];

  for (const [schemaName, payload, expectedSuccess] of schemaCases) {
    test(`${schemaName} ${expectedSuccess ? "accepts" : "rejects"} sample parity`, () => {
      const localResult = local[schemaName].safeParse(payload);
      const publishedResult = published[schemaName].safeParse(payload);
      assert.equal(localResult.success, expectedSuccess);
      assert.equal(localResult.success, publishedResult.success);
    });
  }
}
