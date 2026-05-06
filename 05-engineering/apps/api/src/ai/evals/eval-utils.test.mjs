import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForEval, normalizeForEvalField, setMetrics, EVAL_FIELDS } from "./eval-utils.mjs";

// ── EVAL_FIELDS ───────────────────────────────────────────────────────────────

test("EVAL_FIELDS contains exactly the five extraction fields", () => {
  assert.deepEqual(EVAL_FIELDS, [
    "topics",
    "keywords",
    "geographies",
    "traditionalSources",
    "socialSources",
  ]);
});

// ── normalizeForEval ──────────────────────────────────────────────────────────

test("normalizeForEval: trims leading and trailing whitespace", () => {
  assert.deepEqual(normalizeForEval(["  Reuters  "]), ["Reuters"]);
});

test("normalizeForEval: removes empty strings after trim", () => {
  assert.deepEqual(normalizeForEval(["", "  ", "Reuters"]), ["Reuters"]);
});

test("normalizeForEval: case-insensitive dedupe — first occurrence wins", () => {
  assert.deepEqual(normalizeForEval(["NYT", "nyt", "Reuters"]), ["NYT", "Reuters"]);
});

test("normalizeForEval: @-handle case-insensitive dedupe", () => {
  assert.deepEqual(normalizeForEval(["@StateDept", "@statedept"]), ["@StateDept"]);
});

test("normalizeForEval: sorts case-insensitively (stable)", () => {
  assert.deepEqual(normalizeForEval(["Reuters", "BBC", "AP"]), ["AP", "BBC", "Reuters"]);
});

test("normalizeForEval: handles empty array", () => {
  assert.deepEqual(normalizeForEval([]), []);
});

test("normalizeForEval: drops non-string items", () => {
  assert.deepEqual(normalizeForEval([42, null, "Reuters"]), ["Reuters"]);
});

test("normalizeForEval: idempotent on already-normalised arrays", () => {
  const input = ["BBC", "Reuters"];
  assert.deepEqual(normalizeForEval(normalizeForEval(input)), normalizeForEval(input));
});

test("normalizeForEval: handles non-array input gracefully", () => {
  assert.deepEqual(normalizeForEval(null), []);
  assert.deepEqual(normalizeForEval(undefined), []);
});

// ── setMetrics ────────────────────────────────────────────────────────────────

test("setMetrics: both empty → perfect scores", () => {
  const m = setMetrics([], []);
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 1);
  assert.equal(m.f1, 1);
  assert.equal(m.exactMatch, true);
});

test("setMetrics: perfect match — same elements", () => {
  const m = setMetrics(["Colombia", "US"], ["Colombia", "US"]);
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 1);
  assert.equal(m.f1, 1);
  assert.equal(m.exactMatch, true);
});

test("setMetrics: perfect match — order-independent", () => {
  const m = setMetrics(["US", "Colombia"], ["Colombia", "US"]);
  assert.equal(m.exactMatch, true);
});

test("setMetrics: case-insensitive comparison", () => {
  const m = setMetrics(["colombia"], ["Colombia"]);
  assert.equal(m.exactMatch, true);
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 1);
});

test("setMetrics: predicted empty, expected non-empty → all zero, not exact", () => {
  const m = setMetrics([], ["Colombia"]);
  assert.equal(m.precision, 0);
  assert.equal(m.recall, 0);
  assert.equal(m.f1, 0);
  assert.equal(m.exactMatch, false);
});

test("setMetrics: predicted non-empty, expected empty → all zero, not exact", () => {
  const m = setMetrics(["Colombia"], []);
  assert.equal(m.precision, 0);
  assert.equal(m.recall, 0);
  assert.equal(m.f1, 0);
  assert.equal(m.exactMatch, false);
});

test("setMetrics: partial match — TP=1 of 2 on each side", () => {
  // pred=[A,B] exp=[A,C] → TP=1, P=0.5, R=0.5, F1=0.5
  const m = setMetrics(["A", "B"], ["A", "C"]);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.ok(Math.abs(m.f1 - 0.5) < 0.001);
  assert.equal(m.exactMatch, false);
});

test("setMetrics: high recall, low precision — predicted superset of expected", () => {
  // pred=[A,B,C,D] exp=[A,B] → TP=2, P=0.5, R=1, F1≈0.667
  const m = setMetrics(["A", "B", "C", "D"], ["A", "B"]);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 1);
  assert.ok(Math.abs(m.f1 - 2 / 3) < 0.001);
  assert.equal(m.exactMatch, false);
});

