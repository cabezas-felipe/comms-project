/**
 * D3 Quality Guardrails — composite advisory (Sprint D3)
 *
 * A LOCAL-ONLY orchestration command that runs the quality stack end-to-end and
 * produces a concise, scannable rollup plus a lightweight JSON artifact. It is a
 * balanced composite advisory: it sequences the four quality checks, captures
 * per-check status + duration, and exits non-zero if any check failed — but only
 * AFTER running all of them (continue-all, never short-circuit).
 *
 * Included checks (locked decision #2):
 *   1. dashboard-quality-gate   — existing CI-grade dashboard gate (golden +
 *                                 spanish-recall + calibration guardrails)
 *   2. dashboard-embassy-beat   — C3 mixed EN/ES multi-geo presence smoke
 *   3. cache-benefit-advisory   — D1 ingestion-cache benefit window logic
 *   4. d2-narrative-stability   — D2 fail-closed-per-story narrative stability
 *
 * This runner does NOT change any included eval's logic — it only spawns each
 * existing runner as a child process and aggregates the results.
 *
 * Rollout posture (locked decision #4): LOCAL-ONLY. This is intentionally NOT
 * wired into CI or any blocking quality gate in this slice.
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:d3-quality-advisory
 *   # optional custom artifact path:
 *   node src/ai/evals/run-d3-quality-advisory.mjs --json-out .artifacts/d3.json
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const EVALS_DIR = path.dirname(__filename);
// src/ai/evals → up three → the apps/api root (cwd the child runners expect).
const API_ROOT = path.resolve(EVALS_DIR, "../../..");

export const SCHEMA_VERSION = "d3-quality-advisory-v1";
const DEFAULT_ARTIFACT = path.join(API_ROOT, ".artifacts", "d3-quality-advisory.json");
const HR = "─".repeat(72);

// Deterministic sequence (locked decision #2). `script` is relative to API_ROOT
// (the child cwd) so the printed `command` matches what a human would type.
export const CHECKS = [
  { id: "dashboard-quality-gate", script: "src/ai/evals/run-dashboard-quality-gate.mjs" },
  { id: "dashboard-embassy-beat", script: "src/ai/evals/run-dashboard-embassy-beat.mjs" },
  { id: "cache-benefit-advisory", script: "src/ai/evals/run-cache-benefit-advisory.mjs" },
  { id: "d2-narrative-stability", script: "src/ai/evals/run-d2-narrative-stability.mjs" },
];

function parseArtifactPath(argv) {
  const i = argv.indexOf("--json-out");
  if (i !== -1 && argv[i + 1]) {
    return path.isAbsolute(argv[i + 1]) ? argv[i + 1] : path.resolve(API_ROOT, argv[i + 1]);
  }
  return DEFAULT_ARTIFACT;
}

function tail(text, n = 15) {
  const lines = String(text ?? "").trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

// Default check executor: spawn the child runner and classify by exit code.
// `_output` / `_spawnError` are captured for an on-failure tail only and are
// NEVER persisted to the artifact (the artifact stays lightweight).
function spawnRunCheck(check) {
  const command = `node ${check.script}`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [check.script], {
    cwd: API_ROOT,
    encoding: "utf8",
  });
  const durationMs = Date.now() - t0;
  // status === 0 → pass. A spawn error (null status) is a failure too.
  const ok = res.status === 0;
  return {
    id: check.id,
    command,
    ok,
    durationMs,
    startedAt,
    exitCode: res.status,
    _output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    _spawnError: res.error ? res.error.message : null,
  };
}

// Default artifact writer: lightweight JSON to disk (mkdir -p + write).
function writeArtifactToDisk(artifactPath, artifact) {
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

/**
 * Pure-ish D3 orchestration core. Sequences `checks`, runs each via `runCheck`
 * (continue-all — a failing check never short-circuits the loop), prints the
 * per-check + rollup report via `logger`, writes the lightweight artifact via
 * `writeArtifact`, and RETURNS `{ exitCode, overallOk, artifact, results }`.
 *
 * It does NOT call `process.exit` or touch the filesystem directly — those are
 * injected so the contract (continue-all, exit semantics, reporting, artifact
 * shape) is unit-testable without spawning child processes. The CLI `main()`
 * wrapper wires the real dependencies and owns `process.exit`.
 *
 * @param {object} [deps]
 * @param {Array<{id:string, script:string}>} [deps.checks]
 * @param {(check) => object} [deps.runCheck] — returns a per-check result.
 * @param {() => Date} [deps.now] — clock seam for startedAt/finishedAt.
 * @param {(artifactPath: string, artifact: object) => void} [deps.writeArtifact]
 * @param {{log: (...args) => void}} [deps.logger]
 * @param {string} [deps.artifactPath]
 */
export function runD3QualityAdvisory({
  checks = CHECKS,
  runCheck = spawnRunCheck,
  now = () => new Date(),
  writeArtifact = writeArtifactToDisk,
  logger = console,
  artifactPath = DEFAULT_ARTIFACT,
} = {}) {
  const startedAt = now().toISOString();

  logger.log("\n[d3-quality-advisory] Sprint D3 — composite quality advisory (LOCAL-ONLY, not wired to CI)");
  logger.log(`[d3-quality-advisory] running ${checks.length} checks (continue-all, then non-zero exit if any fail)`);
  logger.log(HR);

  const results = [];
  for (const check of checks) {
    const r = runCheck(check); // continue-all: never throws/breaks the loop
    results.push(r);
    const mark = r.ok ? "✓" : "✗";
    const status = r.ok ? "PASS" : "FAIL";
    logger.log(`${mark} ${String(r.id).padEnd(24)} ${status}  (${r.durationMs}ms)  [${r.command}]`);
    if (!r.ok) {
      if (r._spawnError) logger.log(`    spawn error: ${r._spawnError}`);
      logger.log(`    exitCode=${r.exitCode}; last output lines:`);
      for (const line of tail(r._output).split("\n")) logger.log(`    │ ${line}`);
    }
  }

  const finishedAt = now().toISOString();
  const passed = results.filter((r) => r.ok).length;
  const overallOk = passed === results.length;

  logger.log(HR);
  logger.log(`ROLLUP: ${passed}/${results.length} checks passed — OVERALL ${overallOk ? "PASS" : "FAIL"}`);
  for (const r of results) {
    logger.log(`  ${r.ok ? "✓" : "✗"} ${String(r.id).padEnd(24)} ${r.durationMs}ms`);
  }

  // Lightweight JSON artifact (status + duration per check; NO raw logs).
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    startedAt,
    finishedAt,
    overallOk,
    checks: results.map((r) => ({
      id: r.id,
      command: r.command,
      ok: r.ok,
      durationMs: r.durationMs,
    })),
  };
  writeArtifact(artifactPath, artifact);
  logger.log(`artifact: ${artifactPath}`);
  logger.log("");

  return { exitCode: overallOk ? 0 : 1, overallOk, artifact, results, artifactPath };
}

function main() {
  const artifactPath = parseArtifactPath(process.argv.slice(2));
  const { exitCode } = runD3QualityAdvisory({ artifactPath });
  process.exit(exitCode);
}

if (process.argv[1] === __filename) {
  main();
}
