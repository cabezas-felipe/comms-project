#!/usr/bin/env node
//
// Phase 5 semantic-tag threshold calibration harness.
//
// Operator tool — NOT exercised in CI.  Use this when calibrating
// `TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD` / `TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD`
// before flipping the per-axis flag on.
//
// Usage:
//
//   # Default — uses the bundled fixture set + a built-in mock scorer (no
//   # network calls); useful for smoke-checking the harness itself + the
//   # invariant that out-of-settings labels never appear.
//   node scripts/semantic-tag-calibration.mjs
//
//   # Real provider — wires the embedding scorer to `embedTexts` (production
//   # path).  Requires TEMPO_OPENAI_API_KEY (or OPENAI_API_KEY).
//   node scripts/semantic-tag-calibration.mjs --provider=embeddings
//
//   # Custom fixture file
//   node scripts/semantic-tag-calibration.mjs --fixtures=/path/to/fixtures.json
//
//   # Override candidate thresholds (comma-separated, in [0,1])
//   node scripts/semantic-tag-calibration.mjs --thresholds=0.6,0.7,0.8
//
// Output: one section per axis (`topics`, `keywords`) listing each candidate
// threshold's precision / recall / F1-proxy + a confusion-style summary of
// which cases passed / failed at that threshold.  Recommends the highest
// threshold whose recall does not regress below the next-lowest threshold —
// a conservative bias toward precision in line with the Phase 5 rollout
// posture.
//
// The harness does NOT mutate settings or pipeline state; it only runs the
// scorer against curated evidence/label pairs.  Out-of-settings emission is
// impossible by construction (`mapSemanticAxis` only scores labels you
// pass in), but the harness still asserts the contract per case so a future
// scorer change can't accidentally widen the closed vocabulary.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  mapSemanticAxis,
  createEmbeddingSemanticScorer,
} from "../src/dashboard/meta-story-semantic-mapper.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_FIXTURE_PATH = path.join(__dirname, "semantic-tag-calibration-fixtures.json");
const DEFAULT_THRESHOLDS = [0.55, 0.65, 0.75, 0.85];

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "mock" },
    fixtures: { type: "string" },
    thresholds: { type: "string" },
    // Phase 7: read observed `_meta.tags.{topics,keywords}` snapshots from a
    // file and emit a threshold adjustment recommendation based on per-axis
    // acceptance / below-threshold ratios from real production runs.  Always
    // human-in-the-loop — this prints a recommendation, it does NOT mutate
    // any env config.
    telemetry: { type: "string" },
  },
  strict: false,
});

const provider = (values.provider ?? "mock").toLowerCase();
const fixturesPath = values.fixtures ?? DEFAULT_FIXTURE_PATH;
const telemetryPath = values.telemetry;
const candidateThresholds = values.thresholds
  ? values.thresholds
      .split(",")
      .map((t) => Number.parseFloat(t.trim()))
      .filter((t) => Number.isFinite(t) && t >= 0 && t <= 1)
  : DEFAULT_THRESHOLDS;

// ─── Scorer providers ────────────────────────────────────────────────────────

// Mock scorer — keyword-based "semantic" heuristic that lets the harness run
// offline.  Maps a small synonym/cooccurrence lexicon to a score in (0, 1).
// Not used for real calibration; only here so the harness is self-testable.
function makeMockScorer() {
  const LEX = {
    oil: ["petroleum", "crude", "barrel", "refining", "gasoline", "diesel"],
    sanctions: ["sanction", "ofac", "embargo", "asset freeze", "treasury"],
    deportation: ["deport", "removal", "ice", "icj", "asylum"],
    border: ["border", "frontier", "crossing", "migrant corridor"],
    "diplomatic relations": ["talks", "diplomacy", "bilateral", "envoy", "communique"],
    "migration policy": ["asylum", "migration", "deport", "border policy"],
    "security cooperation": ["patrol", "joint", "intelligence", "interdiction"],
    "energy policy": ["energy", "petroleum", "crude", "refining", "pipeline"],
  };
  return async (evidence, label) => {
    const lower = (evidence ?? "").toLowerCase();
    const needles = LEX[label.toLowerCase()] ?? [];
    let hits = 0;
    for (const needle of needles) {
      if (lower.includes(needle)) hits += 1;
    }
    if (hits === 0) return 0;
    // Compress to [0.55, 0.95] so the harness produces interesting thresholds.
    return Math.min(0.95, 0.55 + 0.1 * hits);
  };
}

async function makeEmbeddingProviderScorer() {
  const { embedTexts } = await import("../src/ai/embeddings.mjs");
  return createEmbeddingSemanticScorer({
    embedFn: (texts) => embedTexts(texts),
  });
}

async function pickScorer() {
  if (provider === "embeddings") return makeEmbeddingProviderScorer();
  if (provider === "mock") return makeMockScorer();
  throw new Error(`Unknown --provider value: ${provider}. Use 'mock' or 'embeddings'.`);
}

// ─── Harness ─────────────────────────────────────────────────────────────────

