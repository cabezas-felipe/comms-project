// Production ES→EN evidence translator (Phase 4 Pre-slice S0).
//
// Why this module exists:
//   `translateEvidenceItems` (ingestion/evidence-translator.mjs) is provider-
//   agnostic: it takes an injected `translateFn(segments, { sourceLang,
//   targetLang, sourceId }) => Promise<string[]>` and stays bounded + fail-open
//   around whatever that function does. Tests inject a deterministic stub. This
//   module is the PRODUCTION implementation of that seam — a thin OpenAI
//   chat-completions wrapper that translates a small batch of short evidence
//   segments (headline + ≤2 snippets) to English.
//
// Design constraints (locked Phase 4 S0 decisions):
//   - Provider/model: OpenAI small/cheap model (default gpt-4o-mini), reusing
//     the existing `TEMPO_OPENAI_API_KEY` / `TEMPO_OPENAI_BASE_URL` plumbing.
//   - Fail-open: this fn may throw (bad key, HTTP error, malformed JSON,
//     timeout); the caller catches every throw and passes the item through
//     untranslated. We never swallow errors here — we let them propagate so the
//     caller's fail-open accounting (failed/timeout counts, diagnostics) stays
//     honest.
//   - Slot fidelity: the caller requires `translated.length === segments.length`
//     (segment[0] is the headline slot, which may be ""). We translate only the
//     non-empty slots and reassemble in original order so the count is exact.

const DEFAULT_TRANSLATION_MODEL = "gpt-4o-mini";
// Self-contained fetch timeout. The caller (`translateEvidenceItems`) already
// races the whole call against `config.timeoutMs` via `withTimeout`, but that
// race does not cancel the in-flight fetch — so we bound the socket here too
// (mirrors the Whisper / openai-compatible providers) to avoid leaked requests.
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Translation model SKU, read from env at call time so a swap is an env flip
 * (no redeploy). Small/cheap default suited to short ES→EN evidence segments.
 */
export function resolveTranslationModel() {
  const raw = (process.env.TEMPO_TRANSLATION_MODEL ?? "").trim();
  return raw || DEFAULT_TRANSLATION_MODEL;
}

/**
 * Translate an ordered segment list to English via OpenAI chat completions.
 *
 * Returns a NEW array the SAME length as `segments`, in the same order. Empty/
 * whitespace-only slots (e.g. a missing headline) are preserved as "" and never
 * sent to the model. Throws on transport / parse / shape errors so the caller's
 * fail-open path records the failure — it does NOT silently return originals.
 */
export async function translateSegmentsWithOpenAI({
  apiKey,
  model,
  baseURL,
  segments,
  sourceLang = "es",
  targetLang = "en",
  sourceId,
  timeoutMs,
  signal,
} = {}) {
  if (!apiKey) throw new Error("openai-translator: missing apiKey");
  const list = Array.isArray(segments) ? segments.map((s) => String(s ?? "")) : [];

  // Only translate non-empty slots; reassemble into the original positions so
  // the returned length matches the input exactly (the caller throws otherwise).
  const sourceIdx = [];
  const toTranslate = [];
  list.forEach((s, i) => {
    if (s.trim()) {
      sourceIdx.push(i);
      toTranslate.push(s);
    }
  });
  if (toTranslate.length === 0) return list;

  const endpointBase = (baseURL || process.env.TEMPO_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const endpoint = `${endpointBase}/chat/completions`;
  const effectiveTimeout = parsePositiveInt(timeoutMs, DEFAULT_FETCH_TIMEOUT_MS);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: model || resolveTranslationModel(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a translation engine for short news-evidence segments. " +
              `Translate every input segment from ${sourceLang} to ${targetLang}. ` +
              "Preserve meaning, named entities, numbers, dates, and the original order. " +
              'Respond with ONLY a JSON object of the form {"segments": string[]} whose ' +
              "array has EXACTLY the same number of items as the input, in the same order. " +
              "Do not add, merge, split, reorder, or omit segments. No commentary.",
          },
          {
            role: "user",
            content: JSON.stringify({ sourceLang, targetLang, segments: toTranslate }),
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`openai-translator: API returned HTTP ${response.status} (sourceId=${sourceId ?? "?"})`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("openai-translator: empty completion content");
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("openai-translator: completion was not valid JSON");
    }
    const translated = parsed?.segments;
    if (!Array.isArray(translated) || translated.length !== toTranslate.length) {
      throw new Error(
        `openai-translator: expected ${toTranslate.length} segments, got ${Array.isArray(translated) ? translated.length : "non-array"}`
      );
    }
    // Reassemble: translated text lands back in its original slot; empty slots
    // stay "". Fall back to the original segment if the model returned a blank
    // for a non-empty input (better a Spanish passthrough than a dropped slot).
    const out = [...list];
    sourceIdx.forEach((origIdx, k) => {
      const t = String(translated[k] ?? "").trim();
      out[origIdx] = t || list[origIdx];
    });
    return out;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Build a `translateFn` matching the `translateEvidenceItems` contract from a
 * fixed apiKey/model. Used by the server to wire production translation.
 */
export function createOpenAITranslateFn({ apiKey, model, baseURL } = {}) {
  return function translateFn(segments, { sourceLang, targetLang, sourceId } = {}) {
    return translateSegmentsWithOpenAI({ apiKey, model, baseURL, segments, sourceLang, targetLang, sourceId });
  };
}

/**
 * Resolve the production `translateFn` from env, or `null` when translation
 * cannot run for real. Returning `null` keeps the translation stage a no-op
 * pass-through (the caller treats a missing fn exactly like the stage being
 * disabled) — so a mock-only box or a missing key behaves like translation-off
 * rather than failing a refresh. Reads env at call time.
 *
 * Null when:
 *   - `TEMPO_AI_MOCK_ONLY=true` (CI / cost-control: never hit a live provider)
 *   - no `TEMPO_OPENAI_API_KEY` / `OPENAI_API_KEY` configured
 *
 * NOTE: this does NOT read `TEMPO_TRANSLATION_ENABLED` — the enable flag is the
 * stage's own gate (`resolveTranslationConfig`). Even with a real fn wired, the
 * stage stays a no-op until the flag is on, so production can ship this fn dark
 * and flip the flag preview-first.
 */
export function resolveProductionTranslateFn() {
  if (String(process.env.TEMPO_AI_MOCK_ONLY ?? "").trim().toLowerCase() === "true") {
    return null;
  }
  const apiKey = process.env.TEMPO_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return createOpenAITranslateFn({ apiKey, model: resolveTranslationModel() });
}
