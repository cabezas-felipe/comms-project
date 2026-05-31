/**
 * Cache-benefit advisory eval — core (Sprint D1)
 *
 * Standalone, deterministic, hermetic validation of the ingestion-cache benefit
 * window logic (`../../dashboard/cache-benefit-window.mjs`). No network, no LLM,
 * no env, no Supabase — it feeds synthetic refresh-run windows through the SAME
 * `computeCacheBenefit` the runtime uses and asserts the advisory verdict
 * matches the locked D1 criteria:
 *
 *   • cache-hit p50 >= 20% faster than live-scoped p50   (success threshold)
 *   • cache-hit rate in the measured window >= 60%        (extra guardrail)
 *   • >= 5 samples per mode in the comparison window       (sample floor)
 *
 * It is ADVISORY BY INTENT (hybrid: advisory now, path to blocking later). The
 * runner exits non-zero when the window logic does not produce the expected
 * verdict for any scenario, so a regression in the measurement surfaces loudly
 * without gating product behavior.
 *
 * The "headline" scenario encodes the realistic healthy production shape (cache
 * clearly faster, cache-heavy traffic) and must PASS — it is the concrete proof
 * that the D1 success criteria are computable and met on representative data.
 */

import {
  computeCacheBenefit,
  CACHE_BENEFIT_REASON,
} from "../../dashboard/cache-benefit-window.mjs";

const cache = (pipelineMs) => ({ mode: "cache_hit", pipelineMs });
const live = (pipelineMs) => ({ mode: "live_scoped", pipelineMs });

/**
 * Each scenario pins a synthetic chronological window (oldest → newest) and the
 * expected advisory outcome: `expectOk` plus the set of reason codes that must
 * be present. Reason-code matching is subset-based on the expectation, so a
 * scenario can assert "improvement fails" without enumerating co-occurring
 * guardrail failures it doesn't care about — but `expectOk` is exact.
 */
export const SCENARIOS = [
  {
    id: "headline-healthy-pass",
    intent: "Representative healthy window: cache ~2x faster, cache-heavy traffic.",
    window: [
      live(420), cache(180), live(440), cache(190), live(410),
      cache(185), live(430), cache(175), live(425), cache(182),
      cache(188), cache(179),
    ],
    expectOk: true,
    expectReasonCodes: [],
  },
  {
    id: "improvement-below-threshold",
    intent: "Cache only ~9% faster — below the 20% success threshold.",
    window: [
      cache(185), live(200), cache(180), live(205), cache(182),
      live(198), cache(181), live(202), cache(180), live(200),
    ],
    expectOk: false,
    expectReasonCodes: [CACHE_BENEFIT_REASON.IMPROVEMENT_BELOW_THRESHOLD],
  },
  {
    id: "hit-rate-below-threshold",
    intent: "Cache is fast but recent traffic is live-heavy — hit rate 50% < 60%.",
    window: [
      cache(180), live(420), live(440), cache(185), live(410),
      cache(182), live(430), live(425), cache(179), cache(188),
    ],
    expectOk: false,
    expectReasonCodes: [CACHE_BENEFIT_REASON.HIT_RATE_BELOW_THRESHOLD],
  },
  {
    id: "insufficient-sample",
    intent: "Only 3 runs per mode — below the 5-run-per-mode comparison floor.",
    window: [cache(180), live(420), cache(185), live(430), cache(182), live(425)],
    expectOk: false,
    expectReasonCodes: [CACHE_BENEFIT_REASON.INSUFFICIENT_SAMPLE],
  },
];

function subsetMatches(expected, actual) {
  const actualSet = new Set(actual);
  return expected.every((code) => actualSet.has(code));
}

/**
 * Evaluate all scenarios. Pure — no console, no process.exit. Returns
 * { ok, reasons, scenarios } where `ok` is true only when every scenario's
 * computed verdict matches its expectation.
 */
export function runCacheBenefitAdvisory() {
  const results = SCENARIOS.map((scenario) => {
    const verdict = computeCacheBenefit(scenario.window);
    const okMatches = verdict.ok === scenario.expectOk;
    const reasonsMatch = subsetMatches(scenario.expectReasonCodes, verdict.reasonCodes);
    const passed = okMatches && reasonsMatch;
    const mismatch = [];
    if (!okMatches) mismatch.push(`ok expected=${scenario.expectOk} actual=${verdict.ok}`);
    if (!reasonsMatch) {
      mismatch.push(
        `reasonCodes expected⊇[${scenario.expectReasonCodes.join(",")}] actual=[${verdict.reasonCodes.join(",")}]`
      );
    }
    return { id: scenario.id, intent: scenario.intent, passed, mismatch, verdict };
  });

  const reasons = results
    .filter((r) => !r.passed)
    .map((r) => `${r.id}: ${r.mismatch.join("; ")}`);

  return { ok: reasons.length === 0, reasons, scenarios: results };
}
