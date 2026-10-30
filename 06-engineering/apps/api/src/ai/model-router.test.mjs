import assert from "node:assert/strict";
import test, { beforeEach, afterEach, describe } from "node:test";
import {
  getAiCapabilityMap,
  getAiMetrics,
  summarizeCluster,
  providerFor,
  assertAiConfig,
  resolveExtractionChain,
  getProviderReadiness,
  assertReadyForRealRun,
  isDcValidationModeEnabled,
  CRITICAL_REAL_RUN_CAPABILITIES,
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

// Capture the AI-routing env as inherited at load (a developer .env or CI can
// export TEMPO_AI_SUMMARY_MODEL=anthropic:... / TEMPO_AI_MOCK_ONLY, which would
// route summarizeCluster onto a real provider and flip the success-path
// `fallbackUsed` assertions).  A describe-scoped beforeEach clears these to the
// shipped mock defaults before every test, and afterEach restores the captured
// values (delete-when-undefined) so nothing leaks to sibling files in a
// single-process full-suite run.  Tests that exercise real-provider routing set
// these vars explicitly inside their own body on top of the cleared baseline.
const _ROUTER_ENV0 = {
  TEMPO_AI_SUMMARY_MODEL: process.env.TEMPO_AI_SUMMARY_MODEL,
  TEMPO_AI_MOCK_ONLY: process.env.TEMPO_AI_MOCK_ONLY,
};

// ── Existing capability/summary tests ────────────────────────────────────────

describe("model-router", () => {
  beforeEach(() => {
    delete process.env.TEMPO_AI_SUMMARY_MODEL;
    delete process.env.TEMPO_AI_MOCK_ONLY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(_ROUTER_ENV0)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

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

// ── R2 readiness + DC-validation guard ──────────────────────────────────────
// Reset env vars that bleed in from the host shell / .env so these tests run
// from a known-clean baseline.  We restore the captured values in finally.

const READINESS_ENV_VARS = [
  "TEMPO_AI_CLUSTER_MODEL",
  "TEMPO_AI_GEO_ASSESS_MODEL",
  "TEMPO_OPENAI_EMBEDDING_MODEL",
  "TEMPO_AI_MOCK_ONLY",
  "TEMPO_DC_VALIDATION_MODE",
  "TEMPO_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "TEMPO_OPENAI_API_KEY",
  "OPENAI_API_KEY",
];

function snapshotEnv() {
  const out = {};
  for (const k of READINESS_ENV_VARS) out[k] = process.env[k];
  return out;
}

function clearEnv() {
  for (const k of READINESS_ENV_VARS) delete process.env[k];
}

function restoreEnv(snap) {
  for (const k of READINESS_ENV_VARS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

test("getProviderReadiness: real Anthropic + OpenAI keys present → readyForRealRun=true", () => {
  const saved = snapshotEnv();
  clearEnv();
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.TEMPO_ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test";
  try {
    const r = getProviderReadiness();
    assert.equal(r.readyForRealRun, true, JSON.stringify(r));
    assert.equal(r.mockOnly, false);
    assert.equal(r.capabilities.clustering.provider, "anthropic");
    assert.equal(r.capabilities.clustering.mock, false);
    assert.equal(r.capabilities.clustering.keyPresent, true);
    assert.equal(r.capabilities.clustering.ready, true);
    assert.equal(r.capabilities.geoAssess.provider, "anthropic");
    assert.equal(r.capabilities.geoAssess.ready, true);
    assert.equal(r.capabilities.embedding.provider, "openai-embedding");
    assert.equal(r.capabilities.embedding.ready, true);
    assert.deepEqual(r.missingKeys, []);
  } finally {
    restoreEnv(saved);
  }
});

test("getProviderReadiness: real Anthropic with missing key → not ready, missingKeys lists var", () => {
  const saved = snapshotEnv();
  clearEnv();
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test";
  // Intentionally no TEMPO_ANTHROPIC_API_KEY
  try {
    const r = getProviderReadiness();
    assert.equal(r.readyForRealRun, false);
    assert.equal(r.capabilities.clustering.ready, false);
    assert.equal(r.capabilities.clustering.keyPresent, false);
    assert.equal(r.capabilities.geoAssess.ready, false);
    assert.equal(r.capabilities.embedding.ready, true);
    assert.ok(r.missingKeys.includes("TEMPO_ANTHROPIC_API_KEY"));
  } finally {
    restoreEnv(saved);
  }
});

test("getProviderReadiness: TEMPO_AI_MOCK_ONLY=true → all capabilities mock and not ready", () => {
  const saved = snapshotEnv();
  clearEnv();
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test";
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  try {
    const r = getProviderReadiness();
    assert.equal(r.readyForRealRun, false);
    assert.equal(r.mockOnly, true);
    // clustering + geoAssess: mocked via providerFor(); embedding: explicit mock branch.
    assert.equal(r.capabilities.clustering.mock, true);
    assert.equal(r.capabilities.geoAssess.mock, true);
    assert.equal(r.capabilities.embedding.mock, true);
    assert.equal(r.capabilities.embedding.provider, "mock-openai-embedding");
    // missingKeys is empty because mocked routes don't require keys.
    assert.deepEqual(r.missingKeys, []);
  } finally {
    restoreEnv(saved);
  }
});

test("getProviderReadiness: defaults (no env) → clustering+geoAssess mock, embedding missing key", () => {
  const saved = snapshotEnv();
  clearEnv();
  try {
    const r = getProviderReadiness();
    assert.equal(r.readyForRealRun, false);
    assert.equal(r.capabilities.clustering.mock, true);
    assert.equal(r.capabilities.geoAssess.provider, "anthropic"); // default SKU is anthropic Haiku
    assert.equal(r.capabilities.geoAssess.keyPresent, false);
    assert.equal(r.capabilities.embedding.provider, "openai-embedding");
    assert.equal(r.capabilities.embedding.keyPresent, false);
    assert.ok(r.missingKeys.includes("TEMPO_ANTHROPIC_API_KEY"));
    assert.ok(r.missingKeys.includes("TEMPO_OPENAI_API_KEY"));
  } finally {
    restoreEnv(saved);
  }
});

test("CRITICAL_REAL_RUN_CAPABILITIES lists clustering, geoAssess, embedding", () => {
  assert.deepEqual([...CRITICAL_REAL_RUN_CAPABILITIES], ["clustering", "geoAssess", "embedding"]);
});

test("isDcValidationModeEnabled reads TEMPO_DC_VALIDATION_MODE at call time", () => {
  const saved = snapshotEnv();
  clearEnv();
  try {
    assert.equal(isDcValidationModeEnabled(), false);
    process.env.TEMPO_DC_VALIDATION_MODE = "true";
    assert.equal(isDcValidationModeEnabled(), true);
    process.env.TEMPO_DC_VALIDATION_MODE = "false";
    assert.equal(isDcValidationModeEnabled(), false);
  } finally {
    restoreEnv(saved);
  }
});

test("assertReadyForRealRun: no-op when validation mode is off (returns readiness)", () => {
  const saved = snapshotEnv();
  clearEnv();
  // Mock-only, but validation mode is OFF → must not throw.
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  try {
    const r = assertReadyForRealRun();
    assert.equal(r.readyForRealRun, false);
    assert.equal(r.mockOnly, true);
  } finally {
    restoreEnv(saved);
  }
});

test("assertReadyForRealRun: validation mode + mock-only → throws DC_VALIDATION_NOT_READY", () => {
  const saved = snapshotEnv();
  clearEnv();
  process.env.TEMPO_DC_VALIDATION_MODE = "true";
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  let caught;
  try {
    try { assertReadyForRealRun(); } catch (e) { caught = e; }
    assert.ok(caught instanceof Error, "must throw");
    assert.equal(caught.code, "DC_VALIDATION_NOT_READY");
    assert.ok(Array.isArray(caught.reasons) && caught.reasons.length > 0);
    assert.ok(caught.readiness && caught.readiness.readyForRealRun === false);
    assert.match(caught.message, /providers not ready/i);
  } finally {
    restoreEnv(saved);
  }
});

test("assertReadyForRealRun: validation mode + missing anthropic key → throws with missing-key reason", () => {
  const saved = snapshotEnv();
  clearEnv();
  process.env.TEMPO_DC_VALIDATION_MODE = "true";
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test"; // embedding ready
  // Intentionally no TEMPO_ANTHROPIC_API_KEY
  let caught;
  try {
    try { assertReadyForRealRun(); } catch (e) { caught = e; }
    assert.ok(caught instanceof Error, "must throw");
    assert.equal(caught.code, "DC_VALIDATION_NOT_READY");
    assert.ok(caught.reasons.some((r) => r.includes("missing-key")));
    assert.ok(caught.readiness.missingKeys.includes("TEMPO_ANTHROPIC_API_KEY"));
  } finally {
    restoreEnv(saved);
  }
});

test("assertReadyForRealRun: validation mode + all real + keys present → returns readiness", () => {
  const saved = snapshotEnv();
  clearEnv();
  process.env.TEMPO_DC_VALIDATION_MODE = "true";
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test";
  try {
    const r = assertReadyForRealRun();
    assert.equal(r.readyForRealRun, true);
  } finally {
    restoreEnv(saved);
  }
});

});
