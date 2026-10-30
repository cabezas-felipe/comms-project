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

test("listIngestionFeeds includes inactive feeds — active:false rows are not filtered out", async () => {
  // This endpoint is catalog/manifest visibility, not an active-only execution list.
  // Inactive feeds must appear so callers can see the full registry state.
  const rows = [
    {
      manifest_feed_id: "active-feed",
      rss_url: "https://example.com/active",
      social_profile_url: null,
      ingestion_weight: 70,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "Active Source", kind: "traditional" },
    },
    {
      manifest_feed_id: "inactive-feed",
      rss_url: "https://example.com/inactive",
      social_profile_url: null,
      ingestion_weight: 60,
      active: false,
      status: "mapped",
      source_entities: { canonical_name: "Inactive Source", kind: "traditional" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(feeds.length, 2, "Both active and inactive feeds must be returned");
  const inactive = feeds.find((f) => f.id === "inactive-feed");
  assert.ok(inactive, "Inactive feed must be present in results");
  assert.equal(inactive.active, false);
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

test("listIngestionFeeds: traditional RSS includes publisher from publisher_display_name (B1)", async () => {
  const rows = [
    {
      manifest_feed_id: "wapo-world",
      rss_url: "https://feeds.washingtonpost.com/rss/world",
      social_profile_url: null,
      ingestion_weight: 92,
      active: true,
      status: "mapped",
      source_entities: {
        canonical_name: "The Washington Post — World",
        kind: "traditional",
        publisher_display_name: "The Washington Post",
      },
    },
  ];
  const [feed] = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });
  assert.equal(feed.name, "The Washington Post — World");
  assert.equal(feed.publisher, "The Washington Post");
});

test("listIngestionFeeds: derives publisher from canonical_name when DB field null (B2)", async () => {
  const rows = [
    {
      manifest_feed_id: "wapo-politics",
      rss_url: "https://feeds.washingtonpost.com/rss/politics",
      social_profile_url: null,
      ingestion_weight: 95,
      active: true,
      status: "mapped",
      source_entities: {
        canonical_name: "The Washington Post — Politics",
        kind: "traditional",
        publisher_display_name: null,
      },
    },
  ];
  const [feed] = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });
  assert.equal(feed.publisher, "The Washington Post");
});

test("listIngestionFeeds: known Spanish feed ids carry lang='es' (DB-manifest language propagation)", async () => {
  const spanishIds = [
    "semana-politica",
    "semana-nacion",
    "semana-estados-unidos",
    "infobae-colombia",
    "infobae-estados-unidos",
    "silla-nacional",
  ];
  const rows = spanishIds.map((id, i) => ({
    manifest_feed_id: id,
    rss_url: `https://example.com/${id}.xml`,
    social_profile_url: null,
    ingestion_weight: 70 - i,
    active: true,
    status: "mapped",
    source_entities: { canonical_name: `${id} section`, kind: "traditional", publisher_display_name: "Pub" },
  }));

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(feeds.length, spanishIds.length);
  for (const id of spanishIds) {
    const feed = feeds.find((f) => f.id === id);
    assert.ok(feed, `feed ${id} present`);
    assert.equal(feed.lang, "es", `feed ${id} must carry lang='es'`);
  }
});

test("listIngestionFeeds: non-Spanish feeds do not get a lang key (no fabricated language)", async () => {
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
      manifest_feed_id: "semana-internacional",
      rss_url: "https://example.com/semana-intl.xml",
      social_profile_url: null,
      ingestion_weight: 60,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "Semana — Internacional", kind: "traditional", publisher_display_name: "Semana" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  for (const feed of feeds) {
    assert.equal("lang" in feed, false, `feed ${feed.id} must not carry a lang key`);
    assert.equal(feed.lang, undefined);
  }
});

test("listIngestionFeeds: Spanish lang tag does not disturb sorting, publisher, or active mapping", async () => {
  const rows = [
    {
      manifest_feed_id: "semana-nacion",
      rss_url: "https://example.com/semana-nacion.xml",
      social_profile_url: null,
      ingestion_weight: 70,
      active: false,
      status: "verified",
      source_entities: { canonical_name: "Semana — Nación", kind: "traditional", publisher_display_name: "Semana" },
    },
    {
      manifest_feed_id: "reuters-world",
      rss_url: "https://feeds.reuters.com/reuters/worldNews",
      social_profile_url: null,
      ingestion_weight: 95,
      active: true,
      status: "mapped",
      source_entities: { canonical_name: "Reuters — World News", kind: "traditional", publisher_display_name: "Reuters" },
    },
  ];

  const feeds = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });

  assert.equal(feeds[0].id, "reuters-world");
  assert.equal(feeds[1].id, "semana-nacion");
  const semana = feeds[1];
  assert.equal(semana.publisher, "Semana");
  assert.equal(semana.active, false);
  assert.equal(semana.lang, "es");
  assert.equal(feeds[0].publisher, "Reuters");
  assert.equal("lang" in feeds[0], false);
});

test("listIngestionFeeds: social rows omit publisher (F1)", async () => {
  const rows = [
    {
      manifest_feed_id: "latamwatcher",
      rss_url: null,
      social_profile_url: "https://twitter.com/latamwatcher",
      ingestion_weight: 50,
      active: true,
      status: "mapped",
      source_entities: {
        canonical_name: "@latamwatcher",
        kind: "social",
        publisher_display_name: null,
      },
    },
  ];
  const [feed] = await listIngestionFeeds({ supabase: makeMockSupabase(rows) });
  assert.equal(feed.kind, "social");
  assert.equal(feed.publisher, undefined);
});
