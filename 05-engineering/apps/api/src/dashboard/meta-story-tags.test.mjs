import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assignMetaStoryTags,
  buildMetaStoryEvidenceText,
} from "./meta-story-tags.mjs";

// ─── Fixture helpers ──────────────────────────────────────────────────────────
//
// These tests target the Phase 3 tag assignment surface directly; they do not
// go through the full pipeline.  Source items only need fields the assigner
// reads (topic, geographies, headline, body) — everything else is intentionally
// omitted to keep the regression surface narrow and the intent obvious.

function makeSourceItem(overrides = {}) {
  return {
    sourceId: "src-1",
    topic: "",
    geographies: [],
    headline: "",
    body: [],
    ...overrides,
  };
}

const BASE_SETTINGS = Object.freeze({
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["OFAC", "sanctions", "oil"],
  geographies: ["US", "Colombia", "China"],
});

// ─── buildMetaStoryEvidenceText ──────────────────────────────────────────────

test("buildMetaStoryEvidenceText: concatenates meta-story title/subtitle/summary and source headline/body", () => {
  const meta = {
    title: "Title text",
    subtitle: "Subtitle text",
    summary: "Summary text",
  };
  const sources = [
    makeSourceItem({ headline: "Headline one", body: ["Body para one.", "Body para two."] }),
    makeSourceItem({ headline: "Headline two", body: "Body string two." }),
  ];
  const text = buildMetaStoryEvidenceText(meta, sources);
  assert.match(text, /Title text/);
  assert.match(text, /Subtitle text/);
  assert.match(text, /Summary text/);
  assert.match(text, /Headline one/);
  assert.match(text, /Body para one\./);
  assert.match(text, /Body para two\./);
  assert.match(text, /Headline two/);
  assert.match(text, /Body string two\./);
});

test("buildMetaStoryEvidenceText: defensively handles missing fields (no throws, no `undefined` text)", () => {
  const text = buildMetaStoryEvidenceText({}, []);
  assert.equal(text, "");
});

test("buildMetaStoryEvidenceText: tolerates partial source items and non-string body entries", () => {
  const meta = { title: "T" };
  const sources = [
    null,
    "not-an-object",
    { headline: "ok-headline", body: ["string-only", 42, null, "trailing"] },
  ];
  const text = buildMetaStoryEvidenceText(meta, sources);
  // Junk entries do not interrupt the bundle; valid string fragments survive.
  assert.match(text, /T/);
  assert.match(text, /ok-headline/);
  assert.match(text, /string-only/);
  assert.match(text, /trailing/);
});

// ─── Topics ──────────────────────────────────────────────────────────────────

test("assignMetaStoryTags: topic tag emitted when the evidence bundle text contains the settings topic phrase", () => {
  // Source has NO `topic` field; topic must come from the meta-story summary.
  const meta = {
    title: "Routine update",
    subtitle: "Sub.",
    summary: "Diplomatic relations between the two governments continued.",
  };
  const sources = [makeSourceItem({ headline: "h", body: ["b"] })];
  const out = assignMetaStoryTags({ metaStory: meta, sourceItems: sources, settings: BASE_SETTINGS });
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
});

test("assignMetaStoryTags: topic tag emitted from source.topic via canonical-synonym normalization", () => {
  // Bundle text is generic; source `topic` is the synonym "bilateral relations"
  // which normalizes to the settings entry "Diplomatic relations".
  const meta = { title: "T", subtitle: "S", summary: "No canonical phrase here." };
  const sources = [makeSourceItem({ topic: "bilateral relations" })];
  const out = assignMetaStoryTags({ metaStory: meta, sourceItems: sources, settings: BASE_SETTINGS });
  assert.deepEqual(out.topics, ["Diplomatic relations"]);
});

