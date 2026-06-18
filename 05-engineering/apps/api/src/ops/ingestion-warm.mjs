// Phase 1 Slice 3: ingestion cache warmer.
//
// Internal-only ops script — no HTTP surface.  Invoked by a scheduled GitHub
// Action (or manually via `node apps/api/src/ops/ingestion-warm.mjs`) to keep
// the `ingestion_recent_items` Tier-A cache warm so interactive refreshes hit
// the cache instead of paying the live-fetch latency.
//
// Wiring:
//   - Fetches the FULL active manifest via `readFeedItems(dataDir)` with NO
//     feedIds scoping — the warmer's whole job is to populate the cache for
//     every active feed, not for one user's selection.  (Per-user scoping is
//     the cache-miss path in server.mjs; this is the opposite case.)
//   - Upserts the mapped raw items via `writeRecentItems` from
//     recent-items-cache.mjs.
//   - Imports those two helpers directly; deliberately does NOT import
//     server.mjs so the warmer never boots the HTTP app.
//
// Logs:
//   - Emits one JSON line tagged `[ingestion-warm]` summarizing the run, so
//     `grep '\[ingestion-warm\]'` in the Action log surfaces the summary
//     fields without scrolling.
//
// Exit codes:
//   - 0  — fetch + write succeeded (a clean write of zero items is still a
//          success: an empty manifest is not a failure).
//   - 1  — fatal: required env missing, the live read threw, the supabase
//          client could not be constructed, or the write threw / returned an
//          error envelope.  These are the only cases where re-running sooner
//          makes sense.

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readFeedItems } from "../ingestion/feed-reader.mjs";
import { writeRecentItems } from "../ingestion/recent-items-cache.mjs";
import { readXItems } from "../ingestion/x-reader.mjs";
import { resolveXConfig, parseAllowlist } from "../ingestion/x-api-client.mjs";
import { getSupabaseClient } from "../db/client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// `src/ops` → `apps/api` is two levels up; mirrors server.mjs's DATA_DIR
// derivation (which resolves from `src`, one level up) so both resolve to
// `apps/api/data` by default.
const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DATA_DIR = process.env.TEMPO_DATA_DIR ?? path.join(ROOT, "data");

// Fields a PostgREST / Supabase error carries.  We surface all of them (when
// present) so a warmer failure is actionable from the log alone: `code` pins
// the Postgres/PostgREST class (e.g. 42501 permission denied, 42P01 undefined
// table, PGRST204 schema-cache miss), while `details`/`hint` carry the
// server-side specifics.  `status`/`statusCode` cover transport-level failures.
const ERROR_DETAIL_FIELDS = ["message", "code", "details", "hint", "status", "statusCode"];

/**
 * Normalize an unknown error value into a concise, log-safe string.
 *
 * The cache write path (`writeRecentItems`) returns the raw supabase error
 * object — a plain `{ message, code, details, hint }`, NOT an `Error`.  The
 * old `String(err)` rendered that as the useless `"[object Object]"`, which is
 * exactly what made the scheduled warmer failures non-actionable.  This helper:
 *   - string            → itself
 *   - Error             → `message` (plus any supabase-style fields it carries)
 *   - supabase/PostgREST → compact JSON of message/code/details/hint/status
 *   - anything else     → best-effort JSON, else a labelled fallback
 * It never returns `"[object Object]"`.
 *
 * @param {unknown} err
 * @returns {string|undefined} undefined only when `err` is null/undefined.
 */
export function normalizeErrorDetail(err) {
  if (err === null || err === undefined) return undefined;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const compact = {};
    for (const field of ERROR_DETAIL_FIELDS) {
      const value = err[field];
      if (value !== undefined && value !== null && value !== "") compact[field] = value;
    }
    if (Object.keys(compact).length > 0) return JSON.stringify(compact);
    if (err instanceof Error && err.message) return err.message;
    // No recognized fields — best-effort serialize the enumerable own props
    // rather than fall back to the opaque "[object Object]".
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json;
    } catch {
      /* circular / non-serializable — fall through to the labelled fallback */
    }
    return `unserializable error (${err?.constructor?.name ?? "object"})`;
  }
  return String(err);
}

/**
 * Count the distinct, non-empty `feedId` values across a batch of raw items.
 * Reported as `feedCount` in the summary so operators can see how many feeds
 * the warm actually drew from (vs. how many items it produced).
 */
