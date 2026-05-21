// Reads raw source items from either:
//   1. The "fixture" path  — `data/source-items.json` (preserved from MVP).
//   2. The "live" path     — fetches every eligible RSS feed in the manifest,
//      parses entries, and maps them to the raw-item shape downstream consumers
//      (`normalizeSourceItems`, then the refresh pipeline) expect.
//
// Mode is selected by env `TEMPO_RSS_INGESTION`:
//   - `fixture` → read source-items.json (test determinism only).
//   - `live`    → fetch RSS feeds from the manifest.
//   - unset     → fixture ONLY when NODE_ENV=test; every other environment
//                  (development, staging, production, unset) defaults to live.
//
// `assertProductionSafe` enforces a hard rule: fixture mode under
// NODE_ENV=production throws synchronously before any fetch / file-read.
//
// Tests can bypass env by passing `opts.mode` and `opts.fetchImpl`.

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Parser from "rss-parser";
import { isSupabaseEnabled, getSupabaseClient } from "../db/client.mjs";
import { listIngestionFeeds } from "./feed-manifest-repo.mjs";
import { derivePublisherFromFeedName } from "./publisher-from-feed-name.mjs";

export { derivePublisherFromFeedName } from "./publisher-from-feed-name.mjs";

const USER_AGENT = "Tempo-API/0.1 (+https://github.com/cabezas-felipe/comms-project)";
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_FETCH_CONCURRENCY = 6;
const DEFAULT_MAX_PER_FEED = 30;
const DEFAULT_MAX_TOTAL = 200;
// Default cap for blocked-feed log lines.  Keeps the operator log readable
// when an allowlist filters out the whole manifest minus a small tail; full
// visibility is still available behind `TEMPO_RSS_ALLOWLIST_VERBOSE=true`.
const BLOCKED_LOG_DEFAULT_CAP = 5;

// Hardcoded restricted default allowlist used when no operator config is
// present.  Pinning it here (rather than reading from the manifest) keeps
// the guard a separate, deliberate kill switch: widening the source pool
// always requires explicit operator action (env var or `opts.allowlist`).
const DEFAULT_ALLOWLIST = Object.freeze(["washington post"]);

// Env var aliases — both newer (`TEMPO_RSS_*`) and legacy (`TEMPO_INGESTION_*`)
// names are honored, with newer winning when set.  Precedence is pinned by
// tests so dropping legacy support requires a deliberate change.
const ENV_ALLOWLIST_NEWER = "TEMPO_RSS_ALLOWLIST";
const ENV_ALLOWLIST_LEGACY = "TEMPO_INGESTION_ALLOWLIST";
const ENV_VERBOSE_NEWER = "TEMPO_RSS_ALLOWLIST_VERBOSE";
const ENV_VERBOSE_LEGACY = "TEMPO_INGESTION_GUARD_VERBOSE";

// Tag for resolveMode's `source` field — quoted in the per-refresh log line
// and the production guard's error so operators can see which signal drove
// the mode decision without grepping env state.
export const INGESTION_MODE_SOURCE = Object.freeze({
  EXPLICIT_ENV: "explicit_env",       // TEMPO_RSS_INGESTION set to live|fixture
  NODE_ENV_DEFAULT: "node_env_default", // fell through to NODE_ENV-based default
  OPTS_OVERRIDE: "opts_override",     // caller passed opts.mode (test path)
});

/**
 * Resolve ingestion mode + the signal it came from.
 *
 * Precedence (first match wins):
 *   1. `TEMPO_RSS_INGESTION` set to "live" or "fixture"  → that mode, source=explicit_env.
 *   2. NODE_ENV === "test"                                → fixture, source=node_env_default.
 *   3. anything else (development, staging, production, unset) → live, source=node_env_default.
 *
 * Pure / accepts an `env` snapshot so tests can pin behavior without
 * mutating `process.env` (which would race other tests in the same
 * runtime).  Default reads `process.env` lazily.
 *
 * @returns {{ mode: "live"|"fixture", source: string }}
 */
export function resolveMode(env = process.env) {
  const explicit = env?.TEMPO_RSS_INGESTION;
  if (explicit === "live" || explicit === "fixture") {
    return { mode: explicit, source: INGESTION_MODE_SOURCE.EXPLICIT_ENV };
  }
  const mode = env?.NODE_ENV === "test" ? "fixture" : "live";
  return { mode, source: INGESTION_MODE_SOURCE.NODE_ENV_DEFAULT };
}

