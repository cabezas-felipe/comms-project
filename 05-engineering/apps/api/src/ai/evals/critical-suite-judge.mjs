/**
 * Critical Suite — Hybrid evaluator: deterministic pre-checks + LLM judge
 *
 * Phase 5b: the critical suite hard-gates on deterministic scenario
 * assertions (`critical-suite-core.mjs`). This module adds two **advisory**
 * layers on top, never blocking:
 *
 *   1. Deterministic pre-checks (`buildDeterministicChecks`) — schema /
 *      shape / contradiction guards over the scenario diagnostics. Fast,
 *      offline, no API key needed. Surfaces as advisory warnings.
 *
 *   2. Semantic judge (`runSemanticJudge`) — optional LLM call that scores
 *      relevance / coverage / noise / source-reasonableness over a small
 *      subset of scenarios. Disabled by default; enabled via env or CLI
 *      flag. Returns advisory findings; never gates release.
 *
 * Both layers feed `aggregateVerdict` from the core as `driftFindings` and
 * `judgeFindings` respectively. Per the locked Phase 5b policy:
 *   - Hard-fail = critical scenario failure ONLY.
 *   - Drift + judge are warning-level unless they correlate with a
 *     critical failure (in which case the aggregator emits a causal note).
 */

import Anthropic from "@anthropic-ai/sdk";

// ─── Deterministic pre-checks ────────────────────────────────────────────────
//
// Each check produces an advisory finding regardless of pass/fail; the
// `level` field signals whether the check found a real concern. These are
// intentionally lightweight — they run over the diagnostics each scenario
// already produced, so they don't re-execute the pipeline.

/**
 * Run deterministic post-hoc checks over scenario diagnostics and return a
 * list of advisory findings. Pure / synchronous / no I/O.
 *
 * @param {Array<{ id: string, ok: boolean, diagnostics: object, reasons: string[] }>} results
 * @returns {Array<{ id: string, level: "info"|"warn", message: string }>}
 */
export function buildDeterministicChecks(results) {
  const findings = [];

  for (const r of results) {
    const d = r.diagnostics ?? {};

    // Recall shape completeness — Phase 3 invariant: every recall return
    // path carries `mode`, `degraded`, and `degraded_reason`. A missing
    // field on a non-error path is a quiet contract drift.
    if (d.recall && typeof d.recall === "object") {
      const required = ["mode", "degraded", "degraded_reason", "finalRelevant"];
      const missing = required.filter((f) => !(f in d.recall));
      if (missing.length > 0) {
        findings.push({
          id: `${r.id}:recall-shape`,
          level: "warn",
          message: `recall diagnostics missing field(s): ${missing.join(", ")}`,
        });
      }
    }

    // Funnel ↔ recall coherence — Phase 3 invariant pinned in tests.
    // We treat a soft contradiction (post-recall count != recall.finalRelevant)
    // as a warning here because it can also signal scenario-fixture drift.
    if (d.funnel && d.recall) {
      const post = d.funnel.afterTopicKeyword;
      const finalRel = d.recall.finalRelevant;
      if (
        typeof post === "number" &&
        typeof finalRel === "number" &&
        post !== finalRel
      ) {
        findings.push({
          id: `${r.id}:funnel-recall-divergence`,
          level: "warn",
          message: `funnel.afterTopicKeyword=${post} ≠ recall.finalRelevant=${finalRel}`,
        });
      }
    }

    // Stories carry real source ids — defense against future "no fabrication"
    // regressions creeping in via clustering output.
    if (Array.isArray(d.stories)) {
      for (const story of d.stories) {
        for (const src of story?.sources ?? []) {
          if (!src?.id || typeof src.id !== "string") {
            findings.push({
              id: `${r.id}:source-id-missing`,
              level: "warn",
              message: `story ${story?.metaStoryId ?? story?.id} has a source without a stable id`,
            });
            break;
          }
        }
      }
    }
  }

  return findings;
}

// ─── Semantic judge (optional) ───────────────────────────────────────────────
//
// Calls a Claude model to score a small subset of scenarios on:
//   relevance (0-3) — does the surfaced output match the scenario intent?
//   coverage  (0-3) — did obvious signals make it through?
//   noise     (0-3) — are off-beat items absent? (3 = clean)
//   source_reasonableness (0-3) — do surfaced sources match the configured set?
//
// Returns findings with `score` (average across dimensions, 0-3). The judge
// is OPT-IN and NEVER gates release — its findings are advisory.
//
// Off by default to keep CI hermetic. Enable via:
//   TEMPO_CRITICAL_SUITE_JUDGE=1 (env) or `--judge` (CLI flag)