function countDistinctFeeds(items) {
  const ids = new Set();
  for (const it of items ?? []) {
    const id = typeof it?.feedId === "string" ? it.feedId : "";
    if (id.length > 0) ids.add(id);
  }
  return ids.size;
}

/**
 * Run one ingestion-cache warm and emit a structured summary log.
 *
 * Exposed for unit tests so the entrypoint contract (log shape + return-code
 * semantics) can be asserted without a real process, a real RSS endpoint, or
 * Supabase.  Tests inject `readFeedItemsFn`, `writeRecentItemsFn`, `supabase`,
 * `logger`, and `envGet`; production reads defaults that point at the real
 * helpers.
 *
 * @param {object} [args]
 * @param {(dataDir: string) => Promise<Array>} [args.readFeedItemsFn]
 * @param {(opts: { supabase: any, items: Array }) => Promise<{ written: number, error: any }>} [args.writeRecentItemsFn]
 * @param {any} [args.supabase]            — injected client; when absent the
 *   real client is built lazily AFTER the env check passes.
 * @param {string} [args.dataDir]
 * @param {(line: string) => void} [args.logger]
 * @param {(name: string) => string|undefined} [args.envGet] — abstracted so the
 *   env check stays testable without mutating real `process.env`.
 * @returns {Promise<{ exitCode: number, summary: object|null, reason: string|null }>}
 */
