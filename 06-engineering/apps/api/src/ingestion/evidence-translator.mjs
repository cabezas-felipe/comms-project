// Translation-first evidence normalization (Phase 3 Slice 14).
//
// Why this stage exists:
//   Recall (lexical keyword/topic gate + embedding similarity) consumes source
//   item *text*. A Spanish RSS item never matches an English user keyword
//   ("migración" ≠ "migration"), so it is dropped before the precision stages
//   can ever see it. This module normalizes non-English evidence to English so
//   the SAME recall machinery admits it — no second bilingual keyword path, no
//   giant dictionary as the primary mechanism (locked product decision:
//   translation-first).
//
// What it does:
//   - Per-source evidence budget: headline + first 2 body snippets, capped at
//     ~700 chars (TRANSLATION_MAX_CHARS). We translate the budget, not the full
//     article — recall only needs a strong lexical/semantic signal.
//   - Dual-text retention: originals (`headline` / `body`) are NEVER mutated;
//     the English normalization lands on `normalizedHeadline` /
//     `normalizedBody`. Downstream consumers read normalized-when-present and
//     fall back to the original, so English items are untouched.
//   - Bounded concurrency (pMap) + per-call timeout (withTimeout) + cache keyed
//     by a stable source id + text hash. Fail-open: a translation error/timeout
//     leaves the item untranslated (passes through) and is recorded in
//     diagnostics — translation NEVER blocks a full refresh.
//
// What it does NOT do:
//   - It does not gate or drop items. A failed translation passes through
//     untranslated; recall decides admission as before.
//   - It does not detect language heuristically beyond a simple `item.lang`
//     check. Feeds carry a `lang` tag (Phase 4 Spanish feeds set `lang: "es"`);
//     items with no `lang` or an `en*` lang are treated as English (no-op).
//   - Activation is mode-driven (`TEMPO_TRANSLATION_MODE=auto|on|off`, default
//     `auto`) rather than a single static "enabled" flag. In `auto`, the stage
//     runs only when the current run carries non-English evidence.

import { createHash } from "node:crypto";
import { pMap } from "../util/p-map.mjs";
import { withTimeout } from "../ai/guardrails.mjs";

export const EVIDENCE_TRANSLATION_VERSION = "evidence-translate-v1";

// Per-source evidence budget (locked product decision).
export const TRANSLATION_MAX_SNIPPETS = 2; // headline + first 2 body snippets
export const TRANSLATION_MAX_CHARS = 700; // cap on the joined budget text

// Writer confidence threshold: a story is full-confidence when at least this
// fraction of its sources carry usable English evidence (English-native OR
// successfully translated). Below it the story is marked degraded/low-confidence
// — never hard-blocked (locked product decision).
export const TRANSLATION_COVERAGE_THRESHOLD = 0.6;

const DEFAULT_CONCURRENCY = 4;
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;
// Bounded short-text translation: a single headline + 2 snippets round-trip is
// small, but we keep a generous ceiling so a slow provider fails-open rather
// than hanging the refresh. Override via TEMPO_TRANSLATION_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 8000;
const TARGET_LANG = "en";

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// ─── Translation mode (auto | on | off) ──────────────────────────────────────
//
// Activation is no longer a single static boolean. The mode decides whether the
// translation stage runs:
//   - "off"  — never translate (English-only posture; the legacy default).
//   - "on"   — always attempt translation (forces the stage on).
//   - "auto" — translate ONLY when the run's selected+matched feed set carries
//              non-English evidence (the new DEFAULT). This closes the root-cause
//              gap where translation stayed off while a user selected Spanish
//              sources, so Spanish election stories were dropped at topic/keyword
//              recall.
//
// The runtime "are non-English feeds present?" half lives in the pipeline (it
// needs the post-geo candidate set); this module owns mode resolution and the
// pure activation decision so both are unit-testable without driving a refresh.
export const TRANSLATION_MODE = Object.freeze({ AUTO: "auto", ON: "on", OFF: "off" });

