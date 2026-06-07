import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecentItemRows,
  writeRecentItems,
  purgeExpired,
  readRecentItems,
  cacheRowsToRawItems,
  RECENT_ITEMS_CACHE_TABLE,
} from "./recent-items-cache.mjs";

// Recording fake of the supabase-js fluent builder.  Captures the table name,
// upsert/delete arguments, and `.lt` calls so tests can pin the wire format
// without a real supabase round-trip.
function createRecordingClient({
  upsertError = null,
  deleteError = null,
  deleteCount = 0,
  selectRows = [],
  selectError = null,
} = {}) {
  const calls = { from: [], upsert: [], delete: [], lt: [], select: [], in: [], gt: [] };
  const builder = {
    from(table) {
      calls.from.push(table);
      return builder;
    },
    upsert(rows, opts) {
      calls.upsert.push({ rows, opts });
      return Promise.resolve({ data: null, error: upsertError });
    },
    delete(opts) {
      calls.delete.push(opts ?? null);
      return builder;
    },
    lt(column, value) {
      calls.lt.push({ column, value });
      return Promise.resolve({ data: null, error: deleteError, count: deleteCount });
    },
    select(columns) {
      calls.select.push(columns);
      return builder;
    },
    in(column, values) {
      calls.in.push({ column, values });
      return builder;
    },
    gt(column, value) {
      calls.gt.push({ column, value });
      return Promise.resolve({ data: selectRows, error: selectError });
    },
  };
  return { client: builder, calls };
}

const SAMPLE_ITEM = {
  sourceId: "wapo-politics::abc123",
  feedId: "wapo-politics",
  url: "https://wapo.example.com/article-1",
  headline: "Test headline",
  body: ["First paragraph body.", "Second paragraph."],
  minutesAgo: 30,
  outlet: "The Washington Post",
};

const NOW = Date.parse("2026-05-27T12:00:00.000Z");

// ─── buildRecentItemRows ─────────────────────────────────────────────────────

test("buildRecentItemRows: projects an item into the cache row shape with ISO timestamps", () => {
  const [row] = buildRecentItemRows([SAMPLE_ITEM], { now: NOW, ttlMs: 3_600_000 });
  assert.equal(row.source_id, "wapo-politics::abc123");
  assert.equal(row.feed_id, "wapo-politics");
  assert.equal(row.url, "https://wapo.example.com/article-1");
  assert.equal(row.headline, "Test headline");
  assert.equal(row.snippet, "First paragraph body.");
  assert.equal(row.fetched_at, "2026-05-27T12:00:00.000Z");
  assert.equal(row.expires_at, "2026-05-27T13:00:00.000Z");
  // published_at = fetched_at − minutesAgo (30min)
  assert.equal(row.published_at, "2026-05-27T11:30:00.000Z");
});

test("buildRecentItemRows: snippet is null when body is missing or empty", () => {
  const [row] = buildRecentItemRows([{ ...SAMPLE_ITEM, body: [] }], { now: NOW });
  assert.equal(row.snippet, null);
  const [row2] = buildRecentItemRows([{ ...SAMPLE_ITEM, body: undefined }], { now: NOW });
  assert.equal(row2.snippet, null);
});

test("buildRecentItemRows: snippet truncates very long bodies", () => {
  const longBody = "x".repeat(2_000);
  const [row] = buildRecentItemRows([{ ...SAMPLE_ITEM, body: [longBody] }], { now: NOW });
  assert.equal(row.snippet.length, 500, "snippet must be capped at 500 chars");
});

test("buildRecentItemRows: published_at is null when minutesAgo is missing or invalid", () => {
  const [row] = buildRecentItemRows([{ ...SAMPLE_ITEM, minutesAgo: undefined }], { now: NOW });
  assert.equal(row.published_at, null);
  const [row2] = buildRecentItemRows([{ ...SAMPLE_ITEM, minutesAgo: -1 }], { now: NOW });
  assert.equal(row2.published_at, null);
});

