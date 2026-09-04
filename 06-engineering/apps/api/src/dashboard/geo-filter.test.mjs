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
  resolveGeoAssessRpmCap,
  createGeoDiagnostics,
  hasStrongLexicalGeoSignal,
  _resetGeoRateLimiter,
  _geoTiming,
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

// ─── A2: lexical geo pre-pass ────────────────────────────────────────────────
//
// Before queuing an implicit/conflict candidate for the (rate-limited, LLM)
// assessor, `applyGeoFilter` checks for a strong lexical geo signal — a
// configured-geography mention in the item text via the shared
// `itemMentionsConfiguredGeography` matcher. A hit admits the item without an
// assess call and bumps `diag.lexicalBypassCount`. These tests pin the bypass,
// the no-signal fall-through, that explicit_match is untouched, and that the
// counter is request-scoped (no cross-run bleed).

// An assessor that throws if ever called — proves the pre-pass admitted the
// item WITHOUT touching the LLM path.
const FAIL_IF_ASSESSED = async () => {
  throw new Error("assessFn must not be called when the lexical pre-pass admits the item");
};

test("hasStrongLexicalGeoSignal: true when text names a configured geography, false otherwise", () => {
  assert.equal(
    hasStrongLexicalGeoSignal(makeItem({ headline: "Colombia readies new policy", body: [] }), CONFIGURED_GEOS),
    true
  );
  assert.equal(
    hasStrongLexicalGeoSignal(makeItem({ headline: "Local fisheries report", body: ["No geo here."] }), CONFIGURED_GEOS),
    false
  );
  // No configured geographies → never a strong signal.
  assert.equal(hasStrongLexicalGeoSignal(makeItem({ headline: "Colombia news" }), []), false);
});

test("applyGeoFilter: implicit_geo item with a lexical geo mention bypasses assess and is included", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [], headline: "US Treasury weighs new package", body: ["Details."] })];
  const diag = createGeoDiagnostics();
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS, FAIL_IF_ASSESSED, diag);
  assert.equal(included.length, 1, "lexical geo mention must admit without an assess call");
  assert.equal(held.length, 0);
  assert.equal(included[0].geoLexicalBypass, true);
  assert.equal(included[0].geoConfidence, 1.0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.IMPLICIT_GEO);
  assert.equal(diag.lexicalBypassCount, 1);
});

test("applyGeoFilter: explicit_conflict item with a lexical geo mention bypasses assess and is included", async () => {
  // Tagged geographies conflict (France), but the text clearly names a
  // configured geography (Colombia) → admit via the pre-pass.
  const items = [makeItem({ sourceId: "a", geographies: ["France"], headline: "Colombia and France sign accord", body: [] })];
  const diag = createGeoDiagnostics();
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS, FAIL_IF_ASSESSED, diag);
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoLexicalBypass, true);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.EXPLICIT_CONFLICT);
  assert.equal(diag.lexicalBypassCount, 1);
});

test("applyGeoFilter: item without a lexical geo signal still goes through assess", async () => {
  let assessCalls = 0;
  const items = [makeItem({ sourceId: "a", geographies: [], headline: "Local council budget talks", body: ["No geo."] })];
  const diag = createGeoDiagnostics();
  const assessFn = async () => { assessCalls += 1; return { confidence: 0.82 }; };
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS, assessFn, diag);
  assert.equal(assessCalls, 1, "no lexical signal → assessor must run");
  assert.equal(included.length, 1, "0.82 >= implicit threshold → included");
  assert.equal(held.length, 0);
  assert.equal(included[0].geoLexicalBypass, undefined, "assessed item is not flagged as a lexical bypass");
  assert.equal(diag.lexicalBypassCount, 0);
});

test("applyGeoFilter: explicit_match behavior unchanged — no assess, not flagged as lexical bypass", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["US"], headline: "US Treasury weighs new package" })];
  const diag = createGeoDiagnostics();
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS, FAIL_IF_ASSESSED, diag);
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.EXPLICIT_MATCH);
  assert.equal(included[0].geoConfidence, 1.0);
  assert.equal(included[0].geoLexicalBypass, undefined, "explicit_match must not be tagged as a lexical bypass");
  assert.equal(diag.lexicalBypassCount, 0, "explicit_match does not count as a lexical bypass");
});

