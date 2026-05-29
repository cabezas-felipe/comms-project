/**
 * Dashboard Quality Gate — CLI runner (Slice 6)
 *
 * Single CI-grade gate that runs the two dashboard quality harnesses in order
 * and fails the build if either regresses:
 *   1. dashboard-refresh-golden  (E2E regression guard, Slice 2)
 *   2. dashboard-calibration     (embed-floor guardrail sweep, Slice 5)
 *
 * Both cores are imported and run in-process (hermetic — no provider keys, no
 * network). The calibration run is also persisted as a machine-readable JSON
 * artifact so CI and reviewers can diff runs over time.
 *
 * Exit code:
 *   0  — golden passed AND calibration guardrails held at every floor
 *   1  — either harness failed (or a runner error)
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
import { runDashboardCalibration } from "./dashboard-calibration-core.mjs";
import { writeCalibrationArtifact } from "./run-dashboard-calibration.mjs";

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
  console.log("\n[quality-gate] Dashboard quality gate — golden + calibration");
  console.log(HR);

  // ── 1. Golden eval ──────────────────────────────────────────────────────
  console.log("[quality-gate] (1/2) running dashboard-refresh-golden …");
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

  // ── 2. Calibration eval ─────────────────────────────────────────────────
  console.log("[quality-gate] (2/2) running dashboard-calibration …");
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

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("[quality-gate] SUMMARY");
  console.log(`    golden ........ ${goldenPass ? "PASS" : "FAIL"}`);
  console.log(`    calibration ... ${calibrationPass ? "PASS" : "FAIL"}`);
  console.log(`    artifact ...... ${artifactPath}`);
  console.log(HR);

  if (!goldenPass || !calibrationPass) {
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
