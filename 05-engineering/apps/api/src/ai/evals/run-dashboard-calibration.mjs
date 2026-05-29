/**
 * Embed-floor Calibration — CLI runner (Slice 5)
 *
 * Thin wrapper around `runDashboardCalibration` in
 * `dashboard-calibration-core.mjs`. Sweeps the recall cosine floor across
 * 0 / 0.35 / 0.40 / 0.45 and prints a readable table of objective diagnostics.
 *
 * Exit code: non-zero ONLY when a hard guardrail fails (fail-closed clustering,
 * degraded title, no Reuters, or liveblog dedupe regression) at any floor. The
 * floor-by-floor metrics themselves never fail the run — they are the signal
 * you read to decide whether 0.40 is still the right default.
 *
 * This harness changes NO runtime defaults. `DEFAULT_EMBED_MIN_SIMILARITY`
 * stays 0.40 in code; this only injects floors per run for comparison.
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:dashboard-calibration
 *   ... --verbose            # also prints per-floor guardrail detail
 *   ... --json-out <path>    # also write a machine-readable JSON artifact
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CALIBRATION_FLOORS,
  buildCalibrationArtifact,
  runDashboardCalibration,
} from "./dashboard-calibration-core.mjs";

const __filename = fileURLToPath(import.meta.url);

// Parse `--json-out <path>` (and `--json-out=<path>`). Returns null when absent.
function parseJsonOut(argv) {
  const eq = argv.find((a) => a.startsWith("--json-out="));
  if (eq) return eq.slice("--json-out=".length);
  const i = argv.indexOf("--json-out");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return null;
}

// Write the artifact to disk, creating parent dirs. Returns the resolved path.
export function writeCalibrationArtifact(result, outPath, timestamp) {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const artifact = buildCalibrationArtifact(result, { timestamp });
  writeFileSync(resolved, JSON.stringify(artifact, null, 2) + "\n");
  return resolved;
}

function fmtFloor(f) {
  return f === 0 ? "0.00 (off)" : f.toFixed(2);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(rows) {
  const cols = [
    ["floor", 11],
    ["stories", 8],
    ["fallback", 9],
    ["kwRecall", 9],
    ["finalRel", 9],
    ["semReject", 10],
    ["floorSeen", 10],
    ["reuters", 8],
    ["lbCollapse", 11],
    ["guard", 6],
  ];
  console.log(cols.map(([h, w]) => pad(h, w)).join(" "));
  console.log(cols.map(([, w]) => "─".repeat(w)).join(" "));
  for (const r of rows) {
    const cells = [
      [fmtFloor(r.floor), 11],
      [r.finalStories, 8],
      [r.usedFallbackClustering ? "YES" : "no", 9],
      [r.keywordRecallCount ?? "n/a", 9],
      [r.finalRelevant ?? "n/a", 9],
      [r.similarityRejected ?? "n/a", 10],
      [r.minSimilarityThreshold ?? "n/a", 10],
      [r.reutersCount, 8],
      [r.liveblogCollapsed ?? "n/a", 11],
      [r.failures.length === 0 ? "PASS" : "FAIL", 6],
    ];
    console.log(cells.map(([c, w]) => pad(c, w)).join(" "));
  }
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const jsonOut = parseJsonOut(process.argv);
  const HR = "─".repeat(96);

  console.log("\n[dashboard-calibration] sweeping TEMPO_EMBED_MIN_SIMILARITY (semantic-only recall floor)");
  console.log(`[dashboard-calibration] floors=[${DEFAULT_CALIBRATION_FLOORS.map(fmtFloor).join(", ")}]  (production default = 0.40)`);
  console.log(HR);

  const result = await runDashboardCalibration();
  const { rows, hardFail } = result;
  printTable(rows);
  console.log(HR);

  if (jsonOut) {
    const resolved = writeCalibrationArtifact(result, jsonOut, new Date().toISOString());
    console.log(`[dashboard-calibration] JSON artifact written → ${resolved}`);
    console.log(HR);
  }

  // Soft-metric narration: how the floor moves the candidate pool.
  console.log("soft metrics (informational — never fail the run):");
  for (const r of rows) {
    console.log(
      `  floor ${fmtFloor(r.floor)} → finalStories=${r.finalStories}  similarityRejected=${r.similarityRejected}  finalRelevant=${r.finalRelevant}`
    );
  }
  console.log(
    "  Read: as the floor rises, similarityRejected rises and finalStories falls — the floor is trimming\n" +
    "  weak semantic-only adds. Pair this with manual quality review (?debug=1) before changing the default."
  );

  if (verbose || hardFail) {
    console.log(HR);
    for (const r of rows) {
      if (r.failures.length === 0) {
        if (verbose) console.log(`floor ${fmtFloor(r.floor)}: guardrails PASS`);
      } else {
        console.error(`floor ${fmtFloor(r.floor)}: guardrails FAIL`);
        for (const f of r.failures) console.error(`  • ${f}`);
      }
    }
  }

  console.log(HR);
  if (hardFail) {
    console.error("[dashboard-calibration] HARD FAIL — a guardrail regressed at one or more floors (see above).");
    process.exit(1);
  }
  console.log("[dashboard-calibration] OK — all guardrails held at every floor. Metrics above are advisory.\n");
}

// Direct-execution guard — main() fires only when this file is the entrypoint.
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[dashboard-calibration] Fatal error:", err);
    process.exit(1);
  });
}
