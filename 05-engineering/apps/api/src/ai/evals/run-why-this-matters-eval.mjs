/**
 * Why-this-matters eval runner — locked 18-case regression set.
 *
 * Spec: docs/why-this-matters-spec.md §10 (release gates) + §12.4 (rubric-only).
 * Dataset: 03-prd/why-this-matters-eval-set-v0.json (18 cases, locked).
 *
 * Usage:
 *   npm run eval:why-this-matters --workspace=@tempo/api      # stub writer (default)
 *   EVAL_WRITER=real npm run eval:why-this-matters ...        # real Anthropic writer
 *
 * Modes:
 *   - stub (default): each case's `referenceGolden` + `expectedTaxonomyPrimary`
 *     + `expectedConfidence` are returned as the writer output, so the rubric
 *     and gate run deterministically without an API key.  Suitable for CI.
 *   - real: omit the writer stub and let the engine call Anthropic via env.
 *     Requires TEMPO_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY.  Group A pass
 *     under real-mode is the staging promotion gate (spec §10 CI section).
 *
 * Output:
 *   - Human-readable per-case ticks and a per-group summary.
 *   - A machine-readable JSON block at the end (between `=== JSON ===` and
 *     `=== END JSON ===` markers) for CI scrapers.
 *
 * Exit code:
 *   - 0 when no blockers; 1 on any release-gate blocker (spec §10).
 *   - Warnings (fallback / duplication rates) do not flip the exit code.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWhyItMatters, validateWhyItMatters } from "../../dashboard/why-this-matters-engine.mjs";
import {
  aggregateEvalMetrics,
  buildResolverInputForCase,
  buildValidationContextForCase,
  evaluateEvalGate,
  scoreEvalCase,
} from "./why-this-matters-eval-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Eval dataset lives in the product spec tree.  Six `..` segments traverse:
// `apps/api/src/ai/evals/` -> ai -> src -> api -> apps -> 05-engineering ->
// repo root, then descend into `03-prd/`.
const DEFAULT_DATASET_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "03-prd",
  "why-this-matters-eval-set-v0.json"
);

const FROZEN_GENERATED_AT = "2026-05-20T00:00:00.000Z";

const STUB_WRITER_CONFIG = Object.freeze({
  enabled: true,
  mockOnly: false,
  model: "anthropic:claude-sonnet-4-6",
  timeoutMs: 4000,
});

/**
 * Build a deterministic writer stub for one case.  Returns the case's
 * `referenceGolden` text and the locked `expectedTaxonomyPrimary` +
 * `expectedConfidence` so the validator sees the same trace shape it would
 * on a passing real-model run.
 *
 * For Group C cases this stub is never invoked (validator-only path).
 * For Group D03 the resolver short-circuits to fallback before reaching
 * the writer, so the stub is also bypassed.
 */
function makeStubWriteFn(caseDef) {
  const expected = caseDef?.expected ?? {};
  const text = typeof expected.referenceGolden === "string" ? expected.referenceGolden : "";
  const taxonomyPrimary =
    typeof expected.expectedTaxonomyPrimary === "string"
      ? expected.expectedTaxonomyPrimary
      : "monitoring_intensity";
  const confidence =
    typeof expected.expectedConfidence === "string" ? expected.expectedConfidence : "medium";
  return () => ({ text, taxonomyPrimary, confidence });
}

/**
 * Resolve a CLI/env flag for writer mode.  `EVAL_WRITER=real` or `--real`
 * opts into the live LLM path.  Everything else (including missing env)
 * defaults to the deterministic stub.
 */
function resolveWriterMode(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--real")) return "real";
  const envVal = String(env.EVAL_WRITER ?? "").trim().toLowerCase();
  if (envVal === "real") return "real";
  return "stub";
}

function shouldEmitJsonOnly(argv = process.argv.slice(2)) {
  return argv.includes("--json-only");
}

/**
 * Execute one eval case end-to-end and return an `outcome` shape suitable
 * for `scoreEvalCase`.  Group C cases short-circuit to validator-only.
 */
export async function runEvalCase(caseDef, { writerMode } = {}) {
  if (caseDef?.group === "C") {
    const validation = validateWhyItMatters(
      {
        text: caseDef?.expected?.trapGolden ?? "",
        taxonomyPrimary: "monitoring_intensity",
        confidence: "medium",
      },
      buildValidationContextForCase(caseDef)
    );
    return { type: "validator", validation };
  }
  const input = buildResolverInputForCase(caseDef);
  const writeFn = writerMode === "real" ? undefined : makeStubWriteFn(caseDef);
  const result = await resolveWhyItMatters(input, {
    writeFn,
    config: STUB_WRITER_CONFIG,
    generatedAt: FROZEN_GENERATED_AT,
  });
  return { type: "resolver", ...result };
}