const VALID_TRANSLATION_MODES = new Set([
  TRANSLATION_MODE.AUTO,
  TRANSLATION_MODE.ON,
  TRANSLATION_MODE.OFF,
]);

/**
 * Resolve the translation mode from env at call time. Precedence (highest first):
 *
 *   1. LEGACY OVERRIDE — `TEMPO_TRANSLATION_ENABLED`, when explicitly set to a
 *      truthy/falsy value, preserves the pre-mode semantics: `true`/`1` → "on",
 *      `false`/`0` → "off". An operator who pinned the old flag keeps the exact
 *      behavior they configured, regardless of `TEMPO_TRANSLATION_MODE`.
 *   2. `TEMPO_TRANSLATION_MODE` — "auto" | "on" | "off" (case-insensitive).
 *   3. DEFAULT — "auto".
 *
 * An unrecognized `TEMPO_TRANSLATION_MODE` value is ignored (falls through to
 * the default) rather than failing the refresh.
 */
export function resolveTranslationMode() {
  const rawEnabled = (process.env.TEMPO_TRANSLATION_ENABLED ?? "").trim().toLowerCase();
  if (rawEnabled === "true" || rawEnabled === "1") return TRANSLATION_MODE.ON;
  if (rawEnabled === "false" || rawEnabled === "0") return TRANSLATION_MODE.OFF;
  const rawMode = (process.env.TEMPO_TRANSLATION_MODE ?? "").trim().toLowerCase();
  if (VALID_TRANSLATION_MODES.has(rawMode)) return rawMode;
  return TRANSLATION_MODE.AUTO;
}

/**
 * Pure activation decision for the translation stage. Given the resolved mode,
 * whether the run carries non-English evidence, and whether a usable translator
 * exists, returns the run/diagnostic flags the pipeline drives the stage with.
 *
 *   - `shouldRun`        — does the stage attempt translation this run?
 *                          off → false; on → true; auto → nonEnglishPresent.
 *   - `required`         — is translation NEEDED to protect recall? True whenever
 *                          non-English evidence is present (data reality), so the
 *                          recall-risk signal is independent of how the mode was
 *                          set.
 *   - `unavailable`      — required but translation will NOT actually produce
 *                          English evidence this run (mode suppressed it, or no
 *                          usable translator). Fail-open is preserved — the items
 *                          still pass through untranslated; this only SURFACES the
 *                          gap so it stops being silent.
 *   - `unavailableReason`— enum diagnosing the unavailability (see below); null
 *                          when not unavailable.
 *   - `recallRisk`       — required && unavailable: non-English stories are at
 *                          risk of being dropped at recall this run.
 *
 * Reason precedence when unavailable: `mode_off` (mode suppressed a needed
 * translation) → `mock_only` → `missing_key` → `provider_unavailable`.
 */
export function computeTranslationActivation({
  mode,
  nonEnglishPresent,
  hasTranslateFn,
  mockOnly = false,
  hasApiKey = true,
}) {
  const required = Boolean(nonEnglishPresent);
  let shouldRun;
  if (mode === TRANSLATION_MODE.OFF) shouldRun = false;
  else if (mode === TRANSLATION_MODE.ON) shouldRun = true;
  else shouldRun = required; // auto

  const canTranslate = shouldRun && Boolean(hasTranslateFn);
  const unavailable = required && !canTranslate;

  let unavailableReason = null;
  if (unavailable) {
    if (!shouldRun) unavailableReason = "mode_off";
    else if (mockOnly) unavailableReason = "mock_only";
    else if (!hasApiKey) unavailableReason = "missing_key";
    else unavailableReason = "provider_unavailable";
  }

  return { mode, required, shouldRun, unavailable, unavailableReason, recallRisk: unavailable };
}

