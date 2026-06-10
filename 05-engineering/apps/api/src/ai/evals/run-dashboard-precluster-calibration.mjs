/**
 * Pre-cluster Weight Calibration — CLI runner  ·  Decision 10D
 *
 * Thin wrapper around `runPreclusterCalibration` in
 * `dashboard-precluster-calibration-core.mjs`. Sweeps candidate pre-cluster
 * WEIGHT PRESETS against a fixed synthetic fixture, prints a readable table of
 * decision-quality metrics per preset, and writes a deterministic JSON artifact
 * so future weight changes can be evidence-backed.
 *
 * Exit code: non-zero ONLY on a genuine guardrail failure — the `baseline`
 * preset (= production weights) violating a hard invariant, or the baseline
 * ranking diverging from the production scorer (`baselineFaithful === false`). A
 * non-baseline preset failing an invariant is expected signal (it is simply not
 * "recommended") and never fails the run.
 *
 * This harness changes NO runtime defaults — production keeps using
 * `RELEVANCE_WEIGHTS`; presets are injected per run for comparison only.
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:dashboard-precluster-calibration
 *   ... --json-out <path>    # override the artifact location
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPreclusterCalibrationArtifact,
  runPreclusterCalibration,
} from "./dashboard-precluster-calibration-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const API_ROOT = path.resolve(path.dirname(__filename), "..", "..", "..");

export const DEFAULT_PRECLUSTER_ARTIFACT = path.join(
  API_ROOT,
  ".artifacts",
  "dashboard-precluster-calibration.json"
);

// Parse `--json-out <path>` (and `--json-out=<path>`). Returns the default path
// when absent.
export function parsePreclusterJsonOut(argv, fallback = DEFAULT_PRECLUSTER_ARTIFACT) {
  const eq = argv.find((a) => a.startsWith("--json-out="));
  if (eq) return eq.slice("--json-out=".length);
  const i = argv.indexOf("--json-out");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return fallback;
}

/**
 * Write the artifact to disk, creating parent dirs. Returns the resolved path.
 * Caller supplies the ISO timestamp so the core stays Date-free/deterministic.
 */
export function writePreclusterCalibrationArtifact(result, outPath, timestamp) {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const artifact = buildPreclusterCalibrationArtifact(result, { timestamp });
  writeFileSync(resolved, JSON.stringify(artifact, null, 2) + "\n");
  return resolved;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(results) {
  const cols = [
    ["preset", 17],
    ["elSurv", 7],
    ["elInCap", 8],
    ["geoInCap", 9],
    ["geoLeak", 8],
    ["cfg>cross", 10],
    ["tieOK", 6],
    ["prodEq", 7],
    ["verdict", 16],
  ];
  console.log(cols.map(([h, w]) => pad(h, w)).join(" "));
  console.log(cols.map(([, w]) => "─".repeat(w)).join(" "));
  for (const r of results) {
    const m = r.metrics;
    const leak = m.geoNoiseLeakedAboveConfiguredElection + m.geoNoiseLeakedAboveCrossCountry;
    const verdict = r.preset === "baseline"
      ? (r.passesInvariants ? "BASELINE ✓" : "BASELINE ✗")
      : (r.recommended ? "ok" : "not-recommended");
    const cells = [
      [r.preset, 17],
      [m.electionSurvivesCap ? "yes" : "NO", 7],
      [m.electionItemsInCap, 8],
      [m.geoNoiseInCap, 9],
      [leak, 8],
      [m.configuredGeoBeatsCrossCountry ? "yes" : "NO", 10],
      [m.tieStable ? "yes" : "NO", 6],
      [m.matchesProductionOrder ? "yes" : "no", 7],
      [verdict, 16],
    ];
    console.log(cells.map(([c, w]) => pad(c, w)).join(" "));
  }
}

async function main() {
  const jsonOut = parsePreclusterJsonOut(process.argv);
  const HR = "─".repeat(96);

  console.log("\n[precluster-calibration] sweeping pre-cluster WEIGHT PRESETS (Decision 10D)");
  console.log("[precluster-calibration] baseline = production RELEVANCE_WEIGHTS; variants are comparison-only");
  console.log(HR);

  const result = await runPreclusterCalibration();
  printTable(result.results);
  console.log(HR);

  console.log(
    `[precluster-calibration] production order: [${result.productionRankedSourceIds.join(", ")}]`
  );
  console.log(
    `[precluster-calibration] baselineFaithful (baseline ranking == production): ${result.baselineFaithful ? "YES" : "NO"}`
  );

  const recommended = result.results.filter((r) => r.recommended).map((r) => r.preset);
  console.log(`[precluster-calibration] presets holding all hard invariants: [${recommended.join(", ")}]`);

  const timestamp = new Date().toISOString();
  const artifactPath = writePreclusterCalibrationArtifact(result, jsonOut, timestamp);
  console.log(`[precluster-calibration] JSON artifact → ${artifactPath}`);
  console.log(HR);

  if (result.hardFail) {
    const baseline = result.results.find((r) => r.preset === "baseline");
    const why = !result.baselineFaithful
      ? "baseline ranking diverged from the production scorer (replica drift)"
      : `baseline preset violated a hard invariant: ${JSON.stringify(baseline?.invariants)}`;
    console.error(`[precluster-calibration] HARD FAIL — ${why}`);
    process.exit(1);
  }
  console.log("[precluster-calibration] OK — baseline faithful + holds all hard invariants. Variant metrics are advisory.\n");
}

// Direct-execution guard — main() fires only when this file is the entrypoint.
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[precluster-calibration] Fatal error:", err);
    process.exit(1);
  });
}
