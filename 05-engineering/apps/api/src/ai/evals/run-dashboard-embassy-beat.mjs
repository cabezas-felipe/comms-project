/**
 * Dashboard Embassy Beat — CLI runner (Sprint C3)
 *
 * Thin CLI wrapper around `runDashboardEmbassyBeat` in
 * `dashboard-embassy-beat-core.mjs`. All eval logic lives in the core module;
 * this file only handles human-readable PASS/FAIL output and the exit code.
 *
 * The eval is fully synthetic + deterministic (no network, no LLM, no env), so
 * no dotenv load is needed. Side effects (console, process.exit) fire only when
 * this file is the node entrypoint — an accidental import is a no-op.
 *
 * Standalone only: NOT wired into `eval:dashboard-quality-gate` (C3 decision).
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:dashboard-embassy-beat
 */

import { fileURLToPath } from "node:url";
import { runDashboardEmbassyBeat } from "./dashboard-embassy-beat-core.mjs";

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const HR = "─".repeat(60);
  console.log("\n[embassy-beat] Sprint C3 golden eval — mixed EN/ES, multi-geo (synthetic)");
  console.log(HR);

  const { ok, reasons, diagnostics } = await runDashboardEmbassyBeat();

  console.log(`[embassy-beat] stories=${diagnostics.storyCount} usedFallbackClustering=${diagnostics.usedFallbackClustering}`);
  console.log(
    `[embassy-beat] clustering: attempts=${diagnostics.clusteringAttempts} failureReason=${diagnostics.clusteringFailureReason} ` +
      `repairAttempted=${diagnostics.clusteringRepairAttempted} repairSucceeded=${diagnostics.clusteringRepairSucceeded}`
  );
  console.log(
    `[embassy-beat] clusterCap: deduped=${diagnostics.clusterCap?.dedupedCount} input=${diagnostics.clusterCap?.clusterInputCount} ` +
      `dropped=${diagnostics.clusterCap?.clusterDroppedCount}`
  );
  console.log(
    `[embassy-beat] translation: translated=${diagnostics.translation?.translatedCount} failed=${diagnostics.translation?.failedCount}`
  );
  for (const title of diagnostics.storyTitles) console.log(`  • story: "${title}"`);
  console.log(HR);

  if (!ok) {
    console.error(`[embassy-beat] FAIL — ${reasons.length} unmet criteri${reasons.length === 1 ? "on" : "a"}:`);
    for (const reason of reasons) console.error(`  • ${reason}`);
    console.error(`\n[embassy-beat] diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
    process.exit(1);
  }

  console.log("[embassy-beat] PASS — stories.length >= 1 AND usedFallbackClustering === false");
  console.log("");
}

// Direct-execution guard — main() fires only when this file is the node
// entrypoint, never on import (mirrors run-cluster-smoke.mjs / server.mjs).
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[embassy-beat] Fatal error:", err);
    process.exit(1);
  });
}
