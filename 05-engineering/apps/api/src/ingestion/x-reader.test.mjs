import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHandle,
  computeStartTimeIso,
  mapTweetToRawItem,
  readXItems,
} from "./x-reader.mjs";
import { __clearUserCache } from "./x-api-client.mjs";

// ─── Fetch mock ──────────────────────────────────────────────────────────────
//
// readXItems goes through the real Step 1.1 client, so the mock must speak the
// X API wire protocol. We route by URL: `/users/by/username/<u>` returns a user
// lookup; `/users/<id>/tweets` returns a tweet page. Per-username scripting lets
// each test stage pages / errors deterministically.

function createXApiMock({ users = {}, tweetPages = {}, errorStatusFor = {} } = {}) {
  const calls = { lookups: [], tweets: [] };
  // Track which page each user id is on across paginated calls.
  const pageCursor = new Map();

  const fetchImpl = async (url) => {
    const lookup = url.match(/\/users\/by\/username\/([^?]+)/);
    if (lookup) {
      const username = decodeURIComponent(lookup[1]);
      calls.lookups.push(username);
      if (errorStatusFor[username]) {
        return jsonResponse({ ok: false, status: errorStatusFor[username] });
      }
      const user = users[username];
      if (!user) return jsonResponse({ body: { errors: [{ detail: "Not Found" }] } });
      return jsonResponse({ body: { data: user } });
    }

    const timeline = url.match(/\/users\/([^/]+)\/tweets/);
    if (timeline) {
      const userId = decodeURIComponent(timeline[1]);
      const parsed = new URL(url);
      const token = parsed.searchParams.get("pagination_token");
      calls.tweets.push({
        userId,
        exclude: parsed.searchParams.get("exclude"),
        startTime: parsed.searchParams.get("start_time"),
        paginationToken: token,
      });
      const pages = tweetPages[userId] ?? [];
      const idx = token ? pageCursor.get(userId) ?? 0 : 0;
      pageCursor.set(userId, idx + 1);
      const page = pages[idx] ?? { body: { data: [], meta: { result_count: 0 } } };
      if (page.status && page.status >= 400) return jsonResponse({ ok: false, status: page.status });
      return jsonResponse({ body: page.body });
    }

    throw new Error(`unexpected url in mock: ${url}`);
  };

  return { fetchImpl, calls };
}

function jsonResponse({ ok = true, status = 200, body = {} }) {
  return { ok, status, statusText: "", json: async () => body };
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    bearerToken: "test-token",
    allowlist: [],
    maxResultsPerPage: 100,
    timeoutMs: 12000,
    apiBase: "https://api.x.com/2",
    ...overrides,
  };
}

// Fixed clock for deterministic minutesAgo / startTime assertions.
const NOW_MS = Date.parse("2026-06-17T12:00:00Z");

// ─── normalizeHandle ─────────────────────────────────────────────────────────

test("normalizeHandle: canonicalizes @, case, and whitespace", () => {
  assert.deepEqual(normalizeHandle("@PetroGustavo"), { username: "petrogustavo", handle: "@petrogustavo" });
  assert.deepEqual(normalizeHandle("  PETROGUSTAVO "), { username: "petrogustavo", handle: "@petrogustavo" });
  assert.deepEqual(normalizeHandle("petrogustavo"), { username: "petrogustavo", handle: "@petrogustavo" });
});

test("normalizeHandle: invalid/empty input returns null", () => {
  assert.equal(normalizeHandle(""), null);
  assert.equal(normalizeHandle("   "), null);
  assert.equal(normalizeHandle("@"), null);
  assert.equal(normalizeHandle(null), null);
  assert.equal(normalizeHandle(undefined), null);
});

// ─── computeStartTimeIso ─────────────────────────────────────────────────────

test("computeStartTimeIso: returns now - 24h as ISO", () => {
  assert.equal(computeStartTimeIso(NOW_MS), "2026-06-16T12:00:00.000Z");
});

// ─── mapTweetToRawItem ───────────────────────────────────────────────────────

