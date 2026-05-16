// Option A — semantic intent scoring layered into BeatFit precision stage.
//
// Why this module exists:
//   The deterministic BeatFit scorer in [./beat-fit-scorer.mjs] is precision-
//   first but lexical: an item about an "ISIS attack in Nigeria" never lights
//   up the configured "terrorism" keyword. The semantic intent score (cosine
//   similarity between the user's profile embedding and the item's canonical
//   text embedding) restores those alignments without replacing the
//   deterministic gates. The final BeatFit score blends the two:
//
//     finalBeatFit = deterministicBeatFit * 0.65 + semanticIntentScore * 0.35
//
//   Threshold + rescue posture stays the same — only the input score changes.
//
// What this module does NOT do:
//   - Generate content, propose new labels, or replace BeatFit's reason codes.
//   - Influence the recall, clustering, or grounding stages. Semantic intent
//     is consumed by the scorer; everything else operates on its existing
//     inputs. (The existing embedding-recall stage handles recall widening
//     independently using its own smaller embedding model.)
//   - Fail the refresh on provider error. Kill-switch / timeout / API error
//     all degrade to deterministic-only with explicit diagnostics — never
//     break the snapshot.
//
// Wiring:
//   The refresh pipeline calls [computeSemanticBeatFitScores] on the post-geo
//   candidate set, attaches `semanticIntentScore` to each item via
//   [attachSemanticScores], and the scorer reads the field directly. When the
//   stage is disabled or fails, items carry `semanticIntentScore: null` and
//   the scorer skips blending (pure deterministic behavior).
//
// Env flags (full precedence + defaults documented in
// [docs/runbook-semantic-beat-fit.md]):
//
//   TEMPO_SEMANTIC_BEAT_FIT_KILL_SWITCH       — wins over all flags (default: false)
//   TEMPO_SEMANTIC_BEAT_FIT_ENABLED           — global gate (default: true)
//   TEMPO_SEMANTIC_BEAT_FIT_MODEL             — embedding model (default: text-embedding-3-large)
//   TEMPO_SEMANTIC_BEAT_FIT_TIMEOUT_MS        — per-batch timeout (default: 4000 — matches SLO)
//   TEMPO_SEMANTIC_BEAT_FIT_MAX_ITEMS         — items embedded per refresh (default: 250)
//   TEMPO_SEMANTIC_BEAT_FIT_MAX_TEXT_CHARS    — per-item text cap (default: 2000)

import { createHash } from "node:crypto";

export const SEMANTIC_BEAT_FIT_VERSION = "semantic-beat-fit-v1";

// Locked blend weights — changing these is a product decision, not a tuning
// knob, so they are not env-configurable. Sum is 1.0 by design.
export const SEMANTIC_BLEND_DETERMINISTIC = 0.65;
export const SEMANTIC_BLEND_SEMANTIC = 0.35;

const DEFAULT_MODEL = "text-embedding-3-large";
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_ITEMS = 250;
const DEFAULT_MAX_TEXT_CHARS = 2000;

// Coarse score distribution buckets surfaced in `_meta` so operators can spot
// "every item scored 0.5" (degenerate) without dumping per-item scores.
const SCORE_BUCKETS = Object.freeze([
  ["b00_20", 0.0, 0.2],
  ["b20_40", 0.2, 0.4],
  ["b40_60", 0.4, 0.6],
  ["b60_80", 0.6, 0.8],
  ["b80_100", 0.8, 1.001], // half-open at top so 1.0 lands here
]);