/**
 * Read translation config from env at call time (mirrors resolveRecallConfig).
 * Carries the resolved `mode` (see resolveTranslationMode) so the pipeline can
 * drive activation off it. `enabled` is retained for backward compatibility with
 * direct callers and reflects the static decision: true only when mode is "on"
 * (the "auto" runtime half is computed in the pipeline). Default mode is "auto",
 * so `enabled` is false at static resolution unless forced on.
 */
export function resolveTranslationConfig() {
  const mode = resolveTranslationMode();
  const enabled = mode === TRANSLATION_MODE.ON;
  return {
    mode,
    enabled,
    concurrency: clamp(
      parsePositiveInt(process.env.TEMPO_TRANSLATION_CONCURRENCY, DEFAULT_CONCURRENCY),
      CONCURRENCY_MIN,
      CONCURRENCY_MAX
    ),
    timeoutMs: parsePositiveInt(process.env.TEMPO_TRANSLATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxChars: TRANSLATION_MAX_CHARS,
    maxSnippets: TRANSLATION_MAX_SNIPPETS,
    // A6: optional stage wall-clock budget (ms). Null by default — env-driven
    // runs do not cap the stage; the cold-start profile passes a finite budget
    // through the pipeline. Absent/null/non-finite/non-positive → unbounded.
    maxWallClockMs: null,
  };
}

// ─── Language signal ─────────────────────────────────────────────────────────

/**
 * Items with no `lang`, or a `lang` that starts with "en", are English and need
 * no translation. Anything else (e.g. "es", "es-CO", "pt") is non-English
 * evidence the recall stage cannot match against English settings.
 */
export function isNonEnglishItem(item) {
  const lang = typeof item?.lang === "string" ? item.lang.trim().toLowerCase() : "";
  if (!lang) return false;
  return !lang.startsWith("en");
}

// ─── Evidence budget ─────────────────────────────────────────────────────────

function bodyToSnippets(body) {
  if (Array.isArray(body)) return body.map((s) => String(s ?? "").trim()).filter(Boolean);
  const s = String(body ?? "").trim();
  return s ? [s] : [];
}

/**
 * Build the bounded segment list to translate: [headline, snippet1, snippet2],
 * truncated so the joined text stays within `maxChars`. Empty segments are
 * dropped. Returns the ordered segments — segments[0] is the headline (may be
 * "" if the item had none), the rest are body snippets.
 */
export function buildEvidenceSegments(item, { maxChars = TRANSLATION_MAX_CHARS, maxSnippets = TRANSLATION_MAX_SNIPPETS } = {}) {
  const headline = String(item?.headline ?? "").trim();
  const snippets = bodyToSnippets(item?.body).slice(0, maxSnippets);
  const segments = [headline, ...snippets];

  // Char-budget the joined text. The headline is kept whole (short by nature);
  // we trim/drop trailing snippets once the running total reaches the cap.
  const budgeted = [];
  let used = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    const clipped = seg.length > remaining ? seg.slice(0, remaining) : seg;
    budgeted.push(clipped);
    used += clipped.length;
  }
  // Preserve the headline slot even when empty so translated[0] always maps to
  // the headline and translated.slice(1) maps to the body snippets.
  if (budgeted.length === 0) budgeted.push("");
  return budgeted;
}

// Boundary-safe cache hash: length-prefix each segment so distinct splits never
// collide (e.g. ["a b","c"] != ["a","b c"]). Pure-ASCII framing — no NUL or
// other control-byte separator, so the source can never regress to a binary diff.
function hashSegments(segments) {
  const hash = createHash("sha256");
  for (const seg of segments) {
    const s = String(seg ?? "");
    hash.update(`${s.length}:${s}`);
  }
  return hash.digest("hex").slice(0, 16);
}

function cacheKeyFor(item, lang, segments) {
  const id = item?.sourceId != null ? String(item.sourceId) : "__no_id";
  return `${id}::${lang}::${hashSegments(segments)}`;
}

