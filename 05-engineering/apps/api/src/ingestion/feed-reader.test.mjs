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
  resolveAllowlist,
  applyAllowlistGuard,
  normalizeAllowlist,
  parseAllowlistEnv,
  formatBlockedList,
  isAllowlistVerboseEnv,
} from "./feed-reader.mjs";

// Helpers shared across the new "restricted default + legacy alias" tests.
// Centralized so each test reads as "set this env shape, run, restore" without
// repeating boilerplate.
async function withAllowlistEnv({ newer, legacy, verboseNewer, verboseLegacy }, fn) {
  // Async-aware: must `await fn()` inside the try block — otherwise the
  // `finally` restores env synchronously, before the awaited inner work
  // (e.g. readFeedItems) ever reads `process.env`, and the test sees the
  // wrong env state.  Helper accepts both sync and async fn (await
  // resolves both).
  const PREV = {
    newer: process.env.TEMPO_RSS_ALLOWLIST,
    legacy: process.env.TEMPO_INGESTION_ALLOWLIST,
    verboseNewer: process.env.TEMPO_RSS_ALLOWLIST_VERBOSE,
    verboseLegacy: process.env.TEMPO_INGESTION_GUARD_VERBOSE,
  };
  const setOrDelete = (key, val) => {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  };
  setOrDelete("TEMPO_RSS_ALLOWLIST", newer);
  setOrDelete("TEMPO_INGESTION_ALLOWLIST", legacy);
  setOrDelete("TEMPO_RSS_ALLOWLIST_VERBOSE", verboseNewer);
  setOrDelete("TEMPO_INGESTION_GUARD_VERBOSE", verboseLegacy);
  try {
    return await fn();
  } finally {
    setOrDelete("TEMPO_RSS_ALLOWLIST", PREV.newer);
    setOrDelete("TEMPO_INGESTION_ALLOWLIST", PREV.legacy);
    setOrDelete("TEMPO_RSS_ALLOWLIST_VERBOSE", PREV.verboseNewer);
    setOrDelete("TEMPO_INGESTION_GUARD_VERBOSE", PREV.verboseLegacy);
  }
}
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

test("mapEntry: carries feedId from manifest row so source-selection can match by stable id", () => {
  // The source-selection stage uses item.feedId for an exact match against
  // selected feeds, surviving any canonical_name drift between the matcher's
  // manifest snapshot and the reader's.  Pin the field so a future refactor
  // can't drop the plumb-through.
  const feed = { id: "wapo-politics", name: "The Washington Post — Politics", weight: 95 };
  const m = mapEntry(feed, { title: "T", link: "https://x/a", guid: "a", pubDate: nowMinusMinutes(5) });
  assert.equal(m.feedId, "wapo-politics");
});

test("mapEntry: feedId is empty string when manifest row has no id (defensive)", () => {
  // Defensive: every manifest row should have an id, but if upstream loaders
  // ever surface an idless row we don't want `String(undefined)` to leak.
  const feed = { name: "Anonymous Source", weight: 50 };
  const m = mapEntry(feed, { title: "T", link: "https://x/a", guid: "a", pubDate: nowMinusMinutes(5) });
  assert.equal(m.feedId, "");
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
  // allowlist:null disables the guard so this test exercises live-fetching
  // mechanics across the full structurally-eligible set rather than getting
  // narrowed by the restricted default (["washington post"]).
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl: makeFetchMock(FETCH_MAP),
    manifestLoader: async () => SAMPLE_MANIFEST,
    allowlist: null,
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
  // allowlist:null — see fixture-coverage rationale on the previous test.
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl: makeFetchMock(FETCH_MAP),
    manifestLoader: async () => SAMPLE_MANIFEST,
    maxPerFeed: 1, // tight cap
    maxTotal: 100,
    allowlist: null,
  });
  // 1 per feed × 3 feeds = 3
  assert.equal(items.length, 3);
  // Each feed contributes its newest entry
  const ids = items.map((i) => i.url).sort();
  assert.deepEqual(ids, ["https://nyt/a", "https://wapo/pol-a", "https://wapo/world-a"]);
});

