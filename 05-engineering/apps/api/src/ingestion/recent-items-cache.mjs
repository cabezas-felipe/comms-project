// Tier-A ephemeral cache for recently-fetched + normalized RSS items.
//
// Sub-slice 2.2 establishes the write path only.  The refresh read path keeps
// hitting the live feed-reader in this slice; Sub-slice 2.3 will wire the
// refresh pipeline to read from this table when an entry is still fresh.
//
// Design notes:
//   - All public functions accept a supabase client as an argument so callers
//     (and tests) control the boundary; the module itself does not import
//     `getSupabaseClient` so it stays pure and trivially mockable.
//   - Failures must be non-fatal at the call site: cache write errors must
//     not block the user's refresh.  Functions return `{ error }` envelopes
//     and never throw on supabase errors; truly unexpected throws bubble up
//     for the caller to log.
//   - `DEFAULT_TTL_MS` deliberately mirrors the dashboard refresh cadence
//     (1 hour, the canonical `REFRESH_INTERVAL_MS` in @tempo/contracts).  We
//     keep a local literal here rather than importing the TS package, matching
//     the existing `contracts-runtime/` pattern used elsewhere in the API.

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const SNIPPET_MAX_LEN = 500;

const RECENT_ITEMS_TABLE = "ingestion_recent_items";

/**
 * Project one mapped item (post `feed-reader.mapEntry`) into a row shape
 * matching the `ingestion_recent_items` schema.  Returns null when the item
 * lacks a non-empty `sourceId` (primary key would be invalid).
 */
function projectRow(item, fetchedAtMs, ttlMs) {
  const sourceId = typeof item?.sourceId === "string" ? item.sourceId.trim() : "";
  if (!sourceId) return null;

  const feedId = typeof item?.feedId === "string" ? item.feedId.trim() : "";
  const fetchedAtIso = new Date(fetchedAtMs).toISOString();
  const expiresAtIso = new Date(fetchedAtMs + ttlMs).toISOString();

  const minutesAgo = Number(item?.minutesAgo);
  const publishedAt = Number.isFinite(minutesAgo) && minutesAgo >= 0
    ? new Date(fetchedAtMs - minutesAgo * 60_000).toISOString()
    : null;

  const snippetSource = Array.isArray(item?.body) ? item.body[0] : null;
  const snippet = typeof snippetSource === "string" && snippetSource.length > 0
    ? snippetSource.slice(0, SNIPPET_MAX_LEN)
    : null;

  return {
    source_id: sourceId,
    feed_id: feedId,
    url: typeof item?.url === "string" ? item.url : null,
    headline: typeof item?.headline === "string" ? item.headline : null,
    snippet,
    published_at: publishedAt,
    fetched_at: fetchedAtIso,
    expires_at: expiresAtIso,
  };
}

/**
 * Build the cache rows for a batch of mapped items.  Exposed for tests so
 * the shape contract can be asserted without a supabase round-trip.
 */
export function buildRecentItemRows(items, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const row = projectRow(item, now, ttlMs);
    if (!row) continue;
    // Dedupe by source_id within the batch so upsert doesn't see a
    // `ON CONFLICT DO UPDATE row twice` error from Postgres.
    if (seen.has(row.source_id)) continue;
    seen.add(row.source_id);
    out.push(row);
  }
  return out;
}

/**
 * Upsert a batch of recently-fetched items into the Tier-A cache.
 *
 * Returns `{ written, error }`:
 *   - `written` — number of rows submitted to the upsert (0 when the batch
 *     is empty or supabase returned an error).
 *   - `error`   — null on success, the supabase error on failure.
 *
 * Callers should treat this as fire-and-forget — log on error, do not abort
 * the surrounding refresh.
 */
export async function writeRecentItems({ supabase, items, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const rows = buildRecentItemRows(items, { now, ttlMs });
  if (rows.length === 0) return { written: 0, error: null };
  const { error } = await supabase
    .from(RECENT_ITEMS_TABLE)
    .upsert(rows, { onConflict: "source_id" });
  return { written: error ? 0 : rows.length, error: error ?? null };
}

/**
 * Delete every cache row whose `expires_at` is at or before `now`.  Intended
 * for an out-of-band purge job; not called inline by the refresh path.
 *
 * Returns `{ purged, error }`.  `purged` reflects the affected-row count
 * supabase reports when `count: "exact"` is honored; falls back to 0 when
 * an error occurred.
 */
export async function purgeExpired({ supabase, now = Date.now() }) {
  const cutoff = new Date(now).toISOString();
  const { error, count } = await supabase
    .from(RECENT_ITEMS_TABLE)
    .delete({ count: "exact" })
    .lt("expires_at", cutoff);
  return { purged: error ? 0 : (count ?? 0), error: error ?? null };
}

export const RECENT_ITEMS_CACHE_TABLE = RECENT_ITEMS_TABLE;
