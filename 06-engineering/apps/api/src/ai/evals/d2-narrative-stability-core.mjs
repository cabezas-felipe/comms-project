/**
 * D2 narrative-stability advisory eval — Core (side-effect-free)
 *
 * Sprint D2 hardens post-cluster narrative generation (what-changed +
 * why-it-matters) with a fail-closed-per-story policy: a stage that cannot
 * produce content for a story retries ONCE, then drops only that story —
 * never failing the global refresh. This eval is the deterministic, hermetic
 * proof of that policy.
 *
 * Everything runs in-process against `runRefreshPipeline` with injected stubs —
 * no network, no real LLM, no env. Controlled failures are injected per story
 * via the `resolveWhatChangedFn` / `resolveWhyItMattersFn` test seams (the same
 * resolver seams the pipeline already exposes), so the eval exercises the REAL
 * pipeline retry/drop orchestration, not a reimplementation of it.
 *
 * Each scenario pins an expected D2 outcome (which stories survive, per-stage
 * retry/drop tallies, and whether the ≥50% retention guardrail holds). The
 * eval fails (exit non-zero in the runner) if observed behavior diverges from
 * expectation — i.e. if the D2 stability logic regresses.
 *
 * Locked guardrail (decision #5): in a failure-injection scenario, the run is
 * "healthy" only if >= 50% of pre-D2 eligible stories survive.
 *
 * Import-safe: no console, no exits. The runner owns all side effects.
 */

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";
const RETENTION_GUARDRAIL = 0.5;

const KEYWORD_RECALL = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

const D2_PERSONA = Object.freeze({
  topics: ["Diplomatic relations"],
  keywords: ["embassy"],
  geographies: ["US"],
  traditionalSources: ["Reuters"],
  socialSources: [],
});

// ─── Hermetic fixture: N independent, grounded meta-stories ──────────────────
// One raw item per story (explicit US geography + the "embassy" keyword so it
// clears recall in keyword mode), and a 1:1 grounded cluster stub so all N
// stories reach the narrative stages.
function buildStoryId(i) {
  return `d2-ms-${i}`;
}

function buildItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    sourceId: `d2-src-${i}`,
    outlet: "Reuters",
    kind: "traditional",
    weight: 80,
    minutesAgo: 30,
    lang: "en",
    topic: "Diplomatic relations",
    geographies: ["US"],
    url: `https://example.com/news/d2-src-${i}`,
    headline: `US embassy update ${i}: diplomatic developments`,
    body: [`The embassy reported diplomatic developments in update ${i}.`],
  }));
}

function buildClusterFn(n) {
  return () =>
    Promise.resolve(
      Array.from({ length: n }, (_, i) => {
        const sid = `d2-src-${i}`;
        return {
          meta_story_id: buildStoryId(i),
          title: `Embassy story ${i}: diplomatic developments`,
          subtitle: `Subtitle ${i} — grounded embassy source.`,
          source_item_ids: [sid],
          summary: `Summary ${i}: embassy diplomatic developments tracked.`,
          tags: { topics: ["Diplomatic relations"], keywords: ["embassy"], geographies: ["US"] },
          factual_claims: [`Embassy source ${i} reports diplomatic developments.`],
          claim_evidence_map: { "0": [sid] },
        };
      })
    );
}

// ─── Per-story stub results ───────────────────────────────────────────────────
function whatChangedOk() {
  return {
    state: "changed",
    whatChanged: "Coverage shifted with a new development.",
    gate: { signal: "strong", reasons: ["stub_ok"] },
    diagnostics: {
      classifySkipped: false, classifyCalled: true, classifyMaterial: true,
      writeCalled: true, writeOk: true,
      llmFailed: { classify: false, write: false, hallucination: false },
      latencyMs: { classify: 0, write: 0 },
    },
  };
}
function whatChangedWriteFailed() {
  return {
    state: "unchanged",
    whatChanged: "",
    gate: { signal: "strong", reasons: ["stub_fail"] },
    diagnostics: {
      classifySkipped: false, classifyCalled: true, classifyMaterial: true,
      writeCalled: true, writeOk: false,
      llmFailed: { classify: false, write: true, hallucination: false },
      latencyMs: { classify: 0, write: 0 },
    },
  };
}
function whyOk(input) {
  return {
    whyItMatters: `Why it matters for ${input.metaStoryId}.`,
    trace: { metaStoryId: input.metaStoryId, state: input.state, fallback_used: false },
    diagnostics: { fallbackUsed: false, writerOk: true, latencyMs: { write: 0, rewrite: 0 } },
  };
}

