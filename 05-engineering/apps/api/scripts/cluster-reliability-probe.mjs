#!/usr/bin/env node
// Baseline clustering reliability probe (PR A — Step 1).
//
// Runs repeated *live* dashboard refreshes for a single user and enforces the
// agreed reliability gate:
//   - successRate   >= 0.95  (success = _meta.usedFallbackClustering === false)
//   - medianStories >= 2
//   - N = 20 runs by default
//
// This is a live probe: it requires the API server running (default
// http://localhost:8787) and, for --email resolution, Supabase admin env
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). It does not change product
// behavior — it only observes refresh responses.
//
// Usage (from 05-engineering/apps/api, with apps/api/.env loaded):
//   npm run cluster:probe -- --email you@example.com
//   npm run cluster:probe -- --user-id <uuid> --runs 20 --cooldown-ms 3000
//   npm run cluster:probe -- --email you@example.com --base-url http://localhost:8787
//
// Exit code: 0 when the gate passes, non-zero when it fails (or on setup error).
//
// The pure helpers (parseArgs, median, percentile, countBy, summarize,
// evaluateGate) are exported and unit-tested offline in
// scripts/cluster-reliability-probe.test.mjs — only the entry path below loads
// dotenv / Supabase and performs live HTTP.

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

// Only the script entry path triggers dotenv + Supabase + live HTTP. Importing
// this module (e.g. from the test file) must not connect to anything.
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// ─── gate thresholds ─────────────────────────────────────────────────────────

export const GATE = Object.freeze({
  minSuccessRate: 0.95,
  minMedianStories: 2,
  defaultRuns: 20,
  defaultCooldownMs: 3000,
  defaultBaseUrl: "http://localhost:8787",
});

// ─── measurement modes (Step 4.1) ────────────────────────────────────────────
//
// `default`    — latency summary spans ALL runs (backward-compatible).
// `cold-start` — latency summary is scoped to RECOMPUTE runs only (runs where
//                clustering actually ran, i.e. `refreshSkippedReason == null`),
//                so a watermark-skip-dominated probe doesn't understate the
//                cold-start p95. Gate thresholds (successRate / medianStories)
//                are computed over all runs in BOTH modes — gate semantics are
//                identical regardless of mode.
export const PROBE_MODE = Object.freeze({
  DEFAULT: "default",
  COLD_START: "cold-start",
});

// Latency scope passed to `summarize`. Mirrors PROBE_MODE but named for what it
// controls (which runs feed p95PipelineMs).
export const LATENCY_SCOPE = Object.freeze({
  ALL: "all",
  RECOMPUTE: "recompute",
});

/** A run is a "recompute" iff the pipeline did NOT short-circuit (no skip reason). */
export function isRecomputeRun(record) {
  return record?.refreshSkippedReason == null;
}

// ─── recompute-enforced sampling (Step 4.1 / Prompt 2b) ──────────────────────
//
// Problem this solves: after the first refresh writes a non-empty snapshot, a
// static candidate set produces an identical watermark, so every subsequent run
// short-circuits (`unchanged_watermark`). A fixed `--runs N` loop can therefore
// yield a latency p95 based on a single recompute run — not trustworthy.
//
// `--require-recompute` changes the loop from "do exactly N requests" to "keep
// requesting until N RECOMPUTE runs are collected", bounded by
// `N * RECOMPUTE_ATTEMPT_MULTIPLIER` total attempts so a server that keeps
// skipping can never spin forever. Skip runs are still recorded (for the
// recompute/skip counts) but don't count toward the target. The latency summary
// (recompute-scoped in cold-start mode) is then computed over a meaningful
// sample. Gate semantics are unchanged: successRate / medianStories still span
// every run that was issued.
export const RECOMPUTE_ATTEMPT_MULTIPLIER = 5;