function parseEnvBool(value, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function parseEnvPositiveInt(value, fallback) {
  if (typeof value !== "string") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Resolve the semantic BeatFit configuration. `enabled` is the AND of (kill
 * switch off) AND (global flag truthy). Defaults to enabled — Option A is
 * rolling out as the production posture for this environment, with the kill
 * switch as the instant-rollback escape hatch.
 *
 * Overrides accept the same lowercase keys; tests pass them in to avoid
 * polluting `process.env` across the suite.
 */
export function resolveSemanticBeatFitConfig(env = process.env, overrides = {}) {
  const killSwitch =
    typeof overrides.killSwitch === "boolean"
      ? overrides.killSwitch
      : parseEnvBool(env.TEMPO_SEMANTIC_BEAT_FIT_KILL_SWITCH, false);
  const enabledRaw =
    typeof overrides.enabled === "boolean"
      ? overrides.enabled
      : parseEnvBool(env.TEMPO_SEMANTIC_BEAT_FIT_ENABLED, true);
  const model =
    typeof overrides.model === "string" && overrides.model.length > 0
      ? overrides.model
      : env.TEMPO_SEMANTIC_BEAT_FIT_MODEL || DEFAULT_MODEL;
  const timeoutMs =
    typeof overrides.timeoutMs === "number"
      ? Math.max(1, overrides.timeoutMs)
      : parseEnvPositiveInt(env.TEMPO_SEMANTIC_BEAT_FIT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxItems =
    typeof overrides.maxItems === "number"
      ? Math.max(1, overrides.maxItems)
      : parseEnvPositiveInt(env.TEMPO_SEMANTIC_BEAT_FIT_MAX_ITEMS, DEFAULT_MAX_ITEMS);
  const maxTextChars =
    typeof overrides.maxTextChars === "number"
      ? Math.max(1, overrides.maxTextChars)
      : parseEnvPositiveInt(env.TEMPO_SEMANTIC_BEAT_FIT_MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);
  return {
    killSwitch,
    enabled: !killSwitch && enabledRaw,
    model,
    timeoutMs,
    maxItems,
    maxTextChars,
  };
}

// ─── Text builders ───────────────────────────────────────────────────────────

function cleanStrings(xs) {
  return (Array.isArray(xs) ? xs : [])
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Build a single-paragraph user intent profile text from settings + onboarding
 * narrative. Phrased as a first-person beat description so the embedding model
 * picks up intent rather than treating it as a feature list.
 *
 * Falls back to an empty string when settings carry no usable signal — the
 * caller then skips semantic scoring entirely for the refresh.
 */
export function buildIntentProfileText(settings) {
  if (!settings || typeof settings !== "object") return "";
  const topics = cleanStrings(settings.topics);
  const keywords = cleanStrings(settings.keywords);
  const geos = cleanStrings(settings.geographies);
  const narrative =
    typeof settings.onboardingNarrative === "string"
      ? settings.onboardingNarrative.trim()
      : "";

  const parts = [];
  if (topics.length > 0) {
    parts.push(`I monitor news about ${topics.join(", ")}.`);
  }
  if (keywords.length > 0) {
    parts.push(`Specific topics I care about: ${keywords.join(", ")}.`);
  }
  if (geos.length > 0) {
    parts.push(`Geographic focus: ${geos.join(", ")}.`);
  }
  if (narrative) {
    parts.push(`Beat narrative: ${narrative}`);
  }
  return parts.join(" ");
}

/**
 * Build canonical item text for semantic intent scoring. Uses headline +
 * subtitle + body — fields that are present at recall time (no model-derived
 * summary/takeaway etc. that would be empty/null pre-clustering).
 *
 * Output is trimmed to `maxChars` so the embedding payload is bounded for
 * very long bodies.
 */
export function buildItemCanonicalText(item, maxChars = DEFAULT_MAX_TEXT_CHARS) {
  if (!item || typeof item !== "object") return "";
  const headline = String(item.headline ?? "").trim();
  const subtitle = String(item.subtitle ?? "").trim();
  const body = Array.isArray(item.body)
    ? item.body.join(" ")
    : String(item.body ?? "");
  const parts = [];
  if (headline) parts.push(headline);
  if (subtitle) parts.push(subtitle);
  const trimmedBody = body.trim();
  if (trimmedBody) parts.push(trimmedBody);
  const joined = parts.join(". ");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars);
}

// ─── Cosine + normalization ──────────────────────────────────────────────────

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i++) {
    const av = typeof a[i] === "number" ? a[i] : 0;
    const bv = typeof b[i] === "number" ? b[i] : 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Map cosine similarity [-1, 1] to a [0, 1] semantic intent score. Standard
 * rescale: `(cosine + 1) / 2`. For real text embeddings cosine is rarely
 * negative; the rescale just keeps the worst case representable and matches
 * the blend-weight assumptions in the scorer.
 */
export function normalizeCosineToScore(cosine) {
  if (typeof cosine !== "number" || !Number.isFinite(cosine)) return 0;
  const clamped = Math.max(-1, Math.min(1, cosine));
  return (clamped + 1) / 2;
}

// ─── Profile cache ───────────────────────────────────────────────────────────
//
// Module-level cache so repeated refreshes with the same settings reuse the
// profile embedding. Keyed by a stable SHA-1 over the settings fields that
// actually feed `buildIntentProfileText` — settings revisions that don't
// touch beat surface (e.g. UI preferences) don't invalidate the cache.
//
// Cap is intentionally tiny: in practice a process serves one or a few users;
// the cap exists only to bound memory if a long-running worker accumulates
// stale revisions.

const DEFAULT_PROFILE_CACHE_LIMIT = 32;

export function createProfileEmbeddingCache(limit = DEFAULT_PROFILE_CACHE_LIMIT) {
  const store = new Map();
  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key);
      // Refresh LRU ordering.
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > limit) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
    },
    size() {
      return store.size;
    },
  };
}

