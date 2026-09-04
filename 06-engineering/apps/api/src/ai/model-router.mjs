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
    clustering: process.env.TEMPO_AI_CLUSTER_MODEL || "mock-anthropic-haiku",
  };
}

// Default SKUs for the story-pool critical capabilities, kept here so the
// readiness helper has one source of truth for "what model would actually
// run" without each consumer reading env directly.
const DEFAULT_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

// Capabilities the DC validation guard treats as required for a real-model
// run.  Listed here (not inline in route code) so additions are one edit.
export const CRITICAL_REAL_RUN_CAPABILITIES = Object.freeze([
  "clustering",
  "geoAssess",
  "embedding",
]);

// Defaults for the onboarding extraction chain.  The route handler reads these
// via `resolveExtractionChain()` and never hardcodes the literals — so a
// model deprecation or A/B swap requires only an env flip, not a redeploy of
// route code.  Production defaults match what shipped historically (Opus
// primary, Sonnet fallback) so behavior is unchanged when the env is unset.
const DEFAULT_EXTRACTION_PRIMARY = "anthropic:claude-opus-4-7";
const DEFAULT_EXTRACTION_FALLBACK = "anthropic:claude-sonnet-4-6";

/**
 * Resolve the two-model extraction chain from env, falling back to the
 * shipping defaults.  Reads env at call time so tests can override after
 * module import.  Returns `{ primary, fallback }` — never `null`/`undefined`,
 * so callers can pass the values straight through to `extractOnboarding`.
 *
 * Env vars:
 *   TEMPO_AI_CLASSIFIER_MODEL          → primary  (default: anthropic:claude-opus-4-7)
 *   TEMPO_AI_CLASSIFIER_FALLBACK_MODEL → fallback (default: anthropic:claude-sonnet-4-6)
 */
