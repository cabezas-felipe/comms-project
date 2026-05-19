import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WHAT_CHANGED_COPY,
  compareStructuralGate,
  resolveWhatChangedDeterministic,
  trivialNormalizeText,
} from "./what-changed-engine.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Inline buildStory-shaped stories.  Only the fields the gate reads are
// populated — `id`, `metaStoryId`, `title`, `subtitle`, `summary`, and
// `sources[]` with `id`, `outlet`, `headline`, `minutesAgo`.  The gate
// intentionally does not read `topic`, `geographies`, `tags`, `priority`,
// `outletCount`, or `body`, so leaving them off keeps the fixtures terse.

function src(id, outlet, headline, minutesAgo = 10) {
  return { id, outlet, kind: "traditional", weight: 50, url: "https://x", minutesAgo, headline, body: ["b"] };
}

function story({
  metaStoryId = "ms-1",
  title = "Original title",
  subtitle = "Original subtitle.",
  summary = "Original summary.",
  sources = [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
} = {}) {
  return {
    id: metaStoryId,
    metaStoryId,
    title,
    subtitle,
    summary,
    takeaway: summary,
    whyItMatters: subtitle,
    whatChanged: "(placeholder)",
    geographies: [],
    priority: "standard",
    outletCount: sources.length,
    tags: { topics: [], keywords: [], geographies: [] },
    sources,
  };
}

// ─── trivialNormalizeText helper ─────────────────────────────────────────────

test("trivialNormalizeText: collapses whitespace, trims, lowercases", () => {
  assert.equal(trivialNormalizeText("  Hello   WORLD\n"), "hello world");
  assert.equal(trivialNormalizeText(""), "");
  assert.equal(trivialNormalizeText(null), "");
  assert.equal(trivialNormalizeText(undefined), "");
});

// ─── compareStructuralGate: not material → none ──────────────────────────────

test("gate: identical sources/title/subtitle/summary → none", () => {
  const prior = story();
  const current = story();
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: reorder only (swap sources[] order, identical ids/headlines) → none", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
  });
  const current = story({
    // Swapped order; identical id/outlet/headline.
    sources: [src("src-2", "NYT", "Headline B"), src("src-1", "Reuters", "Headline A")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: freshness tick only (minutesAgo changes, headlines identical) → none", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A", 30), src("src-2", "NYT", "Headline B", 45)],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "Headline A", 1), src("src-2", "NYT", "Headline B", 5)],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: tag-only / outletCount-only deltas → none (gate ignores those fields)", () => {
  const prior = story();
  // Mutate fields the gate is supposed to ignore; same evidence otherwise.
  const current = {
    ...story(),
    tags: { topics: ["Diplomatic relations"], keywords: ["OFAC"], geographies: ["US"] },
    outletCount: 99,
    priority: "top",
  };
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

// ─── compareStructuralGate: strong signals ───────────────────────────────────

test("gate: new sourceId + new outlet → strong with both reasons", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Headline A"),
      src("src-2", "NYT", "Headline B"),
      src("src-3", "Bloomberg", "Headline C"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("added_source:src-3"));
  assert.ok(result.reasons.includes("new_outlet:bloomberg"));
});

test("gate: new sourceId from an existing outlet → strong (added_source) but no new_outlet", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Headline A"),
      src("src-2", "NYT", "Headline B"),
      // Same outlet, different real article — no syndication match because
      // the headline differs from any prior Reuters headline.
      src("src-1b", "Reuters", "Headline A — follow-up"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("added_source:src-1b"));
  assert.ok(!result.reasons.some((r) => r.startsWith("new_outlet:")));
});

test("gate: headline change on overlapping id → strong (headline_change)", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Original headline"), src("src-2", "NYT", "Other")],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "Revised headline"), src("src-2", "NYT", "Other")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.deepEqual(result.reasons, ["headline_change:src-1"]);
});

test("gate: trivial headline drift (whitespace + casing) → none, not headline_change", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Original headline"), src("src-2", "NYT", "Other")],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "  ORIGINAL   HEADLINE\n"), src("src-2", "NYT", "Other")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

// ─── compareStructuralGate: weak signals ─────────────────────────────────────

test("gate: removed sourceId only → weak (removed_source)", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "A")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["removed_source:src-2"]);
});

test("gate: summary change only → weak (summary_change)", () => {
  const prior = story({ summary: "Original summary." });
  const current = story({ summary: "Materially different summary." });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["summary_change"]);
});

test("gate: subtitle change only → weak (subtitle_change)", () => {
  const prior = story({ subtitle: "Original subtitle." });
  const current = story({ subtitle: "Subtitle now mentions a new angle." });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["subtitle_change"]);
});

test("gate: title change only → weak (title_change), NOT strong", () => {
  const prior = story({ title: "Original title" });
  const current = story({ title: "Different title under the same lock id" });
  const result = compareStructuralGate(prior, current);
  // Defensive — titles are locked in production, but if the lock is missed
  // we surface it as a weak signal (editorial framing only), never strong.
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["title_change"]);
});

// ─── compareStructuralGate: syndication suppression ──────────────────────────

test("gate: syndication duplicate (new id, same normalized outlet + headline) → none", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Same headline text"), src("src-2", "NYT", "B")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Same headline text"),
      src("src-2", "NYT", "B"),
      // New id, but outlet+headline duplicate of an existing Reuters source.
      src("src-3", "  reuters  ", "SAME HEADLINE TEXT"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: same outlet but a genuinely different headline → strong (not syndication)", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Original Reuters headline")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Original Reuters headline"),
      // Same outlet, different article — not a duplicate.
      src("src-1b", "Reuters", "A genuinely new Reuters story"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("added_source:src-1b"));
  assert.ok(!result.reasons.some((r) => r.startsWith("new_outlet:")));
});