test("assignMetaStoryTags: out-of-settings topic in bundle is NOT emitted", () => {
  const meta = {
    title: "T",
    subtitle: "S",
    summary: "Energy policy reform dominates the agenda.",
  };
  const out = assignMetaStoryTags({
    metaStory: meta,
    sourceItems: [makeSourceItem()],
    settings: BASE_SETTINGS, // "Energy policy" is intentionally absent here
  });
  assert.deepEqual(out.topics, []);
});

// ─── Keywords ────────────────────────────────────────────────────────────────

test("assignMetaStoryTags: keyword tag emitted when settings keyword appears as a whole word in source text", () => {
  const meta = { title: "T", subtitle: "S", summary: "Sum." };
  const sources = [makeSourceItem({ headline: "Treasury weighs OFAC expansion", body: ["Routine update."] })];
  const out = assignMetaStoryTags({ metaStory: meta, sourceItems: sources, settings: BASE_SETTINGS });
  assert.deepEqual(out.keywords, ["OFAC"]);
});

test("assignMetaStoryTags: substring inside a larger word does NOT satisfy keyword match", () => {
  // 'ofacility' contains 'ofac' but is a single word — \b boundaries reject it.
  const sources = [makeSourceItem({ headline: "An ofacility opens.", body: ["No other terms."] })];
  const out = assignMetaStoryTags({
    metaStory: { title: "T", summary: "S" },
    sourceItems: sources,
    settings: BASE_SETTINGS,
  });
  assert.deepEqual(out.keywords, []);
});

test("assignMetaStoryTags: 'petroleum' in text + 'oil' in settings emits NO keyword tag (Phase 4 deferred)", () => {
  // Phase 3 contract: keywords are deterministic whole-word matches only.
  // Semantic synonym widening ("petroleum" → "oil") is explicitly Phase 4
  // territory — this test locks the boundary so a future change doesn't
  // accidentally light up semantic matching here.
  const sources = [
    makeSourceItem({ headline: "Petroleum prices climb again.", body: ["Crude refining capacity strained."] }),
  ];
  const out = assignMetaStoryTags({
    metaStory: { title: "Energy roundup", summary: "Markets shift on supply." },
    sourceItems: sources,
    settings: BASE_SETTINGS, // includes "oil"
  });
  assert.ok(
    !out.keywords.includes("oil"),
    "Phase 3 must not widen 'petroleum' to the 'oil' keyword — that's Phase 4"
  );
  assert.deepEqual(out.keywords, []);
});

// ─── Geographies — direct + structural ───────────────────────────────────────

test("assignMetaStoryTags: geography tag emitted via direct phrase match in evidence text", () => {
  const meta = { title: "T", subtitle: "S", summary: "Colombia held a press conference today." };
  const sources = [makeSourceItem({ headline: "h", body: ["b"] })];
  const out = assignMetaStoryTags({ metaStory: meta, sourceItems: sources, settings: BASE_SETTINGS });
  assert.deepEqual(out.geographies, ["Colombia"]);
});

test("assignMetaStoryTags: geography tag emitted via structural source.geographies intersected with settings", () => {
  const meta = { title: "T", summary: "S" };
  const sources = [makeSourceItem({ geographies: ["US", "France"] })];
  const out = assignMetaStoryTags({ metaStory: meta, sourceItems: sources, settings: BASE_SETTINGS });
  // France not in settings → dropped; US kept.
  assert.deepEqual(out.geographies, ["US"]);
});

// ─── Geographies — alias map ─────────────────────────────────────────────────

test("assignMetaStoryTags: alias evidence ('Beijing') emits canonical settings target ('China')", () => {
  const meta = {
    title: "Diplomatic friction",
    subtitle: "Sub.",
    summary: "Officials in Beijing issued a statement late Tuesday.",
  };
  const sources = [makeSourceItem({ headline: "h", body: ["b"] })];
  const out = assignMetaStoryTags({ metaStory: meta, sourceItems: sources, settings: BASE_SETTINGS });
  assert.ok(out.geographies.includes("China"), "Beijing → China when China is in settings");
});

