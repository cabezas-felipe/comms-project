import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  getAiCapabilityMap,
  getAiMetrics,
  assertAiConfig,
  resolveExtractionChain,
  getProviderReadiness,
  isDcValidationModeEnabled,
  assertReadyForRealRun,
} from "./ai/model-router.mjs";
import { extractOnboarding, resolveTimeoutMs as resolveExtractionTimeoutMs } from "./ai/onboarding-extractor.mjs";
import { readSettings, writeSettings, hasSettings, DEFAULT_SETTINGS } from "./db/settings-repo.mjs";
import { isSupabaseEnabled, getSupabaseClient } from "./db/client.mjs";
import { readFeedItems } from "./ingestion/feed-reader.mjs";
import {
  writeRecentItems as cacheWriteRecentItems,
  readRecentItems as cacheReadRecentItems,
  cacheRowsToRawItems,
} from "./ingestion/recent-items-cache.mjs";
import { listIngestionFeeds } from "./ingestion/feed-manifest-repo.mjs";
import { trackServerEvent } from "./telemetry.mjs";
import { readSnapshot, writeSnapshot, writeSnapshotMeta, getLockedTitles, insertTitleLocks, readHoldBucket, writeHoldBucket, mergeEverSeenMetaStoryIds, extractEverSeenFromSnapshot } from "./db/dashboard-snapshot-repo.mjs";
import { appendRejections as appendStoryRejections } from "./db/story-rejection-log-repo.mjs";
import { clusterItems } from "./ai/cluster-engine.mjs";
import { embedTexts } from "./ai/embeddings.mjs";
import { resolveProductionTranslateFn } from "./ai/openai-translator.mjs";
import { runRefreshPipeline } from "./dashboard/refresh-pipeline.mjs";
import {
  createEmbeddingSemanticScorer,
  resolveSemanticTagConfig,
  resolveSemanticScorerRuntimeConfig,
} from "./dashboard/meta-story-semantic-mapper.mjs";
import { resolveRecallConfig } from "./ingestion/embedding-recall.mjs";
import { resolveSemanticBeatFitConfig } from "./dashboard/semantic-beat-fit.mjs";
import {
  tryAcquire as tryAcquireRefresh,
  release as releaseRefresh,
  REFRESH_GUARD_SCOPE,
} from "./dashboard/refresh-guard.mjs";
import {
  listSnapshotAnchors as orchestratorListSnapshotAnchors,
  runDueRefreshes as orchestratorRunDueRefreshes,
} from "./dashboard/due-user-orchestrator.mjs";
import { assessGeoConfidence } from "./dashboard/geo-filter.mjs";
import {
  parseFallbackFeedIdsEnv,
  parseFallbackEnabledEnv,
  resolveSelectedSources,
} from "./ingestion/source-matcher.mjs";
import { recordSourceRegistryEventsFromSettings } from "./db/source-registry-sync.mjs";
import { appendOnboardingNarrative, readCurrentOnboardingNarrative } from "./db/narrative-repo.mjs";
import { atomicSaveSettingsAndNarrative } from "./db/atomic-settings-save.mjs";
import {
  normalizeTopicLabel,
  normalizeKeywordLabel,
  normalizeSourceName,
  stripKeywordsMatchingGeographies,
  dashboardPayloadSchema,
  settingsPayloadSchema,
} from "./contracts-runtime/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.TEMPO_DATA_DIR ?? path.join(ROOT, "data");
const PORT = Number(process.env.TEMPO_API_PORT || 8787);

let _envBootstrapAttempted = false;
function bootstrapApiEnv() {
  if (_envBootstrapAttempted || process.env.NODE_ENV === "test") return;
  _envBootstrapAttempted = true;

  const hasSupabaseEnv =
    Boolean(process.env.SUPABASE_URL) &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);
  if (!hasSupabaseEnv) {
    // Defensive fallback: load env from common roots when the process was started
    // from an unexpected entrypoint and missed main.mjs dotenv bootstrap.
    const candidates = [
      path.resolve(ROOT, ".env"),
      path.resolve(ROOT, ".env.local"),
      path.resolve(ROOT, "..", ".env"),
      path.resolve(ROOT, "..", ".env.local"),
      path.resolve(ROOT, "..", "..", ".env"),
      path.resolve(ROOT, "..", "..", ".env.local"),
    ];
    for (const envPath of candidates) {
      dotenv.config({ path: envPath });
    }

    const recovered =
      Boolean(process.env.SUPABASE_URL) &&
      Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);
    if (!recovered) {
      console.warn(
        "[api.env] Supabase env vars are still missing after dotenv bootstrap. " +
          "Expected SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)."
      );
    }
  }

  // Default semantic tag mapping ON for prototype runs. Explicit env values
  // still win (including kill-switch=true in emergencies).
  if (process.env.TEMPO_TAG_SEMANTIC_MAPPING_ENABLED == null) {
    process.env.TEMPO_TAG_SEMANTIC_MAPPING_ENABLED = "true";
  }
  if (process.env.TEMPO_TAG_SEMANTIC_TOPICS_ENABLED == null) {
    process.env.TEMPO_TAG_SEMANTIC_TOPICS_ENABLED = "true";
  }
  if (process.env.TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED == null) {
    process.env.TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED = "true";
  }
  if (process.env.TEMPO_TAG_SEMANTIC_KILL_SWITCH == null) {
    process.env.TEMPO_TAG_SEMANTIC_KILL_SWITCH = "false";
  }

  // Meta-story fields PR (Prompt 2): default the what-changed delta engine ON
  // for prototype runs.  Explicit env values still win; `TEMPO_AI_MOCK_ONLY=true`
  // continues to disable the LLM-bound stages via `resolveDeltaConfig()`.
  // The early-return on `NODE_ENV === "test"` above keeps the test suite's
  // legacy "delta off unless explicitly set" assumption intact.
  if (process.env.TEMPO_AI_DELTA_ENABLED == null) {
    process.env.TEMPO_AI_DELTA_ENABLED = "true";
  }

  // Why-this-matters writer (spec §9): mirror the delta posture.  Product
  // path is LLM-first — users see tailored implications copy on every refresh.
  // Templates are the failure / kill-switch path, not the default experience.
  // Explicit env values still win (`=false` is the operator kill-switch);
  // `TEMPO_AI_MOCK_ONLY=true` continues to disable the LLM stages via
  // `resolveWhyConfig()` (treated as LLM failure → deterministic template).
  if (process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED == null) {
    process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true";
  }
}
bootstrapApiEnv();

const app = express();
app.use(express.json());

/**
 * Resolves an email address to a Supabase userId via admin API.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; returns null on any failure.
 * Not production auth — this is the prototype email-recognition lookup.
 * Future upgrade path: replace with a proper session token exchange.
 */
async function emailToUserId(email) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    let page = 1;
    for (;;) {
      const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
      if (error || !data) return null;
      // Normalize both sides to handle stored-email casing differences.
      const match = data.users.find((u) => u.email?.toLowerCase() === email);
      if (match) return match.id;
      if (data.users.length < 1000) return null;
      page++;
    }
  } catch {
    return null;
  }
}

/**
 * Mutable hook for the email-to-userId lookup used in the email_recognition identity path.
 * Tests override _emailLookup.resolve to inject a deterministic userId without live Supabase.
 * Do not use in production code paths.
 */
export const _emailLookup = { resolve: emailToUserId };

// ─── Prototype email-recognition cache ───────────────────────────────────────
// In-memory cache for email→userId to reduce repeated listUsers scans within a session.
// Prototype optimization only — not a replacement for production auth/session design.
// Future upgrade: remove when resolver is swapped to token-based identity.
const EMAIL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EMAIL_CACHE_MAX = 100;               // clear-all on overflow (prototype simplicity)

/** @type {Map<string, { userId: string, expiresAt: number }>} */
const _emailCache = new Map();

function emailCacheGet(email) {
  const entry = _emailCache.get(email);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _emailCache.delete(email); return undefined; }
  return entry.userId;
}

function emailCacheSet(email, userId) {
  if (_emailCache.size >= EMAIL_CACHE_MAX) _emailCache.clear();
  _emailCache.set(email, { userId, expiresAt: Date.now() + EMAIL_CACHE_TTL_MS });
}

/** Exported for test teardown only — clears the email-recognition cache. */
export function _clearEmailCache() {
  _emailCache.clear();
}

/**
 * Resolves caller identity from the request. Returns { userId, source } or null.
 *
 * Precedence:
 *   1. Bearer token → Supabase JWT verification (production path; source: "bearer")
 *   2. x-recognized-email header → server-side email lookup (prototype path; source: "email_recognition")
 *
 * Path 2 does NOT trust client-supplied userId — email is resolved server-side to the
 * canonical userId. If a Bearer token is present but unresolvable, returns null without
 * falling through to the prototype path.
 *
 * Prototype identity (path 2) is not production auth. Intended future upgrade: swap
 * email_recognition for a proper short-lived token issued at landing.
 *
 * Exported so tests can exercise the resolver directly without HTTP overhead.
 */
