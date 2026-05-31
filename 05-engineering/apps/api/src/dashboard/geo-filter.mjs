import Anthropic from "@anthropic-ai/sdk";
import { providerFor } from "../ai/model-router.mjs";
import { withTimeout } from "../ai/guardrails.mjs";
import { pMap } from "../util/p-map.mjs";

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
 * Env:
 *   TEMPO_AI_GEO_ASSESS_MODEL      (default: anthropic:claude-haiku-4-5-20251001)
 *   TEMPO_AI_GEO_ASSESS_TIMEOUT_MS (default: TEMPO_AI_TIMEOUT_MS or 3000)
 *   TEMPO_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY
 *   TEMPO_AI_MOCK_ONLY=true        forces mock routing (CI safety)
 *
 * @param {object} item
 * @param {string[]} configuredGeos
 * @returns {Promise<{ confidence: number }>}
 */
export async function assessGeoConfidence(item, configuredGeos) {
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

  try {
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
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[geo-assess] failed (${modelName}): ${msg}; failing safe with confidence=0`);
    return { confidence: 0 };
  }
}

/**
 * Apply geo-confidence filtering to a pool of items.
 *
 * Rules:
 * - If configuredGeos is empty, all items are included (topic+keyword-only mode).
 * - explicit_match items are always included (confidence = 1.0).
 * - explicit_conflict items: call assessFn; include if confidence >= CONFLICT_THRESHOLD (0.90).
 * - implicit_geo items:      call assessFn; include if confidence >= IMPLICIT_THRESHOLD (0.80).
 * - Items below threshold go into the held array (hold bucket).
 *
 * @param {object[]} items
 * @param {string[]} configuredGeos
 * @param {Function} [assessFn]
 * @returns {Promise<{ included: object[], held: object[] }>}
 */
export async function applyGeoFilter(items, configuredGeos, assessFn = mockAssessGeoConfidence) {
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
    assessQueue.push({ item, category });
  }

  if (assessQueue.length === 0) {
    return { included, held };
  }

  const settled = await pMap(
    assessQueue,
    async ({ item, category }) => {
      const { confidence } = await assessFn(item, configuredGeos);
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
