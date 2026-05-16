// Phase 4 — constrained semantic mapping for topic + keyword tags.
//
// Scope (LOCKED — Chunk K, Phase 4):
//   - **Topics + keywords only.**  Geographies stay deterministic (exact +
//     Phase 3 alias map).  No semantic geography path is introduced here.
//   - **Settings is the closed vocabulary.**  The mapper scores candidate
//     evidence against *only* the user's `settings.topics` / `settings.keywords`
//     entries; it can never propose a new label.  Output is therefore by
//     construction a subset of the matching settings list.
//   - **Threshold-gated.**  A candidate is accepted only when the injected
//     scorer returns a similarity score `>= threshold`.  Anything below is
//     dropped (and counted in diagnostics) so low-confidence semantic widening
//     stays out of the payload.
//   - **K1a one-way invariant unchanged.**  Semantic uplift affects shipped
//     `tags` only.  It does NOT influence the pool, recall, clustering, or
//     dedupe stages — those run before this module and on their own inputs.
//
// Injection model (testability + production wiring):
//
// The mapper accepts a `scorer(evidenceText, candidateLabel) -> number` (or a
// Promise of a number) so production can wire an embedding similarity probe
// or a constrained classifier in one place while tests inject deterministic
// fixtures.  When `scorer` is missing (or `enabled` is false), the mapper is
// a no-op — it returns the empty addition set and diagnostics reflect the
// "skipped" state.  This keeps the rollout safe behind the env flags below.
//
// Env flags consumed by `resolveSemanticTagConfig`:
//
//   TEMPO_TAG_SEMANTIC_MAPPING_ENABLED       — global gate (default: false)
//   TEMPO_TAG_SEMANTIC_TOPICS_ENABLED        — per-axis gate (default: false)
//   TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED      — per-axis gate (default: false)
//   TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD      — float in [0,1] (default: 0.75)
//   TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD    — float in [0,1] (default: 0.75)
//
// An axis is considered ENABLED only when BOTH the global flag AND the
// per-axis flag are truthy.  Either flag missing/false → axis is OFF.

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_TOPIC_THRESHOLD = 0.75;
const DEFAULT_KEYWORD_THRESHOLD = 0.75;

// Phase 5 defaults for production scorer bounds.  Conservative — operators
// can override via `TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS` and
// `TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS`.  Picked so a single refresh of a
// few stories with a few candidate labels stays well under the existing
// pipeline budget even on cold-start embedding calls.
const DEFAULT_SCORER_TIMEOUT_MS = 1500;
const DEFAULT_MAX_EVIDENCE_CHARS = 4000;

/**
 * Sentinel error class raised when a scorer call exceeds its timeout budget.
 * Distinguished from a generic scorer error so [`mapSemanticAxis`](./meta-story-semantic-mapper.mjs)
 * can attribute fallback reasons correctly in diagnostics (timeout vs error).
 */
export class SemanticScorerTimeoutError extends Error {
  constructor(message = "semantic scorer timeout") {
    super(message);
    this.name = "SemanticScorerTimeoutError";
  }
}

