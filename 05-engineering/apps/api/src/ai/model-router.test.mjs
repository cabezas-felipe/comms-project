import assert from "node:assert/strict";
import test from "node:test";
import {
  getAiCapabilityMap,
  getAiMetrics,
  summarizeCluster,
  providerFor,
  assertAiConfig,
  resolveExtractionChain,
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

// ── M2: clustering SKU env wiring (N2) ───────────────────────────────────────
//
// Locks the refresh-path contract: the capability map exposes
// `clustering` from `TEMPO_AI_CLUSTER_MODEL` at call time, so flipping the
// env to the N2 production SKU (anthropic:claude-sonnet-4-6) is sufficient
// to take the real Anthropic provider path on refresh.  No code redeploy
// needed; CI/test-mode safety (TEMPO_AI_MOCK_ONLY=true) still wins.

test("capability map clustering defaults to mock-anthropic-haiku when env unset (CI safety)", () => {
  const prev = process.env.TEMPO_AI_CLUSTER_MODEL;
  delete process.env.TEMPO_AI_CLUSTER_MODEL;
  try {
    assert.equal(getAiCapabilityMap().clustering, "mock-anthropic-haiku");
  } finally {
    if (prev !== undefined) process.env.TEMPO_AI_CLUSTER_MODEL = prev;
  }
});

test("capability map clustering reads TEMPO_AI_CLUSTER_MODEL at call time (N2 Sonnet)", () => {
  const prev = process.env.TEMPO_AI_CLUSTER_MODEL;
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  try {
    assert.equal(getAiCapabilityMap().clustering, "anthropic:claude-sonnet-4-6");
    assert.equal(providerFor(getAiCapabilityMap().clustering), "anthropic");
  } finally {
    if (prev !== undefined) process.env.TEMPO_AI_CLUSTER_MODEL = prev;
    else delete process.env.TEMPO_AI_CLUSTER_MODEL;
  }
});

test("TEMPO_AI_MOCK_ONLY=true forces mock for Sonnet clustering env (CI safety)", () => {
  const prevModel = process.env.TEMPO_AI_CLUSTER_MODEL;
  const prevMock = process.env.TEMPO_AI_MOCK_ONLY;
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  try {
    assert.equal(getAiCapabilityMap().clustering, "anthropic:claude-sonnet-4-6");
    assert.notEqual(providerFor(getAiCapabilityMap().clustering), "anthropic");
  } finally {
    if (prevModel !== undefined) process.env.TEMPO_AI_CLUSTER_MODEL = prevModel;
    else delete process.env.TEMPO_AI_CLUSTER_MODEL;
    if (prevMock !== undefined) process.env.TEMPO_AI_MOCK_ONLY = prevMock;
    else delete process.env.TEMPO_AI_MOCK_ONLY;
  }
});

// ── resolveExtractionChain ──────────────────────────────────────────────────

test("resolveExtractionChain returns shipping defaults when env is unset", () => {
  const prevPrimary = process.env.TEMPO_AI_CLASSIFIER_MODEL;
  const prevFallback = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  delete process.env.TEMPO_AI_CLASSIFIER_MODEL;
  delete process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  try {
    const chain = resolveExtractionChain();
    assert.equal(chain.primary, "anthropic:claude-opus-4-7");
    assert.equal(chain.fallback, "anthropic:claude-sonnet-4-6");
  } finally {
    if (prevPrimary !== undefined) process.env.TEMPO_AI_CLASSIFIER_MODEL = prevPrimary;
    if (prevFallback !== undefined) process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = prevFallback;
  }
});

test("resolveExtractionChain reads TEMPO_AI_CLASSIFIER_MODEL + TEMPO_AI_CLASSIFIER_FALLBACK_MODEL", () => {
  const prevPrimary = process.env.TEMPO_AI_CLASSIFIER_MODEL;
  const prevFallback = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  process.env.TEMPO_AI_CLASSIFIER_MODEL = "anthropic:custom-primary";
  process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = "anthropic:custom-fallback";
  try {
    const chain = resolveExtractionChain();
    assert.equal(chain.primary, "anthropic:custom-primary");
    assert.equal(chain.fallback, "anthropic:custom-fallback");
  } finally {
    if (prevPrimary !== undefined) process.env.TEMPO_AI_CLASSIFIER_MODEL = prevPrimary;
    else delete process.env.TEMPO_AI_CLASSIFIER_MODEL;
    if (prevFallback !== undefined) process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = prevFallback;
    else delete process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  }
});

test("resolveExtractionChain falls back to defaults on whitespace/empty env", () => {
  const prevPrimary = process.env.TEMPO_AI_CLASSIFIER_MODEL;
  const prevFallback = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  process.env.TEMPO_AI_CLASSIFIER_MODEL = "   ";
  process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = "";
  try {
    const chain = resolveExtractionChain();
    assert.equal(chain.primary, "anthropic:claude-opus-4-7");
    assert.equal(chain.fallback, "anthropic:claude-sonnet-4-6");
  } finally {
    if (prevPrimary !== undefined) process.env.TEMPO_AI_CLASSIFIER_MODEL = prevPrimary;
    else delete process.env.TEMPO_AI_CLASSIFIER_MODEL;
    if (prevFallback !== undefined) process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = prevFallback;
    else delete process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  }
});
