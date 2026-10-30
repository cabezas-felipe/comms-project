/**
 * Pre-cluster Weight Calibration — Core (side-effect-free)  ·  Decision 10D
 *
 * A hermetic harness that sweeps candidate WEIGHT PRESETS for the pre-cluster
 * relevance scorer against a fixed synthetic fixture, and reports decision-quality
 * metrics per preset so a future weight change can be evidence-backed instead of
 * guessed. It changes NO runtime default: the production scorer
 * (`computePreClusterRelevanceScore`) keeps using `RELEVANCE_WEIGHTS`; this module
 * re-implements the SAME composite formula with an injectable weights object and
 * reuses the production FIT primitives (`computeItemTopicKeywordGeoFit`,
 * `computeBeatDensity`, `classifyElectionGeo`) so only the weighting differs.
 *
 * Faithfulness guardrail: the `baseline` preset is pinned to the production
 * weights + the Decision-5C election-geo shaping constants, and the harness
 * asserts the baseline preset reproduces the EXACT ranking of the production
 * scorer on the fixture (`baselineFaithful`). If the production formula ever
 * drifts from this replica, the harness fails loudly rather than calibrating
 * against a stale model.
 *
 * Hermetic + import-safe: deterministic synthetic items, no pipeline run, no
 * network / provider / DB, no env reads, no console, no `process.exit`. The CLI
 * runner (`run-dashboard-precluster-calibration.mjs`) owns formatting + exit
 * codes; the quality gate may also call `runPreclusterCalibration` in-process.
 */

import {
  RELEVANCE_WEIGHTS,
} from "../../dashboard/relevance-policy.mjs";
import {
  buildPreClusterPoolIndex,
  computeItemTopicKeywordGeoFit,
  computeBeatDensity,
  classifyElectionGeo,
  computePreClusterRelevanceScore,
  comparePreClusterRank,
} from "../../dashboard/pre-cluster-relevance.mjs";
import { scoreBeatFit } from "../../dashboard/beat-fit-scorer.mjs";

// ── Production-mirrored constants (Decision 5C election-geo shaping) ───────────
// These mirror the (non-exported) constants in pre-cluster-relevance.mjs. The
// `baseline` preset uses them so its ranking equals production's; the
// `baselineFaithful` check would catch any drift.
export const PRODUCTION_ELECTION_GEO_BOOST = 1.5;
export const PRODUCTION_ELECTION_GEO_PENALTY = 0.75;

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Freshness replica (pre-cluster-relevance.mjs `freshnessFromMinutes` is private).
// Gentle monotonic decay in minutesAgo, bounded (0, 1], 12h-ish scale.
function freshnessFromMinutes(minutesAgo) {
  const m =
    typeof minutesAgo === "number" && Number.isFinite(minutesAgo)
      ? minutesAgo
      : Number.POSITIVE_INFINITY;
  if (m < 0 || !Number.isFinite(m)) return 0;
  return 1 / (1 + m / 720);
}

// ── Candidate weight presets ──────────────────────────────────────────────────
//
// `baseline` is the reference (production weights). The rest are deliberate
// perturbations spanning the tuning space: a stronger beat emphasis (still
// sane), two degenerate extremes that SHOULD violate a hard invariant
// (geography-dominant, recency-dominant), and a flat control. Variants that
// violate an invariant are reported but never "recommended".
export const PRECLUSTER_PRESETS = Object.freeze([
  {
    name: "baseline",
    description: "Production RELEVANCE_WEIGHTS + Decision-5C election-geo shaping",
    weights: { ...RELEVANCE_WEIGHTS },
    electionGeoBoost: PRODUCTION_ELECTION_GEO_BOOST,
    electionGeoPenalty: PRODUCTION_ELECTION_GEO_PENALTY,
  },
  {
    name: "beat_dominant",
    description: "Stronger topic/keyword emphasis (topic=keyword=4)",
    weights: { ...RELEVANCE_WEIGHTS, topic: 4, keyword: 4 },
    electionGeoBoost: PRODUCTION_ELECTION_GEO_BOOST,
    electionGeoPenalty: PRODUCTION_ELECTION_GEO_PENALTY,
  },
  {
    name: "geo_heavy",
    description: "Geography-dominant (geo=15, topic=keyword=1, no election-geo shaping) — degenerate",
    weights: { ...RELEVANCE_WEIGHTS, topic: 1, keyword: 1, geo: 15 },
    electionGeoBoost: 0,
    electionGeoPenalty: 0,
  },
  {
    name: "freshness_heavy",
    description: "Recency-dominant (freshness=20) — degenerate",
    weights: { ...RELEVANCE_WEIGHTS, freshness: 20 },
    electionGeoBoost: PRODUCTION_ELECTION_GEO_BOOST,
    electionGeoPenalty: PRODUCTION_ELECTION_GEO_PENALTY,
  },
  {
    name: "flat",
    description: "All fit dimensions weighted 1, no election-geo shaping — control",
    weights: { topic: 1, keyword: 1, entity: 1, geo: 1, corroboration: 1, beatFit: 1, freshness: 1 },
    electionGeoBoost: 0,
    electionGeoPenalty: 0,
  },
]);

