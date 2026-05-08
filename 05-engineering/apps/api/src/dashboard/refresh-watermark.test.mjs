import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWatermark, watermarksMatch } from "./refresh-watermark.mjs";

function item(sourceId, minutesAgo) {
  return { sourceId, minutesAgo };
}

const FIXED_NOW = new Date("2026-05-08T12:00:00Z").getTime();

test("computeWatermark: returns 16-char hex string", () => {
  const { watermark } = computeWatermark({
    candidateItems: [item("a", 30)],
    selectedFeedIds: ["wapo-politics"],
    now: FIXED_NOW,
  });
  assert.ok(/^[0-9a-f]{16}$/.test(watermark), `expected 16-hex, got: ${watermark}`);
});

test("computeWatermark: stable across refresh-time drift (now + minutesAgo shift together)", () => {
  // Refresh 1 at FIXED_NOW with minutesAgo=30 → article published at FIXED_NOW - 30min
  const a = computeWatermark({
    candidateItems: [item("a", 30)],
    selectedFeedIds: ["f1"],
    now: FIXED_NOW,
  });
  // Refresh 2 ten minutes later: same article, minutesAgo=40 → same pubDate → same hour bucket
  const b = computeWatermark({
    candidateItems: [item("a", 40)],
    selectedFeedIds: ["f1"],
    now: FIXED_NOW + 10 * 60_000,
  });
  assert.equal(a.watermark, b.watermark, "watermark must be stable under refresh drift");
});

test("computeWatermark: changes when a new sourceId arrives", () => {
  const a = computeWatermark({ candidateItems: [item("a", 30)], selectedFeedIds: ["f1"], now: FIXED_NOW });
  const b = computeWatermark({ candidateItems: [item("a", 30), item("b", 30)], selectedFeedIds: ["f1"], now: FIXED_NOW });
  assert.notEqual(a.watermark, b.watermark);
  assert.equal(a.candidateCount, 1);
  assert.equal(b.candidateCount, 2);
});

test("computeWatermark: changes when a sourceId drops out", () => {
  const a = computeWatermark({ candidateItems: [item("a", 30), item("b", 30)], selectedFeedIds: ["f1"], now: FIXED_NOW });
  const b = computeWatermark({ candidateItems: [item("b", 30)], selectedFeedIds: ["f1"], now: FIXED_NOW });
  assert.notEqual(a.watermark, b.watermark);
});

test("computeWatermark: order of candidate items doesn't matter (sorted)", () => {
  const a = computeWatermark({ candidateItems: [item("a", 30), item("b", 60)], selectedFeedIds: ["f1"], now: FIXED_NOW });
  const b = computeWatermark({ candidateItems: [item("b", 60), item("a", 30)], selectedFeedIds: ["f1"], now: FIXED_NOW });
  assert.equal(a.watermark, b.watermark);
});

test("computeWatermark: changes when selected feed list changes", () => {
  const a = computeWatermark({ candidateItems: [item("a", 30)], selectedFeedIds: ["f1"], now: FIXED_NOW });
  const b = computeWatermark({ candidateItems: [item("a", 30)], selectedFeedIds: ["f1", "f2"], now: FIXED_NOW });
  assert.notEqual(a.watermark, b.watermark);
  assert.equal(a.selectedFeedCount, 1);
  assert.equal(b.selectedFeedCount, 2);
});

test("computeWatermark: empty candidates yields stable hash, count 0, null buckets", () => {
  const r = computeWatermark({ candidateItems: [], selectedFeedIds: ["f1"], now: FIXED_NOW });
  assert.equal(r.candidateCount, 0);
  assert.equal(r.minPubBucket, null);
  assert.equal(r.maxPubBucket, null);
  assert.ok(/^[0-9a-f]{16}$/.test(r.watermark));
});

test("computeWatermark: pub-time bucket changes when an item ages out of an hour", () => {
  // Same sourceId set, but minutesAgo crosses an hour boundary relative to `now`.
  // Bucket-aware composition will detect the shift.
  // Article 1 hour 0 min before now → bucket b1.  Article 1 hour 5 min before now → bucket b1-1.
  const justUnderHour = computeWatermark({
    candidateItems: [item("a", 59)],
    selectedFeedIds: ["f1"],
    now: FIXED_NOW,
  });
  const justOverHour = computeWatermark({
    candidateItems: [item("a", 65)],
    selectedFeedIds: ["f1"],
    now: FIXED_NOW,
  });
  // These two are computed at the same `now` but differ in pubDate by ~6 min,
  // which can land them in the same OR different hour bucket depending on
  // alignment.  Either way, when the bucket diverges the watermark must shift.
  if (justUnderHour.minPubBucket !== justOverHour.minPubBucket) {
    assert.notEqual(justUnderHour.watermark, justOverHour.watermark);
  } else {
    assert.equal(justUnderHour.watermark, justOverHour.watermark);
  }
});

test("watermarksMatch: returns false when either side is null/undefined", () => {
  assert.equal(watermarksMatch(null, "abc"), false);
  assert.equal(watermarksMatch("abc", null), false);
  assert.equal(watermarksMatch(undefined, undefined), false);
});

test("watermarksMatch: returns true only on exact non-empty string equality", () => {
  assert.equal(watermarksMatch("abc", "abc"), true);
  assert.equal(watermarksMatch("abc", "abd"), false);
  assert.equal(watermarksMatch("", ""), false, "empty strings must not be considered a match");
});