export function resolveExtractionChain() {
  const primary =
    (process.env.TEMPO_AI_CLASSIFIER_MODEL ?? "").trim() || DEFAULT_EXTRACTION_PRIMARY;
  const fallback =
    (process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL ?? "").trim() || DEFAULT_EXTRACTION_FALLBACK;
  return { primary, fallback };
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

// ─── Critical-capability readiness (R2) ──────────────────────────────────────
// Reports, for each capability that story-pool real-mode validation depends on,
// the effective model id, the routed provider, whether the route is mock, and
// whether the required key is present.  `readyForRealRun` is the conjunction:
// all critical capabilities resolved to a real provider AND have their key.
//
// Pure / deterministic given process.env — no I/O, no provider calls — so the
// guard surface (`/api/ai/models`, refresh-time gate) and tests can rely on it.

function anthropicKeyPresent() {
  return Boolean(process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
}

function openAiKeyPresent() {
  return Boolean(process.env.TEMPO_OPENAI_API_KEY || process.env.OPENAI_API_KEY);
}

// Embedding routing isn't part of `providerFor()` because the embedding path
// only speaks OpenAI today (no "openai:" prefix is required to opt in).
// `TEMPO_AI_MOCK_ONLY=true` forces the mock branch in `embeddings.mjs`; we
// mirror that decision here so readiness matches actual runtime behavior.
function resolveEmbeddingReadiness() {
  const model = process.env.TEMPO_OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  if (process.env.TEMPO_AI_MOCK_ONLY === "true") {
    return {
      capability: "embedding",
      model,
      provider: "mock-openai-embedding",
      mock: true,
      keyRequired: false,
      keyPresent: false,
      ready: false,
    };
  }
  const keyPresent = openAiKeyPresent();
  return {
    capability: "embedding",
    model,
    provider: "openai-embedding",
    mock: false,
    keyRequired: true,
    keyPresent,
    ready: keyPresent,
  };
}

// Readiness for a capability whose model id is resolved through `providerFor`
// (clustering, geoAssess).  Centralized so both clustering and geoAssess share
// the same shape and the same "real provider needs key" rule.
function resolveProviderCapabilityReadiness(capability, model) {
  const provider = providerFor(model);
  if (provider === "anthropic") {
    const keyPresent = anthropicKeyPresent();
    return {
      capability,
      model,
      provider,
      mock: false,
      keyRequired: true,
      keyPresent,
      ready: keyPresent,
    };
  }
  if (provider === "openai-compatible") {
    const keyPresent = openAiKeyPresent();
    return {
      capability,
      model,
      provider,
      mock: false,
      keyRequired: true,
      keyPresent,
      ready: keyPresent,
    };
  }
  // mock-anthropic / mock-openai / unknown → mock route
  return {
    capability,
    model,
    provider,
    mock: true,
    keyRequired: false,
    keyPresent: false,
    ready: false,
  };
}

/**
 * Report readiness for the capabilities story-pool DC validation depends on.
 * Reads env at call time — no caching — so flipping `TEMPO_AI_MOCK_ONLY` or
 * unsetting a key in a test is immediately reflected.
 *
 * Shape:
 *   {
 *     readyForRealRun: boolean,           // AND across all capabilities
 *     mockOnly: boolean,                  // TEMPO_AI_MOCK_ONLY === "true"
 *     capabilities: {
 *       clustering: { capability, model, provider, mock, keyRequired, keyPresent, ready },
 *       geoAssess:  { ... },
 *       embedding:  { ... },
 *     },
 *     missingKeys: string[],              // env var names that would unblock a real run
 *   }
 */
export function getProviderReadiness() {
  const capabilityMap = getCapabilityDefaults();
  const clusteringModel = capabilityMap.clustering;
  const geoAssessModel = process.env.TEMPO_AI_GEO_ASSESS_MODEL || DEFAULT_GEO_ASSESS_MODEL;

  const clustering = resolveProviderCapabilityReadiness("clustering", clusteringModel);
  const geoAssess = resolveProviderCapabilityReadiness("geoAssess", geoAssessModel);
  const embedding = resolveEmbeddingReadiness();

  const capabilities = { clustering, geoAssess, embedding };
  const missingKeys = new Set();
  for (const cap of Object.values(capabilities)) {
    if (cap.mock) continue;
    if (cap.keyRequired && !cap.keyPresent) {
      if (cap.provider === "anthropic") missingKeys.add("TEMPO_ANTHROPIC_API_KEY");
      else if (cap.provider === "openai-compatible" || cap.provider === "openai-embedding") {
        missingKeys.add("TEMPO_OPENAI_API_KEY");
      }
    }
  }

  const readyForRealRun = Object.values(capabilities).every((c) => c.ready);
  return {
    readyForRealRun,
    mockOnly: process.env.TEMPO_AI_MOCK_ONLY === "true",
    capabilities,
    missingKeys: [...missingKeys].sort(),
  };
}

// ─── DC validation-mode guard (R2) ───────────────────────────────────────────
// `TEMPO_DC_VALIDATION_MODE=true` declares the operator's intent: this run
// must execute against real providers.  When the flag is set, callers should
// invoke `assertReadyForRealRun()` before doing any work that would otherwise
// silently route through mocks.  The guard does NOT touch behavior outside
// validation mode — local dev / test runs continue exactly as before.

export const DC_VALIDATION_MODE_ENV = "TEMPO_DC_VALIDATION_MODE";

export function isDcValidationModeEnabled() {
  return process.env[DC_VALIDATION_MODE_ENV] === "true";
}

/**
 * Throw with a machine-readable diagnostic when DC validation mode is on but
 * a critical capability is mocked or missing a key.  No-op when validation
 * mode is off, so existing flows are unchanged.  Returns the readiness
 * snapshot in both branches so callers can also surface it on success.
 *
 * The thrown Error carries:
 *   - .code = "DC_VALIDATION_NOT_READY"   (stable for clients)
 *   - .readiness = { ... full snapshot ... }
 *   - .reasons = ["capability=clustering provider=mock-anthropic", ...]
 */
export function assertReadyForRealRun({ readiness = getProviderReadiness() } = {}) {
  if (!isDcValidationModeEnabled()) return readiness;
  if (readiness.readyForRealRun) return readiness;

  const reasons = [];
  for (const cap of Object.values(readiness.capabilities)) {
    if (cap.ready) continue;
    if (cap.mock) {
      reasons.push(`capability=${cap.capability} provider=${cap.provider} (mock route)`);
    } else if (cap.keyRequired && !cap.keyPresent) {
      reasons.push(`capability=${cap.capability} provider=${cap.provider} missing-key`);
    } else {
      reasons.push(`capability=${cap.capability} provider=${cap.provider} not-ready`);
    }
  }

  const err = new Error(
    `[ai.dc-validation] real-model run required but providers not ready: ${reasons.join("; ")}` +
      (readiness.missingKeys.length > 0 ? ` (missing keys: ${readiness.missingKeys.join(", ")})` : "")
  );
  err.code = "DC_VALIDATION_NOT_READY";
  err.readiness = readiness;
  err.reasons = reasons;
  throw err;
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
