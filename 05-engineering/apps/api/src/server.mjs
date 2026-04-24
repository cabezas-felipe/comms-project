import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settingsPayloadSchema } from "@tempo/contracts";
import { getAiCapabilityMap, getAiMetrics, summarizeCluster, assertAiConfig } from "./ai/model-router.mjs";
import { readSettings, writeSettings, DEFAULT_SETTINGS } from "./db/settings-repo.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.TEMPO_DATA_DIR ?? path.join(ROOT, "data");
const SOURCE_ITEMS_FILE = path.join(DATA_DIR, "source-items.json");
const PORT = Number(process.env.TEMPO_API_PORT || 8787);

const app = express();
app.use(express.json());

try {
  assertAiConfig();
} catch (err) {
  console.warn(`[ai.config] Misconfiguration detected: ${err.message}`);
}

async function readSourceItems() {
  const content = await fs.readFile(SOURCE_ITEMS_FILE, "utf8");
  return JSON.parse(content);
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

app.get("/api/settings", async (_req, res) => {
  try {
    const payload = await readSettings();
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      message: "Failed to read settings.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.put("/api/settings", async (req, res) => {
  const result = settingsPayloadSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      message: "Invalid settings payload.",
      errors: result.error.errors,
    });
    return;
  }
  try {
    await writeSettings(result.data);
    res.json(result.data);
  } catch (error) {
    res.status(500).json({
      message: "Failed to write settings.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const [settings, sourceItems] = await Promise.all([readSettings(), readSourceItems()]);
    const limit = Number(req.query.limit ?? 10);
    const payload = await buildDashboardPayload(sourceItems, settings, Number.isFinite(limit) ? limit : 10);
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
    res.json({ contractVersion: payload.contractVersion, stories: responseStories });
  } catch (error) {
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
