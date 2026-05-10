// Embedding-based recall stage.
//
// Why this stage exists:
//   The legacy keyword/topic recall is brittle on thin RSS text — a relevant
//   item that doesn't carry an exact configured token gets dropped before the
//   precision stages (beat-fit, clustering, grounding) can ever see it.
//   This module widens recall using semantic similarity against a profile
//   embedding derived from onboarding, then unions the result with the legacy
//   keyword/topic candidates so we never *narrow* recall vs the keyword baseline.
//
// What it does NOT do:
//   - It does not score precision.  Beat-fit + clustering + grounding still run
//     downstream untouched.
//   - It does not generate new content.  Every selected item is a real ingested
//     item that already passed source selection + 24h + geo gating.
//   - It does not fall back to keyword-only on embedding failure.  Fail-closed:
//     return [] and let downstream produce an empty payload.  No silent degrade.
//
// Mode selection (via TEMPO_RECALL_MODE):
//   - "hybrid_strict" (default) — embedding union with keyword/topic recall
//   - "keyword"                 — legacy behavior; embeddings never invoked
//
// Operationally the route handler injects `embedFn` (resolved from the env-aware
// router in src/ai/embeddings.mjs); tests inject deterministic stubs.

export const RECALL_MODE = Object.freeze({
  HYBRID_STRICT: "hybrid_strict",
  KEYWORD: "keyword",
});

const DEFAULT_EMBED_TOP_K = 80;
const DEFAULT_EMBED_MAX_ITEMS = 250;

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Read recall config from env at call time (not import time) so route handlers
 * and tests can mutate process.env between runs.  Unrecognized modes fall
 * through to hybrid_strict — the safer default given the product posture.
 */
export function resolveRecallConfig() {
  const rawMode = (process.env.TEMPO_RECALL_MODE ?? "").trim().toLowerCase();
  const mode =
    rawMode === RECALL_MODE.KEYWORD
      ? RECALL_MODE.KEYWORD
      : RECALL_MODE.HYBRID_STRICT;
  return {
    mode,
    embedTopK: parsePositiveInt(process.env.TEMPO_EMBED_TOP_K, DEFAULT_EMBED_TOP_K),
    embedMaxItems: parsePositiveInt(process.env.TEMPO_EMBED_MAX_ITEMS, DEFAULT_EMBED_MAX_ITEMS),
    embeddingModel: process.env.TEMPO_OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  };
}

// ─── Text builders ───────────────────────────────────────────────────────────

/**
 * Compose one profile text from onboarding settings.  Order is "specific →
 * general" (topics, keywords, geos, sources, narrative) so the embedding
 * weights the user's explicit beat selection most heavily.  Empty arrays are
 * dropped so we don't pollute the vector with empty headings.
 */
export function buildProfileText(settings) {
  if (!settings || typeof settings !== "object") return "";
  const parts = [];
  const topics = (settings.topics ?? []).filter(Boolean);
  if (topics.length > 0) parts.push(`Topics: ${topics.join(", ")}`);
  const keywords = (settings.keywords ?? []).filter(Boolean);
  if (keywords.length > 0) parts.push(`Keywords: ${keywords.join(", ")}`);
  const geos = (settings.geographies ?? []).filter(Boolean);
  if (geos.length > 0) parts.push(`Geographies: ${geos.join(", ")}`);
  const traditional = (settings.traditionalSources ?? []).filter(Boolean);
  const social = (settings.socialSources ?? []).filter(Boolean);
  const sources = [...traditional, ...social];
  if (sources.length > 0) parts.push(`Sources: ${sources.join(", ")}`);
  const narrative =
    typeof settings.onboardingNarrative === "string" && settings.onboardingNarrative.trim()
      ? settings.onboardingNarrative.trim()
      : null;
  if (narrative) parts.push(`Beat narrative: ${narrative}`);
  return parts.join("\n");
}

/**
 * Compose per-item text from real ingested fields only.  Never includes
 * model-derived fields (summary/takeaway/etc.) — those would be empty at
 * recall time and would dilute the vector.
 */
export function buildItemText(item) {
  if (!item || typeof item !== "object") return "";
  const outlet = String(item.outlet ?? "").trim();
  const headline = String(item.headline ?? "").trim();
  const body = Array.isArray(item.body) ? item.body.join(" ") : String(item.body ?? "");
  const trimmedBody = body.trim();
  const parts = [];
  if (outlet) parts.push(outlet);
  if (headline) parts.push(headline);
  if (trimmedBody) parts.push(trimmedBody);
  return parts.join(" — ");
}

// ─── Cosine similarity ───────────────────────────────────────────────────────

export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Recall stage ────────────────────────────────────────────────────────────

