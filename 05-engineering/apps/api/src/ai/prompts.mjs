export const SUMMARY_PROMPT_VERSION = "summary-v1";
export const CLUSTERING_PROMPT_VERSION = "cluster-v2";

export function buildClusteringPrompt(items, settings) {
  const itemLines = items
    .map(
      (item) =>
        `sourceId=${item.sourceId} | outlet=${item.outlet} | topic=${item.topic} | geographies=${item.geographies.join(",")} | minutesAgo=${item.minutesAgo}\nHeadline: ${item.headline}\nBody: ${item.body.slice(0, 2).join(" ").slice(0, 400)}`
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
