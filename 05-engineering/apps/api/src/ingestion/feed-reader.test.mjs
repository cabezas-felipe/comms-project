import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readFeedItems,
  filterFeeds,
  mapEntry,
  stripHtml,
} from "./feed-reader.mjs";
import { normalizeSourceItems } from "./source-normalizer.mjs";

// ─── Inline RSS XML samples ──────────────────────────────────────────────────

function rssXml({ title = "Test Feed", items }) {
  const itemBlocks = items
    .map(
      (it) => `
    <item>
      <title>${it.title ?? ""}</title>
      <link>${it.link ?? ""}</link>
      <guid>${it.guid ?? it.link ?? ""}</guid>
      <pubDate>${it.pubDate ?? ""}</pubDate>
      <description>${it.description ?? ""}</description>
    </item>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${title}</title>
    <link>https://example.com</link>
    <description>A feed</description>${itemBlocks}
  </channel>
</rss>`;
}

function nowMinusMinutes(min) {
  return new Date(Date.now() - min * 60_000).toUTCString();
}

function makeFetchMock(map) {
  // map: { [url]: { ok, status, body } }
  return async (url) => {
    const entry = map[url];
    if (!entry) {
      return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
    }
    return {
      ok: entry.ok ?? true,
      status: entry.status ?? 200,
      statusText: entry.statusText ?? "OK",
      text: async () => entry.body,
    };
  };
}

// ─── stripHtml ───────────────────────────────────────────────────────────────

test("stripHtml: removes tags and collapses whitespace", () => {
  assert.equal(stripHtml("<p>Hello <b>world</b></p>"), "Hello world");
});

test("stripHtml: decodes common entities", () => {
  assert.equal(stripHtml("Tom &amp; Jerry &lt;3 &quot;hi&quot;"), 'Tom & Jerry <3 "hi"');
});

test("stripHtml: decodes numeric and hex entities", () => {
  assert.equal(stripHtml("caf&#233;"), "café");
  assert.equal(stripHtml("&#x2014;"), "—");
});

test("stripHtml: returns empty string on null/undefined", () => {
  assert.equal(stripHtml(null), "");
  assert.equal(stripHtml(undefined), "");
});

// ─── filterFeeds ─────────────────────────────────────────────────────────────

const SAMPLE_MANIFEST = [
  { id: "wapo-pol", name: "Washington Post — Politics", kind: "rss", url: "https://wapo.example.com/politics.xml", weight: 95, active: true },
  { id: "wapo-world", name: "Washington Post — World", kind: "rss", url: "https://wapo.example.com/world.xml", weight: 90, active: true },
  { id: "nyt", name: "The New York Times — Politics", kind: "rss", url: "https://nyt.example.com/politics.xml", weight: 92, active: true },
  { id: "social-x", name: "@somehandle", kind: "social", url: "https://twitter.com/somehandle", weight: 60, active: true },
  { id: "wapo-inactive", name: "Washington Post — Sports", kind: "rss", url: "https://wapo.example.com/sports.xml", weight: 40, active: false },
  { id: "broken", name: "Broken Feed", kind: "rss", url: "not-a-url", weight: 10, active: true },
];

test("filterFeeds: keeps only active rss with valid URL", () => {
  const { eligible, skipped } = filterFeeds(SAMPLE_MANIFEST, "");
  const ids = eligible.map((f) => f.id).sort();
  assert.deepEqual(ids, ["nyt", "wapo-pol", "wapo-world"]);
  assert.equal(skipped.length, 3);
  const reasons = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
  assert.equal(reasons["social-x"], "non_rss");
  assert.equal(reasons["wapo-inactive"], "inactive");
  assert.equal(reasons["broken"], "invalid_url");
});

test("filterFeeds: TEMPO_RSS_PUBLISHER substring match (case + whitespace insensitive)", () => {
  const { eligible } = filterFeeds(SAMPLE_MANIFEST, "  WASHINGTON   post ");
  const ids = eligible.map((f) => f.id).sort();
  assert.deepEqual(ids, ["wapo-pol", "wapo-world"], "all WaPo section feeds matched");
});

test("filterFeeds: empty publisher returns all eligible", () => {
  const { eligible } = filterFeeds(SAMPLE_MANIFEST, "");
  assert.equal(eligible.length, 3);
});

test("filterFeeds: publisher with no match returns empty eligible", () => {
  const { eligible, skipped } = filterFeeds(SAMPLE_MANIFEST, "el tiempo");
  assert.equal(eligible.length, 0);
  // All RSS-and-active feeds get skipped with reason publisher_filter
  const reasons = skipped.filter((s) => s.reason === "publisher_filter").length;
  assert.ok(reasons >= 1);
});

// ─── mapEntry ────────────────────────────────────────────────────────────────

test("mapEntry: produces stable sourceId per feed+guid (idempotent)", () => {
  const feed = { id: "wapo-pol", name: "Washington Post — Politics", weight: 95 };
  const entry = { title: "T", link: "https://wapo.example.com/article-1", guid: "wapo-1", pubDate: nowMinusMinutes(10) };
  const a = mapEntry(feed, entry);
  const b = mapEntry(feed, entry);
  assert.equal(a.sourceId, b.sourceId, "same feed+guid must yield same sourceId");
});

test("mapEntry: different entries produce different sourceIds", () => {
  const feed = { id: "wapo-pol", name: "Washington Post — Politics", weight: 95 };
  const a = mapEntry(feed, { title: "A", link: "https://x/a", guid: "a", pubDate: nowMinusMinutes(5) });
  const b = mapEntry(feed, { title: "B", link: "https://x/b", guid: "b", pubDate: nowMinusMinutes(5) });
  assert.notEqual(a.sourceId, b.sourceId);
});

test("mapEntry: HTML in title/description is stripped to plain text", () => {
  const feed = { id: "f", name: "F", weight: 50 };
  const entry = {
    title: "<b>Hot</b> &amp; cold",
    link: "https://x/article",
    description: "<p>First para.</p><p>Second &mdash; with em dash.</p>",
    pubDate: nowMinusMinutes(20),
  };
  const m = mapEntry(feed, entry);
  assert.equal(m.headline, "Hot & cold");
  assert.deepEqual(m.body, ["First para. Second — with em dash."]);
});

test("mapEntry: minutesAgo computed from pubDate, defaults to 0 when date missing", () => {
  const feed = { id: "f", name: "F", weight: 50 };
  const fetchedAt = Date.now();
  const recent = mapEntry(feed, { title: "T", link: "https://x/a", guid: "a", pubDate: nowMinusMinutes(45) }, fetchedAt);
  assert.ok(recent.minutesAgo >= 44 && recent.minutesAgo <= 46, `expected ~45, got ${recent.minutesAgo}`);

  const noDate = mapEntry(feed, { title: "T", link: "https://x/b", guid: "b" }, fetchedAt);
  assert.equal(noDate.minutesAgo, 0, "missing date → minutesAgo defaults to 0");
});

test("mapEntry: clusterId is omitted (filled by normalizer with provisional:${sourceId})", () => {
  const feed = { id: "f", name: "F", weight: 50 };
  const m = mapEntry(feed, { title: "T", link: "https://x/a", guid: "a", pubDate: nowMinusMinutes(5) });
  assert.equal(m.clusterId, undefined);
  const { items } = normalizeSourceItems([m]);
  assert.equal(items.length, 1);
  assert.equal(items[0].clusterId, `provisional:${m.sourceId}`);
});

test("mapEntry: returns null for entry with no headline and no link", () => {
  const feed = { id: "f", name: "F", weight: 50 };
  assert.equal(mapEntry(feed, {}), null);
});

// ─── readFeedItems (live mode) ──────────────────────────────────────────────

const FETCHED_AT_MIN = (n) => nowMinusMinutes(n);

const WAPO_POL_XML = rssXml({
  title: "WaPo Politics",
  items: [
    { title: "Politics A", link: "https://wapo/pol-a", guid: "pol-a", pubDate: FETCHED_AT_MIN(10), description: "<p>Body A.</p>" },
    { title: "Politics B", link: "https://wapo/pol-b", guid: "pol-b", pubDate: FETCHED_AT_MIN(60), description: "Body B" },
    { title: "Politics C", link: "https://wapo/pol-c", guid: "pol-c", pubDate: FETCHED_AT_MIN(180), description: "Body C" },
  ],
});
const WAPO_WORLD_XML = rssXml({
  title: "WaPo World",
  items: [
    { title: "World &amp; Diplomacy", link: "https://wapo/world-a", guid: "world-a", pubDate: FETCHED_AT_MIN(5), description: "<b>World</b> body." },
    { title: "World B", link: "https://wapo/world-b", guid: "world-b", pubDate: FETCHED_AT_MIN(120), description: "World body B" },
  ],
});
const NYT_XML = rssXml({
  title: "NYT Politics",
  items: [
    { title: "NYT A", link: "https://nyt/a", guid: "nyt-a", pubDate: FETCHED_AT_MIN(15), description: "NYT body" },
  ],
});

const FETCH_MAP = {
  "https://wapo.example.com/politics.xml": { body: WAPO_POL_XML },
  "https://wapo.example.com/world.xml": { body: WAPO_WORLD_XML },
  "https://nyt.example.com/politics.xml": { body: NYT_XML },
};

test("readFeedItems(live): fetches every eligible feed, maps entries, returns plain-text bodies", async () => {
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl: makeFetchMock(FETCH_MAP),
    manifestLoader: async () => SAMPLE_MANIFEST,
  });
  // 3 + 2 + 1 = 6 mapped items from the three eligible feeds
  assert.equal(items.length, 6);
  // Plain text — no HTML tags or unescaped entities
  for (const it of items) {
    assert.ok(!/<[a-z]/.test(it.headline), `headline must be plain text: ${it.headline}`);
    assert.ok(!/&amp;|&lt;|&gt;/.test(it.headline), `entities must be decoded: ${it.headline}`);
  }
  // Specific entity decoding check
  const entityItem = items.find((i) => i.headline === "World & Diplomacy");
  assert.ok(entityItem, "&amp; in title must be decoded to &");
});

