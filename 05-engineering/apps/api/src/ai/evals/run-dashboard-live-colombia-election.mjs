/**
 * Dashboard Live Colombia-Election Smoke — CLI runner (Phase 3 · Step 3.1)
 *
 * ADVISORY by default, NON-HERMETIC. Runs {@link runDashboardLiveColombiaElectionCore}
 * against the live feed pool and prints a concise sectioned report (status,
 * checks, key stats, warnings). The relevance pipeline past the fetch is
 * deterministic and provider-free, so this never spends model tokens.
 *
 * Exit semantics:
 *   - default (advisory): exit 0 even when checks fail — failures print clearly
 *     so a human / scheduled job notices, but a thin or election-free live
 *     window never reads as a CI regression. Exit 1 ONLY on a true execution
 *     error (the core threw — bad config / pipeline crash).
 *   - `--strict`: exit 1 when ANY non-neutral check fails (opt-in gating, e.g.
 *     an on-demand confidence run when election coverage is known to be live).
 *
 * CLI:
 *   --json-out <path>   write the full structured result JSON (parents created)
 *   --strict            non-zero exit on any failed check
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:dashboard-live-colombia-election
 *   ... --strict
 *   npm run eval:dashboard-live-colombia-election:json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { runDashboardLiveColombiaElectionCore } from "./dashboard-live-colombia-election-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_ROOT = path.resolve(__dirname, "..", "..", "..");

// Load apps/api/.env by absolute path so live-fetch config is available
// regardless of CWD. dotenv.config() is a no-op when the file is absent.
dotenv.config({ path: path.resolve(API_ROOT, ".env") });

export const DEFAULT_LIVE_ELECTION_ARTIFACT = path.join(
  API_ROOT,
  ".artifacts",
  "dashboard-live-colombia-election.json"
);

const HR = "─".repeat(72);

/** Parse `--json-out <path>` / `--json-out=<path>`. Returns null when absent. */
export function parseJsonOut(argv) {
  const eq = argv.find((a) => a.startsWith("--json-out="));
  if (eq) return eq.slice("--json-out=".length);
  const i = argv.indexOf("--json-out");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return null;
}

export function parseStrict(argv) {
  return argv.includes("--strict");
}

/**
 * Decide the process exit code from a result + mode. Pure so the runner test can
 * assert advisory/strict semantics without spawning a process.
 *   - advisory: 0 always (the core only returns; a throw is handled by main).
 *   - strict:   1 when any check failed, else 0.
 */
export function exitCodeFor(result, { strict }) {
  if (!strict) return 0;
  return result.checks.every((c) => c.pass) ? 0 : 1;
}

function writeArtifact(result, outPath) {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(result, null, 2) + "\n");
  return resolved;
}

export function formatReport(result, { strict }) {
  const lines = [];
  const failed = result.checks.filter((c) => !c.pass);
  const neutral = result.checks.filter((c) => c.neutral);
  const status = result.ok ? "OK" : "CHECKS FAILED";

  lines.push("");
  lines.push(`[live-colombia-election] Live Colombia-election smoke (${strict ? "STRICT" : "ADVISORY"} / non-hermetic)`);
  lines.push(HR);
  lines.push(`status: ${status}  ·  checks ${result.checks.length - failed.length}/${result.checks.length} passed  ·  ${neutral.length} neutral`);
  lines.push(`timestamp: ${result.timestamp}`);
  lines.push(HR);

  lines.push("checks:");
  for (const c of result.checks) {
    const mark = c.pass ? (c.neutral ? "•" : "✓") : "✗";
    lines.push(`  ${mark} ${c.name} — ${c.detail}`);
  }
  lines.push(HR);

  const s = result.stats;
  lines.push("key stats:");
  lines.push(`  raw=${s.rawCount}  candidate=${s.candidateCount}  geoPassed=${s.geoPassedCount}  recall=${s.recallCount}`);
  lines.push(`  deduped=${s.dedupedCount}  clusterInput=${s.clusterInputCount}/${s.clusterInputCapEffective}  clusterDropped=${s.clusterDroppedCount}  final=${s.finalCount}`);
  lines.push(`  election=${s.electionCount} (configuredGeo=${s.configuredGeoElectionCount}, crossCountry=${s.crossCountryElectionCount})`);

  if (result.warnings.length > 0) {
    lines.push(HR);
    lines.push("warnings:");
    for (const w of result.warnings) lines.push(`  ! ${w}`);
  }
  lines.push(HR);
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const strict = parseStrict(argv);
  const jsonOut = parseJsonOut(argv);

  let result;
  try {
    result = await runDashboardLiveColombiaElectionCore({
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // A throw from the core is a TRUE execution error (bad config / pipeline
    // crash) — always exit 1, in both advisory and strict mode.
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[live-colombia-election] EXECUTION ERROR — ${msg}`);
    process.exit(1);
  }

  console.log(formatReport(result, { strict }));

  if (jsonOut) {
    const resolved = writeArtifact(result, jsonOut);
    console.log(`[live-colombia-election] JSON artifact → ${resolved}`);
  }

  const code = exitCodeFor(result, { strict });
  if (!result.ok) {
    const verb = strict ? "FAIL (strict — non-zero exit)" : "advisory — check failures printed, exit 0 (not a CI regression)";
    console.log(`[live-colombia-election] ${result.ok ? "" : "one or more checks did not hold: "}${verb}`);
  } else {
    console.log("[live-colombia-election] all checks held.");
  }
  process.exit(code);
}

// Direct-execution guard — main() fires only when this file is the entrypoint.
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[live-colombia-election] Fatal error:", err);
    process.exit(1);
  });
}
