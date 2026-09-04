/**
 * Tests for the Live Colombia-Election smoke eval core + runner.
 *
 * The LIVE fetch is the only non-deterministic step in production, so every test
 * STUBS `readItems` — no network is ever touched. Everything downstream (the
 * real `runRefreshPipeline` in lexical recall + the deterministic cluster stub)
 * runs for real, so these exercise the genuine relevance gates against
 * controlled "live" pools. We reuse the proven hermetic election fixtures as the
 * stubbed live pool so pipeline behavior matches the rest of the suite.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  runDashboardLiveColombiaElectionCore,
  _internal,
} from "./dashboard-live-colombia-election-core.mjs";
import {
  parseJsonOut,
  parseStrict,
  exitCodeFor,
  formatReport,
} from "./run-dashboard-live-colombia-election.mjs";
import {
  COLOMBIA_ELECTION_ITEMS,
  CROSS_COUNTRY_ELECTION_ITEMS,
  CAP_PRESSURE_RAW_ITEMS,
  ARGENTINA_FILM_DECOY,
} from "./dashboard-elections-colombia-core.mjs";

const TS = "2026-06-09T00:00:00.000Z";

// Stub fetch: returns a fixed pool (clone so the core's spread can't mutate the
// frozen fixtures). Never touches the network.
function stubReadItems(items) {
  return async () => items.map((i) => ({ ...i }));
}

function run(items, overrides = {}) {
  return runDashboardLiveColombiaElectionCore({
    readItems: stubReadItems(items),
    timestamp: TS,
    ...overrides,
  });
}

function checkByName(result, name) {
  return result.checks.find((c) => c.name === name);
}

// ── Output shape stability ────────────────────────────────────────────────────

test("result has the stable normalized shape", async () => {
  const result = await run([
    ...COLOMBIA_ELECTION_ITEMS,
    ...CROSS_COUNTRY_ELECTION_ITEMS,
  ]);

  assert.equal(typeof result.ok, "boolean");
  assert.ok(Array.isArray(result.checks));
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.timestamp, TS);
  assert.ok(result.stats && typeof result.stats === "object");
  assert.ok(result.diagnostics && typeof result.diagnostics === "object");

  // Every check is well-formed.
  for (const c of result.checks) {
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.pass, "boolean");
    assert.equal(typeof c.detail, "string");
  }
  // All five named checks are present exactly once.
  const names = result.checks.map((c) => c.name).sort();
  assert.deepEqual(names, [
    "cap-behavior",
    "decision-5c-ordering",
    "election-presence",
    "feed-non-empty",
    "geo-noise-guard",
  ]);

  // Stats carry the expected numeric keys.
  for (const k of [
    "rawCount",
    "candidateCount",
    "clusterInputCount",
    "finalCount",
    "electionCount",
    "configuredGeoElectionCount",
    "crossCountryElectionCount",
  ]) {
    assert.equal(typeof result.stats[k], "number", `stats.${k} is a number`);
  }
});

// ── Happy path ────────────────────────────────────────────────────────────────

test("happy path: election present, cap not exercised, 5C observable + passing", async () => {
  // 8 configured-geo + 3 cross-country = 11 surviving (< cap 15). No decoys —
  // the Senegal decoy is itself a cross-country election and the Argentina film
  // is geo-noise, both of which would muddy the exact class counts asserted here.
  const result = await run([
    ...COLOMBIA_ELECTION_ITEMS,
    ...CROSS_COUNTRY_ELECTION_ITEMS,
  ]);

  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  assert.equal(checkByName(result, "feed-non-empty").pass, true);
  assert.equal(checkByName(result, "election-presence").pass, true);

  const cap = checkByName(result, "cap-behavior");
  assert.equal(cap.pass, true);
  assert.equal(cap.neutral, true, "cap should be neutral (pool ≤ cap)");

  const d5c = checkByName(result, "decision-5c-ordering");
  assert.equal(d5c.pass, true);
  assert.ok(!d5c.neutral, "5C should be observable with both classes present");

  assert.equal(result.stats.configuredGeoElectionCount, COLOMBIA_ELECTION_ITEMS.length);
  assert.equal(result.stats.crossCountryElectionCount, CROSS_COUNTRY_ELECTION_ITEMS.length);
});

// ── Thin feed ─────────────────────────────────────────────────────────────────

test("thin-feed: feed-non-empty fails with actionable detail, never throws", async () => {
  const result = await run(COLOMBIA_ELECTION_ITEMS.slice(0, 3));

  assert.equal(result.ok, false);
  const feed = checkByName(result, "feed-non-empty");
  assert.equal(feed.pass, false);
  assert.match(feed.detail, /insufficient live volume/i);
  assert.equal(result.stats.rawCount, 3);
});

test("respects a custom minLivePool floor", async () => {
  const result = await run(COLOMBIA_ELECTION_ITEMS.slice(0, 3), { minLivePool: 2 });
  assert.equal(checkByName(result, "feed-non-empty").pass, true);
});

// ── Election presence ─────────────────────────────────────────────────────────

test("election-presence fails (not throws) when the window has no election signal", async () => {
  // A single non-election, geo-only Colombia item.
  const nonElection = {
    ...COLOMBIA_ELECTION_ITEMS[0],
    sourceId: "col-weather-1",
    headline: "Colombia braces for heavy rains across the Andean region",
    body: ["A Colombia weather advisory issued by local authorities."],
  };
  // Pad to clear the feed-non-empty floor so we isolate the election check.
  const pool = Array.from({ length: 6 }, (_, i) => ({
    ...nonElection,
    sourceId: `col-weather-${i}`,
  }));

  const result = await run(pool);
  const presence = checkByName(result, "election-presence");
  assert.equal(presence.pass, false);
  assert.match(presence.detail, /no election signal/i);
  assert.equal(result.stats.electionCount, 0);
});

// ── Cap exercised vs not ──────────────────────────────────────────────────────

test("cap exercised: >15 surviving candidates ⇒ coherent cap diagnostics", async () => {
  // CAP_PRESSURE_RAW_ITEMS surviving pool = 20 (> CLUSTER_INPUT_CAP 15).
  const result = await run([...CAP_PRESSURE_RAW_ITEMS]);

  const cap = checkByName(result, "cap-behavior");
  assert.equal(cap.pass, true, cap.detail);
  assert.ok(!cap.neutral, "cap should be exercised, not neutral");
  assert.ok(result.stats.dedupedCount > result.stats.clusterInputCapEffective);
  assert.equal(result.stats.clusterInputCount, result.stats.clusterInputCapEffective);
  assert.equal(
    result.stats.clusterDroppedCount,
    result.stats.dedupedCount - result.stats.clusterInputCount
  );
});

test("cap not exercised: small pool ⇒ neutral cap check", async () => {
  const result = await run([
    ...COLOMBIA_ELECTION_ITEMS,
    ...CROSS_COUNTRY_ELECTION_ITEMS,
  ]);
  const cap = checkByName(result, "cap-behavior");
  assert.equal(cap.neutral, true);
  assert.match(cap.detail, /cap not exercised/i);
});

// ── Opportunistic checks become "not observable" ──────────────────────────────

test("decision-5c is neutral when only configured-geo elections are present", async () => {
  const result = await run([
    ...COLOMBIA_ELECTION_ITEMS, // all configured-geo, no cross-country
    ARGENTINA_FILM_DECOY, // non-election geo-noise (does NOT add a cross-country election)
  ]);

  const d5c = checkByName(result, "decision-5c-ordering");
  assert.equal(d5c.neutral, true);
  assert.equal(d5c.pass, true);
  assert.match(d5c.detail, /not observable/i);
  assert.equal(result.stats.crossCountryElectionCount, 0);
  // A neutral opportunistic check never fails the overall run on its own.
  assert.equal(result.ok, true);
});

test("geo-noise-guard is neutral when overflow is not exercised", async () => {
  // A handful of items rarely overflows the 5-story cap with the family-keyed
  // stub; the guard reports neutral with an explicit reason.
  const result = await run([
    ...COLOMBIA_ELECTION_ITEMS.slice(0, 5),
    ...CROSS_COUNTRY_ELECTION_ITEMS,
  ]);
  const guard = checkByName(result, "geo-noise-guard");
  if (!guard.pass) assert.fail(guard.detail);
  // Whether neutral or active, the detail explains the geo-noise posture.
  assert.match(guard.detail, /geo-noise|overflow/i);
});

// ── Bounded diagnostics ───────────────────────────────────────────────────────

test("diagnostics stay bounded (no giant payloads)", async () => {
  const result = await run([...CAP_PRESSURE_RAW_ITEMS]);
  const d = result.diagnostics;

  assert.ok(d.electionSample.length <= 10, "electionSample capped at 10");
  assert.ok(d.clusterInputRankSample.length <= 10, "rankSample capped at 10");
  assert.ok(d.clusterDroppedSourceIds.length <= 10, "droppedIds capped at 10");
  assert.ok(d.overflowDroppedMetaStoryIds.length <= 10);
  assert.ok(d.shippedStoryIds.length <= 10);

  // No raw bodies leak into diagnostics — samples carry IDs + short headlines.
  for (const s of d.electionSample) {
    assert.equal(typeof s.sourceId, "string");
    assert.ok(s.headline.length <= 121, "headline truncated");
    assert.ok(!("body" in s), "no body field in diagnostics samples");
  }
  // The whole diagnostics blob serializes and stays small.
  const json = JSON.stringify(result);
  assert.ok(json.length < 20000, `diagnostics payload should be compact (${json.length} bytes)`);
});

// ── Fetch failure (advisory-friendly, no throw) ───────────────────────────────

test("fetch failure is a failing check, not a throw", async () => {
  const result = await runDashboardLiveColombiaElectionCore({
    readItems: async () => {
      throw new Error("ECONNREFUSED rss endpoint");
    },
    timestamp: TS,
  });

  assert.equal(result.ok, false);
  const feed = checkByName(result, "feed-non-empty");
  assert.equal(feed.pass, false);
  assert.match(feed.detail, /live feed fetch failed/i);
  assert.ok(result.warnings.some((w) => /fetch failed/i.test(w)));
  assert.equal(result.stats.rawCount, 0);
});

// ── True execution errors DO throw ────────────────────────────────────────────

test("non-array fetch result throws (bad config / contract breach)", async () => {
  await assert.rejects(
    runDashboardLiveColombiaElectionCore({
      readItems: async () => ({ not: "an array" }),
      timestamp: TS,
    }),
    /must resolve to an array/
  );
});

test("an injected pipeline crash propagates (true execution error)", async () => {
  await assert.rejects(
    runDashboardLiveColombiaElectionCore({
      readItems: stubReadItems(COLOMBIA_ELECTION_ITEMS),
      runPipeline: async () => {
        throw new Error("pipeline exploded");
      },
      timestamp: TS,
    }),
    /pipeline exploded/
  );
});

// ── Pre-cluster check units (no pipeline) ─────────────────────────────────────

test("unit: checkCapBehavior coherent vs incoherent", () => {
  const neutral = _internal.checkCapBehavior({ dedupedCount: 10, clusterInputCapEffective: 15 });
  assert.equal(neutral.neutral, true);

  const coherent = _internal.checkCapBehavior({
    dedupedCount: 20,
    clusterInputCount: 15,
    clusterDroppedCount: 5,
    clusterDroppedSourceIds: ["a", "b", "c", "d", "e"],
    clusterInputCapEffective: 15,
  });
  assert.equal(coherent.pass, true);

  const incoherent = _internal.checkCapBehavior({
    dedupedCount: 20,
    clusterInputCount: 12, // ≠ cap
    clusterDroppedCount: 5,
    clusterDroppedSourceIds: [],
    clusterInputCapEffective: 15,
  });
  assert.equal(incoherent.pass, false);
});

test("unit: checkGeoNoiseGuard coherent overflow", () => {
  const neutral = _internal.checkGeoNoiseGuard({ overflowCapApplied: false });
  assert.equal(neutral.neutral, true);

  const guardFired = _internal.checkGeoNoiseGuard({
    overflowCapApplied: true,
    overflowInputCount: 8,
    overflowOutputCount: 5,
    overflowDroppedCount: 3,
    thinOnBeatGuardApplied: true,
    thinOnBeatFilteredCount: 2,
  });
  assert.equal(guardFired.pass, true);

  const incoherent = _internal.checkGeoNoiseGuard({
    overflowCapApplied: true,
    overflowInputCount: 8,
    overflowOutputCount: 5,
    overflowDroppedCount: 1, // ≠ 8-5
    thinOnBeatGuardApplied: true,
    thinOnBeatFilteredCount: 0, // guard "applied" but filtered 0
  });
  assert.equal(incoherent.pass, false);
});

// ── Runner semantics ──────────────────────────────────────────────────────────

test("runner: parseJsonOut + parseStrict", () => {
  assert.equal(parseJsonOut(["--json-out", "/tmp/x.json"]), "/tmp/x.json");
  assert.equal(parseJsonOut(["--json-out=/tmp/y.json"]), "/tmp/y.json");
  assert.equal(parseJsonOut(["--strict"]), null);
  assert.equal(parseStrict(["--strict"]), true);
  assert.equal(parseStrict([]), false);
});

test("runner: advisory exit is 0 even when checks fail; strict is non-zero", () => {
  const failing = { ok: false, checks: [{ name: "feed-non-empty", pass: false }] };
  const passing = { ok: true, checks: [{ name: "feed-non-empty", pass: true }] };

  assert.equal(exitCodeFor(failing, { strict: false }), 0, "advisory: failures don't gate");
  assert.equal(exitCodeFor(failing, { strict: true }), 1, "strict: failure gates");
  assert.equal(exitCodeFor(passing, { strict: true }), 0, "strict: all-pass exits 0");

  // Neutral checks (pass:true) never gate strict mode.
  const neutralOnly = { ok: true, checks: [{ name: "cap-behavior", pass: true, neutral: true }] };
  assert.equal(exitCodeFor(neutralOnly, { strict: true }), 0);
});

test("runner: formatReport renders the sectioned report", async () => {
  const result = await run([
    ...COLOMBIA_ELECTION_ITEMS,
    ...CROSS_COUNTRY_ELECTION_ITEMS,
  ]);
  const report = formatReport(result, { strict: false });
  assert.match(report, /ADVISORY/);
  assert.match(report, /checks:/);
  assert.match(report, /key stats:/);
  assert.match(report, /feed-non-empty/);
  const strictReport = formatReport(result, { strict: true });
  assert.match(strictReport, /STRICT/);
});