/**
 * Hard safety guard — fixture mode is never allowed under NODE_ENV=production.
 *
 * Called after the final mode is known (whether from opts.mode or from
 * resolveMode) so opts.mode cannot bypass the guard either.  Throws a
 * synchronous Error with a clear remediation hint so the misconfiguration
 * surfaces immediately instead of silently serving fixture data.
 *
 * Pure / accepts an env snapshot for the same reasons resolveMode does.
 */
export function assertProductionSafe(mode, source, env = process.env) {
  if (env?.NODE_ENV === "production" && mode === "fixture") {
    const explicit = env?.TEMPO_RSS_INGESTION;
    const explicitDescription =
      explicit === undefined ? "<unset>" : JSON.stringify(explicit);
    throw new Error(
      "[feed-reader] fixture ingestion mode is not allowed under " +
        `NODE_ENV=production (resolution_source=${source}, ` +
        `TEMPO_RSS_INGESTION=${explicitDescription}). ` +
        "Set TEMPO_RSS_INGESTION=live explicitly, or unset it to fall " +
        "through to the production default. Fixture mode is reserved for " +
        "test determinism (NODE_ENV=test) and must never serve real users."
    );
  }
}

function maxItemsPerFeed() {
  const v = Number(process.env.TEMPO_RSS_MAX_ITEMS_PER_FEED);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_PER_FEED;
}

function maxItemsTotal() {
  const v = Number(process.env.TEMPO_RSS_MAX_ITEMS_TOTAL);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_TOTAL;
}

// ─── Allowlist guard ──────────────────────────────────────────────────────────
//
// A second-stage guard layered on top of `filterFeeds`.  Where `filterFeeds`
// rejects rows that are structurally ineligible (non-RSS, inactive, invalid
// URL), the allowlist rejects rows whose name does not appear in an
// operator-controlled allowlist.  Useful for incident response (kill a
// feed without a manifest edit), staging environments, and chaos drills.
//
// Inputs:
//   - `opts.allowlist`            — caller-supplied (tests + service code).
//   - `process.env.TEMPO_RSS_ALLOWLIST` — env-supplied default.
// Precedence (must be explicit; ambiguous types fall through to env):
//   - `null`                      → guard disabled (no filtering).
//   - `Array.isArray(...)`        → use this list verbatim (after normalize).
//   - `undefined` / absent        → fall back to env resolution.
//
// Normalization parity: opts entries and env entries are normalized through
// the same pipeline (trim, lowercase, collapse internal whitespace, drop
// empties) so `["  Reuters  "]` and `"reuters"` produce the same matcher.

/**
 * Normalize a single allowlist entry: trim, lowercase, collapse runs of
 * whitespace.  Returns null for non-strings and for entries that are empty
 * after trimming so the caller can `.filter(Boolean)` them out.
 */
function normalizeAllowlistEntry(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return cleaned.length === 0 ? null : cleaned;
}