/**
 * Top-level orchestrator.  Pure return shape (`scored[]` + `metrics` +
 * `gate`) so the unit tests can drive it without spawning the CLI.
 */
export async function runEvalSuite({
  datasetPath = DEFAULT_DATASET_PATH,
  writerMode = "stub",
} = {}) {
  const raw = readFileSync(datasetPath, "utf8");
  const dataset = JSON.parse(raw);
  const cases = Array.isArray(dataset?.cases) ? dataset.cases : [];

  const scored = [];
  for (const caseDef of cases) {
    const outcome = await runEvalCase(caseDef, { writerMode });
    const row = scoreEvalCase(caseDef, outcome);
    scored.push(row);
  }

  const metrics = aggregateEvalMetrics(scored);
  const gate = evaluateEvalGate(metrics);
  return { dataset, scored, metrics, gate };
}

function fmtPct(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function printReport({ dataset, scored, metrics, gate, writerMode }) {
  const HR = "-".repeat(60);
  const HR2 = "=".repeat(60);

  console.log(`\n${HR2}`);
  console.log(` Why-this-matters eval — ${dataset?.version ?? "unknown"} (${writerMode})`);
  console.log(HR2);

  for (const row of scored) {
    const mark = row.pass ? "ok" : "FAIL";
    const flags = [];
    if (row.hardFail) flags.push("hardFail");
    if (row.fallbackUsed) flags.push("fallback");
    const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
    console.log(`  ${mark}  ${row.id} (${row.group})${flagStr}`);
    if (!row.pass && row.failReasons.length > 0) {
      console.log(`        failReasons: ${row.failReasons.join("; ")}`);
    }
  }

  console.log(`\n${HR}`);
  console.log(" Per-group");
  console.log(HR);
  for (const g of ["A", "B", "C", "D"]) {
    const grp = metrics.byGroup?.[g];
    if (!grp) {
      console.log(`  ${g}: -`);
      continue;
    }
    console.log(
      `  ${g}: ${grp.pass}/${grp.total}  (${fmtPct(grp.passRate)})  hardFail=${grp.hardFail}  fallback=${grp.fallback}`
    );
  }

  console.log(`\n${HR}`);
  console.log(" Overall");
  console.log(HR);
  console.log(`  pass=${metrics.overallPass}/${metrics.total} (${fmtPct(metrics.overallPassRate)})`);
  console.log(`  hardFail=${metrics.hardFailCount} (${fmtPct(metrics.hardFailRate)})`);
  console.log(`  fallback=${metrics.fallbackCount} (${fmtPct(metrics.fallbackRate)})`);
  console.log(
    `  duplication_failures=${metrics.duplicationFailureCount} (${fmtPct(metrics.duplicationFailureRate)})`
  );

  if (gate.blockers.length > 0) {
    console.log(`\n${HR}`);
    console.log(" BLOCKERS");
    console.log(HR);
    for (const b of gate.blockers) console.log(`  - ${b}`);
  }
  if (gate.warnings.length > 0) {
    console.log(`\n${HR}`);
    console.log(" WARNINGS");
    console.log(HR);
    for (const w of gate.warnings) console.log(`  - ${w}`);
  }
  if (gate.blockers.length === 0 && gate.warnings.length === 0) {
    console.log("\n  All gates passed.");
  }
  console.log(`\n${HR2}\n`);
}

/**
 * Serialize the run into a stable JSON shape for CI scrapers.  Kept small:
 * id / group / pass / hardFail / fallbackUsed / failReasons per case, plus
 * the same metrics + gate object the runner prints.
 */
export function buildJsonSummary({ dataset, scored, metrics, gate, writerMode }) {
  return {
    dataset: dataset?.version ?? null,
    writerMode,
    metrics,
    gate,
    results: scored.map((r) => ({
      id: r.id,
      group: r.group,
      pass: r.pass,
      hardFail: r.hardFail,
      fallbackUsed: r.fallbackUsed,
      failReasons: r.failReasons,
    })),
  };
}

async function main() {
  const writerMode = resolveWriterMode();
  const jsonOnly = shouldEmitJsonOnly();
  const run = await runEvalSuite({ writerMode });
  if (!jsonOnly) {
    printReport({ ...run, writerMode });
  }
  const summary = buildJsonSummary({ ...run, writerMode });
  console.log("=== JSON ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("=== END JSON ===");
  if (run.gate.blockers.length > 0) process.exit(1);
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[eval:why-this-matters] fatal:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
