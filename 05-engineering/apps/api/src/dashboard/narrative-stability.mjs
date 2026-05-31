/**
 * D2 — post-cluster narrative stability (fail-closed per story)
 *
 * Pure helpers that implement the locked D2 failure policy for the two
 * post-clustering narrative stages (what-changed and why-it-matters):
 *
 *   1. Failure policy: fail-closed PER STORY — a stage that cannot produce
 *      content for a story drops only that story; it never fails the global
 *      refresh.
 *   3. Retry policy: one retry per failing stage, then drop the story if it
 *      still fails.
 *
 * This module owns only the *detection* and *retry orchestration*; the pipeline
 * (`refresh-pipeline.mjs`) owns the actual drop (filtering the story out of the
 * published set) and the additive `log.narrativeStability` diagnostics.
 *
 * Failure detection is deliberately NARROW — it fires only on transient
 * EXECUTION failures of the writer (a thrown/timed-out LLM call), not on the
 * stages' existing graceful degradations:
 *   • what-changed → a classify failure or a hallucination guard still routes to
 *     the "unchanged" copy and is NOT a drop; only a failed write call is.
 *   • why-it-matters → config fallbacks (`disabled`/`mock_only`/`force_writer_fail`)
 *     and content-validation fallbacks (`write_validation_failed`) are NOT drops;
 *     only transport-level failures (`write_failed`/`rewrite_failed`/
 *     `resolver_threw`) are.
 *
 * Keeping the trigger narrow means healthy/default-off/validation paths behave
 * exactly as before — only genuinely unrecoverable per-story failures drop.
 *
 * NOTE: this module changes NO timeout values and adds NO user-facing messaging
 * (drops are silent, per locked decision #2).
 */

/**
 * why-it-matters fallback reasons that represent a genuine transient execution
 * failure of the writer (vs. a config or content-quality fallback).
 */
export const WHY_TRANSIENT_FAILURE_REASONS = Object.freeze(
  new Set(["write_failed", "rewrite_failed", "resolver_threw"])
);

/**
 * True when a what-changed result represents an unrecoverable per-story failure
 * (the Sonnet write call threw / timed out). A missing/non-object result is
 * treated as a failure (defensive — the engine normally never throws).
 */
export function isWhatChangedFailure(result) {
  if (!result || typeof result !== "object") return true;
  return result.diagnostics?.llmFailed?.write === true;
}

/**
 * True when a why-it-matters result represents an unrecoverable per-story
 * failure (a transient writer/resolver execution failure). Config-driven and
 * content-validation fallbacks are explicitly NOT failures.
 */
export function isWhyItMattersFailure(result) {
  if (!result || typeof result !== "object") return true;
  const d = result.diagnostics;
  if (!d || d.fallbackUsed !== true) return false;
  return WHY_TRANSIENT_FAILURE_REASONS.has(d.fallbackReason);
}

/**
 * Run an async stage producer with AT MOST ONE retry (locked decision #3).
 *
 * @param {(attempt: number) => Promise<any>} produce - 1-indexed attempt producer.
 * @param {(result: any) => boolean} isFailure - classifies a result as a failure.
 * @param {(error: unknown, attempt: number) => any} [onThrow] - normalizes a
 *   thrown producer into a usable (aggregate-friendly) result object; the
 *   normalized value is still treated as a failure for retry/drop purposes.
 * @returns {Promise<{result: any, attempts: number, retried: boolean, failed: boolean}>}
 */
export async function runStageWithSingleRetry(produce, isFailure, onThrow) {
  const attemptOnce = async (attempt) => {
    try {
      const result = await produce(attempt);
      return { result, failed: isFailure(result) };
    } catch (err) {
      const result = typeof onThrow === "function" ? onThrow(err, attempt) : null;
      return { result, failed: true };
    }
  };

  let { result, failed } = await attemptOnce(1);
  let attempts = 1;
  let retried = false;
  if (failed) {
    retried = true;
    attempts = 2;
    ({ result, failed } = await attemptOnce(2));
  }
  return { result, attempts, retried, failed };
}

/**
 * Build the additive `log.narrativeStability` diagnostics object from the two
 * stages' per-stage tallies. Pure — no side effects.
 *
 * @param {number} eligible - pre-D2 eligible (post-cluster) story count.
 * @param {Set<string>} droppedStoryIds - union of stories dropped by either stage.
 * @param {{eligible:number, retried:number, dropped:number, droppedIds:string[]}} whatChanged
 * @param {{eligible:number, retried:number, dropped:number, droppedIds:string[]}} whyItMatters
 */
export function buildNarrativeStabilityDiagnostics({
  eligible,
  droppedStoryIds,
  whatChanged,
  whyItMatters,
}) {
  const dropped = droppedStoryIds.size;
  const survived = Math.max(0, eligible - dropped);
  return {
    schemaVersion: "narrative-stability-v1",
    policy: "fail_closed_per_story",
    retryPerStage: 1,
    eligible,
    survived,
    dropped,
    droppedStoryIds: [...droppedStoryIds],
    retentionRate: eligible > 0 ? survived / eligible : 1,
    whatChanged,
    whyItMatters,
  };
}