const DEFAULT_PROFILE_CACHE = createProfileEmbeddingCache();

export function profileCacheKey(settings, model) {
  const norm = {
    topics: cleanStrings(settings?.topics).map((s) => s.toLowerCase()).sort(),
    keywords: cleanStrings(settings?.keywords).map((s) => s.toLowerCase()).sort(),
    geographies: cleanStrings(settings?.geographies).map((s) => s.toLowerCase()).sort(),
    narrative:
      typeof settings?.onboardingNarrative === "string"
        ? settings.onboardingNarrative.trim()
        : "",
    model,
  };
  return createHash("sha1").update(JSON.stringify(norm)).digest("hex");
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

function emptyDiagnostics(config) {
  return {
    version: SEMANTIC_BEAT_FIT_VERSION,
    enabled: Boolean(config?.enabled),
    killSwitchActive: Boolean(config?.killSwitch),
    model: config?.model ?? null,
    scoredCount: 0,
    skippedCount: 0,
    profileCacheHit: false,
    profileCacheSize: 0,
    latencyMs: 0,
    degraded: false,
    degradedReason: null,
    scoreBuckets: Object.fromEntries(SCORE_BUCKETS.map(([k]) => [k, 0])),
    meanScore: null,
  };
}

function bucketize(scores) {
  const buckets = Object.fromEntries(SCORE_BUCKETS.map(([k]) => [k, 0]));
  let sum = 0;
  let count = 0;
  for (const s of scores) {
    if (typeof s !== "number" || !Number.isFinite(s)) continue;
    sum += s;
    count += 1;
    for (const [name, lo, hi] of SCORE_BUCKETS) {
      if (s >= lo && s < hi) {
        buckets[name] += 1;
        break;
      }
    }
  }
  return { buckets, mean: count > 0 ? sum / count : null };
}

// ─── Main scoring entry point ────────────────────────────────────────────────

/**
 * Compute semantic intent scores for a candidate set.
 *
 * @param {object} opts
 * @param {Array}  opts.items           — post-geo candidate items
 * @param {object} opts.settings        — user settings (topics, keywords, geographies, onboardingNarrative)
 * @param {Function|null} opts.embedFn  — async (texts, { signal }?) => number[][]
 * @param {object} [opts.config]        — resolved config (env reads if omitted)
 * @param {object} [opts.profileCache]  — module-level cache (override for tests)
 * @param {AbortSignal} [opts.signal]   — optional cancellation
 *
 * @returns {Promise<{ scoresBySourceId: Map<string, number>, diagnostics: object }>}
 *
 * Failure contract (returned, never thrown). All paths return an empty score
 * map; the blender then falls back to pure deterministic BeatFit:
 *   - Disabled by config           → `degradedReason: "kill_switch_active" | "disabled_by_flag"`,
 *                                    `diagnostics.enabled = false`.
 *   - No embedFn injected          → `degradedReason: "embed_fn_unavailable"`.
 *   - Empty input items            → no degraded flag (nothing to do).
 *   - Empty profile text           → `degradedReason: "empty_profile_text"`.
 *   - No usable item text          → no degraded flag, `embedFn` is not called.
 *   - Empty profile vector         → `degradedReason: "empty_profile_vector"`.
 *   - Provider error / timeout / malformed response →
 *                                    `degradedReason: "embedding_error" | "embedding_timeout" | "embedding_invalid_response"`.
 *
 * Never throws.
 */
export async function computeSemanticBeatFitScores({
  items = [],
  settings = {},
  embedFn = null,
  config = null,
  profileCache = DEFAULT_PROFILE_CACHE,
  signal = null,
} = {}) {
  const cfg = config ?? resolveSemanticBeatFitConfig();
  const diagnostics = emptyDiagnostics(cfg);
  const scoresBySourceId = new Map();
  const startedAt = Date.now();

  if (!cfg.enabled) {
    diagnostics.degradedReason = cfg.killSwitch ? "kill_switch_active" : "disabled_by_flag";
    diagnostics.degraded = true;
    diagnostics.latencyMs = Date.now() - startedAt;
    diagnostics.profileCacheSize = profileCache.size();
    return { scoresBySourceId, diagnostics };
  }

  if (typeof embedFn !== "function") {
    diagnostics.degraded = true;
    diagnostics.degradedReason = "embed_fn_unavailable";
    diagnostics.latencyMs = Date.now() - startedAt;
    diagnostics.profileCacheSize = profileCache.size();
    return { scoresBySourceId, diagnostics };
  }

  if (!Array.isArray(items) || items.length === 0) {
    diagnostics.latencyMs = Date.now() - startedAt;
    diagnostics.profileCacheSize = profileCache.size();
    return { scoresBySourceId, diagnostics };
  }

  const profileText = buildIntentProfileText(settings);
  if (!profileText) {
    diagnostics.degraded = true;
    diagnostics.degradedReason = "empty_profile_text";
    diagnostics.latencyMs = Date.now() - startedAt;
    diagnostics.profileCacheSize = profileCache.size();
    return { scoresBySourceId, diagnostics };
  }

  const cacheKey = profileCacheKey(settings, cfg.model);
  let profileVec = profileCache.get(cacheKey);
  diagnostics.profileCacheHit = profileVec !== undefined;

  // Bound the candidate set so latency stays inside the SLO budget even when a
  // refresh produces an unusually wide geo set.
  const capped = items.slice(0, cfg.maxItems);
  const itemTexts = capped.map((item) =>
    buildItemCanonicalText(item, cfg.maxTextChars)
  );

  // Drop items with no usable text so the embedder doesn't waste a slot on
  // empty strings (some providers reject them outright).
  const embedPlan = [];
  for (let i = 0; i < capped.length; i++) {
    if (itemTexts[i] && itemTexts[i].length > 0) {
      embedPlan.push({ idx: i, text: itemTexts[i] });
    } else {
      diagnostics.skippedCount += 1;
    }
  }

  if (embedPlan.length === 0) {
    // No usable candidate text → no point embedding anything. Even when the
    // profile vector isn't cached yet, embedding the profile alone produces
    // zero scores, so we skip the call to keep cost and latency at zero on
    // these (rare) degenerate refreshes. Not a degraded state — same posture
    // as the empty-items branch above.
    diagnostics.latencyMs = Date.now() - startedAt;
    diagnostics.profileCacheSize = profileCache.size();
    return { scoresBySourceId, diagnostics };
  }

  const texts = [];
  let profileSlot = -1;
  if (profileVec === undefined) {
    profileSlot = texts.length;
    texts.push(profileText);
  }
  const itemSlotBase = texts.length;
  for (const { text } of embedPlan) texts.push(text);

  let vectors;
  try {
    vectors = await runWithTimeout(
      () => embedFn(texts, { signal }),
      cfg.timeoutMs,
      signal
    );
  } catch (err) {
    diagnostics.degraded = true;
    diagnostics.degradedReason = classifyEmbedError(err);
    diagnostics.latencyMs = Date.now() - startedAt;
    diagnostics.profileCacheSize = profileCache.size();
    console.warn(
      `[semantic-beat-fit] degraded reason=${diagnostics.degradedReason} model=${cfg.model} items=${embedPlan.length} err=${err instanceof Error ? err.message : String(err)}`
    );
    return { scoresBySourceId, diagnostics };
  }

  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    diagnostics.degraded = true;
    diagnostics.degradedReason = "embedding_invalid_response";
    diagnostics.latencyMs = Date.now() - startedAt;
    diagnostics.profileCacheSize = profileCache.size();
    console.warn(
      `[semantic-beat-fit] degraded reason=embedding_invalid_response expected=${texts.length} got=${Array.isArray(vectors) ? vectors.length : "(non-array)"}`
    );
    return { scoresBySourceId, diagnostics };
  }

  if (profileSlot >= 0) {
    profileVec = vectors[profileSlot];
    if (Array.isArray(profileVec) && profileVec.length > 0) {
      profileCache.set(cacheKey, profileVec);
    }
  }
  diagnostics.profileCacheSize = profileCache.size();

  if (!Array.isArray(profileVec) || profileVec.length === 0) {
    diagnostics.degraded = true;
    diagnostics.degradedReason = "empty_profile_vector";
    diagnostics.latencyMs = Date.now() - startedAt;
    return { scoresBySourceId, diagnostics };
  }

  const numericScores = [];
  for (let i = 0; i < embedPlan.length; i++) {
    const itemVec = vectors[itemSlotBase + i];
    const cos = cosineSimilarity(profileVec, itemVec);
    const score = normalizeCosineToScore(cos);
    const item = capped[embedPlan[i].idx];
    const id = item?.sourceId;
    if (typeof id === "string" && id.length > 0) {
      scoresBySourceId.set(id, score);
      numericScores.push(score);
      diagnostics.scoredCount += 1;
    } else {
      diagnostics.skippedCount += 1;
    }
  }

  const { buckets, mean } = bucketize(numericScores);
  diagnostics.scoreBuckets = buckets;
  diagnostics.meanScore = mean;
  diagnostics.latencyMs = Date.now() - startedAt;
  return { scoresBySourceId, diagnostics };
}

