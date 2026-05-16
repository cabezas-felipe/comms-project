import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUNTIME_STATE,
  SemanticScorerTimeoutError,
  accumulateAxisDiagnostics,
  createEmbeddingSemanticScorer,
  emptyAggregateAxisDiagnostics,
  mapSemanticAxis,
  mapSemanticTopicsAndKeywords,
  resolveSemanticScorerRuntimeConfig,
  resolveSemanticTagConfig,
} from "./meta-story-semantic-mapper.mjs";

// ─── Test scorer fixtures ────────────────────────────────────────────────────
//
// The mapper is provider-agnostic — production wires in an embedding or
// constrained-classifier call; tests inject a deterministic `scorer(text,
// label) -> number`.  These small fixtures keep each test's intent obvious:
// the table IS the test.

function makeTableScorer(table) {
  // table: { [labelLower]: { keywords: [substring -> score]} } where the
  // score is returned when ANY substring is found in the evidence text.
  // First-match-wins; default score = 0.
  return async (evidence, label) => {
    const entry = table[label.toLowerCase()];
    if (!entry) return 0;
    const lower = evidence.toLowerCase();
    for (const [needle, score] of entry) {
      if (lower.includes(needle)) return score;
    }
    return 0;
  };
}

function neverScorer() {
  return async () => 0;
}

function alwaysScorer(score) {
  return async () => score;
}

// ─── resolveSemanticTagConfig ────────────────────────────────────────────────

test("resolveSemanticTagConfig: defaults are OFF and per-axis OFF when env is empty", () => {
  const cfg = resolveSemanticTagConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.topicsEnabled, false);
  assert.equal(cfg.keywordsEnabled, false);
  assert.equal(cfg.topicsThreshold, 0.75);
  assert.equal(cfg.keywordsThreshold, 0.75);
});

test("resolveSemanticTagConfig: per-axis flag requires the global flag too (AND semantics)", () => {
  // Per-axis ON but global OFF — axis stays OFF.
  const cfg = resolveSemanticTagConfig({
    TEMPO_TAG_SEMANTIC_MAPPING_ENABLED: "false",
    TEMPO_TAG_SEMANTIC_TOPICS_ENABLED: "true",
    TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED: "true",
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.topicsEnabled, false);
  assert.equal(cfg.keywordsEnabled, false);
});

test("resolveSemanticTagConfig: global ON + per-axis ON enables that axis only", () => {
  const cfg = resolveSemanticTagConfig({
    TEMPO_TAG_SEMANTIC_MAPPING_ENABLED: "true",
    TEMPO_TAG_SEMANTIC_TOPICS_ENABLED: "true",
    TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED: "false",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.topicsEnabled, true);
  assert.equal(cfg.keywordsEnabled, false);
});

test("resolveSemanticTagConfig: thresholds parse from env in [0,1]; out-of-range falls back to default", () => {
  const cfg = resolveSemanticTagConfig({
    TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD: "0.42",
    TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD: "2.5", // out of range → default
  });
  assert.equal(cfg.topicsThreshold, 0.42);
  assert.equal(cfg.keywordsThreshold, 0.75);
});

test("resolveSemanticTagConfig: overrides shortcut env reads (test seam)", () => {
  const cfg = resolveSemanticTagConfig(
    {
      // env would say OFF; overrides must win.
      TEMPO_TAG_SEMANTIC_MAPPING_ENABLED: "false",
    },
    { enabled: true, topicsEnabled: true, topicsThreshold: 0.6 }
  );
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.topicsEnabled, true);
  assert.equal(cfg.topicsThreshold, 0.6);
});

// ─── mapSemanticAxis — disabled / missing-scorer fast paths ──────────────────

test("mapSemanticAxis: disabled (enabled=false) returns empty additions and skipped diagnostics", async () => {
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb.",
    allowedLabels: ["oil"],
    deterministicLabels: [],
    threshold: 0.5,
    enabled: false,
    scorer: alwaysScorer(0.99), // would otherwise accept everything
  });
  assert.deepEqual(accepted, []);
  assert.equal(diagnostics.enabled, false);
  assert.equal(diagnostics.candidateCount, 0);
  assert.equal(diagnostics.acceptedCount, 0);
});

test("mapSemanticAxis: enabled but no scorer → no-op (scorerProvided=false)", async () => {
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb.",
    allowedLabels: ["oil"],
    threshold: 0.5,
    enabled: true,
    // scorer omitted
  });
  assert.deepEqual(accepted, []);
  assert.equal(diagnostics.scorerProvided, false);
  assert.equal(diagnostics.candidateCount, 0);
});

