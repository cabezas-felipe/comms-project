import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { providerFor } from "./model-router.mjs";
import { withTimeout } from "./guardrails.mjs";

export const EXTRACT_PROMPT_VERSION = "extract-v3";

export const extractionOutputSchema = z.object({
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});

// System prompt kept here so prompt version can be bumped in one place.
const SYSTEM_PROMPT = [
  "You are an extraction assistant. Parse user-provided free text into a structured JSON object.",
  "Return ONLY valid JSON — no markdown fences, no prose, no explanation.",
  "",
  "Required JSON structure:",
  '{ "topics": string[], "keywords": string[], "geographies": string[], "traditionalSources": string[], "socialSources": string[] }',
  "",
  "Field definitions:",
  '  topics             — broad subject areas; use short canonical labels of 1–4 words (e.g. "Diplomatic relations", "Migration policy", "Security policy", "Humanitarian aid").',
  '                       Do NOT use full sentences or verbose fragments.',
  '  keywords           — specific terms, acronyms, or proper names (e.g. "OFAC", "sanctions", "deportation").',
  '                       Keep each entry short (1–3 words).',
  '  geographies        — country or region names mentioned (e.g. "US", "Colombia").',
  '  traditionalSources — full outlet names without "The" prefix (e.g. "Reuters", "New York Times", "Wall Street Journal", "Associated Press", "BBC", "El Tiempo").',
  '                       Do NOT abbreviate: write "New York Times" not "NYT", "Associated Press" not "AP", "Wall Street Journal" not "WSJ".',
  '  socialSources      — social media accounts or platform-based sources (e.g. "@stateDept", "@latamwatcher").',
  "",
  "Source classification rules:",
  "  - Handles starting with \"@\" → socialSources",
  "  - Named news outlets, newspapers, wire services, or publications → traditionalSources",
  "  - When uncertain, prefer traditionalSources.",
  "",
  "Extract only what is explicitly stated. Return empty arrays for fields with no relevant content.",
].join("\n");

// User message is just the raw text; all instruction lives in the system prompt.
export function buildExtractionPrompt(text) {
  return text;
}

// Strip optional markdown code fences before JSON.parse.
function parseExtractionJson(raw) {
  const clean = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(clean);
}

// Deterministic mock extraction used by both mock-anthropic and mock-openai providers.
function mockExtract(text) {
  const lower = text.toLowerCase();

  const topics = [];
  if (lower.includes("diplomat") || lower.includes("bilateral")) topics.push("Diplomatic relations");
  if (lower.includes("migrat") || lower.includes("deportat")) topics.push("Migration policy");
  if (lower.includes("security") || lower.includes("cooperat")) topics.push("Security cooperation");

  const keywords = [];
  for (const kw of ["OFAC", "sanctions", "deportation", "bilateral"]) {
    if (text.includes(kw)) keywords.push(kw);
  }

  const geographies = [];
  if (lower.includes("united states") || lower.includes(" us ") || lower.includes(" u.s.")) {
    geographies.push("US");
  }
  if (lower.includes("colombia")) geographies.push("Colombia");

  const traditionalSources = [];
  for (const src of ["Reuters", "NYT", "Washington Post", "El Tiempo", "El País", "Semana"]) {
    if (text.includes(src)) traditionalSources.push(src);
  }

  const seenSocial = new Set();
  const socialSources = [];
  for (const handle of (text.match(/@\w+/g) ?? [])) {
    const key = handle.toLowerCase();
    if (!seenSocial.has(key)) { seenSocial.add(key); socialSources.push(handle); }
  }

  return { topics, keywords, geographies, traditionalSources, socialSources };
}

async function extractWithAnthropic({ apiKey, model, text, timeoutMs }) {
  const client = new Anthropic({ apiKey, timeout: timeoutMs });
  const message = await client.messages.create({
    model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildExtractionPrompt(text) }],
  });
  const block = message.content[0];
  if (!block || block.type !== "text" || !block.text.trim()) {
    throw new Error("Anthropic returned empty extraction response");
  }
  const parsed = parseExtractionJson(block.text);
  return extractionOutputSchema.parse(parsed);
}

async function extractWithOpenAICompatible({ apiKey, model, text, timeoutMs }) {
  const baseUrl = (process.env.TEMPO_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const endpoint = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildExtractionPrompt(text) },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI-compatible API returned HTTP ${response.status}`);
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error("OpenAI-compatible returned empty extraction response");
    const parsed = parseExtractionJson(raw);
    return extractionOutputSchema.parse(parsed);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract onboarding fields from free text using the specified model.
 * Throws on provider error, API key missing, timeout, or schema validation failure.
 * Callers are responsible for implementing fallback logic.
 */
export async function extractOnboarding(text, model) {
  const provider = providerFor(model);
  const modelName = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
  const timeoutMs = Number(process.env.TEMPO_AI_TIMEOUT_MS || 1200);

  if (provider === "mock-anthropic" || provider === "mock-openai") {
    return extractionOutputSchema.parse(mockExtract(text));
  }

  if (provider === "anthropic") {
    const apiKey = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "TEMPO_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) is required for anthropic: models"
      );
    }
    return withTimeout(
      () => extractWithAnthropic({ apiKey, model: modelName, text, timeoutMs }),
      timeoutMs,
      `Anthropic extraction timed out (${modelName})`
    );
  }

  if (provider === "openai-compatible") {
    const apiKey = process.env.TEMPO_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "TEMPO_OPENAI_API_KEY (or OPENAI_API_KEY) is required for openai: models"
      );
    }
    return withTimeout(
      () => extractWithOpenAICompatible({ apiKey, model: modelName, text, timeoutMs }),
      timeoutMs,
      `OpenAI extraction timed out (${modelName})`
    );
  }

  // providerFor() defaults unknown prefixes to "mock-openai", so this branch
  // is only reachable if that contract changes.
  return extractionOutputSchema.parse(mockExtract(text));
}