/**
 * Return a new array of items with `semanticIntentScore` populated from the
 * map. Items not present in the map keep their existing field (or null when
 * absent) so the scorer can detect "stage was skipped or item was not scored"
 * and fall back to pure deterministic behavior.
 */
export function attachSemanticScores(items, scoresBySourceId) {
  if (!Array.isArray(items)) return [];
  if (!(scoresBySourceId instanceof Map) || scoresBySourceId.size === 0) {
    return items.map((item) => ({
      ...item,
      semanticIntentScore:
        typeof item?.semanticIntentScore === "number"
          ? item.semanticIntentScore
          : null,
    }));
  }
  return items.map((item) => {
    const id = item?.sourceId;
    const score =
      typeof id === "string" && scoresBySourceId.has(id)
        ? scoresBySourceId.get(id)
        : typeof item?.semanticIntentScore === "number"
          ? item.semanticIntentScore
          : null;
    return { ...item, semanticIntentScore: score };
  });
}

// ─── Internals ───────────────────────────────────────────────────────────────

function classifyEmbedError(err) {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("abort")) {
    return "embedding_timeout";
  }
  return "embedding_error";
}

/**
 * Race the embedFn against the configured timeout. Honors an external
 * AbortSignal — when the caller aborts, we reject immediately so the rest of
 * the refresh doesn't wait out the budget.
 *
 * Every terminal path (external abort, timeout, thunk resolve, thunk reject)
 * funnels through a single `cleanup()` that clears the timeout AND removes
 * the abort listener from `externalSignal`. We deliberately do NOT use
 * `{ once: true }` — relying on the listener self-removing only covers the
 * abort path, and a long-lived `externalSignal` (e.g. the refresh-wide signal
 * shared across stages) would otherwise accumulate stale listeners.
 */
function runWithTimeout(thunk, timeoutMs, externalSignal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const supportsListener =
      externalSignal != null && typeof externalSignal.addEventListener === "function";

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (supportsListener) {
        externalSignal.removeEventListener("abort", onAbort);
      }
    };

    const finalize = (settle, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle(value);
    };

    const onAbort = () => finalize(reject, new Error("aborted"));

    if (externalSignal?.aborted) {
      // Short-circuit: no listener was registered, nothing to clean up beyond
      // the never-armed timer.
      settled = true;
      reject(new Error("aborted"));
      return;
    }
    if (supportsListener) {
      externalSignal.addEventListener("abort", onAbort);
    }
    timer = setTimeout(() => {
      finalize(reject, new Error(`semantic embedding timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve()
      .then(() => thunk())
      .then(
        (value) => finalize(resolve, value),
        (err) => finalize(reject, err)
      );
  });
}
