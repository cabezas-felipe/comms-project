import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  aggregateEvalMetrics,
  buildResolverInputForCase,
  buildValidationContextForCase,
  evaluateEvalGate,
  GATE_THRESHOLDS,
  isTraceComplete,
  REQUIRED_TRACE_FIELDS,
  scoreEvalCase,
} from "./why-this-matters-eval-utils.mjs";
import {
  buildJsonSummary,
  resolveStrictLabelMatch,
  runEvalCase,
  runEvalSuite,
} from "./run-why-this-matters-eval.mjs";

// ─── isTraceComplete ─────────────────────────────────────────────────────────

test("isTraceComplete: returns false on null / non-object / missing field", () => {
  assert.equal(isTraceComplete(null), false);
  assert.equal(isTraceComplete(undefined), false);
  assert.equal(isTraceComplete("trace"), false);
  const partial = Object.fromEntries(REQUIRED_TRACE_FIELDS.slice(0, -1).map((k) => [k, "x"]));
  assert.equal(isTraceComplete(partial), false);
});

test("isTraceComplete: returns true when every required field is present", () => {
  const full = Object.fromEntries(REQUIRED_TRACE_FIELDS.map((k) => [k, "x"]));
  assert.equal(isTraceComplete(full), true);
});

// ─── builders ────────────────────────────────────────────────────────────────

test("buildValidationContextForCase: pulls subtitle / summary / whatChanged / state from input", () => {
  const ctx = buildValidationContextForCase({
    input: {
      state: "evolving",
      whatChangedState: "changed",
      subtitle: "S",
      summary: "Sum",
      whatChanged: "WC",
      evidenceRefs: { summaryChars: 10 },
    },
  });
  assert.equal(ctx.state, "evolving");
  assert.equal(ctx.whatChangedState, "changed");
  assert.equal(ctx.subtitle, "S");
  assert.equal(ctx.summary, "Sum");
  assert.equal(ctx.whatChanged, "WC");
  assert.deepEqual(ctx.evidenceRefs, { summaryChars: 10 });
});

test("buildValidationContextForCase: missing fields fall to safe defaults", () => {
  const ctx = buildValidationContextForCase({});
  assert.equal(ctx.state, "steady");
  assert.equal(ctx.whatChangedState, null);
  assert.equal(ctx.subtitle, "");
  assert.equal(ctx.summary, "");
  assert.equal(ctx.whatChanged, "");
});

test("buildResolverInputForCase: doctrineAvailable=false yields empty doctrineSnippets[]", () => {
  const input = buildResolverInputForCase({
    id: "eval-x",
    input: { metaStoryId: "ms-1", subtitle: "S", doctrineAvailable: false },
  });
  assert.deepEqual(input.doctrineSnippets, []);
  assert.equal(input.metaStoryId, "ms-1");
});

test("buildResolverInputForCase: default doctrineAvailable injects one stub snippet", () => {
  const input = buildResolverInputForCase({ id: "eval-x", input: { subtitle: "S" } });
  assert.equal(input.doctrineSnippets.length, 1);
  assert.equal(input.doctrineSnippets[0].id, "doctrine.stub");
});

test("buildResolverInputForCase: forceWriterFail flag passes through", () => {
  const input = buildResolverInputForCase({ id: "eval-d03", input: { forceWriterFail: true } });
  assert.equal(input.forceWriterFail, true);
});

// ─── scoreEvalCase — validator path (Group C) ────────────────────────────────

const baseGroupCcase = (id, expectedFailDimension) => ({
  id,
  group: "C",
  input: { state: "evolving", subtitle: "x", summary: "y", whatChanged: "z" },
  expected: { expectedPass: false, expectedFailDimension, trapGolden: "trap text" },
});