test("buildRecentItemRows: items without sourceId are skipped (PK guard)", () => {
  const rows = buildRecentItemRows(
    [{ ...SAMPLE_ITEM, sourceId: "" }, { ...SAMPLE_ITEM, sourceId: "  " }, null, undefined, SAMPLE_ITEM],
    { now: NOW }
  );
  assert.equal(rows.length, 1, "only the well-formed item should survive");
  assert.equal(rows[0].source_id, "wapo-politics::abc123");
});

test("buildRecentItemRows: dedupes by source_id within a single batch", () => {
  const dupe = { ...SAMPLE_ITEM, headline: "Second copy" };
  const rows = buildRecentItemRows([SAMPLE_ITEM, dupe], { now: NOW });
  assert.equal(rows.length, 1, "duplicate source_id within a batch must collapse to one row");
  assert.equal(rows[0].headline, "Test headline", "first occurrence wins");
});

test("buildRecentItemRows: returns [] for non-array inputs", () => {
  assert.deepEqual(buildRecentItemRows(null), []);
  assert.deepEqual(buildRecentItemRows(undefined), []);
  assert.deepEqual(buildRecentItemRows("not-an-array"), []);
});

// ─── writeRecentItems ────────────────────────────────────────────────────────

test("writeRecentItems: upserts onto ingestion_recent_items with onConflict='source_id'", async () => {
  const { client, calls } = createRecordingClient();
  const res = await writeRecentItems({ supabase: client, items: [SAMPLE_ITEM], now: NOW });
  assert.equal(res.error, null);
  assert.equal(res.written, 1);
  assert.deepEqual(calls.from, [RECENT_ITEMS_CACHE_TABLE]);
  assert.equal(calls.upsert.length, 1);
  assert.deepEqual(calls.upsert[0].opts, { onConflict: "source_id" });
  assert.equal(calls.upsert[0].rows[0].source_id, "wapo-politics::abc123");
});

test("writeRecentItems: empty/invalid batch is a no-op (no supabase round-trip)", async () => {
  const { client, calls } = createRecordingClient();
  const res = await writeRecentItems({ supabase: client, items: [], now: NOW });
  assert.equal(res.written, 0);
  assert.equal(res.error, null);
  assert.equal(calls.upsert.length, 0, "must not call supabase for an empty batch");

  const res2 = await writeRecentItems({ supabase: client, items: [{ sourceId: "" }], now: NOW });
  assert.equal(res2.written, 0);
  assert.equal(calls.upsert.length, 0, "must not call supabase when every item is filtered out");
});

test("writeRecentItems: surfaces supabase errors via the { error } envelope (no throw)", async () => {
  const upsertError = { message: "rate limited" };
  const { client } = createRecordingClient({ upsertError });
  const res = await writeRecentItems({ supabase: client, items: [SAMPLE_ITEM], now: NOW });
  assert.equal(res.written, 0);
  assert.equal(res.error, upsertError, "supabase error must be returned, not thrown");
});

test("writeRecentItems: expires_at = fetched_at + ttlMs (defaults to 1h)", async () => {
  const { client, calls } = createRecordingClient();
  await writeRecentItems({ supabase: client, items: [SAMPLE_ITEM], now: NOW });
  const row = calls.upsert[0].rows[0];
  const fetched = Date.parse(row.fetched_at);
  const expires = Date.parse(row.expires_at);
  assert.equal(expires - fetched, 3_600_000, "default TTL must be exactly 1 hour");
});

// ─── purgeExpired ────────────────────────────────────────────────────────────