// ─── Percentiles (latency diagnostics) ───────────────────────────────────────

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  // Nearest-rank: index = ceil(p/100 * N) - 1, clamped.
  const idx = clamp(Math.ceil((p / 100) * sortedAsc.length) - 1, 0, sortedAsc.length - 1);
  return sortedAsc[idx];
}

// ─── Core: translate evidence items ──────────────────────────────────────────

/**
 * Translate non-English evidence to English, annotating each item with
 * `normalizedHeadline` / `normalizedBody` (English) and a `_translation`
 * diagnostic stamp. Originals are never mutated. Returns a NEW array (English
 * items pass through unchanged except for the `_translation` stamp).
 *
 * `translateFn(segments: string[], { sourceLang, targetLang, sourceId }) => Promise<string[]>`
 * returns the translated segments in order. Production wraps the AI router;
 * tests inject a deterministic stub. Any throw/timeout fails open.
 *
 * @param {object}   opts
 * @param {Array}    opts.items        — post-geo candidate items
 * @param {Function} opts.translateFn  — batch segment translator (injected)
 * @param {object}   opts.config       — { enabled, concurrency, timeoutMs, maxChars, maxSnippets }
 * @param {Map}      [opts.cache]      — stable-key cache (sourceId+lang+texthash); created if absent
 * @returns {Promise<{ items: Array, diagnostics: object }>}
 */