test("scoreEvalCase: Group C passes when validator rejects with the expected fail dimension", () => {
  const row = scoreEvalCase(baseGroupCcase("eval-c-x", "non_prescriptive"), {
    type: "validator",
    validation: {
      pass: false,
      hardFail: true,
      failReasons: ["non_prescriptive", "auto_fail_phrase"],
      dimensionScores: { non_prescriptive: false },
    },
  });
  assert.equal(row.pass, true);
  // Hard-fail flag suppressed on a passing Group C case — the validator
  // hard-rejecting a trap is the desired outcome, not a shipping defect.
  assert.equal(row.hardFail, false);
  assert.equal(row.details.validatorHardFail, true);
  assert.equal(row.failReasons.length, 0);
});

test("scoreEvalCase: Group C fails when the trap unexpectedly passes the validator", () => {
  const row = scoreEvalCase(baseGroupCcase("eval-c-y", "non_duplication"), {
    type: "validator",
    validation: { pass: true, hardFail: false, failReasons: [], dimensionScores: {} },
  });
  assert.equal(row.pass, false);
  assert.ok(row.failReasons.includes("trap_passed_validator_unexpectedly"));
});

test("scoreEvalCase: Group C fails when the expected fail dimension is missing", () => {
  const row = scoreEvalCase(baseGroupCcase("eval-c-z", "non_duplication"), {
    type: "validator",
    validation: {
      pass: false,
      hardFail: true,
      failReasons: ["length"],
      dimensionScores: {},
    },
  });
  assert.equal(row.pass, false);
  assert.ok(
    row.failReasons.some((r) => r.startsWith("expected_fail_dimension_missing:non_duplication"))
  );
});

// ─── scoreEvalCase — resolver path ───────────────────────────────────────────

function buildFullTrace(overrides = {}) {
  const base = Object.fromEntries(REQUIRED_TRACE_FIELDS.map((k) => [k, k === "fallback_used" ? false : "x"]));
  return { ...base, ...overrides };
}

const baseResolverCase = (overrides = {}) => ({
  id: "eval-a-x",
  group: "A",
  input: {
    state: "intro",
    whatChangedState: "firstSeen",
    subtitle: "Sub",
    summary: "Summary",
    whatChanged: "First appearance in your feed.",
  },
  expected: {
    expectedPass: true,
    expectedTaxonomyPrimary: "monitoring_intensity",
    expectedConfidence: "medium",
    ...overrides,
  },
});

test("scoreEvalCase: resolver path with matching taxonomy/confidence + clean rubric passes", () => {
  const row = scoreEvalCase(baseResolverCase(), {
    type: "resolver",
    whyItMatters:
      "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
    trace: buildFullTrace({
      taxonomyPrimary: "monitoring_intensity",
      confidence: "medium",
      fallback_used: false,
    }),
    diagnostics: { fallbackUsed: false },
  });
  assert.equal(row.pass, true);
  assert.equal(row.fallbackUsed, false);
  assert.equal(row.traceComplete, true);
});

test("scoreEvalCase: MVP default — taxonomy mismatch is recorded in labelMismatches[] but does not fail the row", () => {
  const row = scoreEvalCase(baseResolverCase(), {
    type: "resolver",
    whyItMatters:
      "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
    trace: buildFullTrace({
      taxonomyPrimary: "narrative_stability",
      confidence: "medium",
      fallback_used: false,
    }),
    diagnostics: { fallbackUsed: false },
  });
  assert.equal(row.pass, true, `expected MVP default to ignore label mismatch; failReasons=${row.failReasons.join("; ")}`);
  assert.ok(Array.isArray(row.labelMismatches));
  assert.ok(row.labelMismatches.some((r) => r.startsWith("taxonomy_mismatch:")));
  assert.equal(
    row.failReasons.some((r) => r.startsWith("taxonomy_mismatch:")),
    false,
    "label mismatch must not leak into failReasons under MVP default"
  );
});

test("scoreEvalCase: strict mode — taxonomy mismatch fails the row with detailed reason in failReasons", () => {
  const row = scoreEvalCase(
    baseResolverCase(),
    {
      type: "resolver",
      whyItMatters:
        "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
      trace: buildFullTrace({
        taxonomyPrimary: "narrative_stability",
        confidence: "medium",
        fallback_used: false,
      }),
      diagnostics: { fallbackUsed: false },
    },
    { strictLabelMatch: true }
  );
  assert.equal(row.pass, false);
  assert.ok(row.failReasons.some((r) => r.startsWith("taxonomy_mismatch:")));
  // Under strict mode the mismatch flows through failReasons; labelMismatches stays empty.
  assert.deepEqual(row.labelMismatches, []);
});

