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

test("normalizeSourceItem preserves a feed-supplied lang (e.g. Spanish feeds → es)", () => {
  const item = normalizeSourceItem({ ...MINIMAL_VALID, lang: "es" });
  assert.equal(item.lang, "es", "lang must survive normalization for translation auto-activation");

  const trimmed = normalizeSourceItem({ ...MINIMAL_VALID, lang: "  es-CO  " });
  assert.equal(trimmed.lang, "es-CO", "lang is trimmed");
});

test("normalizeSourceItem leaves lang undefined when absent or blank (no fabrication)", () => {
  assert.equal(normalizeSourceItem(MINIMAL_VALID).lang, undefined);
  assert.equal(normalizeSourceItem({ ...MINIMAL_VALID, lang: "   " }).lang, undefined);
  assert.equal(normalizeSourceItem({ ...MINIMAL_VALID, lang: null }).lang, undefined);
});

test("normalizeSourceItem defaults clusterId to provisional:${sourceId} when omitted", () => {
  const { clusterId: _omit, ...rest } = MINIMAL_VALID;
  const item = normalizeSourceItem(rest);
  assert.equal(item.clusterId, "provisional:test-src-1");
  assert.equal(item.title, "provisional:test-src-1", "title falls back to defaulted clusterId");
});

test("normalizeSourceItem still throws on missing sourceId", () => {
  const { sourceId: _omit, ...rest } = MINIMAL_VALID;
  assert.throws(() => normalizeSourceItem(rest), /Missing required field: sourceId/);
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

test("normalizeSourceItem preserves feedId when present (live items only)", () => {
  const item = normalizeSourceItem({ ...MINIMAL_VALID, feedId: "wapo-politics" });
  assert.equal(item.feedId, "wapo-politics");
});

test("normalizeSourceItem leaves feedId undefined when absent (legacy fixtures)", () => {
  const item = normalizeSourceItem(MINIMAL_VALID);
  assert.equal(item.feedId, undefined);
});

test("normalizeSourceItem treats empty-string feedId as absent (defensive)", () => {
  // Defensive: an empty-string feedId from a defective manifest row would
  // make every item match every selected feed if we treated it as a real id.
  // Pin: empty → undefined → outlet-name fallback engages instead.
  const item = normalizeSourceItem({ ...MINIMAL_VALID, feedId: "" });
  assert.equal(item.feedId, undefined);
});