test("mapSemanticAxis: empty evidence text yields no candidates (no work done)", async () => {
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "topics",
    evidenceText: "",
    allowedLabels: ["Diplomatic relations", "Migration policy"],
    threshold: 0.5,
    enabled: true,
    scorer: alwaysScorer(1.0),
  });
  assert.deepEqual(accepted, []);
  assert.equal(diagnostics.candidateCount, 0);
});

// ─── mapSemanticAxis — accept / reject / dedupe ──────────────────────────────

test("mapSemanticAxis (keywords): 'petroleum' evidence + 'oil' in settings + above-threshold scorer → accepts 'oil'", async () => {
  const scorer = makeTableScorer({ oil: [["petroleum", 0.9]] });
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb again.",
    allowedLabels: ["oil", "OFAC", "sanctions"],
    deterministicLabels: [],
    threshold: 0.75,
    enabled: true,
    scorer,
  });
  assert.deepEqual(accepted, ["oil"]);
  assert.equal(diagnostics.candidateCount, 3, "all settings labels considered (none were deterministic)");
  assert.equal(diagnostics.acceptedCount, 1);
  assert.equal(diagnostics.rejectedCount, 2);
  assert.equal(diagnostics.belowThresholdCount, 2);
});

test("mapSemanticAxis (keywords): below-threshold score is rejected and counted as belowThreshold", async () => {
  const scorer = makeTableScorer({ oil: [["petroleum", 0.6]] });
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb again.",
    allowedLabels: ["oil"],
    threshold: 0.75,
    enabled: true,
    scorer,
  });
  assert.deepEqual(accepted, []);
  assert.equal(diagnostics.acceptedCount, 0);
  assert.equal(diagnostics.belowThresholdCount, 1);
});

test("mapSemanticAxis: labels already on the deterministic list are skipped (no rescoring, no double-count)", async () => {
  const scorer = alwaysScorer(0.99);
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Sanctions news.",
    allowedLabels: ["sanctions", "OFAC"],
    deterministicLabels: ["sanctions"], // already accepted upstream
    threshold: 0.5,
    enabled: true,
    scorer,
  });
  // 'sanctions' is skipped (deterministic), 'OFAC' scored and accepted.
  assert.deepEqual(accepted, ["OFAC"]);
  assert.equal(diagnostics.candidateCount, 1);
  assert.equal(diagnostics.acceptedCount, 1);
});

test("mapSemanticAxis: case-insensitive deterministic dedupe", async () => {
  const { accepted } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Sanctions news.",
    allowedLabels: ["Sanctions"],
    deterministicLabels: ["sanctions"], // different case, same label
    threshold: 0.1,
    enabled: true,
    scorer: alwaysScorer(0.9),
  });
  assert.deepEqual(accepted, []);
});

test("mapSemanticAxis: out-of-settings label can NEVER appear in `accepted` (closed vocabulary)", async () => {
  // Test that the function only scores `allowedLabels`.  We try to feed a
  // scorer that loves "petroleum"; but petroleum isn't in `allowedLabels`,
  // so it's never even passed to the scorer.
  const seenLabels = [];
  const scorer = async (_text, label) => {
    seenLabels.push(label);
    return 0.99;
  };
  const { accepted } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb again.",
    allowedLabels: ["oil"], // closed vocab
    threshold: 0.5,
    enabled: true,
    scorer,
  });
  assert.deepEqual(accepted, ["oil"]);
  assert.deepEqual(seenLabels, ["oil"], "scorer must only see settings labels — never the evidence token");
});

test("mapSemanticAxis: scorer throwing on one candidate counts as a rejection and doesn't break the run", async () => {
  let calls = 0;
  const scorer = async (_text, label) => {
    calls += 1;
    if (label === "OFAC") throw new Error("boom");
    return 0.9;
  };
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Sanctions news.",
    allowedLabels: ["OFAC", "sanctions"],
    threshold: 0.5,
    enabled: true,
    scorer,
  });
  assert.equal(calls, 2, "both candidates scored");
  assert.deepEqual(accepted, ["sanctions"], "the throwing candidate is treated as rejected");
  assert.equal(diagnostics.rejectedCount, 1);
});

// ─── Topics axis behavior ────────────────────────────────────────────────────

