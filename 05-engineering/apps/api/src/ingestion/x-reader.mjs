// X (Twitter) reader: turns selected social handles into normalized raw
// ingestion items, mirroring how `feed-reader.mjs` turns RSS feeds into raw
// items. This is the second half of the X ingestion path (Phase 1, Step 1.2).
//
// SCOPE: reusable reader layer only — NOT wired into `server.mjs` or the refresh
// pipeline yet. All network I/O is delegated to the Step 1.1 client
// (`x-api-client.mjs`) and reaches the wire through an injectable `fetchImpl`,
// so tests stay hermetic. The bearer token never appears here — it lives in
// `config` and is only ever attached as an Authorization header by the client.
//
// Output items match the raw-item shape `normalizeSourceItem` consumes and the
// field conventions of feed-reader's `mapEntry` (narrative fields empty until
// clustering assigns them; `kind` distinguishes the source family).

import { createHash } from "node:crypto";
import { lookupUserByUsername, fetchUserTweets } from "./x-api-client.mjs";

const MS_PER_24H = 24 * 60 * 60 * 1000;
const DEFAULT_HANDLE_WEIGHT = 60;
// Defensive cap so a runaway `nextToken` chain (or a misbehaving mock) can never
// loop forever. The 24h boundary normally terminates pagination well before this.
const MAX_PAGES_PER_HANDLE = 25;
const UNTITLED = "(untitled)";

/**
 * Normalize a raw handle string to its canonical forms.
 *
 * @param {unknown} raw — e.g. "@PetroGustavo", " petrogustavo ", "PETROGUSTAVO".
 * @returns {{ username: string, handle: string } | null}
 *   `username` lowercased without `@`; `handle` the canonical `@username`.
 *   Returns null for nullish/blank/`@`-only input.
 */
export function normalizeHandle(raw) {
  if (raw == null) return null;
  const username = String(raw).trim().replace(/^@+/, "").trim().toLowerCase();
  if (!username) return null;
  return { username, handle: `@${username}` };
}

/**
 * ISO timestamp for `now - 24h`. Aligns the X timeline window with the
 * dashboard's 24h recency filter so social and RSS evidence share one horizon.
 *
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function computeStartTimeIso(nowMs = Date.now()) {
  return new Date(nowMs - MS_PER_24H).toISOString();
}

// Deterministic, collision-resistant source id from the tweet id + username.
// Stable across runs (no time/random input) so dedupe and recent-items caching
// see the same id for the same tweet.
function deriveSourceId(username, tweetId) {
  const digest = createHash("sha256").update(`x:${username}::${tweetId}`).digest("hex").slice(0, 16);
  return `x:${username}:${digest}`;
}

/**
 * Convert a raw X tweet payload into the raw ingestion-item shape.
 *
 * @param {object} args
 * @param {object} args.tweet — raw tweet object from the X API.
 * @param {string} args.handle — canonical `@username` (outlet identity).
 * @param {number} [args.weight=60]
 * @param {number} [args.fetchedAtMs=Date.now()]
 * @returns {object | null} raw item, or null when the tweet is unusable
 *   (no id and no text — nothing to dedupe or display).
 */
export function mapTweetToRawItem({ tweet, handle, weight = DEFAULT_HANDLE_WEIGHT, fetchedAtMs = Date.now() }) {
  if (!tweet || typeof tweet !== "object") return null;

  const tweetId = tweet.id != null ? String(tweet.id).trim() : "";
  const text = typeof tweet.text === "string" ? tweet.text.trim() : "";
  if (!tweetId && !text) return null; // nothing actionable

  const normalized = normalizeHandle(handle);
  const username = normalized ? normalized.username : String(handle ?? "").replace(/^@+/, "").toLowerCase();
  const canonicalHandle = normalized ? normalized.handle : `@${username}`;

  const createdMs = tweet.created_at ? Date.parse(tweet.created_at) : NaN;
  const minutesAgo = Number.isFinite(createdMs)
    ? Math.max(0, Math.floor((fetchedAtMs - createdMs) / 60_000))
    : 0;

  const headline = text || UNTITLED;

  return {
    // clusterId omitted — normalizer fills with `provisional:${sourceId}`.
    sourceId: deriveSourceId(username, tweetId || headline),
    // Stable per-handle feed identifier so source-selection can match social
    // candidates by id, parallel to RSS `feedId`.
    feedId: `x:${username}`,
    // Outlet is the canonical handle (with `@`) — handles are their own
    // identity and are never collapsed to a parent brand (matches socialSources
    // entry style).
    outlet: canonicalHandle,
    kind: "social",
    weight: Number(weight),
    url: `https://x.com/${username}/status/${tweetId}`,
    minutesAgo,
    headline,
    body: [headline],
    // Optional BCP-47 language tag when the tweet carries one — propagated so
    // the translation-first stage can tell non-English evidence apart. Absent
    // when the tweet omits `lang` (never fabricated).
    ...(typeof tweet.lang === "string" && tweet.lang.trim().length > 0
      ? { lang: tweet.lang.trim() }
      : {}),
    // Narrative fields stay empty until clustering assigns them (feed-reader
    // convention).
    title: "",
    topic: "",
    geographies: [],
    takeaway: "",
    summary: "",
    whyItMatters: "",
    whatChanged: "",
  };
}