export async function resolveIdentity(req) {
  // 1. Bearer token — Supabase-verified identity (production path)
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    if (isSupabaseEnabled()) {
      const token = authHeader.slice(7);
      try {
        const { data, error } = await getSupabaseClient().auth.getUser(token);
        if (!error && data?.user) {
          return { userId: data.user.id, source: "bearer" };
        }
      } catch { /* invalid token */ }
    }
    // Bearer present but unresolvable: do not fall through to prototype headers.
    return null;
  }

  // 2. Prototype recognized-identity: resolve email server-side (no client userId trust)
  const recognizedEmail = req.headers["x-recognized-email"];
  if (recognizedEmail && typeof recognizedEmail === "string" && recognizedEmail.trim()) {
    const email = recognizedEmail.trim().toLowerCase();
    const cachedId = emailCacheGet(email);
    if (cachedId !== undefined) return { userId: cachedId, source: "email_recognition" };
    const userId = await _emailLookup.resolve(email);
    if (userId) {
      emailCacheSet(email, userId);
      return { userId, source: "email_recognition" };
    }
  }

  return null;
}

/**
 * Mutable resolver hook. Tests override _auth.resolver to inject a deterministic identity
 * without a live Supabase instance. Do not use in production code paths.
 * Resolver must return { userId: string, source: string } or null.
 */
export const _auth = { resolver: resolveIdentity };

/**
 * Mutable extraction hook. Tests override _extraction.extract to simulate primary/fallback
 * success or failure without calling a live AI provider. Do not use in production code paths.
 */
export const _extraction = { extract: extractOnboarding };

/**
 * Mutable registry sync hook. Tests override _sourceRegistrySync.record to capture
 * sync calls without a live Supabase instance. Do not use in production code paths.
 */
export const _sourceRegistrySync = { record: recordSourceRegistryEventsFromSettings };

/**
 * Mutable narrative hook. Tests override _narrativeRepo.append to capture or
 * skip Supabase writes without a live instance. Do not use in production code paths.
 */
export const _narrativeRepo = { append: appendOnboardingNarrative, read: readCurrentOnboardingNarrative };

/**
 * Mutable atomic-save hook. Tests override _atomicSave.execute to simulate the RPC
 * path (success or failure) without a live Supabase instance. The real implementation
 * calls save_settings_with_narrative via supabase.rpc().
 * Do not use in production code paths.
 */
export const _atomicSave = { execute: atomicSaveSettingsAndNarrative };

/**
 * Mutable settings-write hook. Tests override _writeSettings.write to inject
 * failures without touching the filesystem or Supabase. Do not use in production code paths.
 */
export const _writeSettings = { write: writeSettings };

/**
 * Mutable settings-read hook. Tests override _readSettings.has / _readSettings.read to avoid
 * live Supabase or filesystem calls when reading previous settings before a write.
 * Do not use in production code paths.
 */
export const _readSettings = { has: hasSettings, read: readSettings };

/**
 * Mutable feed manifest hook. Tests override _feedManifest.list to return fixture
 * data without a live Supabase instance. Do not use in production code paths.
 */
export const _feedManifest = { list: listIngestionFeeds };

/**
 * Mutable snapshot repo hook. Tests override individual functions to control
 * snapshot reads/writes without filesystem or Supabase calls.
 */
export const _snapshotRepo = {
  read: readSnapshot,
  write: writeSnapshot,
  writeMeta: writeSnapshotMeta,
  getLocks: getLockedTitles,
  insertLocks: insertTitleLocks,
  readHeld: readHoldBucket,
  writeHeld: writeHoldBucket,
};

/**
 * Mutable cluster engine hook. Tests override cluster to inject deterministic
 * results without AI provider calls.
 */
export const _clusterEngine = { cluster: clusterItems };

/**
 * Mutable embeddings hook. Tests override `embed` to inject deterministic
 * vectors (or simulate timeout/error for fail-closed coverage) without
 * calling the OpenAI embeddings API.
 */
export const _embeddings = { embed: embedTexts };

/**
 * Mutable Tier-A recent-items cache hook (Sub-slices 2.2 + 2.3).  Tests
 * override the four members to exercise the cache path in isolation —
 * `enabled` and `client` decouple the cache toggle from the global
 * `isSupabaseEnabled()` check so a test can flip only this code path on
 * without forcing every other supabase adapter (settings, snapshots,
 * narrative) into network mode at the same time.
 *
 * Defaults preserve production behavior: gate on global supabase env,
 * use the shared singleton client.
 */
export const _recentItemsCache = {
  write: cacheWriteRecentItems,
  read: cacheReadRecentItems,
  enabled: () => isSupabaseEnabled(),
  client: () => getSupabaseClient(),
};

/**
 * Mutable live-fetch hook. Production reads `_feedReader.read`; tests override
 * it to assert the cache-miss branch forwards the user's matched `feedIds`
 * (Slice 2 scoped fetch) without hitting a real RSS endpoint.
 */
export const _feedReader = {
  read: readFeedItems,
};

/**
 * Mutable pipeline-runner seam. Pass-through to the imported `runRefreshPipeline`
 * (behavior identical) — exists so tests can observe the exact opts the wrapper
 * composes (e.g. the resolved `translateFn`) without running the full pipeline.
 * Mirrors the other mutable hooks (`_feedReader`, `_geoFilter`, `_rejectionLog`).
 */
export const _pipelineRunner = { run: runRefreshPipeline };

/**
 * Mutable refresh pipeline hook. Tests override run to simulate pipeline
 * outcomes (success, fallback, grounding failures) without running the full
 * pipeline.
 */
export const _refreshPipeline = {
  run: (opts) => {
    // Attach the production embedding-similarity scorer when any semantic
    // axis is enabled and no test scorer was injected.  When semantic is
    // OFF (default) or kill-switched, the scorer stays null and the
    // pipeline falls into its `disabled` / `enabled_no_scorer` runtime
    // states.  See [`runbook-semantic-tags.md`](../docs/runbook-semantic-tags.md).
    const semanticConfig = opts.semanticTagConfig ?? resolveSemanticTagConfig();
    const semanticAnyAxisOn = semanticConfig.topicsEnabled || semanticConfig.keywordsEnabled;
    let semanticTagScorer = opts.semanticTagScorer ?? null;
    if (!semanticTagScorer && semanticAnyAxisOn) {
      const runtime = resolveSemanticScorerRuntimeConfig();
      semanticTagScorer = createEmbeddingSemanticScorer({
        embedFn: (texts) => _embeddings.embed(texts),
        timeoutMs: runtime.timeoutMs,
        maxEvidenceChars: runtime.maxEvidenceChars,
      });
    }
    return _pipelineRunner.run({
      ...opts,
      clusterFn: _clusterEngine.cluster,
      geoAssessFn: _geoFilter.assess,
      readHeldFn: opts.userId ? () => _snapshotRepo.readHeld(opts.userId) : null,
      writeHeldFn: opts.userId ? (items) => _snapshotRepo.writeHeld(opts.userId, items) : null,
      readPriorSnapshotFn: opts.userId ? () => _snapshotRepo.read(opts.userId) : null,
      writeRejectionsFn: opts.userId ? (recs) => _rejectionLog.write(opts.userId, recs) : null,
      // priorWatermark + priorStoryCount are supplied directly by the route
      // handler from the persisted snapshot blob; avoiding double-reads of
      // the snapshot.  priorStoryCount lets the pipeline suppress the
      // watermark short-circuit when the prior snapshot was empty (so a
      // degraded run can't trap subsequent refreshes at zero).
      priorWatermark: opts.priorWatermark ?? null,
      priorStoryCount: opts.priorStoryCount ?? null,
      // Embedding-aware recall: in `hybrid_strict` mode the pipeline calls
      // this fn with [profileText, ...itemTexts]; absent/throwing → fail-closed.
      embedFn: (texts) => _embeddings.embed(texts),
      // Phase 4 S0 — production ES→EN evidence translation. Wires the real
      // OpenAI-backed translateFn (small/cheap model via TEMPO_OPENAI_API_KEY)
      // so the translation stage can run for real once TEMPO_TRANSLATION_ENABLED
      // is flipped on (preview-first). `resolveProductionTranslateFn()` returns
      // null under mock-only / no-key, which keeps the stage a no-op pass-
      // through (fail-open). An explicitly injected `opts.translateFn` (tests /
      // evals) always wins, so hermetic suites are unaffected.
      translateFn: opts.translateFn ?? resolveProductionTranslateFn(),
      // Phase 5 semantic-tag scorer (config + scorer).  Both may be null /
      // disabled; the pipeline degrades cleanly to the Phase 3 deterministic
      // baseline.  Diagnostics surface the runtime state on every run.
      semanticTagConfig: semanticConfig,
      semanticTagScorer,
      // Option A — semantic BeatFit. The stage reads its own config (kill
      // switch + enable flag + model) from env via resolveSemanticBeatFitConfig.
      // The embedFn is the same OpenAI router, but pinned to the configured
      // semantic model (default text-embedding-3-large) so recall keeps using
      // text-embedding-3-small while BeatFit upgrades to the larger model.
      semanticBeatFitConfig: opts.semanticBeatFitConfig ?? resolveSemanticBeatFitConfig(),
      semanticBeatFitEmbedFn: (texts, callOpts = {}) =>
        _embeddings.embed(texts, {
          signal: callOpts.signal,
          model:
            (opts.semanticBeatFitConfig ?? resolveSemanticBeatFitConfig()).model,
        }),
    });
  },
};

/**
 * Mutable rejection-log hook (Phase 3 strict grounding). Tests override
 * `_rejectionLog.write` to capture dropped-story records without persisting.
 * Internal only — never surfaced via dashboard routes.
 */
export const _rejectionLog = { write: appendStoryRejections };

