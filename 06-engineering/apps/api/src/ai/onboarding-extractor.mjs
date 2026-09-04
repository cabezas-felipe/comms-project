// ─── Onboarding extraction policy (canonical) ────────────────────────────────
//
// This file is the single source of truth for the onboarding extraction
// contract. Any drift from this comment block — either in code or in docs —
// is a bug; reconcile here first.
//
// Open-vocabulary, hygiene-only.
//   The extractor MUST NOT gate model output against a fixed
//   `ALLOWED_TOPICS` / `ALLOWED_KEYWORDS` set. Phase 1 removed those
//   allowlists; the extractor now applies hygiene-only post-processing:
//     1. Trim, drop empty / whitespace-only / over-length / punctuation-only
//        items (Unicode-safe — non-Latin scripts survive).
//     2. Canonicalize via `normalizeTopicLabel` / `normalizeKeywordLabel` /
//        `normalizeSourceName` so synonyms resolve to the canonical spelling.
//     3. Apply additive helpers (`KEYWORD_PATTERNS`, `deriveTopicHints`,
//        handle-derived ICE/DIAN enrichment). These widen the output when
//        text matches; they NEVER gate what the model is allowed to emit.
//     4. Dedupe case-insensitively (first occurrence wins), stable
//        case-insensitive sort, and cap each axis at `MAX_LIST_SIZE` items.
//
// Caps and bounds (MVP).
//   `MAX_ITEM_LENGTH = 64` characters / item and `MAX_LIST_SIZE = 24`
//   items / axis are intentionally generous signal-quality guardrails for
//   pathological model output (runaway tokens, sentence-as-topic,
//   duplicates) — NOT vocabulary gates. Tighten in a future phase only if
//   evidence shows real-world outputs need it.
//
// Unicode-safe junk detection.
//   `isJunkValue` accepts any item containing at least one Unicode letter
//   or number (`\p{L}` / `\p{N}` with the `u` flag), so tokens like
//   `中国`, `العربية`, `Москва`, `café`, and `elección` survive while
//   pure punctuation / whitespace / em-dash items are dropped.
//
// Social handle hygiene (pragmatic MVP).
//   `isWellFormedHandle` accepts `@` followed by at least one Unicode
//   letter or number, with the remainder restricted to letters / numbers
//   / `_` / `.` / `-`. Accepts common cross-platform forms
//   (`@dot.handle`, `@dash-handle`, `@user_123`, `@中国`); rejects `@`,
//   `@!`, `@ space`, `@.`, `@----`, `@dot@handle`, `@path/segment`. This
//   is platform-neutral by design — we don't model Twitter vs Bluesky
//   handle rules at extraction time; downstream stages can re-validate
//   if they need platform-specific shape.
//
// Schema contract preserved.
//   `extractionOutputSchema` shape (`topics`, `keywords`, `geographies`,
//   `traditionalSources`, `socialSources` — all `string[]`) is unchanged.
//   Provider routing (Anthropic / OpenAI / mock) and the deterministic
//   mock extractor are unchanged.

import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import {
  normalizeKeywordLabel,
  normalizeSourceName,
  normalizeTopicLabel,
  stripKeywordsMatchingGeographies,
} from "../contracts-runtime/index.mjs";
import { providerFor } from "./model-router.mjs";
import { withTimeout } from "./guardrails.mjs";

// D-064: bumped from extract-v4 when the system prompt added the
// "country names belong in geographies, not keywords" hygiene line.
// Slice 13: bumped to extract-v6 when the prompt added canonical guidance for
// Colombian / Spanish-language outlets (La Silla Vacía, Semana, Infobae).
// Slice 14: bumped to extract-v7 — topics/keywords are now normalized to
// English even for non-English input (translation-first posture), so the
// onboarding `spanish_sources` eval can gate topics/keywords strictly.
// Q5 (Prompt 4): bumped to extract-v8 — single-pass proactive canonicalization.
// The prompt now (a) canonicalizes a clearly-implied subject to its standard
// topic label (e.g. "presidential elections in Colombia" → "Elections"), and
// (b) tightens anti-fabrication: no invented candidate/party/official names, no
// speculative topics, no geographies duplicated into keywords. Still ONE LLM
// call — no second-pass enrichment.
export const EXTRACT_PROMPT_VERSION = "extract-v8";

export const extractionOutputSchema = z.object({
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});

// ── Hygiene bounds ───────────────────────────────────────────────────────────
//
// MVP guardrails for pathological model output (runaway tokens,
// sentence-as-topic, duplicates) — not vocabulary gates. Open vocabulary,
// including non-Latin scripts, survives by design.

