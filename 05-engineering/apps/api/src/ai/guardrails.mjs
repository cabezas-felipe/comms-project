export async function withTimeout(promiseFactory, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promiseFactory(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function heuristicSummary(cluster) {
  const sourceCount = cluster.sources.length;
  const freshest = Math.min(...cluster.sources.map((s) => s.minutesAgo));
  return `${cluster.title}. ${sourceCount} sources tracked; latest update ${freshest} minutes ago.`;
}