test("scoreEvalCase: MVP default — confidence mismatch is also monitored not blocking", () => {
  const row = scoreEvalCase(baseResolverCase(), {
    type: "resolver",
    whyItMatters:
      "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
    trace: buildFullTrace({
      taxonomyPrimary: "monitoring_intensity",
      confidence: "high", // expected "medium"
      fallback_used: false,
    }),
    diagnostics: { fallbackUsed: false },
  });
  assert.equal(row.pass, true);
  assert.ok(row.labelMismatches.some((r) => r.startsWith("confidence_mismatch:")));
});

test("scoreEvalCase: resolver path detects rubric failure (e.g. duplication trap)", () => {
  const row = scoreEvalCase(baseResolverCase(), {
    type: "resolver",
    // Echoes the summary verbatim — non_duplication will trip.
    whyItMatters: "Summary",
    trace: buildFullTrace({
      taxonomyPrimary: "monitoring_intensity",
      confidence: "medium",
      fallback_used: false,
    }),
    diagnostics: { fallbackUsed: false },
  });
  assert.equal(row.pass, false);
  assert.ok(row.failReasons.some((r) => r.startsWith("rubric_fail:")));
});

test("scoreEvalCase: resolver path with expectFallbackUsed=true and fallback taken passes", () => {
  const row = scoreEvalCase(
    baseResolverCase({
      expectedTaxonomyPrimary: "signal_uncertainty",
      expectedConfidence: "low",
      expectFallbackUsed: true,
      allowFallback: true,
    }),
    {
      type: "resolver",
      whyItMatters: "fallback copy",
      trace: buildFullTrace({
        taxonomyPrimary: "signal_uncertainty",
        confidence: "low",
        fallback_used: true,
      }),
      diagnostics: { fallbackUsed: true },
    }
  );
  assert.equal(row.pass, true);
  assert.equal(row.fallbackUsed, true);
});

test("scoreEvalCase: resolver path with allowFallback=false but fallback used fails", () => {
  const row = scoreEvalCase(
    baseResolverCase({ allowFallback: false }),
    {
      type: "resolver",
      whyItMatters: "fallback copy",
      trace: buildFullTrace({
        taxonomyPrimary: "monitoring_intensity",
        confidence: "medium",
        fallback_used: true,
      }),
      diagnostics: { fallbackUsed: true },
    }
  );
  assert.equal(row.pass, false);
  assert.ok(row.failReasons.includes("fallback_used_when_disallowed"));
});

test("scoreEvalCase: resolver path flags incomplete trace", () => {
  const row = scoreEvalCase(baseResolverCase(), {
    type: "resolver",
    whyItMatters: "ignored",
    trace: { metaStoryId: "x" },
    diagnostics: { fallbackUsed: true },
  });
  assert.equal(row.pass, false);
  assert.ok(row.failReasons.includes("trace_incomplete"));
});

// ─── aggregateEvalMetrics ────────────────────────────────────────────────────

function makeRow(overrides = {}) {
  return {
    id: "x",
    group: "A",
    pass: true,
    hardFail: false,
    fallbackUsed: false,
    failReasons: [],
    ...overrides,
  };
}

test("aggregateEvalMetrics: zero rows -> zero counts and zero rates", () => {
  const m = aggregateEvalMetrics([]);
  assert.equal(m.total, 0);
  assert.equal(m.overallPassRate, 0);
  assert.equal(m.hardFailRate, 0);
  assert.equal(m.fallbackRate, 0);
  assert.equal(m.duplicationFailureRate, 0);
  assert.deepEqual(m.byGroup, {});
});

