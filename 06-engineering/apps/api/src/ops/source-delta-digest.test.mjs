import test from "node:test";
import assert from "node:assert/strict";
import { formatDigest } from "./source-delta-digest.mjs";

const AS_OF = new Date("2026-05-02T09:00:00.000Z");

const TRAD = {
  raw_string: "Reuters",
  kind: "traditional",
  times_seen: 3,
  first_seen_at: "2026-05-01T10:00:00.000Z",
  last_seen_at: "2026-05-01T22:00:00.000Z",
  sample_user_ids: ["user-1"],
};

const SOCIAL = {
  raw_string: "@latamwatcher",
  kind: "social",
  times_seen: 5,
  first_seen_at: "2026-05-01T08:00:00.000Z",
  last_seen_at: "2026-05-01T23:00:00.000Z",
  sample_user_ids: ["user-2", "user-3"],
};

// ─── empty ────────────────────────────────────────────────────────────────────

test("formatDigest: empty rows returns no-unmapped message with date", () => {
  const msg = formatDigest([], AS_OF);
  assert.ok(msg.includes("No unmapped sources"), `Got: ${msg}`);
  assert.ok(msg.includes("2026-05-02"), `Should include date: ${msg}`);
});

// ─── traditional-only ─────────────────────────────────────────────────────────

test("formatDigest: traditional-only shows Traditional section and source name", () => {
  const msg = formatDigest([TRAD], AS_OF);
  assert.ok(msg.includes("Traditional"), `Missing Traditional section: ${msg}`);
  assert.ok(msg.includes("Reuters"), `Missing source name: ${msg}`);
  assert.ok(!msg.includes("Social"), `Should not contain Social section: ${msg}`);
});

test("formatDigest: traditional-only includes times_seen count", () => {
  const msg = formatDigest([TRAD], AS_OF);
  assert.ok(msg.includes("3×"), `Should include seen count: ${msg}`);
});

// ─── social-only ──────────────────────────────────────────────────────────────

test("formatDigest: social-only shows Social section and source name", () => {
  const msg = formatDigest([SOCIAL], AS_OF);
  assert.ok(msg.includes("Social"), `Missing Social section: ${msg}`);
  assert.ok(msg.includes("@latamwatcher"), `Missing source name: ${msg}`);
  assert.ok(!msg.includes("Traditional"), `Should not contain Traditional section: ${msg}`);
});

test("formatDigest: social-only includes times_seen count", () => {
  const msg = formatDigest([SOCIAL], AS_OF);
  assert.ok(msg.includes("5×"), `Should include seen count: ${msg}`);
});

// ─── mixed ────────────────────────────────────────────────────────────────────

test("formatDigest: mixed rows includes both sections and both source names", () => {
  const msg = formatDigest([TRAD, SOCIAL], AS_OF);
  assert.ok(msg.includes("Traditional"), `Missing Traditional section: ${msg}`);
  assert.ok(msg.includes("Social"), `Missing Social section: ${msg}`);
  assert.ok(msg.includes("Reuters"), `Missing Reuters: ${msg}`);
  assert.ok(msg.includes("@latamwatcher"), `Missing @latamwatcher: ${msg}`);
});

test("formatDigest: mixed rows header shows total unmapped count", () => {
  const msg = formatDigest([TRAD, SOCIAL], AS_OF);
  assert.ok(msg.includes("2 unmapped"), `Should show total count: ${msg}`);
});

test("formatDigest: mixed rows header includes date from asOf", () => {
  const msg = formatDigest([TRAD, SOCIAL], AS_OF);
  assert.ok(msg.includes("2026-05-02"), `Should include asOf date: ${msg}`);
});

// ─── ordering ─────────────────────────────────────────────────────────────────

test("formatDigest: higher times_seen appears before lower within same kind", () => {
  const rare = { ...TRAD, raw_string: "Rare Source", times_seen: 1, first_seen_at: "2026-05-01T06:00:00.000Z" };
  const frequent = { ...TRAD, raw_string: "Frequent Source", times_seen: 10, first_seen_at: "2026-05-01T12:00:00.000Z" };
  const msg = formatDigest([rare, frequent], AS_OF);
  const rareIdx = msg.indexOf("Rare Source");
  const frequentIdx = msg.indexOf("Frequent Source");
  assert.ok(frequentIdx < rareIdx, `Frequent (seen 10×) should appear before Rare (seen 1×): ${msg}`);
});

test("formatDigest: ties on times_seen resolved by earliest first_seen_at", () => {
  const later = { ...TRAD, raw_string: "Later Source", times_seen: 5, first_seen_at: "2026-05-01T18:00:00.000Z" };
  const earlier = { ...TRAD, raw_string: "Earlier Source", times_seen: 5, first_seen_at: "2026-05-01T06:00:00.000Z" };
  const msg = formatDigest([later, earlier], AS_OF);
  const laterIdx = msg.indexOf("Later Source");
  const earlierIdx = msg.indexOf("Earlier Source");
  assert.ok(earlierIdx < laterIdx, `Earlier first_seen_at should appear first when times_seen tied: ${msg}`);
});

test("formatDigest: ordering does not mutate the input array", () => {
  const rows = [TRAD, SOCIAL];
  formatDigest(rows, AS_OF);
  assert.equal(rows[0], TRAD, "Input array should not be mutated");
  assert.equal(rows[1], SOCIAL, "Input array should not be mutated");
});
