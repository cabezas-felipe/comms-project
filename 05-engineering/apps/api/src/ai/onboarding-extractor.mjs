import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { normalizeKeywordLabel, normalizeSourceName, normalizeTopicLabel } from "@tempo/contracts";
import { providerFor } from "./model-router.mjs";
import { withTimeout } from "./guardrails.mjs";

export const EXTRACT_PROMPT_VERSION = "extract-v4";

export const extractionOutputSchema = z.object({
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});

const ALLOWED_TOPICS = new Set([
  "Border policy",
  "Customs policy",
  "Deportation policy",
  "Diplomatic relations",
  "Energy policy",
  "Health policy",
  "Humanitarian aid",
  "International health",
  "International trade",
  "Migration policy",
  "Public health",
  "Public health policy",
  "Sanctions enforcement",
  "Security policy",
  "Trade policy",
]);

const ALLOWED_KEYWORDS = new Set([
  "asylum",
  "border",
  "customs",
  "deportation",
  "dhs",
  "dian",
  "diplomacy",
  "elections",
  "energy",
  "health",
  "ice",
  "labor",
  "manufacturing",
  "migration",
  "ofac",
  "organized crime",
  "outbreak",
  "public health",
  "sanctions",
  "security",
  "tariffs",
  "trade",
  "united nations",
  "vaccine",
  "visa",
  "who",
]);

const KEYWORD_PATTERNS = [
  { pattern: /\bofac\b/i, value: "OFAC" },
  { pattern: /\bmigration\b/i, value: "migration" },
  { pattern: /\bsanctions?\b/i, value: "sanctions" },
  { pattern: /\benergy\b/i, value: "energy" },
  { pattern: /\bborder\b/i, value: "border" },
  { pattern: /\bsecurity\b/i, value: "security" },
  { pattern: /\bhealth\b/i, value: "health" },
  { pattern: /\boutbreaks?\b/i, value: "outbreak" },
  { pattern: /\bvaccines?\b/i, value: "vaccine" },
  { pattern: /\bcustoms?\b/i, value: "customs" },
  { pattern: /\bdian\b/i, value: "DIAN" },
  { pattern: /\btrade\b/i, value: "trade" },
  { pattern: /\basylum\b/i, value: "asylum" },
  { pattern: /\bdeportation\b/i, value: "deportation" },
  { pattern: /\bice\b/i, value: "ICE" },
  { pattern: /\bdhs\b/i, value: "DHS" },
  { pattern: /\bdiplomac\w*\b/i, value: "diplomacy" },
  { pattern: /\blabor\b/i, value: "labor" },
  { pattern: /\bmanufacturing\b/i, value: "manufacturing" },
  { pattern: /\btariffs?\b/i, value: "tariffs" },
  { pattern: /\bvisa\b/i, value: "visa" },
  { pattern: /\b(united nations|unhcr)\b/i, value: "United Nations" },
  { pattern: /\borganized crime\b/i, value: "organized crime" },
  { pattern: /\belections?\b/i, value: "elections" },
  { pattern: /\bpublic health\b/i, value: "public health" },
  { pattern: /\bwho\b/i, value: "WHO" },
];

