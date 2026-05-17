// D-063: scenarios in this critical eval (e.g. critical-02 mig-noise leakage)
// assert the legacy 0.40 precision-first contract — an off-topic item with
// only a geo match (score ~0.30) must NOT leak. The MVP default lowered to
// 0.20, which by design admits such borderline items. Pin the legacy
// threshold here so the framework tests keep validating their contract;
// node --test isolates env mutations to this file's child process.
process.env.TEMPO_BEAT_FIT_THRESHOLD = "0.40";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CRITICAL_SCENARIO_IDS,
  runCriticalSuite,
  aggregateVerdict,
} from "./critical-suite-core.mjs";
import { buildDeterministicChecks } from "./critical-suite-judge.mjs";

// ── CRITICAL_SCENARIO_IDS / registry shape ──────────────────────────────────

test("CRITICAL_SCENARIO_IDS lists exactly the 8 locked scenario IDs in order", () => {
  assert.deepEqual(Array.from(CRITICAL_SCENARIO_IDS), [
    "critical-01-china-defense-trade",
    "critical-02-monitoring-migration-border",
    "critical-03-source-scoped-relevance",
    "critical-04-empty-profile-lexical-path",
    "critical-05-embedding-failure-with-lexical-hits",
    "critical-06-embedding-failure-without-lexical-hits",
    "critical-07-settings-save-refresh-propagation",
    "critical-08-grounding-trust-guard",
  ]);
});

// ── runCriticalSuite — happy path (real scenarios) ──────────────────────────

test("runCriticalSuite: all 8 real scenarios pass against the live pipeline (hermetic)", async () => {
  // This is the headline assertion: every scenario must pass when run with
  // its bundled fixtures. A regression in the recall/pipeline path that
  // breaks any scenario lights this up immediately.
  const { results, summary } = await runCriticalSuite();
  assert.equal(summary.total, 8);
  assert.equal(summary.passed, 8, `failed: ${JSON.stringify(results.filter((r) => !r.ok))}`);
  assert.equal(summary.failed, 0);
  assert.equal(summary.hardFail, false);
});

test("runCriticalSuite: each result carries id, intent, ok, reasons, diagnostics", async () => {
  const { results } = await runCriticalSuite();
  for (const r of results) {
    assert.ok(typeof r.id === "string" && r.id.length > 0, `${r.id} missing id`);
    assert.ok(typeof r.intent === "string" && r.intent.length > 0, `${r.id} missing intent`);
    assert.equal(typeof r.ok, "boolean", `${r.id} ok not boolean`);
    assert.ok(Array.isArray(r.reasons), `${r.id} reasons not array`);
    assert.ok(r.diagnostics && typeof r.diagnostics === "object", `${r.id} diagnostics missing`);
  }
});

// ── runCriticalSuite — override stubs (one scenario fails, suite hard-fails)

test("runCriticalSuite: a single overridden failure flips summary.hardFail to true", async () => {
  const overrides = new Map([
    [
      "critical-01-china-defense-trade",
      async () => ({
        ok: false,
        reasons: ["fixture override: forced failure"],
        diagnostics: { stub: true },
      }),
    ],
  ]);
  const { results, summary } = await runCriticalSuite({ overrides });
  assert.equal(summary.total, 8);
  assert.equal(summary.failed, 1);
  assert.equal(summary.hardFail, true);
  const failed = results.find((r) => !r.ok);
  assert.equal(failed.id, "critical-01-china-defense-trade");
  assert.deepEqual(failed.reasons, ["fixture override: forced failure"]);
});

test("runCriticalSuite: thrown scenario is caught and converted to a structured failure", async () => {
  const overrides = new Map([
    [
      "critical-08-grounding-trust-guard",
      async () => {
        throw new Error("simulated runtime error inside scenario");
      },
    ],
  ]);
  const { results, summary } = await runCriticalSuite({ overrides });
  assert.equal(summary.hardFail, true);
  const failed = results.find((r) => r.id === "critical-08-grounding-trust-guard");
  assert.equal(failed.ok, false);
  assert.match(failed.reasons[0], /scenario threw/);
  assert.match(failed.reasons[0], /simulated runtime error/);
});

test("runCriticalSuite: passing override produces ok=true without disturbing other scenarios", async () => {
  // Overrides are scoped — a passing stub for one scenario must NOT mask a
  // real failure elsewhere. Verified by passing a passing stub AND a failing
  // stub and asserting the suite reports failure on the failing one only.
  const overrides = new Map([
    [
      "critical-01-china-defense-trade",
      async () => ({ ok: true, reasons: [], diagnostics: {} }),
    ],
    [
      "critical-02-monitoring-migration-border",
      async () => ({ ok: false, reasons: ["forced for test"], diagnostics: {} }),
    ],
  ]);
  const { results, summary } = await runCriticalSuite({ overrides });
  assert.equal(summary.failed, 1);
  assert.equal(results.find((r) => r.id === "critical-01-china-defense-trade").ok, true);
  assert.equal(results.find((r) => r.id === "critical-02-monitoring-migration-border").ok, false);
});

// ── aggregateVerdict — warning policy ───────────────────────────────────────

test("aggregateVerdict: all critical scenarios pass → release=true, no causal note", () => {
  const verdict = aggregateVerdict({
    criticalResults: [
      { id: "critical-01-china-defense-trade", ok: true, reasons: [] },
      { id: "critical-02-monitoring-migration-border", ok: true, reasons: [] },
    ],
    driftFindings: [{ id: "x:drift-1", level: "warn", message: "advisory" }],
    judgeFindings: [{ id: "judge:x", level: "info", message: "advisory" }],
  });
  assert.equal(verdict.release, true);
  assert.equal(verdict.hardFail, false);
  assert.deepEqual(verdict.failedCriticalIds, []);
  // Advisory findings still bubble up in the warnings array.
  assert.equal(verdict.warnings.length, 2);
  // No causal note when nothing failed.
  assert.deepEqual(verdict.causalNotes, []);
});

