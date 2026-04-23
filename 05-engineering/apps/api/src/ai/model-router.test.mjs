import assert from "node:assert/strict";
import test from "node:test";
import { getAiCapabilityMap, getAiMetrics, summarizeCluster } from "./model-router.mjs";
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
