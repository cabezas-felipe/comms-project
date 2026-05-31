import Anthropic from "@anthropic-ai/sdk";
import { providerFor } from "../ai/model-router.mjs";
import { withTimeout } from "../ai/guardrails.mjs";
import { pMap } from "../util/p-map.mjs";
import { itemMentionsConfiguredGeography } from "./geo-lexical-match.mjs";

export const GEO_CATEGORY = {
  EXPLICIT_MATCH: "explicit_match",
  EXPLICIT_CONFLICT: "explicit_conflict",
  IMPLICIT_GEO: "implicit_geo",
};

export const CONFLICT_THRESHOLD = 0.90;
export const IMPLICIT_THRESHOLD = 0.80;

// N2 locks the geo assessor SKU at Anthropic Haiku 4.5.  Env override keeps
// the SKU swappable without a redeploy; `providerFor` honors TEMPO_AI_MOCK_ONLY
// so CI continues to route through the mock branch without a live key.
export const DEFAULT_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";

/**
 * Categorize a single item relative to the user's configured geographies.
 *
 * - explicit_match:    item.geographies overlaps with configuredGeos
 * - explicit_conflict: item has geographies but none match configuredGeos
 * - implicit_geo:      item.geographies is empty
 */
export function categorizeItem(item, configuredGeos) {
  if (!item.geographies || item.geographies.length === 0) {
    return GEO_CATEGORY.IMPLICIT_GEO;
  }
  const geoSet = new Set(configuredGeos);
  if (item.geographies.some((g) => geoSet.has(g))) {
    return GEO_CATEGORY.EXPLICIT_MATCH;
  }
  return GEO_CATEGORY.EXPLICIT_CONFLICT;
}

/**
 * Mock geo-confidence assessor. Used in tests and as the default when no
 * real LLM assessor is injected. Returns a confidence that passes the
 * implicit threshold (0.85 > 0.80) but fails the conflict threshold (0.85 < 0.90).
 *
 * @param {object} _item
 * @param {string[]} _configuredGeos
 * @returns {{ confidence: number }}
 */
export function mockAssessGeoConfidence(_item, _configuredGeos) {
  return { confidence: 0.85 };
}

// ─── Real Anthropic geo-confidence assessor (M4 / F3b) ────────────────────────
//
// Asks the geo-assess SKU "is this article materially about the user's
// configured geographies?" and parses a structured `{ confidence }` reply.
// The score feeds the same threshold gates as the mock (CONFLICT 0.90 /
// IMPLICIT 0.80) — implementation swap, not behavior swap.
//
// Fail-safe posture (any error → `confidence: 0`):
//   - Missing TEMPO_ANTHROPIC_API_KEY
//   - SDK throw / timeout
//   - Empty or unparseable JSON
// Returning 0 routes the item into the held bucket rather than silently
// admitting something we couldn't verify, matching the recall-stage fail-
// closed posture (F2 / E2).

function buildGeoAssessPrompt(item, configuredGeos) {
  const headline = String(item.headline ?? "").trim();
  const body = Array.isArray(item.body) ? item.body.join(" ") : String(item.body ?? "");
  // Body is hard-capped to keep token cost predictable per item.  Headline
  // carries most of the geo signal anyway; body is a tie-breaker.
  const bodySnippet = body.slice(0, 1200).trim();
  const itemGeos = Array.isArray(item.geographies) && item.geographies.length > 0
    ? item.geographies.join(", ")
    : "none";
  return [
    `The user monitors news about these geographies: ${configuredGeos.join(", ")}.`,
    "Estimate how confident you are that the article below is materially about (or has direct impact on) those geographies.",
    "",
    `Headline: ${headline}`,
    `Article-tagged geographies: ${itemGeos}`,
    bodySnippet ? `Body: ${bodySnippet}` : "",
    "",
    'Reply with JSON only — no markdown, no commentary — of shape: {"confidence": <number between 0 and 1>}',
  ].filter(Boolean).join("\n");
}

