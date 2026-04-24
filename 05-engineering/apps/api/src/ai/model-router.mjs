import { summarizeWithMockOpenAI } from "./providers/mock-openai.mjs";
import { summarizeWithMockAnthropic } from "./providers/mock-anthropic.mjs";
import { summarizeWithOpenAICompatible } from "./providers/openai-compatible.mjs";
import { summarizeWithAnthropic } from "./providers/anthropic.mjs";
import { heuristicSummary, withTimeout } from "./guardrails.mjs";
import { buildSummaryPrompt, SUMMARY_PROMPT_VERSION } from "./prompts.mjs";

// Reads env at call time so tests can set vars after import.
function getCapabilityDefaults() {
  return {
    summarization: process.env.TEMPO_AI_SUMMARY_MODEL || "mock-openai-mini",
    classification: process.env.TEMPO_AI_CLASSIFIER_MODEL || "mock-anthropic-haiku",
    safety: process.env.TEMPO_AI_SAFETY_MODEL || "mock-openai-mini",
  };
}

// Real Anthropic token pricing (USD per million tokens, as of 2026-04).
const ANTHROPIC_COSTS = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 0.80, outputPerMTok: 4.00 },
  "claude-sonnet-4-6": { inputPerMTok: 3.00, outputPerMTok: 15.00 },
  "claude-opus-4-7": { inputPerMTok: 15.00, outputPerMTok: 75.00 },
};

export function providerFor(model) {
  if (process.env.TEMPO_AI_MOCK_ONLY === "true") {
    return model.startsWith("mock-anthropic") ? "mock-anthropic" : "mock-openai";
  }
  if (model.startsWith("anthropic:")) return "anthropic";
  if (model.startsWith("openai:")) return "openai-compatible";
  if (model.startsWith("mock-anthropic")) return "mock-anthropic";
  if (model.startsWith("mock-openai")) return "mock-openai";
  return "mock-openai";
}

function resolveModelName(model) {
  const colonIdx = model.indexOf(":");
  return colonIdx !== -1 ? model.slice(colonIdx + 1) : model;
}

function estimateCostUsd(modelName, promptTokens, outputTokens) {
  const rates = ANTHROPIC_COSTS[modelName];
  if (rates) {
    return Number(
      ((promptTokens * rates.inputPerMTok + outputTokens * rates.outputPerMTok) / 1_000_000).toFixed(6)
    );
  }
  // Deterministic stub for mock/unknown models.
  const factor = modelName.includes("anthropic") ? 0.0000022 : 0.0000020;
  return Number(((promptTokens + outputTokens) * factor).toFixed(6));
}

export function getAiCapabilityMap() {
  return getCapabilityDefaults();
}

const aiMetrics = {
  summarizationRequests: 0,
  summarizationFallbacks: 0,
  summarizationTimeouts: 0,
  providerErrors: 0,
};

export function getAiMetrics() {
  return { ...aiMetrics };
}

// Validates that all configured real providers have their required API keys.
// Accepts an optional capabilityMap for testing; defaults to current env config.
export function assertAiConfig(capabilityMap = getCapabilityDefaults()) {
  for (const [capability, model] of Object.entries(capabilityMap)) {
    const provider = providerFor(model);
    if (provider === "anthropic") {
      const key = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!key) {
        throw new Error(
          `[ai.config] ${capability}=${model} requires TEMPO_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY`
        );
      }
    }
    if (provider === "openai-compatible" && !process.env.TEMPO_OPENAI_API_KEY) {
      throw new Error(`[ai.config] ${capability}=${model} requires TEMPO_OPENAI_API_KEY`);
    }
  }
}

export async function summarizeCluster(cluster) {
  const capability = "summarization";
  const model = getCapabilityDefaults()[capability];
  const provider = providerFor(model);
  const modelName = resolveModelName(model);
  const startedAt = Date.now();
  aiMetrics.summarizationRequests += 1;
  const timeoutMs = Number(process.env.TEMPO_AI_TIMEOUT_MS || 1200);
  const prompt = buildSummaryPrompt(cluster);

  try {
    const callResult = await withTimeout(
      async () => {
        if (provider === "anthropic") {
          const apiKey = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            throw new Error(
              "TEMPO_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) is required for anthropic: models"
            );
          }
          const result = await summarizeWithAnthropic({ apiKey, model: modelName, prompt, timeoutMs });
          return { summary: result.summary, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
        }
        if (provider === "openai-compatible") {
          const apiKey = process.env.TEMPO_OPENAI_API_KEY;
          if (!apiKey) throw new Error("TEMPO_OPENAI_API_KEY is missing");
          const summary = await summarizeWithOpenAICompatible({ apiKey, model: modelName, prompt, timeoutMs });
          return { summary, inputTokens: null, outputTokens: null };
        }
        if (provider === "mock-anthropic") {
          const summary = await summarizeWithMockAnthropic({ cluster });
          return { summary, inputTokens: null, outputTokens: null };
        }
        const summary = await summarizeWithMockOpenAI({ cluster });
        return { summary, inputTokens: null, outputTokens: null };
      },
      timeoutMs,
      "AI summarization timed out"
    );

    const { summary, inputTokens: actualInputTokens, outputTokens: actualOutputTokens } = callResult;
    const elapsedMs = Date.now() - startedAt;
    const estimatedPromptTokens = Math.max(40, cluster.sources.length * 30);
    const estimatedOutputTokens = Math.max(20, Math.ceil(summary.length / 5));
    const promptTokens = actualInputTokens ?? estimatedPromptTokens;
    const outputTokens = actualOutputTokens ?? estimatedOutputTokens;
    const costUsd = estimateCostUsd(modelName, promptTokens, outputTokens);

    return {
      summary,
      meta: {
        capability,
        model,
        provider,
        elapsedMs,
        timedOut: false,
        fallbackUsed: false,
        promptTokens,
        outputTokens,
        costUsd,
        promptVersion: SUMMARY_PROMPT_VERSION,
      },
    };
  } catch (error) {
    const summary = heuristicSummary(cluster);
    const elapsedMs = Date.now() - startedAt;
    aiMetrics.providerErrors += 1;
    aiMetrics.summarizationFallbacks += 1;
    const timedOut = error instanceof Error && error.message.includes("timed out");
    if (timedOut) {
      aiMetrics.summarizationTimeouts += 1;
    }
    return {
      summary,
      meta: {
        capability,
        model,
        provider,
        elapsedMs,
        timedOut,
        fallbackUsed: true,
        promptTokens: 0,
        outputTokens: Math.max(20, Math.ceil(summary.length / 5)),
        costUsd: 0,
        promptVersion: SUMMARY_PROMPT_VERSION,
      },
    };
  }
}
