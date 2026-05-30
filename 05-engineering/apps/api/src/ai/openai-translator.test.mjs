import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import {
  createOpenAITranslateFn,
  resolveProductionTranslateFn,
  resolveTranslationModel,
  translateSegmentsWithOpenAI,
} from "./openai-translator.mjs";

// ── env isolation ─────────────────────────────────────────────────────────────
//
// These functions read env at call time. Snapshot the four vars they touch and
// restore them after each test so cases run in any order without bleed.
const ENV_KEYS = [
  "TEMPO_TRANSLATION_MODEL",
  "TEMPO_AI_MOCK_ONLY",
  "TEMPO_OPENAI_API_KEY",
  "OPENAI_API_KEY",
];

function withEnv(t) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Start each test from a clean slate so an inherited shell value can't leak.
  for (const k of ENV_KEYS) delete process.env[k];
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// Deterministic `fetch` stub. `respond` lets a test shape the HTTP response;
// the default echoes each input segment with an "EN:" prefix. Restores the real
// fetch (if any) on teardown so no global state leaks between tests.
function stubFetch(t, respond) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const inSegs = JSON.parse(body.messages[1].content).segments;
    calls.push({ url, opts, inSegs });
    if (typeof respond === "function") return respond({ inSegs, body, opts });
    const segments = inSegs.map((s) => `EN:${s}`);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ segments }) } }] }) };
  };
  t.after(() => {
    if (prev === undefined) delete globalThis.fetch;
    else globalThis.fetch = prev;
  });
  return calls;
}

// ── resolveTranslationModel ─────────────────────────────────────────────────

test("resolveTranslationModel: returns env override when set", (t) => {
  withEnv(t);
  process.env.TEMPO_TRANSLATION_MODEL = "gpt-4o-mini-custom";
  assert.equal(resolveTranslationModel(), "gpt-4o-mini-custom");
});

test("resolveTranslationModel: falls back to default when unset or blank", (t) => {
  withEnv(t);
  assert.equal(resolveTranslationModel(), "gpt-4o-mini");
  process.env.TEMPO_TRANSLATION_MODEL = "   ";
  assert.equal(resolveTranslationModel(), "gpt-4o-mini");
});

// ── resolveProductionTranslateFn ────────────────────────────────────────────

test("resolveProductionTranslateFn: null under TEMPO_AI_MOCK_ONLY=true (even with a key)", (t) => {
  withEnv(t);
  process.env.TEMPO_OPENAI_API_KEY = "sk-test";
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  assert.equal(resolveProductionTranslateFn(), null);
});

test("resolveProductionTranslateFn: null when no OpenAI key is configured", (t) => {
  withEnv(t);
  assert.equal(resolveProductionTranslateFn(), null);
});

test("resolveProductionTranslateFn: returns a function for TEMPO_OPENAI_API_KEY", (t) => {
  withEnv(t);
  process.env.TEMPO_OPENAI_API_KEY = "sk-tempo";
  assert.equal(typeof resolveProductionTranslateFn(), "function");
});

test("resolveProductionTranslateFn: returns a function for OPENAI_API_KEY fallback", (t) => {
  withEnv(t);
  process.env.OPENAI_API_KEY = "sk-openai";
  assert.equal(typeof resolveProductionTranslateFn(), "function");
});

// ── translateSegmentsWithOpenAI: slot fidelity ──────────────────────────────

test("translateSegmentsWithOpenAI: preserves slot count, order, and empty slots", async (t) => {
  stubFetch(t);
  const out = await translateSegmentsWithOpenAI({
    apiKey: "x",
    model: "gpt-4o-mini",
    segments: ["", "hola mundo", "migración"],
    sourceLang: "es",
    targetLang: "en",
  });
  assert.deepEqual(out, ["", "EN:hola mundo", "EN:migración"]);
});

test("translateSegmentsWithOpenAI: all-empty input short-circuits with no network call", async (t) => {
  const calls = stubFetch(t);
  const out = await translateSegmentsWithOpenAI({ apiKey: "x", segments: ["", "   "] });
  assert.deepEqual(out, ["", "   "]);
  assert.equal(calls.length, 0, "must not hit the network when there is nothing to translate");
});

test("translateSegmentsWithOpenAI: blank translated slot falls back to the original text", async (t) => {
  // Model returns a blank for the second slot — we keep the original (Spanish
  // passthrough) rather than dropping the slot.
  stubFetch(t, ({ inSegs }) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ segments: inSegs.map((s, i) => (i === 1 ? "  " : `EN:${s}`)) }) } }],
    }),
  }));
  const out = await translateSegmentsWithOpenAI({
    apiKey: "x",
    segments: ["Titular", "se mantiene", "tercero"],
  });
  assert.deepEqual(out, ["EN:Titular", "se mantiene", "EN:tercero"]);
});

// ── translateSegmentsWithOpenAI: error surfaces (fail-open is the caller's job) ─

test("translateSegmentsWithOpenAI: throws on non-2xx HTTP (caller fails open)", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 503, json: async () => ({}) }));
  await assert.rejects(
    () => translateSegmentsWithOpenAI({ apiKey: "x", segments: ["hola"] }),
    /HTTP 503/
  );
});

test("translateSegmentsWithOpenAI: throws on segment-count mismatch", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ segments: ["only-one"] }) } }] }),
  }));
  await assert.rejects(
    () => translateSegmentsWithOpenAI({ apiKey: "x", segments: ["uno", "dos"] }),
    /expected 2 segments/
  );
});

test("translateSegmentsWithOpenAI: throws when completion is not valid JSON", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "not json" } }] }),
  }));
  await assert.rejects(
    () => translateSegmentsWithOpenAI({ apiKey: "x", segments: ["hola"] }),
    /not valid JSON/
  );
});

test("translateSegmentsWithOpenAI: throws when apiKey is missing", async (t) => {
  stubFetch(t);
  await assert.rejects(
    () => translateSegmentsWithOpenAI({ segments: ["hola"] }),
    /missing apiKey/
  );
});

// ── abort / timeout hygiene ───────────────────────────────────────────────────

test("translateSegmentsWithOpenAI: removes its abort listener after a successful call (no leak)", async (t) => {
  stubFetch(t);
  const controller = new AbortController();
  await translateSegmentsWithOpenAI({ apiKey: "x", segments: ["hola"], signal: controller.signal });
  assert.equal(
    getEventListeners(controller.signal, "abort").length,
    0,
    "the abort listener must be detached in the finally block"
  );
});

test("translateSegmentsWithOpenAI: an already-aborted signal aborts the request deterministically", async (t) => {
  // Stub honors the propagated AbortSignal: when the caller's signal is already
  // aborted, the request controller aborts and fetch rejects (real fetch
  // behavior). The fn surfaces that as a throw; no listener is left behind.
  stubFetch(t, ({ opts }) => {
    if (opts.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ segments: ["EN:hola"] }) } }] }) };
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => translateSegmentsWithOpenAI({ apiKey: "x", segments: ["hola"], signal: controller.signal }),
    /abort/i
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

// ── createOpenAITranslateFn (the seam the server wires) ──────────────────────

test("createOpenAITranslateFn: returns a translateFn matching the evidence-translator contract", async (t) => {
  stubFetch(t);
  const translateFn = createOpenAITranslateFn({ apiKey: "x", model: "gpt-4o-mini" });
  assert.equal(typeof translateFn, "function");
  const out = await translateFn(["hola", "mundo"], { sourceLang: "es", targetLang: "en", sourceId: "s1" });
  assert.deepEqual(out, ["EN:hola", "EN:mundo"]);
});
