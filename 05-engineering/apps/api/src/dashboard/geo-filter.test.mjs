import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEO_CATEGORY,
  CONFLICT_THRESHOLD,
  IMPLICIT_THRESHOLD,
  DEFAULT_GEO_ASSESS_MODEL,
  categorizeItem,
  mockAssessGeoConfidence,
  applyGeoFilter,
  assessGeoConfidence,
  parseGeoAssessResponse,
  resolveGeoAssessConcurrency,
  _geoAssessClient,
} from "./geo-filter.mjs";

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    outlet: "Reuters",
    topic: "Diplomatic relations",
    geographies: ["US"],
    weight: 75,
    url: "https://example.com",
    minutesAgo: 30,
    headline: "Test headline",
    body: ["Test body."],
    kind: "traditional",
    ...overrides,
  };
}

const CONFIGURED_GEOS = ["US", "Colombia"];

// ─── categorizeItem ───────────────────────────────────────────────────────────

test("categorizeItem: explicit_match when item geos overlap with configured geos", () => {
  const item = makeItem({ geographies: ["US"] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.EXPLICIT_MATCH);
});

test("categorizeItem: explicit_match when item has multiple geos and at least one matches", () => {
  const item = makeItem({ geographies: ["Colombia", "Brazil"] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.EXPLICIT_MATCH);
});

test("categorizeItem: explicit_conflict when item has geos but none match", () => {
  const item = makeItem({ geographies: ["France", "Brazil"] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.EXPLICIT_CONFLICT);
});

test("categorizeItem: implicit_geo when item geographies is empty", () => {
  const item = makeItem({ geographies: [] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.IMPLICIT_GEO);
});

// ─── mockAssessGeoConfidence ──────────────────────────────────────────────────

test("mockAssessGeoConfidence: returns confidence between 0 and 1", () => {
  const { confidence } = mockAssessGeoConfidence(makeItem(), CONFIGURED_GEOS);
  assert.ok(confidence >= 0 && confidence <= 1);
});

test("mockAssessGeoConfidence: returns confidence above implicit threshold (0.80) but below conflict threshold (0.90)", () => {
  const { confidence } = mockAssessGeoConfidence(makeItem(), CONFIGURED_GEOS);
  assert.ok(confidence >= IMPLICIT_THRESHOLD, `confidence ${confidence} must be >= ${IMPLICIT_THRESHOLD}`);
  assert.ok(confidence < CONFLICT_THRESHOLD, `confidence ${confidence} must be < ${CONFLICT_THRESHOLD}`);
});

// ─── applyGeoFilter ───────────────────────────────────────────────────────────

test("applyGeoFilter: passes all items when configured geos is empty (topic+keyword-only mode)", async () => {
  const items = [
    makeItem({ sourceId: "a", geographies: ["France"] }),
    makeItem({ sourceId: "b", geographies: [] }),
  ];
  const { included, held } = await applyGeoFilter(items, []);
  assert.equal(included.length, 2);
  assert.equal(held.length, 0);
});

test("applyGeoFilter: explicit_match items always included with geoConfidence=1.0", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["US"] })];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.EXPLICIT_MATCH);
  assert.equal(included[0].geoConfidence, 1.0);
});

test("applyGeoFilter: explicit_match not affected by assessFn result", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["US"] })];
  const { included } = await applyGeoFilter(items, CONFIGURED_GEOS, async () => ({ confidence: 0.0 }));
  assert.equal(included.length, 1, "explicit_match must include regardless of assessFn");
});

test("applyGeoFilter: explicit_conflict item included when confidence >= 0.90", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["France"] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.92 })
  );
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.EXPLICIT_CONFLICT);
});

test("applyGeoFilter: explicit_conflict item held when confidence < 0.90", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["France"] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.89 })
  );
  assert.equal(included.length, 0);
  assert.equal(held.length, 1);
  assert.equal(held[0].geoCategory, GEO_CATEGORY.EXPLICIT_CONFLICT);
  assert.equal(held[0].geoConfidence, 0.89);
});

test("applyGeoFilter: implicit_geo item included when confidence >= 0.80", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.82 })
  );
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.IMPLICIT_GEO);
});

test("applyGeoFilter: implicit_geo item held when confidence < 0.80", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.79 })
  );
  assert.equal(included.length, 0);
  assert.equal(held.length, 1);
  assert.equal(held[0].geoCategory, GEO_CATEGORY.IMPLICIT_GEO);
});

