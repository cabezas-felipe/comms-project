// Embeddings router.  Single capability for now (text-embedding-3-small via
// OpenAI).  Encapsulates env reads, timeout, retries, and a minimal mock so
// callers can stay agnostic of the underlying provider.
//
// The recall stage is the only consumer.  When TEMPO_AI_MOCK_ONLY=true the
// router returns deterministic hash-derived vectors so mock-only test runs and
// dev environments without a key still produce stable output (cosine values
// are not meaningful in this mode — strictly for plumbing).
//
// Retry policy: one bounded retry on transient errors (timeout / abort / 5xx
// HTTP).  4xx and "missing key" errors are not retried — those are
// configuration faults, not transient.  Exhausting the retry rethrows; the
// recall stage's catch block then triggers fail-closed behavior.

import { createHash } from "node:crypto";
import { embedTextsWithOpenAI } from "./providers/openai-embeddings.mjs";

const MOCK_DIMENSIONS = 32;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ATTEMPTS = 2; // 1 initial + 1 retry
const DEFAULT_RETRY_DELAY_MS = 250;

function mockEmbedding(text) {
  const vec = new Array(MOCK_DIMENSIONS).fill(0);
  const digest = createHash("sha256").update(String(text ?? "")).digest();
  for (let i = 0; i < MOCK_DIMENSIONS; i++) {
    // Map bytes [0..255] → roughly [-1, 1]; deterministic per input text.
    vec[i] = (digest[i % digest.length] - 128) / 128;
  }
  return vec;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err) {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // AbortController-driven timeouts surface as "aborted"/"timed out".
  if (msg.includes("timed out") || msg.includes("abort")) return true;
  // OpenAI provider wraps non-2xx responses as `HTTP <status>: ...`.
  // Treat 5xx as transient; let 4xx (auth, validation) fall straight through.
  const m = msg.match(/http (\d{3})/);
  if (m) {
    const status = Number(m[1]);
    if (status === 429 || (status >= 500 && status < 600)) return true;
  }
  return false;
}

/**
 * Embed a batch of texts.  Throws on error / timeout — the recall stage's
 * fail-closed branch is responsible for catching and emitting an empty
 * candidate set with `degraded_reason`.
 *
 * Configurable via env (all optional):
 *   TEMPO_OPENAI_EMBEDDING_MODEL   default: text-embedding-3-small
 *   TEMPO_EMBED_TIMEOUT_MS         default: 8000
 *   TEMPO_EMBED_MAX_ATTEMPTS       default: 2 (1 + 1 retry)
 *   TEMPO_EMBED_RETRY_DELAY_MS     default: 250
 */
export async function embedTexts(texts) {
  const arr = Array.isArray(texts) ? texts : [];
  if (arr.length === 0) return [];

  if (process.env.TEMPO_AI_MOCK_ONLY === "true") {
    return arr.map(mockEmbedding);
  }

  const apiKey = process.env.TEMPO_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("TEMPO_OPENAI_API_KEY (or OPENAI_API_KEY) required for embeddings");
  }
  const model = process.env.TEMPO_OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const timeoutMs = Number(process.env.TEMPO_EMBED_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.max(
    1,
    Number(process.env.TEMPO_EMBED_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS)
  );
  const retryDelayMs = Math.max(
    0,
    Number(process.env.TEMPO_EMBED_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS)
  );

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await embedTextsWithOpenAI({ apiKey, model, texts: arr, timeoutMs });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isTransientError(err)) {
        console.warn(
          `[embeddings] transient error on attempt ${attempt}/${maxAttempts} (${err instanceof Error ? err.message : err}); retrying in ${retryDelayMs}ms`
        );
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop always either returns or throws.  Keep an explicit
  // throw for type-safety in case the loop body ever changes shape.
  throw lastErr;
}
