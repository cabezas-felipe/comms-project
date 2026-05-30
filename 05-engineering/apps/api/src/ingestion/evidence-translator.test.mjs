import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_TRANSLATION_VERSION,
  TRANSLATION_COVERAGE_THRESHOLD,
  TRANSLATION_MAX_CHARS,
  buildEvidenceSegments,
  computeStoryCoverage,
  isNonEnglishItem,
  readBody,
  readBodyText,
  readHeadline,
  resolveTranslationConfig,
  translateEvidenceItems,
} from "./evidence-translator.mjs";

// ── language signal ───────────────────────────────────────────────────────────

test("isNonEnglishItem: absent lang or en* is English (no translation needed)", () => {
  assert.equal(isNonEnglishItem({}), false);
  assert.equal(isNonEnglishItem({ lang: "en" }), false);
  assert.equal(isNonEnglishItem({ lang: "en-US" }), false);
  assert.equal(isNonEnglishItem({ lang: "  EN  " }), false);
});

test("isNonEnglishItem: non-English lang tags are flagged", () => {
  assert.equal(isNonEnglishItem({ lang: "es" }), true);
  assert.equal(isNonEnglishItem({ lang: "es-CO" }), true);
  assert.equal(isNonEnglishItem({ lang: "pt" }), true);
});

// ── evidence budget ───────────────────────────────────────────────────────────

test("buildEvidenceSegments: headline + first 2 snippets, headline slot preserved", () => {
  const segments = buildEvidenceSegments({
    headline: "Titular",
    body: ["uno", "dos", "tres", "cuatro"],
  });
  assert.deepEqual(segments, ["Titular", "uno", "dos"]);
});

test("buildEvidenceSegments: caps joined text at maxChars", () => {
  const long = "a".repeat(500);
  const segments = buildEvidenceSegments({ headline: long, body: [long, long] }, { maxChars: 700 });
  const total = segments.join("").length;
  assert.ok(total <= TRANSLATION_MAX_CHARS, `joined length ${total} must be <= ${TRANSLATION_MAX_CHARS}`);
  // Headline kept whole (500), then 200 chars of the first snippet.
  assert.equal(segments[0].length, 500);
  assert.equal(segments[1].length, 200);
});

test("buildEvidenceSegments: always returns a headline slot even when empty", () => {
  assert.deepEqual(buildEvidenceSegments({ headline: "", body: [] }), [""]);
});

// ── readers (normalized-when-present) ─────────────────────────────────────────

test("readers fall back to originals for English items", () => {
  const item = { headline: "Hello", body: ["world", "again"] };
  assert.equal(readHeadline(item), "Hello");
  assert.deepEqual(readBody(item), ["world", "again"]);
  assert.equal(readBodyText(item), "world again");
});

test("readers prefer normalized English evidence when present", () => {
  const item = {
    headline: "Hola",
    body: ["mundo"],
    normalizedHeadline: "Hello",
    normalizedBody: ["world", "again"],
  };
  assert.equal(readHeadline(item), "Hello");
  assert.deepEqual(readBody(item), ["world", "again"]);
  assert.equal(readBodyText(item), "world again");
});

// ── config ────────────────────────────────────────────────────────────────────

test("resolveTranslationConfig: default OFF; concurrency clamped", () => {
  const prevEnabled = process.env.TEMPO_TRANSLATION_ENABLED;
  const prevConc = process.env.TEMPO_TRANSLATION_CONCURRENCY;
  delete process.env.TEMPO_TRANSLATION_ENABLED;
  process.env.TEMPO_TRANSLATION_CONCURRENCY = "999";
  try {
    const cfg = resolveTranslationConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.concurrency, 8); // clamped to CONCURRENCY_MAX
  } finally {
    if (prevEnabled !== undefined) process.env.TEMPO_TRANSLATION_ENABLED = prevEnabled;
    else delete process.env.TEMPO_TRANSLATION_ENABLED;
    if (prevConc !== undefined) process.env.TEMPO_TRANSLATION_CONCURRENCY = prevConc;
    else delete process.env.TEMPO_TRANSLATION_CONCURRENCY;
  }
});

test("resolveTranslationConfig: TEMPO_TRANSLATION_ENABLED=true turns the stage on", () => {
  const prev = process.env.TEMPO_TRANSLATION_ENABLED;
  process.env.TEMPO_TRANSLATION_ENABLED = "true";
  try {
    assert.equal(resolveTranslationConfig().enabled, true);
  } finally {
    if (prev !== undefined) process.env.TEMPO_TRANSLATION_ENABLED = prev;
    else delete process.env.TEMPO_TRANSLATION_ENABLED;
  }
});

// ── translateEvidenceItems ─────────────────────────────────────────────────────

const CONFIG_ON = { enabled: true, concurrency: 4, timeoutMs: 1000, maxChars: 700, maxSnippets: 2 };

function esItem(id, headline, body) {
  return { sourceId: id, lang: "es", headline, body, outlet: "X", kind: "traditional", weight: 50, url: "u", minutesAgo: 1 };
}

test("translateEvidenceItems: disabled → passthrough, English items stamped as not-needed", async () => {
  const items = [esItem("a", "Hola", ["mundo"]), { sourceId: "b", headline: "Hi", body: ["there"] }];
  const { items: out, diagnostics } = await translateEvidenceItems({
    items,
    translateFn: async (segs) => segs,
    config: { ...CONFIG_ON, enabled: false },
  });
  assert.equal(diagnostics.enabled, false);
  assert.equal(out[0].normalizedHeadline, undefined, "no normalization when disabled");
  assert.equal(out[0]._translation.needed, true);
  assert.equal(out[0]._translation.applied, false);
  assert.equal(out[1]._translation.needed, false);
  // Disabled + non-English item → not covered (honest coverage).
  assert.equal(diagnostics.neededCount, 1);
});

