import { test } from "node:test";
import assert from "node:assert/strict";

import { RELEVANCE_PRECISION_CASES } from "./relevance-precision-fixtures.mjs";
import {
  applyBeatFitFilter,
  scoreBeatFit,
  BEAT_FIT_RESCUE_REASON,
} from "./beat-fit-scorer.mjs";
import { applyTopicKeywordFilter } from "./refresh-pipeline.mjs";

// ─── Eval harness ─────────────────────────────────────────────────────────────
//
// Deterministic, zero-network harness for the 12 locked relevance/precision
// cases (see [./relevance-precision-fixtures.mjs] and
// [docs/relevance-precision-strategy.md] cross-cutting section).
//
// Each case is asserted against its `currentBaseline` so the suite is green at
// HEAD. The gap between observed behavior and `targetExpected` is collected
// and printed once at the end so a reader can see which locked outcomes still
// depend on Points 1–7 landing.

// Run a single story through current scorer + filter and produce a normalized
// observed-outcome object the assertions/gap report compare against.
function observeSingle(story, settings, semanticIntentScore) {
  const enrichedStory =
    typeof semanticIntentScore === "number" && Number.isFinite(semanticIntentScore)
      ? { ...story, semanticIntentScore }
      : { ...story };

  const filter = applyBeatFitFilter([enrichedStory], settings);
  const includedItem = filter.included[0] ?? null;
  const excludedItem = filter.excluded[0] ?? null;

  const inDashboard = includedItem !== null;
  const excluded = excludedItem !== null;
  const rescued = Boolean(includedItem?.beatFitRescued);
  const rescueReason = rescued
    ? includedItem.beatFitReasonCodes.includes(BEAT_FIT_RESCUE_REASON)
      ? BEAT_FIT_RESCUE_REASON
      : null
    : null;

  // Reason codes survive on the included or excluded item depending on path.
  const reasonCodes = includedItem
    ? includedItem.beatFitReasonCodes ?? []
    : excludedItem
      ? excludedItem.reasonCodes ?? []
      : [];

  const offBeatPenaltyApplied = reasonCodes.some((c) => c.startsWith("geo_offbeat"));
  const score = includedItem?.beatFitScore ?? excludedItem?.score ?? null;
  const deterministicScore =
    includedItem?.beatFitDeterministicScore ?? excludedItem?.deterministicScore ?? null;

  // Lexical recall is a separate stage; expose it for the cases that test P1.
  const lexicalPasses = applyTopicKeywordFilter([enrichedStory], settings).length > 0;

  // Conservative mapping of reason codes → fixture-level rescueBlockedReason.
  // Only well-known existing rescue-block annotations are mapped; unknown codes
  // fall through to null so this harness does not invent semantics.
  //   - "rescue_blocked_geo_gate" (future P6 code) → "geo_gate"
  //   - "rescue_blocked_penalty"                   → "major_penalty"
  //   - "rescue_blocked_insufficient_signals"      → "insufficient_signals"
  // No production reason code is introduced here; the geo_gate mapping is the
  // contract Point 6 implementers must satisfy when emitting a blocked code.
  const rescueBlockedReason = deriveRescueBlockedReason(reasonCodes);

  return {
    in_dashboard: inDashboard,
    excluded,
    rescued,
    rescueReason,
    rescueBlockedReason,
    reasonCodes,
    passesLexicalRecall: lexicalPasses,
    offBeatPenaltyApplied,
    score,
    deterministicScore,
  };
}

function deriveRescueBlockedReason(reasonCodes) {
  if (!Array.isArray(reasonCodes)) return null;
  if (reasonCodes.includes("rescue_blocked_geo_gate")) return "geo_gate";
  if (reasonCodes.includes("rescue_blocked_penalty")) return "major_penalty";
  if (reasonCodes.includes("rescue_blocked_insufficient_signals")) {
    return "insufficient_signals";
  }
  return null;
}