/**
 * Build the injected resolvers for a scenario.
 * - `failWhatChanged` / `failWhy`: Sets of story ids that fail PERSISTENTLY
 *   (every attempt, including the retry) → dropped.
 * - `transientWhatChanged` / `transientWhy`: Sets of ids that fail the FIRST
 *   attempt then succeed on the retry → survive (proves single-retry recovery).
 * The why stub throws to exercise the pipeline's resolver-threw → resolver_threw
 * fallback → drop path end-to-end.
 */
function buildResolvers({
  failWhatChanged = new Set(),
  failWhy = new Set(),
  transientWhatChanged = new Set(),
  transientWhy = new Set(),
} = {}) {
  const wcCalls = new Map();
  const whyCalls = new Map();

  const resolveWhatChangedFn = (input) => {
    const id = input.metaStoryId;
    const n = (wcCalls.get(id) ?? 0) + 1;
    wcCalls.set(id, n);
    if (failWhatChanged.has(id)) return Promise.resolve(whatChangedWriteFailed());
    if (transientWhatChanged.has(id) && n === 1) return Promise.resolve(whatChangedWriteFailed());
    return Promise.resolve(whatChangedOk());
  };

  const resolveWhyItMattersFn = (input) => {
    const id = input.metaStoryId;
    const n = (whyCalls.get(id) ?? 0) + 1;
    whyCalls.set(id, n);
    if (failWhy.has(id)) throw new Error(`synthetic why failure for ${id}`);
    if (transientWhy.has(id) && n === 1) throw new Error(`synthetic transient why failure for ${id}`);
    return whyOk(input);
  };

  return { resolveWhatChangedFn, resolveWhyItMattersFn, wcCalls, whyCalls };
}

async function runScenario(spec) {
  const n = spec.storyCount;
  const resolvers = buildResolvers(spec.inject);
  const { payload, log } = await runRefreshPipeline({
    settings: D2_PERSONA,
    rawItems: buildItems(n),
    clusterFn: buildClusterFn(n),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
    deltaConfig: { enabled: true },
    whyConfig: { enabled: true, mockOnly: false, model: "mock", timeoutMs: 4000 },
    everSeenMetaStoryIds: Array.from({ length: n }, (_, i) => buildStoryId(i)),
    resolveWhatChangedFn: resolvers.resolveWhatChangedFn,
    resolveWhyItMattersFn: resolvers.resolveWhyItMattersFn,
  });

  const ns = log?.narrativeStability ?? null;
  const survivorIds = (payload?.stories ?? []).map((s) => s.metaStoryId).sort();
  const reasons = [];

  if (!ns) {
    reasons.push("log.narrativeStability missing");
    return { id: spec.id, passed: false, reasons, observed: { survivorIds }, expected: spec.expect };
  }

  const exp = spec.expect;
  const check = (label, actual, expected) => {
    if (actual !== expected) reasons.push(`${label}: expected ${expected}, got ${actual}`);
  };

  // Global refresh never failed: a payload with stories array is present.
  if (!Array.isArray(payload?.stories)) reasons.push("global refresh failed (no stories array)");

  check("eligible", ns.eligible, n);
  check("survived", ns.survived, exp.survivors.length);
  check("dropped", ns.dropped, n - exp.survivors.length);
  check("whatChanged.retried", ns.whatChanged.retried, exp.wcRetried);
  check("whatChanged.dropped", ns.whatChanged.dropped, exp.wcDropped);
  check("why.retried", ns.whyItMatters.retried, exp.whyRetried);
  check("why.dropped", ns.whyItMatters.dropped, exp.whyDropped);

  const expectedSurvivors = [...exp.survivors].sort();
  if (JSON.stringify(survivorIds) !== JSON.stringify(expectedSurvivors)) {
    reasons.push(`survivor ids: expected [${expectedSurvivors}], got [${survivorIds}]`);
  }

  // Retention guardrail (locked decision #5).
  const guardrailPass = ns.retentionRate >= RETENTION_GUARDRAIL;
  if (guardrailPass !== exp.guardrailPass) {
    reasons.push(
      `retention guardrail: expected ${exp.guardrailPass ? "PASS" : "FAIL"} ` +
        `(retentionRate=${ns.retentionRate.toFixed(3)} vs ${RETENTION_GUARDRAIL})`
    );
  }

  return {
    id: spec.id,
    intent: spec.intent,
    passed: reasons.length === 0,
    reasons,
    observed: {
      eligible: ns.eligible,
      survived: ns.survived,
      dropped: ns.dropped,
      retentionRate: ns.retentionRate,
      guardrailPass,
      whatChanged: ns.whatChanged,
      whyItMatters: ns.whyItMatters,
      survivorIds,
    },
  };
}

