import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { settingsPayloadSchema } from "@tempo/contracts";
import { getAiCapabilityMap, getAiMetrics, summarizeCluster, assertAiConfig } from "./ai/model-router.mjs";
import { extractOnboarding } from "./ai/onboarding-extractor.mjs";
import { readSettings, writeSettings, DEFAULT_SETTINGS } from "./db/settings-repo.mjs";
import { isSupabaseEnabled, getSupabaseClient } from "./db/client.mjs";
import { readFeedItems } from "./ingestion/feed-reader.mjs";
import { normalizeSourceItems } from "./ingestion/source-normalizer.mjs";
import { trackServerEvent } from "./telemetry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.TEMPO_DATA_DIR ?? path.join(ROOT, "data");
const PORT = Number(process.env.TEMPO_API_PORT || 8787);

const app = express();
app.use(express.json());

/**
 * Extracts the authenticated user ID from the Bearer token in the Authorization header.
 * Returns null when no token is present, Supabase is unconfigured, or the token is invalid.
 */
async function resolveUserId(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) return null;
  if (!isSupabaseEnabled()) return null;
  const token = authHeader.slice(7);
  try {
    const { data, error } = await getSupabaseClient().auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

/**
 * Mutable resolver hook. Tests override _auth.resolver to inject a deterministic user ID
 * without a live Supabase instance. Do not use in production code paths.
 */
export const _auth = { resolver: resolveUserId };

/**
 * Mutable extraction hook. Tests override _extraction.extract to simulate primary/fallback
 * success or failure without calling a live AI provider. Do not use in production code paths.
 */
export const _extraction = { extract: extractOnboarding };

/**
 * Enforces authentication on a route. Sends 401 and returns null when the resolver
 * cannot identify the caller. Callers must guard: `if (!userId) return;`
 */
async function requireAuth(req, res) {
  const userId = await _auth.resolver(req);
  if (!userId) {
    res.status(401).json({ message: "Authentication required. Provide a valid Bearer token." });
    return null;
  }
  return userId;
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
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const payload = await readSettings(userId);
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      message: "Failed to read settings.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.put("/api/settings", async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const result = settingsPayloadSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      message: "Invalid settings payload.",
      errors: result.error.errors,
    });
    return;
  }
  try {
    await writeSettings(result.data, userId);
    trackServerEvent("settings_updated", {
      topicCount: result.data.topics?.length ?? 0,
      geoCount: result.data.geographies?.length ?? 0,
      sourceCount: (result.data.traditionalSources?.length ?? 0) + (result.data.socialSources?.length ?? 0),
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
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const [settings, rawItems] = await Promise.all([readSettings(userId), readFeedItems(DATA_DIR)]);
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

// ─── Dev-only QA: mint a magic link via Supabase Admin API ───────────────────
// Disabled by default. Enable for local QA only: TEMPO_ENABLE_DEV_MAGIC_LINK=true
// NEVER enable in staging or production — uses service-role credentials.

// Maps the frontend auth mode to the Supabase admin.generateLink type.
// login → magiclink  (OTP sign-in for an existing user)
// signup → signup    (creates user if needed + signs in)
const LINK_TYPE_MAP = Object.freeze({ login: "magiclink", signup: "signup" });

// Only localhost origins are permitted as redirectTo destinations.
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedRedirectOrigin(urlStr) {
  if (!urlStr) return true; // omitted redirectTo is fine; Supabase uses its default
  try {
    const { protocol, hostname, port } = new URL(urlStr);
    return DEV_ORIGIN_RE.test(`${protocol}//${hostname}${port ? `:${port}` : ""}`);
  } catch {
    return false;
  }
}

/**
 * Mutable hook so tests can replace generateLink without live Supabase.
 * Same pattern as _auth.resolver. Do not use in production code paths.
 */
export const _devMagicLink = {
  generateLink: async ({ email, supabaseType, redirectTo }) => {
    const adminClient = createClient(
      /** @type {string} */ (process.env.SUPABASE_URL),
      /** @type {string} */ (process.env.SUPABASE_SERVICE_ROLE_KEY),
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const opts = redirectTo ? { options: { redirectTo } } : {};
    const { data, error } = await adminClient.auth.admin.generateLink({
      type: supabaseType,
      email,
      ...opts,
    });
    if (error) throw error;
    return data.properties.action_link;
  },
};

app.post("/api/auth/dev-magic-link", async (req, res) => {
  if (process.env.TEMPO_ENABLE_DEV_MAGIC_LINK !== "true") {
    res.status(404).json({ message: "Not found." });
    return;
  }

  const { email, type, redirectTo } = req.body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ message: "email is required and must contain @." });
    return;
  }
  if (type !== "login" && type !== "signup") {
    res.status(400).json({ message: "type must be 'login' or 'signup'." });
    return;
  }
  if (redirectTo !== undefined && typeof redirectTo !== "string") {
    res.status(400).json({ message: "redirectTo must be a string when provided." });
    return;
  }
  if (!isAllowedRedirectOrigin(redirectTo)) {
    res.status(400).json({
      message: "redirectTo must point to a localhost origin (this endpoint is dev-only).",
    });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({
      message: "Magic link generation requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
    return;
  }

  try {
    const supabaseType = LINK_TYPE_MAP[type];
    const url = await _devMagicLink.generateLink({ email, supabaseType, redirectTo });
    res.json({ url });
  } catch (err) {
    console.error(
      `[auth.dev-magic-link] generateLink failed: ${err instanceof Error ? err.message : String(err)}`
    );
    res.status(502).json({ message: "Could not generate magic link." });
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
