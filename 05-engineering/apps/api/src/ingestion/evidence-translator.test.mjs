import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_TRANSLATION_VERSION,
  TRANSLATION_COVERAGE_THRESHOLD,
  TRANSLATION_MAX_CHARS,
  TRANSLATION_MODE,
  buildEvidenceSegments,
  computeStoryCoverage,
  computeTranslationActivation,
  isNonEnglishItem,
  readBody,
  readBodyText,
  readHeadline,
  resolveTranslationConfig,
  resolveTranslationMode,
  translateEvidenceItems,
} from "./evidence-translator.mjs";

test("evidence-translator.mjs source is plain text — contains no NUL byte", () => {
  const path = fileURLToPath(new URL("./evidence-translator.mjs", import.meta.url));
  const buf = readFileSync(path);
  assert.equal(buf.includes(0x00), false, "module source must not embed a raw NUL byte (binary-diff regression)");
});

test("translateEvidenceItems: cache still distinguishes segment boundaries (hash separator intact)", async () => {
  let calls = 0;
  const translateFn = async (segs) => {
    calls++;
    return segs.map((s) => s.toUpperCase());
  };
  const cache = new Map();
  const mk = (id, headline, body) => ({ sourceId: id, lang: "es", headline, body, outlet: "X", kind: "traditional",weight: 50, url: "u", minutesAgo: 1 });
  await translateEvidenceItems({ items: [mk("a", "a b", ["c"])], translateFn, config: { enabled: true, concurrency:1, timeoutMs: 1000, maxChars: 700, maxSnippets: 2 }, cache });
  await translateEvidenceItems({ items: [mk("a", "a", ["b c"])], translateFn, config: { enabled: true, concurrency:1, timeoutMs: 1000, maxChars: 700, maxSnippets: 2 }, cache });
  assert.equal(calls, 2, "different segment boundaries must not share a cache entry");
});

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