test("mapSemanticAxis (topics): only emits a settings topic that is opted in (no fabrication)", async () => {
  const scorer = makeTableScorer({
    "diplomatic relations": [["talks", 0.9]],
    "energy policy": [["talks", 0.95]], // would be highest, but not in settings
  });
  const { accepted } = await mapSemanticAxis({
    axis: "topics",
    evidenceText: "High-stakes talks resumed in the capital.",
    allowedLabels: ["Diplomatic relations"], // user hasn't opted into Energy policy
    threshold: 0.75,
    enabled: true,
    scorer,
  });
  assert.deepEqual(accepted, ["Diplomatic relations"]);
});

// ─── mapSemanticTopicsAndKeywords (convenience wrapper) ──────────────────────

test("mapSemanticTopicsAndKeywords: maps both axes in one call with per-axis thresholds", async () => {
  const scorer = makeTableScorer({
    "diplomatic relations": [["talks", 0.9]],
    "oil": [["petroleum", 0.9]],
  });
  const out = await mapSemanticTopicsAndKeywords({
    evidenceText: "Talks resumed; petroleum prices climb.",
    settingsTopics: ["Diplomatic relations"],
    settingsKeywords: ["oil"],
    config: {
      enabled: true,
      topicsEnabled: true,
      keywordsEnabled: true,
      topicsThreshold: 0.75,
      keywordsThreshold: 0.75,
    },
    scorer,
  });
  assert.deepEqual(out.topics.accepted, ["Diplomatic relations"]);
  assert.deepEqual(out.keywords.accepted, ["oil"]);
});

test("mapSemanticTopicsAndKeywords: per-axis disable still runs the other axis", async () => {
  const scorer = makeTableScorer({
    "diplomatic relations": [["talks", 0.9]],
    "oil": [["petroleum", 0.9]],
  });
  const out = await mapSemanticTopicsAndKeywords({
    evidenceText: "Talks resumed; petroleum prices climb.",
    settingsTopics: ["Diplomatic relations"],
    settingsKeywords: ["oil"],
    config: {
      enabled: true,
      topicsEnabled: true,
      keywordsEnabled: false, // keywords axis is OFF
      topicsThreshold: 0.75,
      keywordsThreshold: 0.75,
    },
    scorer,
  });
  assert.deepEqual(out.topics.accepted, ["Diplomatic relations"]);
  assert.deepEqual(out.keywords.accepted, []);
  assert.equal(out.keywords.diagnostics.enabled, false);
});

test("mapSemanticTopicsAndKeywords: passes through deterministic baselines so semantic doesn't re-score them", async () => {
  const scorer = alwaysScorer(0.99); // would accept everything not skipped
  const out = await mapSemanticTopicsAndKeywords({
    evidenceText: "Anything goes.",
    settingsTopics: ["Diplomatic relations", "Migration policy"],
    settingsKeywords: ["OFAC", "sanctions"],
    deterministicTopics: ["Diplomatic relations"],
    deterministicKeywords: ["OFAC"],
    config: {
      enabled: true,
      topicsEnabled: true,
      keywordsEnabled: true,
      topicsThreshold: 0.5,
      keywordsThreshold: 0.5,
    },
    scorer,
  });
  // Already-deterministic labels are skipped; only the *new* candidates count.
  assert.deepEqual(out.topics.accepted, ["Migration policy"]);
  assert.deepEqual(out.keywords.accepted, ["sanctions"]);
});

// ─── Diagnostic aggregation helpers ──────────────────────────────────────────

test("accumulateAxisDiagnostics: composes axis diagnostics across stories without mutation", () => {
  const story1 = {
    axis: "keywords",
    enabled: true,
    scorerProvided: true,
    threshold: 0.75,
    candidateCount: 3,
    acceptedCount: 1,
    rejectedCount: 2,
    belowThresholdCount: 2,
  };
  const story2 = { ...story1, candidateCount: 2, acceptedCount: 0, rejectedCount: 2, belowThresholdCount: 1 };
  const agg = accumulateAxisDiagnostics(
    accumulateAxisDiagnostics(emptyAggregateAxisDiagnostics("keywords"), story1),
    story2
  );
  assert.equal(agg.storyCount, 2);
  assert.equal(agg.candidateCount, 5);
  assert.equal(agg.acceptedCount, 1);
  assert.equal(agg.rejectedCount, 4);
  assert.equal(agg.belowThresholdCount, 3);
  assert.equal(agg.threshold, 0.75);
  assert.equal(agg.enabled, true);
  // Original story diagnostics unchanged
  assert.equal(story1.acceptedCount, 1);
});

