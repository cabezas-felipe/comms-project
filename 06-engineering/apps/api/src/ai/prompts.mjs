import { readHeadline, readBody } from "../ingestion/evidence-translator.mjs";

export const SUMMARY_PROMPT_VERSION = "summary-v1";
// Slice 15: bumped cluster-v2 → cluster-v3 — the prompt now reads normalized
// English evidence for non-English items and requires English meta-story output
// (title / subtitle / summary / factual_claims) even when sources are Spanish.
// Q1 B1: bumped cluster-v3 → cluster-v4 — each meta-story now also emits
// `associated_entities` (grounded named entities from the source evidence) so
// downstream relevance scoring can weigh entity fit, not only post-hoc tags.
export const CLUSTERING_PROMPT_VERSION = "cluster-v4";

export function buildClusteringPrompt(items, settings) {
  // Slice 15: feed normalized English evidence (`normalizedHeadline` /
  // `normalizedBody`) when present so the model clusters and writes in English
  // even when the original headline/body are Spanish. `readHeadline` /
  // `readBody` fall back to the untouched originals for English-native items.
  const itemLines = items
    .map(
      (item) =>
        `sourceId=${item.sourceId} | outlet=${item.outlet} | topic=${item.topic} | geographies=${item.geographies.join(",")} | minutesAgo=${item.minutesAgo}\nHeadline: ${readHeadline(item)}\nBody: ${readBody(item).slice(0, 2).join(" ").slice(0, 400)}`
    )
    .join("\n\n");

  const exampleOutput = JSON.stringify(
    {
      meta_stories: [
        {
          title: "6-10 word headline",
          subtitle: "One sentence placing the story in context.",
          source_item_ids: ["sourceId1", "sourceId2"],
          summary: "2-3 sentences describing the narrative using only the referenced articles.",
          tags: { topics: ["relevant topic"], keywords: ["key term"], geographies: ["country"] },
          associated_entities: ["named person, organization, contest, or place from the sources"],
          factual_claims: [
            "First discrete factual claim from the summary.",
            "Second discrete factual claim from the summary.",
          ],
          claim_evidence_map: {
            "0": ["sourceId1"],
            "1": ["sourceId2"],
          },
        },
      ],
    },
    null,
    2
  );

  return [
    "You are a narrative intelligence clustering engine for a communications dashboard.",
    "Group the following news articles into meta-stories. Each meta-story captures a coherent news narrative.",
    "",
    "Rules:",
    "- Return maximum 5 meta-stories",
    "- Each meta-story MUST reference at least 1 sourceId from the list below",
    "- Each meta-story may reference maximum 5 sourceIds",
    "- Every sourceId you reference MUST appear verbatim in the article list",
    "- Shared geography alone is NOT enough to merge: articles set in the same country can be unrelated stories",
    "- Do NOT merge unrelated event types into one meta-story (e.g. an election, an industrial accident, and a disease outbreak are distinct narratives even when they share a country)",
    "- Prefer separate meta-stories when events are distinct, even if they occur in the same country or geography",
    "- The summary must only describe what is stated in the referenced articles — no speculation",
    "- Write ALL output in English. Even when an article's headline or body is in another language (e.g. Spanish), the meta-story title, subtitle, summary, and factual_claims MUST be written in English — the dashboard audience reads English.",
    "- associated_entities: list the specific named entities the meta-story is about — people, organizations, government bodies, contests/events, and places — taken VERBATIM from the referenced articles. Every entity MUST be grounded in the provided source evidence; do NOT invent or infer entities that the articles do not mention. Omit the field (or use an empty array) when no concrete named entity is present.",
    "- factual_claims: list each discrete factual claim made in the summary as a separate string",
    "- claim_evidence_map: map each claim index (\"0\", \"1\", ...) to the sourceId(s) that directly support it",
    "- Every claim MUST be backed by at least one sourceId that appears in source_item_ids",
    "",
    "Return ONLY valid JSON matching this exact structure (no markdown fences, no prose):",
    exampleOutput,
    "",
    "ARTICLES:",
    itemLines,
  ].join("\n");
}

export function buildSummaryPrompt(cluster) {
  const sourceList = cluster.sources
    .map((s) => `${s.outlet} (${s.minutesAgo}m, w${s.weight})`)
    .join("; ");
  return [
    "You are a communications intelligence assistant.",
    "Summarize the narrative movement in 2 concise sentences.",
    "Prioritize signal over speculation.",
    `Title: ${cluster.title}`,
    `Topic: ${cluster.topic}`,
    `Priority: ${cluster.priority}`,
    `Geographies: ${cluster.geographies.join(", ")}`,
    `Sources: ${sourceList}`,
  ].join("\n");
}