/**
 * Resolve the loop bound. Pure.
 *   - `requireRecompute` false → fixed loop of `runs` attempts (backward-compatible).
 *   - `requireRecompute` true  → collect `runs` recompute runs, capped at
 *     `runs * RECOMPUTE_ATTEMPT_MULTIPLIER` attempts.
 */
export function resolveSamplingPlan({ runs, requireRecompute = false }) {
  if (!requireRecompute) {
    return { requireRecompute: false, targetRecomputeRuns: null, maxAttempts: runs };
  }
  return {
    requireRecompute: true,
    targetRecomputeRuns: runs,
    maxAttempts: runs * RECOMPUTE_ATTEMPT_MULTIPLIER,
  };
}

/**
 * Loop guard. Pure. Stop when the attempt cap is hit, or (recompute mode) when
 * the recompute target is reached.
 */
export function shouldStopSampling({ attempts, recomputeRuns, plan }) {
  if (attempts >= plan.maxAttempts) return true;
  if (plan.targetRecomputeRuns != null && recomputeRuns >= plan.targetRecomputeRuns) {
    return true;
  }
  return false;
}

/** True iff a recompute-enforced run actually reached its recompute target. Pure. */
export function recomputeTargetMet({ plan, recomputeRuns }) {
  if (!plan.requireRecompute) return true;
  return recomputeRuns >= plan.targetRecomputeRuns;
}

/**
 * Final probe decision (pure). Combines the reliability gate with a strict
 * SAMPLE-QUALITY gate that is active ONLY in recompute-enforced mode:
 *
 *   - Reliability gate (successRate / medianStories) — unchanged; `gate` is the
 *     `evaluateGate(...)` result and its semantics are untouched.
 *   - Sample-quality gate — when `--require-recompute` is on and the recompute
 *     target was NOT met, the run FAILS regardless of the reliability gate,
 *     because the latency p95 is based on too few recompute runs to trust for a
 *     cold-start hard-gate decision.
 *
 * Returns `{ pass, exitCode, reasons, gatePass, sampleQualityOk }`. In default
 * mode (no enforcement) `sampleQualityOk` is always true, so `pass === gate.pass`
 * and the exit semantics are byte-identical to before this fix.
 */
export function evaluateProbeDecision({ gate, plan, recomputeRuns }) {
  const sampleQualityOk =
    !plan?.requireRecompute || recomputeTargetMet({ plan, recomputeRuns });
  const reasons = [...(gate?.reasons ?? [])];
  if (!sampleQualityOk) {
    reasons.push(
      `recompute sample insufficient: collected ${recomputeRuns}/${plan.targetRecomputeRuns} ` +
        `recompute run(s) in up to ${plan.maxAttempts} attempts — cold-start p95 is NOT trustworthy`
    );
  }
  const gatePass = gate?.pass === true;
  const pass = gatePass && sampleQualityOk;
  return { pass, exitCode: pass ? 0 : 1, reasons, gatePass, sampleQualityOk };
}

// ─── argv parsing ────────────────────────────────────────────────────────────

/**
 * Parse probe CLI args. Returns { ok, ...opts } or { ok: false, error }.
 * Pure: no env reads, no exits.
 */
