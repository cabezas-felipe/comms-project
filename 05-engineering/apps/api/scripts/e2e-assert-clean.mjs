#!/usr/bin/env node
// Asserts a user's baseline is CLEAN (zero-footprint) before an E2E run.
//
// On a dirty baseline it now prints an actionable, table-by-table breakdown —
// which table leaked, how many rows, and up to 3 redacted sample rows with
// recency hints (newest first) — so the operator can see *what leaked, where,
// and how recently* without dumping large JSONB payload columns.
//
// Importing this module (e.g. from the test file) must NOT connect to anything:
// the entry-point guard keeps dotenv / Supabase out of the import path. The
// exported helpers below (parseArgs / redactSample / summarize / formatReport /
// usage) are pure and unit-tested in e2e-assert-clean.test.mjs.

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Only the script entry path triggers dotenv + Supabase. Importing this module
// (from the test file) must not read .env or touch the network.
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// ─── table specs ─────────────────────────────────────────────────────────────
// `select` is an explicit small-column whitelist so large JSONB payload columns
// (payload / items / data / debug_payload / raw_text) never cross the wire.
// `orderBy` is the table's timestamp column → samples come back newest-first
// (the recency hint). `filter` is how the user is matched.

/** The six baseline tables that must be empty for a clean first-time user. */
export const BASE_TABLES = Object.freeze([
  {
    table: "dashboard_snapshots",
    filter: "user_id",
    select: ["user_id", "refreshed_at"],
    orderBy: "refreshed_at",
  },
  {
    table: "meta_story_locks",
    filter: "user_id",
    select: ["user_id", "meta_story_id", "created_at"],
    orderBy: "created_at",
  },
  {
    table: "story_rejections",
    filter: "user_id",
    select: ["id", "user_id", "meta_story_id", "reason_code", "created_at"],
    orderBy: "created_at",
  },
  {
    table: "geo_hold_bucket",
    filter: "user_id",
    select: ["user_id", "updated_at"],
    orderBy: "updated_at",
  },
  {
    table: "user_onboarding_narratives",
    filter: "user_id",
    select: ["id", "user_id", "is_current", "submitted_at"],
    orderBy: "submitted_at",
  },
  {
    table: "settings",
    filter: "key_like", // settings is keyed `user:<userId>`, not a user_id column
    select: ["key", "contract_version", "updated_at"],
    orderBy: "updated_at",
  },
]);

/**
 * Supabase auth (GoTrue) session state — only checked under --require-no-sessions.
 * Lives in the `auth` schema; readable with the service-role key.
 */
export const SESSION_TABLE = Object.freeze({
  table: "sessions",
  schema: "auth",
  label: "auth.sessions",
  filter: "user_id",
  select: ["id", "user_id", "created_at", "updated_at", "not_after"],
  orderBy: "updated_at",
});

const MAX_SAMPLES = 3;
const MAX_STR = 120; // truncate long string fields in samples

// ─── pure helpers ────────────────────────────────────────────────────────────

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? "")
  );
}

export function formatSupabaseError(prefix, error, status, statusText) {
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : null;
  const extras = [];
  if (error?.code) extras.push(`code=${error.code}`);
  if (error?.details) extras.push(`details=${error.details}`);
  if (error?.hint) extras.push(`hint=${error.hint}`);
  if (Number.isFinite(status)) {
    extras.push(`status=${status}${statusText ? ` ${statusText}` : ""}`);
  }
  const suffix = extras.length ? ` (${extras.join("; ")})` : "";
  return `${prefix}: ${message ?? "no error message returned"}${suffix}`;
}

export function usage() {
  return `Usage:
  npm run e2e:assert-clean --workspace=@tempo/api -- --user-id <uuid> [--require-no-sessions]

Asserts the user's baseline is clean (zero rows) before an E2E run. This is a
PRE-RUN check only — after onboarding writes rows it is expected to fail.

Options:
  --user-id <uuid>        User to assert clean (required)
  --require-no-sessions   Also assert zero Supabase auth sessions (auth.sessions)
                          for the user; a live session fails the baseline.

Exit code: 0 = clean baseline, 1 = dirty baseline / query error / bad args.`;
}

export function parseArgs(argv) {
  const out = { ok: true, userId: null, requireNoSessions: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-id") out.userId = argv[++i];
    else if (a === "--require-no-sessions") out.requireNoSessions = true;
    else return { ok: false, error: `Unknown argument: ${a}` };
  }
  if (!out.userId) return { ok: false, error: "Missing required argument: --user-id <uuid>" };
  if (!isUuid(out.userId)) {
    return {
      ok: false,
      error: `Invalid --user-id '${out.userId}'. Expected a real UUID (do not pass placeholders like <e06-user-id>).`,
    };
  }
  return out;
}