test("applyGeoFilter: default mock assessor includes implicit_geo items (0.85 >= 0.80)", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [] })];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.equal(included.length, 1, "mock assessor (0.85) must pass implicit threshold");
  assert.equal(held.length, 0);
});

test("applyGeoFilter: default mock assessor holds explicit_conflict items (0.85 < 0.90)", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["France"] })];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.equal(included.length, 0, "mock assessor (0.85) must not pass conflict threshold");
  assert.equal(held.length, 1);
});

test("applyGeoFilter: mixed batch routes items correctly", async () => {
  const items = [
    makeItem({ sourceId: "match", geographies: ["US"] }),          // explicit_match → included
    makeItem({ sourceId: "conflict", geographies: ["France"] }),   // explicit_conflict, 0.85 < 0.90 → held
    makeItem({ sourceId: "implicit", geographies: [] }),           // implicit_geo, 0.85 >= 0.80 → included
  ];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.deepEqual(included.map((i) => i.sourceId).sort(), ["implicit", "match"]);
  assert.deepEqual(held.map((i) => i.sourceId), ["conflict"]);
});

test("applyGeoFilter: held items preserve original item fields", async () => {
  const item = makeItem({ sourceId: "held-item", headline: "Original headline", geographies: ["France"] });
  const { held } = await applyGeoFilter([item], CONFIGURED_GEOS, async () => ({ confidence: 0.0 }));
  assert.equal(held[0].sourceId, "held-item");
  assert.equal(held[0].headline, "Original headline");
});

// ─── Slice 1: bounded-concurrency geo-assess pool ────────────────────────────
//
// geo-assess runs one Haiku call per implicit/conflict item.  Slice 1 pushes
// those calls through a bounded worker pool (default 8) instead of sequentially
// so the stage stops starving clustering on a first-run refresh.

function withGeoConcurrencyEnv(value, run) {
  const saved = process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY;
  if (value === undefined) delete process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY;
  else process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY = value;
  return run().finally(() => {
    if (saved !== undefined) process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY = saved;
    else delete process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY;
  });
}

test("resolveGeoAssessConcurrency: unset env → default concurrency 8", () => {
  const saved = process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY;
  delete process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY;
  try {
    assert.equal(resolveGeoAssessConcurrency(), 8);
  } finally {
    if (saved !== undefined) process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY = saved;
  }
});

test("applyGeoFilter: runs the assess pool concurrently (8 at a time, not sequential)", async () => {
  // 16 implicit_geo items, each assess call sleeps 50ms. With concurrency=8
  // they complete in two waves (~100ms) rather than 16 sequential calls
  // (~800ms). Generous upper bound keeps the test stable on slow CI.
  const items = Array.from({ length: 16 }, (_, i) =>
    makeItem({ sourceId: `imp-${i}`, geographies: [] })
  );
  const assessFn = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { confidence: 0.85 }; // >= IMPLICIT_THRESHOLD → included
  };

  await withGeoConcurrencyEnv("8", async () => {
    const start = Date.now();
    const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS, assessFn);
    const elapsed = Date.now() - start;
    assert.equal(included.length, 16);
    assert.equal(held.length, 0);
    assert.ok(
      elapsed < 400,
      `expected ~2 waves (~100ms) with concurrency=8, got ${elapsed}ms (sequential would be ~800ms)`
    );
  });
});

test("applyGeoFilter: a single rejecting assess call holds only that item (index-aligned, fail-safe)", async () => {
  // assessFn throws for exactly one item; pMap captures it as a per-index
  // rejection. The rejected item must land in `held` with geoConfidence 0 and
  // its own sourceId — never mis-attributed to another item via indexOf.
  const items = [
    makeItem({ sourceId: "ok-0", geographies: [] }),
    makeItem({ sourceId: "boom-1", geographies: [] }),
    makeItem({ sourceId: "ok-2", geographies: [] }),
  ];
  const assessFn = async (item) => {
    if (item.sourceId === "boom-1") throw new Error("assess blew up");
    return { confidence: 0.85 };
  };

  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS, assessFn);
  assert.deepEqual(included.map((i) => i.sourceId).sort(), ["ok-0", "ok-2"]);
  assert.equal(held.length, 1);
  assert.equal(held[0].sourceId, "boom-1");
  assert.equal(held[0].geoConfidence, 0);
  assert.equal(held[0].geoCategory, GEO_CATEGORY.IMPLICIT_GEO);
});

