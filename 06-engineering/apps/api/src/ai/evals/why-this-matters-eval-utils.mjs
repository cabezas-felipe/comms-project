// Why-this-matters eval helpers (pure / sync).
// Spec: docs/why-this-matters-spec.md §10 (release gates) + §12.4 (rubric-only).
//
// Three responsibilities:
//   1. Translate a locked eval-case definition into the inputs the engine
//      expects (resolver input + validation context).
//   2. Score the outcome of one case (resolver result or validator output for
//      Group C trap-golden cases) into a structured `{pass, hardFail,
//      fallbackUsed, failReasons[], dimensionScores}` row.
//   3. Aggregate per-case rows into run-level metrics and evaluate them
//      against the locked Phase 10 release gates (blockers + warnings).
//
// All functions here are deterministic and free of I/O so the runner and the
// unit tests can share them.

import { validateWhyItMatters } from "../../dashboard/why-this-matters-engine.mjs";

// Required keys on every emitted trace (strategy §3c).  The runner uses this
// to score the `trace_complete` meta dimension from spec §10.
export const REQUIRED_TRACE_FIELDS = Object.freeze([
  "metaStoryId",
  "state",
  "whatChangedState",
  "taxonomyPrimary",
  "confidence",
  "evidenceRefs",
  "doctrineRefs",
  "fallback_used",
  "writerVersion",
  "promptVersion",
  "generatedAt",
]);

// Phase 10 release gate thresholds (locked).
export const GATE_THRESHOLDS = Object.freeze({
  groupAPassRate: 1.0,
  overallPassRate: 0.9,
  hardFailRate: 0.02,
  fallbackRate: 0.1,
  duplicationFailureRate: 0.05,
});

/**
 * True iff `trace` contains every required Phase 3c field.  We check
 * presence only — the engine guarantees the values are well-formed, and
 * eval scoring shouldn't double-verify the engine's invariants here.
 */
export function isTraceComplete(trace) {
  if (!trace || typeof trace !== "object") return false;
  for (const key of REQUIRED_TRACE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(trace, key)) return false;
  }
  return true;
}

/**
 * Build the validation context (subtitle / summary / whatChanged / state /
 * evidenceRefs / whatChangedState) the validator needs from a locked eval
 * case.  Pure — no defaults beyond "" for missing strings.
 */
export function buildValidationContextForCase(caseDef) {
  const input = caseDef?.input ?? {};
  return {
    state: typeof input.state === "string" ? input.state : "steady",
    whatChangedState: input.whatChangedState ?? null,
    subtitle: typeof input.subtitle === "string" ? input.subtitle : "",
    summary: typeof input.summary === "string" ? input.summary : "",
    whatChanged: typeof input.whatChanged === "string" ? input.whatChanged : "",
    evidenceRefs: input.evidenceRefs ?? {},
  };
}

/**
 * Build the input object the resolver expects from a locked eval case.
 * `doctrineAvailable: false` (eval-D01) becomes `doctrineSnippets: []`;
 * everything else gets a single placeholder snippet so `doctrineRefs[]`
 * surfaces on the trace.  The runner injects a stub writer that observes
 * this input via `mode === "initial"`.
 */
export function buildResolverInputForCase(caseDef) {
  const input = caseDef?.input ?? {};
  const doctrineAvailable = input.doctrineAvailable !== false;
  return {
    metaStoryId: typeof input.metaStoryId === "string" ? input.metaStoryId : caseDef?.id ?? "eval-case",
    subtitle: typeof input.subtitle === "string" ? input.subtitle : "",
    summary: typeof input.summary === "string" ? input.summary : "",
    whatChanged: typeof input.whatChanged === "string" ? input.whatChanged : "",
    whatChangedState: input.whatChangedState ?? null,
    state: typeof input.state === "string" ? input.state : undefined,
    evidenceRefs: input.evidenceRefs ?? {},
    doctrineSnippets: doctrineAvailable
      ? [{ id: "doctrine.stub", body: "Stub doctrine framing for eval runs." }]
      : [],
    forceWriterFail: input.forceWriterFail === true,
  };
}

