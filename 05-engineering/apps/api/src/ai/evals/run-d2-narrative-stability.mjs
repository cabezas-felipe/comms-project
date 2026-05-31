/**
 * D2 narrative-stability advisory eval — CLI runner (Sprint D2)
 *
 * Thin CLI wrapper around `runD2NarrativeStability` in
 * `d2-narrative-stability-core.mjs`. All logic lives in the core module; this
 * file only prints a per-scenario PASS/FAIL report and sets the exit code.
 *
 * Fully synthetic + deterministic (no network, no LLM, no env). Side effects
 * (console, process.exit) fire only when this file is the node entrypoint.
 *
 * Advisory by intent (locked decision #7): standalone, NOT wired into any
 * blocking quality gate. Exits non-zero only when the D2 stability logic
 * regresses (observed per-story drop / single-retry / retention behavior
 * diverges from the locked expectation).
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:d2-narrative-stability
 */

import { fileURLToPath } from "node:url";
import { runD2NarrativeStability } from "./d2-narrative-stability-core.mjs";

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const HR = "─".repeat(72);
  console.log("\n[d2-stability] Sprint D2 — fail-closed-per-story narrative stability (synthetic)");
  console.log("[d2-stability] policy: one retry per failing stage, then drop story; >=50% retention guardrail");
  console.log(HR);

  const { ok, reasons, scenarios } = await runD2NarrativeStability();

  for (const s of scenarios) {
    const mark = s.passed ? "✓" : "✗";
    console.log(`${mark} ${s.id} — ${s.intent ?? ""}`);
    const o = s.observed ?? {};
    if (o.eligible !== undefined) {
      console.log(
        `    eligible=${o.eligible} survived=${o.survived} dropped=${o.dropped} ` +
          `retention=${(o.retentionRate * 100).toFixed(1)}% guardrail=${o.guardrailPass ? "PASS" : "FAIL"}`
      );
      console.log(
        `    whatChanged{retried=${o.whatChanged.retried},dropped=${o.whatChanged.dropped}} ` +
          `why{retried=${o.whyItMatters.retried},dropped=${o.whyItMatters.dropped}} ` +
          `survivors=[${o.survivorIds.join(",")}]`
      );
    }
    if (!s.passed) {
      for (const r of s.reasons) console.log(`    MISMATCH: ${r}`);
    }
  }
  console.log(HR);

  if (!ok) {
    console.error(
      `[d2-stability] FAIL — ${reasons.length} scenario${reasons.length === 1 ? "" : "s"} diverged from expected D2 behavior:`
    );
    for (const reason of reasons) console.error(`  • ${reason}`);
    process.exit(1);
  }

  console.log(`[d2-stability] PASS — all ${scenarios.length} scenarios match the locked fail-closed-per-story behavior`);
  console.log("");
}

if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[d2-stability] Fatal error:", err);
    process.exit(1);
  });
}