test("applyGeoFilter: multiple rejecting assess calls each map to their own item", async () => {
  // Two rejections in one batch — the bug indexOf would have masked: both
  // rejected results compare equal-ish and indexOf returns the first match for
  // every one, mis-mapping the second. Index-aligned iteration keeps them
  // distinct.
  const items = [
    makeItem({ sourceId: "boom-a", geographies: [] }),
    makeItem({ sourceId: "ok", geographies: [] }),
    makeItem({ sourceId: "boom-b", geographies: [] }),
  ];
  const assessFn = async (item) => {
    if (item.sourceId.startsWith("boom")) throw new Error("nope");
    return { confidence: 0.85 };
  };

  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS, assessFn);
  assert.deepEqual(included.map((i) => i.sourceId), ["ok"]);
  assert.deepEqual(held.map((i) => i.sourceId).sort(), ["boom-a", "boom-b"]);
  assert.ok(held.every((i) => i.geoConfidence === 0));
});

// ─── M4 / F3b: real Anthropic assessGeoConfidence ────────────────────────────
//
// The production geo assessor is `assessGeoConfidence`, defaulting to Haiku 4.5
// (`anthropic:claude-haiku-4-5-20251001`).  These tests pin:
//   1. Parser semantics (clamp, malformed input → 0).
//   2. Fail-safe envelopes (missing key, SDK throw, timeout, empty body → 0).
//   3. Happy path via stubbed Anthropic client.
//   4. `TEMPO_AI_MOCK_ONLY=true` routes through `mockAssessGeoConfidence`.
//
// Tests never hit the live Anthropic API — they swap `_geoAssessClient.create`
// for a deterministic stub OR rely on the missing-key fail-safe.

function withGeoAssessEnv(setup, run) {
  const saved = {
    model: process.env.TEMPO_AI_GEO_ASSESS_MODEL,
    timeout: process.env.TEMPO_AI_GEO_ASSESS_TIMEOUT_MS,
    apiKey: process.env.TEMPO_ANTHROPIC_API_KEY,
    altKey: process.env.ANTHROPIC_API_KEY,
    mockOnly: process.env.TEMPO_AI_MOCK_ONLY,
  };
  const prevCreate = _geoAssessClient.create;
  delete process.env.TEMPO_AI_GEO_ASSESS_MODEL;
  delete process.env.TEMPO_AI_GEO_ASSESS_TIMEOUT_MS;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TEMPO_AI_MOCK_ONLY;
  setup();
  return run().finally(() => {
    _geoAssessClient.create = prevCreate;
    // Restore each key to its captured value, or DELETE it when it was unset
    // before the test.  Without the `else delete`, a var the test newly set
    // (e.g. TEMPO_AI_GEO_ASSESS_MODEL / API keys) would leak into every later
    // test in the suite and silently flip downstream geo-assessment routing.
    if (saved.model !== undefined) process.env.TEMPO_AI_GEO_ASSESS_MODEL = saved.model;
    else delete process.env.TEMPO_AI_GEO_ASSESS_MODEL;
    if (saved.timeout !== undefined) process.env.TEMPO_AI_GEO_ASSESS_TIMEOUT_MS = saved.timeout;
    else delete process.env.TEMPO_AI_GEO_ASSESS_TIMEOUT_MS;
    if (saved.apiKey !== undefined) process.env.TEMPO_ANTHROPIC_API_KEY = saved.apiKey;
    else delete process.env.TEMPO_ANTHROPIC_API_KEY;
    if (saved.altKey !== undefined) process.env.ANTHROPIC_API_KEY = saved.altKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (saved.mockOnly !== undefined) process.env.TEMPO_AI_MOCK_ONLY = saved.mockOnly;
    else delete process.env.TEMPO_AI_MOCK_ONLY;
  });
}

test("DEFAULT_GEO_ASSESS_MODEL is Haiku 4.5 (N2 SKU lock)", () => {
  assert.equal(DEFAULT_GEO_ASSESS_MODEL, "anthropic:claude-haiku-4-5-20251001");
});