const JUDGE_PROMPT = [
  "You are a release-gate quality assessor for a news-intent dashboard.",
  "For each scenario, you receive: the scenario's stated INTENT and the small",
  "set of stories the pipeline surfaced (titles only). Score the scenario",
  "on four dimensions, each 0–3 (3 = best):",
  "",
  "  relevance              — surfaced stories match the stated intent",
  "  coverage               — obvious intent-relevant signals are present",
  "  noise                  — off-beat / unrelated content is absent",
  "  source_reasonableness  — outlets match the configured source posture",
  "",
  "Return STRICT JSON with shape:",
  '  { "scenario_id": string, "relevance": 0-3, "coverage": 0-3,',
  '    "noise": 0-3, "source_reasonableness": 0-3, "comment": string }',
  "",
  "Do NOT include markdown fences. JSON only.",
].join("\n");

// Build the per-scenario user message — short, deterministic, no creative
// padding. Title-only to keep token usage low and the judge focused.
function buildJudgeUserMessage(scenario) {
  const stories = (scenario.diagnostics?.stories ?? []).map((s) => ({
    title: s.title ?? "(no title)",
    sources: (s.sources ?? []).map((src) => src.outlet ?? src.id ?? "?"),
  }));
  return [
    `scenario_id: ${scenario.id}`,
    `intent: ${scenario.intent}`,
    `stories: ${JSON.stringify(stories)}`,
  ].join("\n");
}

function parseJudgeJson(raw) {
  const clean = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(clean);
}

function avgScore(s) {
  const dims = [s.relevance, s.coverage, s.noise, s.source_reasonableness].filter(
    (n) => typeof n === "number"
  );
  if (dims.length === 0) return null;
  return dims.reduce((a, b) => a + b, 0) / dims.length;
}

/**
 * Run the semantic judge over a subset of scenarios. Returns advisory
 * findings; never throws on judge errors (those become advisory warnings
 * themselves so the suite never fails because the judge had a bad day).
 *
 * @param {object} opts
 * @param {Array<{ id, intent, diagnostics }>} opts.scenarios   — full result rows
 * @param {string[]} [opts.targetIds]                           — subset to judge
 * @param {string}   [opts.apiKey]                              — Anthropic API key
 * @param {string}   [opts.model]                               — defaults to Sonnet
 */
export async function runSemanticJudge({
  scenarios,
  targetIds = [
    "critical-01-china-defense-trade",
    "critical-02-monitoring-migration-border",
  ],
  apiKey,
  model = "claude-sonnet-4-6",
}) {
  if (!apiKey) {
    return [
      {
        id: "judge:disabled",
        level: "info",
        message:
          "Semantic judge disabled — no API key available (set TEMPO_ANTHROPIC_API_KEY and TEMPO_CRITICAL_SUITE_JUDGE=1 to enable).",
      },
    ];
  }
  const client = new Anthropic({ apiKey });
  const findings = [];
  const targets = scenarios.filter((s) => targetIds.includes(s.id));
  for (const scenario of targets) {
    try {
      const message = await client.messages.create({
        model,
        max_tokens: 400,
        system: JUDGE_PROMPT,
        messages: [{ role: "user", content: buildJudgeUserMessage(scenario) }],
      });
      const block = message.content?.[0];
      if (!block || block.type !== "text" || !block.text.trim()) {
        findings.push({
          id: `judge:${scenario.id}`,
          level: "warn",
          message: "Judge returned an empty response — treating as no-signal.",
        });
        continue;
      }
      const parsed = parseJudgeJson(block.text);
      const score = avgScore(parsed);
      const level = typeof score === "number" && score < 2 ? "warn" : "info";
      findings.push({
        id: `judge:${scenario.id}`,
        level,
        score,
        message: `judge avg=${score?.toFixed?.(2) ?? "n/a"} — ${
          parsed.comment ?? ""
        }`.trim(),
      });
    } catch (err) {
      findings.push({
        id: `judge:${scenario.id}`,
        level: "warn",
        message: `judge call failed (advisory only): ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }
  return findings;
}

/**
 * CLI/env resolver — encapsulates the "should we run the judge?" decision
 * so the CLI runner stays tiny.
 */
export function judgeEnabledFromEnv(env = process.env) {
  return env.TEMPO_CRITICAL_SUITE_JUDGE === "1" || env.TEMPO_CRITICAL_SUITE_JUDGE === "true";
}
