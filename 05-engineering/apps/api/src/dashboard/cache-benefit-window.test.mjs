import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CACHE_BENEFIT_DEFAULTS,
  CACHE_BENEFIT_REASON,
  classifyRunMode,
  median,
  computeCacheBenefit,
  recordCacheBenefitRun,
  summarizeCacheBenefitWindow,
  getCacheBenefitWindow,
  resetCacheBenefitWindow,
} from "./cache-benefit-window.mjs";

// ─── helpers ────────────────────────────────────────────────────────────────
function runs(spec) {
  // spec: array of [mode, pipelineMs]
  return spec.map(([mode, pipelineMs]) => ({ mode, pipelineMs }));
}
const cache = (ms) => ["cache_hit", ms];
const live = (ms) => ["live_scoped", ms];

// ─── classifyRunMode ─────────────────────────────────────────────────────────
test("classifyRunMode maps ingestion sources onto the two comparison modes", () => {
  assert.equal(classifyRunMode("cache"), "cache_hit");
  assert.equal(classifyRunMode("live_scoped"), "live_scoped");
  assert.equal(classifyRunMode("live"), "other");
  assert.equal(classifyRunMode(undefined), "other");
});

// ─── median ──────────────────────────────────────────────────────────────────
test("median handles odd, even, and empty inputs", () => {
  assert.equal(median([100]), 100);
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([100, 200, 300, 400]), 250);
  assert.equal(median([]), null);
  assert.equal(median([NaN, "x", undefined]), null);
});

// ─── computeCacheBenefit: healthy pass ───────────────────────────────────────
test("computeCacheBenefit passes when cache p50 is >=20% faster and hit rate >=60%", () => {
  // 7 cache_hit + 5 live_scoped → cache windows full, hit window (last 10) is 6/10 cache? build explicitly.
  const window = runs([
    live(200), cache(100), live(210), cache(110), live(190),
    cache(105), live(205), cache(95), live(200), cache(100),
    cache(102), cache(98),
  ]);
  const v = computeCacheBenefit(window);
  assert.equal(v.cacheP50, 100); // last 5 cache: 105,95,100,102,98 → sorted 95,98,100,102,105 → 100
  assert.equal(v.liveP50, 200); // last 5 live: 200,210,190,205,200 → 200
  assert.ok(v.improvementPct >= 0.2, `improvement ${v.improvementPct}`);
  // hit window = last 10 comparable: indices 2..11 → 6 cache, 4 live → 60%
  assert.equal(v.hitRate, 0.6);
  assert.equal(v.ok, true);
  assert.deepEqual(v.reasonCodes, []);
});

// ─── computeCacheBenefit: improvement too small ──────────────────────────────
test("computeCacheBenefit fails when improvement < 20%", () => {
  const window = runs([
    cache(185), live(200), cache(180), live(205), cache(182),
    live(198), cache(181), live(202), cache(180), live(200),
  ]);
  const v = computeCacheBenefit(window);
  assert.ok(v.improvementPct < 0.2);
  assert.equal(v.ok, false);
  assert.ok(v.reasonCodes.includes(CACHE_BENEFIT_REASON.IMPROVEMENT_BELOW_THRESHOLD));
});

// ─── computeCacheBenefit: hit rate too low ───────────────────────────────────
test("computeCacheBenefit fails when cache-hit rate < 60% even if cache is fast", () => {
  // 5 cache + 5 live but with live-heavy recent arrival → last-10 window is 50%.
  const window = runs([
    cache(100), live(200), live(210), cache(100), live(190),
    cache(100), live(205), live(200), cache(100), cache(100),
  ]);
  const v = computeCacheBenefit(window);
  // hit window = last 10 = 5 cache / 5 live → 50% < 60%
  assert.equal(v.hitRate, 0.5);
  assert.equal(v.ok, false);
  assert.ok(v.reasonCodes.includes(CACHE_BENEFIT_REASON.HIT_RATE_BELOW_THRESHOLD));
});

// ─── computeCacheBenefit: insufficient sample ────────────────────────────────
test("computeCacheBenefit fails when either mode has < 5 runs in the window", () => {
  const window = runs([cache(100), live(200), cache(100), live(200), cache(100), live(200)]);
  const v = computeCacheBenefit(window);
  assert.equal(v.ok, false);
  assert.ok(v.reasonCodes.includes(CACHE_BENEFIT_REASON.INSUFFICIENT_SAMPLE));
  assert.equal(v.sampleCounts.cacheHit, 3);
  assert.equal(v.sampleCounts.liveScoped, 3);
});

test("computeCacheBenefit ignores 'other'/full-live runs and non-finite timings", () => {
  const window = [
    ...runs([
      live(200), cache(100), live(200), cache(100), live(200),
      cache(100), live(200), cache(100), live(200), cache(100),
      cache(100), cache(100),
    ]),
    { mode: "other", pipelineMs: 50 },
    { mode: "cache_hit", pipelineMs: NaN },
  ];
  const v = computeCacheBenefit(window);
  assert.equal(v.sampleCounts.comparable, 12); // other + NaN excluded
  assert.equal(v.hitRate, 0.6); // last-10 window is 6 cache / 4 live
  assert.equal(v.ok, true);
});

test("computeCacheBenefit flags improvement_unmeasurable when live p50 is 0", () => {
  const window = runs([
    cache(100), live(0), cache(100), live(0), cache(100),
    live(0), cache(100), live(0), cache(100), live(0),
  ]);
  const v = computeCacheBenefit(window);
  assert.equal(v.liveP50, 0);
  assert.equal(v.improvementPct, null);
  assert.equal(v.ok, false);
  assert.ok(v.reasonCodes.includes(CACHE_BENEFIT_REASON.IMPROVEMENT_UNMEASURABLE));
});

test("CACHE_BENEFIT_DEFAULTS encodes the locked D1 thresholds", () => {
  assert.equal(CACHE_BENEFIT_DEFAULTS.medianWindow, 5);
  assert.equal(CACHE_BENEFIT_DEFAULTS.minImprovementPct, 0.2);
  assert.equal(CACHE_BENEFIT_DEFAULTS.minHitRate, 0.6);
});

// ─── runtime recorder ────────────────────────────────────────────────────────
test("recordCacheBenefitRun keeps only comparable, finite runs and bounds the window", () => {
  resetCacheBenefitWindow();
  recordCacheBenefitRun({ mode: "cache_hit", pipelineMs: 100 });
  recordCacheBenefitRun({ mode: "live_scoped", pipelineMs: 200 });
  recordCacheBenefitRun({ mode: "other", pipelineMs: 50 }); // ignored
  recordCacheBenefitRun({ mode: "cache_hit", pipelineMs: NaN }); // ignored
  const win = getCacheBenefitWindow();
  assert.equal(win.length, 2);
  assert.deepEqual(win, [
    { mode: "cache_hit", pipelineMs: 100 },
    { mode: "live_scoped", pipelineMs: 200 },
  ]);
  resetCacheBenefitWindow();
});

test("summarizeCacheBenefitWindow reflects recorded runs", () => {
  resetCacheBenefitWindow();
  for (const [mode, ms] of [
    cache(100), live(200), cache(100), live(200), cache(100),
    live(200), cache(100), live(200), cache(100), live(200),
    cache(100), cache(100),
  ]) {
    recordCacheBenefitRun({ mode, pipelineMs: ms });
  }
  const v = summarizeCacheBenefitWindow();
  assert.equal(v.cacheP50, 100);
  assert.equal(v.liveP50, 200);
  assert.equal(v.ok, true);
  resetCacheBenefitWindow();
});