/**
 * Defensive redaction for a sample row: drop object/array (JSONB) values and
 * truncate long strings, so output stays compact even if a `select` whitelist
 * later picks up a large column. Whitelisted selects mean this is usually a
 * no-op, but it guarantees we never dump a full payload.
 */
export function redactSample(row) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (v === null || v === undefined) out[k] = v;
    else if (typeof v === "object") out[k] = "[omitted]";
    else if (typeof v === "string" && v.length > MAX_STR) out[k] = `${v.slice(0, MAX_STR)}…`;
    else out[k] = v;
  }
  return out;
}

/**
 * Reduce probe results to a pass/fail verdict.
 * - dirty  = table returned a non-zero row count
 * - errored = a count/sample query failed (treated as a failure: we can't prove clean)
 * pass = no dirty tables AND no errored queries.
 */
export function summarize(results) {
  const dirty = results.filter((r) => (r.count ?? 0) > 0);
  const errored = results.filter((r) => r.error != null);
  return { pass: dirty.length === 0 && errored.length === 0, dirty, errored };
}

/** Render a deterministic, operator-readable report. Returns a multi-line string. */
export function formatReport({ userId, results }) {
  const { pass, dirty, errored } = summarize(results);
  if (pass) {
    return `[e2e:assert-clean] PASS user_id=${userId} — baseline clean (${results.length} table(s) checked)`;
  }
  const lines = [`[e2e:assert-clean] FAIL user_id=${userId} — baseline is dirty`];
  for (const r of results) {
    if (r.error != null) {
      lines.push(`  ${r.table}: QUERY ERROR — ${r.error}`);
      continue;
    }
    if ((r.count ?? 0) === 0) continue;
    lines.push(`  ${r.table}: ${r.count} row(s)`);
    for (const s of r.samples) lines.push(`    - ${JSON.stringify(s)}`);
    if (r.count > r.samples.length) {
      lines.push(`    … +${r.count - r.samples.length} more (showing first ${r.samples.length})`);
    }
  }
  lines.push(
    `  dirty_tables=[${dirty.map((r) => r.table).join(",")}]` +
      (errored.length ? ` errored_tables=[${errored.map((r) => r.table).join(",")}]` : "")
  );
  return lines.join("\n");
}

// ─── Supabase probing (entry-point only) ─────────────────────────────────────

function fromTable(supabase, spec) {
  const root = spec.schema ? supabase.schema(spec.schema) : supabase;
  return root.from(spec.table);
}

function applyFilter(query, spec, userId) {
  return spec.filter === "key_like"
    ? query.like("key", `%${userId}%`)
    : query.eq("user_id", userId);
}

/**
 * Count rows for a table, and if non-zero, fetch up to MAX_SAMPLES redacted
 * sample rows (newest first). Returns { table, count, samples, error } — never
 * throws, so one failing table is reported without aborting the whole sweep.
 */
async function probeTable(supabase, spec, userId) {
  const label = spec.label ?? spec.table;
  const result = { table: label, count: null, samples: [], error: null };

  const { count, error: countErr, status: countStatus, statusText: countStatusText } = await applyFilter(
    fromTable(supabase, spec).select("*", { count: "exact", head: true }),
    spec,
    userId
  );
  if (countErr) {
    result.error = formatSupabaseError("count failed", countErr, countStatus, countStatusText);
    return result;
  }
  result.count = count ?? 0;
  if (result.count === 0) return result;

  let sampleQuery = applyFilter(fromTable(supabase, spec).select(spec.select.join(",")), spec, userId);
  if (spec.orderBy) sampleQuery = sampleQuery.order(spec.orderBy, { ascending: false });
  const { data, error: sampleErr, status: sampleStatus, statusText: sampleStatusText } =
    await sampleQuery.limit(MAX_SAMPLES);
  if (sampleErr) {
    result.error = formatSupabaseError("sample failed", sampleErr, sampleStatus, sampleStatusText);
    return result;
  }
  result.samples = (data ?? []).map(redactSample);
  return result;
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[e2e:assert-clean] ${parsed.error}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const { getSupabaseClient, isSupabaseEnabled } = await import("../src/db/client.mjs");
  if (!isSupabaseEnabled()) {
    throw new Error(
      "Supabase is not enabled. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY before running e2e assert-clean."
    );
  }
  const supabase = getSupabaseClient();
  const specs = parsed.requireNoSessions ? [...BASE_TABLES, SESSION_TABLE] : BASE_TABLES;

  const results = [];
  for (const spec of specs) results.push(await probeTable(supabase, spec, parsed.userId));

  const report = formatReport({ userId: parsed.userId, results });
  const { pass } = summarize(results);
  if (pass) {
    console.log(report);
  } else {
    console.error(report);
    process.exitCode = 1;
  }
}

if (isEntryPoint) {
  // dotenv only on the real entry path — never on import.
  dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });
  run().catch((err) => {
    console.error(`[e2e:assert-clean] ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