async function loadFixtures(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("fixture file must be a JSON object");
  }
  if (!parsed.settings || !Array.isArray(parsed.cases)) {
    throw new Error("fixture file must have `settings` + `cases`");
  }
  return parsed;
}

function classifyCase(caseRow, accepted) {
  const expectAccept = new Set((caseRow.expectedAccept ?? []).map((s) => s.toLowerCase()));
  const expectReject = new Set((caseRow.expectedReject ?? []).map((s) => s.toLowerCase()));
  const acceptedLower = new Set(accepted.map((s) => s.toLowerCase()));
  let truePositive = 0;
  let falseNegative = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  for (const label of expectAccept) {
    if (acceptedLower.has(label)) truePositive += 1;
    else falseNegative += 1;
  }
  for (const label of expectReject) {
    if (acceptedLower.has(label)) falsePositive += 1;
    else trueNegative += 1;
  }
  return { truePositive, falseNegative, falsePositive, trueNegative };
}

function summarize(confusion) {
  const precDen = confusion.truePositive + confusion.falsePositive;
  const recDen = confusion.truePositive + confusion.falseNegative;
  const precision = precDen === 0 ? 1 : confusion.truePositive / precDen;
  const recall = recDen === 0 ? 1 : confusion.truePositive / recDen;
  const f1Den = precision + recall;
  const f1 = f1Den === 0 ? 0 : (2 * precision * recall) / f1Den;
  return { precision, recall, f1 };
}

function pad(value, width) {
  return String(value).padEnd(width, " ");
}

async function runForAxisAndThreshold({ axis, allowedLabels, cases, threshold, scorer }) {
  const acc = { truePositive: 0, falseNegative: 0, falsePositive: 0, trueNegative: 0 };
  const perCase = [];
  for (const c of cases.filter((c) => c.axis === axis)) {
    const { accepted, diagnostics } = await mapSemanticAxis({
      axis,
      evidenceText: c.evidence,
      allowedLabels,
      deterministicLabels: [],
      threshold,
      enabled: true,
      scorer,
    });
    const confusion = classifyCase(c, accepted);
    acc.truePositive += confusion.truePositive;
    acc.falseNegative += confusion.falseNegative;
    acc.falsePositive += confusion.falsePositive;
    acc.trueNegative += confusion.trueNegative;
    // Closed-vocabulary invariant — must hold even outside production wiring.
    for (const a of accepted) {
      if (!allowedLabels.includes(a)) {
        throw new Error(
          `[calibration] out-of-settings label '${a}' emitted for case ${c.id} — closed-vocabulary lock violated`
        );
      }
    }
    perCase.push({ id: c.id, accepted, confusion, diagnostics });
  }
  return { acc, perCase, ...summarize(acc) };
}

function chooseRecommendedThreshold(byThreshold) {
  // Recommend the highest threshold whose recall is within 0.05 of the
  // best-observed recall — a conservative bias toward precision.
  if (byThreshold.length === 0) return null;
  const bestRecall = Math.max(...byThreshold.map((b) => b.recall));
  const candidates = byThreshold.filter((b) => b.recall >= bestRecall - 0.05);
  return candidates.reduce((acc, cur) =>
    !acc || cur.threshold > acc.threshold ? cur : acc
  , null);
}

async function main() {
  const fixtures = await loadFixtures(fixturesPath);
  const scorer = await pickScorer();

  console.log(`# semantic-tag calibration`);
  console.log(`provider: ${provider}`);
  console.log(`fixtures: ${fixturesPath}`);
  console.log(`thresholds: ${candidateThresholds.join(", ")}`);
  console.log(``);

  for (const axis of ["topics", "keywords"]) {
    const allowedLabels = fixtures.settings[axis] ?? [];
    if (allowedLabels.length === 0) {
      console.log(`## axis: ${axis} — skipped (no settings vocabulary)`);
      console.log(``);
      continue;
    }
    console.log(`## axis: ${axis}`);
    console.log(``);
    console.log(
      `${pad("threshold", 10)}${pad("TP", 5)}${pad("FN", 5)}${pad("FP", 5)}${pad("TN", 5)}${pad("precision", 11)}${pad("recall", 9)}${pad("F1", 8)}`
    );
    const byThreshold = [];
    for (const threshold of candidateThresholds) {
      const r = await runForAxisAndThreshold({
        axis,
        allowedLabels,
        cases: fixtures.cases,
        threshold,
        scorer,
      });
      console.log(
        `${pad(threshold.toFixed(2), 10)}${pad(r.acc.truePositive, 5)}${pad(r.acc.falseNegative, 5)}${pad(r.acc.falsePositive, 5)}${pad(r.acc.trueNegative, 5)}${pad(r.precision.toFixed(3), 11)}${pad(r.recall.toFixed(3), 9)}${pad(r.f1.toFixed(3), 8)}`
      );
      byThreshold.push({ threshold, ...r });
    }
    const recommended = chooseRecommendedThreshold(byThreshold);
    if (recommended) {
      console.log(``);
      console.log(
        `recommended ${axis} threshold: ${recommended.threshold.toFixed(2)} ` +
          `(precision=${recommended.precision.toFixed(3)}, recall=${recommended.recall.toFixed(3)}, F1=${recommended.f1.toFixed(3)})`
      );
    }
    console.log(``);
  }

  // Phase 7: telemetry-driven threshold adjustment recommendation.  Reads a
  // JSON file containing observed `_meta.tags` snapshots (an array of run
  // metas; we aggregate per axis across runs) and prints an "adjust up /
  // hold / adjust down" suggestion alongside the fixture-driven baseline
  // recommendation above.  Strictly advisory — never auto-edits env config.
  if (telemetryPath) {
    const telemetry = await loadTelemetry(telemetryPath);
    console.log(`## telemetry-driven threshold guidance`);
    console.log(`telemetry: ${telemetryPath} (${telemetry.length} run snapshots)`);
    console.log(``);
    for (const axis of ["topics", "keywords"]) {
      const agg = aggregateTelemetryAxis(telemetry, axis);
      const advice = recommendThresholdAdjustment(agg);
      console.log(
        `${pad(axis, 12)}` +
          `runs=${pad(agg.runs, 5)}` +
          `calls=${pad(agg.calls, 7)}` +
          `accept_rate=${pad(formatRate(agg.acceptRate), 7)}` +
          `below_rate=${pad(formatRate(agg.belowRate), 7)}` +
          `timeout_rate=${pad(formatRate(agg.timeoutRate), 9)}` +
          `runtime_state=${agg.worstRuntimeState ?? "—"}`
      );
      console.log(`  guidance: ${advice}`);
    }
    console.log(``);
  }
}

