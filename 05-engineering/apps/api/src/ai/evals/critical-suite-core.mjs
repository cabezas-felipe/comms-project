/**
 * Critical Hard-Fail Suite — Core (side-effect-free)
 *
 * Eight E2E scenarios that act as the **release gate** for Phases 1–4 work.
 * Presence-first: each scenario asserts that a critically important behavior
 * is preserved (or that an explicitly-allowed empty result is correctly
 * diagnosed). Any single failure makes the suite hard-fail; release is
 * blocked until the failure is resolved.
 *
 * Hermetic by design — every scenario uses injected stubs (clusterFn,
 * embedFn, geoAssessFn) so the suite is deterministic and CI-safe without
 * provider keys. The optional LLM judge layer (see `critical-suite-judge.mjs`)
 * is advisory-only and never gates this suite.
 *
 * Scenarios:
 *   1. critical-01-china-defense-trade           — relevant story surfaces
 *   2. critical-02-monitoring-migration-border   — migration/border surfaces
 *   3. critical-03-source-scoped-relevance       — selected sources honored
 *   4. critical-04-empty-profile-lexical-path    — E3b lexical pass-through
 *   5. critical-05-embedding-failure-with-lexical-hits — lexical fallback
 *   6. critical-06-embedding-failure-without-lexical-hits — diagnosed empty
 *   7. critical-07-settings-save-refresh-propagation — intent → payload
 *   8. critical-08-grounding-trust-guard         — ungrounded story dropped
 *
 * Module is import-safe: no env reads, no console output, no `process.exit`.
 * The CLI runner (`run-critical-suite.mjs`) handles formatting + exit codes.
 */

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";

// ─── Recall config presets ───────────────────────────────────────────────────
//
// Each scenario passes one of these so its behavior doesn't depend on the
// process-wide `TEMPO_RECALL_MODE` env var (which various test files mutate).