test("mapTweetToRawItem: maps outlet, kind, url, lang, minutesAgo", () => {
  const item = mapTweetToRawItem({
    tweet: {
      id: "1800000000000000001",
      text: "  Comunicado oficial sobre la frontera.  ",
      created_at: "2026-06-17T11:30:00Z",
      lang: "es",
    },
    handle: "@PetroGustavo",
    weight: 72,
    fetchedAtMs: NOW_MS,
  });

  assert.equal(item.outlet, "@petrogustavo");
  assert.equal(item.kind, "social");
  assert.equal(item.feedId, "x:petrogustavo");
  assert.equal(item.url, "https://x.com/petrogustavo/status/1800000000000000001");
  assert.equal(item.lang, "es");
  assert.equal(item.weight, 72);
  assert.equal(item.minutesAgo, 30); // 12:00 - 11:30
  assert.equal(item.headline, "Comunicado oficial sobre la frontera.");
  assert.deepEqual(item.body, ["Comunicado oficial sobre la frontera."]);
  // narrative fields empty, feed-reader convention
  assert.equal(item.title, "");
  assert.deepEqual(item.geographies, []);
  assert.equal(item.whatChanged, "");
  // stable deterministic sourceId scoped to the handle
  assert.match(item.sourceId, /^x:petrogustavo:[0-9a-f]{16}$/);
});

test("mapTweetToRawItem: omits lang when absent and falls back headline", () => {
  const item = mapTweetToRawItem({
    tweet: { id: "42", text: "" },
    handle: "stateDept",
    fetchedAtMs: NOW_MS,
  });
  assert.equal(item.headline, "(untitled)");
  assert.deepEqual(item.body, ["(untitled)"]);
  assert.ok(!("lang" in item));
  assert.equal(item.weight, 60); // default
  assert.equal(item.minutesAgo, 0); // no created_at
});

test("mapTweetToRawItem: returns null for unusable tweet (no id and no text)", () => {
  assert.equal(mapTweetToRawItem({ tweet: { created_at: "2026-06-17T11:30:00Z" }, handle: "@x" }), null);
  assert.equal(mapTweetToRawItem({ tweet: null, handle: "@x" }), null);
});

// ─── readXItems: disabled gate ───────────────────────────────────────────────

test("readXItems: disabled config returns empty, not degraded", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createXApiMock({});
  const { items, diagnostics } = await readXItems({
    socialSources: ["@petrogustavo"],
    config: baseConfig({ enabled: false }),
    fetchImpl,
    nowMs: NOW_MS,
  });
  assert.deepEqual(items, []);
  assert.equal(diagnostics.degraded, false);
  assert.equal(diagnostics.handlesSelected, 0);
  assert.equal(calls.lookups.length, 0);
});

// ─── readXItems: allowlist filtering ─────────────────────────────────────────

test("readXItems: allowlist keeps only listed handles", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createXApiMock({
    users: { petrogustavo: { id: "u-petro", username: "petrogustavo", name: "Gustavo Petro" } },
    tweetPages: {
      "u-petro": [
        { body: { data: [{ id: "t1", text: "hola", created_at: "2026-06-17T11:00:00Z" }], meta: { result_count: 1 } } },
      ],
    },
  });

  const { items, diagnostics } = await readXItems({
    socialSources: ["@PetroGustavo", "stateDept", "@WhiteHouse"],
    config: baseConfig({ allowlist: ["petrogustavo"] }),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(diagnostics.handlesRequested, 3);
  assert.equal(diagnostics.handlesSelected, 1);
  assert.equal(diagnostics.handlesFetched, 1);
  assert.deepEqual(calls.lookups, ["petrogustavo"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].outlet, "@petrogustavo");
});

// ─── readXItems: pagination across pages ─────────────────────────────────────

test("readXItems: follows pagination token and includes both pages", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createXApiMock({
    users: { petrogustavo: { id: "u-petro", username: "petrogustavo" } },
    tweetPages: {
      "u-petro": [
        {
          body: {
            data: [{ id: "t1", text: "page1", created_at: "2026-06-17T11:50:00Z" }],
            meta: { result_count: 1, oldest_id: "t1", next_token: "PAGE2" },
          },
        },
        {
          body: {
            data: [{ id: "t2", text: "page2", created_at: "2026-06-17T11:40:00Z" }],
            meta: { result_count: 1, oldest_id: "t2" },
          },
        },
      ],
    },
  });

  const { items, diagnostics } = await readXItems({
    socialSources: ["@petrogustavo"],
    config: baseConfig(),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.headline), ["page1", "page2"]);
  assert.equal(diagnostics.tweetsReturned, 2);
  // second tweets call carried the cursor from page 1
  assert.equal(calls.tweets.length, 2);
  assert.equal(calls.tweets[0].paginationToken, null);
  assert.equal(calls.tweets[1].paginationToken, "PAGE2");
});