test("aggregateEvalMetrics: per-group counts + overall rates", () => {
  const rows = [
    makeRow({ group: "A", pass: true }),
    makeRow({ group: "A", pass: false, failReasons: ["taxonomy_mismatch:..."] }),
    makeRow({ group: "B", pass: true, fallbackUsed: true }),
    makeRow({ group: "C", pass: true, hardFail: false }),
    makeRow({ group: "D", pass: true }),
  ];
  const m = aggregateEvalMetrics(rows);
  assert.equal(m.total, 5);
  assert.equal(m.overallPass, 4);
  assert.equal(m.byGroup.A.pass, 1);
  assert.equal(m.byGroup.A.total, 2);
  assert.equal(m.byGroup.A.passRate, 0.5);
  assert.equal(m.fallbackCount, 1);
  assert.equal(m.fallbackRate, 0.2);
});

test("aggregateEvalMetrics: counts duplication failures from failReasons containing 'non_duplication'", () => {
  const rows = [
    makeRow({ group: "A", pass: false, failReasons: ["rubric_fail:non_duplication"] }),
    makeRow({ group: "A", pass: false, failReasons: ["rubric_fail:length"] }),
    makeRow({ group: "B", pass: true }),
  ];
  const m = aggregateEvalMetrics(rows);
  assert.equal(m.duplicationFailureCount, 1);
});

// ─── evaluateEvalGate ────────────────────────────────────────────────────────

function metricsTemplate(overrides = {}) {
  return {
    total: 18,
    overallPass: 18,
    overallPassRate: 1,
    hardFailCount: 0,
    hardFailRate: 0,
    fallbackCount: 0,
    fallbackRate: 0,
    duplicationFailureCount: 0,
    duplicationFailureRate: 0,
    byGroup: {
      A: { total: 6, pass: 6, hardFail: 0, fallback: 0, passRate: 1 },
      B: { total: 4, pass: 4, hardFail: 0, fallback: 0, passRate: 1 },
      C: { total: 4, pass: 4, hardFail: 0, fallback: 0, passRate: 1 },
      D: { total: 4, pass: 4, hardFail: 0, fallback: 0, passRate: 1 },
    },
    ...overrides,
  };
}

test("evaluateEvalGate: clean run -> no blockers or warnings", () => {
  const { blockers, warnings } = evaluateEvalGate(metricsTemplate());
  assert.deepEqual(blockers, []);
  assert.deepEqual(warnings, []);
});

test("evaluateEvalGate: any Group A miss is a blocker", () => {
  const m = metricsTemplate();
  m.byGroup.A.pass = 5;
  m.byGroup.A.passRate = 5 / 6;
  m.overallPass = 17;
  m.overallPassRate = 17 / 18;
  const { blockers } = evaluateEvalGate(m);
  assert.ok(blockers.some((b) => b.startsWith("group_A_pass_rate")));
});

test("evaluateEvalGate: overall pass rate below 90% is a blocker", () => {
  const { blockers } = evaluateEvalGate(metricsTemplate({ overallPassRate: 0.85 }));
  assert.ok(blockers.some((b) => b.startsWith("overall_pass_rate")));
});

test("evaluateEvalGate: hard-fail rate above 2% is a blocker", () => {
  const { blockers } = evaluateEvalGate(metricsTemplate({ hardFailRate: 0.05 }));
  assert.ok(blockers.some((b) => b.startsWith("hard_fail_rate")));
});

test("evaluateEvalGate: fallback rate above 10% is a warning (not blocker)", () => {
  const { blockers, warnings } = evaluateEvalGate(metricsTemplate({ fallbackRate: 0.2 }));
  assert.deepEqual(blockers, []);
  assert.ok(warnings.some((w) => w.startsWith("fallback_rate")));
});

test("evaluateEvalGate: duplication rate above 5% is a warning (not blocker)", () => {
  const { blockers, warnings } = evaluateEvalGate(metricsTemplate({ duplicationFailureRate: 0.1 }));
  assert.deepEqual(blockers, []);
  assert.ok(warnings.some((w) => w.startsWith("duplication_failure_rate")));
});

