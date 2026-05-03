import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { settingsPayloadSchema } from "./contracts/settings-schema.mjs";
import { getAiCapabilityMap, getAiMetrics, summarizeCluster, assertAiConfig } from "./ai/model-router.mjs";
import { extractOnboarding } from "./ai/onboarding-extractor.mjs";
import { readSettings, writeSettings, hasSettings, DEFAULT_SETTINGS } from "./db/settings-repo.mjs";
import { isSupabaseEnabled, getSupabaseClient } from "./db/client.mjs";
import { readFeedItems } from "./ingestion/feed-reader.mjs";
import { normalizeSourceItems } from "./ingestion/source-normalizer.mjs";
import { trackServerEvent } from "./telemetry.mjs";
import { recordSourceRegistryEventsFromSettings } from "./db/source-registry-sync.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.TEMPO_DATA_DIR ?? path.join(ROOT, "data");
const PORT = Number(process.env.TEMPO_API_PORT || 8787);

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
function rankStories(stories) {
  return [...stories].sort((a, b) => {
    const scoreA = a.sources.reduce((sum, s) => sum + s.weight, 0) - Math.min(...a.sources.map((s) => s.minutesAgo));
    const scoreB = b.sources.reduce((sum, s) => sum + s.weight, 0) - Math.min(...b.sources.map((s) => s.minutesAgo));
    return scoreB - scoreA;
  });
}

async function buildDashboardPayload(items, settings, limit = 10) {
  const allowedTopics = new Set(settings.topics ?? []);
  const allowedGeos = new Set(settings.geographies ?? []);
  const allowedSources = new Set([...(settings.traditionalSources ?? []), ...(settings.socialSources ?? [])]);

  const filtered = items.filter((item) => {
    const topicAllowed = allowedTopics.size === 0 || allowedTopics.has(item.topic);
    const geoAllowed = allowedGeos.size === 0 || item.geographies.some((g) => allowedGeos.has(g));
    const sourceAllowed = allowedSources.size === 0 || allowedSources.has(item.outlet);
    return topicAllowed && geoAllowed && sourceAllowed;
  });

  const byCluster = new Map();
  for (const item of filtered) {
    const existing = byCluster.get(item.clusterId);
    if (!existing) {
      byCluster.set(item.clusterId, {
        id: item.clusterId,
        title: item.title,
        geographies: item.geographies,
        topic: item.topic,
        takeaway: item.takeaway,
        summary: item.summary,
        whyItMatters: item.whyItMatters,
        whatChanged: item.whatChanged,
        priority: item.priority,
        outletCount: 0,
        sources: [],
      });
    }
    const cluster = byCluster.get(item.clusterId);
    cluster.sources.push({
      id: item.sourceId,
      outlet: item.outlet,
      byline: item.byline,
      kind: item.kind,
      weight: item.weight,
      url: item.url,
      minutesAgo: item.minutesAgo,
      headline: item.headline,
      body: item.body,
    });
  }

  const stories = Array.from(byCluster.values()).map((story) => ({
    ...story,
    outletCount: story.sources.length,
  }));

  const ranked = rankStories(stories).slice(0, limit);
  const enriched = await Promise.all(
    ranked.map(async (story) => {
      const ai = await summarizeCluster(story);
      return {
        ...story,
        summary: ai.summary,
        aiSummaryMeta: ai.meta,
      };
    })
  );

  return {
    contractVersion: DEFAULT_SETTINGS.contractVersion,
    stories: enriched,
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "@tempo/api" });
});