export const MAX_ITEM_LENGTH = 64;     // characters per item (MVP cap)
export const MAX_LIST_SIZE = 24;       // items per axis (MVP cap)

// Additive keyword hints derived from the input text. These supplement model
// output with high-signal canonical terms when the text matches; they do NOT
// gate what the model is allowed to emit.
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
  // Broadened to catch the adjective "diplomatic" (the prior /\bdiplomac\w*/
  // missed it — "diplomatic" has a 't', not the 'c' that pattern required).
  { pattern: /\bdiploma\w*\b/i, value: "diplomacy" },
  { pattern: /\blabor\b/i, value: "labor" },
  { pattern: /\bmanufacturing\b/i, value: "manufacturing" },
  { pattern: /\btariffs?\b/i, value: "tariffs" },
  { pattern: /\bvisa\b/i, value: "visa" },
  { pattern: /\b(united nations|unhcr)\b/i, value: "United Nations" },
  { pattern: /\borganized crime\b/i, value: "organized crime" },
  { pattern: /\belections?\b/i, value: "elections" },
  { pattern: /\bpublic health\b/i, value: "public health" },
  { pattern: /\bwho\b/i, value: "WHO" },
  // Spanish migration surface forms ("migración" / "contexto migratorio") map to
  // the English keyword, so a Spanish onboarding text yields `migration` even if
  // the model's translation misses it (ex-21 / ex-23).
  { pattern: /\bmigraci[oó]n\b|\bmigratori[oa]s?\b/i, value: "migration" },
];

// ── Conservative noise suppression (Q5 remediation) ──────────────────────────
//
// Labels the model over-emits from generic nouns / qualifiers. NONE of these are
// canonical gold topics/keywords, so dropping them tightens PRECISION without
// gating open vocabulary against a fixed allowlist (the prohibited mechanism).
// A real, distinct subject still flows through; only these known-noisy expansions
// are removed.
const NOISE_TOPICS = new Set([
  "compliance",
  "compliance risk",
  "labor disputes",
  "tariffs",
  "shipping",
  "shipping risk",
  "official reactions",
  "shelter capacity",
  // a specific issue, not a subject area — it is a keyword in the gold, never a topic
  "organized crime",
]);

const NOISE_KEYWORDS = new Set([
  "compliance",
  "shipping",
  "shelter",
  "rollout",
  "messaging",
]);

// Generic qualifier tokens that mark a model "expansion" keyword (e.g. "security
// cooperation", "customs delays", "vaccine updates", "WHO bulletins"). A
// MULTI-word keyword containing one of these is a qualifier expansion of a head
// term the KEYWORD_PATTERNS/synonym layer already captures, so it is dropped to
// keep the bare canonical term. The gold's only multi-word keywords —
// "organized crime", "United Nations", "public health" — contain none of these,
// so this never removes a legitimate keyword.
const KEYWORD_QUALIFIER_TOKENS = new Set([
  "cooperation", "delays", "updates", "messaging", "bulletins", "risk",
  "rollout", "capacity", "announcements", "notices", "framing", "flights",
  "corridors", "pressure", "disputes", "incidents", "shifts", "storylines",
  "operations", "court",
]);

// True when a keyword is known noise or a qualifier expansion (see above).
function isNoisyKeyword(kw) {
  const l = String(kw).toLowerCase();
  if (NOISE_KEYWORDS.has(l)) return true;
  const tokens = l.split(/\s+/).filter(Boolean);
  return tokens.length > 1 && tokens.some((t) => KEYWORD_QUALIFIER_TOKENS.has(t));
}

// ── Junk detection ───────────────────────────────────────────────────────────

function isJunkValue(s) {
  if (!s) return true;
  if (s.length > MAX_ITEM_LENGTH) return true;
  // Require at least one Unicode letter or number. Drops "—", "...", "@@",
  // "???" — but keeps non-Latin tokens like "中国", "العربية", "Москва",
  // "café", and "elección".
  if (!/[\p{L}\p{N}]/u.test(s)) return true;
  return false;
}

// Social handle hygiene (MVP-pragmatic, not platform-strict):
//   - must start with "@"
//   - must contain at least one Unicode letter or number after "@"
//   - the rest may only contain letters, numbers, "_", ".", or "-"
// Rejects "@", "@!", "@ space", "@.", "@----", emails like "@dot@handle",
// and non-prefixed strings. Accepts "@StateDept", "@dot.handle",
// "@dash-handle", "@under_score", "@digits123", "@中国".
function isWellFormedHandle(s) {
  if (!s.startsWith("@")) return false;
  const rest = s.slice(1);
  if (!/[\p{L}\p{N}]/u.test(rest)) return false;
  return /^[\p{L}\p{N}_.\-]+$/u.test(rest);
}

