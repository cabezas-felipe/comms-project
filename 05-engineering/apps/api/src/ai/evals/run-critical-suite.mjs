/**
 * Critical Hard-Fail Suite — CLI runner
 *
 * Thin wrapper around `critical-suite-core.mjs`:
 *   - load apps/api/.env so optional API-key paths work
 *   - run the 8 critical scenarios (deterministic, hermetic)
 *   - run the hybrid advisory layers (deterministic pre-checks + optional LLM judge)
 *   - print a structured report
 *   - exit 0 if no critical scenario failed; exit 1 otherwise
 *
 * The LLM judge is OPT-IN — set `TEMPO_CRITICAL_SUITE_JUDGE=1` (and provide
 * `TEMPO_ANTHROPIC_API_KEY`) to enable. By default the runner is offline,
 * deterministic, and CI-safe.
 *
 * Usage:
 *   cd 05-engineering/apps/api && npm run eval:critical
 *   TEMPO_CRITICAL_SUITE_JUDGE=1 npm run eval:critical    # advisory judge on
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import {
  runCriticalSuite,
  aggregateVerdict,
} from "./critical-suite-core.mjs";
import {
  buildDeterministicChecks,
  judgeEnabledFromEnv,
  runSemanticJudge,
} from "./critical-suite-judge.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fmtRow(r) {
  const marker = r.ok ? "✓" : "✗";
  const head = `  ${marker} ${r.id.padEnd(50)} ${r.ok ? "PASS" : "FAIL"}`;
  if (r.ok) return head;
  const detail = r.reasons.map((reason) => `      • ${reason}`).join("\n");
  return `${head}\n${detail}`;
}

function fmtFinding(f) {
  const lvl = f.level === "warn" ? "WARN" : "info";
  const scoreSuffix = typeof f.score === "number" ? ` (score=${f.score.toFixed(2)})` : "";
  return `  [${lvl}] ${f.source ?? ""} ${f.id} — ${f.message}${scoreSuffix}`;
}

async function main() {
  dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

  const HR = "═".repeat(64);
  const hr = "─".repeat(64);

  console.log(`\n${HR}`);
  console.log(" Critical Hard-Fail Suite — release gate");
  console.log(HR);

  const t0 = Date.now();
  const { results, summary } = await runCriticalSuite();
  const elapsed = Date.now() - t0;

  console.log("\n Scenarios:");
  for (const r of results) console.log(fmtRow(r));
  console.log(`\n  ${summary.passed}/${summary.total} scenarios passed in ${elapsed}ms`);

  // Deterministic advisory pre-checks — always run, never gate.
  const driftFindings = buildDeterministicChecks(results);

  // Optional LLM judge — opt-in only.
  const judgeOn = judgeEnabledFromEnv();
  const apiKey = process.env.TEMPO_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  let judgeFindings = [];
  if (judgeOn) {
    if (!apiKey) {
      judgeFindings = [
        {
          id: "judge:disabled",
          level: "warn",
          message:
            "TEMPO_CRITICAL_SUITE_JUDGE=1 set but no Anthropic key available — skipping judge.",
        },
      ];
    } else {
      judgeFindings = await runSemanticJudge({
        scenarios: results,
        apiKey,
      });
    }
  } else {
    judgeFindings = [
      {
        id: "judge:disabled",
        level: "info",
        message:
          "Semantic judge OFF (default). Set TEMPO_CRITICAL_SUITE_JUDGE=1 to enable advisory scoring.",
      },
    ];
  }

  const verdict = aggregateVerdict({
    criticalResults: results,
    driftFindings,
    judgeFindings,
  });

  console.log(`\n${hr}`);
  console.log(" Hybrid eval summary (advisory only — never gates release)");
  console.log(hr);
  if (driftFindings.length === 0) {
    console.log("  Deterministic pre-checks: no advisory findings");
  } else {
    console.log(`  Deterministic pre-checks (${driftFindings.length}):`);
    for (const f of driftFindings) console.log(fmtFinding({ source: "drift", ...f }));
  }
  if (judgeFindings.length === 0) {
    console.log("  LLM judge: no advisory findings");
  } else {
    console.log(`\n  LLM judge (${judgeFindings.length}):`);
    for (const f of judgeFindings) console.log(fmtFinding({ source: "judge", ...f }));
  }

  console.log(`\n${hr}`);
  console.log(" Warnings");
  console.log(hr);
  if (verdict.warnings.length === 0) {
    console.log("  (none)");
  } else {
    for (const w of verdict.warnings) console.log(fmtFinding(w));
  }
  if (verdict.causalNotes.length > 0) {
    console.log("\n  Causal correlation note(s):");
    for (const note of verdict.causalNotes) console.log(`    • ${note}`);
  }

  console.log(`\n${HR}`);
  if (verdict.hardFail) {
    console.log(` Release gate: FAIL — critical scenario(s) failed: ${verdict.failedCriticalIds.join(", ")}`);
  } else {
    console.log(" Release gate: PASS — no critical scenario failed");
  }
  console.log(`${HR}\n`);

  process.exit(verdict.hardFail ? 1 : 0);
}

// Direct-execution guard — mirrors the cluster-smoke pattern so an accidental
// import (from a test, for example) is a no-op.
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[critical-suite] Fatal error:", err);
    process.exit(1);
  });
}
