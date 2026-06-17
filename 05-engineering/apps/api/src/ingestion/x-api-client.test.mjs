import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveXConfig,
  parseAllowlist,
  normalizeUsername,
  lookupUserByUsername,
  fetchUserTweets,
  XApiError,
  __clearUserCache,
} from "./x-api-client.mjs";

// ─── Fetch mock helpers ──────────────────────────────────────────────────────

// Build a fetchImpl that records every call and replies with the queued
// responses in order. Each response is `{ ok, status, statusText?, body }`.
function createMockFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      statusText: next.statusText ?? "",
      json: async () => next.body,
    };
  };
  return { fetchImpl, calls };
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

// ─── resolveXConfig ──────────────────────────────────────────────────────────

test("resolveXConfig: defaults from empty env", () => {
  const cfg = resolveXConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.bearerToken, "");
  assert.deepEqual(cfg.allowlist, []);
  assert.equal(cfg.maxResultsPerPage, 100);
  assert.equal(cfg.timeoutMs, 12000);
  assert.equal(cfg.apiBase, "https://api.x.com/2");
});

test("resolveXConfig: enabled only when flag truthy AND token present", () => {
  // flag on, no token → disabled
  assert.equal(resolveXConfig({ TEMPO_X_INGESTION_ENABLED: "true" }).enabled, false);
  // token present, flag off → disabled
  assert.equal(resolveXConfig({ TEMPO_X_BEARER_TOKEN: "abc" }).enabled, false);
  // both → enabled (accepts "1" and "true")
  assert.equal(
    resolveXConfig({ TEMPO_X_INGESTION_ENABLED: "1", TEMPO_X_BEARER_TOKEN: "abc" }).enabled,
    true
  );
  assert.equal(
    resolveXConfig({ TEMPO_X_INGESTION_ENABLED: "TRUE", TEMPO_X_BEARER_TOKEN: "abc" }).enabled,
    true
  );
  // non-truthy flag value → disabled
  assert.equal(
    resolveXConfig({ TEMPO_X_INGESTION_ENABLED: "yes", TEMPO_X_BEARER_TOKEN: "abc" }).enabled,
    false
  );
});

test("resolveXConfig: maxResultsPerPage clamps to 5..100 and timeout min 1000", () => {
  assert.equal(resolveXConfig({ TEMPO_X_MAX_RESULTS_PER_PAGE: "1000" }).maxResultsPerPage, 100);
  assert.equal(resolveXConfig({ TEMPO_X_MAX_RESULTS_PER_PAGE: "1" }).maxResultsPerPage, 5);
  assert.equal(resolveXConfig({ TEMPO_X_MAX_RESULTS_PER_PAGE: "42" }).maxResultsPerPage, 42);
  // invalid → default 100
  assert.equal(resolveXConfig({ TEMPO_X_MAX_RESULTS_PER_PAGE: "abc" }).maxResultsPerPage, 100);
  assert.equal(resolveXConfig({ TEMPO_X_TIMEOUT_MS: "10" }).timeoutMs, 1000);
  assert.equal(resolveXConfig({ TEMPO_X_TIMEOUT_MS: "30000" }).timeoutMs, 30000);
  assert.equal(resolveXConfig({ TEMPO_X_TIMEOUT_MS: "bad" }).timeoutMs, 12000);
});

test("resolveXConfig: apiBase override and trimming", () => {
  assert.equal(resolveXConfig({ TEMPO_X_API_BASE: "https://api.twitter.com/2" }).apiBase, "https://api.twitter.com/2");
  assert.equal(resolveXConfig({ TEMPO_X_API_BASE: "   " }).apiBase, "https://api.x.com/2");
  assert.equal(resolveXConfig({ TEMPO_X_BEARER_TOKEN: "  spaced  " }).bearerToken, "spaced");
});

// ─── allowlist / username normalization ──────────────────────────────────────

test("parseAllowlist: normalizes, strips @, lowercases, trims, dedupes", () => {
  assert.deepEqual(
    parseAllowlist("@PetroGustavo, stateDept ,petrogustavo"),
    ["petrogustavo", "statedept"]
  );
  assert.deepEqual(parseAllowlist(""), []);
  assert.deepEqual(parseAllowlist(null), []);
  assert.deepEqual(parseAllowlist(",,  ,"), []);
});

test("resolveXConfig: allowlist parsed from env", () => {
  const cfg = resolveXConfig({ TEMPO_X_HANDLE_ALLOWLIST: "@PetroGustavo, stateDept ,petrogustavo" });
  assert.deepEqual(cfg.allowlist, ["petrogustavo", "statedept"]);
});

test("normalizeUsername: strips leading @ and lowercases", () => {
  assert.equal(normalizeUsername("@PetroGustavo"), "petrogustavo");
  assert.equal(normalizeUsername("  StateDept "), "statedept");
  assert.equal(normalizeUsername(null), "");
});

// ─── lookupUserByUsername ────────────────────────────────────────────────────

test("lookupUserByUsername: success path returns {id, username, name}", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createMockFetch({
    body: { data: { id: "123", username: "petrogustavo", name: "Gustavo Petro" } },
  });
  const user = await lookupUserByUsername("@PetroGustavo", { config: baseConfig(), fetchImpl });
  assert.deepEqual(user, { id: "123", username: "petrogustavo", name: "Gustavo Petro" });

  // verifies endpoint, normalization in path, and auth header (token sent, never logged)
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://api.x.com/2/users/by/username/petrogustavo?"));
  assert.match(calls[0].url, /user\.fields=id,username,name/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
});