test("applyGeoFilter: lexicalBypassCount counts each bypass and does not bleed across runs", async () => {
  const items = [
    makeItem({ sourceId: "a", geographies: [], headline: "US sanctions debated" }),       // bypass
    makeItem({ sourceId: "b", geographies: ["France"], headline: "Colombia accord signed" }), // bypass
    makeItem({ sourceId: "c", geographies: [], headline: "Local weather report", body: ["No geo."] }), // assessed
  ];
  const diagA = createGeoDiagnostics();
  await applyGeoFilter(items, CONFIGURED_GEOS, async () => ({ confidence: 0.85 }), diagA);
  assert.equal(diagA.lexicalBypassCount, 2, "two items admitted via the pre-pass");

  // A fresh run with a fresh diag starts at zero — no cross-run bleed.
  const diagB = createGeoDiagnostics();
  await applyGeoFilter(
    [makeItem({ sourceId: "d", geographies: [], headline: "Local weather report", body: ["No geo."] })],
    CONFIGURED_GEOS,
    async () => ({ confidence: 0.85 }),
    diagB
  );
  assert.equal(diagB.lexicalBypassCount, 0, "run B owns its own counter — Run A's bypasses must not bleed in");
});

test("applyGeoFilter: pre-pass works without a diag context (counter optional)", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [], headline: "US sanctions debated" })];
  const { included } = await applyGeoFilter(items, CONFIGURED_GEOS, FAIL_IF_ASSESSED);
  assert.equal(included.length, 1, "bypass must still admit the item when no diag is provided");
  assert.equal(included[0].geoLexicalBypass, true);
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
    rpmCap: process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP,
    apiKey: process.env.TEMPO_ANTHROPIC_API_KEY,
    altKey: process.env.ANTHROPIC_API_KEY,
    mockOnly: process.env.TEMPO_AI_MOCK_ONLY,
  };
  const prevCreate = _geoAssessClient.create;
  // A1: neutralize real waits and isolate the process-wide limiter state so
  // backoff/limiter spacing don't slow the suite and one test's dispatch
  // reservations can't bleed into the next. (Diagnostics are now request-local
  // per A1.2 — each test owns its own `diag` object, so there's nothing global
  // to reset.)
  const prevSleep = _geoTiming.sleep;
  _geoTiming.sleep = async () => {};
  _resetGeoRateLimiter();
  delete process.env.TEMPO_AI_GEO_ASSESS_MODEL;
  delete process.env.TEMPO_AI_GEO_ASSESS_TIMEOUT_MS;
  delete process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TEMPO_AI_MOCK_ONLY;
  setup();
  return run().finally(() => {
    _geoAssessClient.create = prevCreate;
    _geoTiming.sleep = prevSleep;
    _resetGeoRateLimiter();
    if (saved.rpmCap !== undefined) process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP = saved.rpmCap;
    else delete process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
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

// ─── A1: rate-limit cap + 429 retry/backoff + diagnostics ────────────────────
//
// A high concurrency setting lets a first-run refresh fire dozens of geo-assess
// calls in the same second and trip the Anthropic org RPM ceiling — a wall of
// `429 rate_limit_error` that drops relevant items into the hold bucket and
// starves clustering. A1 adds a process-wide dispatch cap
// (`TEMPO_AI_GEO_ASSESS_RPM_CAP`, default 48 since A1.2) and a bounded 429-only
// retry/backoff (max 2 retries) inside `assessGeoConfidence`. Retry/backoff
// counts accumulate onto a per-call, request-local `diag` context (A1.2) — no
// global counters. These tests pin the cap resolver and the retry envelopes —
// never hitting the live API (`_geoTiming.sleep` is neutralized in
// `withGeoAssessEnv`, so backoff/limiter waits resolve instantly).

function makeRateLimitError() {
  // Mirror the SDK shape (`status: 429`) and the message text logged in prod.
  const err = new Error("429 rate_limit_error");
  err.status = 429;
  return err;
}

test("resolveGeoAssessRpmCap: unset env → default 48 (A1.2)", () => {
  const saved = process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
  delete process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
  try {
    assert.equal(resolveGeoAssessRpmCap(), 48);
    assert.ok(resolveGeoAssessRpmCap() < 50, "default must stay under the 50 RPM org ceiling");
  } finally {
    if (saved !== undefined) process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP = saved;
  }
});

test("resolveGeoAssessRpmCap: invalid env → default 48 (A1.2)", () => {
  const saved = process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
  try {
    for (const bad of ["0", "-5", "abc", "", "NaN"]) {
      process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP = bad;
      assert.equal(resolveGeoAssessRpmCap(), 48, `"${bad}" must fall back to 48`);
    }
  } finally {
    if (saved !== undefined) process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP = saved;
    else delete process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
  }
});

test("resolveGeoAssessRpmCap: valid env honored (floored)", () => {
  const saved = process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
  try {
    process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP = "25.9";
    assert.equal(resolveGeoAssessRpmCap(), 25);
  } finally {
    if (saved !== undefined) process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP = saved;
    else delete process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP;
  }
});

test("assessGeoConfidence: 429 then success returns the parsed confidence and increments retry diagnostics", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      let calls = 0;
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => {
            calls += 1;
            if (calls === 1) throw makeRateLimitError();
            return { content: [{ type: "text", text: '{"confidence": 0.91}' }] };
          },
        },
      });
    },
    async () => {
      const diag = createGeoDiagnostics();
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS, diag);
      assert.equal(result.confidence, 0.91, "retried call must return the success-path confidence");
      assert.equal(diag.rateLimitedCount, 1);
      assert.equal(diag.retryCount, 1);
      assert.ok(diag.backoffMsTotal > 0, "backoff should be recorded");
    }
  );
});