export function parseArgs(argv) {
  const out = {
    ok: true,
    email: null,
    userId: null,
    runs: GATE.defaultRuns,
    cooldownMs: GATE.defaultCooldownMs,
    baseUrl: GATE.defaultBaseUrl,
    // Step 4.1: measurement mode. "default" preserves the existing summary
    // exactly; "cold-start" requests the cold_start profile (`?profile=cold_start`)
    // AND scopes the LATENCY summary to recompute runs (watermark-skip runs
    // excluded) so p95PipelineMs reflects real cold-start clustering work, not
    // skip-dominated fast paths. Gate thresholds are unaffected.
    mode: PROBE_MODE.DEFAULT,
    // Step 4.1 / Prompt 2b: keep sampling until `runs` recompute runs are
    // collected (bounded) instead of issuing exactly `runs` requests. Default
    // false → backward-compatible fixed-N loop.
    requireRecompute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") out.email = argv[++i];
    else if (a === "--user-id") out.userId = argv[++i];
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--cooldown-ms") out.cooldownMs = Number(argv[++i]);
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--require-recompute") out.requireRecompute = true;
    else return { ok: false, error: `Unknown argument: ${a}` };
  }
  if (out.mode !== PROBE_MODE.DEFAULT && out.mode !== PROBE_MODE.COLD_START) {
    return {
      ok: false,
      error: `--mode must be "${PROBE_MODE.DEFAULT}" or "${PROBE_MODE.COLD_START}".`,
    };
  }
  if (!out.email && !out.userId) {
    return { ok: false, error: "Provide one of --email <email> or --user-id <uuid>." };
  }
  if (out.email && out.userId) {
    return { ok: false, error: "Provide only one of --email or --user-id, not both." };
  }
  if (!Number.isFinite(out.runs) || out.runs < 1 || !Number.isInteger(out.runs)) {
    return { ok: false, error: "--runs must be a positive integer." };
  }
  if (!Number.isFinite(out.cooldownMs) || out.cooldownMs < 0) {
    return { ok: false, error: "--cooldown-ms must be a non-negative number." };
  }
  if (!out.baseUrl || typeof out.baseUrl !== "string") {
    return { ok: false, error: "--base-url must be a non-empty string." };
  }
  return out;
}

export function usage() {
  return `Usage:
  npm run cluster:probe -- --email <email>
  npm run cluster:probe -- --user-id <uuid>

Options:
  --email <email>        Resolve user via Supabase admin (requires SUPABASE_URL + SERVICE_ROLE_KEY)
  --user-id <uuid>       Probe a known user id directly (server must accept x-user-id)
  --runs <n>             Number of refreshes (default ${GATE.defaultRuns})
  --cooldown-ms <ms>     Pause between runs (default ${GATE.defaultCooldownMs})
  --base-url <url>       API base url (default ${GATE.defaultBaseUrl})
  --mode <mode>          "${PROBE_MODE.DEFAULT}" (latency over all runs) or "${PROBE_MODE.COLD_START}"
                         (requests ?profile=cold_start; latency p95 over recompute
                         runs only; default ${PROBE_MODE.DEFAULT})
  --require-recompute    Keep sampling until <runs> recompute runs are collected
                         (capped at <runs>×${RECOMPUTE_ATTEMPT_MULTIPLIER} attempts) so p95 isn't skip-diluted.
                         STRICT: if the target is NOT met the probe exits non-zero
                         (sample-quality fail) — the cold-start p95 is untrustworthy.
                         The probe cannot force a server recompute on its own (the
                         watermark is content-driven); to actually collect recompute
                         runs, reset the test user's dashboard snapshot between runs
                         (so the watermark changes) or use a freshly-onboarded user.

Gate: successRate >= ${GATE.minSuccessRate} AND medianStories >= ${GATE.minMedianStories}. Exit non-zero on fail.
Gate thresholds span all runs regardless of --mode / --require-recompute.
--require-recompute adds an independent sample-quality gate (also exits non-zero).`;
}

// ─── math helpers (pure) ─────────────────────────────────────────────────────

/** Median of a numeric array. Returns 0 for an empty array. */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Nearest-rank percentile (p in [0,1]). Returns 0 for an empty array.
 * p95 of [x] === x; matches operator intuition for small N.
 */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/** Count occurrences keyed by the given selector; null/undefined keys are skipped. */
export function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    if (key === null || key === undefined) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ─── summary + gate (pure) ───────────────────────────────────────────────────