/**
 * Score a single eval case.  Three paths:
 *   - Group C (trap-golden): the runner already called `validateWhyItMatters`
 *     on the trap text; we just check the expected fail dimension landed in
 *     `failReasons[]`.
 *   - Resolver result with `fallbackUsed=false`: re-validate the writer
 *     output to surface dimension scores and assert the rubric passed.
 *   - Resolver result with `fallbackUsed=true`: skip rubric re-validation
 *     (fallback copy is locked deterministic text); just check the trace
 *     taxonomy / confidence / fallback expectation.
 *
 * Always returns the same row shape regardless of path so the aggregator
 * doesn't have to branch.
 *
 * MVP gate policy (spec §10): `strictLabelMatch` defaults to `false` so that
 * `taxonomy_mismatch` / `confidence_mismatch` are recorded on the row's
 * `labelMismatches[]` field but do NOT push the row into `pass=false`.  Set
 * to `true` (or via env `EVAL_STRICT_LABEL_MATCH=true` at the runner) to
 * restore the original strict behavior where label mismatches block.
 *
 * @param {object} caseDef
 * @param {object} outcome
 * @param {{ strictLabelMatch?: boolean }} [options]
 */
export function scoreEvalCase(caseDef, outcome, { strictLabelMatch = false } = {}) {
  const id = caseDef?.id ?? "unknown";
  const group = caseDef?.group ?? "?";
  const expected = caseDef?.expected ?? {};
  const failReasons = [];
  const labelMismatches = [];

  if (outcome?.type === "validator") {
    const v = outcome.validation ?? {};
    // Defensive guards: a malformed validator outcome (e.g. failReasons
    // missing or non-array) must not crash scoring.  Spec §10 mandates
    // fail-closed posture for the eval pipeline.
    const vFailReasons = Array.isArray(v.failReasons) ? v.failReasons : [];
    if (v.pass === true) {
      failReasons.push("trap_passed_validator_unexpectedly");
    }
    if (
      typeof expected.expectedFailDimension === "string" &&
      !vFailReasons.includes(expected.expectedFailDimension)
    ) {
      failReasons.push(`expected_fail_dimension_missing:${expected.expectedFailDimension}`);
    }
    const casePass = failReasons.length === 0;
    // Group C trap-golden cases EXPECT the validator to hard-reject the
    // trap.  When the case passes scoring (i.e. the validator rejected as
    // expected), the validator-level `hardFail=true` is the desired
    // outcome — it does not represent a shipping hard-fail.  We surface
    // the raw validator hard-fail under `details.validatorHardFail` for
    // debugging but suppress it on the row's `hardFail` field so the
    // run-level hard-fail rate reflects "shipping hard-fails only"
    // (spec §10 strategy §5b).
    const validatorHardFail = v.hardFail === true;
    return {
      id,
      group,
      pass: casePass,
      hardFail: casePass ? false : validatorHardFail,
      fallbackUsed: false,
      failReasons,
      labelMismatches,
      dimensionScores: v.dimensionScores ?? {},
      traceComplete: null,
      details: {
        path: "validator",
        validatorPass: v.pass === true,
        validatorHardFail,
        validatorFailReasons: vFailReasons,
      },
    };
  }

  // Resolver path
  const trace = outcome?.trace ?? null;
  const diagnostics = outcome?.diagnostics ?? {};
  const fallbackUsed = diagnostics.fallbackUsed === true;

  if (expected.expectFallbackUsed === true && !fallbackUsed) {
    failReasons.push("expected_fallback_used_but_writer_passed");
  }
  if (expected.allowFallback === false && fallbackUsed) {
    failReasons.push("fallback_used_when_disallowed");
  }
  // MVP gate policy (spec §10): taxonomy / confidence label mismatches are
  // monitored on `labelMismatches[]` but non-blocking unless `strictLabelMatch`
  // is true.  Prose quality / safety (rubric, fallback discipline, trace
  // completeness) remains the gate-relevant signal for MVP pilot.
  if (
    typeof expected.expectedTaxonomyPrimary === "string" &&
    trace?.taxonomyPrimary !== expected.expectedTaxonomyPrimary
  ) {
    const reason = `taxonomy_mismatch:expected=${expected.expectedTaxonomyPrimary} actual=${trace?.taxonomyPrimary}`;
    if (strictLabelMatch) failReasons.push(reason);
    else labelMismatches.push(reason);
  }
  if (
    typeof expected.expectedConfidence === "string" &&
    trace?.confidence !== expected.expectedConfidence
  ) {
    const reason = `confidence_mismatch:expected=${expected.expectedConfidence} actual=${trace?.confidence}`;
    if (strictLabelMatch) failReasons.push(reason);
    else labelMismatches.push(reason);
  }

  const traceComplete = isTraceComplete(trace);
  if (!traceComplete) failReasons.push("trace_incomplete");

  let dimensionScores = {};
  let validatorPass = null;
  let validatorHardFail = false;
  let validatorFailReasons = [];
  if (!fallbackUsed && outcome?.whyItMatters) {
    const v = validateWhyItMatters(
      {
        text: outcome.whyItMatters,
        taxonomyPrimary: trace?.taxonomyPrimary,
        confidence: trace?.confidence,
      },
      buildValidationContextForCase(caseDef)
    );
    dimensionScores = v.dimensionScores ?? {};
    validatorPass = v.pass;
    validatorHardFail = v.hardFail === true;
    validatorFailReasons = v.failReasons ?? [];
    if (!v.pass) failReasons.push(`rubric_fail:${(v.failReasons ?? []).join(",")}`);
  }

  return {
    id,
    group,
    pass: failReasons.length === 0,
    hardFail: validatorHardFail,
    fallbackUsed,
    failReasons,
    labelMismatches,
    dimensionScores,
    traceComplete,
    details: {
      path: "resolver",
      taxonomyPrimary: trace?.taxonomyPrimary ?? null,
      confidence: trace?.confidence ?? null,
      whyItMatters: outcome?.whyItMatters ?? null,
      validatorPass,
      validatorFailReasons,
    },
  };
}