// ─── Telemetry-driven recommendation helpers ─────────────────────────────────
//
// `loadTelemetry` accepts either an array of `_meta.tags` objects or a
// single object — the script tolerates both so an operator can paste one
// run's snapshot or accumulate many over time.  Each axis is aggregated
// independently; geographies are skipped because Phase 4/5/6 lock semantic
// uplift to topics + keywords only.

async function loadTelemetry(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error("telemetry file must be a `_meta.tags` object or an array of them");
}

function aggregateTelemetryAxis(snapshots, axis) {
  let candidates = 0;
  let accepted = 0;
  let below = 0;
  let timeouts = 0;
  let calls = 0;
  let runs = 0;
  let worstRuntimeState = null;
  const RANK = {
    disabled: 0,
    enabled_no_scorer: 1,
    enabled_scorer_ready: 2,
    scorer_error_fallback: 3,
    scorer_timeout_fallback: 4,
  };
  for (const snap of snapshots) {
    const row = snap?.[axis];
    if (!row || typeof row !== "object") continue;
    runs += 1;
    candidates += row.candidateCount ?? 0;
    accepted += row.acceptedCount ?? 0;
    below += row.belowThresholdCount ?? 0;
    timeouts += row.fallbackReasonCounts?.timeout ?? 0;
    calls += row.scorerCallCount ?? 0;
    const rs = row.runtimeState;
    if (rs && (worstRuntimeState == null || (RANK[rs] ?? 0) > (RANK[worstRuntimeState] ?? 0))) {
      worstRuntimeState = rs;
    }
  }
  const acceptRate = candidates > 0 ? accepted / candidates : 0;
  const belowRate = candidates > 0 ? below / candidates : 0;
  const timeoutRate = calls > 0 ? timeouts / calls : 0;
  return { runs, candidates, accepted, below, timeouts, calls, acceptRate, belowRate, timeoutRate, worstRuntimeState };
}

function recommendThresholdAdjustment(agg) {
  // Heuristic, conservative — only suggests adjustment when telemetry shows
  // a meaningful signal.  Boundaries:
  //   - too-tight (low accept, high below_threshold): try LOWERING by 0.05
  //   - too-loose (high accept rate, near 100%): try RAISING by 0.05
  //   - frequent timeouts: hold threshold; flag latency tuning instead
  //   - thin telemetry (< 50 candidates): hold; collect more data
  if (agg.candidates < 50) {
    return "HOLD — telemetry sample too small (< 50 candidates); collect more before tuning.";
  }
  if (agg.timeoutRate > 0.05) {
    return `HOLD threshold — ${(agg.timeoutRate * 100).toFixed(1)}% scorer calls timed out; bump TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS or open provider ticket before retuning.`;
  }
  if (agg.belowRate > 0.35 && agg.acceptRate < 0.15) {
    return `LOWER threshold (e.g. by 0.05) — ${(agg.belowRate * 100).toFixed(1)}% of candidates fell just below threshold; recall may be too tight.`;
  }
  if (agg.acceptRate > 0.85) {
    return `RAISE threshold (e.g. by 0.05) — ${(agg.acceptRate * 100).toFixed(1)}% of candidates accept; precision may be too loose.`;
  }
  return `HOLD — accept/below ratios sit in the healthy band (accept=${(agg.acceptRate * 100).toFixed(1)}%, below=${(agg.belowRate * 100).toFixed(1)}%).`;
}

function formatRate(rate) {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