// Dedupe normalized handles by username, preserving first-appearance order.
function dedupeHandles(socialSources) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(socialSources) ? socialSources : []) {
    const normalized = normalizeHandle(raw);
    if (!normalized || seen.has(normalized.username)) continue;
    seen.add(normalized.username);
    out.push(normalized);
  }
  return out;
}

/**
 * Read recent tweets for the selected social handles and return normalized raw
 * ingestion items plus deterministic diagnostics.
 *
 * @param {object} args
 * @param {string[]} args.socialSources — handles (any of `@x`, `x`, mixed case).
 * @param {object} args.config — resolved X config (see resolveXConfig).
 * @param {Function} args.fetchImpl — injected fetch (tests pass a mock).
 * @param {number} [args.nowMs=Date.now()]
 * @param {number} [args.perHandleWeight=60]
 * @returns {Promise<{ items: object[], diagnostics: object }>}
 */
export async function readXItems({
  socialSources,
  config,
  fetchImpl,
  nowMs = Date.now(),
  perHandleWeight = DEFAULT_HANDLE_WEIGHT,
}) {
  const normalizedAll = dedupeHandles(socialSources);

  const diagnostics = {
    handlesRequested: normalizedAll.length,
    handlesSelected: 0,
    handlesFetched: 0,
    tweetsReturned: 0,
    errors: [],
    degraded: false,
  };

  // Gate 1: feature disabled → no work, empty result (not degraded).
  if (!config || !config.enabled) {
    return { items: [], diagnostics };
  }

  // Gate 2: allowlist. Empty allowlist keeps all handles; otherwise keep only
  // allowlisted usernames.
  const allowlist = Array.isArray(config.allowlist) ? config.allowlist : [];
  const allowSet = new Set(allowlist);
  const selected =
    allowSet.size === 0 ? normalizedAll : normalizedAll.filter((h) => allowSet.has(h.username));
  diagnostics.handlesSelected = selected.length;

  const startTimeIso = computeStartTimeIso(nowMs);
  const startTimeMs = Date.parse(startTimeIso);
  const items = [];

  for (const { username, handle } of selected) {
    try {
      const user = await lookupUserByUsername(username, { config, fetchImpl });
      if (!user || !user.id) {
        throw new Error(`lookup returned no id for ${handle}`);
      }

      let paginationToken;
      let pages = 0;
      let handleTweetCount = 0;

      while (pages < MAX_PAGES_PER_HANDLE) {
        const page = await fetchUserTweets(user.id, {
          config,
          fetchImpl,
          startTime: startTimeIso,
          exclude: "retweets",
          paginationToken,
        });
        pages += 1;

        for (const tweet of page.tweets ?? []) {
          const item = mapTweetToRawItem({
            tweet,
            handle,
            weight: perHandleWeight,
            fetchedAtMs: nowMs,
          });
          if (item) {
            items.push(item);
            handleTweetCount += 1;
          }
        }

        // Stop paginating once this page's oldest tweet predates the 24h window —
        // older pages are entirely out of horizon. Also stop when there's no
        // further cursor.
        const oldestMs = oldestTweetMs(page);
        if (Number.isFinite(oldestMs) && Number.isFinite(startTimeMs) && oldestMs < startTimeMs) {
          break;
        }
        if (!page.nextToken) break;
        paginationToken = page.nextToken;
      }

      diagnostics.handlesFetched += 1;
      diagnostics.tweetsReturned += handleTweetCount;
    } catch (err) {
      // Per-handle isolation: one bad handle must not sink the whole run.
      diagnostics.degraded = true;
      diagnostics.errors.push({
        handle,
        message: err instanceof Error ? err.message : String(err),
        ...(err && err.status != null ? { status: err.status } : {}),
      });
    }
  }

  return { items, diagnostics };
}

// Oldest tweet timestamp (ms) on a page. Prefer the explicit oldest tweet's
// created_at; the meta ids are opaque and not time-parseable.
function oldestTweetMs(page) {
  const tweets = page?.tweets ?? [];
  let oldest = NaN;
  for (const tweet of tweets) {
    const ms = tweet?.created_at ? Date.parse(tweet.created_at) : NaN;
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(oldest) || ms < oldest) oldest = ms;
  }
  return oldest;
}