test("readFeedItems(live): per-feed cap limits items from a single feed (newest first)", async () => {
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl: makeFetchMock(FETCH_MAP),
    manifestLoader: async () => SAMPLE_MANIFEST,
    maxPerFeed: 1, // tight cap
    maxTotal: 100,
  });
  // 1 per feed × 3 feeds = 3
  assert.equal(items.length, 3);
  // Each feed contributes its newest entry
  const ids = items.map((i) => i.url).sort();
  assert.deepEqual(ids, ["https://nyt/a", "https://wapo/pol-a", "https://wapo/world-a"]);
});

test("readFeedItems(live): global cap limits the merged pool (newest first)", async () => {
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl: makeFetchMock(FETCH_MAP),
    manifestLoader: async () => SAMPLE_MANIFEST,
    maxPerFeed: 100,
    maxTotal: 2,
  });
  assert.equal(items.length, 2);
  // The two newest across all feeds:
  // world-a (5min) and pol-a (10min) — both newer than nyt-a (15min)
  const urls = items.map((i) => i.url).sort();
  assert.deepEqual(urls, ["https://wapo/pol-a", "https://wapo/world-a"]);
});

test("readFeedItems(live): non-RSS / inactive / invalid-URL rows are skipped (not fetched)", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  await readFeedItems("/unused", {
    mode: "live",
    fetchImpl,
    manifestLoader: async () => SAMPLE_MANIFEST,
  });
  // Only the three eligible URLs should have been fetched
  const sortedCalls = [...calls].sort();
  assert.deepEqual(sortedCalls, [
    "https://nyt.example.com/politics.xml",
    "https://wapo.example.com/politics.xml",
    "https://wapo.example.com/world.xml",
  ]);
});

