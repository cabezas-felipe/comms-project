/**
 * Onboarding Extraction Eval — Section 8
 *
 * Runs the 20-example gold dataset through the same two-model chain used by
 * the onboarding runtime (Opus primary → Sonnet fallback) and reports
 * per-field precision / recall / F1 / exact-match rates.
 *
 * Requires: TEMPO_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY
 * Usage:    npm run eval:onboarding-extraction
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { extractOnboarding } from "../onboarding-extractor.mjs";
import { normalizeForEval, normalizeForEvalField, setMetrics, EVAL_FIELDS } from "./eval-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load apps/api/.env by absolute path so keys are available regardless of CWD.
// dotenv.config() is a no-op when the file is absent, so this is safe everywhere.
dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

const PRIMARY_MODEL = "anthropic:claude-opus-4-7";
const FALLBACK_MODEL = "anthropic:claude-sonnet-4-6";
const EXACT_MATCH_WARN_THRESHOLD = 0.70;

// Mirrors the server's two-model chain without the mutable hook indirection.
async function extractWithChain(text) {
  try {
    return await extractOnboarding(text, PRIMARY_MODEL);
  } catch (primaryErr) {
    console.warn(`    [warn] primary failed: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}`);
    return await extractOnboarding(text, FALLBACK_MODEL);
  }
}

function fmtPct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtN(n) {
  return n.toFixed(3);
}

async function main() {
  const hasKey =
    process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!hasKey) {
    console.warn(
      "\n[eval] WARNING: No TEMPO_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY found."
    );
    console.warn(
      "[eval]          Each example will fail extraction. Set an API key to run meaningfully.\n"
    );
  }

  const goldPath = path.join(__dirname, "onboarding-extraction.gold.json");
  const examples = JSON.parse(await readFile(goldPath, "utf8"));

  console.log(
    `\n[eval] Running ${examples.length} examples — ${PRIMARY_MODEL} → ${FALLBACK_MODEL}`
  );

  const results = [];

  for (const ex of examples) {
    const inputText = ex.inputText ?? ex.input ?? "";
    const expected = {};
    for (const field of EVAL_FIELDS) {
      expected[field] = normalizeForEvalField(field, ex.expected?.[field] ?? []);
    }

    let predicted = null;
    let extractionError = null;

    try {
      const raw = await extractWithChain(inputText);
      predicted = {};
      for (const field of EVAL_FIELDS) {
        predicted[field] = normalizeForEvalField(field, raw[field] ?? []);
      }
    } catch (err) {
      extractionError = err instanceof Error ? err.message : String(err);
    }

    const fieldMetrics = {};
    let allMatch = true;

    if (predicted) {
      for (const field of EVAL_FIELDS) {
        const m = setMetrics(predicted[field], expected[field]);
        fieldMetrics[field] = m;
        if (!m.exactMatch) allMatch = false;
      }
    } else {
      allMatch = false;
      for (const field of EVAL_FIELDS) {
        fieldMetrics[field] = { precision: 0, recall: 0, f1: 0, exactMatch: false };
      }
    }

    process.stdout.write(`  ${allMatch ? "✓" : "✗"} ${ex.id} (${ex.bucket})${extractionError ? " — extraction_error" : ""}\n`);

    results.push({
      id: ex.id,
      bucket: ex.bucket,
      allMatch,
      extractionError,
      fieldMetrics,
      predicted,
      expected,
      inputText,
    });
  }

  // ── Aggregate metrics ──────────────────────────────────────────────────────

  const total = results.length;
  const successCount = results.filter((r) => !r.extractionError).length;
  const exactMatchCount = results.filter((r) => r.allMatch).length;
  const overallRate = exactMatchCount / total;

  const fieldAgg = {};
  for (const field of EVAL_FIELDS) {
    let exactN = 0;
    let sumP = 0, sumR = 0, sumF1 = 0;
    for (const r of results) {
      const m = r.fieldMetrics[field];
      if (m.exactMatch) exactN++;
      sumP += m.precision;
      sumR += m.recall;
      sumF1 += m.f1;
    }
    fieldAgg[field] = {
      exactMatchRate: exactN / total,
      precision: sumP / total,
      recall: sumR / total,
      f1: sumF1 / total,
    };
  }

  // Bucket-level exact match
  const bucketCounts = {};
  const bucketMatches = {};
  for (const r of results) {
    bucketCounts[r.bucket] = (bucketCounts[r.bucket] ?? 0) + 1;
    if (r.allMatch) bucketMatches[r.bucket] = (bucketMatches[r.bucket] ?? 0) + 1;
  }

  // ── Report ─────────────────────────────────────────────────────────────────

  const HR = "─".repeat(60);
  const HR2 = "═".repeat(60);

  console.log(`\n${HR2}`);
  console.log(" Onboarding Extraction Eval — Results");
  console.log(HR2);
  console.log(
    `\n  Examples : ${total}   Extracted : ${successCount}/${total}   Overall exact-match : ${exactMatchCount}/${total} (${fmtPct(overallRate)})`
  );

  if (overallRate < EXACT_MATCH_WARN_THRESHOLD) {
    console.log(
      `\n  ⚠  WARNING: Overall exact-match ${fmtPct(overallRate)} is below target ${fmtPct(EXACT_MATCH_WARN_THRESHOLD)}.`
    );
  }

  console.log(`\n${HR}`);
  console.log(" Per-field metrics (macro-averaged across all examples)");
  console.log(HR);
  console.log(
    `${"Field".padEnd(22)}${"ExactMatch".padEnd(13)}${"P".padEnd(8)}${"R".padEnd(8)}F1`
  );
  console.log("─".repeat(55));
  for (const field of EVAL_FIELDS) {
    const m = fieldAgg[field];
    console.log(
      `${field.padEnd(22)}${fmtPct(m.exactMatchRate).padEnd(13)}${fmtN(m.precision).padEnd(8)}${fmtN(m.recall).padEnd(8)}${fmtN(m.f1)}`
    );
  }

  console.log(`\n${HR}`);
  console.log(" Bucket-level exact-match");
  console.log(HR);
  for (const bucket of Object.keys(bucketCounts).sort()) {
    const n = bucketCounts[bucket];
    const m = bucketMatches[bucket] ?? 0;
    console.log(`  ${bucket.padEnd(24)} ${m}/${n}  (${fmtPct(m / n)})`);
  }

  const failed = results.filter((r) => !r.allMatch);
  if (failed.length > 0) {
    console.log(`\n${HR}`);
    console.log(` Failed examples — ${failed.length}`);
    console.log(HR);
    for (const r of failed) {
      if (r.extractionError) {
        console.log(`\n  [${r.id}] (${r.bucket})`);
        console.log(`    extraction_error: ${r.extractionError}`);
        continue;
      }
      const mismatched = EVAL_FIELDS.filter((f) => !r.fieldMetrics[f].exactMatch);
      console.log(`\n  [${r.id}] (${r.bucket}) — mismatched: ${mismatched.join(", ")}`);
      for (const field of mismatched) {
        const m = r.fieldMetrics[field];
        console.log(`    ${field}:`);
        console.log(`      expected : [${r.expected[field].join(", ")}]`);
        console.log(`      predicted: [${r.predicted[field].join(", ")}]`);
        console.log(`      P=${fmtN(m.precision)} R=${fmtN(m.recall)} F1=${fmtN(m.f1)}`);
      }
    }
  }

  console.log(`\n${HR2}\n`);
}

main().catch((err) => {
  console.error("[eval] Fatal error:", err);
  process.exit(1);
});