test("aggregateVerdict: any critical failure → release=false regardless of advisory findings", () => {
  // Locked policy: advisory layers NEVER gate the release. The only thing
  // that fails the suite is a critical scenario failure.
  const verdict = aggregateVerdict({
    criticalResults: [
      { id: "critical-01-china-defense-trade", ok: false, reasons: ["any reason"] },
      { id: "critical-02-monitoring-migration-border", ok: true, reasons: [] },
    ],
    driftFindings: [],
    judgeFindings: [],
  });
  assert.equal(verdict.release, false);
  assert.equal(verdict.hardFail, true);
  assert.deepEqual(verdict.failedCriticalIds, ["critical-01-china-defense-trade"]);
});

test("aggregateVerdict: advisory findings WITHOUT critical failure → release=true (warnings only)", () => {
  // Drift / judge findings alone must never gate. This pins the
  // "non-critical drift is warning-level" Phase 5b decision.
  const verdict = aggregateVerdict({
    criticalResults: [
      { id: "critical-01-china-defense-trade", ok: true, reasons: [] },
    ],
    driftFindings: [
      { id: "x:funnel-drift", level: "warn", message: "afterTopicKeyword diverges" },
    ],
    judgeFindings: [
      { id: "judge:x", level: "warn", message: "judge avg=1.5", score: 1.5 },
    ],
  });
  assert.equal(verdict.release, true);
  assert.equal(verdict.hardFail, false);
  assert.equal(verdict.warnings.length, 2);
  assert.deepEqual(verdict.causalNotes, []);
});

test("aggregateVerdict: critical failure + advisory findings → emits causal correlation note", () => {
  const verdict = aggregateVerdict({
    criticalResults: [
      { id: "critical-04-empty-profile-lexical-path", ok: false, reasons: ["strict-empty"] },
    ],
    driftFindings: [
      { id: "x:funnel-divergence", level: "warn", message: "post-recall mismatch" },
    ],
    judgeFindings: [],
  });
  assert.equal(verdict.hardFail, true);
  assert.equal(verdict.causalNotes.length, 1);
  assert.match(verdict.causalNotes[0], /1 critical scenario\(s\) failed/);
  assert.match(verdict.causalNotes[0], /investigate whether the drift signals correlate/);
});

test("aggregateVerdict: warnings carry their source label (drift vs judge)", () => {
  const verdict = aggregateVerdict({
    criticalResults: [{ id: "x", ok: true, reasons: [] }],
    driftFindings: [{ id: "d", level: "warn", message: "d-msg" }],
    judgeFindings: [{ id: "j", level: "info", message: "j-msg", score: 2.5 }],
  });
  const sources = verdict.warnings.map((w) => w.source);
  assert.deepEqual(sources, ["drift", "judge"]);
});

// ── buildDeterministicChecks — advisory pre-checks ──────────────────────────

test("buildDeterministicChecks: passes silently on a healthy result", () => {
  const findings = buildDeterministicChecks([
    {
      id: "critical-01-china-defense-trade",
      ok: true,
      diagnostics: {
        stories: [
          {
            metaStoryId: "ms-1",
            sources: [{ id: "src-1", outlet: "Reuters" }],
          },
        ],
        recall: {
          mode: "hybrid_strict",
          degraded: false,
          degraded_reason: null,
          finalRelevant: 1,
        },
        funnel: { afterTopicKeyword: 1 },
      },
    },
  ]);
  assert.deepEqual(findings, []);
});

test("buildDeterministicChecks: flags missing recall fields as advisory warn", () => {
  const findings = buildDeterministicChecks([
    {
      id: "critical-05-embedding-failure-with-lexical-hits",
      ok: true,
      diagnostics: {
        // Missing degraded_reason + finalRelevant — Phase 3 contract drift.
        recall: { mode: "hybrid_strict", degraded: true },
      },
    },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warn");
  assert.match(findings[0].id, /:recall-shape$/);
  assert.match(findings[0].message, /degraded_reason/);
  assert.match(findings[0].message, /finalRelevant/);
});

test("buildDeterministicChecks: flags funnel ↔ recall divergence", () => {
  const findings = buildDeterministicChecks([
    {
      id: "critical-07-settings-save-refresh-propagation",
      ok: true,
      diagnostics: {
        recall: {
          mode: "hybrid_strict",
          degraded: false,
          degraded_reason: null,
          finalRelevant: 5,
        },
        funnel: { afterTopicKeyword: 3 }, // diverges
      },
    },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warn");
  assert.match(findings[0].id, /:funnel-recall-divergence$/);
  assert.match(findings[0].message, /3/);
  assert.match(findings[0].message, /5/);
});

test("buildDeterministicChecks: flags source without stable id (no-fabrication contract)", () => {
  const findings = buildDeterministicChecks([
    {
      id: "critical-02-monitoring-migration-border",
      ok: true,
      diagnostics: {
        stories: [
          {
            metaStoryId: "ms-x",
            // One source carries a falsy id — a future regression in the
            // payload shape would surface here without changing behavior.
            sources: [{ id: "good" }, { id: "" }],
          },
        ],
      },
    },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warn");
  assert.match(findings[0].id, /:source-id-missing$/);
});