// Trim, drop empties, and dedupe case-insensitively (first-occurrence wins).
function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    const s = typeof item === "string" ? item.trim() : "";
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function sortCaseInsensitive(items) {
  return [...items].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Topic labels coming from the model are normalized first, then nudged onto
// the canonical "<thing> policy" form for the two cases the model frequently
// emits as a bare word.
function canonicalizeTopic(topic) {
  const normalized = normalizeTopicLabel(topic);
  const lower = normalized.toLowerCase();
  if (lower === "migration") return "Migration policy";
  if (lower === "trade") return "Trade policy";
  return normalized;
}

function deriveTopicHints(text) {
  const lower = text.toLowerCase();
  const hints = [];
  if (/\bmigration\b/i.test(text)) hints.push("Migration policy");
  if (/\bdeportation\b/i.test(text) && !/\bhumanitarian\b/i.test(lower)) {
    hints.push("Deportation policy");
  }
  if (/\bborder\b/i.test(text) || /\b(cbp|dhs|ice)\b/i.test(text)) hints.push("Border policy");
  if (/\bsecurity\b/i.test(text)) hints.push("Security policy");
  if (/\bpublic health\b/i.test(text)) hints.push("Public health");
  if (/\btariffs?\b/i.test(text) || /\btrade\b/i.test(text)) hints.push("Trade policy");
  return hints;
}

function sanitizeTopics(rawTopics, text) {
  const lower = text.toLowerCase();
  let fromModel = uniqueStrings(rawTopics)
    .map(canonicalizeTopic)
    .filter((topic) => ALLOWED_TOPICS.has(topic));

  // Dataset-consistent strictness: sanctions usually surface as a keyword,
  // not a top-level topic, unless the brief is sanctions/compliance-focused.
  if (
    fromModel.includes("Sanctions enforcement") &&
    (fromModel.includes("Energy policy") || fromModel.includes("Migration policy"))
  ) {
    fromModel = fromModel.filter((t) => t !== "Sanctions enforcement");
  }

  // Humanitarian/migration narratives can mention deportation as a keyword
  // without promoting it to a top-level topic.
  if (fromModel.includes("Humanitarian aid") && fromModel.includes("Deportation policy")) {
    fromModel = fromModel.filter((t) => t !== "Deportation policy");
  }

  let topics = uniqueStrings([...fromModel, ...deriveTopicHints(text)]);

  const addIfMissing = (label) => {
    if (!topics.includes(label)) topics.push(label);
  };

  if (/\bhealth ngo\b/i.test(lower)) addIfMissing("Health policy");
  if (/\boutbreak\b/i.test(lower) || /\bvaccine\b/i.test(lower)) {
    addIfMissing("International health");
  }
  if (/\btrade\b/i.test(lower) && /\bacross\b/i.test(lower)) {
    addIfMissing("International trade");
  }

  // "Diplomatic relations" requires an explicit phrase — the bare word
  // "diplomatic" alone isn't enough to keep the topic.
  if (!/\b(diplomatic relations|bilateral relations)\b/i.test(lower)) {
    topics = topics.filter((t) => t !== "Diplomatic relations");
  }

  // When the brief refers only to "public health policy" (and not bare
  // "public health"), the International + Public pair is redundant — drop
  // Public so the more specific International stands.
  if (
    topics.includes("International health") &&
    topics.includes("Public health") &&
    /\bpublic health policy\b/i.test(lower) &&
    !/\bpublic health(?! policy)\b/i.test(lower)
  ) {
    topics = topics.filter((t) => t !== "Public health");
  }

  return sortCaseInsensitive(topics);
}

// "WHO" is a high-frequency acronym that the @WHO handle alone shouldn't
// promote into the keyword list — only count it when the bare word appears
// outside of an @-prefix.
function whoAppearsAsTextNotHandle(text) {
  return /(?:^|[^@])\bwho\b/i.test(text);
}

function sanitizeKeywords(rawKeywords, text) {
  const lower = text.toLowerCase();

  const fromModel = uniqueStrings(rawKeywords)
    .map(normalizeKeywordLabel)
    .filter((kw) => ALLOWED_KEYWORDS.has(kw.toLowerCase()));

  const fromText = KEYWORD_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ value }) => value);

  // Handle-derived keyword exceptions with explicit policy checks.
  if (/@icegov\b/i.test(lower)) fromText.push("ICE");
  if (/@diancolombia\b/i.test(lower) && /\bcustoms policy\b/i.test(lower)) fromText.push("DIAN");

  const keepWho = whoAppearsAsTextNotHandle(text);
  const merged = uniqueStrings([...fromModel, ...fromText])
    .filter((kw) => ALLOWED_KEYWORDS.has(kw.toLowerCase()))
    .filter((kw) => keepWho || kw.toLowerCase() !== "who");

  return sortCaseInsensitive(merged);
}

