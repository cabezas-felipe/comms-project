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

// ─── Diagnostics shape ───────────────────────────────────────────────────────
//
// One axis call produces:
//   {
//     axis: "topics" | "keywords",
//     enabled: boolean,           // semantic axis was active
//     scorerProvided: boolean,    // a scorer fn was actually passed
//     threshold: number,          // gate value used
//     candidateCount: number,     // labels considered (allowed minus already-deterministic)
//     acceptedCount: number,      // labels above threshold
//     rejectedCount: number,      // candidateCount - acceptedCount
//     belowThresholdCount: number, // subset of rejected: had a score, but < threshold
//   }
// Aggregated across stories, the same shape is rolled up into
// `_lastRunMeta.tags.{topics,keywords}` so an operator can answer
// "is semantic widening firing, and how often is it borderline?".

function emptyAxisDiagnostics(axis, threshold, opts = {}) {
  return {
    axis,
    enabled: Boolean(opts.enabled),
    scorerProvided: Boolean(opts.scorerProvided),
    threshold,
    candidateCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    belowThresholdCount: 0,
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
    try {
      const raw = await scorer(evidenceText, label, { axis });
      score = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    } catch {
      // Scorer failure on a single candidate is non-fatal — count it as a
      // rejection and continue.  A broken scorer shouldn't take down tag
      // emission for the whole story; the deterministic baseline still ships.
      diagnostics.rejectedCount += 1;
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
  };
}

/**
 * Merge a single-story axis diagnostic into a running aggregate (immutable
 * w.r.t. inputs; returns a fresh object).  `enabled` and `threshold` reflect
 * the configured state for the run — they should be the same across stories
 * so `Math.max` here mostly degenerates to a stable copy, but we still defend
 * against drift by keeping the first non-null value.
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
  };
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