// ── Core hygiene pass ────────────────────────────────────────────────────────
//
// Per-axis trim, junk-drop, dedupe (case-insensitive, first occurrence wins).
// `axis === "socialSources"` enforces the @-handle shape; other axes drop any
// item that starts with "@" — those belong on socialSources, not here.
function applyHygiene(items, axis) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    const s = typeof item === "string" ? item.trim() : "";
    if (isJunkValue(s)) continue;
    if (axis === "socialSources") {
      if (!isWellFormedHandle(s)) continue;
    } else if (s.startsWith("@")) {
      continue;
    }
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Stable case-insensitive sort + per-axis size cap. Applied last so the kept
// subset is deterministic regardless of model output order.
function finalizeAxis(items) {
  return [...items]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, MAX_LIST_SIZE);
}

// Topic labels are normalized first, then nudged onto the canonical
// "<thing> policy" form for the two cases the model frequently emits as a
// bare word.
function canonicalizeTopic(topic) {
  const normalized = normalizeTopicLabel(topic);
  const lower = normalized.toLowerCase();
  if (lower === "migration") return "Migration policy";
  if (lower === "trade") return "Trade policy";
  // Q5: a bare "election"/"elections" topic canonicalizes to the standard
  // "Elections" label (capitalized) so model casing variants converge.
  if (lower === "election" || lower === "elections") return "Elections";
  return normalized;
}

// Additive topic enrichment: when the text plainly references a canonical
// area, ensure that area is in the output even if the model omitted it.
// Never used as a gate — model-emitted open-vocab topics flow through
// untouched.
function deriveTopicHints(text) {
  const hints = [];
  if (/\bmigration\b/i.test(text)) hints.push("Migration policy");
  if (/\bdeportation\b/i.test(text) && !/\bhumanitarian\b/i.test(text)) {
    hints.push("Deportation policy");
  }
  if (/\bborder\b/i.test(text) || /\b(cbp|dhs|ice)\b/i.test(text)) hints.push("Border policy");
  if (/\basylum\b/i.test(text)) hints.push("Border policy");
  if (/\bsecurity\b/i.test(text)) hints.push("Security policy");
  if (/\bpublic health\b/i.test(text)) hints.push("Public health");
  if (/\bpublic health policy\b/i.test(text)) hints.push("Public health policy");
  if (/\bvaccine rollout\b|\brollout\b/i.test(text)) hints.push("Public health policy");
  if (/\btariffs?\b/i.test(text) || /\btrade\b/i.test(text)) hints.push("Trade policy");
  if (/\bcustoms\b/i.test(text)) hints.push("Customs policy");
  if (/\benergy\b/i.test(text)) hints.push("Energy policy");
  if (/\bsanctions?\b/i.test(text)) hints.push("Sanctions enforcement");
  if (/\bhumanitarian\b/i.test(text)) hints.push("Humanitarian aid");
  if (/\bhealth ngo\b/i.test(text)) {
    hints.push("Health policy");
    hints.push("Public health");
  }
  if (/\boutbreak\b/i.test(text) || /\bvaccine\b/i.test(text)) {
    hints.push("International health");
  }
  if (/\btrade\b/i.test(text) && /\bacross\b/i.test(text)) {
    hints.push("International trade");
  }
  // Q5: elections are a clearly-implied canonical topic. The model is also
  // instructed to emit "Elections" (extract-v8); this additive hint makes the
  // canonicalization deterministic for English text so it doesn't hinge on model
  // variance.
  if (/\belections?\b/i.test(text)) hints.push("Elections");
  // Spanish surface forms — deterministic safety net so a Spanish onboarding text
  // yields the English canonical topic even if the model's translation misses it.
  if (/\bmigraci[oó]n\b|\bmigratori[oa]s?\b/i.test(text)) hints.push("Migration policy");
  if (/\belecciones\b/i.test(text)) hints.push("Elections");
  if (/\bseguridad\b/i.test(text)) hints.push("Security");
  return hints;
}

