/**
 * Cache-benefit advisory eval — CLI runner (Sprint D1)
 *
 * Thin CLI wrapper around `runCacheBenefitAdvisory` in
 * `cache-benefit-advisory-core.mjs`. All logic lives in the core module; this
 * file only prints a human-readable per-scenario report and sets the exit code.
 *
 * Fully synthetic + deterministic (no network, no LLM, no env), so no dotenv
 * load is needed. Side effects (console, process.exit) fire only when this file
 * is the node entrypoint — an accidental import is a no-op.
 *
 * Advisory by intent: standalone, NOT wired into any blocking quality gate.
 * Exits non-zero only when the window logic regresses (a scenario's computed
 * verdict diverges from its locked expectation).
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:cache-benefit-advisory
 */

import { fileURLToPath } from "node:url";
import { runCacheBenefitAdvisory } from "./cache-benefit-advisory-core.mjs";

const __filename = fileURLToPath(import.meta.url);

function fmtPct(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function main() {
  const HR = "─".repeat(68);
  console.log("\n[cache-benefit] Sprint D1 ingestion-cache benefit advisory (synthetic, deterministic)");
  console.log("[cache-benefit] criteria: improvement>=20% AND hitRate>=60% AND >=5 samples/mode");
  console.log(HR);

  const { ok, reasons, scenarios } = runCacheBenefitAdvisory();

  for (const s of scenarios) {
    const v = s.verdict;
    const mark = s.passed ? "✓" : "✗";
    console.log(`${mark} ${s.id} — ${s.intent}`);
    console.log(
      `    verdict: ok=${v.ok} improvement=${fmtPct(v.improvementPct)} hitRate=${fmtPct(v.hitRate)} ` +
        `cacheP50=${v.cacheP50 ?? "n/a"} liveP50=${v.liveP50 ?? "n/a"} ` +
        `samples={cache:${v.sampleCounts.cacheHit},live:${v.sampleCounts.liveScoped}}`
    );
    if (v.reasons.length > 0) {
      for (const reason of v.reasons) console.log(`    reason: ${reason}`);
    }
    if (!s.passed) {
      for (const m of s.mismatch) console.log(`    MISMATCH: ${m}`);
    }
  }
  console.log(HR);

  if (!ok) {
    console.error(
      `[cache-benefit] FAIL — ${reasons.length} scenario${reasons.length === 1 ? "" : "s"} diverged from expected verdict:`
    );
    for (const reason of reasons) console.error(`  • ${reason}`);
    process.exit(1);
  }

  console.log(`[cache-benefit] PASS — all ${scenarios.length} scenarios produced the expected advisory verdict`);
  console.log("");
}

// Direct-execution guard — main() fires only when this file is the node
// entrypoint, never on import (mirrors run-dashboard-embassy-beat.mjs).
if (process.argv[1] === __filename) {
  main();
}
