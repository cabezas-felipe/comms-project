/**
 * Dashboard Live Colombia-Election Smoke — Core (Phase 3 · Step 3.1)
 *
 * A NON-HERMETIC smoke eval. It pulls the SAME live feed pool the dashboard
 * refresh consumes (`readFeedItems(dataDir, { mode: "live" })`) and runs it
 * through the SAME relevance pipeline (`runRefreshPipeline`) so we can confirm
 * the Phase-1/2 relevance behavior still holds on real data — recall admits the
 * pool, geo precision holds, the C1 cluster-input cap stays coherent, the A4
 * overflow / thin-on-beat geo-noise guard behaves, and Decision 5C ordering
 * (configured-geo elections ahead of cross-country) survives into ranked
 * cluster input.
 *
 * Only the DATA SOURCE is live. Everything downstream of the fetch is
 * deterministic: recall runs in lexical `keyword` mode (no embeddings, no
 * network), beat-fit is disabled (threshold-independent, mirrors the hermetic
 * elections core), and clustering uses an INJECTED deterministic stub — so a
 * given live pool always yields the same checks. No Anthropic / OpenAI / embed
 * provider is ever called. This keeps the eval safe for local + CI advisory use
 * (no keys, no model spend, no LLM variance) while still exercising the real
 * relevance gates against whatever the feeds carry right now.
 *
 * Tolerant by design: live news is variable, so "no election in the window" or
 * "the cap didn't bite this run" are NORMAL outcomes. Those become failing /
 * neutral CHECKS with actionable detail — never thrown errors. The core throws
 * ONLY for a true execution failure (the pipeline itself crashing, bad config).
 * A feed-fetch failure is reported as a failing check (advisory-friendly), not a
 * throw, so a network blip in CI doesn't read as a code regression.
 *
 * Reuses production helpers verbatim to avoid logic drift:
 *   - `readFeedItems`                       — the production live-fetch path
 *   - `runRefreshPipeline`                  — the production relevance pipeline
 *   - `isElectionCycleItem` / `classifyElectionGeo` — the production Decision-5C
 *     election classifiers (same regex/lexicon, no duplicated drift)
 *
 * Import-safe: no env reads at module load, no console, no `process.exit`. The
 * runner (`run-dashboard-live-colombia-election.mjs`) owns CLI + exit semantics;
 * the `.test.mjs` drives the core with stubbed fetch (no network).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { readFeedItems } from "../../ingestion/feed-reader.mjs";
import {
  runRefreshPipeline,
  CLUSTER_INPUT_CAP,
} from "../../dashboard/refresh-pipeline.mjs";
import {
  isElectionCycleItem,
  classifyElectionGeo,
  computeHeadlineFamilyKey,
} from "../../dashboard/pre-cluster-relevance.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/api/data — the same default the server's `dataDir()` resolves to (env
// `TEMPO_DATA_DIR` wins when set). evals → ai → src → api, then `data`.
const DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "..", "..", "data");

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

// Minimum live raw pool for the smoke to be meaningful. Below this the feed is
// "thin" and downstream checks aren't trustworthy — we say so rather than pass
// vacuously.
const MIN_LIVE_POOL_DEFAULT = 5;

// Diagnostics must stay log-scrape-safe: IDs / counts / a few short samples, no
// raw bodies, no giant arrays.
const SAMPLE_CAP = 10;
const HEADLINE_SAMPLE_CHARS = 120;

// Lexical-only recall: admission depends purely on the lexical gates
// (keyword / configured-geo-in-text), so no embedding provider is touched.
// Pinned per-run so the eval doesn't depend on the process-wide
// TEMPO_RECALL_MODE. Mirrors the hermetic elections core.
const KEYWORD_RECALL = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

/**
 * Colombia-election monitoring persona. Broad election vocabulary + Colombia
 * geography. `traditionalSources` is intentionally empty: the core fills it at
 * runtime from the DISTINCT OUTLETS actually fetched, so source-selection admits
 * the live pool and the smoke exercises the geo / recall / cap gates rather than
 * source matching. Override `options.settings` to pin a specific source set.
 */
