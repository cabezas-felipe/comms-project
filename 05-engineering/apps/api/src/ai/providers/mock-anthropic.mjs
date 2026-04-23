export async function summarizeWithMockAnthropic({ cluster, maxSentences = 2 }) {
  const topOutlets = cluster.sources
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((s) => s.outlet)
    .join(", ");
  const sentenceOne = `Cluster focus: ${cluster.topic}. Highest-signal outlets: ${topOutlets || "n/a"}.`;
  const sentenceTwo = `Narrative posture is ${cluster.priority === "top" ? "high urgency" : "monitoring"} with ${cluster.geographies.join(" / ")} relevance.`;
  return [sentenceOne, sentenceTwo].slice(0, maxSentences).join(" ");
}