// ─── readXItems: pagination stop at 24h boundary ─────────────────────────────

test("readXItems: stops paginating when page oldest predates 24h window", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createXApiMock({
    users: { petrogustavo: { id: "u-petro", username: "petrogustavo" } },
    tweetPages: {
      "u-petro": [
        {
          // oldest tweet (t-old) is > 24h old → loop must stop after this page
          // even though next_token is present.
          body: {
            data: [
              { id: "t-new", text: "recent", created_at: "2026-06-17T11:00:00Z" },
              { id: "t-old", text: "stale", created_at: "2026-06-15T11:00:00Z" },
            ],
            meta: { result_count: 2, oldest_id: "t-old", next_token: "PAGE2" },
          },
        },
        {
          // should never be fetched
          body: { data: [{ id: "t3", text: "should-not-appear", created_at: "2026-06-17T10:00:00Z" }], meta: { result_count: 1 } },
        },
      ],
    },
  });

  const { items } = await readXItems({
    socialSources: ["@petrogustavo"],
    config: baseConfig(),
    fetchImpl,
    nowMs: NOW_MS,
  });

  // Both tweets from page 1 are mapped (we don't drop the stale one here — the
  // 24h gate governs pagination depth), but page 2 is never fetched.
  assert.equal(calls.tweets.length, 1);
  assert.deepEqual(items.map((i) => i.headline).sort(), ["recent", "stale"]);
});

// ─── readXItems: per-handle error isolation ──────────────────────────────────

test("readXItems: one handle fails, another succeeds — degraded with error entry", async () => {
  __clearUserCache();
  const { fetchImpl } = createXApiMock({
    users: { petrogustavo: { id: "u-petro", username: "petrogustavo" } },
    tweetPages: {
      "u-petro": [
        { body: { data: [{ id: "t1", text: "ok", created_at: "2026-06-17T11:00:00Z" }], meta: { result_count: 1 } } },
      ],
    },
    errorStatusFor: { statedept: 429 },
  });

  const { items, diagnostics } = await readXItems({
    socialSources: ["@stateDept", "@petrogustavo"],
    config: baseConfig(),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].outlet, "@petrogustavo");
  assert.equal(diagnostics.degraded, true);
  assert.equal(diagnostics.handlesFetched, 1);
  assert.equal(diagnostics.errors.length, 1);
  assert.equal(diagnostics.errors[0].handle, "@statedept");
  assert.equal(diagnostics.errors[0].status, 429);
  assert.match(diagnostics.errors[0].message, /429/);
  // token never leaked into diagnostics
  assert.doesNotMatch(JSON.stringify(diagnostics), /test-token/);
});

// ─── readXItems: retweet exclusion contract ──────────────────────────────────

test("readXItems: calls fetchUserTweets with exclude=retweets and 24h start_time", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createXApiMock({
    users: { petrogustavo: { id: "u-petro", username: "petrogustavo" } },
    tweetPages: {
      "u-petro": [
        { body: { data: [{ id: "t1", text: "ok", created_at: "2026-06-17T11:00:00Z" }], meta: { result_count: 1 } } },
      ],
    },
  });

  await readXItems({
    socialSources: ["@petrogustavo"],
    config: baseConfig(),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(calls.tweets.length, 1);
  assert.equal(calls.tweets[0].exclude, "retweets");
  assert.equal(calls.tweets[0].startTime, "2026-06-16T12:00:00.000Z");
});

// ─── readXItems: runtime fetch fallback (no injected fetchImpl) ───────────────

// Scoped swap of globalThis.fetch, restored even on throw — mirrors the server
// runtime where _xReader.read is called without a fetchImpl.
async function withGlobalFetch(stub, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "fetch");
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    if (had) globalThis.fetch = original;
    else delete globalThis.fetch;
  }
}