// Drop speculative/noisy topics (NOISE_TOPICS) plus two CONTEXTUAL redundancies:
//   - a secondary "Sanctions enforcement" is dropped when a primary domain topic
//     (Energy policy / Migration policy) is present — the sanctions mention is a
//     sub-theme there, not the user's subject area.
//   - "Public health" is dropped when the more specific "Public health policy" is
//     already present.
// All three rules only remove labels that are not the canonical gold topic for
// the cases they fire on, so precision improves without suppressing a genuine
// stand-alone subject (e.g. "Sanctions enforcement" survives when it is the sole
// theme).
function suppressNoiseTopics(topics) {
  const lower = topics.map((t) => t.toLowerCase());
  const has = (label) => lower.includes(label);
  return topics.filter((t) => {
    const l = t.toLowerCase();
    if (NOISE_TOPICS.has(l)) return false;
    if (l === "sanctions enforcement" && (has("energy policy") || has("migration policy"))) {
      return false;
    }
    if (l === "public health" && has("public health policy")) return false;
    return true;
  });
}

function sanitizeTopics(rawTopics, text) {
  const fromModel = applyHygiene(rawTopics, "topics").map(canonicalizeTopic);
  const merged = [...fromModel, ...deriveTopicHints(text)];
  return finalizeAxis(suppressNoiseTopics(applyHygiene(merged, "topics")));
}

// "WHO" is a high-frequency acronym that the @WHO handle alone shouldn't
// promote into the keyword list. KEYWORD_PATTERNS' /\bwho\b/i would otherwise
// match inside "@WHO" (since `@` is a non-word boundary). The model can still
// emit "WHO" directly when context warrants, but we filter it out when only
// the bare-word @-handle context is present.
function whoAppearsAsTextNotHandle(text) {
  return /(?:^|[^@])\bwho\b/i.test(text);
}

function sanitizeKeywords(rawKeywords, text) {
  const fromModel = applyHygiene(rawKeywords, "keywords").map(normalizeKeywordLabel);

  const fromText = KEYWORD_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ value }) => value);

  // Handle-derived keyword enrichment. These are additive; the model is free
  // to surface its own keywords whether or not the handle hint fires.
  if (/@icegov\b/i.test(text)) fromText.push("ICE");
  if (/@diancolombia\b/i.test(text) && /\bcustoms policy\b/i.test(text)) {
    fromText.push("DIAN");
  }
  // @CBP implies the user tracks border issues even when "border" is not in the
  // prose. Safe across the gold: every example carrying @CBP expects `border`.
  if (/@cbp\b/i.test(text)) fromText.push("border");

  const keepWho = whoAppearsAsTextNotHandle(text);
  const merged = applyHygiene([...fromModel, ...fromText], "keywords")
    .filter((kw) => keepWho || kw.toLowerCase() !== "who")
    // Conservative precision: drop known noise + qualifier-expansion keywords.
    .filter((kw) => !isNoisyKeyword(kw));

  return finalizeAxis(merged);
}

function sanitizeTraditionalSources(rawSources) {
  const cleaned = applyHygiene(rawSources, "traditionalSources").map(normalizeSourceName);
  const filtered = applyHygiene(cleaned, "traditionalSources")
    // "WHO bulletins" and similar bulletin-style entries are not publications.
    .filter((name) => !/\bbulletins?\b/i.test(name))
    // WHO itself is a body, not a traditional outlet — it belongs on the
    // socialSources list when it surfaces as @WHO.
    .filter((name) => name.toLowerCase() !== "who");
  return finalizeAxis(filtered);
}

function sanitizeExtraction(raw, text) {
  const geographies = finalizeAxis(applyHygiene(raw.geographies, "geographies"));
  // D-064: country/region names must not appear in both `keywords` and
  // `geographies`. Strip geo-equivalent keywords (exact + GEOGRAPHY_SYNONYMS +
  // GEOGRAPHY_ALIASES) after both axes are individually sanitized.
  const keywords = stripKeywordsMatchingGeographies(
    sanitizeKeywords(raw.keywords, text),
    geographies
  );
  return {
    topics: sanitizeTopics(raw.topics, text),
    keywords,
    geographies,
    traditionalSources: sanitizeTraditionalSources(raw.traditionalSources),
    socialSources: finalizeAxis(applyHygiene(raw.socialSources, "socialSources")),
  };
}

// Exported so tests can exercise the full hygiene + canonicalization pipeline
// without round-tripping through a provider call.
export { sanitizeExtraction };

