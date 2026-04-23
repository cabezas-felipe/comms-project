export async function summarizeWithOpenAICompatible({
  apiKey,
  model,
  prompt,
  timeoutMs,
}) {
  const endpoint = process.env.TEMPO_OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions";

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
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "Return concise, factual summaries with no markdown.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI-compatible API returned HTTP ${response.status}`);
    }
    const data = await response.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      throw new Error("OpenAI-compatible API returned empty summary");
    }
    return summary;
  } finally {
    clearTimeout(timer);
  }
}