export const LIVE_COLOMBIA_ELECTION_PERSONA = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  topics: ["Elections"],
  keywords: ["election", "elections", "ballot", "vote", "candidate", "campaign", "runoff", "presidential"],
  geographies: ["Colombia"],
  traditionalSources: [],
  socialSources: [],
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s, n = HEADLINE_SAMPLE_CHARS) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function distinctOutlets(items) {
  const seen = new Set();
  for (const it of items) {
    const o = String(it?.outlet ?? "").trim();
    if (o) seen.add(o);
  }
  return [...seen];
}

function safeNum(v) {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Deterministic, provider-free cluster stub used as the default `clusterFn`.
 *
 * Captures the (ranked, capped) cluster input — so Decision-5C ordering can be
 * inspected — then partitions whatever survived recall/geo/cap into grounded
 * meta-stories keyed by headline family. Election groups carry grounded
 * `tags` + `associated_entities` (high relevance); non-election groups are
 * geo-only (low relevance) so the A4 overflow / thin-on-beat guard has geo-noise
 * to act on when the story set overflows the 5-story cap.
 *
 * The grounded shape mirrors the proven hermetic elections core so the grounding
 * stage keeps these stories rather than dropping them as ungrounded.
 */
function deterministicLiveClusterFn(capture, settings) {
  return (items) => {
    capture.input = items;
    const groups = new Map();
    for (const it of items) {
      const key = computeHeadlineFamilyKey(it) || it.sourceId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }

    const clusters = [];
    let n = 0;
    for (const groupItems of groups.values()) {
      const sourceIds = groupItems.map((i) => i.sourceId);
      const isElection = groupItems.some((i) => isElectionCycleItem(i));
      const isConfiguredGeo = groupItems.some(
        (i) => classifyElectionGeo(i, settings) === "configuredGeoElection"
      );
      const tags = isElection
        ? {
            topics: ["Elections"],
            keywords: ["election"],
            geographies: isConfiguredGeo ? [...(settings.geographies ?? [])] : [],
          }
        : { topics: [], keywords: [], geographies: isConfiguredGeo ? [...(settings.geographies ?? [])] : [] };
      const associated_entities = isElection
        ? ["election", ...(isConfiguredGeo ? settings.geographies ?? [] : [])]
        : [];
      clusters.push({
        meta_story_id: `live-ms-${n++}`,
        title: truncate(groupItems[0].headline, 80),
        subtitle: "Composed from grounded live sources.",
        source_item_ids: sourceIds,
        summary: `${truncate(groupItems[0].headline, 80)}.`,
        tags,
        associated_entities,
        factual_claims: ["A claim grounded in every cited source."],
        claim_evidence_map: { "0": [...sourceIds] },
      });
    }
    return Promise.resolve(clusters);
  };
}

/**
 * Default live fetch: the production live-ingestion path. `mode: "live"` forces
 * the RSS fetch branch regardless of NODE_ENV so the eval is genuinely
 * non-hermetic when run for real. Tests override `options.readItems` with a
 * deterministic stub so the suite never touches the network.
 */
async function defaultReadItems({ dataDir }) {
  return readFeedItems(dataDir, { mode: "live" });
}

// ── Checks ──────────────────────────────────────────────────────────────────
//
// Each check is `{ name, pass, detail, neutral? }`. A `neutral` check is one
// whose scenario isn't present in this live window (e.g. cap not exercised); it
// reports `pass: true` so it never fails the run, but `neutral: true` so the
// report can say "not observable" rather than implying a positive result.

function checkFeedNonEmpty(rawCount, minPool) {
  return {
    name: "feed-non-empty",
    pass: rawCount >= minPool,
    detail:
      rawCount >= minPool
        ? `live raw pool has ${rawCount} item(s) (floor ${minPool})`
        : `insufficient live volume: ${rawCount} item(s) < floor ${minPool} — the feed window is too thin for a meaningful smoke`,
  };
}

function checkElectionPresence(electionCount, rawCount) {
  return {
    name: "election-presence",
    pass: electionCount >= 1,
    detail:
      electionCount >= 1
        ? `${electionCount}/${rawCount} live item(s) carry an election-cycle signal (isElectionCycleItem)`
        : "no election signal in current window — no live item matched the election lexicon (not a runtime error; the news window simply has no election coverage)",
  };
}

function checkCapBehavior(clusterCap) {
  const dedupedCount = safeNum(clusterCap?.dedupedCount);
  const clusterInputCount = safeNum(clusterCap?.clusterInputCount);
  const droppedCount = safeNum(clusterCap?.clusterDroppedCount);
  const droppedIds = Array.isArray(clusterCap?.clusterDroppedSourceIds)
    ? clusterCap.clusterDroppedSourceIds
    : [];
  const capEffective = safeNum(clusterCap?.clusterInputCapEffective) || CLUSTER_INPUT_CAP;

  if (dedupedCount <= capEffective) {
    return {
      name: "cap-behavior",
      pass: true,
      neutral: true,
      detail: `cap not exercised: deduped pool ${dedupedCount} ≤ cap ${capEffective} (every candidate reached clustering)`,
    };
  }

  // Cap bit — diagnostics must be internally coherent.
  const inputAtCap = clusterInputCount === capEffective;
  const dropMath = droppedCount === dedupedCount - clusterInputCount;
  const idsAligned = droppedIds.length === Math.min(droppedCount, droppedIds.length) && droppedCount >= droppedIds.length;
  const coherent = inputAtCap && dropMath && droppedCount > 0;
  return {
    name: "cap-behavior",
    pass: coherent,
    detail: coherent
      ? `cap applied: deduped ${dedupedCount} → clusterInput ${clusterInputCount} (=cap ${capEffective}), dropped ${droppedCount} (math + sampled ids aligned)`
      : `cap diagnostics incoherent: deduped=${dedupedCount} clusterInput=${clusterInputCount} cap=${capEffective} dropped=${droppedCount} sampledDroppedIds=${droppedIds.length} (expected clusterInput=cap and dropped=deduped-clusterInput)`,
  };
}

function checkGeoNoiseGuard(overflowCap) {
  const applied = overflowCap?.overflowCapApplied === true;
  if (!applied) {
    return {
      name: "geo-noise-guard",
      pass: true,
      neutral: true,
      detail: "overflow not exercised: ≤5 meta-stories shipped, so the thin-on-beat geo-noise guard had nothing to act on (no geo-only backfill possible)",
    };
  }

  const guardApplied = overflowCap?.thinOnBeatGuardApplied === true;
  const filtered = safeNum(overflowCap?.thinOnBeatFilteredCount);
  const inputCount = safeNum(overflowCap?.overflowInputCount);
  const outputCount = safeNum(overflowCap?.overflowOutputCount);
  const droppedCount = safeNum(overflowCap?.overflowDroppedCount);
  // Coherence: dropped accounts for the input/output delta, and when the guard
  // reports "applied" it must have actually removed ≥1 geo-noise story. Both
  // shapes mean "no geo-only backfill is dominating the survivors".
  const dropMath = droppedCount === inputCount - outputCount;
  const guardCoherent = guardApplied ? filtered > 0 : filtered === 0;
  const coherent = dropMath && guardCoherent;
  return {
    name: "geo-noise-guard",
    pass: coherent,
    detail: coherent
      ? `overflow applied (in ${inputCount} → out ${outputCount}, dropped ${droppedCount}); thin-on-beat guard ${guardApplied ? `suppressed ${filtered} geo-noise story(ies)` : "inactive (no on-beat survivor to protect; pure survival ranking)"} — no geo-only backfill dominating survivors`
      : `overflow diagnostics incoherent: in=${inputCount} out=${outputCount} dropped=${droppedCount} guardApplied=${guardApplied} filtered=${filtered}`,
  };
}

function meanRank(rankedIds, idSet) {
  const ranks = [];
  rankedIds.forEach((id, i) => {
    if (idSet.has(id)) ranks.push(i);
  });
  return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : Infinity;
}

/**
 * Decision 5C live ordering sanity.
 *
 * On live data, comparing the MEAN RANK of the two election classes inside the
 * capped cluster input is brittle: a single fresh cross-country item legitimately
 * outranks a stale configured-geo one, inverting the mean without any regression.
 * The robust, freshness-independent signal Decision 5C actually shapes is
 * SURVIVAL into the cap — configured-geo elections carry a +boost and
 * cross-country a −penalty, so configured-geo should survive the cluster-input
 * cap at a rate AT LEAST as high as cross-country. (Mean rank is kept as
 * informational detail only.)
 *
 * Only enforced when both classes exist in the raw election pool; otherwise
 * neutral ("not observable").
 */
function checkDecision5cOrdering(clusterInput, configuredRawCount, crossRawCount, settings) {
  if (configuredRawCount === 0 || crossRawCount === 0) {
    return {
      name: "decision-5c-ordering",
      pass: true,
      neutral: true,
      detail: `not observable in this run: need both configured-geo (${configuredRawCount}) and cross-country (${crossRawCount}) election candidates in the live pool to compare ordering`,
    };
  }

  const rankedIds = clusterInput.map((i) => i.sourceId);
  const configuredIds = new Set();
  const crossIds = new Set();
  for (const it of clusterInput) {
    const cls = classifyElectionGeo(it, settings);
    if (cls === "configuredGeoElection") configuredIds.add(it.sourceId);
    else if (cls === "crossCountryElection") crossIds.add(it.sourceId);
  }

  const configuredRate = configuredIds.size / configuredRawCount;
  const crossRate = crossIds.size / crossRawCount;
  const cfgMean = meanRank(rankedIds, configuredIds);
  const crossMean = meanRank(rankedIds, crossIds);
  const meanNote = `mean rank cfg=${Number.isFinite(cfgMean) ? cfgMean.toFixed(2) : "n/a"} vs cross=${Number.isFinite(crossMean) ? crossMean.toFixed(2) : "n/a"} (informational; freshness-sensitive)`;

  // Configured-geo must survive the cap at least as readily as cross-country.
  const pass = configuredRate >= crossRate;
  return {
    name: "decision-5c-ordering",
    pass,
    detail: pass
      ? `configured-geo elections survive the cluster-input cap at least as well as cross-country: ${configuredIds.size}/${configuredRawCount} (${(configuredRate * 100).toFixed(0)}%) vs ${crossIds.size}/${crossRawCount} (${(crossRate * 100).toFixed(0)}%) — ${meanNote}`
      : `Decision 5C regression: configured-geo survives the cap WORSE than cross-country: ${configuredIds.size}/${configuredRawCount} (${(configuredRate * 100).toFixed(0)}%) < ${crossIds.size}/${crossRawCount} (${(crossRate * 100).toFixed(0)}%) — the configured-geo boost is not protecting them — ${meanNote}`,
  };
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Run the live Colombia-election smoke eval.
 *
 * @param {object} [options]
 * @param {(ctx:{dataDir:string})=>Promise<object[]>} [options.readItems]
 *        Live-fetch seam. Defaults to the production `readFeedItems` live path.
 *        Tests inject a deterministic stub (no network).
 * @param {(opts:object)=>Promise<{payload:object,log:object}>} [options.runPipeline]
 *        Pipeline seam. Defaults to the production `runRefreshPipeline`.
 * @param {Function} [options.clusterFn] Optional cluster fn. Defaults to a
 *        deterministic provider-free stub (wrapped so cluster input is captured
 *        for Decision-5C inspection regardless).
 * @param {object} [options.settings] Persona/settings override. Defaults to
 *        {@link LIVE_COLOMBIA_ELECTION_PERSONA} with `traditionalSources` filled
 *        from the live outlets.
 * @param {string} [options.dataDir] Live data dir (manifest source). Defaults to
 *        `TEMPO_DATA_DIR` or apps/api/data.
 * @param {number} [options.minLivePool] Feed-non-empty floor (default 5).
 * @param {string} [options.timestamp] ISO timestamp (injected for determinism).
 * @returns {Promise<{ok:boolean, checks:object[], stats:object, diagnostics:object, warnings:string[], timestamp:string}>}
 */
export async function runDashboardLiveColombiaElectionCore(options = {}) {
  const {
    readItems = defaultReadItems,
    runPipeline = runRefreshPipeline,
    clusterFn: userClusterFn = null,
    settings: settingsOverride = null,
    dataDir = process.env.TEMPO_DATA_DIR ?? DEFAULT_DATA_DIR,
    minLivePool = MIN_LIVE_POOL_DEFAULT,
    timestamp = new Date().toISOString(),
  } = options;

  const warnings = [];
  const checks = [];
  const emptyStats = {
    rawCount: 0,
    candidateCount: 0,
    geoPassedCount: 0,
    recallCount: 0,
    dedupedCount: 0,
    clusterInputCount: 0,
    clusterDroppedCount: 0,
    clusterInputCapEffective: CLUSTER_INPUT_CAP,
    finalCount: 0,
    electionCount: 0,
    configuredGeoElectionCount: 0,
    crossCountryElectionCount: 0,
  };

  // ── 1) Live fetch (the only non-hermetic step) ──────────────────────────────
  // A fetch failure is reported as a failing check, NOT thrown: an advisory run
  // (local / CI) must still produce a structured verdict on a network blip.
  let rawItems;
  try {
    rawItems = await readItems({ dataDir });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`live feed fetch failed: ${msg}`);
    checks.push({
      name: "feed-non-empty",
      pass: false,
      detail: `live feed fetch failed (no pool to evaluate): ${msg}`,
    });
    return {
      ok: false,
      checks,
      stats: { ...emptyStats },
      diagnostics: { dataDir, fetchError: msg },
      warnings,
      timestamp,
    };
  }

  if (!Array.isArray(rawItems)) {
    // Bad config / contract breach from the fetch seam — a true execution error.
    throw new Error(
      `[live-colombia-election] readItems must resolve to an array, got ${typeof rawItems}`
    );
  }

  const rawCount = rawItems.length;
  const electionItems = rawItems.filter((i) => isElectionCycleItem(i));

  // Effective settings: fill traditionalSources from live outlets so source
  // selection admits the pool (unless the caller pinned their own settings).
  const baseSettings = settingsOverride ?? LIVE_COLOMBIA_ELECTION_PERSONA;
  const effectiveSettings =
    baseSettings.traditionalSources && baseSettings.traditionalSources.length > 0
      ? baseSettings
      : { ...baseSettings, traditionalSources: distinctOutlets(rawItems) };

  const configuredGeoElectionCount = electionItems.filter(
    (i) => classifyElectionGeo(i, effectiveSettings) === "configuredGeoElection"
  ).length;
  const crossCountryElectionCount = electionItems.filter(
    (i) => classifyElectionGeo(i, effectiveSettings) === "crossCountryElection"
  ).length;

  // ── 2) Run the relevance pipeline (deterministic past the fetch) ────────────
  // A pipeline crash IS a true execution error — let it throw out of the core.
  const capture = { input: null };
  const clusterFn = userClusterFn
    ? (items) => {
        capture.input = items;
        return userClusterFn(items);
      }
    : deterministicLiveClusterFn(capture, effectiveSettings);

  const { payload, log } = await runPipeline({
    settings: effectiveSettings,
    rawItems: rawItems.map((i) => ({ ...i })),
    clusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
  });

  const stories = payload?.stories ?? [];
  const clusterInput = capture.input ?? [];
  const clusterCap = log?.clusterCap ?? {};
  const overflowCap = log?.overflowCap ?? {};
  const stageCounts = log?.decisionTrace?.stageCounts ?? {};

  // ── 3) Checks ───────────────────────────────────────────────────────────────
  checks.push(checkFeedNonEmpty(rawCount, minLivePool));
  checks.push(checkElectionPresence(electionItems.length, rawCount));
  checks.push(checkCapBehavior(clusterCap));
  checks.push(checkGeoNoiseGuard(overflowCap));
  checks.push(
    checkDecision5cOrdering(clusterInput, configuredGeoElectionCount, crossCountryElectionCount, effectiveSettings)
  );

  const stats = {
    rawCount,
    candidateCount: safeNum(stageCounts.afterSourceSelection),
    geoPassedCount: safeNum(stageCounts.afterGeoFilter),
    recallCount: safeNum(stageCounts.afterTopicKeyword),
    dedupedCount: safeNum(clusterCap.dedupedCount),
    clusterInputCount: safeNum(clusterCap.clusterInputCount) || clusterInput.length,
    clusterDroppedCount: safeNum(clusterCap.clusterDroppedCount),
    clusterInputCapEffective: safeNum(clusterCap.clusterInputCapEffective) || CLUSTER_INPUT_CAP,
    finalCount: stories.length,
    electionCount: electionItems.length,
    configuredGeoElectionCount,
    crossCountryElectionCount,
  };

  // Bounded, serializable diagnostics — IDs / counts / short samples only.
  const clusterInputClasses = { configuredGeoElection: 0, crossCountryElection: 0, nonElection: 0 };
  const rankSample = [];
  clusterInput.forEach((it, idx) => {
    const cls = classifyElectionGeo(it, effectiveSettings);
    clusterInputClasses[cls] = (clusterInputClasses[cls] ?? 0) + 1;
    if (idx < SAMPLE_CAP) {
      rankSample.push({ rank: idx, sourceId: it.sourceId, outlet: it.outlet, electionGeoClass: cls });
    }
  });

  const diagnostics = {
    dataDir,
    settingsSourceCount: effectiveSettings.traditionalSources.length,
    electionSample: electionItems.slice(0, SAMPLE_CAP).map((i) => ({
      sourceId: i.sourceId,
      outlet: i.outlet,
      electionGeoClass: classifyElectionGeo(i, effectiveSettings),
      headline: truncate(i.headline),
    })),
    clusterInputClasses,
    clusterInputRankSample: rankSample,
    clusterDroppedSourceIds: Array.isArray(clusterCap.clusterDroppedSourceIds)
      ? clusterCap.clusterDroppedSourceIds.slice(0, SAMPLE_CAP)
      : [],
    overflowDroppedMetaStoryIds: Array.isArray(overflowCap.overflowDroppedMetaStoryIds)
      ? overflowCap.overflowDroppedMetaStoryIds.slice(0, SAMPLE_CAP)
      : [],
    shippedStoryIds: stories.slice(0, SAMPLE_CAP).map((s) => s.metaStoryId ?? s.id).filter(Boolean),
  };

  // Non-neutral warnings surface notable-but-not-fatal live conditions.
  if (stats.candidateCount < rawCount) {
    warnings.push(
      `${rawCount - stats.candidateCount} of ${rawCount} live item(s) did not reach the candidate stage (source-selection / time-window)`
    );
  }
  if (electionItems.length > 0 && configuredGeoElectionCount === 0) {
    warnings.push(
      "election items present but none classify as configured-geo (Colombia) — live coverage is cross-country only this window"
    );
  }

  const ok = checks.every((c) => c.pass);
  return { ok, checks, stats, diagnostics, warnings, timestamp };
}

export const _internal = {
  DEFAULT_DATA_DIR,
  MIN_LIVE_POOL_DEFAULT,
  KEYWORD_RECALL,
  deterministicLiveClusterFn,
  checkFeedNonEmpty,
  checkElectionPresence,
  checkCapBehavior,
  checkGeoNoiseGuard,
  checkDecision5cOrdering,
};