function parseEnvBool(value) {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseEnvThreshold(value, fallback) {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

/**
 * Resolve the semantic tag mapping configuration from the process env (or an
 * override object — useful for tests).  Returns a fully-populated config
 * object with `enabled` already AND-folded between the global flag and each
 * per-axis flag, so callers can switch on `config.topicsEnabled` /
 * `config.keywordsEnabled` directly.
 *
 * The override object accepts the same lowercase keys we expose externally
 * (`enabled`, `topicsEnabled`, `keywordsEnabled`, `topicsThreshold`,
 * `keywordsThreshold`) and skips env reads when set — this is the seam used
 * by pipeline tests so a single test run can flip the flag without polluting
 * the actual `process.env` for other tests.
 */
export function resolveSemanticTagConfig(env = process.env, overrides = {}) {
  const globalEnabled =
    typeof overrides.enabled === "boolean"
      ? overrides.enabled
      : parseEnvBool(env.TEMPO_TAG_SEMANTIC_MAPPING_ENABLED);
  const topicsEnabledRaw =
    typeof overrides.topicsEnabled === "boolean"
      ? overrides.topicsEnabled
      : parseEnvBool(env.TEMPO_TAG_SEMANTIC_TOPICS_ENABLED);
  const keywordsEnabledRaw =
    typeof overrides.keywordsEnabled === "boolean"
      ? overrides.keywordsEnabled
      : parseEnvBool(env.TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED);
  const topicsThreshold =
    typeof overrides.topicsThreshold === "number"
      ? clampThreshold(overrides.topicsThreshold, DEFAULT_TOPIC_THRESHOLD)
      : parseEnvThreshold(env.TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD, DEFAULT_TOPIC_THRESHOLD);
  const keywordsThreshold =
    typeof overrides.keywordsThreshold === "number"
      ? clampThreshold(overrides.keywordsThreshold, DEFAULT_KEYWORD_THRESHOLD)
      : parseEnvThreshold(env.TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD, DEFAULT_KEYWORD_THRESHOLD);
  return {
    enabled: globalEnabled,
    topicsEnabled: globalEnabled && topicsEnabledRaw,
    keywordsEnabled: globalEnabled && keywordsEnabledRaw,
    topicsThreshold,
    keywordsThreshold,
  };
}

function clampThreshold(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

function parseEnvPositiveInt(value, fallback) {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Resolve the production scorer runtime config (timeout + max evidence text
 * length).  Independent from the on/off flag and threshold config because the
 * scorer factory is what consumes these values — `mapSemanticAxis` itself
 * stays agnostic.  Defaults are conservative; operators flip env vars to
 * tune without code changes.
 */
export function resolveSemanticScorerRuntimeConfig(env = process.env, overrides = {}) {
  const timeoutMs =
    typeof overrides.timeoutMs === "number"
      ? Math.max(1, overrides.timeoutMs)
      : parseEnvPositiveInt(env.TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS, DEFAULT_SCORER_TIMEOUT_MS);
  const maxEvidenceChars =
    typeof overrides.maxEvidenceChars === "number"
      ? Math.max(1, overrides.maxEvidenceChars)
      : parseEnvPositiveInt(env.TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS, DEFAULT_MAX_EVIDENCE_CHARS);
  return { timeoutMs, maxEvidenceChars };
}

// ─── Diagnostics shape ───────────────────────────────────────────────────────
//
// One axis call produces:
//   {
//     axis: "topics" | "keywords",
//     enabled: boolean,             // semantic axis was active per config
//     scorerProvided: boolean,      // a scorer fn was actually passed
//     threshold: number,            // gate value used
//     candidateCount: number,       // labels considered (allowed minus already-deterministic)
//     acceptedCount: number,        // labels above threshold
//     rejectedCount: number,        // candidateCount - acceptedCount
//     belowThresholdCount: number,  // subset of rejected: had a score, but < threshold
//     // ── Phase 5 additions ──
//     runtimeState: RuntimeState,   // derived state (see below)
//     scorerLatencyMs: number,      // cumulative wall-clock time spent in scorer calls
//     fallbackReasonCounts: {       // per-reason failure counts (axis-local)
//       timeout: number,
//       error: number,
//     },
//   }
//
// Aggregated across stories, the same shape is rolled up into
// `_lastRunMeta.tags.{topics,keywords}` → `_meta.tags.{topics,keywords}` so
// an operator can answer "is semantic widening firing, how often is it
// borderline, did the production scorer fail closed, how slow was it?".

/**
 * Operator-facing runtime states for the semantic axis.  Derived AFTER the
 * mapper run completes from the captured state (enabled flag, scorerProvided
 * flag, fallbackReasonCounts).  Stored on diagnostics so the operator can
 * read a single string from `_meta.tags.{topics,keywords}.runtimeState`
 * instead of recombining flags by hand.
 *
 *   - disabled                  — axis flag was off (or global flag off).
 *   - enabled_no_scorer         — flag on, but no scorer was provided
 *                                 (production wiring degraded / not yet
 *                                 wired).  Semantic uplift produces no
 *                                 additions; deterministic baseline ships.
 *   - enabled_scorer_ready      — flag on, scorer provided, all calls
 *                                 returned a numeric score.  Semantic
 *                                 uplift may have fired.
 *   - scorer_error_fallback     — flag on, scorer provided, but at least
 *                                 one candidate call threw (non-timeout).
 *                                 Per-candidate failure is non-fatal; this
 *                                 state surfaces the partial degradation
 *                                 so an operator can spot a flaky scorer.
 *   - scorer_timeout_fallback   — flag on, scorer provided, at least one
 *                                 candidate call exceeded the configured
 *                                 timeout budget.
 *
 * When both timeout and error happen in the same run, `scorer_timeout_fallback`
 * wins (timeout is the more actionable signal for an operator — it usually
 * indicates capacity / latency drift on the provider side).
 */
export const RUNTIME_STATE = Object.freeze({
  DISABLED: "disabled",
  ENABLED_NO_SCORER: "enabled_no_scorer",
  ENABLED_SCORER_READY: "enabled_scorer_ready",
  SCORER_ERROR_FALLBACK: "scorer_error_fallback",
  SCORER_TIMEOUT_FALLBACK: "scorer_timeout_fallback",
});

function deriveRuntimeState({ enabled, scorerProvided, timeoutCount, errorCount }) {
  if (!enabled) return RUNTIME_STATE.DISABLED;
  if (!scorerProvided) return RUNTIME_STATE.ENABLED_NO_SCORER;
  if (timeoutCount > 0) return RUNTIME_STATE.SCORER_TIMEOUT_FALLBACK;
  if (errorCount > 0) return RUNTIME_STATE.SCORER_ERROR_FALLBACK;
  return RUNTIME_STATE.ENABLED_SCORER_READY;
}

function emptyAxisDiagnostics(axis, threshold, opts = {}) {
  const enabled = Boolean(opts.enabled);
  const scorerProvided = Boolean(opts.scorerProvided);
  return {
    axis,
    enabled,
    scorerProvided,
    threshold,
    candidateCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    belowThresholdCount: 0,
    runtimeState: deriveRuntimeState({
      enabled,
      scorerProvided,
      timeoutCount: 0,
      errorCount: 0,
    }),
    scorerLatencyMs: 0,
    fallbackReasonCounts: { timeout: 0, error: 0 },
  };
}

// ─── Core mapper ─────────────────────────────────────────────────────────────

/**
 * Score evidence text against a closed list of allowed labels and return the
 * subset that meets a confidence threshold.  Inputs:
 *
 *   - `axis`               — "topics" | "keywords" (recorded in diagnostics).
 *   - `evidenceText`       — the meta-story evidence bundle.
 *   - `allowedLabels`      — `settings.topics` or `settings.keywords` (closed
 *                            output vocabulary; the mapper cannot widen this).
 *   - `deterministicLabels` — labels already accepted via the deterministic
 *                            path; these are NOT re-scored (de-duplication).
 *   - `threshold`          — score cut-off (`>= threshold` → accepted).
 *   - `enabled`            — when false, no candidate is scored and the empty
 *                            additions array is returned (with skipped-state
 *                            diagnostics).
 *   - `scorer`             — `(evidenceText, label) -> number | Promise<number>`.
 *                            When absent, behavior matches `enabled === false`
 *                            (`scorerProvided: false` in diagnostics).
 *
 * Returns `{ accepted: string[], diagnostics }`.  `accepted` contains only
 * labels that (1) are in `allowedLabels`, (2) are NOT already in
 * `deterministicLabels`, and (3) scored `>= threshold`.  Output preserves
 * the order of `allowedLabels` (callers stable-sort downstream).
 *
 * The function is async because the scorer may be — production wirings will
 * typically wrap an embedding API or a constrained classifier.
 */
export async function mapSemanticAxis({
  axis,
  evidenceText,
  allowedLabels,
  deterministicLabels = [],
  threshold,
  enabled,
  scorer,
}) {
  const cleanedAllowed = sanitizeStringList(allowedLabels);
  const deterministicSet = new Set(
    sanitizeStringList(deterministicLabels).map((v) => v.toLowerCase())
  );
  const scorerProvided = typeof scorer === "function";
  const isEnabled = Boolean(enabled) && scorerProvided;

  // Diagnostics start empty; we mutate the counters as we score.
  const diagnostics = emptyAxisDiagnostics(axis, threshold, {
    enabled: Boolean(enabled),
    scorerProvided,
  });

  // No-text / no-vocabulary / disabled / no-scorer → fast empty path.
  if (
    !isEnabled ||
    typeof evidenceText !== "string" ||
    evidenceText.length === 0 ||
    cleanedAllowed.length === 0
  ) {
    return { accepted: [], diagnostics };
  }

  const accepted = [];
  for (const label of cleanedAllowed) {
    if (deterministicSet.has(label.toLowerCase())) continue;
    diagnostics.candidateCount += 1;
    let score = 0;
    const startMs = Date.now();
    try {
      const raw = await scorer(evidenceText, label, { axis });
      diagnostics.scorerLatencyMs += Date.now() - startMs;
      score = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    } catch (err) {
      // Phase 5: categorize fallback reason.  Timeout (a `SemanticScorerTimeoutError`
      // thrown by the scorer wrapper) is distinguished from a generic scorer
      // error — both are non-fatal (deterministic baseline still ships) but
      // they map to different runtime states so an operator can tell "the
      // provider is slow" from "the provider is broken".  Latency for the
      // failed call is still counted toward `scorerLatencyMs` so a slow
      // failure isn't invisible in the dashboards.
      diagnostics.scorerLatencyMs += Date.now() - startMs;
      diagnostics.rejectedCount += 1;
      if (err instanceof SemanticScorerTimeoutError) {
        diagnostics.fallbackReasonCounts.timeout += 1;
      } else {
        diagnostics.fallbackReasonCounts.error += 1;
      }
      continue;
    }
    if (score >= threshold) {
      accepted.push(label);
      diagnostics.acceptedCount += 1;
    } else {
      diagnostics.rejectedCount += 1;
      diagnostics.belowThresholdCount += 1;
    }
  }
  // Final runtime state is derived after all candidates are scored so an
  // operator reading the diagnostic gets the worst-observed degradation
  // (timeout > error > ready).  Even when SOME candidates succeed, a single
  // timeout flips the axis state to `scorer_timeout_fallback` — this is the
  // posture we want: degradation surfaces immediately rather than getting
  // averaged out across the run.
  diagnostics.runtimeState = deriveRuntimeState({
    enabled: Boolean(enabled),
    scorerProvided,
    timeoutCount: diagnostics.fallbackReasonCounts.timeout,
    errorCount: diagnostics.fallbackReasonCounts.error,
  });
  return { accepted, diagnostics };
}

/**
 * Convenience wrapper that maps both `topics` and `keywords` in one call,
 * sharing the same evidence text and scorer.  Returns:
 *
 *   {
 *     topics:   { accepted, diagnostics },
 *     keywords: { accepted, diagnostics },
 *   }
 *
 * Geographies are NOT mapped here.  Phase 4 keeps the deterministic-only
 * posture for geo intentionally — see [`meta-story-tags.mjs`](./meta-story-tags.mjs)
 * for the geo path.
 */
export async function mapSemanticTopicsAndKeywords({
  evidenceText,
  settingsTopics,
  settingsKeywords,
  deterministicTopics = [],
  deterministicKeywords = [],
  config,
  scorer,
}) {
  const cfg = config ?? resolveSemanticTagConfig();
  const [topics, keywords] = await Promise.all([
    mapSemanticAxis({
      axis: "topics",
      evidenceText,
      allowedLabels: settingsTopics,
      deterministicLabels: deterministicTopics,
      threshold: cfg.topicsThreshold,
      enabled: cfg.topicsEnabled,
      scorer,
    }),
    mapSemanticAxis({
      axis: "keywords",
      evidenceText,
      allowedLabels: settingsKeywords,
      deterministicLabels: deterministicKeywords,
      threshold: cfg.keywordsThreshold,
      enabled: cfg.keywordsEnabled,
      scorer,
    }),
  ]);
  return { topics, keywords };
}

// ─── Diagnostic aggregation helpers ──────────────────────────────────────────
//
// The pipeline emits one set of axis diagnostics per shipped story; the
// operator wants a single roll-up across the run.  These helpers compose
// without mutating their inputs.

/**
 * Returns a fresh, zero-initialized aggregate for a single axis.  Use this
 * as the starting accumulator for [`accumulateAxisDiagnostics`](./meta-story-semantic-mapper.mjs).
 */
export function emptyAggregateAxisDiagnostics(axis) {
  return {
    axis,
    enabled: false,
    scorerProvided: false,
    threshold: null,
    candidateCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    belowThresholdCount: 0,
    storyCount: 0,
    // Phase 5 aggregate fields
    runtimeState: RUNTIME_STATE.DISABLED,
    scorerLatencyMs: 0,
    fallbackReasonCounts: { timeout: 0, error: 0 },
  };
}

// Worst-observed runtime state across all stories in the aggregate.  Order is
// timeout > error > ready > no_scorer > disabled — once the worst is seen,
// it sticks.  This is what the operator reads to answer "did the production
// scorer degrade at any point during this run?".
const RUNTIME_STATE_RANK = {
  [RUNTIME_STATE.DISABLED]: 0,
  [RUNTIME_STATE.ENABLED_NO_SCORER]: 1,
  [RUNTIME_STATE.ENABLED_SCORER_READY]: 2,
  [RUNTIME_STATE.SCORER_ERROR_FALLBACK]: 3,
  [RUNTIME_STATE.SCORER_TIMEOUT_FALLBACK]: 4,
};

function worseRuntimeState(a, b) {
  const ra = RUNTIME_STATE_RANK[a] ?? 0;
  const rb = RUNTIME_STATE_RANK[b] ?? 0;
  return ra >= rb ? a : b;
}

/**
 * Merge a single-story axis diagnostic into a running aggregate (immutable
 * w.r.t. inputs; returns a fresh object).  `enabled` and `threshold` reflect
 * the configured state for the run — they should be the same across stories
 * so `Math.max` here mostly degenerates to a stable copy, but we still defend
 * against drift by keeping the first non-null value.  Latency, fallback
 * reasons, and runtime state aggregate too — see `worseRuntimeState`.
 */
export function accumulateAxisDiagnostics(aggregate, story) {
  if (!story || typeof story !== "object") return aggregate;
  return {
    axis: aggregate.axis,
    enabled: aggregate.enabled || Boolean(story.enabled),
    scorerProvided: aggregate.scorerProvided || Boolean(story.scorerProvided),
    threshold:
      aggregate.threshold == null ? (typeof story.threshold === "number" ? story.threshold : null) : aggregate.threshold,
    candidateCount: aggregate.candidateCount + (story.candidateCount ?? 0),
    acceptedCount: aggregate.acceptedCount + (story.acceptedCount ?? 0),
    rejectedCount: aggregate.rejectedCount + (story.rejectedCount ?? 0),
    belowThresholdCount: aggregate.belowThresholdCount + (story.belowThresholdCount ?? 0),
    storyCount: aggregate.storyCount + 1,
    runtimeState: worseRuntimeState(
      aggregate.runtimeState ?? RUNTIME_STATE.DISABLED,
      story.runtimeState ?? RUNTIME_STATE.DISABLED
    ),
    scorerLatencyMs: aggregate.scorerLatencyMs + (story.scorerLatencyMs ?? 0),
    fallbackReasonCounts: {
      timeout:
        (aggregate.fallbackReasonCounts?.timeout ?? 0) +
        (story.fallbackReasonCounts?.timeout ?? 0),
      error:
        (aggregate.fallbackReasonCounts?.error ?? 0) +
        (story.fallbackReasonCounts?.error ?? 0),
    },
  };
}

// ─── Production scorer factory (embedding cosine similarity) ────────────────
//
// Wraps an `embedFn(texts) -> number[][]` (the same shape used by recall) in
// the `(evidence, label) -> number` scorer interface that `mapSemanticAxis`
// expects.  The wrapper:
//   - truncates evidence text to `maxEvidenceChars` so the request size is
//     bounded regardless of how chatty a meta-story is;
//   - races each scorer call against a `timeoutMs` wall-clock budget; on
//     timeout, throws `SemanticScorerTimeoutError` so the mapper categorizes
//     the fallback as `scorer_timeout_fallback` rather than a generic error;
//   - memoizes evidence + label embeddings WITHIN a single factory instance
//     so repeated probes against the same evidence (one per candidate label)
//     don't re-embed the bundle, and the same label probed in a later story
//     re-uses the prior vector;
//   - normalizes cosine similarity from `[-1, 1]` to `[0, 1]` so the existing
//     threshold knobs (`[0,1]`) keep working without re-calibration.
//
// Returns a scorer function ready to pass as `semanticTagScorer` to the
// pipeline.  This factory is the seam Phase 5 wires into `server.mjs`; tests
// continue to inject their own deterministic scorers and don't go through
// this path.
export function createEmbeddingSemanticScorer({
  embedFn,
  timeoutMs,
  maxEvidenceChars,
} = {}) {
  if (typeof embedFn !== "function") {
    throw new Error("createEmbeddingSemanticScorer: embedFn must be a function");
  }
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SCORER_TIMEOUT_MS;
  const effectiveMaxChars =
    Number.isFinite(maxEvidenceChars) && maxEvidenceChars > 0
      ? maxEvidenceChars
      : DEFAULT_MAX_EVIDENCE_CHARS;

  const evidenceCache = new Map(); // key: truncated evidence text → embedding vector
  const labelCache = new Map(); // key: label.toLowerCase() → embedding vector

  return async function embeddingScorer(evidence, label) {
    const truncated =
      typeof evidence === "string"
        ? evidence.length > effectiveMaxChars
          ? evidence.slice(0, effectiveMaxChars)
          : evidence
        : "";
    if (!truncated || typeof label !== "string" || label.length === 0) return 0;

    // Per-call timeout via Promise.race.  Note: the underlying embedFn may
    // continue running after the race resolves (no AbortController plumbed
    // through here yet) — that's acceptable for a fail-closed Phase 5 path,
    // the work just doesn't influence the response.  A follow-up can plumb
    // an AbortSignal end-to-end if provider quotas matter.
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new SemanticScorerTimeoutError(`scorer timeout after ${effectiveTimeout}ms`)),
        effectiveTimeout
      );
    });

    try {
      const evidenceKey = truncated;
      const labelKey = label.toLowerCase();
      const needEvidence = !evidenceCache.has(evidenceKey);
      const needLabel = !labelCache.has(labelKey);

      if (needEvidence || needLabel) {
        const probeTexts = [];
        if (needEvidence) probeTexts.push(truncated);
        if (needLabel) probeTexts.push(label);
        const vectors = await Promise.race([embedFn(probeTexts), timeoutPromise]);
        if (!Array.isArray(vectors) || vectors.length !== probeTexts.length) {
          // Defensive: any malformed response counts as a generic scorer
          // error so the mapper records `scorer_error_fallback`.
          throw new Error("embedFn returned malformed vectors");
        }
        let idx = 0;
        if (needEvidence) {
          evidenceCache.set(evidenceKey, vectors[idx++]);
        }
        if (needLabel) {
          labelCache.set(labelKey, vectors[idx++]);
        }
      }

      const ev = evidenceCache.get(truncated);
      const la = labelCache.get(label.toLowerCase());
      const cosine = cosineSimilarity(ev, la);
      // Rescale cosine [-1, 1] → [0, 1] so existing thresholds in the same
      // range stay applicable.  For typical text embeddings, cosine is rarely
      // negative; the rescale just makes the worst case representable.
      return (cosine + 1) / 2;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
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

// ─── Internal helpers ────────────────────────────────────────────────────────

function sanitizeStringList(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}
