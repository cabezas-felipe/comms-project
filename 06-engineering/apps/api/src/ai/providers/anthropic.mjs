import Anthropic from "@anthropic-ai/sdk";

export async function summarizeWithAnthropic({ apiKey, model, prompt, timeoutMs }) {
  const client = new Anthropic({ apiKey, timeout: timeoutMs });
  const message = await client.messages.create({
    model,
    max_tokens: 256,
    temperature: 0.2,
    system: "Return concise, factual summaries with no markdown.",
    messages: [{ role: "user", content: prompt }],
  });
  const block = message.content[0];
  if (!block || block.type !== "text" || !block.text.trim()) {
    throw new Error("Anthropic API returned empty summary");
  }
  return {
    summary: block.text.trim(),
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
  };
}