test("setMetrics: high precision, low recall — predicted subset of expected", () => {
  // pred=[A] exp=[A,B,C] → TP=1, P=1, R=1/3, F1=0.5
  const m = setMetrics(["A"], ["A", "B", "C"]);
  assert.equal(m.precision, 1);
  assert.ok(Math.abs(m.recall - 1 / 3) < 0.001);
  assert.ok(Math.abs(m.f1 - 0.5) < 0.001);
  assert.equal(m.exactMatch, false);
});

test("setMetrics: no overlap — precision and recall both 0", () => {
  const m = setMetrics(["X"], ["Y"]);
  assert.equal(m.precision, 0);
  assert.equal(m.recall, 0);
  assert.equal(m.f1, 0);
  assert.equal(m.exactMatch, false);
});

// ── normalizeForEvalField ─────────────────────────────────────────────────────

test("normalizeForEvalField: topics — maps synonym to canonical form", () => {
  assert.deepEqual(
    normalizeForEvalField("topics", ["Security cooperation"]),
    ["Security policy"]
  );
});

test("normalizeForEvalField: topics — preserves canonical label unchanged", () => {
  assert.deepEqual(
    normalizeForEvalField("topics", ["Diplomatic relations"]),
    ["Diplomatic relations"]
  );
});

test("normalizeForEvalField: topics — dedupes synonym and canonical to one entry", () => {
  const result = normalizeForEvalField("topics", ["Security cooperation", "Security policy"]);
  assert.equal(result.length, 1);
  assert.equal(result[0], "Security policy");
});

test("normalizeForEvalField: traditionalSources — maps NYT to New York Times", () => {
  assert.deepEqual(
    normalizeForEvalField("traditionalSources", ["NYT"]),
    ["New York Times"]
  );
});

test("normalizeForEvalField: traditionalSources — maps AP to Associated Press", () => {
  assert.deepEqual(
    normalizeForEvalField("traditionalSources", ["AP"]),
    ["Associated Press"]
  );
});

test("normalizeForEvalField: traditionalSources — maps BBC News to BBC", () => {
  assert.deepEqual(
    normalizeForEvalField("traditionalSources", ["BBC News"]),
    ["BBC"]
  );
});

test("normalizeForEvalField: geographies — applies no field normalizer (passthrough)", () => {
  assert.deepEqual(
    normalizeForEvalField("geographies", ["Colombia", "US"]),
    ["Colombia", "US"]
  );
});

test("normalizeForEvalField: socialSources — applies no field normalizer (passthrough)", () => {
  assert.deepEqual(
    normalizeForEvalField("socialSources", ["@stateDept"]),
    ["@stateDept"]
  );
});

test("normalizeForEvalField: unknown field — behaves like normalizeForEval", () => {
  assert.deepEqual(
    normalizeForEvalField("unknownField", ["Reuters", "Reuters"]),
    ["Reuters"]
  );
});

test("normalizeForEvalField: topics — maps 'Sanctions' to 'Sanctions enforcement'", () => {
  assert.deepEqual(
    normalizeForEvalField("topics", ["Sanctions"]),
    ["Sanctions enforcement"]
  );
});

test("normalizeForEvalField: topics — maps 'Deportation' to 'Deportation policy'", () => {
  assert.deepEqual(
    normalizeForEvalField("topics", ["Deportation"]),
    ["Deportation policy"]
  );
});

test("normalizeForEvalField: topics — maps 'Vaccine rollout' to 'Public health policy'", () => {
  assert.deepEqual(
    normalizeForEvalField("topics", ["Vaccine rollout"]),
    ["Public health policy"]
  );
});

test("normalizeForEvalField: keywords — maps 'outbreaks' to 'outbreak'", () => {
  assert.deepEqual(
    normalizeForEvalField("keywords", ["outbreaks"]),
    ["outbreak"]
  );
});

test("normalizeForEvalField: keywords — maps 'asylum court' to 'asylum'", () => {
  assert.deepEqual(
    normalizeForEvalField("keywords", ["asylum court"]),
    ["asylum"]
  );
});

test("normalizeForEvalField: traditionalSources — maps 'WSJ' to 'Wall Street Journal'", () => {
  assert.deepEqual(
    normalizeForEvalField("traditionalSources", ["WSJ"]),
    ["Wall Street Journal"]
  );
});