test("lookupUserByUsername: cache hit avoids a second fetch", async () => {
  __clearUserCache();
  const { fetchImpl, calls } = createMockFetch({
    body: { data: { id: "999", username: "cachehandle", name: "Cached" } },
  });
  const cfg = baseConfig();
  const first = await lookupUserByUsername("cacheHandle", { config: cfg, fetchImpl });
  const second = await lookupUserByUsername("@CacheHandle", { config: cfg, fetchImpl });
  assert.deepEqual(first, second);
  assert.equal(calls.length, 1, "second lookup should be served from cache");
});

test("lookupUserByUsername: throws a clear XApiError on 401", async () => {
  __clearUserCache();
  const { fetchImpl } = createMockFetch({ ok: false, status: 401, statusText: "Unauthorized", body: {} });
  await assert.rejects(
    () => lookupUserByUsername("someone", { config: baseConfig(), fetchImpl }),
    (err) => {
      assert.ok(err instanceof XApiError);
      assert.equal(err.status, 401);
      assert.match(err.message, /401/);
      assert.match(err.message, /authentication failed/i);
      // never leak the token
      assert.doesNotMatch(err.message, /test-token/);
      return true;
    }
  );
});

test("lookupUserByUsername: malformed payload (missing data.id) throws", async () => {
  __clearUserCache();
  const { fetchImpl } = createMockFetch({ body: { errors: [{ detail: "Not found" }] } });
  await assert.rejects(
    () => lookupUserByUsername("ghost", { config: baseConfig(), fetchImpl }),
    (err) => {
      assert.ok(err instanceof XApiError);
      assert.match(err.message, /malformed payload/i);
      return true;
    }
  );
});

// ─── fetchUserTweets ─────────────────────────────────────────────────────────

test("fetchUserTweets: success path maps meta and returns next token", async () => {
  const tweets = [
    { id: "t2", text: "newer", created_at: "2026-06-17T10:00:00Z", lang: "es" },
    { id: "t1", text: "older", created_at: "2026-06-17T09:00:00Z", lang: "en" },
  ];
  const { fetchImpl } = createMockFetch({
    body: {
      data: tweets,
      meta: { result_count: 2, newest_id: "t2", oldest_id: "t1", next_token: "PAGE2" },
    },
  });
  const result = await fetchUserTweets("123", { config: baseConfig(), fetchImpl });
  assert.deepEqual(result.tweets, tweets);
  assert.equal(result.resultCount, 2);
  assert.equal(result.newestId, "t2");
  assert.equal(result.oldestId, "t1");
  assert.equal(result.nextToken, "PAGE2");
});

test("fetchUserTweets: query includes exclude=retweets, tweet.fields, start_time, pagination_token", async () => {
  const { fetchImpl, calls } = createMockFetch({
    body: { data: [], meta: { result_count: 0 } },
  });
  await fetchUserTweets("123", {
    config: baseConfig({ maxResultsPerPage: 50 }),
    fetchImpl,
    startTime: "2026-06-01T00:00:00Z",
    paginationToken: "CURSOR",
  });
  const url = calls[0].url;
  assert.ok(url.startsWith("https://api.x.com/2/users/123/tweets?"));
  assert.match(url, /max_results=50/);
  assert.match(url, /exclude=retweets/);
  assert.match(url, /tweet\.fields=created_at%2Ctext%2Clang/);
  assert.match(url, /start_time=2026-06-01T00%3A00%3A00Z/);
  assert.match(url, /pagination_token=CURSOR/);
  // token still sent via header, never in the URL
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
  assert.doesNotMatch(url, /test-token/);
});

test("fetchUserTweets: throws a clear XApiError on 429", async () => {
  const { fetchImpl } = createMockFetch({ ok: false, status: 429, statusText: "Too Many Requests", body: {} });
  await assert.rejects(
    () => fetchUserTweets("123", { config: baseConfig(), fetchImpl }),
    (err) => {
      assert.ok(err instanceof XApiError);
      assert.equal(err.status, 429);
      assert.match(err.message, /429/);
      assert.match(err.message, /rate limit/i);
      return true;
    }
  );
});

test("fetchUserTweets: tolerates empty shape (missing data/meta) without crashing", async () => {
  // Valid empty timeline: meta.result_count 0, no `data` key at all.
  const { fetchImpl } = createMockFetch({ body: { meta: { result_count: 0 } } });
  const result = await fetchUserTweets("123", { config: baseConfig(), fetchImpl });
  assert.deepEqual(result.tweets, []);
  assert.equal(result.resultCount, 0);
  assert.equal(result.nextToken, null);
  assert.equal(result.newestId, null);
  assert.equal(result.oldestId, null);

  // Entirely empty object (no data, no meta) → still graceful empty result.
  const { fetchImpl: fetchImpl2 } = createMockFetch({ body: {} });
  const result2 = await fetchUserTweets("123", { config: baseConfig(), fetchImpl: fetchImpl2 });
  assert.deepEqual(result2.tweets, []);
  assert.equal(result2.resultCount, 0);
  assert.equal(result2.nextToken, null);
});
