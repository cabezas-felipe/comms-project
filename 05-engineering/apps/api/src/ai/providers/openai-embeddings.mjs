// OpenAI embeddings provider.  Used by the recall stage to compute one
// profile vector + per-item vectors for cosine similarity.
//
// Single-batch call so we control the request shape end-to-end.  Caller is
// responsible for slicing the candidate pool down to TEMPO_EMBED_MAX_ITEMS
// before invoking — this provider does not chunk further.

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/embeddings";

export async function embedTextsWithOpenAI({ apiKey, model, texts, timeoutMs }) {
  if (!apiKey) throw new Error("embedTextsWithOpenAI: apiKey is required");
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const endpoint = process.env.TEMPO_OPENAI_EMBEDDINGS_URL || DEFAULT_ENDPOINT;
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
      body: JSON.stringify({ model, input: texts }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI embeddings API returned HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length !== texts.length) {
      throw new Error(`OpenAI embeddings returned ${rows.length} rows for ${texts.length} inputs`);
    }
    // Preserve input order using `index` when present (the API guarantees it).
    const out = new Array(texts.length);
    for (const row of rows) {
      const idx = typeof row?.index === "number" ? row.index : -1;
      if (idx < 0 || idx >= texts.length) {
        throw new Error("OpenAI embeddings returned out-of-range index");
      }
      out[idx] = row.embedding;
    }
    for (let i = 0; i < out.length; i++) {
      if (!Array.isArray(out[i]) || out[i].length === 0) {
        throw new Error(`OpenAI embeddings returned empty vector at index ${i}`);
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