test("translateEvidenceItems: enabled → non-English gets normalized fields; English untouched", async () => {
  const translateFn = async (segments) => segments.map((s) => s.replace(/migración/i, "migration"));
  const items = [
    esItem("a", "La migración crece", ["más migración"]),
    { sourceId: "b", lang: "en", headline: "English headline", body: ["english body"] },
  ];
  const { items: out, diagnostics } = await translateEvidenceItems({ items, translateFn, config: CONFIG_ON });
  // Non-English item normalized; originals retained (dual text).
  assert.equal(out[0].headline, "La migración crece");
  assert.equal(out[0].normalizedHeadline, "La migration crece");
  assert.deepEqual(out[0].normalizedBody, ["más migration"]);
  assert.equal(out[0]._translation.applied, true);
  // English item untouched, no normalized fields.
  assert.equal(out[1].normalizedHeadline, undefined);
  assert.equal(out[1]._translation.needed, false);
  assert.equal(diagnostics.translatedCount, 1);
  assert.equal(diagnostics.passthroughCount, 1);
  assert.equal(diagnostics.version, EVIDENCE_TRANSLATION_VERSION);
});

test("translateEvidenceItems: fail-open on throw — item passes through untranslated, refresh not blocked", async () => {
  const translateFn = async (_segs, { sourceId }) => {
    if (sourceId === "boom") throw new Error("provider down");
    return _segs;
  };
  const items = [esItem("ok", "uno", ["dos"]), esItem("boom", "tres", ["cuatro"])];
  const { items: out, diagnostics } = await translateEvidenceItems({ items, translateFn, config: CONFIG_ON });
  assert.equal(out[0]._translation.applied, true);
  assert.equal(out[1]._translation.applied, false);
  assert.equal(out[1]._translation.failed, true);
  assert.equal(out[1]._translation.reason, "error");
  assert.equal(out[1].normalizedHeadline, undefined);
  assert.equal(diagnostics.failedCount, 1);
  assert.equal(diagnostics.translatedCount, 1);
});

test("translateEvidenceItems: timeout fails open and is counted", async () => {
  const translateFn = () => new Promise((resolve) => setTimeout(() => resolve(["x"]), 50));
  const items = [esItem("slow", "uno", ["dos"])];
  const { items: out, diagnostics } = await translateEvidenceItems({
    items,
    translateFn,
    config: { ...CONFIG_ON, timeoutMs: 10 },
  });
  assert.equal(out[0]._translation.failed, true);
  assert.equal(out[0]._translation.reason, "timeout");
  assert.equal(diagnostics.timeoutCount, 1);
  assert.equal(diagnostics.failedCount, 1);
});

test("translateEvidenceItems: cache hit on identical source/text key (no second translateFn call)", async () => {
  let calls = 0;
  const translateFn = async (segs) => {
    calls++;
    return segs.map((s) => s.toUpperCase());
  };
  const cache = new Map();
  const item = esItem("a", "hola", ["mundo"]);
  const first = await translateEvidenceItems({ items: [item], translateFn, config: CONFIG_ON, cache });
  const second = await translateEvidenceItems({ items: [{ ...item }], translateFn, config: CONFIG_ON, cache });
  assert.equal(calls, 1, "second run must hit cache");
  assert.equal(first.diagnostics.cacheHits, 0);
  assert.equal(second.diagnostics.cacheHits, 1);
  assert.equal(second.items[0].normalizedHeadline, "HOLA");
});

test("translateEvidenceItems: invalid response (wrong segment count) fails open", async () => {
  const translateFn = async () => ["only-one"]; // expected 2 (headline + 1 snippet)
  const { items: out, diagnostics } = await translateEvidenceItems({
    items: [esItem("a", "uno", ["dos"])],
    translateFn,
    config: CONFIG_ON,
  });
  assert.equal(out[0]._translation.failed, true);
  assert.equal(diagnostics.failedCount, 1);
});

// ── coverage ────────────────────────────────────────────────────────────────

test("computeStoryCoverage: all English → full confidence", () => {
  const cov = computeStoryCoverage([
    { _translation: { needed: false } },
    { _translation: { needed: false } },
  ]);
  assert.equal(cov.coverage, 1);
  assert.equal(cov.degraded, false);
  assert.equal(cov.confidence, "full");
});

test("computeStoryCoverage: translated non-English counts as covered", () => {
  const cov = computeStoryCoverage([
    { _translation: { needed: true, applied: true } },
    { _translation: { needed: true, applied: true } },
  ]);
  assert.equal(cov.coverage, 1);
  assert.equal(cov.translatedCount, 2);
  assert.equal(cov.degraded, false);
});

test("computeStoryCoverage: below threshold → degraded/low", () => {
  const cov = computeStoryCoverage([
    { _translation: { needed: true, applied: true } }, // covered
    { _translation: { needed: true, applied: false, failed: true } }, // not covered
    { _translation: { needed: true, applied: false, failed: true } }, // not covered
  ]);
  assert.ok(cov.coverage < TRANSLATION_COVERAGE_THRESHOLD);
  assert.equal(cov.degraded, true);
  assert.equal(cov.confidence, "low");
});

test("computeStoryCoverage: empty story is trivially full-confidence", () => {
  const cov = computeStoryCoverage([]);
  assert.equal(cov.coverage, 1);
  assert.equal(cov.degraded, false);
});