function withTranslationEnv(vars, fn) {
  const keys = ["TEMPO_TRANSLATION_ENABLED", "TEMPO_TRANSLATION_MODE"];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("resolveTranslationMode: default is auto when nothing is set", () => {
  withTranslationEnv({}, () => {
    assert.equal(resolveTranslationMode(), TRANSLATION_MODE.AUTO);
    assert.equal(resolveTranslationMode(), "auto");
  });
});

test("resolveTranslationMode: TEMPO_TRANSLATION_MODE selects auto/on/off (case-insensitive)", () => {
  withTranslationEnv({ TEMPO_TRANSLATION_MODE: "on" }, () => assert.equal(resolveTranslationMode(), "on"));
  withTranslationEnv({ TEMPO_TRANSLATION_MODE: "OFF" }, () => assert.equal(resolveTranslationMode(), "off"));
  withTranslationEnv({ TEMPO_TRANSLATION_MODE: " Auto " }, () => assert.equal(resolveTranslationMode(), "auto"));
});

test("resolveTranslationMode: unrecognized mode falls through to the auto default", () => {
  withTranslationEnv({ TEMPO_TRANSLATION_MODE: "spanish" }, () =>
    assert.equal(resolveTranslationMode(), "auto")
  );
});

test("resolveTranslationMode: legacy TEMPO_TRANSLATION_ENABLED overrides mode (precedence)", () => {
  withTranslationEnv({ TEMPO_TRANSLATION_ENABLED: "true", TEMPO_TRANSLATION_MODE: "off" }, () =>
    assert.equal(resolveTranslationMode(), "on")
  );
  withTranslationEnv({ TEMPO_TRANSLATION_ENABLED: "false", TEMPO_TRANSLATION_MODE: "on" }, () =>
    assert.equal(resolveTranslationMode(), "off")
  );
  withTranslationEnv({ TEMPO_TRANSLATION_ENABLED: "1" }, () => assert.equal(resolveTranslationMode(), "on"));
  withTranslationEnv({ TEMPO_TRANSLATION_ENABLED: "0" }, () => assert.equal(resolveTranslationMode(), "off"));
});

test("resolveTranslationConfig: carries the resolved mode; default auto → enabled false", () => {
  withTranslationEnv({}, () => {
    const cfg = resolveTranslationConfig();
    assert.equal(cfg.mode, "auto");
    assert.equal(cfg.enabled, false, "auto resolves the runtime half in the pipeline, not statically");
  });
  withTranslationEnv({ TEMPO_TRANSLATION_MODE: "on" }, () => {
    const cfg = resolveTranslationConfig();
    assert.equal(cfg.mode, "on");
    assert.equal(cfg.enabled, true);
  });
});

test("computeTranslationActivation: auto runs only when non-English evidence is present", () => {
  const withEs = computeTranslationActivation({ mode: "auto", nonEnglishPresent: true, hasTranslateFn: true });
  assert.equal(withEs.shouldRun, true);
  assert.equal(withEs.required, true);
  assert.equal(withEs.unavailable, false);
  assert.equal(withEs.recallRisk, false);

  const noEs = computeTranslationActivation({ mode: "auto", nonEnglishPresent: false, hasTranslateFn: true });
  assert.equal(noEs.shouldRun, false);
  assert.equal(noEs.required, false);
  assert.equal(noEs.unavailable, false);
  assert.equal(noEs.recallRisk, false);
});

test("computeTranslationActivation: off never runs; required+unavailable when ES present (mode_off)", () => {
  const off = computeTranslationActivation({ mode: "off", nonEnglishPresent: true, hasTranslateFn: true });
  assert.equal(off.shouldRun, false);
  assert.equal(off.required, true);
  assert.equal(off.unavailable, true);
  assert.equal(off.unavailableReason, "mode_off");
  assert.equal(off.recallRisk, true);
});

test("computeTranslationActivation: on forces a translation attempt even without ES feeds", () => {
  const on = computeTranslationActivation({ mode: "on", nonEnglishPresent: false, hasTranslateFn: true });
  assert.equal(on.shouldRun, true);
  assert.equal(on.required, false);
  assert.equal(on.unavailable, false);
  assert.equal(on.recallRisk, false);
});

test("computeTranslationActivation: needed-but-unavailable sets recallRisk + a precise reason", () => {
  const noFn = computeTranslationActivation({
    mode: "auto",
    nonEnglishPresent: true,
    hasTranslateFn: false,
    hasApiKey: true,
  });
  assert.equal(noFn.recallRisk, true);
  assert.equal(noFn.unavailableReason, "provider_unavailable");

  const mock = computeTranslationActivation({
    mode: "on",
    nonEnglishPresent: true,
    hasTranslateFn: false,
    mockOnly: true,
  });
  assert.equal(mock.recallRisk, true);
  assert.equal(mock.unavailableReason, "mock_only");

  const noKey = computeTranslationActivation({
    mode: "on",
    nonEnglishPresent: true,
    hasTranslateFn: false,
    hasApiKey: false,
  });
  assert.equal(noKey.recallRisk, true);
  assert.equal(noKey.unavailableReason, "missing_key");
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

// ── A6: wall-clock budget (maxWallClockMs) ────────────────────────────────────
//
// Budget is enforced at the SCHEDULING boundary: a pMap worker that picks up a
// cache-miss item after the stage budget is spent defers it (no new call) with
// the canonical reason "wall_clock_budget_exhausted". In-flight calls finish.
// Deferral is NOT a failure — failedCount / degradedFallbackRate exclude it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUDGET_REASON = "wall_clock_budget_exhausted";

test("A6 (A): generous budget → identical to baseline (all translated, no skips)", async () => {
  const translateFn = async (segs) => segs.map((s) => s.toUpperCase());
  const items = [esItem("a", "uno", ["dos"]), esItem("b", "tres", ["cuatro"]), esItem("c", "cinco", ["seis"])];

  const baseline = await translateEvidenceItems({ items, translateFn, config: CONFIG_ON });
  const budgeted = await translateEvidenceItems({
    items,
    translateFn,
    config: { ...CONFIG_ON, maxWallClockMs: 100000 },
  });

  // Translation outcome is byte-identical to the un-budgeted run.
  assert.equal(budgeted.diagnostics.translatedCount, baseline.diagnostics.translatedCount);
  assert.equal(budgeted.diagnostics.neededCount, 3);
  assert.equal(budgeted.diagnostics.translatedCount, 3);
  assert.equal(budgeted.diagnostics.failedCount, 0);
  for (const it of budgeted.items) {
    assert.equal(it._translation.applied, true);
    assert.equal(it._translation.reason, null);
  }
  // New diagnostics: budget recorded, but never hit.
  assert.equal(budgeted.diagnostics.wallClockBudgetMs, 100000);
  assert.equal(budgeted.diagnostics.wallClockBudgetHit, false);
  assert.equal(budgeted.diagnostics.wallClockSkippedCount, 0);
  // Baseline (no budget) reports a null budget and the additive fields exist.
  assert.equal(baseline.diagnostics.wallClockBudgetMs, null);
  assert.equal(baseline.diagnostics.wallClockBudgetHit, false);
  assert.equal(baseline.diagnostics.wallClockSkippedCount, 0);
});

test("A6 (B): tiny budget → only the early in-flight subset translated; rest deferred with budget reason", async () => {
  // concurrency 2 + an 80ms translate sleep + a 30ms budget: the first 2 items
  // start in-flight at elapsed ~0 (< 30) and translate; by the time they finish
  // (~80ms) the budget is spent, so every later item is deferred, not called.
  const translateFn = async (segs) => {
    await sleep(80);
    return segs.map((s) => s.toUpperCase());
  };
  const items = Array.from({ length: 6 }, (_, i) => esItem(`es-${i}`, `t${i}`, [`b${i}`]));
  const { items: out, diagnostics } = await translateEvidenceItems({
    items,
    translateFn,
    config: { ...CONFIG_ON, concurrency: 2, maxWallClockMs: 30 },
  });

  // Exactly the 2 in-flight items translated; the other 4 deferred.
  assert.equal(diagnostics.translatedCount, 2, "only the in-flight (concurrency) items translated");
  assert.equal(diagnostics.wallClockSkippedCount, 4);
  assert.equal(diagnostics.wallClockBudgetHit, true);
  assert.equal(diagnostics.wallClockBudgetMs, 30);
  // Coherence: every needed item is translated, failed, or budget-deferred.
  assert.equal(diagnostics.neededCount, 6);
  assert.equal(diagnostics.translatedCount + diagnostics.failedCount + diagnostics.wallClockSkippedCount, 6);
  // Budget defer is NOT a failure → failure metrics stay clean.
  assert.equal(diagnostics.failedCount, 0);
  assert.equal(diagnostics.timeoutCount, 0);
  assert.equal(diagnostics.degradedFallbackRate, 0, "skipped items do not inflate the failure rate");

  // Results are index-aligned: the first two applied, the rest deferred.
  assert.equal(out[0]._translation.applied, true);
  assert.equal(out[1]._translation.applied, true);
  for (let i = 2; i < 6; i++) {
    const tr = out[i]._translation;
    assert.equal(tr.reason, BUDGET_REASON, `out[${i}] deferred for budget`);
    assert.equal(tr.needed, true);
    assert.equal(tr.applied, false);
    assert.equal(tr.failed, false);
    assert.equal(tr.fromCache, false);
    assert.equal(tr.lang, "es");
    assert.equal(out[i].normalizedHeadline, undefined, "deferred item is left untranslated (fail-open)");
  }
});

test("A6 (C): in-flight calls complete even when the budget is crossed mid-flight (concurrency > 1)", async () => {
  // concurrency 3 + 100ms sleep + 20ms budget: 3 calls start before the budget
  // is spent and must ALL finish (the guard never cancels in-flight work); the
  // remaining 2 items, pulled after the calls resolve, are deferred.
  const started = [];
  const translateFn = async (segs, { sourceId }) => {
    started.push(sourceId);
    await sleep(100);
    return segs.map((s) => s.toUpperCase());
  };
  const items = Array.from({ length: 5 }, (_, i) => esItem(`es-${i}`, `t${i}`, [`b${i}`]));
  const { items: out, diagnostics } = await translateEvidenceItems({
    items,
    translateFn,
    config: { ...CONFIG_ON, concurrency: 3, maxWallClockMs: 20 },
  });

  assert.equal(started.length, 3, "exactly the concurrency-many calls were started");
  assert.equal(diagnostics.translatedCount, 3, "all started calls completed despite crossing the budget");
  assert.equal(diagnostics.wallClockSkippedCount, 2);
  assert.equal(diagnostics.wallClockBudgetHit, true);
  assert.equal(diagnostics.failedCount, 0, "in-flight completion is not a failure");
  for (let i = 0; i < 3; i++) assert.equal(out[i]._translation.applied, true);
  for (let i = 3; i < 5; i++) assert.equal(out[i]._translation.reason, BUDGET_REASON);
});

test("A6: non-finite / non-positive budget is inert (unbounded, no new behavior)", async () => {
  const translateFn = async (segs) => segs.map((s) => s.toUpperCase());
  const items = [esItem("a", "uno", ["dos"]), esItem("b", "tres", ["cuatro"])];
  for (const bad of [0, -5, NaN, Infinity, "30", null, undefined]) {
    const { diagnostics } = await translateEvidenceItems({
      items,
      translateFn,
      config: { ...CONFIG_ON, maxWallClockMs: bad },
    });
    assert.equal(diagnostics.wallClockBudgetMs, null, `budget=${String(bad)} → unbounded (null)`);
    assert.equal(diagnostics.wallClockBudgetHit, false);
    assert.equal(diagnostics.wallClockSkippedCount, 0);
    assert.equal(diagnostics.translatedCount, 2, "all items translated when unbounded");
  }
});

test("A6: cache hits are still served after the budget is spent (defers calls, not free lookups)", async () => {
  // Pre-warm the cache for es-0, then run with a tiny budget and a slow stub.
  // es-0 should be served from cache (free) even though es-1 is budget-deferred.
  const slow = async (segs) => {
    await sleep(80);
    return segs.map((s) => s.toUpperCase());
  };
  const cache = new Map();
  await translateEvidenceItems({ items: [esItem("es-0", "uno", ["dos"])], translateFn: slow, config: CONFIG_ON, cache });

  // First worker burns the budget on es-1 (cache miss, slow); a later worker that
  // reaches the spent budget still serves es-0 from cache.
  const items = [esItem("es-1", "tres", ["cuatro"]), esItem("es-0", "uno", ["dos"])];
  const { items: out, diagnostics } = await translateEvidenceItems({
    items,
    translateFn: slow,
    config: { ...CONFIG_ON, concurrency: 1, maxWallClockMs: 30 },
    cache,
  });
  const byId = Object.fromEntries(out.map((it) => [it.sourceId, it._translation]));
  assert.equal(byId["es-1"].applied, true, "the first (in-flight) call completed");
  assert.equal(byId["es-0"].fromCache, true, "cache hit served despite the spent budget");
  assert.equal(byId["es-0"].applied, true);
  assert.equal(diagnostics.wallClockSkippedCount, 0, "a cache hit is not a deferred call");
  assert.equal(diagnostics.cacheHits, 1);
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