test("assignMetaStoryTags: alias hit does NOT emit when canonical target is absent from settings", () => {
  // Identical evidence as the previous test, but settings drops "China".
  const meta = {
    title: "Diplomatic friction",
    subtitle: "Sub.",
    summary: "Officials in Beijing issued a statement late Tuesday.",
  };
  const settingsWithoutChina = { ...BASE_SETTINGS, geographies: ["US", "Colombia"] };
  const out = assignMetaStoryTags({
    metaStory: meta,
    sourceItems: [makeSourceItem()],
    settings: settingsWithoutChina,
  });
  assert.ok(!out.geographies.includes("China"), "China must not appear when it is absent from settings");
  assert.ok(!out.geographies.includes("Beijing"), "alias token itself must never be emitted");
  assert.deepEqual(out.geographies, []);
});

test("assignMetaStoryTags: alias emission preserves the settings spelling (not the alias map literal)", () => {
  // Settings carries a lowercase "china"; the assigner must emit that exact
  // string rather than the map's Title-Case canonical.
  const meta = { title: "T", summary: "Officials in Beijing met today." };
  const out = assignMetaStoryTags({
    metaStory: meta,
    sourceItems: [makeSourceItem()],
    settings: { topics: [], keywords: [], geographies: ["china"] },
  });
  assert.deepEqual(out.geographies, ["china"]);
});

// ─── Ordering, dedupe, empty-settings invariants ─────────────────────────────

test("assignMetaStoryTags: returns empty arrays on every axis when nothing matches (no fabrication)", () => {
  const out = assignMetaStoryTags({
    metaStory: { title: "Quiet day.", summary: "Nothing notable to report." },
    sourceItems: [makeSourceItem({ headline: "Routine notice.", body: ["Nothing matched."] })],
    settings: BASE_SETTINGS,
  });
  assert.deepEqual(out, { topics: [], keywords: [], geographies: [] });
});

test("assignMetaStoryTags: returns empty axes when a settings list is empty", () => {
  const out = assignMetaStoryTags({
    metaStory: { title: "Diplomatic relations between governments.", summary: "Beijing met today." },
    sourceItems: [makeSourceItem({ topic: "Diplomatic relations", geographies: ["US"] })],
    settings: { topics: [], keywords: [], geographies: [] },
  });
  assert.deepEqual(out, { topics: [], keywords: [], geographies: [] });
});

test("assignMetaStoryTags: dedupes repeated evidence and stable-sorts within each axis", () => {
  // Multiple signals on the same canonical value across sources must collapse
  // to one entry; multiple canonical values must come back locale-sorted.
  const meta = {
    title: "Cross-border update",
    subtitle: "Sub.",
    summary: "Migration policy reforms continue; Diplomatic relations strained.",
  };
  const sources = [
    makeSourceItem({ topic: "Diplomatic relations", geographies: ["US", "Colombia"] }),
    makeSourceItem({ topic: "Diplomatic relations", geographies: ["US"] }),
    makeSourceItem({ topic: "bilateral relations" }), // normalizes to same canonical
  ];
  const out = assignMetaStoryTags({ metaStory: meta, sourceItems: sources, settings: BASE_SETTINGS });
  assert.deepEqual(out.topics, ["Diplomatic relations", "Migration policy"]);
  assert.deepEqual(out.geographies, ["Colombia", "US"]);
});

test("assignMetaStoryTags: never mutates settings or source arrays", () => {
  const settings = {
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US", "China"],
  };
  const settingsSnapshot = JSON.parse(JSON.stringify(settings));
  const sources = [
    makeSourceItem({ topic: "Diplomatic relations", geographies: ["US", "France"], headline: "Beijing meets DC." }),
  ];
  const sourcesSnapshot = JSON.parse(JSON.stringify(sources));
  assignMetaStoryTags({
    metaStory: { title: "T", summary: "Beijing summit." },
    sourceItems: sources,
    settings,
  });
  assert.deepEqual(settings, settingsSnapshot, "settings must not be mutated");
  assert.deepEqual(sources, sourcesSnapshot, "source items must not be mutated");
});