test("purgeExpired: deletes rows whose expires_at is before `now`", async () => {
  const { client, calls } = createRecordingClient({ deleteCount: 5 });
  const res = await purgeExpired({ supabase: client, now: NOW });
  assert.equal(res.purged, 5);
  assert.equal(res.error, null);
  assert.deepEqual(calls.from, [RECENT_ITEMS_CACHE_TABLE]);
  assert.equal(calls.delete.length, 1);
  assert.deepEqual(calls.delete[0], { count: "exact" });
  assert.equal(calls.lt.length, 1);
  assert.equal(calls.lt[0].column, "expires_at");
  assert.equal(calls.lt[0].value, "2026-05-27T12:00:00.000Z");
});

test("purgeExpired: surfaces supabase errors via the { error } envelope", async () => {
  const deleteError = { message: "constraint violation" };
  const { client } = createRecordingClient({ deleteError, deleteCount: 0 });
  const res = await purgeExpired({ supabase: client, now: NOW });
  assert.equal(res.purged, 0);
  assert.equal(res.error, deleteError);
});

// ─── readRecentItems (Sub-slice 2.3) ─────────────────────────────────────────

test("readRecentItems: queries by feed_id IN (…) and expires_at > now", async () => {
  const cacheRows = [
    { source_id: "s1", feed_id: "wapo-politics", url: "u1", headline: "h1", snippet: "b1",
      published_at: "2026-05-27T11:30:00.000Z", fetched_at: "2026-05-27T11:55:00.000Z", expires_at: "2026-05-27T12:55:00.000Z" },
  ];
  const { client, calls } = createRecordingClient({ selectRows: cacheRows });
  const res = await readRecentItems({
    supabase: client,
    feedIds: ["wapo-politics", "reuters-world-americas"],
    now: NOW,
  });
  assert.equal(res.error, null);
  assert.deepEqual(res.rows, cacheRows);
  assert.deepEqual(calls.from, [RECENT_ITEMS_CACHE_TABLE]);
  assert.equal(calls.select.length, 1, "select must be called once");
  assert.deepEqual(calls.in, [{ column: "feed_id", values: ["wapo-politics", "reuters-world-americas"] }]);
  assert.deepEqual(calls.gt, [{ column: "expires_at", value: "2026-05-27T12:00:00.000Z" }]);
});

test("readRecentItems: empty feedIds list short-circuits (no supabase call)", async () => {
  const { client, calls } = createRecordingClient();
  const res = await readRecentItems({ supabase: client, feedIds: [], now: NOW });
  assert.deepEqual(res.rows, []);
  assert.equal(res.error, null);
  assert.equal(calls.from.length, 0);
});

test("readRecentItems: surfaces supabase errors via the { rows: [], error } envelope", async () => {
  const selectError = { message: "timeout" };
  const { client } = createRecordingClient({ selectError });
  const res = await readRecentItems({ supabase: client, feedIds: ["wapo-politics"], now: NOW });
  assert.deepEqual(res.rows, []);
  assert.equal(res.error, selectError);
});

// ─── cacheRowsToRawItems (Sub-slice 2.3 read path) ───────────────────────────

const MANIFEST = [
  { id: "wapo-politics", name: "The Washington Post — Politics", publisher: "The Washington Post", kind: "rss", weight: 95, active: true, url: "https://wapo.example.com/politics.xml" },
  { id: "reuters-world-americas", name: "Reuters — World (Americas)", publisher: "Reuters", kind: "rss", weight: 88, active: true, url: "https://reuters.example.com/americas.xml" },
];

const CACHE_ROW = {
  source_id: "wapo-politics::abc123",
  feed_id: "wapo-politics",
  url: "https://wapo.example.com/article-1",
  headline: "Test headline",
  snippet: "First paragraph body.",
  published_at: "2026-05-27T11:30:00.000Z",
  fetched_at: "2026-05-27T11:55:00.000Z",
  expires_at: "2026-05-27T12:55:00.000Z",
};