// ── Fixed synthetic fixture ───────────────────────────────────────────────────
//
// Settings mirror the elections-Colombia beat (topics/keywords/geographies). Each
// item carries a `role` the metrics read so we never re-derive intent:
//   configuredElection — on-beat election ON the configured geography (Colombia)
//   crossCountryElection — election elsewhere (implicit geo, not Colombia)
//   geoNoise          — configured-geo but off-beat (weather / volcano)
//   offBeat           — wrong geo AND wrong beat (sinks / hard-fails)
// `pc-tie-a` / `pc-tie-z` are byte-identical except sourceId so the deterministic
// final tie-break (sourceId ascending) is observable.
export const PRECLUSTER_FIXTURE_SETTINGS = Object.freeze({
  topics: ["Elections"],
  keywords: ["election"],
  geographies: ["Colombia"],
});

export const PRECLUSTER_CAP = 3;
export const PRECLUSTER_TIE_PAIR = Object.freeze(["pc-tie-a", "pc-tie-z"]);

function fx(sourceId, role, overrides) {
  return {
    role,
    item: {
      sourceId,
      outlet: "Reuters",
      kind: "traditional",
      weight: 70,
      byline: "Staff",
      ...overrides,
    },
  };
}

export const PRECLUSTER_FIXTURE = Object.freeze([
  // On-beat configured-geo election — deliberately the OLDEST (minutesAgo 600) so
  // a sane preset must still rank it top on relevance, not recency.
  fx("pc-el-cfg", "configuredElection", {
    topic: "Elections",
    geographies: ["Colombia"],
    headline: "Colombia presidential election race tightens before the vote",
    body: ["Campaign closes as the presidential election nears."],
    minutesAgo: 600,
  }),
  // Cross-country election — implicit geo (no tag, no Colombia mention) so it is
  // NOT a hard-fail; Decision 5C dampens it relative to the configured one.
  fx("pc-el-cross", "crossCountryElection", {
    topic: "Elections",
    geographies: [],
    headline: "Mexico runoff vote count continues nationwide",
    body: ["Officials tally the runoff vote across the country."],
    minutesAgo: 30,
  }),
  // Geo-noise: configured geography, off-beat (weather), fresh.
  fx("pc-geo-volcano", "geoNoise", {
    topic: "Environment",
    geographies: ["Colombia"],
    headline: "Nevado del Ruiz volcano activity prompts alerts in Colombia",
    body: ["Authorities monitor rising volcanic activity."],
    minutesAgo: 8,
  }),
  // Tie pair: identical Colombia weather geo-noise, fresh, differ only by id.
  fx("pc-tie-a", "geoNoise", {
    topic: "Weather",
    geographies: ["Colombia"],
    headline: "Colombia Caribbean coast braces for heavy rain",
    body: ["Heavy rain forecast along the coast."],
    minutesAgo: 5,
  }),
  fx("pc-tie-z", "geoNoise", {
    topic: "Weather",
    geographies: ["Colombia"],
    headline: "Colombia Caribbean coast braces for heavy rain",
    body: ["Heavy rain forecast along the coast."],
    minutesAgo: 5,
  }),
  // Off-beat foreign — wrong geo (explicit conflict → geo hard-fail) and off-beat.
  fx("pc-off-foreign", "offBeat", {
    topic: "Weather",
    geographies: ["Japan"],
    headline: "Tokyo weekend weather outlook stays mild",
    body: ["Mild conditions expected across Tokyo."],
    minutesAgo: 3,
  }),
]);

// ── Preset scoring ────────────────────────────────────────────────────────────

// Re-implement the production composite with an injectable preset. Reuses the
// production FIT primitives so only the weighting/shaping differs. Returns a sort
// key shaped for `comparePreClusterRank`.
function scoreItemWithPreset(item, settings, poolIndex, preset) {
  const { topicFit, keywordFit, geoFit } = computeItemTopicKeywordGeoFit(item, settings);
  const corroboration = clamp01(computeBeatDensity(item, poolIndex));
  const beatFit = clamp01(scoreBeatFit(item, settings).score);
  const freshness = freshnessFromMinutes(item?.minutesAgo);
  const electionGeoClass = classifyElectionGeo(item, settings);
  const electionGeoBoost =
    electionGeoClass === "configuredGeoElection"
      ? preset.electionGeoBoost
      : electionGeoClass === "crossCountryElection"
        ? -preset.electionGeoPenalty
        : 0;

  const W = preset.weights;
  const preClusterScore =
    W.topic * topicFit +
    W.keyword * keywordFit +
    W.geo * geoFit +
    W.corroboration * corroboration +
    W.beatFit * beatFit +
    W.freshness * freshness +
    electionGeoBoost;

  return {
    preClusterScore,
    corroborationScore: corroboration,
    beatFitScore: beatFit,
    minutesAgo:
      typeof item?.minutesAgo === "number" && Number.isFinite(item.minutesAgo)
        ? item.minutesAgo
        : Number.POSITIVE_INFINITY,
    sourceId: item?.sourceId ?? "",
  };
}

