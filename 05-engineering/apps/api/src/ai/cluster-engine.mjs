import { createHash } from "node:crypto";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { providerFor } from "./model-router.mjs";
import { withTimeout } from "./guardrails.mjs";
import { buildClusteringPrompt } from "./prompts.mjs";

export const CLUSTER_ENGINE_VERSION = "cluster-v1";

// ─── Zod schema for LLM clustering output ────────────────────────────────────
// Exported so the M8 cluster-smoke runner (and any future contract-shape
// checks) can validate against the same source of truth the real-provider
// parser already uses — no duplicated contract.

export const metaStoryOutputSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1),
  source_item_ids: z.array(z.string().min(1)).min(1).max(5),
  summary: z.string().min(1),
  tags: z.object({
    topics: z.array(z.string()),
    keywords: z.array(z.string()),
    geographies: z.array(z.string()),
  }),
  factual_claims: z.array(z.string()).min(1),
  claim_evidence_map: z.record(z.string(), z.array(z.string())),
});

export const clusteringOutputSchema = z.object({
  meta_stories: z.array(metaStoryOutputSchema).max(5),
});

// ─── Stable ID generation ─────────────────────────────────────────────────────

/**
 * Derives a stable meta-story ID from evidence signature — NOT from title text.
 * Signature = sorted source_item_ids joined with first topic tag.
 * Stable: same articles + topic → same ID even when title wording changes.
 *
 * @param {{ source_item_ids: string[], tags?: { topics?: string[] } }} metaStory
 */
export function generateMetaStoryId(metaStory) {
  const sortedIds = [...(metaStory.source_item_ids ?? [])].sort().join(",");
  const topic = ((metaStory.tags?.topics ?? [])[0] ?? "").toLowerCase().trim();
  const signature = sortedIds + "::" + topic;
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

// ─── Mock clustering (deterministic, no AI call) ─────────────────────────────

function mockCluster(items, settings) {
  const byTopic = new Map();
  for (const item of items) {
    const topic = item.topic || "General";
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(item);
  }

  const stories = [];
  for (const [topic, groupItems] of byTopic) {
    const sourceItems = groupItems.slice(0, 5);
    const title = `${topic} Developments`;
    const keywords = (settings.keywords ?? []).filter((k) =>
      sourceItems.some((i) =>
        (i.headline + " " + i.body.join(" ")).toLowerCase().includes(k.toLowerCase())
      )
    );
    const sourceItemIds = sourceItems.map((i) => i.sourceId);
    const factual_claims = sourceItems.map(
      (item) => `${item.outlet} reports: ${item.headline}`
    );
    const claim_evidence_map = Object.fromEntries(
      factual_claims.map((_, i) => [String(i), [sourceItems[i].sourceId]])
    );
    stories.push({
      title,
      subtitle: `Recent developments in ${topic.toLowerCase()}.`,
      source_item_ids: sourceItemIds,
      summary: `${title}. ${sourceItems.length} source${sourceItems.length === 1 ? "" : "s"} tracked.`,
      tags: {
        topics: [topic],
        keywords,
        geographies: [...new Set(sourceItems.flatMap((i) => i.geographies))],
      },
      factual_claims,
      claim_evidence_map,
    });
    if (stories.length >= 5) break;
  }

  return stories.map((ms) => ({ ...ms, meta_story_id: generateMetaStoryId(ms) }));
}

// ─── Real Anthropic clustering ────────────────────────────────────────────────

function parseClusteringResponse(raw) {
  const clean = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(clean);
  const result = clusteringOutputSchema.parse(parsed);
  return result.meta_stories.map((ms) => ({
    ...ms,
    meta_story_id: generateMetaStoryId(ms),
  }));
}

async function clusterWithAnthropic({ apiKey, model, items, settings, timeoutMs }) {
  const client = new Anthropic({ apiKey, timeout: timeoutMs });
  const prompt = buildClusteringPrompt(items, settings);
  const message = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  const block = message.content[0];
  if (!block || block.type !== "text" || !block.text.trim()) {
    throw new Error("Anthropic returned empty clustering response");
  }
  return parseClusteringResponse(block.text);
}

// ─── Fallback: graceful grouping without LLM ─────────────────────────────────

export function gracefulFallbackClustering(items, settings) {
  const byTopic = new Map();
  for (const item of items) {
    const topic = item.topic || "General";
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(item);
  }

  const stories = [];
  for (const [topic, groupItems] of byTopic) {
    const sourceItems = groupItems.slice(0, 5);
    const title = `${topic} Updates`;
    const sourceItemIds = sourceItems.map((i) => i.sourceId);
    const factual_claims = sourceItems.map(
      (item) => `${item.outlet} reports: ${item.headline}`
    );
    const claim_evidence_map = Object.fromEntries(
      factual_claims.map((_, i) => [String(i), [sourceItems[i].sourceId]])
    );
    const story = {
      title,
      subtitle: `Recent ${topic.toLowerCase()} updates.`,
      source_item_ids: sourceItemIds,
      summary: extractiveSummary(title, sourceItems),
      tags: {
        topics: [topic],
        keywords: [],
        geographies: [...new Set(sourceItems.flatMap((i) => i.geographies))],
      },
      factual_claims,
      claim_evidence_map,
    };
    stories.push({ meta_story_id: generateMetaStoryId(story), ...story });
    if (stories.length >= 5) break;
  }

  return stories;
}

// ─── Extractive summary fallback ──────────────────────────────────────────────

export function extractiveSummary(title, sourceItems) {
  const headlines = sourceItems
    .slice(0, 3)
    .map((i) => i.headline)
    .join("; ");
  return `${title}. ${headlines}.`;
}

/**
 * Deterministic subtitle text from source headlines only (no model prose).
 * Callers may use this for safe copy paths; the refresh pipeline does **not**
 * ship `partial_source_ids` stories (**J1a** — they are invalid / dropped).
 */
export function extractiveSubtitle(sourceItems) {
  const headlines = (sourceItems ?? []).map((i) => i?.headline).filter(Boolean);
  if (headlines.length === 0) return "";
  return headlines[0];
}

// ─── Grounding verifier ───────────────────────────────────────────────────────

// C0 summary cap — meta-story summary is a deterministic join of grounded
// claims, soft-capped at SUMMARY_MAX_CHARS.  Truncation appends an ellipsis
// at the nearest sentence boundary so we never ship a half-word.  The number
// is a product call (~400–500 chars keeps the card readable).  See Prompt 1.
const SUMMARY_MAX_CHARS = 500;

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function capSummary(text, maxChars = SUMMARY_MAX_CHARS) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars).trimEnd();
  // Try to clip at the last sentence boundary so we never end mid-word.
  const lastSentence = head.lastIndexOf(". ");
  if (lastSentence >= Math.floor(maxChars * 0.6)) {
    return head.slice(0, lastSentence + 1);
  }
  // Otherwise clip at last space and add ellipsis.
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) return head.slice(0, lastSpace) + "…";
  return head + "…";
}