test("cacheRowsToRawItems: joins each row with its manifest entry to recover outlet/kind/weight", () => {
  const [item] = cacheRowsToRawItems([CACHE_ROW], MANIFEST, { now: NOW });
  assert.equal(item.sourceId, "wapo-politics::abc123");
  assert.equal(item.feedId, "wapo-politics");
  assert.equal(item.outlet, "The Washington Post");
  // D1: manifest INGESTION kind "rss" maps to the contract kind "traditional"
  // (cache-origin items must never carry "rss" into the pipeline / schema).
  assert.equal(item.kind, "traditional");
  assert.equal(item.weight, 95);
  assert.equal(item.url, "https://wapo.example.com/article-1");
  assert.equal(item.headline, "Test headline");
  assert.deepEqual(item.body, ["First paragraph body."]);
});

test("cacheRowsToRawItems: minutesAgo computed from published_at against `now`", () => {
  const [item] = cacheRowsToRawItems([CACHE_ROW], MANIFEST, { now: NOW });
  // NOW = 12:00:00; published_at = 11:30:00 → 30 minutes ago
  assert.equal(item.minutesAgo, 30);
});

test("cacheRowsToRawItems: falls back to fetched_at when published_at is null", () => {
  const row = { ...CACHE_ROW, published_at: null };
  const [item] = cacheRowsToRawItems([row], MANIFEST, { now: NOW });
  // fetched_at = 11:55:00 → 5 minutes ago
  assert.equal(item.minutesAgo, 5);
});

test("cacheRowsToRawItems: snippet → body[] with empty fallback when snippet is null", () => {
  const [withSnippet] = cacheRowsToRawItems([CACHE_ROW], MANIFEST, { now: NOW });
  assert.deepEqual(withSnippet.body, ["First paragraph body."]);
  const [withoutSnippet] = cacheRowsToRawItems([{ ...CACHE_ROW, snippet: null }], MANIFEST, { now: NOW });
  assert.deepEqual(withoutSnippet.body, []);
});

test("cacheRowsToRawItems: manifest kind 'rss' maps to contract kind 'traditional' (D1)", () => {
  const [item] = cacheRowsToRawItems([CACHE_ROW], MANIFEST, { now: NOW });
  assert.equal(item.kind, "traditional");
});

test("cacheRowsToRawItems: manifest kind 'social' maps to contract kind 'social' (D1)", () => {
  const manifest = [{ id: "x-handle", name: "Some Handle", publisher: "Some Handle", kind: "social", weight: 60 }];
  const row = { ...CACHE_ROW, source_id: "x-handle::1", feed_id: "x-handle" };
  const [item] = cacheRowsToRawItems([row], manifest, { now: NOW });
  assert.equal(item.kind, "social");
});

test("cacheRowsToRawItems: rows without a manifest match get safe defaults (kind=traditional, weight=50)", () => {
  const orphan = { ...CACHE_ROW, source_id: "ghost::1", feed_id: "unknown-feed" };
  const [item] = cacheRowsToRawItems([orphan], MANIFEST, { now: NOW });
  assert.equal(item.kind, "traditional");
  assert.equal(item.weight, 50);
  assert.equal(item.outlet, "", "outlet falls through to empty when manifest is missing");
});

test("cacheRowsToRawItems: derives outlet from feed name when manifest lacks publisher", () => {
  const manifest = [{ id: "wapo-politics", name: "The Washington Post — Politics", kind: "rss", weight: 95 }];
  const [item] = cacheRowsToRawItems([CACHE_ROW], manifest, { now: NOW });
  assert.equal(item.outlet, "The Washington Post", "section suffix must be stripped via derive helper");
});

test("cacheRowsToRawItems: skips rows with empty source_id and returns [] for non-array input", () => {
  const rows = [{ ...CACHE_ROW, source_id: "" }, null];
  assert.deepEqual(cacheRowsToRawItems(rows, MANIFEST, { now: NOW }), []);
  assert.deepEqual(cacheRowsToRawItems(null, MANIFEST), []);
});
