import { test } from "node:test";
import assert from "node:assert/strict";
import { listIngestionFeeds } from "./feed-manifest-repo.mjs";

// Builds a mock Supabase client that returns `rows` (or `error`) for the
// source_feed_mapping query chain used by listIngestionFeeds.
function makeMockSupabase(rows, error = null) {
  const result = { data: rows, error };
  const builder = {
    select: () => builder,
    in: () => builder,
    order: async () => result,
  };
  return { from: () => builder };
}

test("listIngestionFeeds returns feeds sorted weight-desc, name-asc", async () => {
  const rows = [
    {
      manifest_feed_id: "reuters-world",
      rss_url: "https://feeds.reuters.com/reuters/worldNews",
      social_profile_url: null,
      ingestion_weight: 88,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "Reuters — World News", kind: "traditional" },
    },
    {
      manifest_feed_id: "nyt-politics",
      rss_url: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
      social_profile_url: null,
      ingestion_weight: 95,
      active: true,
      status: "verified",
      source_entities: { canonical_name: "The New York Times — Politics", kind: "traditional" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(feeds.length, 2);
  assert.equal(feeds[0].id, "nyt-politics");
  assert.equal(feeds[0].weight, 95);
  assert.equal(feeds[0].kind, "rss");
  assert.equal(feeds[0].name, "The New York Times — Politics");
  assert.equal(feeds[1].id, "reuters-world");
  assert.equal(feeds[1].weight, 88);
});

test("listIngestionFeeds secondary sort: equal weight feeds ordered name-asc", async () => {
  const rows = [
    {
      manifest_feed_id: "zeta-feed",
      rss_url: "https://example.com/zeta",
      social_profile_url: null,
      ingestion_weight: 70,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "Zeta News", kind: "traditional" },
    },
    {
      manifest_feed_id: "alpha-feed",
      rss_url: "https://example.com/alpha",
      social_profile_url: null,
      ingestion_weight: 70,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "Alpha News", kind: "traditional" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(feeds[0].id, "alpha-feed");
  assert.equal(feeds[1].id, "zeta-feed");
});

test("listIngestionFeeds excludes rows with no URL", async () => {
  const rows = [
    {
      manifest_feed_id: "no-url-feed",
      rss_url: null,
      social_profile_url: null,
      ingestion_weight: 70,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "No URL Source", kind: "traditional" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });
  assert.equal(feeds.length, 0);
});

test("listIngestionFeeds uses social_profile_url and kind=social when rss_url absent", async () => {
  const rows = [
    {
      manifest_feed_id: "latamwatcher",
      rss_url: null,
      social_profile_url: "https://twitter.com/latamwatcher",
      ingestion_weight: 65,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "@latamwatcher", kind: "social" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].kind, "social");
  assert.equal(feeds[0].url, "https://twitter.com/latamwatcher");
  assert.equal(feeds[0].weight, 65);
  assert.equal(feeds[0].active, true);
});

test("listIngestionFeeds generates deterministic id when manifest_feed_id is null", async () => {
  const rows = [
    {
      manifest_feed_id: null,
      rss_url: "https://example.com/rss",
      social_profile_url: null,
      ingestion_weight: 50,
      active: false,
      status: "mapped",
      source_entities: { canonical_name: "Example Source — Beta", kind: "traditional" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].id, "example-source-beta");
  assert.equal(feeds[0].active, false);
});

test("listIngestionFeeds throws when DB returns error", async () => {
  await assert.rejects(
    () => listIngestionFeeds({ supabase: makeMockSupabase(null, { message: "connection failed" }) }),
    /connection failed/
  );
});

test("listIngestionFeeds returns empty array when no rows", async () => {
  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase([]) });
  assert.deepEqual(feeds, []);
});

test("listIngestionFeeds maps all required output fields", async () => {
  const rows = [
    {
      manifest_feed_id: "politico-congress",
      rss_url: "https://www.politico.com/rss/politicopicks.xml",
      social_profile_url: null,
      ingestion_weight: 80,
      active: true,
      status: "verified",
      source_entities: { canonical_name: "Politico — Congress", kind: "traditional" },
    },
  ];

  const [feed] = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(typeof feed.id, "string");
  assert.equal(typeof feed.name, "string");
  assert.equal(typeof feed.kind, "string");
  assert.equal(typeof feed.url, "string");
  assert.equal(typeof feed.weight, "number");
  assert.equal(typeof feed.active, "boolean");
});
