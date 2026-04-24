import assert from "node:assert/strict";
import test from "node:test";
import {
  getAiCapabilityMap,
  getAiMetrics,
  summarizeCluster,
  providerFor,
  assertAiConfig,
} from "./model-router.mjs";
import { withTimeout, heuristicSummary } from "./guardrails.mjs";

const SAMPLE_CLUSTER = {
  id: "c1",
  title: "Sample cluster",
  geographies: ["US"],
  topic: "Diplomatic relations",
  priority: "top",
  sources: [
    { outlet: "Reuters", minutesAgo: 12, weight: 90 },
    { outlet: "NYT", minutesAgo: 30, weight: 80 },
  ],
};

// ── Existing capability/summary tests ────────────────────────────────────────

test("capability map exposes model assignments", () => {
  const map = getAiCapabilityMap();
  assert.ok(map.summarization);
  assert.ok(map.classification);
  assert.ok(map.safety);
});

test("summarizeCluster returns summary and metadata", async () => {
  const result = await summarizeCluster(SAMPLE_CLUSTER);
  assert.equal(typeof result.summary, "string");
  assert.ok(result.summary.length > 0);
  assert.equal(result.meta.capability, "summarization");
  assert.equal(typeof result.meta.costUsd, "number");
  assert.equal(result.meta.promptVersion, "summary-v1");
});

test("summarization metrics increment", async () => {
  const before = getAiMetrics();
  await summarizeCluster(SAMPLE_CLUSTER);
  const after = getAiMetrics();
  assert.ok(after.summarizationRequests >= before.summarizationRequests + 1);
});

test("summarizeCluster meta contains all expected fields on success path", async () => {
  const { meta } = await summarizeCluster(SAMPLE_CLUSTER);
  assert.equal(typeof meta.capability, "string");
  assert.equal(typeof meta.model, "string");
  assert.equal(typeof meta.provider, "string");
  assert.equal(typeof meta.elapsedMs, "number");
  assert.equal(typeof meta.timedOut, "boolean");
  assert.equal(typeof meta.fallbackUsed, "boolean");
  assert.equal(typeof meta.promptTokens, "number");
  assert.equal(typeof meta.outputTokens, "number");
  assert.equal(typeof meta.costUsd, "number");
  assert.equal(typeof meta.promptVersion, "string");
  assert.equal(meta.timedOut, false);
  assert.equal(meta.fallbackUsed, false);
});

test("withTimeout resolves when promise completes before deadline", async () => {
  const result = await withTimeout(() => Promise.resolve("ok"), 1000, "timed out");
  assert.equal(result, "ok");
});

test("withTimeout rejects with timeout message when deadline is exceeded", async () => {
  const neverResolves = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(() => neverResolves, 10, "AI summarization timed out"),
    { message: "AI summarization timed out" }
  );
});

test("heuristicSummary returns non-empty string that includes cluster title", () => {
  const summary = heuristicSummary(SAMPLE_CLUSTER);
  assert.equal(typeof summary, "string");
  assert.ok(summary.length > 0);
  assert.ok(summary.includes(SAMPLE_CLUSTER.title));
});

test("getAiMetrics returns an isolated snapshot, not a live reference", () => {
  const snap = getAiMetrics();
  snap.summarizationRequests = 99999;
  const check = getAiMetrics();
  assert.notEqual(check.summarizationRequests, 99999);
});

// ── Provider routing ──────────────────────────────────────────────────────────

test("providerFor routes mock-openai-mini to mock-openai", () => {
  assert.equal(providerFor("mock-openai-mini"), "mock-openai");
});

test("providerFor routes mock-anthropic-haiku to mock-anthropic", () => {
  assert.equal(providerFor("mock-anthropic-haiku"), "mock-anthropic");
});

test("providerFor routes anthropic:<model> to anthropic", () => {
  assert.equal(providerFor("anthropic:claude-haiku-4-5-20251001"), "anthropic");
  assert.equal(providerFor("anthropic:claude-sonnet-4-6"), "anthropic");
});

test("providerFor routes openai:<model> to openai-compatible", () => {
  assert.equal(providerFor("openai:gpt-4o-mini"), "openai-compatible");
});

test("providerFor defaults unknown models to mock-openai", () => {
  assert.equal(providerFor("unknown-model"), "mock-openai");
});

// ── TEMPO_AI_MOCK_ONLY flag ───────────────────────────────────────────────────