test("GATE_THRESHOLDS exposes the locked values", () => {
  assert.equal(GATE_THRESHOLDS.groupAPassRate, 1.0);
  assert.equal(GATE_THRESHOLDS.overallPassRate, 0.9);
  assert.equal(GATE_THRESHOLDS.hardFailRate, 0.02);
  assert.equal(GATE_THRESHOLDS.fallbackRate, 0.1);
  assert.equal(GATE_THRESHOLDS.duplicationFailureRate, 0.05);
});

// ─── runEvalCase (validator + resolver paths) ────────────────────────────────

test("runEvalCase: Group C dispatches to validator with the trap text", async () => {
  const outcome = await runEvalCase({
    id: "eval-c-test",
    group: "C",
    input: {
      state: "evolving",
      subtitle: "x",
      summary: "Two outlets reported new legal-context framing this morning, with both emphasizing court scheduling.",
      whatChanged: "z",
    },
    expected: {
      expectedFailDimension: "non_duplication",
      trapGolden: "Two outlets reported new legal-context framing this morning.",
    },
  });
  assert.equal(outcome.type, "validator");
  assert.equal(outcome.validation.pass, false);
  assert.ok(outcome.validation.failReasons.includes("non_duplication"));
});

test("runEvalCase: Group A in stub mode returns resolver result with referenceGolden", async () => {
  const outcome = await runEvalCase(
    {
      id: "eval-a-test",
      group: "A",
      input: {
        metaStoryId: "ms-a",
        state: "intro",
        whatChangedState: "firstSeen",
        subtitle: "New cross-outlet pickup on a developing policy-to-political shift.",
        summary: "Coverage is widening from policy reporting toward political reaction.",
        whatChanged: "First appearance in your feed.",
      },
      expected: {
        expectedPass: true,
        expectedTaxonomyPrimary: "monitoring_intensity",
        expectedConfidence: "medium",
        referenceGolden:
          "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
      },
    },
    { writerMode: "stub" }
  );
  assert.equal(outcome.type, "resolver");
  assert.equal(outcome.diagnostics.fallbackUsed, false);
  assert.equal(outcome.trace.taxonomyPrimary, "monitoring_intensity");
  assert.equal(outcome.trace.confidence, "medium");
});

test("runEvalCase: Group D forceWriterFail routes to fallback with signal_uncertainty/low", async () => {
  const outcome = await runEvalCase(
    {
      id: "eval-d03-test",
      group: "D",
      input: {
        metaStoryId: "ms-d03",
        state: "evolving",
        whatChangedState: "changed",
        subtitle: "Opinion cycle intensifies.",
        summary: "Commentary volume is increasing.",
        whatChanged: "Commentary volume increased in the last cycle.",
        forceWriterFail: true,
      },
      expected: { expectFallbackUsed: true },
    },
    { writerMode: "stub" }
  );
  assert.equal(outcome.diagnostics.fallbackUsed, true);
  assert.equal(outcome.trace.taxonomyPrimary, "signal_uncertainty");
  assert.equal(outcome.trace.confidence, "low");
});

// ─── runEvalSuite + JSON shape against synthetic datasets ────────────────────

async function withTempDataset(dataset, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "why-eval-"));
  const file = path.join(dir, "eval.json");
  await writeFile(file, JSON.stringify(dataset), "utf8");
  return fn(file);
}

test("runEvalSuite: parses a synthetic dataset and computes pass/fail metrics", async () => {
  const dataset = {
    version: "test-v0",
    cases: [
      {
        id: "eval-a-1",
        group: "A",
        input: {
          metaStoryId: "ms-1",
          state: "intro",
          whatChangedState: "firstSeen",
          subtitle: "New cross-outlet pickup on a developing policy-to-political shift.",
          summary: "Coverage is widening from policy reporting toward political reaction.",
          whatChanged: "First appearance in your feed.",
        },
        expected: {
          expectedPass: true,
          expectedTaxonomyPrimary: "monitoring_intensity",
          expectedConfidence: "medium",
          referenceGolden:
            "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
        },
      },
      {
        id: "eval-c-1",
        group: "C",
        input: {
          state: "steady",
          subtitle: "x",
          summary: "y",
          whatChanged: "z",
        },
        expected: {
          expectedPass: false,
          expectedFailDimension: "state_coherence",
          trapGolden: "Nothing to monitor here.",
        },
      },
    ],
  };
  await withTempDataset(dataset, async (datasetPath) => {
    const { scored, metrics, gate } = await runEvalSuite({
      datasetPath,
      writerMode: "stub",
    });
    assert.equal(scored.length, 2);
    assert.ok(scored.every((r) => r.pass), `expected all to pass, got ${JSON.stringify(scored)}`);
    assert.equal(metrics.overallPass, 2);
    assert.deepEqual(gate.blockers, []);
  });
});

