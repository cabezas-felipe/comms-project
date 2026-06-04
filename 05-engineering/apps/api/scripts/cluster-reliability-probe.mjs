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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") out.email = argv[++i];
    else if (a === "--user-id") out.userId = argv[++i];
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--cooldown-ms") out.cooldownMs = Number(argv[++i]);
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else return { ok: false, error: `Unknown argument: ${a}` };
  }
  if (!out.email && !out.userId) {
    return { ok: false, error: "Provide one of --email <email> or --user-id <uuid>." };
  }
  if (out.email && out.userId) {
    return { ok: false, error: "Provide only one of --email or --user-id, not both." };
  }
  if (!Number.isFinite(out.runs) || out.runs < 1) {
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

Gate: successRate >= ${GATE.minSuccessRate} AND medianStories >= ${GATE.minMedianStories}. Exit non-zero on fail.`;
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
 */
export function summarize(records) {
  const runs = records.length;
  const successes = records.filter((r) => r.usedFallbackClustering === false).length;
  const storyCounts = records.map((r) => r.stories);
  const pipelineMsValues = records
    .map((r) => r.pipelineMs)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  return {
    runs,
    successRate: runs ? successes / runs : 0,
    medianStories: median(storyCounts),
    p95PipelineMs: percentile(pipelineMsValues, 0.95),
    clusteringFailureReasons: countBy(records, (r) => r.clusteringFailureReason),
    refreshSkippedReasons: countBy(records, (r) => r.refreshSkippedReason),
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
async function runOnce({ baseUrl, email, userId }) {
  const headers = { "content-type": "application/json" };
  if (email) headers["x-recognized-email"] = email;
  else if (userId) headers["x-user-id"] = userId;

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/dashboard/refresh`, {
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
      `${userId && email ? ` (userId=${userId})` : ""} runs=${args.runs} cooldownMs=${args.cooldownMs}`
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

  const records = [];
  for (let i = 1; i <= args.runs; i++) {
    let rec;
    try {
      rec = await runOnce({ baseUrl: args.baseUrl, email, userId });
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
      console.error(`[probe] run ${i} request error: ${err instanceof Error ? err.message : err}`);
    }
    records.push(rec);
    console.log(formatRunLine(i, args.runs, rec));
    if (i < args.runs && args.cooldownMs > 0) await sleep(args.cooldownMs);
  }

  const summary = summarize(records);
  const gate = evaluateGate(summary);

  console.log("\n[probe] summary:");
  console.log(JSON.stringify(summary, null, 2));

  if (gate.pass) {
    console.log("\n[probe] GATE PASS ✅");
    process.exit(0);
  } else {
    console.log(`\n[probe] GATE FAIL ❌ — ${gate.reasons.join("; ")}`);
    process.exit(1);
  }
}

if (isEntryPoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