test("readXItems: works without fetchImpl, falling back to globalThis.fetch", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createXApiMock({
    users: { petrogustavo: { id: "u-petro", username: "petrogustavo" } },
    tweetPages: {
      "u-petro": [
        { body: { data: [{ id: "t1", text: "comunicado", created_at: "2026-06-17T11:00:00Z", lang: "es" }], meta: { result_count: 1 } } },
      ],
    },
  });

  // No fetchImpl passed — the client must resolve globalThis.fetch at runtime.
  const { items, diagnostics } = await withGlobalFetch(fetchImpl, () =>
    readXItems({
      socialSources: ["@petrogustavo"],
      config: baseConfig(),
      nowMs: NOW_MS,
    })
  );

  assert.equal(calls.lookups.length, 1, "global fetch used for lookup");
  assert.equal(calls.tweets.length, 1, "global fetch used for timeline");
  assert.equal(items.length, 1);
  assert.equal(items[0].outlet, "@petrogustavo");
  assert.equal(diagnostics.handlesFetched, 1);
  assert.equal(diagnostics.tweetsReturned, 1);
  assert.equal(diagnostics.degraded, false);
});

// ─── Phase 2: multi-handle ingestion ─────────────────────────────────────────
//
// Build a mock seeded with one one-tweet page per handle, so a clean multi-handle
// run yields exactly one item per handle.
function multiHandleMock(usernames) {
  const users = {};
  const tweetPages = {};
  for (const u of usernames) {
    users[u] = { id: `u-${u}`, username: u };
    tweetPages[`u-${u}`] = [
      {
        body: {
          data: [{ id: `t-${u}`, text: `post from ${u}`, created_at: "2026-06-17T11:00:00Z" }],
          meta: { result_count: 1 },
        },
      },
    ];
  }
  return createXApiMock({ users, tweetPages });
}