/**
 * Mutable geo-confidence assessor hook.  Default is the Anthropic-backed
 * `assessGeoConfidence` (M4 / F3b) — Haiku 4.5 structured `{ confidence }`.
 * Reads env at call time, fails safe to `{ confidence: 0 }` (held) when the
 * key is absent or the SDK errors, and honors `TEMPO_AI_MOCK_ONLY=true` for
 * CI.  Tests override `_geoFilter.assess` directly with a deterministic stub.
 */
export const _geoFilter = { assess: assessGeoConfidence };

/**
 * Enforces recognized identity on a route. Sends 401 and returns null when identity cannot be resolved.
 * Callers must guard: `if (!identity) return;`
 * Returns { userId, source } on success.
 */
async function requireIdentity(req, res) {
  const identity = await _auth.resolver(req);
  if (!identity) {
    res.status(401).json({ message: "Authentication required. Provide a valid Bearer token or recognized-identity headers." });
    return null;
  }
  return identity;
}

try {
  assertAiConfig();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[ai.config] Misconfiguration detected: ${message}`);
}

/**
 * One-shot startup diagnostic for the onboarding extraction subsystem.
 * Prints the effective primary/fallback model + timeout that the route will
 * use, so a deploy that picked up an unexpected env (or missed an env reload)
 * is visible immediately without waiting for the first save attempt.
 *
 * Why this exists: the historical regression was a 1.2s default timeout
 * collapsing both models silently; that's now caught at boot, not at a user's
 * first onboarding submission.  Skipped under NODE_ENV=test so the API test
 * suite stays quiet.
 */
function logExtractionConfigOnStartup() {
  if (process.env.NODE_ENV === "test") return;
  const { primary, fallback } = resolveExtractionChain();
  const timeoutMs = resolveExtractionTimeoutMs();
  console.log(
    `[ai.config] extraction chain primary=${primary} fallback=${fallback} timeoutMs=${timeoutMs}`
  );
  if (timeoutMs < 5000) {
    console.warn(
      `[ai.config] WARNING: TEMPO_AI_TIMEOUT_MS=${timeoutMs} is below 5000ms — Anthropic Opus + Sonnet round-trips routinely take 3-8s on first call. ` +
        `A short timeout collapses BOTH models in the chain and silently falls back to baseline-only persist. ` +
        `Raise the value (or unset it) in your .env, not as an ad-hoc shell override.`
    );
  }
}
logExtractionConfigOnStartup();

/**
 * Load the ingestion manifest for source-selection (Phase 2).  Mirrors the
 * source-of-truth used by GET /api/ingestion/sources: Supabase via
 * listIngestionFeeds when enabled, else the file at data/source-feeds.json.
 * Failures are non-fatal — pipeline falls back to legacy outlet matching when
 * manifestFeeds is null.
 */
async function loadManifestForSelection() {
  try {
    if (isSupabaseEnabled()) {
      return await _feedManifest.list({ supabase: getSupabaseClient() });
    }
    const file = path.join(DATA_DIR, "source-feeds.json");
    const content = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.feeds) ? parsed.feeds : [];
  } catch (err) {
    console.warn(
      `[dashboard.refresh] manifest load failed (selection will fall back): ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
// Tag an extraction error so failure logs distinguish "the model timed out"
// from "the provider returned an error" from "we failed schema validation".
// Operators reading [onboarding.extract] lines can spot timeout drift (the
// historical regression) without grepping stack traces.
function classifyExtractionError(err) {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message.toLowerCase();
  if (msg.includes("timed out") || msg.includes("abort")) return "timeout";
  // Anthropic SDK + the OpenAI provider both surface non-2xx as `HTTP <code>`.
  if (/http \d{3}/.test(msg)) return "provider_http_error";
  if (msg.includes("api key") || msg.includes("required for")) return "config_error";
  if (msg.includes("zod") || msg.includes("validation") || msg.includes("invalid")) return "schema_error";
  return "provider_error";
}

// Trim, filter empties, and deduplicate (case-insensitive, first-occurrence wins).
// Applied to model-returned string arrays before persistence.
function normalizeStringArray(arr) {
  const seen = new Set();
  const result = [];
  for (const raw of arr) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) continue;
    const key = s.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(s); }
  }
  return result;
}


app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "@tempo/api" });
});

// D-064a: idempotent backfill for pre-D-064 settings. Users who onboarded
// before the dedupe shipped still carry country names in both `keywords` and
// `geographies`. We run the helper on every read and persist exactly once
// when (and only when) the keywords list actually changes. Subsequent reads
// are a no-op write-skip. Persistence failures are non-fatal — the client
// still receives the cleaned payload so the UI is correct even if the write
// hasn't landed yet.
function keywordListsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function backfillKeywordDedupe(payload, userId) {
  if (!payload || !Array.isArray(payload.keywords) || !Array.isArray(payload.geographies)) {
    return payload;
  }
  const cleanedKeywords = stripKeywordsMatchingGeographies(payload.keywords, payload.geographies);
  if (keywordListsEqual(cleanedKeywords, payload.keywords)) {
    return payload;
  }
  const next = { ...payload, keywords: cleanedKeywords };
  try {
    await _writeSettings.write(next, userId);
  } catch (err) {
    console.warn(
      `[settings.backfill] dedupe write failed user=${userId} err=${err instanceof Error ? err.message : err}`
    );
  }
  return next;
}