// ─── compareStructuralGate: aggregation ──────────────────────────────────────

test("gate: multiple weak + one strong aggregates to strong; reasons accumulate", () => {
  const prior = story({
    subtitle: "Sub before",
    summary: "Sum before",
    sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")],
  });
  const current = story({
    subtitle: "Sub after",
    summary: "Sum after",
    sources: [
      // src-1 dropped → weak (removed_source:src-1)
      src("src-2", "NYT", "B"),
      // new outlet → strong (added_source + new_outlet)
      src("src-3", "Bloomberg", "C"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("removed_source:src-1"));
  assert.ok(result.reasons.includes("added_source:src-3"));
  assert.ok(result.reasons.includes("new_outlet:bloomberg"));
  assert.ok(result.reasons.includes("summary_change"));
  assert.ok(result.reasons.includes("subtitle_change"));
});

test("gate: new_outlet fires at most once per normalized outlet across multiple new sources", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "A")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "A"),
      // Three new sources from the same brand-new outlet.
      src("src-2", "Bloomberg", "B1"),
      src("src-3", "Bloomberg", "B2"),
      src("src-4", "bloomberg ", "B3"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  const newOutletReasons = result.reasons.filter((r) => r.startsWith("new_outlet:"));
  assert.equal(newOutletReasons.length, 1, "new_outlet must fire exactly once per outlet");
  assert.equal(newOutletReasons[0], "new_outlet:bloomberg");
  // All three new ids still surface their added_source reason.
  assert.ok(result.reasons.includes("added_source:src-2"));
  assert.ok(result.reasons.includes("added_source:src-3"));
  assert.ok(result.reasons.includes("added_source:src-4"));
});

// ─── compareStructuralGate: defensive paths ──────────────────────────────────

test("gate: priorStory === null → { signal: 'none', reasons: [] }", () => {
  const result = compareStructuralGate(null, story());
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: ignores sources with missing id or empty outlet", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "A")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "A"),
      // Missing id — must not contribute added_source / new_outlet.
      { outlet: "Bloomberg", kind: "traditional", weight: 50, url: "https://x", minutesAgo: 10, headline: "X", body: ["b"] },
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

// ─── resolveWhatChangedDeterministic ─────────────────────────────────────────

test("resolver: first-seen (id not in ever-seen) → first-seen copy + gate.signal=none", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-new",
    currentStory: story({ metaStoryId: "ms-new" }),
    priorStory: null,
    everSeenMetaStoryIds: ["ms-1", "ms-2"],
  });
  assert.equal(result.state, "first-seen");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.firstSeen);
  assert.equal(result.gate.signal, "none");
  // Reason convention: tag the first-seen branch explicitly so downstream
  // observability can attribute the state without re-checking the set.
  assert.deepEqual(result.gate.reasons, ["first_seen"]);
});

test("resolver: ever-seen but priorStory absent → unchanged copy (re-entry) + reasons=['no_prior_story']", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: story({ metaStoryId: "ms-1" }),
    priorStory: null,
    everSeenMetaStoryIds: ["ms-1", "ms-2"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "none");
  assert.deepEqual(result.gate.reasons, ["no_prior_story"]);
});

test("resolver: ever-seen + prior + gate none → unchanged copy (spec §10 row 2)", () => {
  const prior = story({ metaStoryId: "ms-1" });
  const current = story({ metaStoryId: "ms-1" });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "none");
  assert.deepEqual(result.gate.reasons, []);
});

test("resolver: ever-seen + prior + reorder only → unchanged copy + gate none (spec §10 row 11)", () => {
  const prior = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")],
  });
  const current = story({
    metaStoryId: "ms-1",
    sources: [src("src-2", "NYT", "B"), src("src-1", "Reuters", "A")],
  });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "none");
});

test("resolver: gate strong in Phase 2 still resolves to unchanged copy (LLM stages deferred)", () => {
  // Spec §10 row 9: headline change on overlapping source → gate strong.
  // Phase 2 doesn't write `changed` prose; the resolver must surface the
  // real gate signal so Phase 3 can branch on it without recomputing.
  const prior = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "Original headline"), src("src-2", "NYT", "Other")],
  });
  const current = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "Revised headline"), src("src-2", "NYT", "Other")],
  });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "strong");
  assert.ok(result.gate.reasons.includes("headline_change:src-1"));
});

test("resolver: ever-seen + prior + gate weak (summary change) → unchanged copy + gate weak preserved", () => {
  const prior = story({ metaStoryId: "ms-1", summary: "before" });
  const current = story({ metaStoryId: "ms-1", summary: "after" });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "weak");
  assert.deepEqual(result.gate.reasons, ["summary_change"]);
});

test("resolver: empty everSeenMetaStoryIds / missing input gracefully resolves to first-seen", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: story({ metaStoryId: "ms-1" }),
    priorStory: null,
    everSeenMetaStoryIds: [],
  });
  assert.equal(result.state, "first-seen");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.firstSeen);
});

test("resolver: handles non-array everSeenMetaStoryIds (treats as empty)", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: story({ metaStoryId: "ms-1" }),
    priorStory: null,
    everSeenMetaStoryIds: null,
  });
  assert.equal(result.state, "first-seen");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.firstSeen);
});