test("accumulateAxisDiagnostics: gracefully handles malformed entries (no NaN, no throws)", () => {
  const agg = accumulateAxisDiagnostics(emptyAggregateAxisDiagnostics("topics"), null);
  assert.equal(agg.storyCount, 0);
});

// ─── Defensive uses of neverScorer (no leakage of out-of-settings labels) ────

test("mapSemanticAxis: even with a non-zero scorer, nothing is emitted when allowedLabels is empty", async () => {
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Anything.",
    allowedLabels: [],
    threshold: 0.1,
    enabled: true,
    scorer: alwaysScorer(0.99),
  });
  assert.deepEqual(accepted, []);
  assert.equal(diagnostics.candidateCount, 0);
});

test("mapSemanticAxis: a never-accepting scorer rejects everything and produces clean diagnostics", async () => {
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "topics",
    evidenceText: "Talks resumed.",
    allowedLabels: ["Diplomatic relations", "Migration policy"],
    threshold: 0.75,
    enabled: true,
    scorer: neverScorer(),
  });
  assert.deepEqual(accepted, []);
  assert.equal(diagnostics.candidateCount, 2);
  assert.equal(diagnostics.belowThresholdCount, 2);
});

// ─── Phase 5: runtime state + fallback categorization ───────────────────────
//
// `mapSemanticAxis` now surfaces a single-string `runtimeState`, per-axis
// `scorerLatencyMs`, and `fallbackReasonCounts: {timeout, error}` so an
// operator can read rollout posture without recombining flags.  These tests
// pin (a) the state derivation rules, (b) timeout vs error categorization,
// (c) latency aggregation, and (d) graceful degradation on scorer failures.

test("mapSemanticAxis: runtimeState = 'disabled' when enabled flag is false", async () => {
  const { diagnostics } = await mapSemanticAxis({
    axis: "topics",
    evidenceText: "Anything.",
    allowedLabels: ["Diplomatic relations"],
    threshold: 0.5,
    enabled: false,
    scorer: alwaysScorer(1),
  });
  assert.equal(diagnostics.runtimeState, RUNTIME_STATE.DISABLED);
  assert.equal(diagnostics.fallbackReasonCounts.timeout, 0);
  assert.equal(diagnostics.fallbackReasonCounts.error, 0);
});

test("mapSemanticAxis: runtimeState = 'enabled_no_scorer' when scorer is missing", async () => {
  const { diagnostics } = await mapSemanticAxis({
    axis: "topics",
    evidenceText: "Talks resumed.",
    allowedLabels: ["Diplomatic relations"],
    threshold: 0.5,
    enabled: true,
    // scorer omitted
  });
  assert.equal(diagnostics.runtimeState, RUNTIME_STATE.ENABLED_NO_SCORER);
});

test("mapSemanticAxis: runtimeState = 'enabled_scorer_ready' on a clean run", async () => {
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb.",
    allowedLabels: ["oil"],
    threshold: 0.5,
    enabled: true,
    scorer: alwaysScorer(0.9),
  });
  assert.deepEqual(accepted, ["oil"]);
  assert.equal(diagnostics.runtimeState, RUNTIME_STATE.ENABLED_SCORER_READY);
  assert.equal(diagnostics.fallbackReasonCounts.timeout, 0);
  assert.equal(diagnostics.fallbackReasonCounts.error, 0);
});

test("mapSemanticAxis: timeout error in scorer → runtimeState = 'scorer_timeout_fallback', deterministic baseline preserved", async () => {
  // Mapper itself returns the deterministic-only result; the *pipeline* keeps
  // the Phase 3 baseline ahead of it.  Here we verify the mapper categorizes
  // the failure correctly and counts it under `timeout`.
  const scorer = async () => {
    throw new SemanticScorerTimeoutError("simulated");
  };
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb.",
    allowedLabels: ["oil", "sanctions"],
    threshold: 0.5,
    enabled: true,
    scorer,
  });
  assert.deepEqual(accepted, [], "no semantic uplift when scorer times out");
  assert.equal(diagnostics.runtimeState, RUNTIME_STATE.SCORER_TIMEOUT_FALLBACK);
  assert.equal(diagnostics.fallbackReasonCounts.timeout, 2);
  assert.equal(diagnostics.fallbackReasonCounts.error, 0);
});