test("TEMPO_AI_MOCK_ONLY=true routes anthropic: model to mock-openai", () => {
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  try {
    assert.equal(providerFor("anthropic:claude-haiku-4-5-20251001"), "mock-openai");
  } finally {
    delete process.env.TEMPO_AI_MOCK_ONLY;
  }
});

test("TEMPO_AI_MOCK_ONLY=true routes openai: model to mock-openai", () => {
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  try {
    assert.equal(providerFor("openai:gpt-4o-mini"), "mock-openai");
  } finally {
    delete process.env.TEMPO_AI_MOCK_ONLY;
  }
});

// ── assertAiConfig validation ─────────────────────────────────────────────────

test("assertAiConfig does not throw for mock-only capability map", () => {
  assert.doesNotThrow(() =>
    assertAiConfig({ summarization: "mock-openai-mini", classification: "mock-anthropic-haiku" })
  );
});

test("assertAiConfig throws when anthropic: model has no API key", () => {
  const saved = {
    TEMPO_ANTHROPIC_API_KEY: process.env.TEMPO_ANTHROPIC_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(
      () => assertAiConfig({ summarization: "anthropic:claude-haiku-4-5-20251001" }),
      /TEMPO_ANTHROPIC_API_KEY/
    );
  } finally {
    if (saved.TEMPO_ANTHROPIC_API_KEY) process.env.TEMPO_ANTHROPIC_API_KEY = saved.TEMPO_ANTHROPIC_API_KEY;
    if (saved.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
  }
});

test("assertAiConfig throws when openai: model has no TEMPO_OPENAI_API_KEY", () => {
  const saved = process.env.TEMPO_OPENAI_API_KEY;
  delete process.env.TEMPO_OPENAI_API_KEY;
  try {
    assert.throws(
      () => assertAiConfig({ summarization: "openai:gpt-4o-mini" }),
      /TEMPO_OPENAI_API_KEY/
    );
  } finally {
    if (saved) process.env.TEMPO_OPENAI_API_KEY = saved;
  }
});

// ── Fallback path coverage (closes Slice 10 gap) ──────────────────────────────

test("summarizeCluster falls back to heuristic when anthropic key is missing", async () => {
  const savedModel = process.env.TEMPO_AI_SUMMARY_MODEL;
  const savedKey1 = process.env.TEMPO_ANTHROPIC_API_KEY;
  const savedKey2 = process.env.ANTHROPIC_API_KEY;
  process.env.TEMPO_AI_SUMMARY_MODEL = "anthropic:claude-haiku-4-5-20251001";
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await summarizeCluster(SAMPLE_CLUSTER);
    assert.equal(result.meta.fallbackUsed, true);
    assert.equal(result.meta.timedOut, false);
    assert.ok(result.summary.includes(SAMPLE_CLUSTER.title));
  } finally {
    if (savedModel !== undefined) process.env.TEMPO_AI_SUMMARY_MODEL = savedModel;
    else delete process.env.TEMPO_AI_SUMMARY_MODEL;
    if (savedKey1) process.env.TEMPO_ANTHROPIC_API_KEY = savedKey1;
    if (savedKey2) process.env.ANTHROPIC_API_KEY = savedKey2;
  }
});

test("provider error increments providerErrors and summarizationFallbacks", async () => {
  const savedModel = process.env.TEMPO_AI_SUMMARY_MODEL;
  const savedKey1 = process.env.TEMPO_ANTHROPIC_API_KEY;
  const savedKey2 = process.env.ANTHROPIC_API_KEY;
  process.env.TEMPO_AI_SUMMARY_MODEL = "anthropic:claude-haiku-4-5-20251001";
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const before = getAiMetrics();
  try {
    await summarizeCluster(SAMPLE_CLUSTER);
    const after = getAiMetrics();
    assert.ok(after.providerErrors >= before.providerErrors + 1);
    assert.ok(after.summarizationFallbacks >= before.summarizationFallbacks + 1);
  } finally {
    if (savedModel !== undefined) process.env.TEMPO_AI_SUMMARY_MODEL = savedModel;
    else delete process.env.TEMPO_AI_SUMMARY_MODEL;
    if (savedKey1) process.env.TEMPO_ANTHROPIC_API_KEY = savedKey1;
    if (savedKey2) process.env.ANTHROPIC_API_KEY = savedKey2;
  }
});