test("readFeedItems(live): publisher filter restricts fetched feeds", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  const prev = process.env.TEMPO_RSS_PUBLISHER;
  process.env.TEMPO_RSS_PUBLISHER = "Washington Post";
  try {
    await readFeedItems("/unused", {
      mode: "live",
      fetchImpl,
      manifestLoader: async () => SAMPLE_MANIFEST,
    });
    const sortedCalls = [...calls].sort();
    assert.deepEqual(sortedCalls, [
      "https://wapo.example.com/politics.xml",
      "https://wapo.example.com/world.xml",
    ]);
  } finally {
    if (prev === undefined) delete process.env.TEMPO_RSS_PUBLISHER;
    else process.env.TEMPO_RSS_PUBLISHER = prev;
  }
});

test("readFeedItems(live): individual feed failure does not abort the whole refresh", async () => {
  const fetchImpl = async (url) => {
    if (url === "https://wapo.example.com/world.xml") {
      throw new Error("ECONNRESET");
    }
    return makeFetchMock(FETCH_MAP)(url);
  };
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl,
    manifestLoader: async () => SAMPLE_MANIFEST,
  });
  // pol-* (3) + nyt (1) = 4; world-* skipped due to fetch error
  assert.equal(items.length, 4);
});

test("readFeedItems(live): non-2xx response is treated as fetch failure (skipped, not thrown)", async () => {
  const fetchImpl = async (url) => {
    if (url === "https://nyt.example.com/politics.xml") {
      return { ok: false, status: 503, statusText: "Service Unavailable", text: async () => "" };
    }
    return makeFetchMock(FETCH_MAP)(url);
  };
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl,
    manifestLoader: async () => SAMPLE_MANIFEST,
  });
  // 3 + 2 + 0 = 5
  assert.equal(items.length, 5);
});