// Rank a list of fixture entries by a preset; returns sourceIds best-first.
// Deterministic — sorts a copy via the production comparator (total order down to
// sourceId), so the input order never affects the output.
function rankWithPreset(fixture, settings, poolIndex, preset) {
  return fixture
    .map((entry) => ({
      sourceId: entry.item.sourceId,
      key: scoreItemWithPreset(entry.item, settings, poolIndex, preset),
    }))
    .sort((a, b) => comparePreClusterRank(a.key, b.key))
    .map((s) => s.sourceId);
}

// Production ranking (the real scorer + comparator) — the fidelity reference.
function rankWithProduction(fixture, settings, poolIndex) {
  return fixture
    .map((entry) => ({
      sourceId: entry.item.sourceId,
      key: computePreClusterRelevanceScore(entry.item, settings, poolIndex),
    }))
    .sort((a, b) => comparePreClusterRank(a.key, b.key))
    .map((s) => s.sourceId);
}

// ── Metrics + invariants ──────────────────────────────────────────────────────

function roleOf(fixture, sourceId) {
  return fixture.find((e) => e.item.sourceId === sourceId)?.role ?? null;
}

function evaluatePreset({ fixture, settings, poolIndex, preset, cap, productionOrder }) {
  const ranked = rankWithPreset(fixture, settings, poolIndex, preset);
  // Determinism / tie stability: ranking the fixture REVERSED must yield the
  // identical order (the comparator is total, so input order can't matter), and
  // the designated tie pair must resolve sourceId-ascending.
  const reversedOrder = rankWithPreset([...fixture].reverse(), settings, poolIndex, preset);
  const orderStable = ranked.length === reversedOrder.length && ranked.every((id, i) => id === reversedOrder[i]);
  const [tieA, tieZ] = PRECLUSTER_TIE_PAIR;
  const tieAResolvesFirst = ranked.indexOf(tieA) < ranked.indexOf(tieZ);
  const tieStable = orderStable && tieAResolvesFirst;

  const survivorsAtCap = ranked.slice(0, cap);
  const rankIndex = (id) => ranked.indexOf(id);
  const idsByRole = (role) => fixture.filter((e) => e.role === role).map((e) => e.item.sourceId);

  const configuredElectionIds = idsByRole("configuredElection");
  const crossCountryIds = idsByRole("crossCountryElection");
  const geoNoiseIds = idsByRole("geoNoise");

  const configuredElectionRank = Math.min(...configuredElectionIds.map(rankIndex));
  const crossCountryRank = crossCountryIds.length ? Math.min(...crossCountryIds.map(rankIndex)) : Infinity;

  const electionSurvivesCap = configuredElectionIds.some((id) => survivorsAtCap.includes(id));
  const electionItemsInCap = survivorsAtCap.filter(
    (id) => roleOf(fixture, id) === "configuredElection" || roleOf(fixture, id) === "crossCountryElection"
  ).length;
  const geoNoiseInCap = survivorsAtCap.filter((id) => roleOf(fixture, id) === "geoNoise").length;

  // Suppression quality: geo-noise must not outrank the on-beat election, AND
  // must not outrank the (weaker-geo) cross-country election either.
  const geoNoiseLeakedAboveConfiguredElection = geoNoiseIds.filter(
    (id) => rankIndex(id) < configuredElectionRank
  ).length;
  const geoNoiseLeakedAboveCrossCountry = geoNoiseIds.filter(
    (id) => rankIndex(id) < crossCountryRank
  ).length;

  const configuredGeoBeatsCrossCountry = configuredElectionRank < crossCountryRank;
  const matchesProductionOrder =
    ranked.length === productionOrder.length && ranked.every((id, i) => id === productionOrder[i]);

  const invariants = {
    // ≥1 on-beat (configured-geo) election survives the cap.
    electionSurvivesCap,
    // No geo-noise leaks above either election (configured or cross-country).
    geoNoiseSuppressed:
      geoNoiseLeakedAboveConfiguredElection === 0 && geoNoiseLeakedAboveCrossCountry === 0,
    // Decision 5C: configured-geo election ranks above the cross-country one.
    configuredGeoOrdering: configuredGeoBeatsCrossCountry,
    // Deterministic tie resolution.
    tieStable,
  };
  const passesInvariants = Object.values(invariants).every(Boolean);

  return {
    preset: preset.name,
    description: preset.description,
    weights: { ...preset.weights },
    electionGeoBoost: preset.electionGeoBoost,
    electionGeoPenalty: preset.electionGeoPenalty,
    rankedSourceIds: ranked,
    survivorsAtCap,
    metrics: {
      electionSurvivesCap,
      electionItemsInCap,
      geoNoiseInCap,
      configuredElectionRank,
      crossCountryRank: Number.isFinite(crossCountryRank) ? crossCountryRank : null,
      geoNoiseLeakedAboveConfiguredElection,
      geoNoiseLeakedAboveCrossCountry,
      configuredGeoBeatsCrossCountry,
      tieStable,
      matchesProductionOrder,
    },
    invariants,
    passesInvariants,
    // A preset is only ever "recommended" when it holds every hard invariant.
    recommended: passesInvariants,
  };
}

