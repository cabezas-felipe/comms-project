// Reads raw source items from either:
//   1. The "fixture" path  — `data/source-items.json` (preserved from MVP).
//   2. The "live" path     — fetches every eligible RSS feed in the manifest,
//      parses entries, and maps them to the raw-item shape downstream consumers
//      (`normalizeSourceItems`, then the refresh pipeline) expect.
//
// Mode is selected by env `TEMPO_RSS_INGESTION`:
//   - `fixture` → read source-items.json (back-compat for tests/dev).
//   - `live`    → fetch RSS feeds from the manifest.
//   - unset     → defaults to `live` in production (NODE_ENV=production), else `fixture`.
//
// Tests can bypass env by passing `opts.mode` and `opts.fetchImpl`.

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Parser from "rss-parser";
import { isSupabaseEnabled, getSupabaseClient } from "../db/client.mjs";
import { listIngestionFeeds } from "./feed-manifest-repo.mjs";

const USER_AGENT = "Tempo-API/0.1 (+https://github.com/cabezas-felipe/comms-project)";
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_FETCH_CONCURRENCY = 6;
const DEFAULT_MAX_PER_FEED = 30;
const DEFAULT_MAX_TOTAL = 200;

function resolveMode() {
  const explicit = process.env.TEMPO_RSS_INGESTION;
  if (explicit === "live" || explicit === "fixture") return explicit;
  return process.env.NODE_ENV === "production" ? "live" : "fixture";
}

function maxItemsPerFeed() {
  const v = Number(process.env.TEMPO_RSS_MAX_ITEMS_PER_FEED);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_PER_FEED;
}

function maxItemsTotal() {
  const v = Number(process.env.TEMPO_RSS_MAX_ITEMS_TOTAL);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_TOTAL;
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
 * @returns {Promise<Array>} raw items
 */
export async function readFeedItems(dataDir, opts = {}) {
  const mode = opts.mode ?? resolveMode();
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
  const { eligible, skipped } = filterFeeds(allFeeds, process.env.TEMPO_RSS_PUBLISHER);

  if (skipped.length > 0) {
    console.log(`[feed-reader.live] skipped ${skipped.length} manifest row(s): ${skipped.map((s) => `${s.id}:${s.reason}`).join(", ")}`);
  }

  if (eligible.length === 0) {
    console.log(`[feed-reader.live] no eligible RSS feeds after filtering (publisher="${process.env.TEMPO_RSS_PUBLISHER ?? ""}")`);
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
    outlet: String(feed.name ?? feed.id ?? "Unknown"),
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