// ─── Scenarios ───────────────────────────────────────────────────────────────
// id helpers
const ID = (i) => `d2-ms-${i}`;

export const SCENARIOS = [
  {
    id: "what-changed-persistent-drop",
    intent: "what-changed write fails persistently for 1/4 → dropped after retry, 3 survive (75%).",
    storyCount: 4,
    inject: { failWhatChanged: new Set([ID(1)]) },
    expect: {
      survivors: [ID(0), ID(2), ID(3)],
      wcRetried: 1, wcDropped: 1, whyRetried: 0, whyDropped: 0,
      guardrailPass: true,
    },
  },
  {
    id: "why-persistent-drop-boundary",
    intent: "why fails persistently for 2/4 → dropped after retry, 2 survive (50% — guardrail boundary PASS).",
    storyCount: 4,
    inject: { failWhy: new Set([ID(0), ID(2)]) },
    expect: {
      survivors: [ID(1), ID(3)],
      wcRetried: 0, wcDropped: 0, whyRetried: 2, whyDropped: 2,
      guardrailPass: true,
    },
  },
  {
    id: "both-stages-mixed-drop",
    intent: "what-changed drops 1, why drops 1 (different stories) of 4 → 2 survive (50%).",
    storyCount: 4,
    inject: { failWhatChanged: new Set([ID(0)]), failWhy: new Set([ID(1)]) },
    expect: {
      survivors: [ID(2), ID(3)],
      wcRetried: 1, wcDropped: 1, whyRetried: 1, whyDropped: 1,
      guardrailPass: true,
    },
  },
  {
    id: "single-retry-recovery",
    intent: "transient failures recover on the single retry → 0 drops, all 4 survive, retries counted.",
    storyCount: 4,
    inject: { transientWhatChanged: new Set([ID(0)]), transientWhy: new Set([ID(3)]) },
    expect: {
      survivors: [ID(0), ID(1), ID(2), ID(3)],
      wcRetried: 1, wcDropped: 0, whyRetried: 1, whyDropped: 0,
      guardrailPass: true,
    },
  },
  {
    id: "retention-guardrail-breach-detected",
    intent: "3/4 fail → only 1 survives (25%) → guardrail correctly FLAGS the breach (no global fail).",
    storyCount: 4,
    inject: { failWhatChanged: new Set([ID(0), ID(1)]), failWhy: new Set([ID(2)]) },
    expect: {
      survivors: [ID(3)],
      wcRetried: 2, wcDropped: 2, whyRetried: 1, whyDropped: 1,
      guardrailPass: false,
    },
  },
];

/**
 * Run all D2 scenarios. Pure: no console, no exits. Returns
 * `{ ok, reasons, scenarios }`. `ok` is true only when every scenario's
 * observed D2 behavior matches its locked expectation.
 */
export async function runD2NarrativeStability() {
  const scenarios = [];
  for (const spec of SCENARIOS) {
    // eslint-disable-next-line no-await-in-loop
    scenarios.push(await runScenario(spec));
  }
  const reasons = scenarios
    .filter((s) => !s.passed)
    .map((s) => `${s.id}: ${s.reasons.join("; ")}`);
  return { ok: reasons.length === 0, reasons, scenarios };
}
