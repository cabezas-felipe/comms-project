import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCatalogMarkdown,
  sortRows,
} from "./source-registry-catalog-generate.mjs";

const META = {
  generatedAt: new Date("2026-05-03T12:00:00.000Z"),
  supabaseUrl: "https://example.supabase.co",
};

const VERIFIED = {
  canonical_name: "Reuters",
  kind: "traditional",
  status: "verified",
  rss_url: "https://feeds.reuters.com/reuters/topNews",
  social_profile_url: null,
  manifest_feed_id: "reuters-top",
  ingestion_weight: 80,
  active: true,
  updated_at: "2026-04-01T10:00:00.000Z",
  created_at: "2026-04-01T10:00:00.000Z",
};

const MAPPED = {
  canonical_name: "AP News",
  kind: "traditional",
  status: "mapped",
  rss_url: "https://rsshub.app/apnews/topics/apf-topnews",
  social_profile_url: null,
  manifest_feed_id: "ap-top",
  ingestion_weight: 70,
  active: true,
  updated_at: "2026-04-02T10:00:00.000Z",
  created_at: "2026-04-02T10:00:00.000Z",
};

const PENDING = {
  canonical_name: "El Tiempo",
  kind: "traditional",
  status: "pending",
  rss_url: null,
  social_profile_url: null,
  manifest_feed_id: null,
  ingestion_weight: 50,
  active: false,
  updated_at: null,
  created_at: "2026-04-03T10:00:00.000Z",
};

const REJECTED = {
  canonical_name: "Spam Blog",
  kind: "social",
  status: "rejected",
  rss_url: null,
  social_profile_url: "https://twitter.com/spamblog",
  manifest_feed_id: null,
  ingestion_weight: 0,
  active: false,
  updated_at: "2026-04-04T10:00:00.000Z",
  created_at: "2026-04-04T10:00:00.000Z",
};

// ─── header metadata ──────────────────────────────────────────────────────────

test("formatCatalogMarkdown: output contains DO NOT EDIT marker", () => {
  const md = formatCatalogMarkdown([VERIFIED], META);
  assert.ok(md.includes("DO NOT EDIT"), `Missing DO NOT EDIT: ${md.slice(0, 200)}`);
});

test("formatCatalogMarkdown: output contains generated timestamp when generatedAt is provided", () => {
  const md = formatCatalogMarkdown([VERIFIED], META);
  assert.ok(md.includes("2026-05-03T12:00:00.000Z"), `Missing timestamp: ${md.slice(0, 500)}`);
});

test("formatCatalogMarkdown: no timestamp line when generatedAt is omitted (diff-stable default)", () => {
  const metaNoTimestamp = { supabaseUrl: "https://example.supabase.co" };
  const md = formatCatalogMarkdown([VERIFIED], metaNoTimestamp);
  assert.ok(
    !md.includes("**Generated:**"),
    `Timestamp line must be absent when generatedAt is not provided: ${md.slice(0, 500)}`
  );
});

test("formatCatalogMarkdown: output contains supabaseUrl", () => {
  const md = formatCatalogMarkdown([VERIFIED], META);
  assert.ok(md.includes("https://example.supabase.co"), `Missing supabase URL: ${md.slice(0, 500)}`);
});

test("formatCatalogMarkdown: output contains regenerate command", () => {
  const md = formatCatalogMarkdown([VERIFIED], META);
  assert.ok(
    md.includes("source-catalog:generate"),
    `Missing regen command: ${md.slice(0, 500)}`
  );
});

// ─── section grouping ────────────────────────────────────────────────────────

test("formatCatalogMarkdown: all four section headers present", () => {
  const md = formatCatalogMarkdown([VERIFIED, MAPPED, PENDING, REJECTED], META);
  for (const s of ["## Verified", "## Mapped", "## Pending", "## Rejected"]) {
    assert.ok(md.includes(s), `Missing section "${s}"`);
  }
});

test("formatCatalogMarkdown: verified row appears in Verified section only", () => {
  const md = formatCatalogMarkdown([VERIFIED, PENDING], META);
  const verifiedIdx = md.indexOf("## Verified");
  const mappedIdx = md.indexOf("## Mapped");
  const reutersIdx = md.indexOf("Reuters");
  assert.ok(reutersIdx > verifiedIdx, "Reuters should appear after ## Verified");
  assert.ok(reutersIdx < mappedIdx, "Reuters should appear before ## Mapped");
});