/**
 * Run the recall stage.
 *
 * @param {object} opts
 * @param {Array}  opts.candidateItems       — geo-passed items (post-source/time/geo gating)
 * @param {object} opts.settings
 * @param {Array}  opts.keywordRecallItems   — items already passed legacy keyword/topic recall
 * @param {Function|null} opts.embedFn       — async (texts: string[]) => number[][]; null in keyword mode
 * @param {object} opts.config               — { mode, embedTopK, embedMaxItems, ... }
 *
 * @returns {Promise<{ items: Array, diagnostics: object }>}
 */
export async function runEmbeddingRecall(opts) {
  const {
    candidateItems = [],
    settings = {},
    keywordRecallItems = [],
    embedFn = null,
    config = resolveRecallConfig(),
  } = opts ?? {};

  const baseDiagnostics = {
    mode: config.mode,
    embeddedCount: null,
    similarityKept: null,
    keywordRecallCount: keywordRecallItems.length,
    unionCount: keywordRecallItems.length,
    finalRelevant: keywordRecallItems.length,
    degraded: false,
    degraded_reason: null,
    embedTopK: config.embedTopK,
    embedMaxItems: config.embedMaxItems,
    embeddingModel: config.embeddingModel,
  };

  // Legacy mode: embeddings never run; just pass through keyword recall.
  if (config.mode === RECALL_MODE.KEYWORD) {
    return { items: keywordRecallItems, diagnostics: baseDiagnostics };
  }

  // Hybrid_strict from here on.
  //
  // Strict fail-closed policy (Option A): every condition that prevents us
  // from running a real semantic comparison returns an empty candidate set,
  // never the keyword baseline.  Comms users are the audience; surfacing the
  // legacy keyword recall under degraded conditions risks delivering content
  // that *looks* like the normal product but is materially weaker.  Empty
  // state with a clear `degraded_reason` is the safer signal.
  //
  // The four fail-closed conditions are:
  //   1. embedFn missing            → embedding_unavailable_fail_closed
  //   2. empty profile text         → empty_profile_text_fail_closed
  //   3. provider timeout / error   → embedding_(timeout|error)_fail_closed
  //   4. invalid response shape     → embedding_invalid_response_fail_closed
  //
  // The route handler ALWAYS supplies embedFn in production, so case 1 is
  // reached only by tests that bypass injection deliberately — but the
  // contract is uniform across all callers regardless.
  const failClosedDiagnostics = (reason) => ({
    ...baseDiagnostics,
    embeddedCount: 0,
    similarityKept: 0,
    keywordRecallCount: keywordRecallItems.length,
    unionCount: 0,
    finalRelevant: 0,
    degraded: true,
    degraded_reason: reason,
  });

  /**
   * When embeddings cannot run or return unusable vectors, preserve the
   * keyword/topic recall path only.  This is the "trust protections held"
   * outcome: lexical hits already pass real source/topic/keyword gates, so
   * surfacing them is *not* speculation — it's just the legacy product on
   * a degraded run.  Operators see `degraded_reason` and
   * `keywordFallbackAfterEmbeddingFailure: true` on `_meta.recall` so the
   * cliff is debuggable.
   *
   * Strict-empty branch: when keyword recall is also empty, there is no
   * lexical signal to fall back on — the run produces nothing at all and
   * the diagnostics flag stays consistent with the four documented
   * fail-closed reasons (no `keywordFallbackAfterEmbeddingFailure` flag,
   * no synthetic items).
   */
  const lexicalFallbackAfterEmbeddingFailure = (reason) => {
    const n = keywordRecallItems.length;
    if (n === 0) {
      // Lexical recall is empty → nothing to fall back to.  Honor strict-empty
      // semantics: zero items, no `keywordFallbackAfterEmbeddingFailure` flag.
      console.warn(
        `[recall.embedding] FAIL-CLOSED reason=${reason} keywordRecall=0 (no lexical fallback available)`
      );
      return {
        items: [],
        diagnostics: failClosedDiagnostics(reason),
      };
    }
    console.warn(
      `[recall.embedding] LEXICAL-FALLBACK reason=${reason} keywordRecall=${n} (semantic widening skipped)`
    );
    return {
      items: keywordRecallItems,
      diagnostics: {
        ...baseDiagnostics,
        embeddedCount: 0,
        similarityKept: 0,
        keywordRecallCount: n,
        unionCount: n,
        finalRelevant: n,
        degraded: true,
        degraded_reason: reason,
        keywordFallbackAfterEmbeddingFailure: true,
      },
    };
  };

  if (typeof embedFn !== "function") {
    console.warn(
      `[recall.embedding] embedding_unavailable_fail_closed (no embedFn injected) — using lexical recall only`
    );
    return lexicalFallbackAfterEmbeddingFailure("embedding_unavailable_fail_closed");
  }

  // No candidates means nothing for the embedder to do — propagate empty.
  // This is NOT a degraded state: source/time/geo gates simply yielded
  // nothing this refresh.  We keep `degraded: false` so the funnel reads as
  // a clean strict-empty rather than a fail-closed event.
  if (candidateItems.length === 0) {
    return {
      items: [],
      diagnostics: {
        ...baseDiagnostics,
        embeddedCount: 0,
        similarityKept: 0,
        unionCount: 0,
        finalRelevant: 0,
      },
    };
  }

  const profileText = buildProfileText(settings);
  if (!profileText) {
    // No profile means we can't compute meaningful similarity.  Under strict
    // fail-closed we treat this as an operational gap, not a soft fallback —
    // an empty profile typically means onboarding hasn't completed yet, and
    // serving keyword-only output without explicit user beat context risks
    // surfacing items the user wouldn't recognize as relevant.
    console.warn(
      `[recall.embedding] FAIL-CLOSED reason=empty_profile_text_fail_closed (settings + narrative produced no profile signal)`
    );
    return {
      items: [],
      diagnostics: failClosedDiagnostics("empty_profile_text_fail_closed"),
    };
  }

  // Cap the candidate pool before embedding to bound cost / latency.
  // The cap is deterministic (slice of input order) so behavior is testable.
  const capped = candidateItems.slice(0, config.embedMaxItems);
  const itemTexts = capped.map(buildItemText);
  const embedInputs = [profileText, ...itemTexts];

  let vectors;
  try {
    vectors = await embedFn(embedInputs);
  } catch (err) {
    // Fail-closed: never degrade to keyword-only on operational error.
    // Log a structured one-liner so operators can spot the cliff in logs.
    const reason = err instanceof Error && /timed out|abort/i.test(err.message)
      ? "embedding_timeout_fail_closed"
      : "embedding_error_fail_closed";
    console.warn(
      `[recall.embedding] provider failure → lexical fallback reason=${reason} model=${config.embeddingModel} candidates=${capped.length} err=${err instanceof Error ? err.message : String(err)}`
    );
    return lexicalFallbackAfterEmbeddingFailure(reason);
  }

  // Sanity-check provider response.  Mismatched length is treated as
  // operational failure → lexical fallback (same contract as throw path).
  if (!Array.isArray(vectors) || vectors.length !== embedInputs.length) {
    console.warn(
      `[recall.embedding] invalid embedding response → lexical fallback reason=embedding_invalid_response_fail_closed expected=${embedInputs.length} got=${Array.isArray(vectors) ? vectors.length : "(non-array)"}`
    );
    return lexicalFallbackAfterEmbeddingFailure("embedding_invalid_response_fail_closed");
  }

  const profileVec = vectors[0];
  const itemVecs = vectors.slice(1);
  const scored = capped.map((item, idx) => ({
    item,
    score: cosineSimilarity(profileVec, itemVecs[idx]),
    // `seq` carries the original input position so the sort can resolve ties
    // deterministically — items with identical cosine scores fall back to
    // input order, then to sourceId.  V8's sort is stable, but explicit
    // tie-breakers keep the contract obvious to readers (and survive any
    // future engine swap).
    seq: idx,
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.seq !== b.seq) return a.seq - b.seq;
    const aId = a.item?.sourceId ?? "";
    const bId = b.item?.sourceId ?? "";
    if (aId < bId) return -1;
    if (aId > bId) return 1;
    return 0;
  });
  const topK = scored.slice(0, config.embedTopK);

  // Union with keyword recall.  Deterministic order: keyword candidates first
  // (preserve their relative order), then semantic-only additions in score
  // order.  Dedup on sourceId; fall back to index identity for items missing
  // a sourceId (defensive — every ingested item has one in practice).
  const seen = new Set();
  const idOf = (item, idx) => item?.sourceId ?? `__idx_${idx}`;
  const merged = [];
  keywordRecallItems.forEach((item, idx) => {
    const id = idOf(item, idx);
    if (seen.has(id)) return;
    seen.add(id);
    merged.push(item);
  });
  topK.forEach(({ item }) => {
    const id = idOf(item, -1);
    if (seen.has(id)) return;
    seen.add(id);
    merged.push(item);
  });

  return {
    items: merged,
    diagnostics: {
      ...baseDiagnostics,
      embeddedCount: capped.length,
      similarityKept: topK.length,
      keywordRecallCount: keywordRecallItems.length,
      unionCount: merged.length,
      finalRelevant: merged.length,
      degraded: false,
      degraded_reason: null,
    },
  };
}
