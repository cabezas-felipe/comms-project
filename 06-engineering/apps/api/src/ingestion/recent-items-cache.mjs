// Tier-A ephemeral cache for recently-fetched, normalized ingestion items —
// both RSS feed items and X (social) handle items.
//
// Refresh writes upsert rows here at the end of each ingestion; the next
// refresh reads still-fresh rows from this table and falls back to a live
// fetch (feed-reader for RSS, x-reader for handles) when the cache is cold or
// expired (see the cache-first branches in `server.mjs`).
//
// Design notes:
//   - All public functions accept a supabase client as an argument so callers
//     (and tests) control the boundary; the module itself does not import
//     `getSupabaseClient` so it stays pure and trivially mockable.
//   - Failures must be non-fatal at the call site: cache write errors must
//     not block the user's refresh.  Functions return `{ error }` envelopes
//     and never throw on supabase errors; truly unexpected throws bubble up
//     for the caller to log.
//   - `DEFAULT_TTL_MS` is bound to the canonical `REFRESH_INTERVAL_MS` cadence
//     (`@tempo/contracts`, mirrored in `contracts-runtime/`).  Binding the TTL
//     to the same constant the client heartbeat and the server-side due-user
//     orchestrator (Sub-slice 2.4) consume prevents drift between cache expiry
//     and refresh cadence — a longer TTL would leave the orchestrator reading
//     a still-fresh cache row on schedules where the user expected new data,
//     while a shorter TTL would force redundant live fetches.

import { derivePublisherFromFeedName } from "./publisher-from-feed-name.mjs";
import { mapIngestionKindToContractKind } from "./source-kind.mjs";
import { REFRESH_INTERVAL_MS } from "../contracts-runtime/index.mjs";

const DEFAULT_TTL_MS = REFRESH_INTERVAL_MS;
const SNIPPET_MAX_LEN = 500;
const DEFAULT_WEIGHT = 50;
// Per-handle weight for reconstructed X (social) cache rows — mirrors the
// x-reader's DEFAULT_HANDLE_WEIGHT so a cache-hit social item scores the same
// as a live-fetched one.
const DEFAULT_X_HANDLE_WEIGHT = 60;

// A cache row keyed `x:{username}` is a social handle item (the x-reader sets
// `feedId: x:{username}`, lowercase). Handles never get manifest rows — social
// selection is a UNION by outlet handle, not a manifest match — so these rows
// must reconstruct as social directly from the feed id, NOT fall through to the
// RSS/manifest defaults (which would mislabel them traditional and drop them at
// source selection).
const X_FEED_ID_RE = /^x:([a-z0-9_]+)$/;

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

/**
 * Read recently-cached items for the user's selected feeds (Sub-slice 2.3).
 *
 * Returns rows whose `expires_at` is strictly greater than `now`.  The
 * `feed_id IN (…)` filter scopes the lookup to the user's matched feeds so
 * we don't drag in rows for publishers the user hasn't selected — keeps the
 * payload small and avoids surprises if the cache holds historical feeds.
 *
 * Returns `{ rows, error }`:
 *   - `rows`  — array of cache rows (empty on error or no match).
 *   - `error` — null on success, the supabase error on failure.
 *
 * Like the write path, callers should treat read errors as soft-fail and
 * fall back to a live fetch rather than propagate to the user.
 */
export async function readRecentItems({ supabase, feedIds, now = Date.now() }) {
  if (!Array.isArray(feedIds) || feedIds.length === 0) {
    return { rows: [], error: null };
  }
  const cutoff = new Date(now).toISOString();
  const { data, error } = await supabase
    .from(RECENT_ITEMS_TABLE)
    .select("source_id, feed_id, url, headline, snippet, published_at, fetched_at, expires_at")
    .in("feed_id", feedIds)
    .gt("expires_at", cutoff);
  return { rows: error ? [] : (data ?? []), error: error ?? null };
}