/**
 * Aggregate per-case rows into run-level metrics: overall pass rate, hard
 * fail rate, fallback rate, duplication-failure rate, label-mismatch rate
 * (taxonomy / confidence; monitor-only under MVP policy, see spec §10), plus
 * per-group (A/B/C/D) pass counts.  All rates are pre-computed so the runner
 * and the gate don't have to recompute.
 */
export function aggregateEvalMetrics(scored) {
  const rows = Array.isArray(scored) ? scored : [];
  const total = rows.length;
  let passCount = 0;
  let hardFailCount = 0;
  let fallbackCount = 0;
  let duplicationFailCount = 0;
  let labelMismatchCount = 0;
  const byGroup = {};

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.pass) passCount += 1;
    if (row.hardFail) hardFailCount += 1;
    if (row.fallbackUsed) fallbackCount += 1;
    const failReasonsArr = Array.isArray(row.failReasons) ? row.failReasons : [];
    const labelMismatchesArr = Array.isArray(row.labelMismatches) ? row.labelMismatches : [];
    if (failReasonsArr.some((r) => typeof r === "string" && r.includes("non_duplication"))) {
      duplicationFailCount += 1;
    }
    // Count label mismatches whether they appear in failReasons (strict mode)
    // or labelMismatches (MVP default).  This keeps the rate comparable
    // across both modes for the operator-facing warning.
    const hasLabelMismatchInFails = failReasonsArr.some(
      (r) => typeof r === "string" && (r.startsWith("taxonomy_mismatch") || r.startsWith("confidence_mismatch"))
    );
    if (hasLabelMismatchInFails || labelMismatchesArr.length > 0) {
      labelMismatchCount += 1;
    }
    const g = typeof row.group === "string" ? row.group : "?";
    if (!byGroup[g]) byGroup[g] = { total: 0, pass: 0, hardFail: 0, fallback: 0 };
    byGroup[g].total += 1;
    if (row.pass) byGroup[g].pass += 1;
    if (row.hardFail) byGroup[g].hardFail += 1;
    if (row.fallbackUsed) byGroup[g].fallback += 1;
  }
  for (const g of Object.keys(byGroup)) {
    byGroup[g].passRate = byGroup[g].total > 0 ? byGroup[g].pass / byGroup[g].total : 0;
  }

  return {
    total,
    overallPass: passCount,
    overallPassRate: total > 0 ? passCount / total : 0,
    hardFailCount,
    hardFailRate: total > 0 ? hardFailCount / total : 0,
    fallbackCount,
    fallbackRate: total > 0 ? fallbackCount / total : 0,
    duplicationFailureCount: duplicationFailCount,
    duplicationFailureRate: total > 0 ? duplicationFailCount / total : 0,
    labelMismatchCount,
    labelMismatchRate: total > 0 ? labelMismatchCount / total : 0,
    byGroup,
  };
}