test("readFeedItems(live) → normalizer: clusterId defaulted to provisional:${sourceId}", async () => {
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl: makeFetchMock(FETCH_MAP),
    manifestLoader: async () => SAMPLE_MANIFEST,
  });
  const { items: normalized, errors } = normalizeSourceItems(items);
  assert.equal(errors.length, 0, `unexpected normalize errors: ${JSON.stringify(errors)}`);
  assert.equal(normalized.length, items.length);
  for (const n of normalized) {
    assert.ok(n.clusterId.startsWith("provisional:"), `clusterId must be provisional: ${n.clusterId}`);
    assert.equal(n.clusterId, `provisional:${n.sourceId}`);
  }
});

// ─── Fixture mode (back-compat) ─────────────────────────────────────────────

test("readFeedItems(fixture): reads source-items.json unchanged", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "feed-reader-"));
  try {
    const fixture = [
      { clusterId: "c1", sourceId: "s1", outlet: "Outlet", kind: "traditional", weight: 50, url: "#", minutesAgo: 5, headline: "H", body: ["B"] },
    ];
    await writeFile(path.join(tmp, "source-items.json"), JSON.stringify(fixture), "utf8");
    const items = await readFeedItems(tmp, { mode: "fixture" });
    assert.deepEqual(items, fixture);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("readFeedItems: env TEMPO_RSS_INGESTION=fixture preserves fixture path", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "feed-reader-env-"));
  const prev = process.env.TEMPO_RSS_INGESTION;
  process.env.TEMPO_RSS_INGESTION = "fixture";
  try {
    const fixture = [
      { clusterId: "c1", sourceId: "s1", outlet: "Outlet", kind: "traditional", weight: 50, url: "#", minutesAgo: 5, headline: "H", body: ["B"] },
    ];
    await writeFile(path.join(tmp, "source-items.json"), JSON.stringify(fixture), "utf8");
    const items = await readFeedItems(tmp);
    assert.equal(items.length, 1);
  } finally {
    if (prev === undefined) delete process.env.TEMPO_RSS_INGESTION;
    else process.env.TEMPO_RSS_INGESTION = prev;
    await rm(tmp, { recursive: true, force: true });
  }
});

// ─── Optional live smoke (skipped by default) ────────────────────────────────

describe("live smoke (skipped by default; set TEMPO_RSS_LIVE_SMOKE=true to enable)", () => {
  const enabled = process.env.TEMPO_RSS_LIVE_SMOKE === "true";
  test("hits a real RSS endpoint and returns at least one mapped item", { skip: !enabled }, async () => {
    const items = await readFeedItems("/unused", {
      mode: "live",
      manifestLoader: async () => [
        { id: "smoke-feed", name: "Smoke Feed", kind: "rss", url: process.env.TEMPO_RSS_LIVE_SMOKE_URL ?? "", weight: 50, active: true },
      ],
    });
    assert.ok(items.length > 0, "live smoke must return at least one item");
  });
});
