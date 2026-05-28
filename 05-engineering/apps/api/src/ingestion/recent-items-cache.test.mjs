import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecentItemRows,
  writeRecentItems,
  purgeExpired,
  RECENT_ITEMS_CACHE_TABLE,
} from "./recent-items-cache.mjs";

// Recording fake of the supabase-js fluent builder.  Captures the table name,
// upsert/delete arguments, and `.lt` calls so tests can pin the wire format
// without a real supabase round-trip.
function createRecordingClient({ upsertError = null, deleteError = null, deleteCount = 0 } = {}) {
  const calls = { from: [], upsert: [], delete: [], lt: [] };
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