test("parseGeoAssessResponse: extracts confidence from plain JSON", () => {
  assert.equal(parseGeoAssessResponse('{"confidence": 0.73}'), 0.73);
});

test("parseGeoAssessResponse: tolerates ```json``` code-fence wrapping", () => {
  assert.equal(parseGeoAssessResponse('```json\n{"confidence": 0.5}\n```'), 0.5);
});

test("parseGeoAssessResponse: clamps confidence above 1 down to 1", () => {
  assert.equal(parseGeoAssessResponse('{"confidence": 1.7}'), 1);
});

test("parseGeoAssessResponse: clamps negative confidence up to 0", () => {
  assert.equal(parseGeoAssessResponse('{"confidence": -0.4}'), 0);
});

test("parseGeoAssessResponse: returns 0 when confidence is non-numeric", () => {
  assert.equal(parseGeoAssessResponse('{"confidence": "maybe"}'), 0);
});

test("parseGeoAssessResponse: throws on malformed JSON (caller handles fail-safe)", () => {
  assert.throws(() => parseGeoAssessResponse("not json at all"));
});

test("assessGeoConfidence: fails safe with confidence=0 when ANTHROPIC_API_KEY is absent", async () => {
  await withGeoAssessEnv(() => {}, async () => {
    const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
    assert.deepEqual(result, { confidence: 0 });
  });
});

test("assessGeoConfidence: TEMPO_AI_MOCK_ONLY=true routes through mockAssessGeoConfidence (CI safety)", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_AI_MOCK_ONLY = "true";
      // Even without a key, mock branch must return 0.85.
    },
    async () => {
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
      assert.equal(result.confidence, 0.85);
    }
  );
});

test("assessGeoConfidence: happy path parses stubbed Anthropic response", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => ({
            content: [{ type: "text", text: '{"confidence": 0.92}' }],
          }),
        },
      });
    },
    async () => {
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
      assert.equal(result.confidence, 0.92);
    }
  );
});

test("assessGeoConfidence: passes resolved model name (no `anthropic:` prefix) to client", async () => {
  let seenModel = null;
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async ({ model }) => {
            seenModel = model;
            return { content: [{ type: "text", text: '{"confidence": 0.6}' }] };
          },
        },
      });
    },
    async () => {
      await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
      assert.equal(seenModel, "claude-haiku-4-5-20251001");
    }
  );
});

test("assessGeoConfidence: honors TEMPO_AI_GEO_ASSESS_MODEL env override", async () => {
  let seenModel = null;
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-sonnet-4-6";
      _geoAssessClient.create = () => ({
        messages: {
          create: async ({ model }) => {
            seenModel = model;
            return { content: [{ type: "text", text: '{"confidence": 0.4}' }] };
          },
        },
      });
    },
    async () => {
      await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
      assert.equal(seenModel, "claude-sonnet-4-6");
    }
  );
});

test("assessGeoConfidence: fails safe with confidence=0 on SDK throw", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => { throw new Error("provider 503"); },
        },
      });
    },
    async () => {
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
      assert.deepEqual(result, { confidence: 0 });
    }
  );
});

test("assessGeoConfidence: fails safe with confidence=0 on empty text block", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => ({ content: [{ type: "text", text: "" }] }),
        },
      });
    },
    async () => {
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
      assert.deepEqual(result, { confidence: 0 });
    }
  );
});

test("assessGeoConfidence: fails safe with confidence=0 on malformed JSON body", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => ({ content: [{ type: "text", text: "I think yes" }] }),
        },
      });
    },
    async () => {
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS);
      assert.deepEqual(result, { confidence: 0 });
    }
  );
});

test("assessGeoConfidence: integrates with applyGeoFilter — held when stubbed confidence below threshold", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => ({ content: [{ type: "text", text: '{"confidence": 0.5}' }] }),
        },
      });
    },
    async () => {
      // implicit_geo needs >= 0.80 — 0.5 → held.
      const { included, held } = await applyGeoFilter(
        [makeItem({ sourceId: "x", geographies: [] })],
        CONFIGURED_GEOS,
        assessGeoConfidence
      );
      assert.equal(included.length, 0);
      assert.equal(held.length, 1);
      assert.equal(held[0].geoConfidence, 0.5);
    }
  );
});
