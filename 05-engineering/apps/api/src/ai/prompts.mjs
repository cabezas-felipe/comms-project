export const SUMMARY_PROMPT_VERSION = "summary-v1";

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
