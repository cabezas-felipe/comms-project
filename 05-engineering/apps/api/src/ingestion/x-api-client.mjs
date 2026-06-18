// Standalone X (Twitter) API v2 client for the ingestion layer.
//
// SCOPE: reusable client primitive — consumed by `x-reader.mjs` (refresh +
// warmer). It mirrors the shape of the RSS path (`feed-reader.mjs`): config resolved from
// env at call time, all network I/O goes through an injectable `fetchImpl` so
// tests stay hermetic, and a deterministic AbortController-based timeout wraps
// every request.
//
// Env contract (all optional; ingestion stays OFF unless explicitly enabled):
//   - TEMPO_X_INGESTION_ENABLED   — "true"/"1" turns the client on (AND a token
//                                   must be present for `enabled` to be true).
//   - TEMPO_X_BEARER_TOKEN        — OAuth2 app-only bearer token. NEVER logged.
//   - TEMPO_X_HANDLE_ALLOWLIST    — comma-separated usernames to ingest.
//   - TEMPO_X_MAX_RESULTS_PER_PAGE — page size (default 100, clamp 5..100).
//   - TEMPO_X_TIMEOUT_MS          — per-request timeout (default 12000, min 1000).
//   - TEMPO_X_API_BASE            — override the API base (default api.x.com/2).
//
// SECURITY: the bearer token only ever appears in the Authorization header sent
// to `fetchImpl`. It is never written to logs, error messages, or return values.

const DEFAULT_MAX_RESULTS_PER_PAGE = 100;
const MAX_RESULTS_MIN = 5;
const MAX_RESULTS_MAX = 100;
const DEFAULT_TIMEOUT_MS = 12000;
const TIMEOUT_MIN_MS = 1000;
const DEFAULT_API_BASE = "https://api.x.com/2";
const DEFAULT_EXCLUDE = "retweets";
// Phase 2: bounded parallelism for multi-handle ingestion. Default keeps a
// conservative rate-limit posture (3 handles in flight); the env knob is clamped
// to 1..5 so a misconfig can neither serialize unexpectedly to 0 nor stampede
// the X user-lookup / timeline endpoints.
const DEFAULT_HANDLE_CONCURRENCY = 3;
const HANDLE_CONCURRENCY_MIN = 1;
const HANDLE_CONCURRENCY_MAX = 5;

// Process-wide cache of resolved username → user object. The X user-lookup
// endpoint is rate-limited and the id of a handle is stable, so we resolve each
// allowlisted handle at most once per process lifetime.
const userCache = new Map();

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function isTruthyFlag(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Normalize a handle to its canonical lookup form: strip a single leading `@`,
 * trim surrounding whitespace, lowercase. Returns "" for nullish/blank input so
 * callers can treat empty as "no usable username".
 *
 * @param {unknown} username
 * @returns {string}
 */
export function normalizeUsername(username) {
  if (username == null) return "";
  return String(username).trim().replace(/^@+/, "").trim().toLowerCase();
}

/**
 * Parse the comma-separated allowlist env value into normalized, de-duped
 * usernames. Blank entries are dropped; order of first appearance is preserved.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseAllowlist(raw) {
  if (raw == null) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(",")) {
    const handle = normalizeUsername(part);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

/**
 * Resolve X client config from env (deterministic, no I/O). `enabled` is true
 * only when the feature flag is truthy AND a bearer token is present, so a
 * misconfigured deploy (flag on, token missing) reads as disabled rather than
 * making doomed authenticated requests.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 */
export function resolveXConfig(env = process.env) {
  const bearerToken = String(env.TEMPO_X_BEARER_TOKEN ?? "").trim();
  const flagOn = isTruthyFlag(env.TEMPO_X_INGESTION_ENABLED);
  return {
    enabled: flagOn && bearerToken.length > 0,
    bearerToken,
    allowlist: parseAllowlist(env.TEMPO_X_HANDLE_ALLOWLIST),
    maxResultsPerPage: clamp(
      parsePositiveInt(env.TEMPO_X_MAX_RESULTS_PER_PAGE, DEFAULT_MAX_RESULTS_PER_PAGE),
      MAX_RESULTS_MIN,
      MAX_RESULTS_MAX
    ),
    // Accept the documented `TEMPO_X_FETCH_TIMEOUT_MS` (see .env.example) and
    // fall back to the original `TEMPO_X_TIMEOUT_MS` alias.
    timeoutMs: Math.max(
      TIMEOUT_MIN_MS,
      parsePositiveInt(
        env.TEMPO_X_FETCH_TIMEOUT_MS ?? env.TEMPO_X_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
      )
    ),
    apiBase: String(env.TEMPO_X_API_BASE ?? "").trim() || DEFAULT_API_BASE,
    // Phase 2: max handles fetched in parallel by the reader (clamped 1..5).
    handleConcurrency: clamp(
      parsePositiveInt(env.TEMPO_X_HANDLE_CONCURRENCY, DEFAULT_HANDLE_CONCURRENCY),
      HANDLE_CONCURRENCY_MIN,
      HANDLE_CONCURRENCY_MAX
    ),
  };
}

/**
 * Error thrown for any non-2xx X API response or malformed payload. Carries the
 * HTTP `status` (null for parse/shape failures) so callers can branch on it
 * (e.g. back off on 429) without string-matching the message.
 */
export class XApiError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message);
    this.name = "XApiError";
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

