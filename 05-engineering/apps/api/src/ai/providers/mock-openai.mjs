export async function summarizeWithMockOpenAI({ cluster, maxSentences = 2 }) {
  const sourceCount = cluster.sources.length;
  const freshest = Math.min(...cluster.sources.map((s) => s.minutesAgo));
  const sentenceOne = `${cluster.title} is moving with ${sourceCount} sources in scope.`;
  const sentenceTwo = `Latest movement was ${freshest} minutes ago, with emphasis on ${cluster.topic.toLowerCase()}.`;
  return [sentenceOne, sentenceTwo].slice(0, maxSentences).join(" ");
}