/**
 * Run the pre-cluster weight calibration. Pure: no console, no exits, no Date.
 *
 * @param {object} [opts]
 * @param {ReadonlyArray} [opts.presets] — presets to sweep (default PRECLUSTER_PRESETS)
 * @param {number} [opts.cap] — survival cap used by the survival metrics (default PRECLUSTER_CAP)
 * @returns {{ cap, settings, fixtureRoles, productionRankedSourceIds, baselineFaithful, results, hardFail }}
 *   `hardFail` is true ONLY on a genuine guardrail failure — the baseline preset
 *   violating a hard invariant, or the baseline ranking diverging from production
 *   (`baselineFaithful === false`). A non-baseline preset failing an invariant
 *   is expected signal and never sets `hardFail`.
 */
export async function runPreclusterCalibration({
  presets = PRECLUSTER_PRESETS,
  cap = PRECLUSTER_CAP,
} = {}) {
  const fixture = PRECLUSTER_FIXTURE;
  const settings = PRECLUSTER_FIXTURE_SETTINGS;
  const items = fixture.map((e) => e.item);
  const poolIndex = buildPreClusterPoolIndex(items, settings);
  const productionRankedSourceIds = rankWithProduction(fixture, settings, poolIndex);

  const results = presets.map((preset) =>
    evaluatePreset({ fixture, settings, poolIndex, preset, cap, productionOrder: productionRankedSourceIds })
  );

  const baseline = results.find((r) => r.preset === "baseline") ?? null;
  const baselineFaithful = baseline ? baseline.metrics.matchesProductionOrder : false;
  const baselinePasses = baseline ? baseline.passesInvariants : false;

  return {
    cap,
    settings,
    fixtureRoles: fixture.map((e) => ({ sourceId: e.item.sourceId, role: e.role })),
    productionRankedSourceIds,
    baselineFaithful,
    results,
    hardFail: !baselineFaithful || !baselinePasses,
  };
}

// ── Artifact ──────────────────────────────────────────────────────────────────

// Stable identity for the JSON artifact. Bump `version` only on a breaking shape
// change.
export const PRECLUSTER_CALIBRATION_HARNESS = "dashboard-precluster-weight-calibration";
export const PRECLUSTER_CALIBRATION_VERSION = 1;

/**
 * Build a machine-readable artifact from a calibration result. Pure — the caller
 * supplies `timestamp` (ISO string) so this stays deterministic/testable (no
 * `Date` inside).
 */
export function buildPreclusterCalibrationArtifact(result, { timestamp }) {
  const { cap, settings, fixtureRoles, productionRankedSourceIds, baselineFaithful, results, hardFail } = result;
  return {
    harness: PRECLUSTER_CALIBRATION_HARNESS,
    version: PRECLUSTER_CALIBRATION_VERSION,
    timestamp,
    cap,
    settings: {
      topics: [...(settings.topics ?? [])],
      keywords: [...(settings.keywords ?? [])],
      geographies: [...(settings.geographies ?? [])],
    },
    fixtureRoles,
    productionRankedSourceIds,
    baselineFaithful,
    overall: { pass: !hardFail, hardFail },
    presets: results.map((r) => ({
      preset: r.preset,
      description: r.description,
      weights: r.weights,
      electionGeoBoost: r.electionGeoBoost,
      electionGeoPenalty: r.electionGeoPenalty,
      rankedSourceIds: r.rankedSourceIds,
      survivorsAtCap: r.survivorsAtCap,
      metrics: r.metrics,
      invariants: r.invariants,
      passesInvariants: r.passesInvariants,
      recommended: r.recommended,
    })),
  };
}