/**
 * Build the summary object from collected per-run records.
 * A run record: { stories:number, usedFallbackClustering:boolean,
 *   clusteringFailureReason:string|null, refreshSkippedReason:string|null,
 *   pipelineMs:number|null }
 *
 * `opts.latencyScope` (Step 4.1):
 *   - LATENCY_SCOPE.ALL (default) — p95PipelineMs spans every run's numeric
 *     pipelineMs. Backward-compatible: identical to the pre-Step-4.1 summary.
 *   - LATENCY_SCOPE.RECOMPUTE — p95PipelineMs spans only recompute runs (no
 *     `refreshSkippedReason`), so watermark-skip runs don't dilute the
 *     cold-start latency tail.
 *
 * `runs`, `successRate`, and `medianStories` ALWAYS span all runs in both
 * scopes — gate semantics never change. The additive `recomputeRuns` /
 * `skippedRuns` / `latencyScope` / `latencyRunsCounted` fields make the scope
 * explicit and auditable.
 */
export function summarize(records, opts = {}) {
  const latencyScope = opts.latencyScope ?? LATENCY_SCOPE.ALL;
  const runs = records.length;
  const successes = records.filter((r) => r.usedFallbackClustering === false).length;
  const storyCounts = records.map((r) => r.stories);
  const recomputeRecords = records.filter(isRecomputeRun);
  const recomputeRuns = recomputeRecords.length;
  const latencySource =
    latencyScope === LATENCY_SCOPE.RECOMPUTE ? recomputeRecords : records;
  const pipelineMsValues = latencySource
    .map((r) => r.pipelineMs)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  return {
    runs,
    successRate: runs ? successes / runs : 0,
    medianStories: median(storyCounts),
    p95PipelineMs: percentile(pipelineMsValues, 0.95),
    clusteringFailureReasons: countBy(records, (r) => r.clusteringFailureReason),
    refreshSkippedReasons: countBy(records, (r) => r.refreshSkippedReason),
    // Step 4.1: latency-scope transparency (additive).
    latencyScope,
    recomputeRuns,
    skippedRuns: runs - recomputeRuns,
    latencyRunsCounted: pipelineMsValues.length,
  };
}

/**
 * Decide pass/fail from a summary. Pure.
 * Pass requires successRate >= minSuccessRate AND medianStories >= minMedianStories.
 */
export function evaluateGate(summary, gate = GATE) {
  const reasons = [];
  if (summary.successRate < gate.minSuccessRate) {
    reasons.push(`successRate ${summary.successRate.toFixed(3)} < ${gate.minSuccessRate}`);
  }
  if (summary.medianStories < gate.minMedianStories) {
    reasons.push(`medianStories ${summary.medianStories} < ${gate.minMedianStories}`);
  }
  return { pass: reasons.length === 0, reasons };
}

// ─── live probe (entry-only) ─────────────────────────────────────────────────