export async function translateEvidenceItems(opts) {
  const {
    items = [],
    translateFn = null,
    config = resolveTranslationConfig(),
    cache = new Map(),
  } = opts ?? {};

  const candidateCount = Array.isArray(items) ? items.length : 0;
  // A6: normalize the optional stage wall-clock budget. Anything non-finite or
  // ≤ 0 disables the cap (unbounded scheduling, byte-identical to pre-A6).
  const wallClockBudgetMs =
    Number.isFinite(config?.maxWallClockMs) && config.maxWallClockMs > 0
      ? Math.floor(config.maxWallClockMs)
      : null;
  const baseDiagnostics = {
    version: EVIDENCE_TRANSLATION_VERSION,
    enabled: Boolean(config?.enabled),
    coverageThreshold: TRANSLATION_COVERAGE_THRESHOLD,
    candidateCount,
    neededCount: 0,
    translatedCount: 0,
    passthroughCount: 0, // English-native items (no translation needed)
    failedCount: 0, // needed but errored/timed-out → passed through untranslated
    timeoutCount: 0,
    cacheHits: 0,
    degradedFallbackRate: 0, // failed / needed
    latencyMsP50: 0,
    latencyMsP95: 0,
    // A6: stage wall-clock budget diagnostics (additive). `wallClockBudgetMs` is
    // the normalized cap (null when unbounded); `wallClockBudgetHit` is true when
    // at least one needed item was deferred for budget; `wallClockSkippedCount`
    // is how many. Budget-deferred items are NOT failures — see the scheduling
    // guard below — so `failedCount` / `degradedFallbackRate` exclude them.
    wallClockBudgetMs,
    wallClockBudgetHit: false,
    wallClockSkippedCount: 0,
  };

  // Disabled / no translator / nothing to do → pass items through untouched.
  // Each item still gets a `_translation` stamp so coverage math downstream is
  // uniform (English items are "covered" because they need no translation).
  if (!config?.enabled || typeof translateFn !== "function" || candidateCount === 0) {
    const stamped = (items ?? []).map((item) => {
      const needed = isNonEnglishItem(item);
      return {
        ...item,
        _translation: {
          needed,
          applied: false,
          failed: false,
          fromCache: false,
          // When the stage is off but the item is non-English, it is NOT
          // covered (no usable English evidence) — surfaced so a disabled
          // run still reports honest coverage rather than a false 100%.
          reason: !config?.enabled ? "stage_disabled" : needed ? "no_translate_fn" : null,
          lang: typeof item?.lang === "string" ? item.lang : null,
        },
      };
    });
    const neededCount = stamped.filter((it) => it._translation.needed).length;
    return {
      items: stamped,
      diagnostics: {
        ...baseDiagnostics,
        neededCount,
        passthroughCount: candidateCount - neededCount,
        failedCount: neededCount, // not translated → not covered
        degradedFallbackRate: neededCount > 0 ? 1 : 0,
      },
    };
  }

  const latencies = [];
  let translatedCount = 0;
  let failedCount = 0;
  let timeoutCount = 0;
  let cacheHits = 0;
  let neededCount = 0;
  let wallClockSkippedCount = 0;
  // A6: stage timer for the wall-clock budget. The pMap worker pool pulls items
  // one at a time; the guard below runs when a worker PICKS UP an item, so once
  // the budget is spent every newly-pulled item is deferred rather than starting
  // a fresh translation call — but any call already in flight runs to completion.
  const stageStartedAt = Date.now();

  const out = await pMap(
    items,
    async (item) => {
      if (!isNonEnglishItem(item)) {
        return {
          ...item,
          _translation: {
            needed: false,
            applied: false,
            failed: false,
            fromCache: false,
            reason: null,
            lang: typeof item?.lang === "string" ? item.lang : null,
          },
        };
      }

      neededCount++;
      const lang = item.lang.trim().toLowerCase();
      const segments = buildEvidenceSegments(item, {
        maxChars: config.maxChars ?? TRANSLATION_MAX_CHARS,
        maxSnippets: config.maxSnippets ?? TRANSLATION_MAX_SNIPPETS,
      });
      const key = cacheKeyFor(item, lang, segments);

      if (cache.has(key)) {
        cacheHits++;
        translatedCount++;
        const cached = cache.get(key);
        return {
          ...item,
          normalizedHeadline: cached.normalizedHeadline,
          normalizedBody: cached.normalizedBody,
          _translation: { needed: true, applied: true, failed: false, fromCache: true, reason: null, lang },
        };
      }

      // A6: wall-clock budget guard at the scheduling boundary. A worker that
      // reaches a cache MISS after the stage budget is exhausted does NOT start a
      // new translation call — the item passes through untranslated with a
      // deterministic defer stamp. Cache hits above are free and always served.
      // Budget exhaustion is a bounded DEFER, never a failure: it does not touch
      // `failedCount`/`timeoutCount`, so `degradedFallbackRate` keeps reflecting
      // true errors/timeouts only. Fail-open posture is preserved — recall still
      // sees the original text.
      if (wallClockBudgetMs != null && Date.now() - stageStartedAt >= wallClockBudgetMs) {
        wallClockSkippedCount++;
        return {
          ...item,
          _translation: {
            needed: true,
            applied: false,
            failed: false,
            fromCache: false,
            reason: "wall_clock_budget_exhausted",
            lang,
          },
        };
      }

      const startedAt = Date.now();
      try {
        const translated = await withTimeout(
          () =>
            Promise.resolve(
              translateFn(segments, {
                sourceLang: lang,
                targetLang: TARGET_LANG,
                sourceId: item.sourceId,
              })
            ),
          config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          `evidence translation timed out (${item.sourceId})`
        );
        if (!Array.isArray(translated) || translated.length !== segments.length) {
          throw new Error(
            `translateFn returned ${Array.isArray(translated) ? translated.length : "non-array"} segments, expected ${segments.length}`
          );
        }
        const normalizedHeadline = String(translated[0] ?? "").trim();
        const normalizedBody = translated.slice(1).map((s) => String(s ?? "").trim()).filter(Boolean);
        latencies.push(Date.now() - startedAt);
        translatedCount++;
        cache.set(key, { normalizedHeadline, normalizedBody });
        return {
          ...item,
          normalizedHeadline,
          normalizedBody,
          _translation: { needed: true, applied: true, failed: false, fromCache: false, reason: null, lang },
        };
      } catch (err) {
        // Fail-open: leave the item untranslated; recall handles admission.
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = /timed out|timeout|abort/i.test(msg);
        if (isTimeout) timeoutCount++;
        failedCount++;
        console.warn(
          `[evidence-translate] FAIL-OPEN sourceId=${item?.sourceId ?? "?"} lang=${lang} reason=${isTimeout ? "timeout" : "error"} err=${msg}`
        );
        return {
          ...item,
          _translation: {
            needed: true,
            applied: false,
            failed: true,
            fromCache: false,
            reason: isTimeout ? "timeout" : "error",
            lang,
          },
        };
      }
    },
    config.concurrency ?? DEFAULT_CONCURRENCY
  );

  // pMap returns settled wrappers; our mapper never throws (errors are caught
  // and returned as fail-open items), so every settle is fulfilled.
  const resultItems = out.map((settled, idx) =>
    settled.status === "fulfilled" ? settled.value : { ...items[idx] }
  );

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    items: resultItems,
    diagnostics: {
      ...baseDiagnostics,
      neededCount,
      translatedCount,
      passthroughCount: candidateCount - neededCount,
      failedCount,
      timeoutCount,
      cacheHits,
      degradedFallbackRate: neededCount > 0 ? failedCount / neededCount : 0,
      latencyMsP50: percentile(sorted, 50),
      latencyMsP95: percentile(sorted, 95),
      // A6: wall-clock budget outcome for this run (additive; budgetMs already
      // carried via baseDiagnostics). Hit/skipped reflect deferred-not-failed.
      wallClockBudgetHit: wallClockSkippedCount > 0,
      wallClockSkippedCount,
    },
  };
}

