import { summarizeWithMockOpenAI } from "./providers/mock-openai.mjs";
import { summarizeWithMockAnthropic } from "./providers/mock-anthropic.mjs";
import { summarizeWithOpenAICompatible } from "./providers/openai-compatible.mjs";
import { heuristicSummary, withTimeout } from "./guardrails.mjs";
import { buildSummaryPrompt, SUMMARY_PROMPT_VERSION } from "./prompts.mjs";

const CAPABILITY_DEFAULTS = {
  summarization: process.env.TEMPO_AI_SUMMARY_MODEL || "mock-openai-mini",
  classification: process.env.TEMPO_AI_CLASSIFIER_MODEL || "mock-anthropic-haiku",
  safety: process.env.TEMPO_AI_SAFETY_MODEL || "mock-openai-mini",
};

function providerFor(model) {
  if (model.startsWith("openai:")) return "openai-compatible";
  if (model.startsWith("mock-openai")) return "mock-openai";
  if (model.startsWith("mock-anthropic")) return "mock-anthropic";
  return "mock-openai";
}

function estimateCostUsd(model, promptTokens, outputTokens) {
  // Cheap deterministic cost stub for MVP observability.
  const factor = model.startsWith("mock-anthropic") ? 0.0000022 : 0.0000020;
  return Number(((promptTokens + outputTokens) * factor).toFixed(6));
}

export function getAiCapabilityMap() {
  return { ...CAPABILITY_DEFAULTS };
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

export async function summarizeCluster(cluster) {
  const capability = "summarization";
  const model = CAPABILITY_DEFAULTS[capability];
  const provider = providerFor(model);
  const startedAt = Date.now();
  aiMetrics.summarizationRequests += 1;
  const timeoutMs = Number(process.env.TEMPO_AI_TIMEOUT_MS || 1200);
  const prompt = buildSummaryPrompt(cluster);

  try {
    const summary = await withTimeout(
      async () => {
        if (provider === "openai-compatible") {
          const apiKey = process.env.TEMPO_OPENAI_API_KEY;
          if (!apiKey) {
            throw new Error("TEMPO_OPENAI_API_KEY is missing");
          }
          const modelName = model.replace("openai:", "");
          return summarizeWithOpenAICompatible({
            apiKey,
            model: modelName,
            prompt,
            timeoutMs,
          });
        }
        if (provider === "mock-anthropic") {
          return summarizeWithMockAnthropic({ cluster });
        }
        return summarizeWithMockOpenAI({ cluster });
      },
      timeoutMs,
      "AI summarization timed out"
    );
    const elapsedMs = Date.now() - startedAt;
    const promptTokens = Math.max(40, cluster.sources.length * 30);
    const outputTokens = Math.max(20, Math.ceil(summary.length / 5));
    const costUsd = estimateCostUsd(model, promptTokens, outputTokens);

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