test("formatCatalogMarkdown: empty section renders no-entries placeholder", () => {
  const md = formatCatalogMarkdown([VERIFIED], META);
  assert.ok(md.includes("_No entries._"), `Expected no-entries placeholder: ${md}`);
});

test("formatCatalogMarkdown: summary table shows correct total", () => {
  const md = formatCatalogMarkdown([VERIFIED, MAPPED, PENDING], META);
  assert.ok(md.includes("| Total | 3 |"), `Missing total count in summary: ${md.slice(0, 600)}`);
});

// ─── empty values ────────────────────────────────────────────────────────────

test("formatCatalogMarkdown: null rss_url and null social_profile_url renders dash", () => {
  const md = formatCatalogMarkdown([PENDING], META);
  const pendingSection = md.slice(md.indexOf("## Pending"));
  assert.ok(pendingSection.includes("—"), `Expected dash for null URL: ${pendingSection}`);
});

test("formatCatalogMarkdown: null manifest_feed_id renders dash", () => {
  const md = formatCatalogMarkdown([PENDING], META);
  const pendingSection = md.slice(md.indexOf("## Pending"));
  assert.ok(pendingSection.includes("—"), `Expected dash for null manifest_feed_id: ${pendingSection}`);
});

test("formatCatalogMarkdown: null updated_at falls back to created_at date", () => {
  const md = formatCatalogMarkdown([PENDING], META);
  assert.ok(md.includes("2026-04-03"), `Expected created_at fallback date: ${md}`);
});

test("formatCatalogMarkdown: social_profile_url used when rss_url is null", () => {
  const md = formatCatalogMarkdown([REJECTED], META);
  assert.ok(
    md.includes("https://twitter.com/spamblog"),
    `Expected social_profile_url in output: ${md}`
  );
});

// ─── deterministic ordering ──────────────────────────────────────────────────

test("sortRows: verified appears before mapped", () => {
  const sorted = sortRows([MAPPED, VERIFIED]);
  assert.equal(sorted[0].status, "verified");
  assert.equal(sorted[1].status, "mapped");
});

test("sortRows: status order is verified → mapped → pending → rejected", () => {
  const sorted = sortRows([REJECTED, PENDING, MAPPED, VERIFIED]);
  assert.deepEqual(
    sorted.map((r) => r.status),
    ["verified", "mapped", "pending", "rejected"]
  );
});

test("sortRows: within same status, higher ingestion_weight appears first", () => {
  const low = { ...MAPPED, canonical_name: "Low", ingestion_weight: 10 };
  const high = { ...MAPPED, canonical_name: "High", ingestion_weight: 90 };
  const sorted = sortRows([low, high]);
  assert.equal(sorted[0].canonical_name, "High");
  assert.equal(sorted[1].canonical_name, "Low");
});

test("sortRows: weight tie broken by canonical_name ASC", () => {
  const b = { ...MAPPED, canonical_name: "Bravo", ingestion_weight: 50 };
  const a = { ...MAPPED, canonical_name: "Alpha", ingestion_weight: 50 };
  const sorted = sortRows([b, a]);
  assert.equal(sorted[0].canonical_name, "Alpha");
  assert.equal(sorted[1].canonical_name, "Bravo");
});

// ─── no mutation ─────────────────────────────────────────────────────────────

test("sortRows: does not mutate input array", () => {
  const rows = [REJECTED, PENDING, MAPPED, VERIFIED];
  sortRows(rows);
  assert.equal(rows[0], REJECTED, "Input array should not be mutated");
  assert.equal(rows[1], PENDING);
  assert.equal(rows[2], MAPPED);
  assert.equal(rows[3], VERIFIED);
});

test("formatCatalogMarkdown: does not mutate input array", () => {
  const rows = [REJECTED, PENDING, MAPPED, VERIFIED];
  formatCatalogMarkdown(rows, META);
  assert.equal(rows[0], REJECTED, "Input array should not be mutated");
  assert.equal(rows[3], VERIFIED);
});