/**
 * Convert cache rows back into the pipeline's raw-item shape (`mapEntry`
 * output).  Joins each row with its manifest entry to recover `outlet`,
 * `kind`, and `weight` — fields the cache schema deliberately omits because
 * they belong to the manifest, not the per-item record.
 *
 * `now` controls the `minutesAgo` clock so tests can pin the conversion.
 */
export function cacheRowsToRawItems(rows, manifestFeeds = [], { now = Date.now() } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const manifestById = new Map();
  for (const f of manifestFeeds ?? []) {
    if (f && typeof f.id === "string") manifestById.set(f.id, f);
  }

  const out = [];
  for (const row of rows) {
    if (!row || typeof row.source_id !== "string" || row.source_id.length === 0) continue;
    const manifest = manifestById.get(row.feed_id) ?? null;

    // Recency clock: prefer published_at (matches feed-reader's mapEntry which
    // derives minutesAgo from the RSS pubDate); fall back to fetched_at when
    // the upstream feed omits pubDate.  Either way, minutesAgo never goes
    // negative even if the row clock is ahead of `now`.
    const publishedMs = row.published_at ? Date.parse(row.published_at) : NaN;
    const fetchedMs = row.fetched_at ? Date.parse(row.fetched_at) : NaN;
    const baseMs = Number.isFinite(publishedMs)
      ? publishedMs
      : (Number.isFinite(fetchedMs) ? fetchedMs : NaN);
    const minutesAgo = Number.isFinite(baseMs)
      ? Math.max(0, Math.floor((now - baseMs) / 60_000))
      : 0;

    // X-aware reconstruction: a row keyed `x:{username}` with no manifest entry
    // rebuilds as a social item (outlet `@username`, kind "social", X handle
    // weight) so source-selection's handle union admits it. Manifest-backed
    // (RSS) rows keep the existing derivation verbatim — the `xMatch` guard only
    // fires when there is genuinely no manifest match, so RSS behavior is
    // unchanged.
    const xMatch = manifest ? null : X_FEED_ID_RE.exec(typeof row.feed_id === "string" ? row.feed_id : "");

    // Outlet derivation mirrors mapEntry: manifest publisher wins, else strip
    // the section suffix off the feed name, else fall through to the name. For X
    // rows the canonical `@username` handle is the outlet identity.
    const publisher = typeof manifest?.publisher === "string" && manifest.publisher.length > 0
      ? manifest.publisher
      : null;
    const derived = derivePublisherFromFeedName(typeof manifest?.name === "string" ? manifest.name : "");
    const outlet = xMatch
      ? `@${xMatch[1]}`
      : (publisher ?? derived ?? (typeof manifest?.name === "string" ? manifest.name : "") ?? "");

    const item = {
      sourceId: row.source_id,
      feedId: row.feed_id,
      url: typeof row.url === "string" ? row.url : "",
      headline: typeof row.headline === "string" ? row.headline : "",
      body: typeof row.snippet === "string" && row.snippet.length > 0 ? [row.snippet] : [],
      minutesAgo,
      outlet,
      // X rows are social by construction; otherwise map the manifest's
      // INGESTION kind (`"rss"`) to the contract kind (`"traditional"`). A
      // missing/unknown manifest kind also resolves to the safe default so
      // cache-origin items never carry a schema-invalid kind.
      kind: xMatch ? "social" : mapIngestionKindToContractKind(manifest?.kind),
      weight: xMatch
        ? DEFAULT_X_HANDLE_WEIGHT
        : (typeof manifest?.weight === "number" ? manifest.weight : DEFAULT_WEIGHT),
    };
    // Carry the manifest language tag through so cache-hit refreshes keep the
    // non-English signal that drives TEMPO_TRANSLATION_MODE=auto (mirrors
    // mapEntry). Only set when present — never fabricate a language.
    if (typeof manifest?.lang === "string" && manifest.lang.trim().length > 0) {
      item.lang = manifest.lang.trim();
    }
    out.push(item);
  }
  return out;
}

export const RECENT_ITEMS_CACHE_TABLE = RECENT_ITEMS_TABLE;