// Run a multi-item batch (case 12) and return rollup counters.
function observeBatch(batch, settings) {
  const items = batch.map(({ story, semanticIntentScore }) =>
    typeof semanticIntentScore === "number" && Number.isFinite(semanticIntentScore)
      ? { ...story, semanticIntentScore }
      : { ...story }
  );
  const filter = applyBeatFitFilter(items, settings);
  const rescuedItems = filter.included.filter((it) => it.beatFitRescued);
  const perItem = items.map((it) => {
    const inc = filter.included.find((x) => x.sourceId === it.sourceId);
    return {
      sourceId: it.sourceId,
      rescued: Boolean(inc?.beatFitRescued),
      rescueReason: inc?.beatFitRescued
        ? (inc.beatFitReasonCodes ?? []).find((c) => c.startsWith("rescue_")) ?? null
        : null,
    };
  });
  // Cap-blocked items are by definition NOT rescued — they sit in the excluded
  // bucket carrying a `rescue_semantic_geo_cap_exceeded` annotation. Under the
  // amended uncapped policy (D-062) this count is always 0; the metric stays
  // semantically correct if legacy capped logic is ever re-exercised.
  const capBlockedCount = filter.excluded.filter(
    (ex) => (ex.reasonCodes ?? []).includes("rescue_semantic_geo_cap_exceeded")
  ).length;
  return {
    rescuedCount: rescuedItems.length,
    capBlockedCount,
    perItem,
    summary: filter.summary,
  };
}

// Compare a slice of `observed` against `expected`; returns mismatched keys.
function diffOutcome(observed, expected, keys) {
  const diffs = [];
  for (const key of keys) {
    if (!(key in expected)) continue;
    const o = observed[key];
    const e = expected[key];
    if (Array.isArray(e) || (e && typeof e === "object")) {
      if (JSON.stringify(o) !== JSON.stringify(e)) diffs.push({ key, observed: o, expected: e });
    } else if (o !== e) {
      diffs.push({ key, observed: o, expected: e });
    }
  }
  return diffs;
}

const SINGLE_OUTCOME_KEYS = [
  "in_dashboard",
  "excluded",
  "rescued",
  "rescueReason",
  "rescueBlockedReason",
  "passesLexicalRecall",
  "offBeatPenaltyApplied",
];
const BATCH_OUTCOME_KEYS = ["rescuedCount", "capBlockedCount", "perItem"];

// Collected gaps (current ≠ target). Printed at end of suite for visibility.
const GAPS = [];