function clampConfidence(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function parseGeoAssessResponse(raw) {
  const clean = String(raw ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(clean);
  return clampConfidence(parsed?.confidence);
}

/**
 * Resolve the bounded-concurrency cap for the geo-assess worker pool from
 * `TEMPO_AI_GEO_ASSESS_CONCURRENCY`.  Defaults to 8 (locked default) when unset
 * or misconfigured (non-finite / <= 0).  Exported so tests can pin the default
 * without exercising the full pMap path.
 */
export function resolveGeoAssessConcurrency() {
  const n = Number(process.env.TEMPO_AI_GEO_ASSESS_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

// ─── A1: process-wide geo-assess rate limiter + 429 retry/backoff ─────────────
//
// `resolveGeoAssessConcurrency` caps how many geo-assess calls are *in flight*;
// it does NOT cap how fast they are dispatched.  With a high concurrency a
// first-run refresh can fire dozens of Haiku calls in the same second and trip
// the Anthropic org RPM ceiling, which surfaces as a wall of
// `429 rate_limit_error` failures → items dropped into the hold bucket →
// clustering starved.  The limiter below staggers *dispatch* so the effective
// request rate stays under `TEMPO_AI_GEO_ASSESS_RPM_CAP` regardless of how high
// concurrency is set; the bounded retry/backoff inside `assessGeoConfidence`
// then absorbs the occasional 429 that still slips through.

// A1.2: bumped 40 → 48.  40 left ~20% of the org's 50 RPM budget unused, which
// under-covered first-run refreshes (items needlessly deferred while the
// limiter idled).  48 keeps a 2-RPM safety margin under the hard 50 ceiling
// while recovering that throughput; the 429 retry/backoff below still absorbs
// the rare burst that crosses the line.
export const GEO_ASSESS_RPM_CAP_DEFAULT = 48; // safe under the 50 RPM org limit
const GEO_ASSESS_MAX_RETRIES = 2;
const GEO_ASSESS_BACKOFF_BASE_MS = 250;

/**
 * Resolve the per-minute request cap for geo-assess dispatch from
 * `TEMPO_AI_GEO_ASSESS_RPM_CAP`.  Defaults to 48 when unset or misconfigured
 * (non-finite / <= 0) — chosen to stay safely under the Anthropic 50 RPM org
 * limit.  Exported so tests can pin the default without exercising the limiter.
 */
export function resolveGeoAssessRpmCap() {
  const n = Number(process.env.TEMPO_AI_GEO_ASSESS_RPM_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : GEO_ASSESS_RPM_CAP_DEFAULT;
}

/**
 * Timing seam for the limiter + backoff.  Production uses the wall clock and
 * real timers; tests swap `sleep` for an instant resolve so backoff/limiter
 * waits don't slow the suite.  Mirrors the `_geoAssessClient` injection seam —
 * production code never overrides this.
 */
export const _geoTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Process-wide dispatch clock.  `nextAllowedAt` is the earliest wall-clock time
// the next geo-assess call may dispatch; each acquire reserves its slot
// synchronously (no await between read and write) so concurrent pool workers
// stagger correctly instead of all reading the same timestamp.
const _geoRateLimiterState = { nextAllowedAt: 0 };

/** Test hook: clear limiter state so a prior test's reservations don't bleed in. */
export function _resetGeoRateLimiter() {
  _geoRateLimiterState.nextAllowedAt = 0;
}

/**
 * Block until the next geo-assess dispatch slot is free.  Spacing = 60000/cap
 * ms between dispatches, so the effective rate can't exceed the cap even under
 * high concurrency.  An isolated call (clock idle) returns immediately.
 */
async function acquireGeoRateSlot() {
  const cap = resolveGeoAssessRpmCap();
  const intervalMs = 60000 / cap;
  const now = _geoTiming.now();
  const scheduledAt = Math.max(now, _geoRateLimiterState.nextAllowedAt);
  _geoRateLimiterState.nextAllowedAt = scheduledAt + intervalMs;
  const waitMs = scheduledAt - now;
  if (waitMs > 0) await _geoTiming.sleep(waitMs);
}

// A1.2: request-scoped geo-assess diagnostics.  Previously a process-global
// monotonic accumulator that the pipeline read via before/after delta math —
// which mixes counts across overlapping refresh runs in one process.  Instead
// each run creates its own `diag` context and threads it through
// `applyGeoFilter` → `assessGeoConfidence`, so the counters belong to exactly
// one refresh and can be read directly.  The process-wide RPM limiter
// (`acquireGeoRateSlot`) stays global on purpose — the rate ceiling is an
// org-level concern shared across runs, not a per-run one.
export function createGeoDiagnostics() {
  return { rateLimitedCount: 0, retryCount: 0, backoffMsTotal: 0, lexicalBypassCount: 0 };
}

// ─── A2: lexical geo pre-pass ─────────────────────────────────────────────────
//
// Before spending an LLM assess call on an implicit/conflict candidate, check
// whether the item's text already names one of the user's configured
// geographies. A clear lexical mention is a strong-enough signal to admit the
// item outright — the SAME deterministic bar the recall gate
// (`applyTopicKeywordFilter`) and the Lane 1 must-see classification already
// use via `itemMentionsConfiguredGeography`. Reusing that shared matcher (no
// duplicated geo logic) keeps the pre-pass from drifting from those stages.
//
// Text surface mirrors the pipeline's `joinGeoText` (headline + subtitle +
// body + url). The geo stage runs BEFORE translation, so no normalized-English
// evidence exists yet at this point — reading the raw fields here matches what
// the recall gate's lexical classifier sees one stage earlier.
function joinGeoPrePassText(item) {
  const headline = String(item?.headline ?? "");
  const subtitle = String(item?.subtitle ?? "");
  const body = Array.isArray(item?.body) ? item.body.join(" ") : String(item?.body ?? "");
  const url = typeof item?.url === "string" ? item.url : "";
  return `${headline} ${subtitle} ${body} ${url}`.trim();
}

/**
 * Does this item carry a strong lexical geo signal for the configured
 * geographies?  True when its text mentions any configured geography (canonical
 * token + GEOGRAPHY_SYNONYMS + settings-gated GEOGRAPHY_ALIASES).  Exported so
 * the pre-pass decision is unit-testable in isolation.
 */
export function hasStrongLexicalGeoSignal(item, configuredGeos) {
  if (!Array.isArray(configuredGeos) || configuredGeos.length === 0) return false;
  return itemMentionsConfiguredGeography(joinGeoPrePassText(item), configuredGeos) !== null;
}

/**
 * Detect Anthropic rate-limit (429) failures.  Matches the SDK's typed error
 * (`status === 429` / `RateLimitError`) and the raw message text logged in
 * production (`... 429 rate_limit_error`).  Deliberately narrow — only 429s get
 * retried; every other error keeps the single-shot fail-safe posture.
 */
function isRateLimitError(err) {
  if (!err) return false;
  if (typeof err.status === "number" && err.status === 429) return true;
  const name = err.name || err.constructor?.name || "";
  if (/RateLimit/i.test(name)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit/i.test(msg);
}

/** Exponential backoff with full jitter, bounded by `GEO_ASSESS_MAX_RETRIES`. */
function geoBackoffMs(attempt) {
  const base = GEO_ASSESS_BACKOFF_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * GEO_ASSESS_BACKOFF_BASE_MS);
  return base + jitter;
}

function resolveModelName(model) {
  const i = model.indexOf(":");
  return i !== -1 ? model.slice(i + 1) : model;
}

/**
 * Internal hook for tests to inject a fake Anthropic client without monkey-
 * patching the SDK.  When `create` is set, `assessGeoConfidence` uses the
 * returned client instead of constructing `new Anthropic(...)`.  Production
 * code never overrides this.
 */
export const _geoAssessClient = { create: null };

/**
 * Anthropic-backed structured geo-confidence assessor.  Reads model + key +
 * timeout from env at call time so a deploy swap doesn't require a code
 * change.  Always resolves — errors are mapped to `{ confidence: 0 }` so the
 * surrounding `applyGeoFilter` loop can't blow up mid-run.
 *
 * Dispatch is gated by a process-wide RPM limiter (A1) and a bounded
 * retry/backoff on 429s, so a high-concurrency first-run refresh can't trip the
 * Anthropic org rate limit and bury relevant items in the hold bucket.  Only
 * rate-limit errors are retried (max 2, exponential backoff + jitter); every
 * other failure keeps the single-shot fail-safe.
 *
 * Env:
 *   TEMPO_AI_GEO_ASSESS_MODEL      (default: anthropic:claude-haiku-4-5-20251001)
 *   TEMPO_AI_GEO_ASSESS_TIMEOUT_MS (default: TEMPO_AI_TIMEOUT_MS or 3000)
 *   TEMPO_AI_GEO_ASSESS_RPM_CAP    (default: 48 — safe under the 50 RPM org limit)
 *   TEMPO_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY
 *   TEMPO_AI_MOCK_ONLY=true        forces mock routing (CI safety)
 *
 * @param {object} item
 * @param {string[]} configuredGeos
 * @param {{rateLimitedCount:number,retryCount:number,backoffMsTotal:number}} [diag]
 *        Optional request-local diagnostics context (see `createGeoDiagnostics`).
 *        When provided, 429/retry/backoff counts are accumulated onto it so a
 *        single refresh run can read its own totals without global state.
 * @returns {Promise<{ confidence: number }>}
 */
export async function assessGeoConfidence(item, configuredGeos, diag = null) {
  const model = (process.env.TEMPO_AI_GEO_ASSESS_MODEL || DEFAULT_GEO_ASSESS_MODEL).trim();
  const provider = providerFor(model);
  const modelName = resolveModelName(model);
  const timeoutMs = Number(
    process.env.TEMPO_AI_GEO_ASSESS_TIMEOUT_MS || process.env.TEMPO_AI_TIMEOUT_MS || 3000
  );

  if (provider === "mock-anthropic" || provider === "mock-openai") {
    return mockAssessGeoConfidence(item, configuredGeos);
  }

  if (provider !== "anthropic") {
    console.warn(
      `[geo-assess] unsupported provider="${provider}" for model="${model}"; failing safe with confidence=0`
    );
    return { confidence: 0 };
  }

  const apiKey = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(
      `[geo-assess] TEMPO_ANTHROPIC_API_KEY missing for model="${model}"; failing safe with confidence=0`
    );
    return { confidence: 0 };
  }

  const prompt = buildGeoAssessPrompt(item, configuredGeos);

  // Retry/backoff is scoped to 429s only.  The limiter wait happens *before*
  // `withTimeout` so dispatch spacing never counts against the per-call
  // timeout budget.
  let attempt = 0;
  while (true) {
    try {
      await acquireGeoRateSlot();
      const confidence = await withTimeout(
        async () => {
          const client = _geoAssessClient.create
            ? _geoAssessClient.create({ apiKey, timeoutMs })
            : new Anthropic({ apiKey, timeout: timeoutMs });
          const message = await client.messages.create({
            model: modelName,
            max_tokens: 64,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          });
          const block = message?.content?.[0];
          if (!block || block.type !== "text" || !block.text?.trim()) {
            throw new Error("Anthropic returned empty geo-assess response");
          }
          return parseGeoAssessResponse(block.text);
        },
        timeoutMs,
        `Anthropic geo-assess timed out (${modelName})`
      );
      return { confidence };
    } catch (err) {
      const rateLimited = isRateLimitError(err);
      if (rateLimited && diag) diag.rateLimitedCount += 1;
      if (rateLimited && attempt < GEO_ASSESS_MAX_RETRIES) {
        const backoffMs = geoBackoffMs(attempt);
        if (diag) {
          diag.retryCount += 1;
          diag.backoffMsTotal += backoffMs;
        }
        attempt += 1;
        console.warn(
          `[geo-assess] rate-limited (${modelName}); retry ${attempt}/${GEO_ASSESS_MAX_RETRIES} in ${backoffMs}ms`
        );
        await _geoTiming.sleep(backoffMs);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[geo-assess] failed (${modelName}): ${msg}; failing safe with confidence=0`);
      return { confidence: 0 };
    }
  }
}

/**
 * Apply geo-confidence filtering to a pool of items.
 *
 * Rules:
 * - If configuredGeos is empty, all items are included (topic+keyword-only mode).
 * - explicit_match items are always included (confidence = 1.0).
 * - A2 lexical pre-pass: an explicit_conflict or implicit_geo item whose text
 *   names a configured geography is admitted WITHOUT an assessFn call
 *   (`geoConfidence = 1.0`, `geoLexicalBypass = true`), and `diag.lexicalBypassCount`
 *   is incremented. This cuts geo-assess load for obvious geography matches.
 * - explicit_conflict items (no lexical signal): call assessFn; include if confidence >= CONFLICT_THRESHOLD (0.90).
 * - implicit_geo items (no lexical signal):      call assessFn; include if confidence >= IMPLICIT_THRESHOLD (0.80).
 * - Items below threshold go into the held array (hold bucket).
 *
 * @param {object[]} items
 * @param {string[]} configuredGeos
 * @param {Function} [assessFn]
 * @param {object} [diag] request-local geo diagnostics context, forwarded to
 *        `assessFn` as its third argument (the real `assessGeoConfidence`
 *        accumulates 429/retry counts onto it; injected stubs ignore it).
 * @returns {Promise<{ included: object[], held: object[] }>}
 */
export async function applyGeoFilter(items, configuredGeos, assessFn = mockAssessGeoConfidence, diag = null) {
  if (configuredGeos.length === 0) {
    return { included: items, held: [] };
  }

  const included = [];
  const held = [];
  const assessQueue = [];

  for (const item of items) {
    const category = categorizeItem(item, configuredGeos);

    if (category === GEO_CATEGORY.EXPLICIT_MATCH) {
      included.push({ ...item, geoCategory: category, geoConfidence: 1.0 });
      continue;
    }
    // A2: lexical geo pre-pass — a clear configured-geography mention admits the
    // item without an LLM assess call. Applies to both assess paths
    // (explicit_conflict and implicit_geo); explicit_match above is untouched.
    if (hasStrongLexicalGeoSignal(item, configuredGeos)) {
      if (diag) diag.lexicalBypassCount += 1;
      included.push({ ...item, geoCategory: category, geoConfidence: 1.0, geoLexicalBypass: true });
      continue;
    }
    assessQueue.push({ item, category });
  }

  if (assessQueue.length === 0) {
    return { included, held };
  }

  const settled = await pMap(
    assessQueue,
    async ({ item, category }) => {
      const { confidence } = await assessFn(item, configuredGeos, diag);
      return { item, category, confidence };
    },
    resolveGeoAssessConcurrency()
  );

  // pMap returns index-aligned settled results, so walk by index and read the
  // matching queue entry directly — `indexOf` would mis-map when more than one
  // task rejects (duplicate result objects collapse to the first match).
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "rejected") {
      // Defensive fallback for custom assessFn stubs that throw: fail safe.
      const { item, category } = assessQueue[i];
      held.push({ ...item, geoCategory: category, geoConfidence: 0 });
      continue;
    }
    const { item, category, confidence } = result.value;
    const threshold =
      category === GEO_CATEGORY.EXPLICIT_CONFLICT ? CONFLICT_THRESHOLD : IMPLICIT_THRESHOLD;
    if (confidence >= threshold) included.push({ ...item, geoCategory: category, geoConfidence: confidence });
    else held.push({ ...item, geoCategory: category, geoConfidence: confidence });
  }

  return { included, held };
}