async function findUserIdByEmail(admin, email) {
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const match = data.users.find((u) => u.email === email);
    if (match) return match.id;
    if (data.users.length < 1000) return null;
    page++;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform one live refresh and reduce its response to a run record.
 * Identity: prefer x-recognized-email (the prototype path the server supports);
 * fall back to x-user-id when only a userId is known.
 */
async function runOnce({ baseUrl, email, userId, profile = null }) {
  const headers = { "content-type": "application/json" };
  if (email) headers["x-recognized-email"] = email;
  else if (userId) headers["x-user-id"] = userId;

  // Step 4.1: cold-start validation must exercise the cold_start profile the
  // server gates behind `?profile=cold_start` (default/omitted → default
  // profile). Backward-compatible: when `profile` is null the URL is unchanged.
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/dashboard/refresh${query}`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave json null; recorded as a parse/HTTP failure below */
  }

  if (!res.ok || !json) {
    return {
      stories: 0,
      usedFallbackClustering: true, // treat non-200 / unparseable as a failed run
      clusteringFailureReason: `http_${res.status}`,
      clusteringAttempts: null,
      clusteringLatencyMs: null,
      pipelineMs: null,
      refreshSkippedReason: null,
      httpStatus: res.status,
    };
  }

  const meta = json._meta ?? {};
  return {
    stories: Array.isArray(json.stories) ? json.stories.length : 0,
    usedFallbackClustering: meta.usedFallbackClustering === true,
    clusteringFailureReason: meta.clusteringFailureReason ?? null,
    clusteringAttempts: meta.clusteringAttempts ?? null,
    clusteringLatencyMs: meta.clusteringLatencyMs ?? null,
    pipelineMs: meta.timings?.pipelineMs ?? null,
    refreshSkippedReason: meta.refreshSkippedReason ?? null,
    httpStatus: res.status,
  };
}

/**
 * Preflight a single refresh to confirm the chosen identity mode is accepted
 * before committing to N runs. Used for the --user-id-only path, where the
 * server may not honor the x-user-id header (it could 401/403 every run).
 * Returns { ok: true } on a 2xx, or { ok: false, status } on an auth-style
 * (or any non-200) failure. Reuses runOnce() so request logic stays in one place.
 */
async function preflightIdentityMode({ baseUrl, email, userId }) {
  const rec = await runOnce({ baseUrl, email, userId });
  if (rec.httpStatus >= 200 && rec.httpStatus < 300) return { ok: true };
  return { ok: false, status: rec.httpStatus };
}

function formatRunLine(i, total, rec) {
  const ok = rec.usedFallbackClustering ? "FALLBACK" : "ok";
  const lat = Array.isArray(rec.clusteringLatencyMs)
    ? `[${rec.clusteringLatencyMs.join(",")}]`
    : rec.clusteringLatencyMs ?? "-";
  return [
    `run ${String(i).padStart(2)}/${total}`,
    `status=${rec.httpStatus}`,
    `result=${ok}`,
    `stories=${rec.stories}`,
    `attempts=${rec.clusteringAttempts ?? "-"}`,
    `clusterLatencyMs=${lat}`,
    `pipelineMs=${rec.pipelineMs ?? "-"}`,
    rec.clusteringFailureReason ? `failReason=${rec.clusteringFailureReason}` : null,
    rec.refreshSkippedReason ? `skipped=${rec.refreshSkippedReason}` : null,
  ]
    .filter(Boolean)
    .join("  ");
}

async function main() {
  dotenv.config({ path: path.join(PACKAGE_ROOT, ".env") });

  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`[probe] ${args.error}\n`);
    console.error(usage());
    process.exit(1);
  }

  const email = args.email ? args.email.trim().toLowerCase() : null;
  let userId = args.userId;

  // Resolve email → userId for clarity/logging when Supabase admin is available.
  // The refresh itself still uses the x-recognized-email path the server supports.
  if (email) {
    const useSupabase = !!(
      process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    if (useSupabase) {
      const admin = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );
      const resolved = await findUserIdByEmail(admin, email);
      if (!resolved) {
        console.error(`[probe] No Supabase user for email: ${email}`);
        process.exit(1);
      }
      userId = resolved;
    } else {
      console.warn(
        "[probe] SUPABASE_URL/SERVICE_ROLE_KEY not set — using x-recognized-email without id resolution."
      );
    }
  }

  console.log(
    `[probe] baseUrl=${args.baseUrl} identity=${email ? `email:${email}` : `user-id:${userId}`}` +
      `${userId && email ? ` (userId=${userId})` : ""} runs=${args.runs} cooldownMs=${args.cooldownMs} mode=${args.mode}`
  );
  console.log(
    `[probe] gate: successRate>=${GATE.minSuccessRate} medianStories>=${GATE.minMedianStories}`
  );

  // --user-id-only: confirm the server accepts the x-user-id path before
  // running N times, so an unsupported identity mode fails fast and clearly
  // instead of producing a wall of repeated http_401 lines.
  if (userId && !email) {
    let preflight;
    try {
      preflight = await preflightIdentityMode({ baseUrl: args.baseUrl, userId });
    } catch (err) {
      console.error(
        `[probe] preflight request failed: ${err instanceof Error ? err.message : err}`
      );
      console.error(`[probe] Is the API server running at ${args.baseUrl}?`);
      process.exit(1);
    }
    if (!preflight.ok) {
      console.error(
        `[probe] preflight returned status=${preflight.status}. ` +
          "`--user-id` mode is not accepted by this server path. " +
          "Use `--email <invited-email>` so probe uses `x-recognized-email`."
      );
      process.exit(1);
    }
  }

  // Cold-start mode drives the server's cold_start profile; recompute-enforced
  // sampling keeps going until enough recompute runs are collected (bounded).
  const profile = args.mode === PROBE_MODE.COLD_START ? "cold_start" : null;
  const plan = resolveSamplingPlan({ runs: args.runs, requireRecompute: args.requireRecompute });

  const records = [];
  let attempts = 0;
  let recomputeRuns = 0;
  while (!shouldStopSampling({ attempts, recomputeRuns, plan })) {
    attempts++;
    let rec;
    try {
      rec = await runOnce({ baseUrl: args.baseUrl, email, userId, profile });
    } catch (err) {
      rec = {
        stories: 0,
        usedFallbackClustering: true,
        clusteringFailureReason: "probe_request_error",
        clusteringAttempts: null,
        clusteringLatencyMs: null,
        pipelineMs: null,
        refreshSkippedReason: null,
        httpStatus: 0,
      };
      console.error(`[probe] run ${attempts} request error: ${err instanceof Error ? err.message : err}`);
    }
    records.push(rec);
    if (isRecomputeRun(rec)) recomputeRuns++;
    console.log(formatRunLine(attempts, plan.maxAttempts, rec));
    if (!shouldStopSampling({ attempts, recomputeRuns, plan }) && args.cooldownMs > 0) {
      await sleep(args.cooldownMs);
    }
  }

  const latencyScope =
    args.mode === PROBE_MODE.COLD_START ? LATENCY_SCOPE.RECOMPUTE : LATENCY_SCOPE.ALL;
  const targetMet = recomputeTargetMet({ plan, recomputeRuns });
  const summary = {
    ...summarize(records, { latencyScope }),
    // Step 4.1 / Prompt 2b: recompute-enforcement transparency (additive).
    requireRecompute: plan.requireRecompute,
    recomputeTarget: plan.targetRecomputeRuns,
    recomputeTargetMet: targetMet,
    attempts,
  };
  const gate = evaluateGate(summary);
  const decision = evaluateProbeDecision({ gate, plan, recomputeRuns });

  console.log("\n[probe] summary:");
  console.log(JSON.stringify(summary, null, 2));

  if (decision.pass) {
    console.log("\n[probe] GATE PASS ✅");
    process.exit(0);
  }
  // Distinguish the two failure causes so the operator knows whether to act on
  // reliability (successRate/medianStories) or on sample quality (recompute).
  if (!decision.sampleQualityOk) {
    console.error(
      `\n[probe] SAMPLE-QUALITY FAIL ❌ — collected ${recomputeRuns}/${plan.targetRecomputeRuns} ` +
        `recompute run(s) in ${attempts} attempt(s) (cap ${plan.maxAttempts}).\n` +
        `[probe] The cold-start p95 is based on too few recompute runs to trust for the hard gate.\n` +
        `[probe] Fix: force fresh recompute candidates between runs — reset the test user's dashboard\n` +
        `[probe] snapshot (so the watermark changes) or use a freshly-onboarded user, then re-run.`
    );
    if (!decision.gatePass) {
      console.error(`[probe] (reliability gate also failed: ${gate.reasons.join("; ")})`);
    }
    process.exit(decision.exitCode); // non-zero
  }
  console.log(`\n[probe] GATE FAIL ❌ — ${decision.reasons.join("; ")}`);
  process.exit(decision.exitCode); // non-zero
}

if (isEntryPoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