test("Phase 2: empty allowlist ingests every handle in socialSources", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = multiHandleMock(["petrogustavo", "statedept", "whitehouse"]);

  const { items, diagnostics } = await readXItems({
    socialSources: ["@PetroGustavo", "stateDept", "@WhiteHouse"],
    config: baseConfig({ allowlist: [] }), // unset/empty → full ingest
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(diagnostics.handlesRequested, 3);
  assert.equal(diagnostics.handlesSelected, 3, "no allowlist → all selected");
  assert.equal(diagnostics.handlesFetched, 3, "all three fetched");
  assert.equal(diagnostics.tweetsReturned, 3);
  assert.equal(diagnostics.degraded, false);
  assert.deepEqual(calls.lookups.sort(), ["petrogustavo", "statedept", "whitehouse"]);
  assert.deepEqual(
    items.map((i) => i.outlet).sort(),
    ["@petrogustavo", "@statedept", "@whitehouse"]
  );
  // Additive per-handle tweet counts surface for E2E observability.
  assert.deepEqual(diagnostics.tweetsByHandle, {
    "@petrogustavo": 1,
    "@statedept": 1,
    "@whitehouse": 1,
  });
});

test("Phase 2: non-empty allowlist still intersects (Phase 1 regression guard)", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = multiHandleMock(["petrogustavo", "statedept", "whitehouse"]);

  const { items, diagnostics } = await readXItems({
    socialSources: ["@PetroGustavo", "stateDept", "@WhiteHouse"],
    config: baseConfig({ allowlist: ["petrogustavo", "whitehouse"] }),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(diagnostics.handlesRequested, 3);
  assert.equal(diagnostics.handlesSelected, 2, "allowlist intersects socialSources");
  assert.equal(diagnostics.handlesFetched, 2);
  assert.deepEqual(calls.lookups.sort(), ["petrogustavo", "whitehouse"]);
  assert.deepEqual(items.map((i) => i.outlet).sort(), ["@petrogustavo", "@whitehouse"]);
  // statedept was selected out, never fetched.
  assert.ok(!calls.lookups.includes("statedept"));
});

test("Phase 2: 3 handles, 1 fails — other two return items, degraded with one error", async () => {
  __clearUserCache();
  const base = multiHandleMock(["petrogustavo", "statedept", "whitehouse"]);
  // Make the middle handle's lookup fail (404) — isolation must hold.
  const { fetchImpl, calls } = createXApiMock({
    users: {
      petrogustavo: { id: "u-petrogustavo", username: "petrogustavo" },
      whitehouse: { id: "u-whitehouse", username: "whitehouse" },
    },
    tweetPages: {
      "u-petrogustavo": [
        { body: { data: [{ id: "t-p", text: "ok p", created_at: "2026-06-17T11:00:00Z" }], meta: { result_count: 1 } } },
      ],
      "u-whitehouse": [
        { body: { data: [{ id: "t-w", text: "ok w", created_at: "2026-06-17T11:00:00Z" }], meta: { result_count: 1 } } },
      ],
    },
    errorStatusFor: { statedept: 404 },
  });
  void base;

  const { items, diagnostics } = await readXItems({
    socialSources: ["@PetroGustavo", "@stateDept", "@WhiteHouse"],
    config: baseConfig(),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(diagnostics.handlesSelected, 3);
  assert.equal(diagnostics.handlesFetched, 2, "two handles succeed");
  assert.equal(diagnostics.tweetsReturned, 2);
  assert.equal(diagnostics.degraded, true);
  assert.equal(diagnostics.errors.length, 1, "exactly one handle errored");
  assert.equal(diagnostics.errors[0].handle, "@statedept");
  assert.equal(diagnostics.errors[0].status, 404);
  // Survivors' items still present; failed handle absent from items + tweetsByHandle.
  assert.deepEqual(items.map((i) => i.outlet).sort(), ["@petrogustavo", "@whitehouse"]);
  assert.deepEqual(Object.keys(diagnostics.tweetsByHandle).sort(), ["@petrogustavo", "@whitehouse"]);
  // Token never leaks even on the degraded path.
  assert.doesNotMatch(JSON.stringify(diagnostics), /test-token/);
});

// Concurrency-observing wrapper: tracks the max number of in-flight fetch calls.
// Each worker runs lookup→tweets serially, so peak in-flight === active workers,
// which pMap bounds to min(concurrency, handles).
function concurrencyMock(usernames, delayMs = 5) {
  const base = multiHandleMock(usernames);
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (...args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await base.fetchImpl(...args);
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, calls: base.calls, getMaxInFlight: () => maxInFlight };
}

test("Phase 2: fetches run in parallel, bounded by config.handleConcurrency", async () => {
  __clearUserCache();
  const usernames = ["h1", "h2", "h3", "h4", "h5"];
  const { fetchImpl, getMaxInFlight } = concurrencyMock(usernames);

  const { diagnostics } = await readXItems({
    socialSources: usernames.map((u) => `@${u}`),
    config: baseConfig({ handleConcurrency: 2 }),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(diagnostics.handlesFetched, 5, "all handles still fetched");
  const peak = getMaxInFlight();
  assert.ok(peak <= 2, `peak in-flight ${peak} must not exceed concurrency 2`);
  assert.ok(peak >= 2, `peak in-flight ${peak} proves parallel, not serial`);
});

test("Phase 2: default concurrency is 3 when config omits the knob", async () => {
  __clearUserCache();
  const usernames = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const { fetchImpl, getMaxInFlight } = concurrencyMock(usernames);

  await readXItems({
    socialSources: usernames.map((u) => `@${u}`),
    config: baseConfig(), // no handleConcurrency → reader default (3)
    fetchImpl,
    nowMs: NOW_MS,
  });

  const peak = getMaxInFlight();
  assert.ok(peak <= 3, `peak in-flight ${peak} must not exceed default concurrency 3`);
  assert.ok(peak >= 2, `peak in-flight ${peak} proves parallelism`);
});

test("Phase 2: concurrency=1 runs handles serially (peak in-flight 1)", async () => {
  __clearUserCache();
  const usernames = ["h1", "h2", "h3"];
  const { fetchImpl, getMaxInFlight } = concurrencyMock(usernames);

  await readXItems({
    socialSources: usernames.map((u) => `@${u}`),
    config: baseConfig({ handleConcurrency: 1 }),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(getMaxInFlight(), 1, "concurrency=1 never overlaps fetches");
});

test("Phase 2: every fetched handle's outlet is the @-prefixed handle (source-selection match)", async () => {
  __clearUserCache();
  const { fetchImpl } = multiHandleMock(["petrogustavo", "statedept", "whitehouse"]);

  const { items } = await readXItems({
    // Mixed/odd casing in settings — the outlet must canonicalize to the
    // @-prefixed handle so the social source-selection union can match it.
    socialSources: ["@PetroGustavo", "STATEDEPT", "@WhiteHouse"],
    config: baseConfig(),
    fetchImpl,
    nowMs: NOW_MS,
  });

  assert.equal(items.length, 3);
  for (const item of items) {
    assert.equal(item.kind, "social");
    assert.match(item.outlet, /^@[a-z0-9_]+$/, "outlet is the @-prefixed canonical handle");
  }
  assert.deepEqual(
    items.map((i) => i.outlet).sort(),
    ["@petrogustavo", "@statedept", "@whitehouse"]
  );
});
