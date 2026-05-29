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
import { getSupabaseClient } from "../db/client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// `src/ops` → `apps/api` is two levels up; mirrors server.mjs's DATA_DIR
// derivation (which resolves from `src`, one level up) so both resolve to
// `apps/api/data` by default.
const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DATA_DIR = process.env.TEMPO_DATA_DIR ?? path.join(ROOT, "data");

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
      const message = err instanceof Error ? err.message : String(err);
      emit({ startedAt, ok: false, skippedReason: "supabase_client_failed", error: message });
      return { exitCode: 1, summary: null, reason: "supabase_client_failed" };
    }
  }

  // Full-manifest warm: NO feedIds — fetch every active feed.
  let rawItems;
  try {
    rawItems = await readFeedItemsFn(dataDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      startedAt,
      ok: false,
      skippedReason: "read_threw",
      error: message,
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
    const message = err instanceof Error ? err.message : String(err);
    emit({
      startedAt,
      ok: false,
      skippedReason: "write_threw",
      error: message,
      itemCount,
      feedCount,
      durationMs: Date.now() - startMs,
    });
    return { exitCode: 1, summary: null, reason: "write_threw" };
  }

  // writeRecentItems returns an error envelope rather than throwing on a
  // supabase failure — treat a non-null `error` as fatal so cron retries.
  if (writeResult?.error) {
    const message =
      writeResult.error instanceof Error ? writeResult.error.message : String(writeResult.error);
    const written = writeResult.written ?? 0;
    emit({
      startedAt,
      ok: false,
      skippedReason: "write_error",
      error: message,
      itemCount,
      feedCount,
      written,
      durationMs: Date.now() - startMs,
    });
    return { exitCode: 1, summary: { itemCount, feedCount, written }, reason: "write_error" };
  }

  const written = writeResult?.written ?? 0;
  const durationMs = Date.now() - startMs;
  emit({ startedAt, ok: true, itemCount, feedCount, written, durationMs });
  return { exitCode: 0, summary: { itemCount, feedCount, written, durationMs }, reason: null };
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ingestion-warm] Fatal (uncaught): ${message}`);
      process.exit(1);
    });
}