/**
 * Joins grounded factual claims into a single summary string, separated by
 * a space; normalizes whitespace and caps length per C0 policy.  Each input
 * claim is expected to be a verified sentence — callers should pass only
 * claims that have already passed the evidence-map gate.
 *
 * @param {object} metaStory — meta-story carrying `factual_claims`
 * @returns {string} summary text (already capped)
 */
export function synthesizeSummary(metaStory) {
  const claims = Array.isArray(metaStory?.factual_claims)
    ? metaStory.factual_claims
        .map((c) => normalizeWhitespace(c))
        .filter((c) => c.length > 0)
    : [];
  if (claims.length === 0) return normalizeWhitespace(metaStory?.summary ?? "");
  // Ensure each claim ends with terminal punctuation so the join reads as
  // a sequence of sentences rather than run-on prose.
  const normalized = claims.map((c) => (/[.!?]$/.test(c) ? c : `${c}.`));
  return capSummary(normalizeWhitespace(normalized.join(" ")));
}

/**
 * Verifies grounding in two gates:
 *
 * Gate 1 (source-level): source_item_ids must reference real pool items.
 *   - All hallucinated → invalid "no_valid_source_ids" (discard)
 *   - Partial hallucinated → invalid "partial_source_ids" (trimmed ids on
 *     the returned object; pipeline **drops** these under **J1a** — no salvage)
 *
 * Gate 2 (claim-level): each factual_claims[i] must have ≥1 valid source in
 *   claim_evidence_map["i"]. A single claim with no valid backing rejects the
 *   entire story ("ungrounded_claims").  Stories with empty factual_claims pass.
 *
 * Gate 3 (valid path — C0 grounding policy for the meta-story fields PR):
 *   when `factual_claims.length > 0`:
 *     - `subtitle` is set to the **first** verified claim (clustering semantics
 *       — one sentence placing the story in context).
 *     - `summary` is a deterministic join of **all** verified claims (narrative
 *       across sources), whitespace-normalized and capped (~500 chars).  This
 *       guarantees `subtitle !== summary` whenever ≥2 claims are present.
 *   When `factual_claims.length === 0`, the model's `summary` / `subtitle`
 *   pass through unchanged.
 * @param {Array} metaStories
 * @param {Map<string, object>} sourceItemsById — keyed by sourceId
 * @returns {{ valid: Array, invalid: Array }}
 */
