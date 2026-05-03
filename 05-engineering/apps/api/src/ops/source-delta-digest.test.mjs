import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDigest } from "./source-delta-digest.mjs";

const DATE = "2026-05-02";

const ROWS = [
  {
    raw_string: "Reuters",
    kind: "traditional",
    times_seen: 5,
    first_seen_at: "2026-05-02T08:00:00.000Z",
    last_seen_at: "2026-05-02T20:00:00.000Z",
  },
  {
    raw_string: "AP",
    kind: "traditional",
    times_seen: 2,
    first_seen_at: "2026-05-02T10:00:00.000Z",
    last_seen_at: "2026-05-02T14:00:00.000Z",
  },
  {
    raw_string: "@nytimes",
    kind: "social",
    times_seen: 1,
    first_seen_at: "2026-05-02T12:00:00.000Z",
    last_seen_at: "2026-05-02T12:00:00.000Z",
  },
];

describe("formatDigest", () => {
  it("includes the date in the header", () => {
    const msg = formatDigest(ROWS, DATE);
    assert.ok(msg.includes(DATE), "header should contain the date");
  });

  it("pluralises source count correctly", () => {
    assert.ok(formatDigest(ROWS, DATE).includes("3 unmapped sources"));
    assert.ok(formatDigest([ROWS[0]], DATE).includes("1 unmapped source"));
    assert.ok(!formatDigest([ROWS[0]], DATE).includes("1 unmapped sources"));
  });

  it("renders traditional and social sections", () => {
    const msg = formatDigest(ROWS, DATE);
    assert.ok(msg.includes("*Traditional*"));
    assert.ok(msg.includes("*Social*"));
  });

  it("omits traditional section when no traditional rows", () => {
    const msg = formatDigest(ROWS.filter((r) => r.kind === "social"), DATE);
    assert.ok(!msg.includes("*Traditional*"));
    assert.ok(msg.includes("*Social*"));
  });

  it("omits social section when no social rows", () => {
    const msg = formatDigest(ROWS.filter((r) => r.kind === "traditional"), DATE);
    assert.ok(msg.includes("*Traditional*"));
    assert.ok(!msg.includes("*Social*"));
  });

  it("lists each source name", () => {
    const msg = formatDigest(ROWS, DATE);
    assert.ok(msg.includes("`Reuters`"));
    assert.ok(msg.includes("`AP`"));
    assert.ok(msg.includes("`@nytimes`"));
  });

  it("includes times_seen counts", () => {
    const msg = formatDigest(ROWS, DATE);
    assert.ok(msg.includes("5x"), "Reuters count");
    assert.ok(msg.includes("2x"), "AP count");
    assert.ok(msg.includes("1x"), "@nytimes count");
  });

  it("includes formatted first_seen_at timestamp", () => {
    const msg = formatDigest(ROWS, DATE);
    assert.ok(msg.includes("2026-05-02 08:00 UTC"), "Reuters first-seen timestamp");
  });

  it("includes playbook reference footer", () => {
    const msg = formatDigest(ROWS, DATE);
    assert.ok(msg.includes("SOURCE-REGISTRY-PHASE2-PLAYBOOK.md"));
  });

  it("returns a non-empty string for a single row", () => {
    const msg = formatDigest([ROWS[0]], DATE);
    assert.ok(typeof msg === "string" && msg.length > 0);
  });
});