/**
 * Evaluate Phase 10 release gates against an aggregated metrics object.
 * Returns `{ blockers: string[], warnings: string[] }`.  A non-empty
 * `blockers` array should cause the runner to exit non-zero.
 */
export function evaluateEvalGate(metrics, thresholds = GATE_THRESHOLDS) {
  const blockers = [];
  const warnings = [];
  if (!metrics || typeof metrics !== "object") {
    blockers.push("metrics_missing");
    return { blockers, warnings };
  }
  const groupA = metrics.byGroup?.A;
  if (groupA && groupA.total > 0 && groupA.passRate < thresholds.groupAPassRate) {
    blockers.push(
      `group_A_pass_rate ${(groupA.passRate * 100).toFixed(1)}% < ${(thresholds.groupAPassRate * 100).toFixed(0)}%`
    );
  }
  if (metrics.overallPassRate < thresholds.overallPassRate) {
    blockers.push(
      `overall_pass_rate ${(metrics.overallPassRate * 100).toFixed(1)}% < ${(thresholds.overallPassRate * 100).toFixed(0)}%`
    );
  }
  if (metrics.hardFailRate > thresholds.hardFailRate) {
    blockers.push(
      `hard_fail_rate ${(metrics.hardFailRate * 100).toFixed(1)}% > ${(thresholds.hardFailRate * 100).toFixed(0)}%`
    );
  }
  if (metrics.fallbackRate > thresholds.fallbackRate) {
    warnings.push(
      `fallback_rate ${(metrics.fallbackRate * 100).toFixed(1)}% > ${(thresholds.fallbackRate * 100).toFixed(0)}%`
    );
  }
  if (metrics.duplicationFailureRate > thresholds.duplicationFailureRate) {
    warnings.push(
      `duplication_failure_rate ${(metrics.duplicationFailureRate * 100).toFixed(1)}% > ${(thresholds.duplicationFailureRate * 100).toFixed(0)}%`
    );
  }
  // MVP gate policy (spec §10): taxonomy/confidence label mismatches are
  // monitored but non-blocking.  Surface as a warning so operators see the
  // signal without the gate flipping red.  Under EVAL_STRICT_LABEL_MATCH=true
  // the mismatches will also count in `overallPassRate` and may block there.
  if (typeof metrics.labelMismatchCount === "number" && metrics.labelMismatchCount > 0) {
    warnings.push(
      `label_mismatch_rate ${(metrics.labelMismatchRate * 100).toFixed(1)}% (${metrics.labelMismatchCount}/${metrics.total} cases; taxonomy/confidence labels — non-blocking under MVP policy)`
    );
  }
  return { blockers, warnings };
}
