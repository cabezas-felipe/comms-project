import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WHY_TRANSIENT_FAILURE_REASONS,
  isWhatChangedFailure,
  isWhyItMattersFailure,
  runStageWithSingleRetry,
  buildNarrativeStabilityDiagnostics,
} from "./narrative-stability.mjs";

// ─── isWhatChangedFailure ────────────────────────────────────────────────────
test("isWhatChangedFailure fires only on a failed write call", () => {
  // Healthy write
  assert.equal(
    isWhatChangedFailure({ diagnostics: { llmFailed: { classify: false, write: false, hallucination: false } } }),
    false
  );
  // Classify failed → graceful unchanged copy, NOT a drop
  assert.equal(
    isWhatChangedFailure({ diagnostics: { llmFailed: { classify: true, write: false, hallucination: false } } }),
    false
  );
  // Hallucination guard → graceful unchanged copy, NOT a drop
  assert.equal(
    isWhatChangedFailure({ diagnostics: { llmFailed: { classify: false, write: false, hallucination: true } } }),
    false
  );
  // Write failed → drop
  assert.equal(
    isWhatChangedFailure({ diagnostics: { llmFailed: { classify: false, write: true, hallucination: false } } }),
    true
  );
  // Missing/garbage → defensive failure
  assert.equal(isWhatChangedFailure(null), true);
  assert.equal(isWhatChangedFailure(undefined), true);
  assert.equal(isWhatChangedFailure({}), false); // no llmFailed → treated as non-failure (graceful)
});

// ─── isWhyItMattersFailure ───────────────────────────────────────────────────
test("isWhyItMattersFailure fires only on transient execution fallbacks", () => {
  const ok = { diagnostics: { fallbackUsed: false } };
  assert.equal(isWhyItMattersFailure(ok), false);

  for (const reason of ["disabled", "mock_only", "force_writer_fail", "rewrite_validation_failed"]) {
    assert.equal(
      isWhyItMattersFailure({ diagnostics: { fallbackUsed: true, fallbackReason: reason } }),
      false,
      `${reason} must NOT be a drop`
    );
  }
  for (const reason of ["write_failed", "rewrite_failed", "resolver_threw"]) {
    assert.equal(
      isWhyItMattersFailure({ diagnostics: { fallbackUsed: true, fallbackReason: reason } }),
      true,
      `${reason} must be a drop`
    );
  }
  assert.equal(isWhyItMattersFailure(null), true);
});

test("WHY_TRANSIENT_FAILURE_REASONS contains exactly the three transient reasons", () => {
  assert.deepEqual([...WHY_TRANSIENT_FAILURE_REASONS].sort(), ["resolver_threw", "rewrite_failed", "write_failed"]);
});

// ─── runStageWithSingleRetry ─────────────────────────────────────────────────
test("runStageWithSingleRetry: success on first attempt → no retry", async () => {
  let calls = 0;
  const out = await runStageWithSingleRetry(
    async () => { calls += 1; return { ok: true }; },
    (r) => !r.ok
  );
  assert.equal(calls, 1);
  assert.equal(out.attempts, 1);
  assert.equal(out.retried, false);
  assert.equal(out.failed, false);
});

test("runStageWithSingleRetry: transient failure then success on retry", async () => {
  let calls = 0;
  const out = await runStageWithSingleRetry(
    async (attempt) => { calls += 1; return { ok: attempt === 2 }; },
    (r) => !r.ok
  );
  assert.equal(calls, 2);
  assert.equal(out.attempts, 2);
  assert.equal(out.retried, true);
  assert.equal(out.failed, false);
});

test("runStageWithSingleRetry: persistent failure → exactly one retry then failed", async () => {
  let calls = 0;
  const out = await runStageWithSingleRetry(
    async () => { calls += 1; return { ok: false }; },
    (r) => !r.ok
  );
  assert.equal(calls, 2, "exactly one retry — never more");
  assert.equal(out.attempts, 2);
  assert.equal(out.retried, true);
  assert.equal(out.failed, true);
});

test("runStageWithSingleRetry: thrown producer is normalized via onThrow and retried once", async () => {
  let calls = 0;
  const out = await runStageWithSingleRetry(
    async () => { calls += 1; throw new Error("boom"); },
    () => false, // would-be non-failure, but a throw is always a failure
    (err, attempt) => ({ synthesized: true, attempt, message: err.message })
  );
  assert.equal(calls, 2);
  assert.equal(out.failed, true);
  assert.equal(out.result.synthesized, true);
  assert.equal(out.result.attempt, 2);
});

// ─── buildNarrativeStabilityDiagnostics ──────────────────────────────────────
test("buildNarrativeStabilityDiagnostics computes retention from the drop set", () => {
  const diag = buildNarrativeStabilityDiagnostics({
    eligible: 4,
    droppedStoryIds: new Set(["a", "b"]),
    whatChanged: { eligible: 4, retried: 1, dropped: 1, droppedIds: ["a"] },
    whyItMatters: { eligible: 3, retried: 1, dropped: 1, droppedIds: ["b"] },
  });
  assert.equal(diag.schemaVersion, "narrative-stability-v1");
  assert.equal(diag.policy, "fail_closed_per_story");
  assert.equal(diag.retryPerStage, 1);
  assert.equal(diag.eligible, 4);
  assert.equal(diag.survived, 2);
  assert.equal(diag.dropped, 2);
  assert.deepEqual(diag.droppedStoryIds.sort(), ["a", "b"]);
  assert.equal(diag.retentionRate, 0.5);
});

test("buildNarrativeStabilityDiagnostics retention is 1 when nothing eligible", () => {
  const diag = buildNarrativeStabilityDiagnostics({
    eligible: 0,
    droppedStoryIds: new Set(),
    whatChanged: { eligible: 0, retried: 0, dropped: 0, droppedIds: [] },
    whyItMatters: { eligible: 0, retried: 0, dropped: 0, droppedIds: [] },
  });
  assert.equal(diag.retentionRate, 1);
  assert.equal(diag.survived, 0);
});