test("readFeedItems(live): global cap limits the merged pool (newest first)", async () => {
  // allowlist:null — tests global merge ordering across the full eligible set.
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl: makeFetchMock(FETCH_MAP),
    manifestLoader: async () => SAMPLE_MANIFEST,
    maxPerFeed: 100,
    maxTotal: 2,
    allowlist: null,
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
  // allowlist:null isolates this test to filterFeeds skip-path mechanics.
  // Without it, the restricted default would also block NYT and the
  // assertion below ("only the three eligible URLs were fetched") would
  // become a tautology with the allowlist guard rather than a check on
  // structural eligibility.
  await readFeedItems("/unused", {
    mode: "live",
    fetchImpl,
    manifestLoader: async () => SAMPLE_MANIFEST,
    allowlist: null,
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
  // allowlist:null — exercise per-feed failure isolation across the full
  // eligible set, not just the WaPo subset that matches the default.
  const items = await readFeedItems("/unused", {
    mode: "live",
    fetchImpl,
    manifestLoader: async () => SAMPLE_MANIFEST,
    allowlist: null,
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

// ─── Allowlist guard ─────────────────────────────────────────────────────────

test("normalizeAllowlist: trims, lowercases, collapses whitespace, drops empties, dedupes", () => {
  // Single-pass normalization contract that opts and env paths share — so a
  // user who passes `["  Reuters  ", "REUTERS"]` produces the same matcher
  // as a `TEMPO_RSS_ALLOWLIST="reuters,REUTERS"` env config.
  const out = normalizeAllowlist([
    "  Reuters  ",
    "REUTERS",                  // duplicate after lowercase → dedupe
    "Washington   Post",         // collapse internal whitespace
    "",                          // drop empty
    "   ",                       // drop whitespace-only
    null,                        // drop non-string
    42,                          // drop non-string
  ]);
  assert.deepEqual(out, ["reuters", "washington post"]);
});

test("parseAllowlistEnv: comma-split parity with normalizeAllowlist (trim/lowercase/collapse/drop)", () => {
  // Env path runs the same normalization — pin the parity so a future
  // refactor can't drift the two paths apart.
  assert.deepEqual(
    parseAllowlistEnv("  Reuters , REUTERS , Washington   Post , "),
    ["reuters", "washington post"]
  );
  assert.deepEqual(parseAllowlistEnv(""), []);
  assert.deepEqual(parseAllowlistEnv(undefined), []);
  assert.deepEqual(parseAllowlistEnv(null), []);
});

test("resolveAllowlist: opts.allowlist=null disables guard (returns null)", () => {
  // Explicit-disable contract: only `null` gets to bypass the env guard.
  // Anything else (undefined, "", arrays) goes through normalization.
  assert.equal(resolveAllowlist(null, "reuters,bbc"), null);
});

test("resolveAllowlist: opts.allowlist=undefined falls back to env (does NOT disable guard)", () => {
  // The whole point of the precedence rule: a caller that forgot to pass
  // an allowlist must NOT silently disable the operator's env-configured
  // guardrail.  Pin this so a future refactor can't loosen it.
  assert.deepEqual(resolveAllowlist(undefined, "reuters,bbc"), ["reuters", "bbc"]);
});

test("resolveAllowlist: Array opts override env", () => {
  // Caller-supplied list wins.  Env is ignored when opts is an explicit array.
  assert.deepEqual(resolveAllowlist(["NYT"], "reuters"), ["nyt"]);
});

test("resolveAllowlist: empty Array opts → empty allowlist (NOT null), env ignored", () => {
  // An empty array is still an explicit override — it should not silently
  // re-enable the env-configured allowlist.  An empty allowlist means
  // "permissive: no filter" (see applyAllowlistGuard).
  assert.deepEqual(resolveAllowlist([], "reuters"), []);
});

test("resolveAllowlist: env normalization parity — mixed case/whitespace produces same allowlist as opts", () => {
  // Direct parity check: same content via both paths must yield the same
  // normalized list, character for character.
  const fromOpts = resolveAllowlist(["  Reuters  ", "WASHINGTON POST"], undefined);
  const fromEnv = resolveAllowlist(undefined, "  Reuters  ,WASHINGTON POST");
  assert.deepEqual(fromOpts, fromEnv);
});

test("resolveAllowlist: unexpected types (string/object) fall back to env, do not disable", () => {
  // Defensive: a typo like `opts.allowlist = "reuters"` (string instead of
  // array) must not silently disable the guard.  We treat it as "undefined"
  // and resolve from env — the operator's intent stands.
  assert.deepEqual(resolveAllowlist("reuters", "bbc"), ["bbc"]);
  assert.deepEqual(resolveAllowlist({ a: 1 }, "bbc"), ["bbc"]);
});

test("applyAllowlistGuard: null allowlist allows every feed (guard disabled)", () => {
  const feeds = [{ id: "a", name: "Reuters" }, { id: "b", name: "NYT" }];
  const { allowed, blocked } = applyAllowlistGuard(feeds, null);
  assert.deepEqual(allowed.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(blocked, []);
});

test("applyAllowlistGuard: empty allowlist allows every feed (no filter to apply)", () => {
  // An empty allowlist (e.g. env unset, opts undefined) is the "permissive
  // default" — distinct from `null` (explicit disable) but functionally
  // equivalent at the filter step.
  const feeds = [{ id: "a", name: "Reuters" }, { id: "b", name: "NYT" }];
  const { allowed, blocked } = applyAllowlistGuard(feeds, []);
  assert.deepEqual(allowed.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(blocked, []);
});

test("applyAllowlistGuard: non-empty allowlist substring-matches feed names case-insensitively", () => {
  // Substring match keeps publisher-level allowlist entries working against
  // section-level feed names — `"reuters"` covers `"Reuters — World News"`.
  const feeds = [
    { id: "wapo-pol", name: "The Washington Post — Politics" },
    { id: "reuters-world", name: "Reuters — World News" },
    { id: "nyt", name: "The New York Times — Politics" },
  ];
  const { allowed, blocked } = applyAllowlistGuard(feeds, ["reuters"]);
  assert.deepEqual(allowed.map((f) => f.id), ["reuters-world"]);
  assert.deepEqual(blocked.map((f) => f.id), ["wapo-pol", "nyt"]);
});

test("formatBlockedList: returns null when nothing blocked (no log line emitted)", () => {
  // Skipping the log line entirely on empty input keeps the operator's view
  // clean — no `blocked=0` chatter.
  assert.equal(formatBlockedList([]), null);
  assert.equal(formatBlockedList(undefined), null);
});

test("formatBlockedList: default mode caps the rendered list and appends '...and N more'", () => {
  // 8 blocked feeds, default cap=5: render 5 ids + "...and 3 more".
  const blocked = Array.from({ length: 8 }, (_, i) => ({ id: `feed-${i}`, name: `Feed ${i}` }));
  const out = formatBlockedList(blocked, { verbose: false, cap: 5 });
  assert.match(out, /^blocked=8 \[feed-0, feed-1, feed-2, feed-3, feed-4, \.\.\.and 3 more\]$/);
});

test("formatBlockedList: default mode renders full list when total ≤ cap (no '...and 0 more')", () => {
  // Boundary: when the cap isn't exceeded the trailing summary must NOT
  // appear — it would mislead operators reading the log.
  const blocked = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const out = formatBlockedList(blocked, { verbose: false, cap: 5 });
  assert.equal(out, "blocked=2 [a, b]");
  assert.equal(out.includes("more"), false);
});

test("formatBlockedList: verbose mode prints full list regardless of cap", () => {
  // The verbose escape hatch matters during incident response — operators
  // need every blocked feed in one line so they can grep for a specific id.
  const blocked = Array.from({ length: 12 }, (_, i) => ({ id: `feed-${i}` }));
  const out = formatBlockedList(blocked, { verbose: true, cap: 3 });
  assert.match(out, /^blocked=12 \[feed-0, feed-1, feed-2, feed-3, feed-4, feed-5, feed-6, feed-7, feed-8, feed-9, feed-10, feed-11\]$/);
  assert.equal(out.includes("more"), false);
});

test("readFeedItems(live): opts.allowlist=undefined falls through to TEMPO_RSS_ALLOWLIST (does NOT disable guard)", async () => {
  // End-to-end: env-configured allowlist must apply when caller is silent.
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  const prev = process.env.TEMPO_RSS_ALLOWLIST;
  process.env.TEMPO_RSS_ALLOWLIST = "washington post";
  try {
    await readFeedItems("/unused", {
      mode: "live",
      fetchImpl,
      manifestLoader: async () => SAMPLE_MANIFEST,
      // allowlist intentionally omitted — must fall back to env
    });
    const sortedCalls = [...calls].sort();
    assert.deepEqual(sortedCalls, [
      "https://wapo.example.com/politics.xml",
      "https://wapo.example.com/world.xml",
    ], "only WaPo feeds fetched — NYT blocked by allowlist");
  } finally {
    if (prev === undefined) delete process.env.TEMPO_RSS_ALLOWLIST;
    else process.env.TEMPO_RSS_ALLOWLIST = prev;
  }
});

test("readFeedItems(live): opts.allowlist=null disables guard even with TEMPO_RSS_ALLOWLIST set", async () => {
  // Explicit caller override — disables the env-configured guard so every
  // structurally-eligible feed gets fetched.
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  const prev = process.env.TEMPO_RSS_ALLOWLIST;
  process.env.TEMPO_RSS_ALLOWLIST = "el tiempo"; // would normally block all manifest rows
  try {
    await readFeedItems("/unused", {
      mode: "live",
      fetchImpl,
      manifestLoader: async () => SAMPLE_MANIFEST,
      allowlist: null, // explicit disable
    });
    const sortedCalls = [...calls].sort();
    assert.deepEqual(sortedCalls, [
      "https://nyt.example.com/politics.xml",
      "https://wapo.example.com/politics.xml",
      "https://wapo.example.com/world.xml",
    ], "all 3 eligible feeds fetched despite restrictive env allowlist");
  } finally {
    if (prev === undefined) delete process.env.TEMPO_RSS_ALLOWLIST;
    else process.env.TEMPO_RSS_ALLOWLIST = prev;
  }
});

// ─── Restricted default + legacy alias precedence (Phase 3 fix patch) ───────

test("resolveAllowlist: unset env + opts undefined → DEFAULT_ALLOWLIST (NOT permissive)", () => {
  // Codex-flagged regression: when neither newer nor legacy env is set, the
  // resolver MUST fall back to the hardcoded restricted default rather than
  // returning an empty (permissive) list.  This prevents future manifest
  // expansion from silently widening ingestion.  Snapshot form decouples
  // the assertion from process.env state.
  const result = resolveAllowlist(undefined, { newer: undefined, legacy: undefined });
  // The default is intentionally WaPo-scoped to mirror the source-by-source
  // rollout posture documented in data/source-feeds.json.
  assert.deepEqual(result, ["washington post"]);
  assert.notEqual(result.length, 0, "default must NOT be permissive empty list");
});

test("resolveAllowlist: legacy TEMPO_INGESTION_ALLOWLIST drives behavior when newer is unset", () => {
  // Backward-compat: ops configs that pre-date the rss-scoped naming must
  // keep working.  Legacy env behaves identically to the newer var when
  // it's the only one set.
  const result = resolveAllowlist(undefined, { newer: undefined, legacy: "El Tiempo, BBC" });
  assert.deepEqual(result, ["el tiempo", "bbc"]);
});

test("resolveAllowlist: legacy env takes precedence over default", () => {
  // The default is a *fallback* — once any operator config is present, the
  // default steps aside.  Pinning this so a future refactor can't promote
  // the default ahead of operator intent.
  const result = resolveAllowlist(undefined, { newer: undefined, legacy: "reuters" });
  assert.deepEqual(result, ["reuters"]);
});

test("resolveAllowlist: alias precedence — newer wins when BOTH env vars are set", () => {
  // Documented precedence: when both TEMPO_RSS_ALLOWLIST and
  // TEMPO_INGESTION_ALLOWLIST carry values, the newer (rss-scoped) name
  // takes effect.  Operators migrating from the legacy name will see the
  // newer value win, which is the intended migration direction.
  const result = resolveAllowlist(undefined, {
    newer: "Reuters, NYT",
    legacy: "El Tiempo, BBC",
  });
  assert.deepEqual(result, ["reuters", "nyt"], "newer var must win when both are set");
});

test("resolveAllowlist: empty newer falls through to legacy (does NOT silently flip permissive)", () => {
  // Defensive: a deploy that clears the newer var (e.g., `unset
  // TEMPO_RSS_ALLOWLIST` accidentally) MUST fall through to the legacy
  // value rather than collapsing to empty/permissive.  This is the safety
  // property Codex's review highlighted.
  const result = resolveAllowlist(undefined, {
    newer: "",
    legacy: "reuters",
  });
  assert.deepEqual(result, ["reuters"]);
});

test("resolveAllowlist: newer set to garbage that normalizes to empty falls through to legacy", () => {
  // Garbage like ", , " normalizes to [] and must NOT widen ingestion to
  // permissive.  Falls through to legacy / default per the documented
  // "non-empty wins" rule.
  const result = resolveAllowlist(undefined, {
    newer: " , , , ",
    legacy: "reuters",
  });
  assert.deepEqual(result, ["reuters"]);
});

test("resolveAllowlist: both env vars empty/garbage → DEFAULT_ALLOWLIST", () => {
  // Final fallback: with nothing usable from either env source the
  // restricted default still applies.  Ingestion never silently widens.
  const result = resolveAllowlist(undefined, {
    newer: " , , ",
    legacy: "",
  });
  assert.deepEqual(result, ["washington post"]);
});

test("resolveAllowlist: opts=null disables guard regardless of env", () => {
  // Re-pin with the new snapshot signature: explicit-disable still wins
  // over ANY env (newer, legacy, or default).
  assert.equal(resolveAllowlist(null, { newer: "reuters", legacy: "bbc" }), null);
  assert.equal(resolveAllowlist(null, { newer: undefined, legacy: undefined }), null);
});

test("resolveAllowlist: opts=Array overrides every env source", () => {
  // Re-pin: array opts beats both env vars regardless of which one carries
  // a value.
  const out = resolveAllowlist(["NYT"], { newer: "reuters", legacy: "bbc" });
  assert.deepEqual(out, ["nyt"]);
});

test("resolveAllowlist: reads from process.env when called without explicit env arg", () => {
  // Production wire-up: readLiveItems calls resolveAllowlist(opts.allowlist)
  // with no env arg, so the resolver must read process.env on its own.
  // This pins that path so a future refactor can't drop it without flagging.
  withAllowlistEnv({ newer: "reuters", legacy: undefined }, () => {
    assert.deepEqual(resolveAllowlist(undefined), ["reuters"]);
  });
  withAllowlistEnv({ newer: undefined, legacy: "bbc" }, () => {
    assert.deepEqual(resolveAllowlist(undefined), ["bbc"]);
  });
  withAllowlistEnv({ newer: undefined, legacy: undefined }, () => {
    assert.deepEqual(resolveAllowlist(undefined), ["washington post"]);
  });
});

test("isAllowlistVerboseEnv: legacy TEMPO_INGESTION_GUARD_VERBOSE still drives verbose output when newer is unset", () => {
  // Backward-compat: existing deploys that toggle verbose via the legacy
  // var name keep working.  No silent ignoring of the legacy flag.
  withAllowlistEnv({ verboseNewer: undefined, verboseLegacy: "true" }, () => {
    assert.equal(isAllowlistVerboseEnv(), true);
  });
  withAllowlistEnv({ verboseNewer: undefined, verboseLegacy: "false" }, () => {
    assert.equal(isAllowlistVerboseEnv(), false);
  });
  withAllowlistEnv({ verboseNewer: undefined, verboseLegacy: undefined }, () => {
    assert.equal(isAllowlistVerboseEnv(), false);
  });
});

test("isAllowlistVerboseEnv: newer wins when set, legacy ignored even if 'true'", () => {
  // Newer "false" trumps legacy "true": operator's most recent intent stands.
  withAllowlistEnv({ verboseNewer: "false", verboseLegacy: "true" }, () => {
    assert.equal(isAllowlistVerboseEnv(), false);
  });
  withAllowlistEnv({ verboseNewer: "true", verboseLegacy: "false" }, () => {
    assert.equal(isAllowlistVerboseEnv(), true);
  });
});

test("readFeedItems(live): unset env + opts undefined → DEFAULT_ALLOWLIST restricts to WaPo feeds only", async () => {
  // End-to-end wire-up: with both newer and legacy env unset and no caller
  // override, the live reader must apply the restricted default.  NYT
  // (structurally eligible) gets blocked because it doesn't match
  // "washington post".  This is the exact regression Codex flagged: prior
  // to the fix patch the unset-env path returned [] (permissive) and NYT
  // would have been fetched.
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  await withAllowlistEnv({ newer: undefined, legacy: undefined }, async () => {
    await readFeedItems("/unused", {
      mode: "live",
      fetchImpl,
      manifestLoader: async () => SAMPLE_MANIFEST,
      // opts.allowlist intentionally omitted — must hit the default.
    });
  });
  const sortedCalls = [...calls].sort();
  assert.deepEqual(sortedCalls, [
    "https://wapo.example.com/politics.xml",
    "https://wapo.example.com/world.xml",
  ], "default allowlist must restrict to WaPo; NYT must NOT be fetched");
});

test("readFeedItems(live): legacy TEMPO_INGESTION_ALLOWLIST drives the live guard when newer unset", async () => {
  // Backward-compat for deploys that haven't migrated to the rss-scoped
  // env var.  Legacy alone selects exactly what newer alone would.
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  await withAllowlistEnv({ newer: undefined, legacy: "new york times" }, async () => {
    await readFeedItems("/unused", {
      mode: "live",
      fetchImpl,
      manifestLoader: async () => SAMPLE_MANIFEST,
    });
  });
  assert.deepEqual(calls, ["https://nyt.example.com/politics.xml"]);
});

test("readFeedItems(live): both env vars set → newer wins (alias precedence at wire-up)", async () => {
  // Pins the alias precedence rule end-to-end: the live reader respects
  // newer-wins so an operator who sets the rss-scoped var sees its effect
  // even if the legacy var is still configured (typical mid-migration).
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  await withAllowlistEnv({ newer: "washington post", legacy: "new york times" }, async () => {
    await readFeedItems("/unused", {
      mode: "live",
      fetchImpl,
      manifestLoader: async () => SAMPLE_MANIFEST,
    });
  });
  const sortedCalls = [...calls].sort();
  assert.deepEqual(sortedCalls, [
    "https://wapo.example.com/politics.xml",
    "https://wapo.example.com/world.xml",
  ], "newer var wins; legacy NYT entry must NOT take effect");
});

test("readFeedItems(live): legacy verbose env enables full blocked-list logging", async () => {
  // Pin the wire-up of the legacy verbose alias.  Capture console.log to
  // assert the guard log line carries every blocked feed (no "...and N
  // more" truncation) when the legacy var is set to "true".
  const captured = [];
  const origLog = console.log;
  console.log = (msg) => { captured.push(String(msg)); };
  try {
    await withAllowlistEnv({
      newer: "washington post",  // restricts to WaPo so NYT is blocked
      legacy: undefined,
      verboseNewer: undefined,
      verboseLegacy: "true",      // legacy verbose flag
    }, async () => {
      await readFeedItems("/unused", {
        mode: "live",
        fetchImpl: makeFetchMock(FETCH_MAP),
        manifestLoader: async () => SAMPLE_MANIFEST,
      });
    });
  } finally {
    console.log = origLog;
  }
  const allowlistLog = captured.find((m) => m.includes("[feed-reader.live] allowlist"));
  assert.ok(allowlistLog, "expected an allowlist log line");
  // Verbose mode must NOT include the "...and N more" truncation marker.
  assert.equal(allowlistLog.includes("more"), false, `verbose log must not truncate: ${allowlistLog}`);
  // The blocked NYT feed id must appear in full.
  assert.ok(allowlistLog.includes("nyt"), `blocked NYT id missing from verbose log: ${allowlistLog}`);
});

test("readFeedItems(live): opts.allowlist (Array) overrides env", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeFetchMock(FETCH_MAP)(url);
  };
  const prev = process.env.TEMPO_RSS_ALLOWLIST;
  process.env.TEMPO_RSS_ALLOWLIST = "washington post"; // would normally allow only WaPo
  try {
    await readFeedItems("/unused", {
      mode: "live",
      fetchImpl,
      manifestLoader: async () => SAMPLE_MANIFEST,
      allowlist: ["new york times"], // override → only NYT
    });
    assert.deepEqual(calls, ["https://nyt.example.com/politics.xml"]);
  } finally {
    if (prev === undefined) delete process.env.TEMPO_RSS_ALLOWLIST;
    else process.env.TEMPO_RSS_ALLOWLIST = prev;
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
