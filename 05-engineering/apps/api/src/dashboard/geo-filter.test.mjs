import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEO_CATEGORY,
  CONFLICT_THRESHOLD,
  IMPLICIT_THRESHOLD,
  categorizeItem,
  mockAssessGeoConfidence,
  applyGeoFilter,
} from "./geo-filter.mjs";

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    outlet: "Reuters",
    topic: "Diplomatic relations",
    geographies: ["US"],
    weight: 75,
    url: "https://example.com",
    minutesAgo: 30,
    headline: "Test headline",
    body: ["Test body."],
    kind: "traditional",
    ...overrides,
  };
}

const CONFIGURED_GEOS = ["US", "Colombia"];

// ─── categorizeItem ───────────────────────────────────────────────────────────

test("categorizeItem: explicit_match when item geos overlap with configured geos", () => {
  const item = makeItem({ geographies: ["US"] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.EXPLICIT_MATCH);
});

test("categorizeItem: explicit_match when item has multiple geos and at least one matches", () => {
  const item = makeItem({ geographies: ["Colombia", "Brazil"] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.EXPLICIT_MATCH);
});

test("categorizeItem: explicit_conflict when item has geos but none match", () => {
  const item = makeItem({ geographies: ["France", "Brazil"] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.EXPLICIT_CONFLICT);
});

test("categorizeItem: implicit_geo when item geographies is empty", () => {
  const item = makeItem({ geographies: [] });
  assert.equal(categorizeItem(item, CONFIGURED_GEOS), GEO_CATEGORY.IMPLICIT_GEO);
});

// ─── mockAssessGeoConfidence ──────────────────────────────────────────────────

test("mockAssessGeoConfidence: returns confidence between 0 and 1", () => {
  const { confidence } = mockAssessGeoConfidence(makeItem(), CONFIGURED_GEOS);
  assert.ok(confidence >= 0 && confidence <= 1);
});

test("mockAssessGeoConfidence: returns confidence above implicit threshold (0.80) but below conflict threshold (0.90)", () => {
  const { confidence } = mockAssessGeoConfidence(makeItem(), CONFIGURED_GEOS);
  assert.ok(confidence >= IMPLICIT_THRESHOLD, `confidence ${confidence} must be >= ${IMPLICIT_THRESHOLD}`);
  assert.ok(confidence < CONFLICT_THRESHOLD, `confidence ${confidence} must be < ${CONFLICT_THRESHOLD}`);
});

// ─── applyGeoFilter ───────────────────────────────────────────────────────────

test("applyGeoFilter: passes all items when configured geos is empty (topic+keyword-only mode)", async () => {
  const items = [
    makeItem({ sourceId: "a", geographies: ["France"] }),
    makeItem({ sourceId: "b", geographies: [] }),
  ];
  const { included, held } = await applyGeoFilter(items, []);
  assert.equal(included.length, 2);
  assert.equal(held.length, 0);
});

test("applyGeoFilter: explicit_match items always included with geoConfidence=1.0", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["US"] })];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.EXPLICIT_MATCH);
  assert.equal(included[0].geoConfidence, 1.0);
});

test("applyGeoFilter: explicit_match not affected by assessFn result", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["US"] })];
  const { included } = await applyGeoFilter(items, CONFIGURED_GEOS, async () => ({ confidence: 0.0 }));
  assert.equal(included.length, 1, "explicit_match must include regardless of assessFn");
});

test("applyGeoFilter: explicit_conflict item included when confidence >= 0.90", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["France"] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.92 })
  );
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.EXPLICIT_CONFLICT);
});

test("applyGeoFilter: explicit_conflict item held when confidence < 0.90", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["France"] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.89 })
  );
  assert.equal(included.length, 0);
  assert.equal(held.length, 1);
  assert.equal(held[0].geoCategory, GEO_CATEGORY.EXPLICIT_CONFLICT);
  assert.equal(held[0].geoConfidence, 0.89);
});

test("applyGeoFilter: implicit_geo item included when confidence >= 0.80", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.82 })
  );
  assert.equal(included.length, 1);
  assert.equal(held.length, 0);
  assert.equal(included[0].geoCategory, GEO_CATEGORY.IMPLICIT_GEO);
});

test("applyGeoFilter: implicit_geo item held when confidence < 0.80", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [] })];
  const { included, held } = await applyGeoFilter(
    items, CONFIGURED_GEOS, async () => ({ confidence: 0.79 })
  );
  assert.equal(included.length, 0);
  assert.equal(held.length, 1);
  assert.equal(held[0].geoCategory, GEO_CATEGORY.IMPLICIT_GEO);
});

test("applyGeoFilter: default mock assessor includes implicit_geo items (0.85 >= 0.80)", async () => {
  const items = [makeItem({ sourceId: "a", geographies: [] })];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.equal(included.length, 1, "mock assessor (0.85) must pass implicit threshold");
  assert.equal(held.length, 0);
});

test("applyGeoFilter: default mock assessor holds explicit_conflict items (0.85 < 0.90)", async () => {
  const items = [makeItem({ sourceId: "a", geographies: ["France"] })];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.equal(included.length, 0, "mock assessor (0.85) must not pass conflict threshold");
  assert.equal(held.length, 1);
});

test("applyGeoFilter: mixed batch routes items correctly", async () => {
  const items = [
    makeItem({ sourceId: "match", geographies: ["US"] }),          // explicit_match → included
    makeItem({ sourceId: "conflict", geographies: ["France"] }),   // explicit_conflict, 0.85 < 0.90 → held
    makeItem({ sourceId: "implicit", geographies: [] }),           // implicit_geo, 0.85 >= 0.80 → included
  ];
  const { included, held } = await applyGeoFilter(items, CONFIGURED_GEOS);
  assert.deepEqual(included.map((i) => i.sourceId).sort(), ["implicit", "match"]);
  assert.deepEqual(held.map((i) => i.sourceId), ["conflict"]);
});

test("applyGeoFilter: held items preserve original item fields", async () => {
  const item = makeItem({ sourceId: "held-item", headline: "Original headline", geographies: ["France"] });
  const { held } = await applyGeoFilter([item], CONFIGURED_GEOS, async () => ({ confidence: 0.0 }));
  assert.equal(held[0].sourceId, "held-item");
  assert.equal(held[0].headline, "Original headline");
});
