import test from "node:test";
import assert from "node:assert/strict";
import { computeDeltaRows } from "./source-registry-sync.mjs";

const USER = "test-user-id";

// ─── computeDeltaRows — delta logic ──────────────────────────────────────────

test("computeDeltaRows: logs only newly added traditional source", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: ["Reuters"], socialSources: [] },
    nextPayload: { traditionalSources: ["Reuters", "NYT"], socialSources: [] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_string, "NYT");
  assert.equal(rows[0].kind, "traditional");
  assert.equal(rows[0].user_id, USER);
});

test("computeDeltaRows: logs only newly added social source", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: [], socialSources: ["@latamwatcher"] },
    nextPayload: { traditionalSources: [], socialSources: ["@latamwatcher", "@newaccount"] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_string, "@newaccount");
  assert.equal(rows[0].kind, "social");
});

test("computeDeltaRows: no rows when sources are unchanged", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: ["Reuters"], socialSources: ["@latamwatcher"] },
    nextPayload: { traditionalSources: ["Reuters"], socialSources: ["@latamwatcher"] },
  });
  assert.equal(rows.length, 0);
});

test("computeDeltaRows: no rows on removal only (no additions)", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: ["Reuters", "El Tiempo"], socialSources: ["@latamwatcher"] },
    nextPayload: { traditionalSources: ["Reuters"], socialSources: [] },
  });
  assert.equal(rows.length, 0);
});

test("computeDeltaRows: logs all sources on first save (previousPayload null)", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: null,
    nextPayload: { traditionalSources: ["Reuters", "NYT"], socialSources: ["@latamwatcher"] },
  });
  assert.equal(rows.length, 3);
  const kinds = rows.map((r) => r.kind);
  assert.equal(kinds.filter((k) => k === "traditional").length, 2);
  assert.equal(kinds.filter((k) => k === "social").length, 1);
  assert.ok(rows.some((r) => r.raw_string === "Reuters"));
  assert.ok(rows.some((r) => r.raw_string === "NYT"));
  assert.ok(rows.some((r) => r.raw_string === "@latamwatcher"));
});

test("computeDeltaRows: logs all sources when previousPayload has empty arrays", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: [], socialSources: [] },
    nextPayload: { traditionalSources: ["Reuters"], socialSources: ["@latamwatcher"] },
  });
  assert.equal(rows.length, 2);
});

test("computeDeltaRows: no rows when both payloads have no sources", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: [], socialSources: [] },
    nextPayload: { traditionalSources: [], socialSources: [] },
  });
  assert.equal(rows.length, 0);
});

test("computeDeltaRows: handles mixed additions and removals across kinds", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: ["Reuters", "El Tiempo"], socialSources: ["@latamwatcher"] },
    nextPayload: { traditionalSources: ["Reuters", "NYT"], socialSources: ["@latamwatcher", "@newone"] },
  });
  // Added: NYT (traditional), @newone (social). Removed: El Tiempo (traditional) — not logged.
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.raw_string === "NYT" && r.kind === "traditional"));
  assert.ok(rows.some((r) => r.raw_string === "@newone" && r.kind === "social"));
});

test("computeDeltaRows: matching is exact — different casing is treated as new", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: ["reuters"], socialSources: [] },
    nextPayload: { traditionalSources: ["Reuters"], socialSources: [] },
  });
  // "reuters" ≠ "Reuters" (no normalization at this stage)
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_string, "Reuters");
});

// ─── Intra-payload deduplication ─────────────────────────────────────────────

test("computeDeltaRows: duplicate traditional string in nextPayload yields one row", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: null,
    nextPayload: { traditionalSources: ["NYT", "NYT"], socialSources: [] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_string, "NYT");
  assert.equal(rows[0].kind, "traditional");
});

test("computeDeltaRows: duplicate social string in nextPayload yields one row", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: null,
    nextPayload: { traditionalSources: [], socialSources: ["@latamwatcher", "@latamwatcher"] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_string, "@latamwatcher");
  assert.equal(rows[0].kind, "social");
});

test("computeDeltaRows: duplicates plus one new source emits one row per unique new source", () => {
  const rows = computeDeltaRows({
    userId: USER,
    previousPayload: { traditionalSources: ["Reuters"], socialSources: [] },
    nextPayload: { traditionalSources: ["Reuters", "NYT", "NYT"], socialSources: [] },
  });
  // Reuters is unchanged; NYT appears twice but should produce exactly one row.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_string, "NYT");
});