function sanitizeSources(rawTraditional) {
  return sortCaseInsensitive(
    uniqueStrings(rawTraditional)
      .map((name) => normalizeSourceName(name))
      .filter((name) => !/\bbulletins?\b/i.test(name))
      .filter((name) => name.toLowerCase() !== "who")
  );
}

function sanitizeExtraction(raw, text) {
  return {
    topics: sanitizeTopics(raw.topics, text),
    keywords: sanitizeKeywords(raw.keywords, text),
    geographies: sortCaseInsensitive(uniqueStrings(raw.geographies)),
    traditionalSources: sanitizeSources(raw.traditionalSources),
    socialSources: sortCaseInsensitive(uniqueStrings(raw.socialSources)),
  };
}

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
  "                       Be conservative: include a topic only when explicitly stated or unambiguously central.",
  "                       Do NOT add speculative/derived topics (e.g. 'Official reactions', 'Compliance risk', 'Shelter capacity').",
  '  keywords           — specific terms, acronyms, or proper names explicitly present in the text (e.g. "OFAC", "sanctions", "deportation").',
  "                       Prefer verbatim terms from user text; do not invent synonyms not present in text.",
  "                       Include high-signal nouns/acronyms when present (e.g. WHO, DHS, ICE, DIAN, migration, border, sanctions, vaccine, outbreak).",
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

// Deterministic mock extraction used by both mock-anthropic and mock-openai
// providers.  The output passes through `sanitizeExtraction` like real-model
// output, so we only need to surface the obvious signals — the sanitizer's
// allow-lists, keyword patterns, and topic hints fill in the rest (and drop
// anything the mock guesses incorrectly).
function mockExtract(text) {
  const lower = text.toLowerCase();

  const topics = [];
  if (lower.includes("diplomat") || lower.includes("bilateral")) topics.push("Diplomatic relations");
  if (lower.includes("migrat") || lower.includes("deportat")) topics.push("Migration policy");

  const keywords = [];
  for (const kw of ["OFAC", "sanctions", "deportation"]) {
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

  const socialSources = uniqueStrings(text.match(/@\w+/g) ?? []);

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
  const parsed = extractionOutputSchema.parse(parseExtractionJson(block.text));
  return extractionOutputSchema.parse(sanitizeExtraction(parsed, text));
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
    const parsed = extractionOutputSchema.parse(parseExtractionJson(raw));
    return extractionOutputSchema.parse(sanitizeExtraction(parsed, text));
  } finally {
    clearTimeout(timer);
  }
}

// 15s default — Anthropic Opus + Sonnet round-trips routinely run 3–8s on
// first call (cold cache, 512-token completion). The previous 1.2s default
// caused both primary and fallback to time out simultaneously, collapsing the
// save flow to a baseline-only persist. Override per-environment via
// TEMPO_AI_TIMEOUT_MS when needed (CI mocks set it lower).
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 15000;

/**
 * Resolves the active extraction timeout from env, falling back to the
 * production-safe default. Exported so tests can verify the default and the
 * override path without coupling to a free-floating constant.
 */
export function resolveTimeoutMs() {
  const raw = process.env.TEMPO_AI_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_EXTRACTION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXTRACTION_TIMEOUT_MS;
}

// Strip the optional "<provider>:" prefix so SDK calls receive a bare model id.
function resolveModelName(model) {
  const i = model.indexOf(":");
  return i !== -1 ? model.slice(i + 1) : model;
}

/**
 * Extract onboarding fields from free text using the specified model.
 * Throws on provider error, API key missing, timeout, or schema validation failure.
 * Callers are responsible for implementing fallback logic.
 */
export async function extractOnboarding(text, model) {
  const provider = providerFor(model);
  const modelName = resolveModelName(model);
  const timeoutMs = resolveTimeoutMs();

  if (provider === "mock-anthropic" || provider === "mock-openai") {
    return extractionOutputSchema.parse(sanitizeExtraction(mockExtract(text), text));
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
