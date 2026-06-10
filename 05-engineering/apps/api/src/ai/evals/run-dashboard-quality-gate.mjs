/**
 * Dashboard Quality Gate — CLI runner (Slice 6)
 *
 * Single CI-grade gate that runs the dashboard quality harnesses in order and
 * fails the build if any regresses:
 *   1. dashboard-refresh-golden        (E2E regression guard, Slice 2)
 *   2. dashboard-spanish-recall        (translation-first recall guard, Slice 14)
 *   3. dashboard-elections-colombia    (Q6B relevance-strategy acceptance test)
 *   4. dashboard-calibration           (embed-floor guardrail sweep, Slice 5)
 *   5. dashboard-precluster-calibration (pre-cluster weight guardrail, Decision 10D)
 *
 * All cores are imported and run in-process (hermetic — no provider keys,
 * no network). The two calibration runs are also persisted as machine-readable
 * JSON artifacts so CI and reviewers can diff runs over time.
 *
 * Exit code:
 *   0  — golden AND spanish-recall AND elections-colombia passed AND embed-floor
 *        calibration guardrails held at every floor AND the pre-cluster weight
 *        baseline is faithful + holds every hard invariant
 *   1  — any harness failed (or a runner error)
 *
 * Changes NO runtime defaults — this only observes/asserts. The calibration
 * floor metrics are advisory; only the hard guardrails gate.
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:dashboard-quality-gate
 *   ... --json-out <path>   # override the calibration artifact location
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDashboardRefreshGolden } from "./dashboard-refresh-golden-core.mjs";
import { runDashboardSpanishRecall } from "./dashboard-spanish-recall-core.mjs";
import { runDashboardElectionsColombia } from "./dashboard-elections-colombia-core.mjs";
import { runDashboardCalibration } from "./dashboard-calibration-core.mjs";
import { writeCalibrationArtifact } from "./run-dashboard-calibration.mjs";
import { runPreclusterCalibration } from "./dashboard-precluster-calibration-core.mjs";
import {
  writePreclusterCalibrationArtifact,
  DEFAULT_PRECLUSTER_ARTIFACT,
} from "./run-dashboard-precluster-calibration.mjs";

const __filename = fileURLToPath(import.meta.url);

const DEFAULT_ARTIFACT_PATH = path.join(".artifacts", "dashboard-calibration.json");

function parseJsonOut(argv) {
  const eq = argv.find((a) => a.startsWith("--json-out="));
  if (eq) return eq.slice("--json-out=".length);
  const i = argv.indexOf("--json-out");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return DEFAULT_ARTIFACT_PATH;
}

async function main() {
  const jsonOut = parseJsonOut(process.argv);
  const HR = "─".repeat(72);
  console.log(
    "\n[quality-gate] Dashboard quality gate — golden + spanish-recall + elections-colombia + calibration + precluster-weights"
  );
  console.log(HR);

  // ── 1. Golden eval ──────────────────────────────────────────────────────
  console.log("[quality-gate] (1/5) running dashboard-refresh-golden …");
  const golden = await runDashboardRefreshGolden();
  const goldenPass = !golden.summary.hardFail;
  for (const r of golden.results) {
    console.log(`    ${r.ok ? "✓" : "✗"} ${r.id}`);
    if (!r.ok) for (const reason of r.reasons) console.error(`        • ${reason}`);
  }
  console.log(
    `[quality-gate] golden: ${goldenPass ? "PASS" : "FAIL"} (${golden.summary.passed}/${golden.summary.total} scenarios)`
  );
  console.log(HR);

  // ── 2. Spanish recall eval (Slice 14) ───────────────────────────────────
  console.log("[quality-gate] (2/5) running dashboard-spanish-recall …");
  const spanish = await runDashboardSpanishRecall();
  const spanishPass = !spanish.summary.hardFail;
  for (const r of spanish.results) {
    console.log(`    ${r.ok ? "✓" : "✗"} ${r.id}`);
    if (!r.ok) for (const reason of r.reasons) console.error(`        • ${reason}`);
  }
  console.log(
    `[quality-gate] spanish-recall: ${spanishPass ? "PASS" : "FAIL"} (${spanish.summary.passed}/${spanish.summary.total} scenarios)`
  );
  console.log(HR);

  // ── 3. Elections-Colombia eval (Q6B acceptance test) ────────────────────
  console.log("[quality-gate] (3/5) running dashboard-elections-colombia …");
  const elections = await runDashboardElectionsColombia();
  const electionsPass = !elections.summary.hardFail;
  for (const r of elections.results) {
    console.log(`    ${r.ok ? "✓" : "✗"} ${r.id}`);
    if (!r.ok) for (const reason of r.reasons) console.error(`        • ${reason}`);
  }
  console.log(
    `[quality-gate] elections-colombia: ${electionsPass ? "PASS" : "FAIL"} (${elections.summary.passed}/${elections.summary.total} checks)`
  );
  console.log(HR);

  // ── 4. Calibration eval ─────────────────────────────────────────────────
  console.log("[quality-gate] (4/5) running dashboard-calibration …");
  const calibration = await runDashboardCalibration();
  const calibrationPass = !calibration.hardFail;
  for (const row of calibration.rows) {
    const floor = row.floor === 0 ? "0.00(off)" : row.floor.toFixed(2);
    console.log(
      `    ${row.failures.length === 0 ? "✓" : "✗"} floor=${floor} stories=${row.finalStories} semReject=${row.similarityRejected} reuters=${row.reutersCount} lbCollapse=${row.liveblogCollapsed}`
    );
    if (row.failures.length > 0) for (const f of row.failures) console.error(`        • ${f}`);
  }
  const artifactPath = writeCalibrationArtifact(calibration, jsonOut, new Date().toISOString());
  console.log(`[quality-gate] calibration: ${calibrationPass ? "PASS" : "FAIL"}`);
  console.log(`[quality-gate] calibration JSON artifact → ${artifactPath}`);
  console.log(HR);

  // ── 5. Pre-cluster weight calibration (Decision 10D) ────────────────────
  // Hermetic, microsecond-fast: scores a fixed fixture under candidate weight
  // presets. Gates ONLY on the baseline (= production weights) — it must stay
  // faithful to the production scorer and hold every hard invariant; degenerate
  // variants failing are advisory signal, not a gate failure.
  console.log("[quality-gate] (5/5) running dashboard-precluster-calibration …");
  const precluster = await runPreclusterCalibration();
  const preclusterPass = !precluster.hardFail;
  for (const r of precluster.results) {
    const tag =
      r.preset === "baseline"
        ? r.passesInvariants ? "✓ baseline" : "✗ baseline"
        : r.recommended ? "  ✓" : "  ·";
    console.log(`    ${tag} ${r.preset} (recommended=${r.recommended})`);
  }
  const preclusterArtifactPath = writePreclusterCalibrationArtifact(
    precluster,
    DEFAULT_PRECLUSTER_ARTIFACT,
    new Date().toISOString()
  );
  console.log(
    `[quality-gate] precluster-calibration: ${preclusterPass ? "PASS" : "FAIL"} (baselineFaithful=${precluster.baselineFaithful})`
  );
  console.log(`[quality-gate] precluster JSON artifact → ${preclusterArtifactPath}`);
  console.log(HR);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("[quality-gate] SUMMARY");
  console.log(`    golden ................... ${goldenPass ? "PASS" : "FAIL"}`);
  console.log(`    spanish-recall ........... ${spanishPass ? "PASS" : "FAIL"}`);
  console.log(`    elections-colombia ....... ${electionsPass ? "PASS" : "FAIL"}`);
  console.log(`    calibration .............. ${calibrationPass ? "PASS" : "FAIL"}`);
  console.log(`    precluster-calibration ... ${preclusterPass ? "PASS" : "FAIL"}`);
  console.log(`    artifact ................. ${artifactPath}`);
  console.log(`    precluster artifact ...... ${preclusterArtifactPath}`);
  console.log(HR);

  if (!goldenPass || !spanishPass || !electionsPass || !calibrationPass || !preclusterPass) {
    console.error("[quality-gate] FAIL — dashboard quality gate did not pass. See failures above.");
    process.exit(1);
  }
  console.log("[quality-gate] OK — dashboard quality gate passed.\n");
}

// Direct-execution guard — main() fires only when this file is the entrypoint.
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[quality-gate] Fatal error:", err);
    process.exit(1);
  });
}