app.get("/api/settings", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const payload = await readSettings(identity.userId);
    const cleaned = await backfillKeywordDedupe(payload, identity.userId);
    res.json(cleaned);
  } catch (error) {
    res.status(500).json({
      message: "Failed to read settings.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.put("/api/settings", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  // Strip onboardingRawText before schema validation — settings schema stays clean.
  const { onboardingRawText: rawNarrative, ...settingsBody } = req.body ?? {};
  const onboardingRawText =
    typeof rawNarrative === "string" && rawNarrative.trim() ? rawNarrative.trim() : null;
  const result = settingsPayloadSchema.safeParse(settingsBody);
  if (!result.success) {
    res.status(400).json({
      message: "Invalid settings payload.",
      errors: result.error.errors,
    });
    return;
  }
  // D-064: enforce geo-keyword dedupe on every persisted payload — manual
  // Settings edits cannot reintroduce country names into the keywords axis
  // after first onboarding.
  result.data.keywords = stripKeywordsMatchingGeographies(
    result.data.keywords,
    result.data.geographies
  );
  try {
    // Read previous before writing so the sync can diff new vs existing sources.
    // hasSettings avoids auto-creating a default file for first-time users.
    // Any read failure falls back to null → first-save semantics (log all sources).
    let previousPayload = null;
    try {
      if (await _readSettings.has(identity.userId)) {
        previousPayload = await _readSettings.read(identity.userId);
      }
    } catch { /* treat unreadable previous as first-save */ }

    if (onboardingRawText && isSupabaseEnabled()) {
      // Atomic path (Supabase): settings upsert + narrative append run inside one
      // Postgres transaction via the save_settings_with_narrative RPC.  A failure
      // in either step rolls back both — no partial state is committed.
      await _atomicSave.execute({ userId: identity.userId, settingsPayload: result.data, rawNarrative: onboardingRawText });
    } else {
      // Sequential path: no narrative to persist, or file adapter (dev/test only).
      // File adapter has no transaction support; partial writes on error are acceptable
      // in dev since the adapter is never used in production.
      await _writeSettings.write(result.data, identity.userId);
      if (onboardingRawText) {
        // Reached only on file adapter — Supabase path takes the atomic branch above.
        await _narrativeRepo.append(identity.userId, onboardingRawText);
      }
    }

    // Post-save extraction — only when onboardingRawText was provided.
    // Non-fatal: settings + narrative already committed before this block.
    //
    // Safe-fallback contract: when both primary and fallback models fail, the
    // baseline `result.data` (already persisted) is what the client sees. The
    // client is responsible for sending empty arrays for AI-derivable fields
    // (keywords, geographies, traditional/social sources) at first onboarding —
    // we never inject seeded placeholders here. `_meta.extractionStatus` makes
    // the failure visible to the UI without blocking navigation.
    let settingsToReturn = result.data;
    let extractionStatus = "not_attempted"; // "succeeded" | "failed"
    if (onboardingRawText) {
      try {
        // Prefer the stored narrative (Supabase accumulation); fall back to the
        // raw text supplied in this request so extraction works on the file adapter
        // (where appendOnboardingNarrative is a no-op) without a false skipped status.
        const storedNarrative = await _narrativeRepo.read(identity.userId);
        const narrative = storedNarrative ?? onboardingRawText;
        // narrative is always non-empty here: onboardingRawText is non-null at this point.
        if (process.env.TEMPO_AI_MOCK_ONLY === "true" && process.env.NODE_ENV !== "test") {
          console.warn("[onboarding.extract] mock-only mode enabled; skipping extraction in non-test runtime");
          extractionStatus = "failed";
        } else {
          // Strict two-model chain.  Models are resolved from env at call
          // time via `resolveExtractionChain()` (defaults: Opus primary,
          // Sonnet fallback) — no literals hardcoded here, so a deprecation
          // or A/B swap is a single env flip.  No mock/default fallback: if
          // both models fail, extraction is skipped non-fatally.
          const { primary: primaryModel, fallback: fallbackModel } = resolveExtractionChain();
          let extracted = null;
          try {
            extracted = await _extraction.extract(narrative, primaryModel);
          } catch (primaryErr) {
            console.warn(
              `[onboarding.extract] primary failed model=${primaryModel} kind=${classifyExtractionError(primaryErr)} err=${primaryErr instanceof Error ? primaryErr.message : primaryErr}`
            );
            try {
              extracted = await _extraction.extract(narrative, fallbackModel);
            } catch (fallbackErr) {
              console.warn(
                `[onboarding.extract] fallback failed model=${fallbackModel} kind=${classifyExtractionError(fallbackErr)} err=${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`
              );
            }
          }
          if (extracted) {
            const extractedTopics = normalizeStringArray((extracted.topics ?? []).map(normalizeTopicLabel));
            const extractedKeywords = normalizeStringArray((extracted.keywords ?? []).map(normalizeKeywordLabel));
            const extractedGeographies = normalizeStringArray(extracted.geographies ?? []);
            const extractedTraditional = normalizeStringArray((extracted.traditionalSources ?? []).map(normalizeSourceName));
            const extractedSocial = normalizeStringArray(extracted.socialSources ?? []);
            const merged = {
              ...result.data,
              ...(extractedTopics.length > 0 && { topics: extractedTopics }),
              ...(extractedKeywords.length > 0 && { keywords: extractedKeywords }),
              ...(extractedGeographies.length > 0 && { geographies: extractedGeographies }),
              ...(extractedTraditional.length > 0 && { traditionalSources: extractedTraditional }),
              ...(extractedSocial.length > 0 && { socialSources: extractedSocial }),
            };
            // D-064: dedupe geo-equivalent keywords against the merged
            // geographies (the post-extraction set, not the pre-merge baseline).
            merged.keywords = stripKeywordsMatchingGeographies(merged.keywords, merged.geographies);
            const fieldsChanged = ["topics", "keywords", "geographies", "traditionalSources", "socialSources"]
              .some(f => JSON.stringify(merged[f]) !== JSON.stringify(result.data[f]));
            if (fieldsChanged) {
              await _writeSettings.write(merged, identity.userId);
            }
            settingsToReturn = merged;
            extractionStatus = "succeeded";
          } else {
            extractionStatus = "failed";
          }
        }
      } catch (extractErr) {
        console.error(
          `[onboarding.extract] post-save extraction failed for user ${identity.userId}: ${extractErr instanceof Error ? extractErr.message : extractErr}`
        );
        extractionStatus = "failed";
      }
    }

    // Registry sync always runs after the write(s) — append-only observation log.
    // Errors are swallowed internally; failures here never affect the response.
    await _sourceRegistrySync.record({ userId: identity.userId, previousPayload, nextPayload: settingsToReturn });
    trackServerEvent("settings_updated", {
      topicCount: settingsToReturn.topics?.length ?? 0,
      geoCount: settingsToReturn.geographies?.length ?? 0,
      sourceCount: (settingsToReturn.traditionalSources?.length ?? 0) + (settingsToReturn.socialSources?.length ?? 0),
      identitySource: identity.source,
    });
    res.json({ ...settingsToReturn, _meta: { extractionStatus } });
  } catch (error) {
    trackServerEvent("api_error", {
      route: "/api/settings",
      statusCode: 500,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    res.status(500).json({
      message: "Failed to write settings.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/ingestion/sources", async (_req, res) => {
  if (isSupabaseEnabled()) {
    try {
      const supabase = getSupabaseClient();
      const feeds = await _feedManifest.list({ supabase });
      res.json({ feeds });
    } catch (error) {
      res.status(500).json({
        message: "Failed to read source feeds from database.",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return;
  }

  try {
    const feedsFile = path.join(DATA_DIR, "source-feeds.json");
    const content = await fs.readFile(feedsFile, "utf8");
    res.json(JSON.parse(content));
  } catch (error) {
    res.status(500).json({
      message: "Failed to read source feeds.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─── Dashboard response helpers ──────────────────────────────────────────────
// The `_selectionMeta` (Phase 2), `_watermark` (Phase 4),
// `_everSeenMetaStoryIds` (what-changed Phase 1), and `_whyItMattersTraces`
// (why-this-matters Phase 7) fields are persisted alongside the contract
// payload but must NOT leak into the response body — `_selectionMeta` /
// `_watermark` are surfaced under `_meta.selection` / `_meta.watermark`,
// and `_everSeenMetaStoryIds` / `_whyItMattersTraces` are internal-only
// (history + trace scope, not for clients).  Both dashboard routes (GET,
// POST refresh, POST bootstrap) repeat the same strip+reattach dance, so
// it lives here in one place.

function stripPersistedFields(snapshot) {
  // `_lastRunMeta` is consumed by `liftSnapshotMeta` on subsequent reads
  // and lifted into `_meta.{funnel,recall,tags,whatChanged,whyItMatters,…}`;
  // it must not leak into the immediate refresh-response body (the
  // manually-built `_meta` on that branch is the only surface clients
  // should see).  `_everSeenMetaStoryIds` is internal-only history state.
  // `_whyItMattersTraces` is the server-side per-metaStoryId trace map
  // (spec §7) used for eval replay and debug — never exposed to clients.
  // All are destructured out below; the rename aliases (`_unused*`) just
  // satisfy the lint convention for intentionally-discarded keys.
  const {
    _meta = {},
    _selectionMeta,
    _watermark,
    _everSeenMetaStoryIds: _unusedEverSeen,
    _lastRunMeta: _unusedLastRunMeta,
    _whyItMattersTraces: _unusedWhyTraces,
    ...body
  } = snapshot ?? {};
  return { body, baseMeta: _meta, selectionMeta: _selectionMeta, watermark: _watermark };
}

function attachInternalsToMeta(meta, { selectionMeta, watermark } = {}) {
  const out = { ...(meta ?? {}) };
  if (selectionMeta) out.selection = selectionMeta;
  if (watermark) out.watermark = watermark;
  return out;
}

function emptyDashboardResponse(metaExtra = {}) {
  return {
    contractVersion: DEFAULT_SETTINGS.contractVersion,
    stories: [],
    _meta: { hasSnapshot: false, ...metaExtra },
  };
}

app.get("/api/dashboard", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const snapshot = await _snapshotRepo.read(identity.userId);
    if (!snapshot) {
      trackServerEvent("api_dashboard_requested", {
        hasSnapshot: false,
        storyCount: 0,
        identitySource: identity.source,
      });
      return res.json(emptyDashboardResponse());
    }
    const { body, baseMeta, selectionMeta, watermark } = stripPersistedFields(snapshot);
    const validation = dashboardPayloadSchema.safeParse(body);
    if (!validation.success) {
      console.warn(
        `[dashboard.get] snapshot for user=${identity.userId} failed schema validation; returning empty`,
        validation.error.errors
      );
      trackServerEvent("api_dashboard_requested", {
        hasSnapshot: false,
        storyCount: 0,
        identitySource: identity.source,
        validationFailed: true,
      });
      return res.json(emptyDashboardResponse());
    }
    trackServerEvent("api_dashboard_requested", {
      hasSnapshot: true,
      storyCount: snapshot.stories?.length ?? 0,
      identitySource: identity.source,
    });
    res.json({ ...body, _meta: attachInternalsToMeta(baseMeta, { selectionMeta, watermark }) });
  } catch (error) {
    trackServerEvent("api_error", {
      route: "/api/dashboard",
      statusCode: 500,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    res.status(500).json({
      message: "Failed to read dashboard snapshot.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Phase 5: shared refresh executor used by both POST /api/dashboard/refresh
 * and the bootstrap route's "stale or missing snapshot → run refresh" path.
 *
 * Returns `{ kind, httpStatus, body }` where `kind` describes the terminal
 * branch the refresh took.  Bootstrap uses `kind` to derive its
 * `bootstrapDecision` enum without re-implementing pipeline orchestration.
 *
 *   kind ∈
 *     "in_flight"      — concurrent refresh in progress; this caller did not run anything
 *     "unchanged"      — pipeline watermark short-circuited; no new work performed
 *     "ran"            — full pipeline ran, snapshot persisted
 *     "error_fallback" — pipeline threw; served prior snapshot as soft fallback
 *     "error_500"      — pipeline threw and no prior snapshot to fall back on
 *
 * Telemetry inside this helper only emits the existing refresh-flow events
 * (`dashboard_refreshed`, `dashboard_refresh_skipped`, `api_error`).  Bootstrap
 * adds its own `dashboard_bootstrap` event on top.
 */
async function executeRefreshFlow(identity) {
  const startedAt = Date.now();
  // `lastCheckedAt` represents "when did the server initiate / complete a feed
  // check for this user".  Unlike `refreshedAt`, it advances on every refresh
  // attempt — including no-op outcomes (watermark unchanged, in_flight skip,
  // error fallback) — so the dashboard's header clock moves even when the
  // story list stays put.
  const lastCheckedAt = new Date().toISOString();

  // R2 DC-validation guard: when TEMPO_DC_VALIDATION_MODE=true, refuse to run
  // a "validation" refresh that would silently traverse mock routes or hit a
  // missing key.  Fails closed with a machine-readable diagnostic before any
  // pipeline I/O so a misconfigured validation run can't be mistaken for a
  // green real-model run.  Outside validation mode this is a no-op.
  const readinessSnapshot = getProviderReadiness();
  if (isDcValidationModeEnabled() && !readinessSnapshot.readyForRealRun) {
    try {
      assertReadyForRealRun({ readiness: readinessSnapshot });
    } catch (guardErr) {
      console.error(
        `[dashboard.refresh] DC_VALIDATION_NOT_READY user=${identity.userId} reasons=${(guardErr.reasons ?? []).join("|")} missingKeys=${readinessSnapshot.missingKeys.join(",")}`
      );
      trackServerEvent("dashboard_refresh_skipped", {
        reason: "dc_validation_not_ready",
        identitySource: identity.source,
        missingKeys: readinessSnapshot.missingKeys,
        mockOnly: readinessSnapshot.mockOnly,
      });
      return {
        kind: "validation_not_ready",
        httpStatus: 503,
        body: {
          message: "Dashboard refresh blocked: DC validation mode requires real-model providers.",
          code: "DC_VALIDATION_NOT_READY",
          reasons: guardErr.reasons ?? [],
          readiness: readinessSnapshot,
        },
      };
    }
  }

  // Phase 4: per-user in-flight guard.  See refresh-guard.mjs for scope notes.
  if (!tryAcquireRefresh(identity.userId)) {
    console.log(
      `[dashboard.refresh] user=${identity.userId} skipped: in_flight (scope=${REFRESH_GUARD_SCOPE})`
    );
    trackServerEvent("dashboard_refresh_skipped", {
      reason: "in_flight",
      identitySource: identity.source,
      refreshGuardScope: REFRESH_GUARD_SCOPE,
    });
    const inflightSnapshot = await _snapshotRepo.read(identity.userId).catch(() => null);
    if (inflightSnapshot) {
      // Best-effort: bump persisted lastCheckedAt so a full reload reflects
      // this attempt.  Races with the concurrent in-flight pipeline are
      // benign — the eventual full write sets its own (later) lastCheckedAt.
      await _snapshotRepo.writeMeta(identity.userId, { lastCheckedAt }).catch(() => {});
      const { body, baseMeta, selectionMeta } = stripPersistedFields(inflightSnapshot);
      return {
        kind: "in_flight",
        httpStatus: 200,
        body: {
          ...body,
          _meta: attachInternalsToMeta(
            { ...baseMeta, refreshSkippedReason: "in_flight", unchanged: false, lastCheckedAt },
            { selectionMeta }
          ),
        },
      };
    }
    return {
      kind: "in_flight",
      httpStatus: 200,
      body: emptyDashboardResponse({
        refreshSkippedReason: "in_flight",
        unchanged: false,
        lastCheckedAt,
      }),
    };
  }

  try {
    const [rawSettings, manifestFeeds, priorSnapshot, narrative] = await Promise.all([
      readSettings(identity.userId),
      loadManifestForSelection(),
      _snapshotRepo.read(identity.userId).catch(() => null),
      // Onboarding narrative is the richest source of beat context for the
      // embedding profile.  Read failures are non-fatal — we just lose some
      // signal and the recall stage falls through to settings-only profile.
      _narrativeRepo.read(identity.userId).catch(() => null),
    ]);

    // D-064a: apply the idempotent keyword-dedupe backfill so pipeline
    // scoring uses clean keywords even if the user hasn't hit GET /api/settings
    // since D-064 shipped. Write fires at most once per pre-D-064 user.
    const settings = await backfillKeywordDedupe(rawSettings, identity.userId);

    // Sub-slice 2.3: cache-first ingestion source resolution.
    //
    // Resolve the user's selected feed IDs against the manifest, then look up
    // any non-expired rows in `ingestion_recent_items` for those feeds.  A
    // cache hit skips the live RSS fetch entirely; a cache miss falls back to
    // `readFeedItems(DATA_DIR)` and re-populates the cache on the way through
    // (the 2.2 write path).
    //
    // The pipeline still does its own source-selection downstream — the
    // server-level resolution here is only used to scope the cache lookup.
    const selectedNames = [
      ...(settings.traditionalSources ?? []),
      ...(settings.socialSources ?? []),
    ];
    const cacheFeedIds = (manifestFeeds && selectedNames.length > 0)
      ? resolveSelectedSources({
          selectedSources: selectedNames,
          manifestFeeds,
          fallbackFeedIds: parseFallbackFeedIdsEnv(process.env.TEMPO_FALLBACK_SOURCE_IDS),
          fallbackEnabled: parseFallbackEnabledEnv(process.env.TEMPO_FALLBACK_ENABLED),
        }).matchedFeeds.map((f) => f.id).filter((id) => typeof id === "string" && id.length > 0)
      : [];

    // Slice 7: wall-clock around the ingestion block (cache read + optional
    // live fetch), excluding the pipeline call. Folded into _meta.timings below.
    const ingestionStartedAt = Date.now();
    let rawItems;
    let ingestionSource = "live";
    if (_recentItemsCache.enabled() && cacheFeedIds.length > 0) {
      try {
        const { rows, error } = await _recentItemsCache.read({
          supabase: _recentItemsCache.client(),
          feedIds: cacheFeedIds,
        });
        if (error) {
          console.warn(
            `[ingestion.cache] read failed (falling back to live): ${error.message ?? error}`
          );
        } else if (Array.isArray(rows) && rows.length > 0) {
          rawItems = cacheRowsToRawItems(rows, manifestFeeds);
          ingestionSource = "cache";
        }
      } catch (err) {
        console.warn(
          `[ingestion.cache] read threw (falling back to live): ${err instanceof Error ? err.message : err}`
        );
      }
    }
    if (rawItems === undefined) {
      // Slice 2: scope the live fetch to the user's matched feeds so a cache
      // miss fetches only those feeds instead of the entire manifest.  When
      // there are no matched feeds (no user selection yet / unresolved), omit
      // `feedIds` entirely so readFeedItems keeps its full-manifest behavior.
      // cacheFeedIds is already filtered to non-empty strings above.
      if (cacheFeedIds.length > 0) {
        rawItems = await _feedReader.read(DATA_DIR, { feedIds: cacheFeedIds });
        ingestionSource = "live_scoped";
      } else {
        rawItems = await _feedReader.read(DATA_DIR);
      }
    }
    const ingestionMs = Math.max(0, Date.now() - ingestionStartedAt);
    console.log(
      `[refresh] ingestionSource=${ingestionSource} items=${Array.isArray(rawItems) ? rawItems.length : 0} matchedFeeds=${cacheFeedIds.length} ingestionMs=${ingestionMs}`
    );

    // Sub-slice 2.2 write: opportunistic upsert into the Tier-A cache so
    // concurrent refreshes can share this fetch.  Only fires when we did a
    // live fetch in this request — both the full-manifest ("live") and the
    // Slice 2 scoped ("live_scoped") branches re-warm the cache; cache hits
    // don't need to re-write the rows we just read.  Fire-and-forget: cache
    // failures must never block the user's refresh.
    if (
      (ingestionSource === "live" || ingestionSource === "live_scoped") &&
      _recentItemsCache.enabled() &&
      Array.isArray(rawItems) &&
      rawItems.length > 0
    ) {
      void Promise.resolve()
        .then(() => _recentItemsCache.write({ supabase: _recentItemsCache.client(), items: rawItems }))
        .then((res) => {
          if (res?.error) {
            console.warn(
              `[ingestion.cache] write failed (non-fatal): ${res.error.message ?? res.error}`
            );
          }
        })
        .catch((err) => {
          console.warn(
            `[ingestion.cache] write threw (non-fatal): ${err instanceof Error ? err.message : err}`
          );
        });
    }

    const priorWatermark = priorSnapshot?._watermark ?? null;
    // Story count drives the trap-guard inside the pipeline: when the prior
    // snapshot is empty AND the current run has candidates, the pipeline
    // suppresses the watermark short-circuit and lets clustering re-run.
    const priorStoryCount = Array.isArray(priorSnapshot?.stories)
      ? priorSnapshot.stories.length
      : null;
    // What-changed wiring: read priors from the persisted snapshot once and
    // feed both to the pipeline. `extractEverSeenFromSnapshot` gives the
    // history set that drives the first-seen branch; `priorStoriesById`
    // gives the per-`metaStoryId` lookup the structural gate diffs against.
    // The pipeline returns run-level diagnostics on `log.whatChanged`,
    // persisted below as `_lastRunMeta.whatChanged` and lifted into
    // `_meta.whatChanged` on subsequent reads.
    //
    // Pre-lock vs post-lock asymmetry (spec alignment #8): the engine runs
    // inside the pipeline BEFORE title locks are applied to the current
    // story (locks are applied below in this route handler).  But
    // `priorStoriesById` is built from the PERSISTED prior snapshot, which
    // was lock-applied at write time.  MVP accepts that asymmetry — worst
    // case is an occasional weak `subtitle_change` / `title_change` signal
    // when the lock masks underlying drift; both are weak-only and Haiku
    // can reject downstream.  Moving the engine post-lock or storing a
    // pre-lock snapshot side-by-side is a fast-follow if telemetry shows
    // material noise.
    const priorEverSeenMetaStoryIds = extractEverSeenFromSnapshot(priorSnapshot);
    const priorStoriesById = new Map(
      (Array.isArray(priorSnapshot?.stories) ? priorSnapshot.stories : [])
        .filter((s) => s && typeof s.metaStoryId === "string" && s.metaStoryId.length > 0)
        .map((s) => [s.metaStoryId, s])
    );

    // Decorate the in-memory settings with the narrative so buildProfileText
    // picks it up.  We never persist this back — it's transient per refresh.
    const settingsWithNarrative =
      typeof narrative === "string" && narrative.trim().length > 0
        ? { ...settings, onboardingNarrative: narrative.trim() }
        : settings;

    const clusterModel = getAiCapabilityMap().clustering;
    // M3 / L1a: surface model identity on refresh _meta so DC demo debugging
    // and incident replay don't depend on log scrapes.  Both ids are env-derived
    // at call time, mirroring the SKU the run will actually use.
    const embeddingModel = resolveRecallConfig().embeddingModel;
    const { payload, log } = await _refreshPipeline.run({
      userId: identity.userId,
      settings: settingsWithNarrative,
      rawItems,
      clusterModel,
      contractVersion: DEFAULT_SETTINGS.contractVersion,
      manifestFeeds,
      fallbackFeedIds: parseFallbackFeedIdsEnv(process.env.TEMPO_FALLBACK_SOURCE_IDS),
      fallbackEnabled: parseFallbackEnabledEnv(process.env.TEMPO_FALLBACK_ENABLED),
      priorWatermark,
      priorStoryCount,
      everSeenMetaStoryIds: priorEverSeenMetaStoryIds,
      priorStoriesById,
    });

    // Slice 7: fold the server-measured ingestionMs into the pipeline's
    // per-stage timings so _meta.timings carries one unified object
    // (ingestion + pipeline stages). Guarded — the watermark short-circuit
    // branch returns a log without `timings`, which is fine.
    if (log && typeof log === "object") {
      log.timings = { ingestionMs, ...(log.timings ?? {}) };
    }

    // ─── Phase 4 short-circuit: watermark unchanged ─────────────────────────
    if (log?.unchanged === true && payload === null) {
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[dashboard.refresh] user=${identity.userId} skipped: unchanged_watermark=${log.watermark} candidates=${log.candidateCount} feeds=${log.selectedFeedCount} elapsed=${elapsedMs}ms`
      );
      trackServerEvent("dashboard_refresh_skipped", {
        reason: "unchanged_watermark",
        watermark: log.watermark,
        candidateCount: log.candidateCount,
        selectedFeedCount: log.selectedFeedCount,
        elapsedMs,
        identitySource: identity.source,
      });
      // Surface recall + funnel + beatFit + selection on the watermark-skip
      // branch too: the pipeline computed them before deciding to
      // short-circuit, and operators reading `_meta.*` to debug a stable
      // empty snapshot need the same diagnostic surface as the full-run
      // branch.  Each key is optional — when the log doesn't carry it (older
      // test mocks, partial returns) we omit it rather than emit an
      // `undefined` placeholder, keeping the response shape backward-compatible.
      //
      // The prior-snapshot branch below ALSO runs `attachInternalsToMeta`,
      // which overrides `selection` with the persisted `_selectionMeta` (the
      // authoritative source when a snapshot exists).  Adding selection here
      // covers the no-prior-snapshot edge case where `_selectionMeta` is not
      // available, so diagnostics stay consistent across both branches.
      const skipMeta = {
        unchanged: true,
        refreshSkippedReason: "unchanged_watermark",
        watermark: log.watermark,
        candidateCount: log.candidateCount,
        selectedFeedCount: log.selectedFeedCount,
        lastCheckedAt,
        // M3: model identity surfaces on the skip branch too, so an operator
        // diagnosing a stable empty snapshot can confirm the SKU without
        // forcing a full refresh.
        clusterModel,
        embeddingModel,
      };
      if (log.recall) skipMeta.recall = log.recall;
      if (log.funnel) skipMeta.funnel = log.funnel;
      if (log.beatFit) skipMeta.beatFit = log.beatFit;
      if (log.timings) skipMeta.timings = log.timings;
      // Phase 2 lightweight decision trace.  Optional — older pipeline mocks
      // and partial returns may omit it; consumers ignore unknown _meta keys.
      if (log.decisionTrace) skipMeta.decisionTrace = log.decisionTrace;
      if (log.selection) skipMeta.selection = log.selection;
      if (priorSnapshot) {
        // Persist the bumped lastCheckedAt onto the existing snapshot so a
        // full page reload reflects this check.  refreshedAt stays pinned to
        // the last real snapshot write — only the check timestamp moves.
        await _snapshotRepo.writeMeta(identity.userId, { lastCheckedAt }).catch(() => {});
        const { body, baseMeta, selectionMeta } = stripPersistedFields(priorSnapshot);
        return {
          kind: "unchanged",
          httpStatus: 200,
          body: {
            ...body,
            _meta: attachInternalsToMeta(
              { ...baseMeta, ...skipMeta },
              { selectionMeta: selectionMeta ?? log.selection }
            ),
          },
        };
      }
      return {
        kind: "unchanged",
        httpStatus: 200,
        body: emptyDashboardResponse(skipMeta),
      };
    }

    // Apply title-only locks (meta-story fields PR — Prompt 1).
    // Product rule: on first publish, freeze the meta-story's `title` per
    // `metaStoryId` so it never silently renames across refreshes.  The
    // `subtitle` field intentionally re-renders every run — it carries
    // clustering context (one-sentence placement) which must reflect the
    // current evidence.  Legacy lock rows that stored a `subtitle` value are
    // ignored on read; we never write `subtitle` on new locks.
    const metaStoryIds = payload.stories.map((s) => s.metaStoryId).filter(Boolean);
    const lockedTitles = await _snapshotRepo.getLocks(identity.userId, metaStoryIds);

    const lockedStories = payload.stories.map((story) => {
      const lock = story.metaStoryId ? lockedTitles.get(story.metaStoryId) : undefined;
      if (lock) {
        return { ...story, title: lock.title };
      }
      return story;
    });

    const newLocks = lockedStories
      .filter((s) => s.metaStoryId && !lockedTitles.has(s.metaStoryId))
      .map((s) => ({ metaStoryId: s.metaStoryId, title: s.title }));
    await _snapshotRepo.insertLocks(identity.userId, newLocks);

    const finalPayload = { ...payload, stories: lockedStories };
    finalPayload._selectionMeta = log.selection;
    finalPayload._watermark = log.watermark;
    // Persist lastCheckedAt alongside the snapshot so subsequent reads (GET
    // /api/dashboard, bootstrap served_fresh_snapshot) surface the same value
    // the refresh response carries.  On a full run, this equals refreshedAt.
    finalPayload._lastCheckedAt = lastCheckedAt;
    // What-changed: union prior ever-seen with the current run's shipped
    // metaStoryIds, preserving oldest-first insertion order. Only advanced
    // when a fresh snapshot is actually written (watermark-skip /
    // in-flight / error-fallback all skip this branch and inherit the
    // prior snapshot's array verbatim).
    finalPayload._everSeenMetaStoryIds = mergeEverSeenMetaStoryIds(
      priorEverSeenMetaStoryIds,
      lockedStories.map((s) => s.metaStoryId)
    );
    // M3b / P1: persist last-run diagnostics so GET /api/dashboard can explain
    // funnel/recall/beatFit/model identity without re-running refresh.  Keys
    // are individually optional — older pipeline returns that lack one of
    // them won't emit an `undefined` placeholder on readback.
    const lastRunMeta = { clusterModel, embeddingModel };
    // Clustering fail-closed diagnostics (Slice 1).  Persisted so GET
    // /api/dashboard can explain "empty dashboard because clustering failed"
    // (timeout vs error, how many attempts, per-attempt latency) without
    // re-running refresh.  Each is individually optional for back-compat with
    // pipeline returns predating these fields.
    if (log.usedFallbackClustering !== undefined) lastRunMeta.usedFallbackClustering = log.usedFallbackClustering;
    if (log.clusteringFailureReason !== undefined) lastRunMeta.clusteringFailureReason = log.clusteringFailureReason;
    if (log.clusteringAttempts !== undefined) lastRunMeta.clusteringAttempts = log.clusteringAttempts;
    if (log.clusteringLatencyMs !== undefined) lastRunMeta.clusteringLatencyMs = log.clusteringLatencyMs;
    if (log.funnel !== undefined) lastRunMeta.funnel = log.funnel;
    if (log.recall !== undefined) lastRunMeta.recall = log.recall;
    if (log.translation !== undefined) lastRunMeta.translation = log.translation;
    if (log.beatFit !== undefined) lastRunMeta.beatFit = log.beatFit;
    if (log.decisionTrace !== undefined) lastRunMeta.decisionTrace = log.decisionTrace;
    // Phase 4: per-axis semantic tag-mapping aggregate (topics/keywords) and
    // the locked `geographies.semanticApplied: false` stamp.  Persisted so
    // `GET /api/dashboard` can surface "was semantic widening on for this
    // run, and how often did it fire?" without re-running the pipeline.
    if (log.tags !== undefined) lastRunMeta.tags = log.tags;
    // What-changed (Phase 4): run-level diagnostics for the delta engine.
    // Surfaced under `_meta.whatChanged` on subsequent dashboard reads so
    // operators can audit first-seen / unchanged / changed counts and any
    // LLM failures without replaying the pipeline.
    if (log.whatChanged !== undefined) lastRunMeta.whatChanged = log.whatChanged;
    // Why-this-matters (Phase 5): run-level diagnostics for the
    // implications writer.  Same persistence posture as `whatChanged`
    // above — surfaced under `_meta.whyItMatters` on subsequent reads so
    // operators can audit pass / fallback / lowConfidence counts and
    // writer-stage latency without replaying the pipeline.
    if (log.whyItMatters !== undefined) lastRunMeta.whyItMatters = log.whyItMatters;
    // Slice 7: per-stage wall-clock timings (ingestion + pipeline). Optional —
    // surfaced under `_meta.timings` on subsequent reads via liftSnapshotMeta.
    if (log.timings !== undefined) lastRunMeta.timings = log.timings;
    finalPayload._lastRunMeta = lastRunMeta;

    await _snapshotRepo.write(identity.userId, finalPayload);

    const elapsedMs = Date.now() - startedAt;
    const sel = log.selection ?? {};
    console.log(
      `[dashboard.refresh] user=${identity.userId} stories=${finalPayload.stories.length} pool=${log.poolCount} relevant=${log.relevantCount} elapsed=${elapsedMs}ms fallback=${log.usedFallbackClustering} groundingFail=${log.groundingFailures} dropped=${log.droppedUngroundedStoryCount ?? 0} selectionMode=${sel.sourceSelectionMode} sourceFallback=${sel.sourceFallbackUsed} watermark=${log.watermark}`
    );

    trackServerEvent("dashboard_refreshed", {
      storyCount: finalPayload.stories.length,
      poolCount: log.poolCount,
      relevantCount: log.relevantCount,
      usedFallbackClustering: log.usedFallbackClustering,
      groundingFailures: log.groundingFailures,
      elapsedMs,
      clusterModel,
      identitySource: identity.source,
      sourceSelectionMode: sel.sourceSelectionMode,
      sourceFallbackUsed: sel.sourceFallbackUsed,
      sourceFallbackReason: sel.sourceFallbackReason,
      matchedSourceCount: sel.matchedSourceCount,
      selectedSourceCount: sel.selectedSourceCount,
      unmatchedSelectedSourceCount: (sel.unmatchedSelectedSources ?? []).length,
      unavailableConnectorCount: sel.unavailableConnectorCount,
      relevantItemCount: sel.relevantItemCount,
      droppedUngroundedStoryCount: log.droppedUngroundedStoryCount ?? 0,
      groundingDropReasons: log.groundingDropReasons ?? {},
      watermark: log.watermark,
      candidateCount: log.candidateCount,
      selectedFeedCount: log.selectedFeedCount,
      unchanged: false,
    });

    const { body: responsePayload } = stripPersistedFields(finalPayload);
    return {
      kind: "ran",
      httpStatus: 200,
      body: {
        ...responsePayload,
        _meta: {
          refreshedAt: lastCheckedAt,
          lastCheckedAt,
          hasSnapshot: true,
          selection: log.selection,
          timings: log.timings,
          unchanged: false,
          watermark: log.watermark,
          candidateCount: log.candidateCount,
          selectedFeedCount: log.selectedFeedCount,
          // Phase 1 relevance Stage 2 — internal explainability surface.
          // Backwards-compatible: clients ignore unknown _meta keys.
          beatFit: log.beatFit,
          recall: log.recall,
          // Slice 14: translation-first normalization diagnostics (coverage,
          // translated/failed/timeout counts, degraded rate, latency p50/p95,
          // per-story coverage). Backwards-compatible; OFF by default in prod.
          translation: log.translation,
          funnel: log.funnel,
          // Clustering fail-closed diagnostics (Slice 1) — also surfaced on
          // the immediate refresh response so the first read after a failed
          // clustering run can explain the empty dashboard without a reload.
          usedFallbackClustering: log.usedFallbackClustering,
          clusteringFailureReason: log.clusteringFailureReason,
          clusteringAttempts: log.clusteringAttempts,
          clusteringLatencyMs: log.clusteringLatencyMs,
          // Phase 2 lightweight decision trace.  Optional, compact,
          // backend-only.  Carries stage counts, beat-fit details, and a
          // capped sample of exclusions — no raw source bodies.
          decisionTrace: log.decisionTrace,
          // M3 / L1a: SKU identity on the refresh response.  Persistence to
          // snapshot storage is deferred to M3b.
          clusterModel,
          embeddingModel,
          // R2: readiness snapshot at run time — additive, lets operators
          // confirm a passing DC validation run actually ran on real models.
          readiness: readinessSnapshot,
        },
      },
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[dashboard.refresh] FAILED user=${identity.userId} elapsed=${elapsedMs}ms: ${message}`);

    trackServerEvent("api_error", {
      route: "/api/dashboard/refresh",
      statusCode: 500,
      message,
      elapsedMs,
    });

    try {
      const lastSnapshot = await _snapshotRepo.read(identity.userId);
      if (lastSnapshot) {
        // error_fallback represents "we tried" — the pipeline ran and threw,
        // so a check did occur even if no new snapshot was produced.  Bump
        // persisted lastCheckedAt (best-effort, non-fatal) so a full reload
        // after this attempt doesn't regress the "Last refresh" clock back
        // to the fallback snapshot's older timestamp.  refreshedAt remains
        // pinned to the fallback snapshot's last successful run.
        await _snapshotRepo.writeMeta(identity.userId, { lastCheckedAt }).catch(() => {});
        const { body: lastBody, baseMeta } = stripPersistedFields(lastSnapshot);
        return {
          kind: "error_fallback",
          httpStatus: 200,
          body: { ...lastBody, _meta: { ...baseMeta, fallback: true, lastCheckedAt } },
        };
      }
    } catch { /* ignore */ }

    return {
      kind: "error_500",
      httpStatus: 500,
      body: { message: "Dashboard refresh failed.", detail: message },
    };
  } finally {
    releaseRefresh(identity.userId);
  }
}

/**
 * Mutable execution hook for the shared refresh flow.  Both
 * `POST /api/dashboard/refresh` and the bootstrap route's "stale or missing
 * snapshot" path go through this hook so tests can stub flow outcomes
 * (in_flight, ran, unchanged, error_*) deterministically without timing/
 * concurrency races.  Production code reads `_refreshExecutor.execute` —
 * tests replace it inside a `try/finally` and restore the prior reference.
 */
export const _refreshExecutor = { execute: executeRefreshFlow };

/**
 * Sub-slice 2.4: server-side due-user orchestrator hook.
 *
 * Routes through the same `_refreshExecutor.execute` path the interactive
 * `POST /api/dashboard/refresh` uses, so the in-flight guard, watermark
 * short-circuit, snapshot persistence, and `_lastCheckedAt` anchor update
 * all stay consistent regardless of trigger source.
 *
 * Mutable so 2.4 tests can stub `listAnchors` and `executeRefreshFlowFn`
 * deterministically (no live Supabase, no pipeline I/O), and so 2.5 can
 * later swap the supabase client / interval source via the same hook.
 *
 * No public endpoint surfaces this in 2.4 — `runDueRefreshes` is invoked
 * from the Sub-slice 2.5 entrypoint (scheduled GitHub Action wiring).
 */
export const _dueUserOrchestrator = {
  listAnchors: () => orchestratorListSnapshotAnchors({ supabase: getSupabaseClient() }),
  runDueRefreshes: (opts = {}) =>
    orchestratorRunDueRefreshes({
      listAnchorsFn: _dueUserOrchestrator.listAnchors,
      executeRefreshFlowFn: _refreshExecutor.execute,
      ...opts,
    }),
};

app.post("/api/dashboard/refresh", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  const { httpStatus, body } = await _refreshExecutor.execute(identity);
  res.status(httpStatus).json(body);
});

// ─── Phase 5: bootstrap route ────────────────────────────────────────────────
//
// Backend-owned freshness policy: dashboard's first paint after Landing or
// post-Onboarding entry calls this endpoint instead of GET /api/dashboard.
// Behavior:
//   - snapshot exists AND age <= 60 min  →  served_fresh_snapshot (no refresh)
//   - snapshot missing OR age > 60 min   →  ran_refresh (delegate to refresh flow)
//   - refresh attempt produced no snapshot at all → no_snapshot
//
// The `bootstrapDecision` field is exclusive to this route — GET /api/dashboard
// and POST /api/dashboard/refresh do not surface it.
const BOOTSTRAP_FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000;

function snapshotAgeMs(snapshot) {
  const ts = snapshot?._meta?.refreshedAt;
  if (!ts) return Infinity;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? Date.now() - parsed : Infinity;
}

app.post("/api/dashboard/bootstrap", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;

  // 1. Try to serve fresh snapshot without running anything expensive.
  const snapshot = await _snapshotRepo.read(identity.userId).catch(() => null);
  const ageMs = snapshotAgeMs(snapshot);
  if (snapshot && ageMs <= BOOTSTRAP_FRESHNESS_THRESHOLD_MS) {
    const { body, baseMeta, selectionMeta, watermark } = stripPersistedFields(snapshot);
    // Mirror GET /api/dashboard's contract validation: a malformed persisted
    // snapshot must NOT leak through.  On validation failure we fall back to
    // the same empty-payload shape GET uses, but tag the bootstrap decision as
    // `no_snapshot` since the persisted blob was unusable.
    const validation = dashboardPayloadSchema.safeParse(body);
    if (!validation.success) {
      console.warn(
        `[dashboard.bootstrap] user=${identity.userId} snapshot failed schema validation; serving empty`,
        validation.error.errors
      );
      trackServerEvent("dashboard_bootstrap", {
        decision: "no_snapshot",
        snapshotAgeMs: ageMs,
        identitySource: identity.source,
        validationFailed: true,
      });
      return res.json(emptyDashboardResponse({ bootstrapDecision: "no_snapshot" }));
    }
    const responseMeta = attachInternalsToMeta(baseMeta, { selectionMeta, watermark });
    responseMeta.bootstrapDecision = "served_fresh_snapshot";
    console.log(
      `[dashboard.bootstrap] user=${identity.userId} decision=served_fresh_snapshot ageMs=${ageMs}`
    );
    trackServerEvent("dashboard_bootstrap", {
      decision: "served_fresh_snapshot",
      snapshotAgeMs: ageMs,
      identitySource: identity.source,
    });
    return res.json({ ...body, _meta: responseMeta });
  }

  // 2. Stale or missing — run the refresh flow.  This delegates to the same
  //    in-flight guard, watermark short-circuit, lock writes, and snapshot
  //    persistence used by POST /api/dashboard/refresh.
  const { kind, httpStatus, body } = await _refreshExecutor.execute(identity);

  // Map refresh kind → bootstrap decision.
  //   "ran"             — fresh pipeline run produced a new snapshot
  //   "unchanged"       — watermark short-circuit; we attempted refresh but
  //                       served the prior snapshot — still semantically a
  //                       refresh attempt, classify as ran_refresh
  //   "in_flight"       — another refresh is currently running.  Decision is
  //                       driven by the RETURNED body's `_meta.hasSnapshot`,
  //                       not the bootstrap-route's earlier snapshot read.
  //                       The earlier read can be null while executeRefreshFlow
  //                       (which performs its own re-read) successfully pulls
  //                       a snapshot — in that case we should still report
  //                       ran_refresh since data is being served.
  //   "error_fallback"  — pipeline threw but a prior snapshot was served;
  //                       still classify as ran_refresh from the user's POV
  //   "error_500"       — pipeline threw with no fallback snapshot available
  const hasSnapshotFlag = body?._meta?.hasSnapshot === true;
  let decision;
  if (kind === "error_500" || kind === "validation_not_ready") {
    // R2: validation_not_ready short-circuits with 503 + diagnostic body; do
    // not classify it as a successful refresh attempt for bootstrap purposes.
    decision = "no_snapshot";
  } else if (kind === "in_flight") {
    decision = hasSnapshotFlag ? "ran_refresh" : "no_snapshot";
  } else {
    decision = "ran_refresh";
  }

  // Edge case: ran/unchanged/error_fallback paths can land here without a
  // snapshot (e.g. first-time pipeline produced empty payload AND no prior
  // snapshot).  Demote to no_snapshot so clients aren't told a refresh
  // happened when there's nothing to show.
  if (!snapshot && !hasSnapshotFlag && decision === "ran_refresh") {
    decision = "no_snapshot";
  }

  console.log(
    `[dashboard.bootstrap] user=${identity.userId} decision=${decision} kind=${kind} hadPriorSnapshot=${!!snapshot}`
  );
  trackServerEvent("dashboard_bootstrap", {
    decision,
    refreshKind: kind,
    hadPriorSnapshot: !!snapshot,
    snapshotAgeMs: ageMs,
    identitySource: identity.source,
  });

  if (httpStatus !== 200) {
    return res.status(httpStatus).json(body);
  }

  const responseMeta = { ...(body._meta ?? {}), bootstrapDecision: decision };
  res.json({ ...body, _meta: responseMeta });
});

app.get("/api/ai/models", (_req, res) => {
  // R2: surface readiness diagnostics so operators can verify DC validation
  // mode pre-conditions (real providers + keys present) without running
  // refresh.  Additive: existing `capabilityMap` / `mockOnly` fields are
  // unchanged for backwards compatibility.
  const readiness = getProviderReadiness();
  res.json({
    capabilityMap: getAiCapabilityMap(),
    mockOnly: readiness.mockOnly,
    dcValidationMode: isDcValidationModeEnabled(),
    readiness,
  });
});

app.get("/api/ai/metrics", (_req, res) => {
  res.json({
    metrics: getAiMetrics(),
  });
});

// Phase 7: internal-only debug surface for `_meta.tags` (semantic tag rollout
// diagnostics).  Two compounding gates: the env opt-in MUST be true AND
// NODE_ENV must NOT be "production" — neither alone is sufficient.  This
// keeps the surface unavailable from prod even if the env var leaks, and
// unavailable from staging/dev unless an operator deliberately opts in.
// The endpoint is also identity-bound (same `requireIdentity` as
// `/api/dashboard`) so the diagnostics never leak to anonymous callers.
//
// Returns ONLY the `_meta.tags` aggregate from the user's last persisted
// snapshot — never any story content, source bodies, or selection meta.
// Operators reading this can answer "is semantic uplift firing? how often
// is it borderline? is the scorer healthy?" without log grep.
function isDebugTagsEnabled(env = process.env) {
  if (env.NODE_ENV === "production") return false;
  const raw = String(env.TEMPO_DEBUG_TAGS_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

app.get("/api/_debug/dashboard-tags", async (req, res) => {
  if (!isDebugTagsEnabled()) {
    return res.status(404).json({ message: "Not found" });
  }
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const snapshot = await _snapshotRepo.read(identity.userId);
    if (!snapshot) {
      return res.json({
        hasSnapshot: false,
        tags: null,
        message: "No persisted snapshot for this identity yet.",
      });
    }
    const tags = snapshot._meta?.tags ?? null;
    return res.json({
      hasSnapshot: true,
      schemaVersion: tags?.schemaVersion ?? null,
      killSwitchActive: tags?.killSwitchActive ?? null,
      tags,
      refreshedAt: snapshot._meta?.refreshedAt ?? null,
      lastCheckedAt: snapshot._meta?.lastCheckedAt ?? null,
    });
  } catch (error) {
    trackServerEvent("api_error", {
      route: "/api/_debug/dashboard-tags",
      statusCode: 500,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return res.status(500).json({ message: "Internal error" });
  }
});

// ─── Prototype routing: resolve destination by email ─────────────────────────
// Checks Supabase Auth + user settings to route to /dashboard or /onboarding.
// No session is created; this is a pre-auth identity hint for the prototype.

/** Returns true if any onboarding category has at least one entry. */
function hasOnboardingEntries(settings) {
  if (!settings) return false;
  return (
    (settings.topics?.length ?? 0) > 0 ||
    (settings.keywords?.length ?? 0) > 0 ||
    (settings.geographies?.length ?? 0) > 0 ||
    (settings.socialSources?.length ?? 0) > 0 ||
    (settings.traditionalSources?.length ?? 0) > 0
  );
}

/**
 * Mutable hook. Tests replace findUserByEmail / readSettingsForUser to avoid
 * live Supabase or filesystem calls. Do not use outside tests.
 */
export const _resolveDestination = {
  findUserByEmail: async (email) => {
    const adminClient = createClient(
      /** @type {string} */ (process.env.SUPABASE_URL),
      /** @type {string} */ (process.env.SUPABASE_SERVICE_ROLE_KEY),
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    let page = 1;
    for (;;) {
      const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      const match = data.users.find((u) => u.email === email);
      if (match) return { id: match.id, email: match.email };
      if (data.users.length < 1000) return null;
      page++;
    }
  },
  readSettingsForUser: readSettings,
};

app.post("/api/auth/resolve-destination", async (req, res) => {
  const { email } = req.body ?? {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ message: "email is required and must contain @." });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({
      message: "resolve-destination requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
    return;
  }
  try {
    const user = await _resolveDestination.findUserByEmail(email);
    if (!user) {
      return res.status(403).json({
        allowed: false,
        message: "This email is not enabled for the prototype yet. Contact the team to be added.",
      });
    }
    const settings = await _resolveDestination.readSettingsForUser(user.id).catch(() => null);
    const destination = hasOnboardingEntries(settings) ? "/dashboard" : "/onboarding";
    return res.json({ destination, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(
      `[auth.resolve-destination] ${err instanceof Error ? err.message : String(err)}`
    );
    res.status(502).json({ message: "Could not resolve destination." });
  }
});

// ─── Voice transcription ──────────────────────────────────────────────────────
// Accepts raw audio body; uses OpenAI Whisper when TEMPO_OPENAI_API_KEY is set.
// Without a key in development: returns a deterministic mock transcript.
// Without a key in production: returns 503 — no silent mock outside dev.
app.post("/api/transcribe", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
  const audioBuffer = req.body;
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    res.status(400).json({ message: "Audio body is required." });
    return;
  }

  const apiKey = process.env.TEMPO_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV !== "production") {
      res.json({
        transcript:
          "I lead comms for a nonprofit working on migration between the US and Colombia. I read NYT and El Tiempo, and I follow the State Department on X. Mostly I brief US boards on what's happening in Colombia.",
      });
      return;
    }
    res.status(503).json({ message: "Transcription unavailable: API key not configured." });
    return;
  }

  const rawType = (req.headers["content-type"] || "audio/webm").split(";")[0].trim();
  const extMap = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav" };
  const ext = extMap[rawType] ?? "webm";

  try {
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: rawType }), `audio.${ext}`);
    formData.append("model", "whisper-1");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`[transcribe] Whisper error ${response.status}: ${errText}`);
      res.status(502).json({ message: "Transcription service error." });
      return;
    }
    const data = await response.json();
    res.json({ transcript: data.text ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[transcribe] ${message}`);
    res.status(500).json({ message: "Transcription failed." });
  }
});

export { app };

if (process.argv[1] === __filename) {
  app.listen(PORT, () => {
    console.log(`@tempo/api listening on http://localhost:${PORT}`);
  });
}
