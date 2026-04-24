import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSourceItem, normalizeSourceItems } from "./source-normalizer.mjs";

const MINIMAL_VALID = {
  clusterId: "test-cluster",
  sourceId: "test-src-1",
  outlet: "Reuters",
  kind: "traditional",
  weight: 88,
  url: "https://example.com/article",
  minutesAgo: 30,
  headline: "Test Headline",
  body: ["First paragraph", "Second paragraph"],
};

test("normalizeSourceItem returns canonical shape from a fully specified item", () => {
  const raw = {
    ...MINIMAL_VALID,
    title: "Test Cluster Title",
    topic: "Diplomatic relations",
    geographies: ["US", "Colombia"],
    priority: "top",
    takeaway: "Key takeaway",
    summary: "Short summary",
    whyItMatters: "Explanation",
    whatChanged: "What shifted",
    byline: "By Test Author",
  };
  const item = normalizeSourceItem(raw);
  assert.equal(item.clusterId, "test-cluster");
  assert.equal(item.title, "Test Cluster Title");
  assert.equal(item.topic, "Diplomatic relations");
  assert.deepEqual(item.geographies, ["US", "Colombia"]);
  assert.equal(item.priority, "top");
  assert.equal(item.outlet, "Reuters");
  assert.equal(item.kind, "traditional");
  assert.equal(item.weight, 88);
  assert.equal(item.url, "https://example.com/article");
  assert.equal(item.minutesAgo, 30);
  assert.equal(item.headline, "Test Headline");
  assert.deepEqual(item.body, ["First paragraph", "Second paragraph"]);
  assert.equal(item.byline, "By Test Author");
});

test("normalizeSourceItem defaults optional fields when absent", () => {
  const item = normalizeSourceItem(MINIMAL_VALID);
  assert.equal(item.title, "test-cluster", "title defaults to clusterId");
  assert.equal(item.topic, "");
  assert.deepEqual(item.geographies, []);
  assert.equal(item.priority, "standard");
  assert.equal(item.takeaway, "");
  assert.equal(item.summary, "");
  assert.equal(item.whyItMatters, "");
  assert.equal(item.whatChanged, "");
  assert.equal(item.byline, undefined);
});

test("normalizeSourceItem throws on missing clusterId", () => {
  const { clusterId: _omit, ...rest } = MINIMAL_VALID;
  assert.throws(() => normalizeSourceItem(rest), /Missing required field: clusterId/);
});

test("normalizeSourceItem throws on missing body", () => {
  const { body: _omit, ...rest } = MINIMAL_VALID;
  assert.throws(() => normalizeSourceItem(rest), /Missing required field: body/);
});

test("normalizeSourceItem normalizes a string body into a single-element array", () => {
  const item = normalizeSourceItem({ ...MINIMAL_VALID, body: "Single paragraph string" });
  assert.deepEqual(item.body, ["Single paragraph string"]);
});

test("normalizeSourceItems returns all items and empty errors for all-valid input", () => {
  const raw = [MINIMAL_VALID, { ...MINIMAL_VALID, sourceId: "test-src-2" }];
  const { items, errors } = normalizeSourceItems(raw);
  assert.equal(items.length, 2);
  assert.equal(errors.length, 0);
});

test("normalizeSourceItems skips invalid items and reports error by index", () => {
  const raw = [
    MINIMAL_VALID,
    { sourceId: "bad-item" }, // missing clusterId, outlet, kind, etc.
    { ...MINIMAL_VALID, sourceId: "test-src-3" },
  ];
  const { items, errors } = normalizeSourceItems(raw);
  assert.equal(items.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 1);
  assert.ok(typeof errors[0].error === "string", "error must be a string message");
});

test("normalizeSourceItems throws TypeError when input is not an array", () => {
  assert.throws(() => normalizeSourceItems(null), /rawItems must be an array/);
  assert.throws(() => normalizeSourceItems({ key: "value" }), /rawItems must be an array/);
});