test("mapSemanticAxis: generic scorer error → runtimeState = 'scorer_error_fallback'", async () => {
  const scorer = async () => {
    throw new Error("provider went sideways");
  };
  const { accepted, diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Anything.",
    allowedLabels: ["OFAC"],
    threshold: 0.5,
    enabled: true,
    scorer,
  });
  assert.deepEqual(accepted, []);
  assert.equal(diagnostics.runtimeState, RUNTIME_STATE.SCORER_ERROR_FALLBACK);
  assert.equal(diagnostics.fallbackReasonCounts.error, 1);
  assert.equal(diagnostics.fallbackReasonCounts.timeout, 0);
});

test("mapSemanticAxis: timeout dominates error in runtime state when both occur", async () => {
  let i = 0;
  const scorer = async () => {
    i += 1;
    if (i === 1) throw new Error("boom");
    throw new SemanticScorerTimeoutError("slow");
  };
  const { diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb.",
    allowedLabels: ["OFAC", "sanctions"],
    threshold: 0.5,
    enabled: true,
    scorer,
  });
  // Both reasons counted, but the runtime state surfaces the more actionable
  // signal (timeout > error).
  assert.equal(diagnostics.fallbackReasonCounts.error, 1);
  assert.equal(diagnostics.fallbackReasonCounts.timeout, 1);
  assert.equal(diagnostics.runtimeState, RUNTIME_STATE.SCORER_TIMEOUT_FALLBACK);
});

test("mapSemanticAxis: scorerLatencyMs accumulates wall-clock time, including failed calls", async () => {
  let i = 0;
  const scorer = async () => {
    i += 1;
    // First call succeeds quickly; second call sleeps then throws timeout.
    if (i === 1) return 0.9;
    await new Promise((r) => setTimeout(r, 25));
    throw new SemanticScorerTimeoutError("slow");
  };
  const { diagnostics } = await mapSemanticAxis({
    axis: "keywords",
    evidenceText: "Petroleum prices climb.",
    allowedLabels: ["oil", "sanctions"],
    threshold: 0.5,
    enabled: true,
    scorer,
  });
  assert.ok(diagnostics.scorerLatencyMs >= 25, "failed timeout call latency must be included");
});

// ─── Aggregate diagnostics: worse-state precedence + per-reason sums ────────

test("accumulateAxisDiagnostics: runtime state aggregates to the worst seen across stories", () => {
  const ready = {
    runtimeState: RUNTIME_STATE.ENABLED_SCORER_READY,
    enabled: true,
    scorerProvided: true,
    threshold: 0.75,
    candidateCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    belowThresholdCount: 0,
    scorerLatencyMs: 10,
    fallbackReasonCounts: { timeout: 0, error: 0 },
  };
  const errored = { ...ready, runtimeState: RUNTIME_STATE.SCORER_ERROR_FALLBACK, fallbackReasonCounts: { timeout: 0, error: 1 } };
  const timedOut = { ...ready, runtimeState: RUNTIME_STATE.SCORER_TIMEOUT_FALLBACK, fallbackReasonCounts: { timeout: 1, error: 0 } };
  let agg = emptyAggregateAxisDiagnostics("keywords");
  agg = accumulateAxisDiagnostics(agg, ready);
  agg = accumulateAxisDiagnostics(agg, errored);
  agg = accumulateAxisDiagnostics(agg, timedOut);
  // Worst rank wins.
  assert.equal(agg.runtimeState, RUNTIME_STATE.SCORER_TIMEOUT_FALLBACK);
  assert.equal(agg.fallbackReasonCounts.error, 1);
  assert.equal(agg.fallbackReasonCounts.timeout, 1);
  assert.equal(agg.scorerLatencyMs, 30);
  assert.equal(agg.storyCount, 3);
});

// ─── Production scorer factory (cosine over injected embedder) ──────────────
//
// `createEmbeddingSemanticScorer` is the seam Phase 5 wires into server.mjs.
// These tests inject a deterministic `embedFn` so the factory's behavior is
// covered without any network calls.  Cosine similarity is rescaled from
// `[-1, 1]` to `[0, 1]`.

function makeStaticEmbedFn(table) {
  // table: { [text]: number[] }
  return async (texts) => texts.map((t) => table[t] ?? new Array(3).fill(0));
}