const HYBRID = Object.freeze({
  mode: "hybrid_strict",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

const KEYWORD = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  const sourceId = overrides.sourceId ?? "src-1";
  return {
    clusterId: "cluster-1",
    title: "Test cluster",
    topic: "Diplomatic relations",
    geographies: ["US"],
    priority: "standard",
    takeaway: "Test takeaway",
    summary: "Test summary",
    whyItMatters: "Test why",
    whatChanged: "Test what changed",
    sourceId,
    outlet: "Reuters",
    byline: "Test Author",
    kind: "traditional",
    weight: 85,
    url: `https://example.com/${sourceId}`,
    minutesAgo: 30,
    headline: "Test Headline",
    body: ["Test body."],
    ...overrides,
  };
}

// Build a grounded meta-story from a list of source items. Mirrors the shape
// `cluster-engine` returns — each non-empty `factual_claims[i]` must have a
// `claim_evidence_map[i]` of valid sourceIds, otherwise verifyGrounding drops.
function makeGroundedCluster({
  id = "ms-1",
  title = "Test story",
  subtitle = "Sub",
  summary = "Summary.",
  sourceItems,
  tags = { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
  claims = ["A claim grounded in the sources."],
}) {
  const sourceIds = sourceItems.map((i) => i.sourceId);
  const claim_evidence_map = {};
  claims.forEach((_c, idx) => {
    claim_evidence_map[String(idx)] = sourceIds;
  });
  return {
    meta_story_id: id,
    title,
    subtitle,
    source_item_ids: sourceIds,
    summary,
    tags,
    factual_claims: claims,
    claim_evidence_map,
  };
}

// Deterministic 2-d embedder: [signal_token_count, normalized_length].
// Items whose text contains any of the listed signal tokens rank higher than
// items that don't. Used by scenarios that want hybrid_strict to actually
// widen recall.
function makeStubEmbedder(signalTokens) {
  return async (texts) => {
    return texts.map((t) => {
      const lower = String(t).toLowerCase();
      const matches = signalTokens.filter((tok) => lower.includes(tok)).length;
      return [matches, Math.min(lower.length, 1000) / 1000];
    });
  };
}

// Build a stub clusterFn that wraps every input item into a single grounded
// meta-story keyed by a deterministic id. The cluster's title is derived
// from the lead source item's headline so the per-scenario relevance checks
// (which inspect title/summary) reflect what actually reached clustering.
// Good default for scenarios where clustering quality is not the focus — we
// just want a shipped story when items reach the cluster stage.
function passthroughClusterFn(idPrefix = "ms") {
  return async (items) => {
    if (!items || items.length === 0) return [];
    const lead = items[0];
    return [
      makeGroundedCluster({
        id: `${idPrefix}-1`,
        title: lead.headline ?? "Bundled story",
        subtitle: Array.isArray(lead.body) ? lead.body[0] ?? "" : String(lead.body ?? ""),
        summary: lead.headline ?? "Summary.",
        sourceItems: items,
        tags: {
          topics: [lead.topic].filter(Boolean),
          keywords: [],
          geographies: lead.geographies ?? [],
        },
      }),
    ];
  };
}

// ─── Scenario runners ────────────────────────────────────────────────────────
//
// Each runner returns `{ ok, reasons, diagnostics }`:
//   - `ok`         : true iff the must-pass assertions all hold
//   - `reasons`    : strings explaining why ok is false (empty when ok=true)
//   - `diagnostics`: structured fields the CLI/judge can inspect (stories,
//                    log meta, settings/intent labels). Always populated.

async function scenarioChinaDefenseTrade() {
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Trade policy", "Security policy"],
    keywords: ["China", "defense", "trade"],
    geographies: ["US", "China"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const rawItems = [
    makeItem({
      sourceId: "china-1",
      outlet: "Reuters",
      topic: "Trade policy",
      geographies: ["US", "China"],
      headline: "US weighs new defense trade restrictions on China",
      body: ["The administration is reviewing China-focused defense trade controls."],
    }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: passthroughClusterFn("china"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID,
    embedFn: makeStubEmbedder(["china", "defense", "trade"]),
  });

  const reasons = [];
  if (!payload || !Array.isArray(payload.stories)) {
    reasons.push("payload missing stories array");
  } else if (payload.stories.length === 0) {
    reasons.push("no relevant story surfaced for US-China defense/trade intent");
  } else {
    const top = payload.stories[0];
    const text = `${top.title ?? ""} ${top.takeaway ?? ""} ${top.summary ?? ""}`.toLowerCase();
    const hasGeo = top.geographies?.some((g) => g === "US" || g === "China");
    const hasSignal = /china|defense|trade/.test(text);
    if (!hasGeo) reasons.push("surfaced story does not carry a relevant geography");
    if (!hasSignal) reasons.push("surfaced story does not carry a relevant signal in title/summary");
  }
  if (log?.recall?.degraded) {
    reasons.push(`recall unexpectedly degraded: ${log.recall.degraded_reason}`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: { stories: payload?.stories ?? [], recall: log?.recall, funnel: log?.funnel },
  };
}

async function scenarioMonitoringMigrationBorder() {
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Migration policy", "Border policy"],
    keywords: ["migration", "border", "deportation"],
    geographies: ["US", "Mexico"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const rawItems = [
    makeItem({
      sourceId: "mig-1",
      outlet: "Reuters",
      topic: "Migration policy",
      geographies: ["US", "Mexico"],
      headline: "US adjusts border migration enforcement",
      body: ["New guidance updates how migration cases are handled at the border."],
    }),
    // Off-topic item that must NOT surface.
    makeItem({
      sourceId: "mig-noise",
      outlet: "Reuters",
      topic: "Other",
      geographies: ["US"],
      headline: "Local sports recap",
      body: ["Nothing related to the beat."],
    }),
  ];
  const { payload } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: passthroughClusterFn("mig"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID,
    embedFn: makeStubEmbedder(["migration", "border", "deportation"]),
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  if (stories.length === 0) {
    reasons.push("migration/border-relevant candidate present but no story surfaced");
  } else {
    const sourceIds = stories.flatMap((s) => s.sources.map((src) => src.id));
    if (!sourceIds.includes("mig-1")) reasons.push("expected mig-1 in surfaced sources");
    if (sourceIds.includes("mig-noise")) reasons.push("off-topic 'mig-noise' leaked into stories");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: { stories },
  };
}

async function scenarioSourceScopedRelevance() {
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Diplomatic relations"],
    keywords: ["bilateral"],
    geographies: ["US", "Colombia"],
    traditionalSources: ["Reuters"], // ONLY Reuters
    socialSources: [],
  };
  const rawItems = [
    // On-source, on-topic — must surface.
    makeItem({
      sourceId: "scoped-good",
      outlet: "Reuters",
      topic: "Diplomatic relations",
      geographies: ["US", "Colombia"],
      headline: "US-Colombia bilateral talks resume",
      body: ["Diplomats discuss bilateral cooperation."],
    }),
    // Off-source even though topically relevant — must NOT surface.
    makeItem({
      sourceId: "scoped-leak",
      outlet: "Random Blog",
      topic: "Diplomatic relations",
      geographies: ["US", "Colombia"],
      headline: "Bilateral US-Colombia coordination report",
      body: ["Diplomatic update."],
    }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: passthroughClusterFn("scoped"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID,
    embedFn: makeStubEmbedder(["bilateral", "colombia"]),
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  const ids = stories.flatMap((s) => s.sources.map((src) => src.id));
  if (!ids.includes("scoped-good")) {
    reasons.push("on-source/on-topic item failed to surface — source-selection over-collapsed");
  }
  if (ids.includes("scoped-leak")) {
    reasons.push("off-source 'scoped-leak' leaked through despite source scoping");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: { stories, selection: log?.selection },
  };
}

async function scenarioEmptyProfileLexicalPath() {
  // Intentionally narrow profile (only keywords + sources) so the recall
  // stage exercises its lexical-only path.  A fully empty profile is not
  // reachable here: empty traditionalSources+socialSources trips C2
  // fail-closed BEFORE recall, so we must keep one source to clear the gate.
  // The assertion below only requires that lexical hits surface — whether
  // `recall.degraded` ends up true (profile text empty) or false (sources
  // axis contributed text) doesn't matter, as long as the run is NOT an
  // embedding-failure cliff.
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: [],
    keywords: ["bilateral"], // gives lexical recall something to find
    geographies: [],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const rawItems = [
    makeItem({
      sourceId: "lex-1",
      outlet: "Reuters",
      topic: "Other",
      geographies: [],
      headline: "Bilateral coordination resumes between leaders",
      body: ["Officials confirmed bilateral cooperation."],
    }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: passthroughClusterFn("lex"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID,
    embedFn: makeStubEmbedder(["bilateral"]),
    // Scenario focus is the recall-level lexical path; beat-fit's heuristic
    // precision score requires multi-axis signal (topic + actor + keyword +
    // geo). With an intentionally sparse profile, beat-fit would correctly
    // drop the item even though recall surfaced it — that masks the recall
    // contract under test. Bypassing precision here keeps the assertion
    // narrow: "lexical recall surfaces a relevant item under a sparse
    // profile" (the prod precision posture is itself covered elsewhere).
    beatFitEnabled: false,
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  if (stories.length === 0) {
    reasons.push(
      "lexical-only relevant item present but pipeline returned strict-empty (expected the lexical path to surface it)"
    );
  }
  // Whether recall.degraded is true here depends on whether the profile text
  // ended up empty. Either way it must NOT be an embedding-failure cliff.
  if (log?.recall?.keywordFallbackAfterEmbeddingFailure) {
    reasons.push(
      "recall reported embedding-failure fallback, but no embedding error occurred"
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: { stories, recall: log?.recall },
  };
}

async function scenarioEmbeddingFailureWithLexicalHits() {
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Diplomatic relations"],
    keywords: ["sanctions"],
    geographies: ["US"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const rawItems = [
    makeItem({
      sourceId: "lex-hit",
      outlet: "Reuters",
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Treasury sanctions package widens",
      body: ["Sanctions update."],
    }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: passthroughClusterFn("ef-lex"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID,
    embedFn: async () => {
      throw new Error("provider 500 simulated failure");
    },
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  if (stories.length === 0) {
    reasons.push("lexical hits present but embedding failure collapsed the run");
  } else {
    const ids = stories.flatMap((s) => s.sources.map((src) => src.id));
    if (!ids.includes("lex-hit")) reasons.push("lex-hit missing from fallback output");
  }
  if (!log?.recall?.degraded) {
    reasons.push("recall.degraded must be true on embedding failure");
  }
  if (!/^embedding_(error|timeout|invalid_response|unavailable)_fail_closed$/.test(
    log?.recall?.degraded_reason ?? ""
  )) {
    reasons.push(`unexpected degraded_reason: ${log?.recall?.degraded_reason}`);
  }
  if (log?.recall?.keywordFallbackAfterEmbeddingFailure !== true) {
    reasons.push(
      "keywordFallbackAfterEmbeddingFailure must be true when lexical hits surface after embedding failure"
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: { stories, recall: log?.recall },
  };
}

async function scenarioEmbeddingFailureWithoutLexicalHits() {
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Diplomatic relations"],
    keywords: ["sanctions"],
    geographies: ["US"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const rawItems = [
    // No topic match, no keyword match — lexical recall is empty.
    makeItem({
      sourceId: "no-lex",
      outlet: "Reuters",
      topic: "Other",
      geographies: ["US"],
      headline: "Local sports recap",
      body: ["Nothing related to the beat."],
    }),
  ];
  const { payload, log } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: passthroughClusterFn("ef-empty"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: HYBRID,
    embedFn: async () => {
      throw new Error("provider 503 simulated failure");
    },
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  if (stories.length !== 0) {
    reasons.push(`expected strict-empty but received ${stories.length} story/stories`);
  }
  if (!log?.recall?.degraded) {
    reasons.push("recall.degraded must be true on embedding failure");
  }
  if (!/^embedding_(error|timeout|invalid_response|unavailable)_fail_closed$/.test(
    log?.recall?.degraded_reason ?? ""
  )) {
    reasons.push(`expected fail-closed degraded_reason, got: ${log?.recall?.degraded_reason}`);
  }
  if (log?.recall?.keywordFallbackAfterEmbeddingFailure === true) {
    reasons.push(
      "keywordFallbackAfterEmbeddingFailure must NOT be set when lexical recall is empty"
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: { stories, recall: log?.recall },
  };
}

async function scenarioSettingsSaveRefreshPropagation() {
  // API-side half of the Settings save → refresh trigger contract.
  // The prototype-side trigger fire is covered by
  // `04-prototype/src/pages/Settings.test.tsx` (5 tests under
  // "Settings — debounced save → dashboard refresh trigger"). Here we verify
  // the API contract that trigger depends on: a refresh under different
  // settings produces different output, so triggering after a save actually
  // updates the user-visible dashboard.
  const rawItems = [
    makeItem({
      sourceId: "prop-a",
      outlet: "Reuters",
      topic: "Trade policy",
      geographies: ["US", "China"],
      headline: "US weighs new China trade measures",
      body: ["China trade policy update."],
    }),
    makeItem({
      sourceId: "prop-b",
      outlet: "Reuters",
      topic: "Migration policy",
      geographies: ["US", "Mexico"],
      headline: "US updates border migration guidance",
      body: ["Migration policy update."],
    }),
  ];
  const tradeSettings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Trade policy"],
    keywords: ["china", "trade"],
    geographies: ["US", "China"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const migrationSettings = {
    ...tradeSettings,
    topics: ["Migration policy"],
    keywords: ["migration", "border"],
    geographies: ["US", "Mexico"],
  };
  const baseOpts = {
    rawItems,
    clusterFn: passthroughClusterFn("prop"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    // Use KEYWORD mode for this scenario. The propagation contract under
    // test is "settings change → refresh output changes" — a lexical-only
    // recall makes the dependency on `settings.topics` + `settings.keywords`
    // visible without the embedding union blurring the boundary (an
    // omnibus stub embedder would mark every item relevant to every
    // settings variant, masking the contract).
    recallConfig: KEYWORD,
  };

  const tradeRun = await runRefreshPipeline({ ...baseOpts, settings: tradeSettings });
  const migrationRun = await runRefreshPipeline({
    ...baseOpts,
    settings: migrationSettings,
  });

  const tradeIds = (tradeRun.payload?.stories ?? []).flatMap((s) =>
    s.sources.map((src) => src.id)
  );
  const migIds = (migrationRun.payload?.stories ?? []).flatMap((s) =>
    s.sources.map((src) => src.id)
  );

  const reasons = [];
  if (tradeIds.length === 0 || migIds.length === 0) {
    reasons.push("one of the settings variants produced no stories — propagation untestable");
  }
  if (!tradeIds.includes("prop-a")) reasons.push("trade settings did not surface China-trade item");
  if (!migIds.includes("prop-b")) reasons.push("migration settings did not surface border item");
  if (tradeIds.includes("prop-b")) {
    reasons.push("trade settings leaked migration item — propagation not settings-sensitive");
  }
  if (migIds.includes("prop-a")) {
    reasons.push("migration settings leaked trade item — propagation not settings-sensitive");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: {
      tradeStorySourceIds: tradeIds,
      migrationStorySourceIds: migIds,
      prototypeTestRef:
        "04-prototype/src/pages/Settings.test.tsx — debounced save → dashboard refresh trigger",
    },
  };
}

async function scenarioGroundingTrustGuard() {
  // Cluster output references a hallucinated source id alongside a real one.
  // Phase 3 strict-grounding posture: ANY grounding failure drops the story.
  // The must-pass: payload contains NO ungrounded story; rejection metadata
  // explains the drop.
  const settings = {
    contractVersion: "2026-04-22-slice1",
    topics: ["Diplomatic relations"],
    keywords: ["bilateral"],
    geographies: ["US"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const rawItems = [
    makeItem({
      sourceId: "real-1",
      outlet: "Reuters",
      topic: "Diplomatic relations",
      geographies: ["US"],
      headline: "Bilateral talks resume",
      body: ["Officials confirmed bilateral cooperation."],
    }),
  ];
  const hallucinatingClusterFn = async (items) => {
    const real = items.find((i) => i.sourceId === "real-1");
    if (!real) return [];
    return [
      {
        meta_story_id: "ms-bad",
        title: "Story with hallucinated source",
        subtitle: "Sub",
        source_item_ids: [real.sourceId, "hallucinated-id"],
        summary: "Summary.",
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        factual_claims: ["A claim."],
        claim_evidence_map: { "0": [real.sourceId, "hallucinated-id"] },
      },
    ];
  };
  const { payload, log } = await runRefreshPipeline({
    settings,
    rawItems,
    clusterFn: hallucinatingClusterFn,
    clusterModel: "mock-anthropic-haiku",
    contractVersion: "2026-04-22-slice1",
    recallConfig: KEYWORD, // bypass embeddings — focus is grounding
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  if (stories.length !== 0) {
    reasons.push(`ungrounded story shipped — expected strict-grounding drop (got ${stories.length})`);
  }
  if ((log?.droppedUngroundedStoryCount ?? 0) === 0) {
    reasons.push("rejection log did not record the ungrounded drop");
  }
  if (!log?.groundingDropReasons || Object.keys(log.groundingDropReasons).length === 0) {
    reasons.push("groundingDropReasons must explain the drop");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: {
      stories,
      droppedUngroundedStoryCount: log?.droppedUngroundedStoryCount,
      groundingDropReasons: log?.groundingDropReasons,
    },
  };
}

// ─── Scenario registry ───────────────────────────────────────────────────────

const SCENARIO_DEFS = Object.freeze([
  {
    id: "critical-01-china-defense-trade",
    intent: "US–China + defense/military + trade/economy",
    run: scenarioChinaDefenseTrade,
  },
  {
    id: "critical-02-monitoring-migration-border",
    intent: "Migration / border policy narrative",
    run: scenarioMonitoringMigrationBorder,
  },
  {
    id: "critical-03-source-scoped-relevance",
    intent: "Narrow source scope — relevant content from selected sources only",
    run: scenarioSourceScopedRelevance,
  },
  {
    id: "critical-04-empty-profile-lexical-path",
    intent: "Sparse / empty profile — lexical hits still surface",
    run: scenarioEmptyProfileLexicalPath,
  },
  {
    id: "critical-05-embedding-failure-with-lexical-hits",
    intent: "Embedding failure + lexical hits → lexical fallback with diagnostics",
    run: scenarioEmbeddingFailureWithLexicalHits,
  },
  {
    id: "critical-06-embedding-failure-without-lexical-hits",
    intent: "Embedding failure + no lexical hits → diagnosed strict-empty",
    run: scenarioEmbeddingFailureWithoutLexicalHits,
  },
  {
    id: "critical-07-settings-save-refresh-propagation",
    intent: "Settings change is reflected in refresh output (API contract behind the trigger)",
    run: scenarioSettingsSaveRefreshPropagation,
  },
  {
    id: "critical-08-grounding-trust-guard",
    intent: "Ungrounded meta-story is dropped, not shipped",
    run: scenarioGroundingTrustGuard,
  },
]);

export const CRITICAL_SCENARIO_IDS = Object.freeze(SCENARIO_DEFS.map((d) => d.id));

/**
 * Run all 8 critical scenarios. Returns a structured result the CLI/judge
 * can format and act on. Pure: no console output, no exits.
 *
 * @param {object} [opts]
 * @param {Map<string, () => Promise<{ ok, reasons, diagnostics }>>} [opts.overrides]
 *   Optional per-scenario override map keyed by scenario id. Used by unit
 *   tests to swap a scenario's run function for a deterministic stub.
 */
export async function runCriticalSuite({ overrides = new Map() } = {}) {
  // D-063: scenarios assert the legacy precision-first contract (e.g. critical-02
  // mig-noise must not leak at ~0.30). MVP default is 0.20; pin here for CI/CLI.
  process.env.TEMPO_BEAT_FIT_THRESHOLD = "0.40";

  const results = [];
  for (const def of SCENARIO_DEFS) {
    const run = overrides.get(def.id) ?? def.run;
    let outcome;
    try {
      outcome = await run();
    } catch (err) {
      outcome = {
        ok: false,
        reasons: [`scenario threw: ${err instanceof Error ? err.message : String(err)}`],
        diagnostics: { error: true },
      };
    }
    results.push({
      id: def.id,
      intent: def.intent,
      ok: outcome.ok,
      reasons: outcome.reasons ?? [],
      diagnostics: outcome.diagnostics ?? {},
    });
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      hardFail: results.some((r) => !r.ok),
    },
  };
}

// ─── Warning policy / hybrid aggregator ──────────────────────────────────────

/**
 * Build the final release-gate verdict from critical results + advisory
 * inputs (drift findings + LLM judge findings).
 *
 * Rules:
 *   - Any failed critical scenario → `hardFail: true`, `release: false`.
 *   - Drift / judge findings are warnings only — they never gate.
 *   - When `hardFail` AND any drift / judge finding is present, the verdict
 *     attaches a causal note so operators see the correlation explicitly.
 *
 * @param {object} input
 * @param {{ id: string, ok: boolean, reasons: string[] }[]} input.criticalResults
 * @param {Array<{ id: string, level: "info"|"warn", message: string }>} [input.driftFindings]
 * @param {Array<{ id: string, level: "info"|"warn", message: string, score?: number }>} [input.judgeFindings]
 */
export function aggregateVerdict({
  criticalResults,
  driftFindings = [],
  judgeFindings = [],
}) {
  const failedCritical = criticalResults.filter((r) => !r.ok);
  const hardFail = failedCritical.length > 0;

  const warnings = [
    ...driftFindings.map((f) => ({ source: "drift", ...f })),
    ...judgeFindings.map((f) => ({ source: "judge", ...f })),
  ];

  const causalNotes = [];
  if (hardFail && warnings.length > 0) {
    causalNotes.push(
      `${failedCritical.length} critical scenario(s) failed and ${warnings.length} advisory finding(s) are present — investigate whether the drift signals correlate with the failures.`
    );
  }

  return {
    release: !hardFail,
    hardFail,
    failedCriticalIds: failedCritical.map((r) => r.id),
    warnings,
    causalNotes,
  };
}