app.get("/api/settings", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const payload = await readSettings(identity.userId);
    res.json(payload);
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
  const result = settingsPayloadSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      message: "Invalid settings payload.",
      errors: result.error.errors,
    });
    return;
  }
  try {
    // Read previous before writing so the sync can diff new vs existing sources.
    // hasSettings avoids auto-creating a default file for first-time users.
    // Any read failure falls back to null → first-save semantics (log all sources).
    let previousPayload = null;
    try {
      if (await hasSettings(identity.userId)) {
        previousPayload = await readSettings(identity.userId);
      }
    } catch { /* treat unreadable previous as first-save */ }
    await writeSettings(result.data, identity.userId);
    await _sourceRegistrySync.record({ userId: identity.userId, previousPayload, nextPayload: result.data });
    trackServerEvent("settings_updated", {
      topicCount: result.data.topics?.length ?? 0,
      geoCount: result.data.geographies?.length ?? 0,
      sourceCount: (result.data.traditionalSources?.length ?? 0) + (result.data.socialSources?.length ?? 0),
      identitySource: identity.source,
    });
    res.json(result.data);
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

app.get("/api/dashboard", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const [settings, rawItems] = await Promise.all([readSettings(identity.userId), readFeedItems(DATA_DIR)]);
    const { items: sourceItems, errors: normErrors } = normalizeSourceItems(rawItems);
    if (normErrors.length > 0) {
      console.warn(`[ingestion.normalize] ${normErrors.length} item(s) skipped:`, normErrors);
    }
    const rawLimit = Number(req.query.limit ?? 10);
    const resolvedLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 10;
    const payload = await buildDashboardPayload(sourceItems, settings, resolvedLimit);
    const aiConfig = getAiCapabilityMap();
    const estimatedCostUsd = payload.stories.reduce(
      (sum, story) => sum + (story.aiSummaryMeta?.costUsd ?? 0),
      0
    );
    const fallbackCount = payload.stories.filter((story) => story.aiSummaryMeta?.fallbackUsed).length;
    if (estimatedCostUsd > 0) {
      console.log(
        `[ai.cost] capability=summarization model=${aiConfig.summarization} stories=${payload.stories.length} cost_usd=${estimatedCostUsd.toFixed(6)} fallback=${fallbackCount}`
      );
    }
    const responseStories = payload.stories.map(({ aiSummaryMeta: _meta, ...story }) => story);
    trackServerEvent("api_dashboard_requested", {
      storyCount: responseStories.length,
      normErrorCount: normErrors.length,
      limitApplied: resolvedLimit,
      fallbackCount,
      totalCostUsd: estimatedCostUsd,
      aiModel: aiConfig.summarization,
      identitySource: identity.source,
    });
    res.json({ contractVersion: payload.contractVersion, stories: responseStories });
  } catch (error) {
    trackServerEvent("api_error", {
      route: "/api/dashboard",
      statusCode: 500,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    res.status(500).json({
      message: "Failed to build dashboard payload.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/ai/models", (_req, res) => {
  res.json({
    capabilityMap: getAiCapabilityMap(),
    mockOnly: process.env.TEMPO_AI_MOCK_ONLY === "true",
  });
});

app.get("/api/ai/metrics", (_req, res) => {
  res.json({
    metrics: getAiMetrics(),
  });
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

// ─── Onboarding text extraction ──────────────────────────────────────────────
// Tries primary model first; if it fails and a different fallback is configured,
// retries with the fallback. Returns 500 only when both are unavailable.
app.post("/api/onboarding/extract", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ message: "text is required." });
    return;
  }

  const primary = process.env.TEMPO_AI_CLASSIFIER_MODEL || "mock-anthropic-haiku";
  const fallback = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;

  try {
    const result = await _extraction.extract(text, primary);
    return res.json(result);
  } catch (primaryErr) {
    console.warn(
      `[onboarding.extract] primary (${primary}) failed: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}`
    );
  }

  if (fallback && fallback !== primary) {
    console.log(`[onboarding.extract] attempting fallback: ${fallback}`);
    try {
      const result = await _extraction.extract(text, fallback);
      console.log(`[onboarding.extract] fallback (${fallback}) succeeded`);
      return res.json(result);
    } catch (fallbackErr) {
      console.warn(
        `[onboarding.extract] fallback (${fallback}) failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`
      );
    }
  }

  res.status(500).json({ message: "Extraction failed: all configured models unavailable." });
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
          "Track US and Colombia diplomatic stories — especially OFAC and migration. Trust NYT, Reuters, El Tiempo, and Semana.",
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
