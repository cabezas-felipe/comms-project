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
// Minimum cosine similarity for a SEMANTIC-ONLY top-K addition to enter the
// union.  Keyword/topic hits always pass (they cleared real lexical gates);
// this floor only constrains items that would be admitted purely on embedding
// proximity, so a weak/off-beat semantic neighbor can't widen recall into
// noise.  0.40 is a conservative default for text-embedding-3-small cosine on
// short RSS text; tune via TEMPO_EMBED_MIN_SIMILARITY.
const DEFAULT_EMBED_MIN_SIMILARITY = 0.4;

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// Parse a [0,1] similarity floor.  Out-of-range / non-numeric → fallback.
// 0 is allowed (admit everything in top-K) so an operator can fully disable
// the floor without code changes.
function parseSimilarity(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
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
    minSimilarity: parseSimilarity(process.env.TEMPO_EMBED_MIN_SIMILARITY, DEFAULT_EMBED_MIN_SIMILARITY),
    embeddingModel: process.env.TEMPO_OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  };
}

// ─── Text builders ───────────────────────────────────────────────────────────

// Per-axis segment builder.  Returns an ordered list of
// `{ axis, text }` objects — empty / whitespace-only items are dropped at the
// item level, and axes that contribute nothing are dropped at the axis level.
// Used by both `buildProfileText` (joins `.text` into the embedding input) and
// `summarizeProfileContent` (counts axes for sparse-profile diagnostics).
function profileSegments(settings) {
  if (!settings || typeof settings !== "object") return [];
  const clean = (xs) =>
    (Array.isArray(xs) ? xs : [])
      .filter((v) => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  const parts = [];
  const topics = clean(settings.topics);
  if (topics.length > 0) parts.push({ axis: "topics", text: `Topics: ${topics.join(", ")}` });
  const keywords = clean(settings.keywords);
  if (keywords.length > 0) parts.push({ axis: "keywords", text: `Keywords: ${keywords.join(", ")}` });
  const geos = clean(settings.geographies);
  if (geos.length > 0) parts.push({ axis: "geographies", text: `Geographies: ${geos.join(", ")}` });
  const traditional = clean(settings.traditionalSources);
  const social = clean(settings.socialSources);
  const sources = [...traditional, ...social];
  if (sources.length > 0) parts.push({ axis: "sources", text: `Sources: ${sources.join(", ")}` });
  const narrative =
    typeof settings.onboardingNarrative === "string" && settings.onboardingNarrative.trim()
      ? settings.onboardingNarrative.trim()
      : null;
  if (narrative) parts.push({ axis: "narrative", text: `Beat narrative: ${narrative}` });
  return parts;
}

/**
 * Compose one profile text from onboarding settings.  Order is "specific →
 * general" (topics, keywords, geos, sources, narrative) so the embedding
 * weights the user's explicit beat selection most heavily.  Empty arrays,
 * whitespace-only entries, and axes with no usable content are dropped so we
 * don't pollute the vector with empty/garbled headings.
 */
export function buildProfileText(settings) {
  return profileSegments(settings).map((s) => s.text).join("\n");
}

/**
 * Summarize what went into the profile text: the joined text itself, a count
 * of axes that contributed, the ordered axis names, and the final char
 * length.  Surfaced on `_meta.recall` so operators can spot thin / single-axis
 * profiles without having to inspect raw settings.  Phase 3: pure
 * observability — does NOT change recall behavior.
 */
export function summarizeProfileContent(settings) {
  const segments = profileSegments(settings);
  const text = segments.map((s) => s.text).join("\n");
  return {
    profileText: text,
    profileAxes: segments.length,
    profileAxisNames: segments.map((s) => s.axis),
    profileTextLength: text.length,
  };
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

  // Phase 3: compute profile-content summary upfront so EVERY return path
  // carries the same observability surface (`profileAxes`, axis names, char
  // length).  Without this the keyword bypass + fail-closed paths emitted a
  // narrower diagnostic shape than the full-run path, making "did we have
  // anything to embed against?" hard to answer from `_meta.recall` alone.
  const profileSummary = summarizeProfileContent(settings);

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
    // Similarity floor (Slice 1): the threshold a semantic-only top-K addition
    // must clear to join the union, and how many were rejected for falling
    // below it this run.  `similarityRejected` counts only items NOT already
    // admitted via the keyword path — keyword hits never count as rejected.
    minSimilarityThreshold: config.minSimilarity,
    similarityRejected: 0,
    // Profile sparseness diagnostics — pure observability, never gates behavior.
    //   `profileAxes`      : how many of the 5 settings axes contributed
    //                        (0 → empty profile guard fires; 1 → degenerate
    //                        semantic widen; ≥2 → normal).
    //   `profileAxisNames` : ordered axis names that contributed (e.g.
    //                        ["topics","keywords","geographies"]) so operators
    //                        can tell "thin profile, only sources" apart from
    //                        "thin profile, only topics".
    //   `profileTextLength`: char count of the embedding input — a quick sniff
    //                        for unusually small / large profile vectors.
    profileAxes: profileSummary.profileAxes,
    profileAxisNames: profileSummary.profileAxisNames,
    profileTextLength: profileSummary.profileTextLength,
  };

  // Legacy mode: embeddings never run; just pass through keyword recall.
  // Profile-sparseness diagnostics are still surfaced so operators can spot
  // "we're in keyword mode and the profile would have been thin anyway."
  if (config.mode === RECALL_MODE.KEYWORD) {
    return { items: keywordRecallItems, diagnostics: baseDiagnostics };
  }

  // Hybrid_strict from here on.
  //
  // Degrade contract:
  //   - Provider/runtime failures (embedFn missing, throw, timeout, invalid
  //     response) keep their strict posture: lexical-fallback when keyword
  //     recall has hits, else strict-empty.  `keywordFallbackAfterEmbeddingFailure`
  //     is set so operators see the cliff.
  //   - Empty profile text (E3b / M5) is NOT an operational error — it just
  //     means the user has no beat signal to embed against.  We pass the
  //     lexical hits through (no semantic widen) and emit
  //     `degraded_reason: "empty_profile_text_lexical_only"`.  Without the
  //     flag, an empty-profile run with zero keyword hits would look
  //     identical to a fail-closed provider error.
  //
  // The route handler ALWAYS supplies embedFn in production, so the
  // embedding-unavailable branch is reached only by tests that bypass
  // injection deliberately — but the contract is uniform across all callers.
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

  const profileText = profileSummary.profileText;
  if (!profileText) {
    // E3b (M5): no profile signal → skip semantic widen, pass lexical hits
    // through.  This is distinct from the provider-failure path: there's no
    // operational error to flag with `keywordFallbackAfterEmbeddingFailure`;
    // the user simply hasn't given us anything to embed against.  When
    // keyword recall is also empty we surface strict-empty with the same
    // diagnostic so operators can tell empty-profile apart from a real cliff.
    // `profileAxes === 0` is the formal invariant for this branch; pinned in
    // tests so any future settings shape that produces a non-empty profile
    // text with zero axes (or vice-versa) trips loudly.
    const n = keywordRecallItems.length;
    console.warn(
      `[recall.embedding] LEXICAL-ONLY reason=empty_profile_text_lexical_only keywordRecall=${n} profileAxes=0 (no profile signal to embed)`
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
        degraded_reason: "empty_profile_text_lexical_only",
      },
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
  // Semantic-only additions must clear the similarity floor.  Items already in
  // the union via the keyword path are skipped here regardless of score (they
  // passed a real lexical gate); a below-floor semantic-only neighbor is
  // dropped and counted in `similarityRejected` so an operator can see how
  // much noise the floor held back.
  let similarityRejected = 0;
  topK.forEach(({ item, score }) => {
    const id = idOf(item, -1);
    if (seen.has(id)) return; // already admitted via keyword path — always passes
    if (score < config.minSimilarity) {
      // Semantic-only candidate below the floor → drop and count it.
      similarityRejected++;
      return;
    }
    seen.add(id);
    merged.push(item);
  });

  return {
    items: merged,
    diagnostics: {
      ...baseDiagnostics,
      embeddedCount: capped.length,
      // `similarityKept` is the number of top-K candidates that survived the
      // floor (top-K size minus those rejected below threshold).  Preserves
      // the legacy meaning when no floor is configured (rejected=0 → kept=K).
      similarityKept: topK.length - similarityRejected,
      similarityRejected,
      keywordRecallCount: keywordRecallItems.length,
      unionCount: merged.length,
      finalRelevant: merged.length,
      degraded: false,
      degraded_reason: null,
    },
  };
}