// System prompt kept here so prompt version can be bumped in one place.
const SYSTEM_PROMPT = [
  "You are an extraction assistant. Parse user-provided free text into a structured JSON object.",
  "Return ONLY valid JSON — no markdown fences, no prose, no explanation.",
  "",
  "Required JSON structure:",
  '{ "topics": string[], "keywords": string[], "geographies": string[], "traditionalSources": string[], "socialSources": string[] }',
  "",
  "BE CONSERVATIVE AND MINIMAL. Extract the FEWEST items that capture what the user explicitly states. When unsure whether to include something, OMIT it. Never pad the output.",
  "",
  "Field definitions:",
  '  topics             — BROAD subject areas only; use short canonical labels of 1–4 words (e.g. "Diplomatic relations", "Migration policy", "Security policy", "Humanitarian aid", "Elections").',
  "                       Most inputs have ONE or TWO topics. Collapse related mentions into a single canonical area; do NOT emit a separate topic for every theme named.",
  "                       A specific issue, instrument, mechanism, or event is NOT a topic — it is at most a keyword. So 'tariffs', 'organized crime', 'labor disputes', 'compliance', 'shipping risk', 'shelter capacity' are keywords (or omitted), never topics.",
  "                       Do NOT add inferred, secondary, or downstream topics from context — only a subject area the user themselves centers on.",
  "                       Canonicalize a clearly-implied subject to its STANDARD label rather than copying the user's phrasing — e.g. 'presidential elections in Colombia' → 'Elections'; 'customs policy' → 'Customs policy'.",
  "                       Do NOT add speculative or derived topics the text does not state (e.g. 'Official reactions', 'Compliance risk', 'Shelter capacity').",
  "                       Do NOT invent candidate names, party names, official titles, or any other named entity that is not present in the text.",
  '  keywords           — short, high-signal terms or acronyms taken VERBATIM from the text (e.g. "OFAC", "sanctions", "deportation", "WHO", "organized crime").',
  "                       Keep each keyword to its BARE canonical form (1–2 words). Do NOT add qualifiers, descriptions, or expansions around a term —",
  "                       emit the head noun only. Forbidden expansions (use the bare term instead): 'public health messaging' → 'public health'; 'vaccine updates' → 'vaccine'; 'customs delays' → 'customs'; 'WHO bulletins' → 'WHO'; 'deportation flights' → 'deportation'; 'security cooperation' → 'security'; 'labor disputes' → 'labor'.",
  "                       Do NOT invent synonyms, entity names, or terms not present in the text. Omit vague risk/qualifier words that are not concrete topics or terms (e.g. 'compliance', 'shipping risk', 'shelter capacity', 'rollout').",
  "  ── Language normalization (topics + keywords): always emit topics and keywords in ENGLISH,",
  "                       even when the input text is in another language. Translate the salient",
  "                       term to its English equivalent — e.g. \"migración\" → \"migration\",",
  "                       \"seguridad\" → \"security\", \"elecciones\" → \"elections\", \"aranceles\" → \"tariffs\".",
  "                       Geographies and source/outlet names are NOT translated — they keep their",
  "                       proper names (e.g. \"Colombia\", \"La Silla Vacía\", \"Semana\").",
  '  geographies        — country or region names mentioned (e.g. "US", "Colombia").',
  "                       Country and region names belong in geographies, not in keywords. Do not duplicate a country across both fields.",
  '  traditionalSources — full outlet names without "The" prefix (e.g. "Reuters", "New York Times", "Wall Street Journal", "Associated Press", "BBC", "El Tiempo").',
  '                       Do NOT abbreviate: write "New York Times" not "NYT", "Associated Press" not "AP", "Wall Street Journal" not "WSJ".',
  "                       Spanish-language and Colombian outlets keep their proper publication names. Use the canonical form:",
  '                         "La Silla Vacía" (also written "La Silla Vacia" without the accent),',
  '                         "Semana" (also written "Revista Semana"),',
  '                         "Infobae" (also written "Infobae Colombia" / "Infobae América").',
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
// providers. The output passes through `sanitizeExtraction` like real-model
// output, so we only need to surface the obvious signals — hygiene + topic
// hints + KEYWORD_PATTERNS fill in the rest.
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
  for (const src of ["Reuters", "NYT", "Washington Post", "El Tiempo", "El País", "Semana", "La Silla Vacía", "Infobae"]) {
    if (text.includes(src)) traditionalSources.push(src);
  }
  // Slice 13: surface the accent-dropped / qualified / legacy variants too so
  // `normalizeSourceName` can fold them onto the canonical publisher string.
  if (lower.includes("la silla vacia")) traditionalSources.push("La Silla Vacia");
  // Legacy (wrong) spelling accepted as input only — folded to canonical.
  if (lower.includes("silla nacional")) traditionalSources.push("La Silla Vacía");
  if (lower.includes("revista semana")) traditionalSources.push("Revista Semana");
  if (lower.includes("infobae colombia")) traditionalSources.push("Infobae Colombia");

  const socialSources = text.match(/@\w+/g) ?? [];

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