// ─── Normalized-evidence readers ─────────────────────────────────────────────
//
// Consumers (lexical recall, embedding text builder, geo text gate) call these
// so they read English-when-present and fall back to the untouched original.
// English items (never translated) return their originals unchanged.

export function readHeadline(item) {
  const norm = typeof item?.normalizedHeadline === "string" ? item.normalizedHeadline.trim() : "";
  if (norm) return norm;
  return typeof item?.headline === "string" ? item.headline : "";
}

export function readBody(item) {
  const norm = item?.normalizedBody;
  if (Array.isArray(norm) && norm.length > 0) return norm;
  if (typeof norm === "string" && norm.trim()) return [norm];
  if (Array.isArray(item?.body)) return item.body;
  if (typeof item?.body === "string") return [item.body];
  return [];
}

export function readBodyText(item) {
  return readBody(item).join(" ");
}

// ─── Per-story coverage + diagnostics ────────────────────────────────────────

/**
 * Per-story translated-source coverage. A source is "covered" when it carries
 * usable English evidence: English-native (no translation needed) OR a
 * non-English item that was successfully translated. Non-English items that
 * failed translation are NOT covered.
 *
 * Returns `coverage` in [0,1] (1 for an empty story) and the `degraded` /
 * `confidence` markers derived from `TRANSLATION_COVERAGE_THRESHOLD`.
 */
export function computeStoryCoverage(sourceItems) {
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  const total = items.length;
  let needed = 0;
  let covered = 0;
  let translated = 0;
  for (const it of items) {
    const tr = it?._translation;
    const isNeeded = tr?.needed === true;
    if (isNeeded) needed++;
    const applied = tr?.applied === true;
    if (isNeeded && applied) translated++;
    const usable = !isNeeded || applied;
    if (usable) covered++;
  }
  const coverage = total === 0 ? 1 : covered / total;
  const degraded = coverage < TRANSLATION_COVERAGE_THRESHOLD;
  return {
    sourceCount: total,
    coveredCount: covered,
    neededCount: needed,
    translatedCount: translated,
    coverage,
    degraded,
    confidence: degraded ? "low" : "full",
  };
}