// Map a non-2xx status to an actionable, token-free message. Anything other
// than the well-known auth/limit codes is surfaced verbatim with its status.
function describeStatus(status, statusText) {
  switch (status) {
    case 401:
      return "authentication failed — bearer token missing, expired, or invalid";
    case 403:
      return "request forbidden — token lacks access to this resource or the account is suspended";
    case 429:
      return "rate limit exceeded — back off and retry after the reset window";
    default:
      return `unexpected HTTP status ${status}${statusText ? ` ${statusText}` : ""}`;
  }
}

/**
 * Single source of truth for fetch resolution. Tests inject `explicitFetchImpl`
 * to stay hermetic; the server runtime omits it and falls back to the platform
 * `globalThis.fetch` (Node 18+). Throws an actionable `XApiError` only when
 * neither is available, so a genuinely fetch-less environment fails loudly.
 *
 * @param {Function|undefined} explicitFetchImpl
 * @param {string} context — request label, surfaced in the error message.
 * @returns {Function}
 */
export function resolveFetchImpl(explicitFetchImpl, context = "request") {
  if (typeof explicitFetchImpl === "function") return explicitFetchImpl;
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  throw new XApiError(`[x-api-client] ${context}: no fetch implementation available`);
}

// Single request primitive shared by every endpoint. Builds the auth header,
// applies a deterministic AbortController timeout, honors a caller-supplied
// abort `signal`, asserts a 2xx, and returns the parsed JSON object.
async function requestJson(url, { config, fetchImpl, signal }, context) {
  // Resolve once here (the shared callsite) so endpoints never duplicate the
  // injected → global → throw precedence.
  const resolvedFetch = resolveFetchImpl(fetchImpl, context);

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response;
  try {
    response = await resolvedFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.bearerToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new XApiError(`[x-api-client] ${context}: request failed (${err?.message ?? err})`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  if (!response || typeof response.ok !== "boolean") {
    throw new XApiError(`[x-api-client] ${context}: malformed fetch response (no status)`);
  }
  if (!response.ok) {
    throw new XApiError(
      `[x-api-client] ${context} failed (${response.status}): ${describeStatus(response.status, response.statusText)}`,
      { status: response.status }
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new XApiError(`[x-api-client] ${context}: response was not valid JSON`, { cause: err });
  }
  if (payload == null || typeof payload !== "object") {
    throw new XApiError(`[x-api-client] ${context}: response JSON was not an object`);
  }
  return payload;
}

/**
 * Resolve a username to its X user object, caching the result for the process
 * lifetime. Cache hits skip the network entirely.
 *
 * @param {string} username — may include a leading `@`.
 * @param {{ config: object, fetchImpl: Function, signal?: AbortSignal }} opts
 * @returns {Promise<{ id: string, username: string, name?: string }>}
 */
export async function lookupUserByUsername(username, opts = {}) {
  const handle = normalizeUsername(username);
  if (!handle) {
    throw new XApiError("[x-api-client] lookupUserByUsername: username is empty after normalization");
  }
  if (userCache.has(handle)) {
    return userCache.get(handle);
  }

  const { config, fetchImpl, signal } = opts;
  if (!config) {
    throw new XApiError("[x-api-client] lookupUserByUsername: missing config");
  }

  const url = `${config.apiBase}/users/by/username/${encodeURIComponent(handle)}?user.fields=id,username,name`;
  const payload = await requestJson(url, { config, fetchImpl, signal }, "user lookup");

  const data = payload.data;
  if (data == null || typeof data !== "object" || !data.id) {
    throw new XApiError(`[x-api-client] user lookup: malformed payload — missing data.id for "${handle}"`);
  }

  const user = {
    id: String(data.id),
    username: String(data.username ?? handle),
    name: data.name != null ? String(data.name) : undefined,
  };
  userCache.set(handle, user);
  return user;
}

/**
 * Fetch a single page of a user's tweets timeline.
 *
 * @param {string} userId
 * @param {object} opts
 * @param {object} opts.config
 * @param {Function} opts.fetchImpl
 * @param {string} [opts.startTime]        — ISO timestamp; sent as `start_time`.
 * @param {string} [opts.exclude="retweets"]
 * @param {string} [opts.paginationToken]  — page cursor from a prior response.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ tweets: object[], nextToken: string|null, resultCount: number, newestId: string|null, oldestId: string|null }>}
 */
export async function fetchUserTweets(userId, opts = {}) {
  const id = String(userId ?? "").trim();
  if (!id) {
    throw new XApiError("[x-api-client] fetchUserTweets: userId is empty");
  }

  const {
    config,
    fetchImpl,
    startTime,
    exclude = DEFAULT_EXCLUDE,
    paginationToken,
    signal,
  } = opts;
  if (!config) {
    throw new XApiError("[x-api-client] fetchUserTweets: missing config");
  }

  const params = new URLSearchParams();
  params.set("max_results", String(config.maxResultsPerPage));
  params.set("exclude", exclude);
  params.set("tweet.fields", "created_at,text,lang");
  if (startTime) params.set("start_time", String(startTime));
  if (paginationToken) params.set("pagination_token", String(paginationToken));

  const url = `${config.apiBase}/users/${encodeURIComponent(id)}/tweets?${params.toString()}`;
  const payload = await requestJson(url, { config, fetchImpl, signal }, "user tweets");

  // Tolerate the valid empty shape: a timeline with no new tweets returns
  // `meta.result_count: 0` and omits `data`. Treat that as zero tweets rather
  // than a malformed payload.
  const tweets = Array.isArray(payload.data) ? payload.data : [];
  const meta = payload.meta != null && typeof payload.meta === "object" ? payload.meta : {};

  return {
    tweets,
    nextToken: meta.next_token != null ? String(meta.next_token) : null,
    resultCount: meta.result_count != null ? Number(meta.result_count) : tweets.length,
    newestId: meta.newest_id != null ? String(meta.newest_id) : null,
    oldestId: meta.oldest_id != null ? String(meta.oldest_id) : null,
  };
}

// Test-only: clear the process user cache between cases so cache-hit assertions
// are deterministic and independent of test execution order.
export function __clearUserCache() {
  userCache.clear();
}