test("assessGeoConfidence: repeated 429 exhausts retries and fails safe to confidence 0", async () => {
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => {
            throw makeRateLimitError();
          },
        },
      });
    },
    async () => {
      const diag = createGeoDiagnostics();
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS, diag);
      assert.deepEqual(result, { confidence: 0 });
      // initial attempt + 2 retries = 3 calls, all 429.
      assert.equal(diag.rateLimitedCount, 3);
      assert.equal(diag.retryCount, 2);
    }
  );
});

test("assessGeoConfidence: non-429 error fails safe without retrying", async () => {
  let calls = 0;
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => {
            calls += 1;
            throw new Error("provider 503");
          },
        },
      });
    },
    async () => {
      const diag = createGeoDiagnostics();
      const result = await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS, diag);
      assert.deepEqual(result, { confidence: 0 });
      assert.equal(calls, 1, "a non-rate-limit error must not trigger the retry loop");
      assert.equal(diag.retryCount, 0);
      assert.equal(diag.rateLimitedCount, 0);
    }
  );
});

test("assessGeoConfidence: diagnostics are request-local — two runs don't bleed across each other", async () => {
  // A1.2 concurrency-safety: each run owns its own `diag`. Even with the same
  // process-global limiter, counts must not mix. Run A sees one 429-then-success
  // (1 rate-limit, 1 retry); Run B sees a clean success (0/0). Their diag
  // objects must reflect only their own pressure.
  await withGeoAssessEnv(
    () => {
      process.env.TEMPO_ANTHROPIC_API_KEY = "test-key";
    },
    async () => {
      const diagA = createGeoDiagnostics();
      const diagB = createGeoDiagnostics();

      // Run A: 429 then success.
      let aCalls = 0;
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => {
            aCalls += 1;
            if (aCalls === 1) throw makeRateLimitError();
            return { content: [{ type: "text", text: '{"confidence": 0.7}' }] };
          },
        },
      });
      await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS, diagA);

      // Run B: clean success, no rate limiting.
      _geoAssessClient.create = () => ({
        messages: {
          create: async () => ({ content: [{ type: "text", text: '{"confidence": 0.8}' }] }),
        },
      });
      await assessGeoConfidence(makeItem({ geographies: ["France"] }), CONFIGURED_GEOS, diagB);

      assert.deepEqual(diagA, { rateLimitedCount: 1, retryCount: 1, backoffMsTotal: diagA.backoffMsTotal, lexicalBypassCount: 0 });
      assert.ok(diagA.backoffMsTotal > 0, "Run A recorded backoff");
      assert.deepEqual(diagB, { rateLimitedCount: 0, retryCount: 0, backoffMsTotal: 0, lexicalBypassCount: 0 },
        "Run B's diagnostics must be untouched by Run A");
    }
  );
});