// Per-case test runner. Asserts `currentBaseline` exactly; records gap to
// `targetExpected` without failing.
function runCase(testCase) {
  test(`relevance-precision eval — ${testCase.id}`, () => {
    if (testCase.isBatch) {
      const observed = observeBatch(testCase.batch, testCase.settings);
      const baselineDiffs = diffOutcome(observed, testCase.currentBaseline, BATCH_OUTCOME_KEYS);
      assert.deepEqual(
        baselineDiffs,
        [],
        `currentBaseline mismatch for ${testCase.id}: ${JSON.stringify(baselineDiffs)}`
      );
      const targetDiffs = diffOutcome(observed, testCase.targetExpected, BATCH_OUTCOME_KEYS);
      if (targetDiffs.length > 0) {
        GAPS.push({ id: testCase.id, kind: "batch", diffs: targetDiffs });
      }
      return;
    }

    const observed = observeSingle(testCase.story, testCase.settings, testCase.semanticIntentScore);

    // Structural reason-code assertions encoded on the case.
    if (testCase.targetExpected.mustIncludeReasonCodePrefix) {
      assert.ok(
        observed.reasonCodes.some((c) =>
          c.startsWith(testCase.targetExpected.mustIncludeReasonCodePrefix)
        ),
        `${testCase.id}: expected reasonCodes to include prefix ` +
          `${testCase.targetExpected.mustIncludeReasonCodePrefix}, got ${JSON.stringify(observed.reasonCodes)}`
      );
    }
    if (testCase.currentBaseline.mustNotIncludeReasonCodePrefix) {
      assert.ok(
        !observed.reasonCodes.some((c) =>
          c.startsWith(testCase.currentBaseline.mustNotIncludeReasonCodePrefix)
        ),
        `${testCase.id}: expected NO reason code with prefix ` +
          `${testCase.currentBaseline.mustNotIncludeReasonCodePrefix}, got ${JSON.stringify(observed.reasonCodes)}`
      );
    }
    if (testCase.currentBaseline.excludedBeforeRescue) {
      // "Excluded before rescue" — verify the item is excluded AND was not
      // even evaluated for the rescue band (no rescue_blocked_* annotation).
      assert.equal(observed.excluded, true);
      assert.equal(observed.rescued, false);
      assert.ok(
        !observed.reasonCodes.some((c) => c.startsWith("rescue_blocked_")),
        `${testCase.id}: expected exclusion before rescue path; got rescue_blocked code in ${JSON.stringify(observed.reasonCodes)}`
      );
    }

    const baselineDiffs = diffOutcome(observed, testCase.currentBaseline, SINGLE_OUTCOME_KEYS);
    assert.deepEqual(
      baselineDiffs,
      [],
      `currentBaseline mismatch for ${testCase.id}: ${JSON.stringify(baselineDiffs)}\n  reasonCodes=${JSON.stringify(observed.reasonCodes)}\n  det=${observed.deterministicScore} score=${observed.score}`
    );

    const targetDiffs = diffOutcome(observed, testCase.targetExpected, SINGLE_OUTCOME_KEYS);
    if (targetDiffs.length > 0) {
      GAPS.push({ id: testCase.id, kind: "single", diffs: targetDiffs });
    }

    // Symmetry sub-assertion for case 6: when topics=[X] vs keywords=[X], the
    // recall stage's pass/fail should match at target state. Today, asymmetric.
    if (testCase.targetExpected.symmetricWithKeyword !== undefined) {
      const topicLabel = (testCase.settings.topics ?? [])[0];
      if (typeof topicLabel === "string" && topicLabel.length > 0) {
        const asTopicSettings = { ...testCase.settings, topics: [topicLabel], keywords: [] };
        const asKeywordSettings = { ...testCase.settings, topics: [], keywords: [topicLabel] };
        const passesAsTopic = applyTopicKeywordFilter([testCase.story], asTopicSettings).length > 0;
        const passesAsKeyword = applyTopicKeywordFilter([testCase.story], asKeywordSettings).length > 0;
        const symmetric = passesAsTopic === passesAsKeyword;
        if (symmetric !== testCase.currentBaseline.symmetricWithKeyword) {
          throw new Error(
            `${testCase.id}: symmetricWithKeyword baseline mismatch — observed=${symmetric} ` +
              `expected=${testCase.currentBaseline.symmetricWithKeyword}`
          );
        }
        if (symmetric !== testCase.targetExpected.symmetricWithKeyword) {
          GAPS.push({
            id: testCase.id,
            kind: "symmetry",
            diffs: [{ key: "symmetricWithKeyword", observed: symmetric, expected: testCase.targetExpected.symmetricWithKeyword }],
          });
        }
      }
    }
  });
}

// ─── Suite header sanity ─────────────────────────────────────────────────────

test("relevance-precision eval — 12 locked cases registered (case 7 has 7a + 7b → 13 entries)", () => {
  assert.equal(RELEVANCE_PRECISION_CASES.length, 13);
});

test("relevance-precision eval — scoreBeatFit and applyBeatFitFilter exports are intact", () => {
  assert.equal(typeof scoreBeatFit, "function");
  assert.equal(typeof applyBeatFitFilter, "function");
});

// ─── Per-case runs ───────────────────────────────────────────────────────────

for (const testCase of RELEVANCE_PRECISION_CASES) {
  runCase(testCase);
}

// ─── Gap report ──────────────────────────────────────────────────────────────
//
// Emitted on test completion so a reader can quickly see which locked
// expectations are still pending implementation. Non-blocking by design.

test("relevance-precision eval — pending gap report (informational, not a failure)", () => {
  // Force this test to run after the per-case tests by giving it a name late
  // in source order. (node --test runs files top-to-bottom.)
  const lines = [];
  lines.push("");
  lines.push("=== relevance-precision-eval :: gap report (target − current) ===");
  if (GAPS.length === 0) {
    lines.push("  No gaps. All 13 fixture outcomes match target.");
  } else {
    for (const gap of GAPS) {
      lines.push(`  [${gap.kind}] ${gap.id}`);
      for (const d of gap.diffs) {
        lines.push(
          `    - ${d.key}: observed=${JSON.stringify(d.observed)} expected=${JSON.stringify(d.expected)}`
        );
      }
    }
    lines.push("");
    lines.push("  These gaps are expected pre-implementation of P1–P7. See");
    lines.push("  docs/relevance-precision-strategy.md cross-cutting section.");
  }
  lines.push("=== end gap report ===");
  console.log(lines.join("\n"));
  // Always passes — this is a report, not a gate.
  assert.ok(true);
});