export async function runIngestionWarm({
  readFeedItemsFn = readFeedItems,
  writeRecentItemsFn = writeRecentItems,
  readXItemsFn = readXItems,
  resolveXConfigFn = () => resolveXConfig(process.env),
  supabase,
  dataDir = DEFAULT_DATA_DIR,
  logger = (line) => console.log(line),
  envGet = (name) => process.env[name],
} = {}) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const emit = (payload) => logger(`[ingestion-warm] ${JSON.stringify(payload)}`);

  // Env precondition — same posture as cadence-tick.mjs.  The warmer writes
  // with the service role, so a service-role key is required, not just any key.
  if (!envGet("SUPABASE_URL") || !envGet("SUPABASE_SERVICE_ROLE_KEY")) {
    const reason = "missing_supabase_env";
    emit({
      startedAt,
      ok: false,
      skippedReason: reason,
      message:
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to warm the ingestion cache.",
    });
    return { exitCode: 1, summary: null, reason };
  }

  // Resolve the client lazily only when not injected, mirroring cadence-tick's
  // lazy import — keeps the env-missing test path from constructing a client.
  let client = supabase;
  if (!client) {
    try {
      client = getSupabaseClient();
    } catch (err) {
      emit({
        startedAt,
        ok: false,
        skippedReason: "supabase_client_failed",
        error: normalizeErrorDetail(err),
      });
      return { exitCode: 1, summary: null, reason: "supabase_client_failed" };
    }
  }

  // Full-manifest warm: NO feedIds — fetch every active feed.
  let rawItems;
  try {
    rawItems = await readFeedItemsFn(dataDir);
  } catch (err) {
    emit({
      startedAt,
      ok: false,
      skippedReason: "read_threw",
      error: normalizeErrorDetail(err),
      durationMs: Date.now() - startMs,
    });
    return { exitCode: 1, summary: null, reason: "read_threw" };
  }

  const items = Array.isArray(rawItems) ? rawItems : [];
  const itemCount = items.length;
  const feedCount = countDistinctFeeds(items);

  let writeResult;
  try {
    writeResult = await writeRecentItemsFn({ supabase: client, items });
  } catch (err) {
    emit({
      startedAt,
      ok: false,
      skippedReason: "write_threw",
      error: normalizeErrorDetail(err),
      itemCount,
      feedCount,
      durationMs: Date.now() - startMs,
    });
    return { exitCode: 1, summary: null, reason: "write_threw" };
  }

  // writeRecentItems returns an error envelope rather than throwing on a
  // supabase failure — treat a non-null `error` as fatal so cron retries.
  if (writeResult?.error) {
    const written = writeResult.written ?? 0;
    emit({
      startedAt,
      ok: false,
      skippedReason: "write_error",
      error: normalizeErrorDetail(writeResult.error),
      itemCount,
      feedCount,
      written,
      durationMs: Date.now() - startMs,
    });
    return { exitCode: 1, summary: { itemCount, feedCount, written }, reason: "write_error" };
  }

  const written = writeResult?.written ?? 0;

  // ─── X (social) warm ────────────────────────────────────────────────────
  // After the RSS full-manifest warm, opportunistically warm a configured list
  // of X handles into the same Tier-A cache so interactive refreshes hit the
  // cache instead of paying the live X-API latency. Two gates, both required:
  //   1. The X feature is enabled (flag on AND bearer token present — encoded
  //      in resolveXConfig.enabled).
  //   2. TEMPO_X_WARM_HANDLES is a non-empty, comma-separated handle list
  //      (parsed with the same normalization as the allowlist). This is a pilot
  //      warm list, distinct from TEMPO_X_HANDLE_ALLOWLIST (which gates per-user
  //      fetch in the refresh path).
  // When either gate is off, X warm is skipped and the run stays an RSS-only
  // success (xEnabled / xHandlesWarmed reflect that).
  //
  // Exit-code posture mirrors the RSS write path: once X warm is ATTEMPTED
  // (enabled + handles present), a reader throw or a write failure is fatal
  // (exit 1) so cron retries; skipping X warm when unconfigured is success.
  const xConfig = resolveXConfigFn();
  const xEnabled = xConfig?.enabled === true;
  const warmHandles = parseAllowlist(envGet("TEMPO_X_WARM_HANDLES"));
  let xHandlesWarmed = 0;
  let xItemCount = 0;
  let xWritten = 0;

  if (xEnabled && warmHandles.length > 0) {
    let xItems;
    try {
      const result = await readXItemsFn({ socialSources: warmHandles, config: xConfig });
      xItems = Array.isArray(result?.items) ? result.items : [];
    } catch (err) {
      emit({
        startedAt,
        ok: false,
        skippedReason: "x_read_threw",
        error: normalizeErrorDetail(err),
        itemCount,
        feedCount,
        written,
        durationMs: Date.now() - startMs,
      });
      return { exitCode: 1, summary: null, reason: "x_read_threw" };
    }
    xHandlesWarmed = warmHandles.length;
    xItemCount = xItems.length;

    let xWriteResult;
    try {
      xWriteResult = await writeRecentItemsFn({ supabase: client, items: xItems });
    } catch (err) {
      emit({
        startedAt,
        ok: false,
        skippedReason: "x_write_threw",
        error: normalizeErrorDetail(err),
        itemCount,
        feedCount,
        written,
        xHandlesWarmed,
        xItemCount,
        durationMs: Date.now() - startMs,
      });
      return { exitCode: 1, summary: null, reason: "x_write_threw" };
    }
    // writeRecentItems returns an error envelope rather than throwing on a
    // supabase failure — treat a non-null `error` as fatal so cron retries.
    if (xWriteResult?.error) {
      emit({
        startedAt,
        ok: false,
        skippedReason: "x_write_error",
        error: normalizeErrorDetail(xWriteResult.error),
        itemCount,
        feedCount,
        written,
        xHandlesWarmed,
        xItemCount,
        xWritten: xWriteResult.written ?? 0,
        durationMs: Date.now() - startMs,
      });
      return { exitCode: 1, summary: { itemCount, feedCount, written, xHandlesWarmed, xItemCount }, reason: "x_write_error" };
    }
    xWritten = xWriteResult?.written ?? 0;
  }

  const durationMs = Date.now() - startMs;
  emit({ startedAt, ok: true, itemCount, feedCount, written, xEnabled, xHandlesWarmed, xItemCount, xWritten, durationMs });
  return {
    exitCode: 0,
    summary: { itemCount, feedCount, written, xEnabled, xHandlesWarmed, xItemCount, xWritten, durationMs },
    reason: null,
  };
}

// Direct-invocation guard mirrors cadence-tick: only call `process.exit` when
// this file is the entrypoint, so tests can `import` the module without
// triggering a process exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runIngestionWarm()
    .then(({ exitCode }) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      // Defensive net: runIngestionWarm is supposed to translate all internal
      // errors into the structured log + exit-code contract.  If it ever
      // rejects, log + exit 1 so cron has a fingerprint to grep on.
      console.error(`[ingestion-warm] Fatal (uncaught): ${normalizeErrorDetail(err)}`);
      process.exit(1);
    });
}