/** Apply normalization + drop-empty in one pass.  Exported for parity tests. */
export function normalizeAllowlist(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of entries) {
    const norm = normalizeAllowlistEntry(raw);
    if (norm == null) continue;
    if (seen.has(norm)) continue; // dedupe so blocked-list logs stay clean
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Parse `TEMPO_RSS_ALLOWLIST` (comma-separated names) into a normalized
 * allowlist.  Empty / unset env yields `[]`.  Each entry runs through the
 * same normalization the opts path uses, so behavior is identical.
 */
export function parseAllowlistEnv(raw) {
  if (raw == null) return [];
  return normalizeAllowlist(String(raw).split(","));
}

/**
 * Read the env snapshot used by `resolveAllowlist` / `isAllowlistVerboseEnv`.
 * Centralizing this here keeps the resolver decoupled from `process.env`
 * (tests can pass an explicit snapshot) and documents the supported names
 * in one place.  Both newer and legacy names are read on every call — the
 * resolver decides which one wins.
 */
function readAllowlistEnv() {
  return {
    newer: process.env[ENV_ALLOWLIST_NEWER],
    legacy: process.env[ENV_ALLOWLIST_LEGACY],
  };
}

/**
 * Resolve the effective allowlist from caller opts + env.  Returns:
 *   - `null`     — guard disabled (caller passed `opts.allowlist === null`).
 *   - `string[]` — normalized allowlist.  An empty list is permissive at the
 *                  filter step (every feed passes); only reachable via an
 *                  explicit empty array from the caller.  When opts is
 *                  absent and env yields nothing, the resolver falls back
 *                  to `DEFAULT_ALLOWLIST` so manifest expansion cannot
 *                  silently widen ingestion.
 *
 * The asymmetry between `null` (disabled) and `[]` (permissive) is
 * deliberate: a caller who genuinely wants to bypass the env/default
 * allowlist must do so explicitly (`opts.allowlist = null`) so they cannot
 * accidentally lose the guard by passing `undefined`.
 *
 * Env precedence (when opts is absent):
 *   1. `TEMPO_RSS_ALLOWLIST` (newer, scoped to RSS) — wins when normalized
 *      to a non-empty list.
 *   2. `TEMPO_INGESTION_ALLOWLIST` (legacy alias) — fallback.
 *   3. `DEFAULT_ALLOWLIST` (hardcoded `["washington post"]`).
 *
 * "Wins when non-empty" means an env value that normalizes to nothing
 * (empty string, only commas/whitespace) does NOT silently flip the
 * guard to permissive — it falls through to the next source.  The only
 * way to get an empty allowlist is an explicit empty array from opts.
 *
 * The second arg accepts either a `{ newer, legacy }` snapshot (preferred,
 * used by tests that mock the env without touching `process.env`) or a
 * plain string treated as the newer var.  Default is read from
 * `process.env` lazily so the function stays test-friendly.
 */
export function resolveAllowlist(optsAllowlist, env = readAllowlistEnv()) {
  if (optsAllowlist === null) return null;
  if (Array.isArray(optsAllowlist)) return normalizeAllowlist(optsAllowlist);
  // Any other opts shape (undefined, string, object) → fall through to env.
  // We do NOT silently disable the guard for unexpected types — that would
  // let a typo in caller code bypass the operator-configured allowlist.
  const snap = typeof env === "object" && env !== null
    ? env
    : { newer: env, legacy: undefined };
  const fromNewer = parseAllowlistEnv(snap.newer);
  if (fromNewer.length > 0) return fromNewer;
  const fromLegacy = parseAllowlistEnv(snap.legacy);
  if (fromLegacy.length > 0) return fromLegacy;
  return normalizeAllowlist(DEFAULT_ALLOWLIST);
}

/**
 * Apply the allowlist guard to a list of feeds.  Returns `{ allowed,
 * blocked }`.
 *
 *   - `allowlist === null`        → guard disabled, every feed allowed.
 *   - `allowlist.length === 0`    → no filter configured, every feed allowed.
 *   - non-empty allowlist         → feed name (normalized) must contain at
 *                                   least one allowlist entry as a substring.
 *
 * Substring match (rather than exact) keeps publisher-level allowlist entries
 * working against section-level feed names — e.g. `"reuters"` matches
 * `"Reuters — World News"`.
 */
export function applyAllowlistGuard(feeds, allowlist) {
  if (allowlist === null || allowlist.length === 0) {
    return { allowed: [...(feeds ?? [])], blocked: [] };
  }
  const allowed = [];
  const blocked = [];
  for (const feed of feeds ?? []) {
    const norm = String(feed?.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (norm && allowlist.some((entry) => norm.includes(entry))) {
      allowed.push(feed);
    } else {
      blocked.push(feed);
    }
  }
  return { allowed, blocked };
}

/**
 * Format a blocked-list log fragment.  Default mode caps the rendered list
 * to keep operator logs readable; verbose mode (TEMPO_RSS_ALLOWLIST_VERBOSE)
 * dumps the full list.  Either way the count is always present so log
 * readers can spot a sudden uptick in blocked feeds without scrolling.
 *
 * Returns the rendered fragment or `null` when nothing is blocked, so the
 * caller can skip emitting a log line entirely (no "blocked=0" noise).
 */
export function formatBlockedList(blocked, { verbose, cap = BLOCKED_LOG_DEFAULT_CAP } = {}) {
  if (!Array.isArray(blocked) || blocked.length === 0) return null;
  const ids = blocked.map((f) => String(f?.id ?? f?.name ?? "?"));
  const total = ids.length;
  if (verbose) {
    return `blocked=${total} [${ids.join(", ")}]`;
  }
  if (total <= cap) {
    return `blocked=${total} [${ids.join(", ")}]`;
  }
  const head = ids.slice(0, cap).join(", ");
  const remainder = total - cap;
  return `blocked=${total} [${head}, ...and ${remainder} more]`;
}

/**
 * Resolve the verbose flag with the same newer-wins precedence the
 * allowlist uses.  Either `TEMPO_RSS_ALLOWLIST_VERBOSE` or the legacy
 * `TEMPO_INGESTION_GUARD_VERBOSE` may set it; only the literal string
 * `"true"` (case-insensitive) enables verbose output.
 *
 * "Newer wins when set" follows the same rule as the allowlist: a
 * non-empty value for the newer var takes precedence regardless of
 * whether it evaluates to true or false — operator's most recent
 * intent stands.  Legacy is consulted only when the newer var is unset
 * or empty.
 */
export function isAllowlistVerboseEnv(env = process.env) {
  const newer = env[ENV_VERBOSE_NEWER];
  if (typeof newer === "string" && newer.length > 0) {
    return newer.trim().toLowerCase() === "true";
  }
  const legacy = env[ENV_VERBOSE_LEGACY];
  if (typeof legacy === "string" && legacy.length > 0) {
    return legacy.trim().toLowerCase() === "true";
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read raw source items for the refresh pipeline.
 *
 * @param {string} dataDir
 * @param {object} [opts]
 * @param {"fixture"|"live"} [opts.mode]      — override env detection (tests).
 * @param {Function} [opts.fetchImpl]         — replace global fetch (tests).
 * @param {Function} [opts.manifestLoader]    — async () → feeds[] (tests).
 * @param {object}   [opts.parser]            — pre-built rss-parser instance (tests).
 * @param {number}   [opts.concurrency]
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.maxPerFeed]
 * @param {number}   [opts.maxTotal]
 * @param {string[]|null} [opts.allowlist]    — feed-name allowlist guard:
 *   `null` disables the guard, `string[]` overrides env, `undefined` falls
 *   back to TEMPO_RSS_ALLOWLIST.  See `resolveAllowlist` for precedence.
 * @returns {Promise<Array>} raw items
 */
export async function readFeedItems(dataDir, opts = {}) {
  // Resolve mode + record where it came from so the per-refresh log line
  // and the production safety guard both have the same signal.  opts.mode
  // (test path) bypasses env resolution but is STILL gated by the
  // production guard — a misset opts.mode in production must fail loud.
  let mode;
  let source;
  if (opts.mode === "live" || opts.mode === "fixture") {
    mode = opts.mode;
    source = INGESTION_MODE_SOURCE.OPTS_OVERRIDE;
  } else {
    ({ mode, source } = resolveMode());
  }
  assertProductionSafe(mode, source);
  // One low-noise line per refresh — surfaces fixture-mode surprises in
  // dev (and the resolution signal makes "why is this fixture?" a single
  // log grep instead of a full env audit).  Stays separate from the
  // existing live-path summary log so neither is harder to read.
  console.log(`[feed-reader] mode=${mode} resolution_source=${source}`);
  if (mode === "fixture") return readFixtureItems(dataDir);
  return readLiveItems(dataDir, opts);
}

// ─── Fixture path (unchanged behavior) ───────────────────────────────────────

async function readFixtureItems(dataDir) {
  const file = path.join(dataDir, "source-items.json");
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}

// ─── Live path ───────────────────────────────────────────────────────────────

async function readLiveItems(dataDir, opts) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const parser = opts.parser ?? new Parser();
  const concurrency = opts.concurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxPerFeed = opts.maxPerFeed ?? maxItemsPerFeed();
  const maxTotal = opts.maxTotal ?? maxItemsTotal();

  if (typeof fetchImpl !== "function") {
    throw new Error("[feed-reader.live] no fetch implementation available");
  }

  const allFeeds = await loadManifest(dataDir, opts.manifestLoader);
  const { eligible: structurallyEligible, skipped } = filterFeeds(allFeeds, process.env.TEMPO_RSS_PUBLISHER);

  if (skipped.length > 0) {
    console.log(`[feed-reader.live] skipped ${skipped.length} manifest row(s): ${skipped.map((s) => `${s.id}:${s.reason}`).join(", ")}`);
  }

  // Layered guard: filterFeeds rejects rows by structural eligibility
  // (kind/active/url); the allowlist rejects by operator policy.  We resolve
  // and apply it AFTER filterFeeds so the blocked log only mentions rows
  // that would otherwise have been fetched — keeping the operator's mental
  // model simple ("blocked = real feeds the allowlist held back").
  // Pass `undefined` as the second arg so resolveAllowlist reads its env
  // snapshot from process.env directly — picks up both the newer and legacy
  // var names with the documented precedence.  Tests that mock the env
  // without touching process.env can pass a snapshot via opts.allowlist or
  // by mutating process.env before the call.
  const allowlist = resolveAllowlist(opts.allowlist);
  const { allowed: eligible, blocked } = applyAllowlistGuard(structurallyEligible, allowlist);
  const blockedFragment = formatBlockedList(blocked, { verbose: isAllowlistVerboseEnv() });
  if (blockedFragment) {
    // One log line, optional cap, never "blocked=0" — see formatBlockedList.
    console.log(`[feed-reader.live] allowlist ${blockedFragment}`);
  }

  if (eligible.length === 0) {
    console.log(`[feed-reader.live] no eligible RSS feeds after filtering (publisher="${process.env.TEMPO_RSS_PUBLISHER ?? ""}", allowlistActive=${allowlist === null ? "false" : String(allowlist.length > 0)})`);
    return [];
  }

  const fetchedAt = Date.now();
  const settled = await pMap(
    eligible,
    (feed) => fetchAndParseFeed(feed, { fetchImpl, parser, timeoutMs }),
    concurrency
  );

  let parsedTotal = 0;
  let failedFeeds = 0;
  const perFeedItems = [];
  for (let i = 0; i < settled.length; i++) {
    const feed = eligible[i];
    const r = settled[i];
    if (r.status !== "fulfilled") {
      failedFeeds++;
      console.warn(`[feed-reader.live] feed=${feed.id} fetch failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
      continue;
    }
    const mapped = r.value
      .map((entry) => mapEntry(feed, entry, fetchedAt))
      .filter(Boolean)
      // Per-feed cap, newest first (smaller minutesAgo = newer).
      .sort((a, b) => a.minutesAgo - b.minutesAgo)
      .slice(0, maxPerFeed);
    parsedTotal += mapped.length;
    perFeedItems.push(...mapped);
  }

  // Global cap, newest first across the merged pool.
  const merged = perFeedItems
    .sort((a, b) => a.minutesAgo - b.minutesAgo)
    .slice(0, maxTotal);

  console.log(
    `[feed-reader.live] feeds=${eligible.length} skipped=${skipped.length} failed=${failedFeeds} parsed=${parsedTotal} returned=${merged.length} (cap/feed=${maxPerFeed}, cap/total=${maxTotal})`
  );

  return merged;
}

// ─── Manifest loading ────────────────────────────────────────────────────────

async function loadManifest(dataDir, injected) {
  if (injected) return injected();
  if (isSupabaseEnabled()) {
    return listIngestionFeeds({ supabase: getSupabaseClient() });
  }
  const file = path.join(dataDir, "source-feeds.json");
  const content = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(content);
  return Array.isArray(parsed?.feeds) ? parsed.feeds : [];
}

/**
 * Filter manifest rows down to the set of feeds eligible for live fetching.
 * Logs (returns) reasons for skipped rows so refresh isn't silently lossy.
 *
 * Publisher filter rule (when TEMPO_RSS_PUBLISHER is set): case-insensitive
 * substring match on the manifest `name` after collapsing whitespace.
 * Example: "washington post" matches "Washington Post — Politics".
 */
export function filterFeeds(feeds, publisherFilterRaw) {
  const eligible = [];
  const skipped = [];
  const publisher = (publisherFilterRaw ?? "").trim().toLowerCase().replace(/\s+/g, " ");

  for (const feed of feeds ?? []) {
    if (!feed || typeof feed !== "object") {
      skipped.push({ id: "?", reason: "invalid_row" });
      continue;
    }
    if (feed.kind !== "rss") {
      skipped.push({ id: feed.id ?? "?", reason: "non_rss" });
      continue;
    }
    if (feed.active === false) {
      skipped.push({ id: feed.id ?? "?", reason: "inactive" });
      continue;
    }
    const url = String(feed.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      skipped.push({ id: feed.id ?? "?", reason: "invalid_url" });
      continue;
    }
    if (publisher) {
      const name = String(feed.name ?? "").toLowerCase().replace(/\s+/g, " ");
      if (!name.includes(publisher)) {
        skipped.push({ id: feed.id ?? "?", reason: "publisher_filter" });
        continue;
      }
    }
    eligible.push(feed);
  }
  return { eligible, skipped };
}

// ─── Fetch + parse ───────────────────────────────────────────────────────────

async function fetchAndParseFeed(feed, { fetchImpl, parser, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(feed.url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const xml = await response.text();
    const parsed = await parser.parseString(xml);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } finally {
    clearTimeout(timer);
  }
}

// ─── Entry mapping ───────────────────────────────────────────────────────────

/**
 * Map a single rss-parser entry to the raw-item shape consumed by
 * `normalizeSourceItems`.  Returns null when the entry can't be mapped
 * (e.g. missing both link and title — nothing to display).
 */
export function mapEntry(feed, entry, fetchedAt = Date.now()) {
  if (!entry || typeof entry !== "object") return null;

  const link = (entry.link ?? entry.guid ?? "").trim();
  const headline = stripHtml(entry.title ?? "").trim();
  if (!headline && !link) return null; // nothing actionable

  const stableKey = entry.guid || entry.link || `${entry.title ?? ""}|${entry.pubDate ?? entry.isoDate ?? ""}`;
  const sourceId = createHash("sha256").update(`${feed.id}::${stableKey}`).digest("hex").slice(0, 16);

  const bodyText = stripHtml(
    entry["content:encoded"] ??
      entry.content ??
      entry.contentSnippet ??
      entry.summary ??
      entry.description ??
      ""
  ).trim();

  const dateString = entry.isoDate ?? entry.pubDate ?? null;
  const itemTime = dateString ? Date.parse(dateString) : NaN;
  const minutesAgo = Number.isFinite(itemTime)
    ? Math.max(0, Math.floor((fetchedAt - itemTime) / 60_000))
    : 0;

  return {
    // clusterId omitted — normalizer fills with `provisional:${sourceId}`
    sourceId,
    // Stable manifest-row identifier carried through so the source-selection
    // stage can match candidates against `selection.matchedFeeds` by id —
    // robust to upstream canonical_name drift / whitespace / "The " variance
    // that an outlet-name string match would miss.  Empty string when the
    // manifest row had no id (defensive — every row should have one).
    feedId: String(feed.id ?? ""),
    // Publisher brand on the user-facing outlet field — never the section
    // name.  Manifest-supplied `feed.publisher` wins; otherwise we strip the
    // trailing "— Section" off `feed.name` (B2 fallback); only then do we
    // fall through to the raw manifest name / id so the downstream count
    // collapses sibling-section feeds (e.g. WaPo Politics + World) to one
    // outlet identity.  See the publisher-outlet spec.
    outlet: String(
      feed.publisher ??
        derivePublisherFromFeedName(feed.name) ??
        feed.name ??
        feed.id ??
        "Unknown"
    ),
    kind: "traditional",
    weight: Number(feed.weight ?? 0),
    url: link || feed.url,
    minutesAgo,
    headline: headline || "(untitled)",
    body: bodyText ? [bodyText] : [headline || "(untitled)"],
    // Narrative fields stay empty until clustering assigns them.
    title: "",
    topic: "",
    geographies: [],
    takeaway: "",
    summary: "",
    whyItMatters: "",
    whatChanged: "",
  };
}

// ─── HTML helpers ────────────────────────────────────────────────────────────

const NUMERIC_ENTITY = /&#(\d+);/g;
const HEX_ENTITY = /&#x([0-9a-fA-F]+);/g;
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};
const NAMED_ENTITY_RE = /&([a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Strip HTML tags and decode common entities, returning plain text only.
 * Whitespace is collapsed to single spaces.  Named entities not in the table
 * are left as-is (they're rare in news bodies and rss-parser usually decodes
 * them upstream via contentSnippet).
 */
export function stripHtml(input) {
  if (input == null) return "";
  return String(input)
    .replace(/<[^>]+>/g, " ")
    .replace(NUMERIC_ENTITY, (_, n) => safeFromCodePoint(parseInt(n, 10)))
    .replace(HEX_ENTITY, (_, n) => safeFromCodePoint(parseInt(n, 16)))
    .replace(NAMED_ENTITY_RE, (m, name) => {
      const lower = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)
        ? NAMED_ENTITIES[lower]
        : m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function safeFromCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

// ─── Bounded concurrency map (Promise.allSettled-style results) ──────────────

async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = [];
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i], i) };
        } catch (err) {
          results[i] = { status: "rejected", reason: err };
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}