test("runEvalSuite: surfaces Group A miss as a release blocker", async () => {
  // referenceGolden is a near-duplicate of the summary, so both the
  // initial write and the rewrite (stub returns the same text) fail
  // non_duplication and the resolver falls back to the safe template.
  // Fallback emits signal_uncertainty/low, so the expected
  // monitoring_intensity/medium mismatches and the case fails scoring.
  const dataset = {
    version: "test-fail",
    cases: [
      {
        id: "eval-a-bad",
        group: "A",
        input: {
          metaStoryId: "ms-1",
          state: "intro",
          whatChangedState: "firstSeen",
          subtitle: "Sub",
          summary: "Coverage is widening across multiple watchlist outlets this morning.",
          whatChanged: "First appearance in your feed.",
        },
        expected: {
          expectedPass: true,
          expectedTaxonomyPrimary: "monitoring_intensity",
          expectedConfidence: "medium",
          allowFallback: false,
          referenceGolden: "Coverage is widening across multiple watchlist outlets this morning.",
        },
      },
    ],
  };
  await withTempDataset(dataset, async (datasetPath) => {
    const { scored, gate } = await runEvalSuite({ datasetPath, writerMode: "stub" });
    assert.equal(scored[0].pass, false, `failReasons=${scored[0].failReasons.join("; ")}`);
    assert.ok(gate.blockers.some((b) => b.startsWith("group_A_pass_rate")));
    assert.ok(gate.blockers.some((b) => b.startsWith("overall_pass_rate")));
  });
});

test("buildJsonSummary: emits a stable shape (dataset, writerMode, metrics, gate, results[])", async () => {
  const dataset = {
    version: "test-shape",
    cases: [
      {
        id: "eval-c-shape",
        group: "C",
        input: { state: "evolving", subtitle: "x", summary: "y", whatChanged: "z" },
        expected: {
          expectedPass: false,
          expectedFailDimension: "non_prescriptive",
          trapGolden: "Issue a statement now before narrative hardens.",
        },
      },
    ],
  };
  await withTempDataset(dataset, async (datasetPath) => {
    const run = await runEvalSuite({ datasetPath, writerMode: "stub" });
    const summary = buildJsonSummary({ ...run, writerMode: "stub" });
    assert.equal(summary.dataset, "test-shape");
    assert.equal(summary.writerMode, "stub");
    assert.ok(summary.metrics);
    assert.ok(summary.gate);
    assert.ok(Array.isArray(summary.results));
    assert.deepEqual(
      Object.keys(summary.results[0]).sort(),
      ["failReasons", "fallbackUsed", "group", "hardFail", "id", "labelMismatches", "pass"].sort()
    );
    // Roundtrip through JSON to confirm shape is serializable.
    const roundtripped = JSON.parse(JSON.stringify(summary));
    assert.equal(roundtripped.results[0].id, "eval-c-shape");
  });
});

// ─── MVP gate policy: EVAL_STRICT_LABEL_MATCH toggle ────────────────────────

