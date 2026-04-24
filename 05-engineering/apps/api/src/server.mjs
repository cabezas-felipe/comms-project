import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settingsPayloadSchema } from "@tempo/contracts";
import { getAiCapabilityMap, getAiMetrics, summarizeCluster, assertAiConfig } from "./ai/model-router.mjs";
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

export { app };

if (process.argv[1] === __filename) {
  app.listen(PORT, () => {
    console.log(`@tempo/api listening on http://localhost:${PORT}`);
  });
}