export function verifyGrounding(metaStories, sourceItemsById) {
  const valid = [];
  const invalid = [];

  for (const ms of metaStories) {
    // Gate 1: at least one source_item_id must be real
    const existingIds = ms.source_item_ids.filter((id) => sourceItemsById.has(id));

    if (existingIds.length === 0) {
      console.warn(
        `[grounding] meta_story="${ms.meta_story_id}" rejected: no valid source_item_ids (all hallucinated)`
      );
      invalid.push({ ...ms, groundingFailure: "no_valid_source_ids" });
      continue;
    }

    // Gate 2: every factual_claim[i] must have ≥1 valid evidence ID
    const claims = Array.isArray(ms.factual_claims) ? ms.factual_claims : [];
    const evidenceMap =
      ms.claim_evidence_map && typeof ms.claim_evidence_map === "object"
        ? ms.claim_evidence_map
        : {};
    const badClaimIndices = claims.reduce((acc, _, i) => {
      const evidence = evidenceMap[String(i)] ?? [];
      if (!evidence.some((id) => sourceItemsById.has(id))) acc.push(i);
      return acc;
    }, []);

    if (badClaimIndices.length > 0) {
      console.warn(
        `[grounding] meta_story="${ms.meta_story_id}" rejected: claims [${badClaimIndices.join(",")}] lack valid evidence`
      );
      invalid.push({ ...ms, groundingFailure: "ungrounded_claims" });
      continue;
    }

    // Gate 1 (partial): hallucinated ids trimmed; story is invalid — pipeline drops (J1a)
    if (existingIds.length < ms.source_item_ids.length) {
      const hallucinated = ms.source_item_ids.filter((id) => !sourceItemsById.has(id));
      console.warn(
        `[grounding] meta_story="${ms.meta_story_id}" partial: hallucinated ids=[${hallucinated.join(",")}] — invalid (strict drop)`
      );
      invalid.push({
        ...ms,
        source_item_ids: existingIds,
        groundingFailure: "partial_source_ids",
      });
      continue;
    }

    // Gate 3 (summary/subtitle — C0 policy): replace model-prose with verified-
    // claim text so ungrounded sentences cannot reach the publish path.  The
    // subtitle takes the first claim (one-sentence contextual placement);
    // the summary is the deterministic join of all claims (narrative across
    // sources) via `synthesizeSummary`.
    const groundedSubtitle =
      claims.length > 0 ? normalizeWhitespace(claims[0]) : ms.subtitle;
    const groundedSummary =
      claims.length > 0 ? synthesizeSummary(ms) : ms.summary;

    valid.push({ ...ms, summary: groundedSummary, subtitle: groundedSubtitle });
  }

  return { valid, invalid };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Cluster source items into meta-stories using the specified model.
 * Uses mock clustering when model is a mock provider.
 * Throws on provider error, API key missing, timeout, or schema validation failure.
 * Callers are responsible for fallback logic (gracefulFallbackClustering).
 *
 * @param {Array} items — normalized source items (filtered pool)
 * @param {object} settings — user settings (for keyword/tag extraction in mock)
 * @param {string} model — capability model string (e.g. "anthropic:claude-haiku-4-5-20251001")
 * @returns {Promise<Array>} — array of meta-story objects with meta_story_id
 */
export async function clusterItems(items, settings, model) {
  if (!items.length) return [];

  const provider = providerFor(model);
  const modelName = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
  const timeoutMs = Number(process.env.TEMPO_AI_TIMEOUT_MS || 15000);

  if (provider === "mock-anthropic" || provider === "mock-openai") {
    return mockCluster(items, settings);
  }

  if (provider === "anthropic") {
    const apiKey = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "TEMPO_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) is required for anthropic: clustering models"
      );
    }
    return withTimeout(
      () => clusterWithAnthropic({ apiKey, model: modelName, items, settings, timeoutMs }),
      timeoutMs,
      `Anthropic clustering timed out (${modelName})`
    );
  }

  // Default: mock fallback for unknown providers
  return mockCluster(items, settings);
}