test("resolveStrictLabelMatch: default false; env=true and --strict-labels CLI both opt in", () => {
  assert.equal(resolveStrictLabelMatch([], {}), false);
  assert.equal(resolveStrictLabelMatch([], { EVAL_STRICT_LABEL_MATCH: "true" }), true);
  assert.equal(resolveStrictLabelMatch([], { EVAL_STRICT_LABEL_MATCH: "1" }), true);
  assert.equal(resolveStrictLabelMatch([], { EVAL_STRICT_LABEL_MATCH: "TRUE" }), true);
  assert.equal(resolveStrictLabelMatch([], { EVAL_STRICT_LABEL_MATCH: "false" }), false);
  assert.equal(resolveStrictLabelMatch([], { EVAL_STRICT_LABEL_MATCH: "yes" }), false);
  assert.equal(resolveStrictLabelMatch(["--strict-labels"], {}), true);
});

test("runEvalSuite: label mismatch alone does NOT block under MVP default; surfaces as warning", async () => {
  // We need a stub-mode case where the writer's emitted taxonomy/confidence
  // diverge from `expected.*`.  The stub writer normally mirrors the expected
  // labels back, so we use `forceWriterFail: true` to route through the
  // Phase 3d fallback, which deterministically emits
  // signal_uncertainty / low.  Setting expected to monitoring_intensity /
  // medium therefore guarantees a label mismatch on both fields.
  const dataset = {
    version: "test-mvp-policy",
    cases: [
      {
        id: "eval-mvp-policy",
        group: "B",
        input: {
          metaStoryId: "ms-mvp",
          state: "evolving",
          whatChangedState: "changed",
          subtitle: "New cross-outlet pickup on a developing policy-to-political shift.",
          summary: "Coverage is widening from policy reporting toward political reaction.",
          whatChanged: "Two outlets shifted framing in the last cycle.",
          forceWriterFail: true,
        },
        expected: {
          expectedPass: true,
          expectedTaxonomyPrimary: "monitoring_intensity",
          expectedConfidence: "medium",
          allowFallback: true,
          referenceGolden: "ignored — fallback path",
        },
      },
    ],
  };
  await withTempDataset(dataset, async (datasetPath) => {
    // MVP default: row passes despite taxonomy mismatch; no blocker.
    const lenient = await runEvalSuite({ datasetPath, writerMode: "stub" });
    assert.equal(lenient.scored[0].pass, true);
    assert.ok(lenient.scored[0].labelMismatches.some((r) => r.startsWith("taxonomy_mismatch:")));
    assert.deepEqual(lenient.gate.blockers, []);
    assert.ok(
      lenient.gate.warnings.some((w) => w.startsWith("label_mismatch_rate")),
      `expected label_mismatch warning, got warnings=${lenient.gate.warnings.join("; ")}`
    );
    assert.equal(lenient.metrics.labelMismatchCount, 1);
    assert.equal(lenient.strictLabelMatch, false);

    // Strict mode: the same mismatches now flow into failReasons and push
    // overall pass rate below 90%, which blocks.
    const strict = await runEvalSuite({
      datasetPath,
      writerMode: "stub",
      strictLabelMatch: true,
    });
    assert.equal(strict.scored[0].pass, false);
    assert.ok(strict.scored[0].failReasons.some((r) => r.startsWith("taxonomy_mismatch:")));
    assert.ok(strict.scored[0].failReasons.some((r) => r.startsWith("confidence_mismatch:")));
    assert.ok(
      strict.gate.blockers.some((b) => b.startsWith("overall_pass_rate")),
      `expected overall_pass_rate blocker under strict mode, got blockers=${strict.gate.blockers.join("; ")}`
    );
    assert.equal(strict.strictLabelMatch, true);
  });
});

// ─── Smoke: locked 18-case set still passes the gate in stub mode ───────────

test("runEvalSuite: locked 18-case dataset clears all blockers in stub mode", async () => {
  const { scored, metrics, gate } = await runEvalSuite({ writerMode: "stub" });
  assert.equal(scored.length, 18, "locked eval set must contain exactly 18 cases");
  assert.equal(metrics.byGroup.A.total, 6);
  assert.equal(metrics.byGroup.B.total, 4);
  assert.equal(metrics.byGroup.C.total, 4);
  assert.equal(metrics.byGroup.D.total, 4);
  assert.deepEqual(gate.blockers, [], `unexpected blockers: ${gate.blockers.join("; ")}`);
});