test("createEmbeddingSemanticScorer: identical vectors → score = 1 (cosine 1 → 1.0)", async () => {
  const scorer = createEmbeddingSemanticScorer({
    embedFn: makeStaticEmbedFn({
      "Petroleum prices climb.": [1, 0, 0],
      oil: [1, 0, 0],
    }),
  });
  const score = await scorer("Petroleum prices climb.", "oil");
  assert.ok(score > 0.999 && score <= 1, `expected ≈1, got ${score}`);
});

test("createEmbeddingSemanticScorer: orthogonal vectors → score = 0.5 (cosine 0 → 0.5 after rescale)", async () => {
  const scorer = createEmbeddingSemanticScorer({
    embedFn: makeStaticEmbedFn({ x: [1, 0, 0], y: [0, 1, 0] }),
  });
  const score = await scorer("x", "y");
  assert.ok(score > 0.49 && score < 0.51, `expected ≈0.5, got ${score}`);
});

test("createEmbeddingSemanticScorer: truncates evidence text to maxEvidenceChars before embedding", async () => {
  const seenTexts = [];
  const embedFn = async (texts) => {
    seenTexts.push(...texts);
    return texts.map(() => [1, 0]);
  };
  const scorer = createEmbeddingSemanticScorer({ embedFn, maxEvidenceChars: 10 });
  await scorer("x".repeat(100), "oil");
  // First text passed to embedFn should be the truncated evidence.
  assert.equal(seenTexts[0].length, 10);
});

test("createEmbeddingSemanticScorer: memoizes evidence + label vectors across calls", async () => {
  let callCount = 0;
  const embedFn = async (texts) => {
    callCount += 1;
    return texts.map(() => [1, 0]);
  };
  const scorer = createEmbeddingSemanticScorer({ embedFn });
  await scorer("evidence-a", "oil");
  await scorer("evidence-a", "oil"); // both cached → no second embedFn call
  assert.equal(callCount, 1, "second probe with same inputs must hit cache");
  await scorer("evidence-a", "sanctions"); // new label → one more call
  assert.equal(callCount, 2);
});

test("createEmbeddingSemanticScorer: throws SemanticScorerTimeoutError on slow embedFn", async () => {
  const embedFn = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return [[1, 0]];
  };
  const scorer = createEmbeddingSemanticScorer({ embedFn, timeoutMs: 5 });
  await assert.rejects(() => scorer("evidence", "oil"), SemanticScorerTimeoutError);
});

test("createEmbeddingSemanticScorer: malformed embedFn response → generic Error (categorized as 'error', not 'timeout')", async () => {
  const embedFn = async () => "not an array";
  const scorer = createEmbeddingSemanticScorer({ embedFn });
  await assert.rejects(
    () => scorer("evidence", "oil"),
    (err) => err instanceof Error && !(err instanceof SemanticScorerTimeoutError)
  );
});

test("createEmbeddingSemanticScorer: throws on construction when embedFn is not a function", () => {
  assert.throws(() => createEmbeddingSemanticScorer({ embedFn: null }), /embedFn must be a function/);
});

// ─── resolveSemanticScorerRuntimeConfig ─────────────────────────────────────

test("resolveSemanticScorerRuntimeConfig: defaults are sane (1500ms timeout, 4000-char evidence cap)", () => {
  const cfg = resolveSemanticScorerRuntimeConfig({});
  assert.equal(cfg.timeoutMs, 1500);
  assert.equal(cfg.maxEvidenceChars, 4000);
});

test("resolveSemanticScorerRuntimeConfig: env overrides parse positive integers", () => {
  const cfg = resolveSemanticScorerRuntimeConfig({
    TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS: "500",
    TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS: "200",
  });
  assert.equal(cfg.timeoutMs, 500);
  assert.equal(cfg.maxEvidenceChars, 200);
});

test("resolveSemanticScorerRuntimeConfig: out-of-range / non-numeric env values fall back to defaults", () => {
  const cfg = resolveSemanticScorerRuntimeConfig({
    TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS: "-1",
    TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS: "abc",
  });
  assert.equal(cfg.timeoutMs, 1500);
  assert.equal(cfg.maxEvidenceChars, 4000);
});

test("resolveSemanticScorerRuntimeConfig: overrides shortcut env reads", () => {
  const cfg = resolveSemanticScorerRuntimeConfig(
    { TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS: "999" },
    { timeoutMs: 250, maxEvidenceChars: 50 }
  );
  assert.equal(cfg.timeoutMs, 250);
  assert.equal(cfg.maxEvidenceChars, 50);
});
