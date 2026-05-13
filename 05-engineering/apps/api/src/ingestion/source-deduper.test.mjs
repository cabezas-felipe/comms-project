import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeUrl,
  dedupeSourceItems,
  normalizeHeadline,
  PUBLISH_WINDOW_MINUTES,
} from "./source-deduper.mjs";

function makeItem(overrides = {}) {
  return {
    sourceId: "src-1",
    feedId: "feed-1",
    outlet: "Washington Post",
    kind: "traditional",
    weight: 80,
    url: "https://www.washingtonpost.com/news/article-a",
    minutesAgo: 30,
    headline: "Article A",
    body: ["Body of article A."],
    byline: "Reporter",
    ...overrides,
  };
}

// ─── canonicalizeUrl ─────────────────────────────────────────────────────────

test("canonicalizeUrl: lowercases host and drops fragment", () => {
  const c = canonicalizeUrl("HTTPS://Example.COM/path#section");
  assert.equal(c, "https://example.com/path");
});

test("canonicalizeUrl: strips utm_*, fbclid, gclid, mc_*, _ga", () => {
  const c = canonicalizeUrl(
    "https://example.com/x?utm_source=twitter&utm_medium=feed&fbclid=abc&gclid=def&mc_cid=zz&_ga=42&keep=yes"
  );
  assert.equal(c, "https://example.com/x?keep=yes");
});

test("canonicalizeUrl: sorts surviving query keys", () => {
  const a = canonicalizeUrl("https://example.com/x?b=2&a=1");
  const b = canonicalizeUrl("https://example.com/x?a=1&b=2");
  assert.equal(a, b);
});

test("canonicalizeUrl: strips a single trailing slash on non-root paths", () => {
  assert.equal(canonicalizeUrl("https://example.com/foo/"), "https://example.com/foo");
  // Root preserved
  assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
});

test("canonicalizeUrl: returns null for unparsable / non-http inputs", () => {
  assert.equal(canonicalizeUrl(""), null);
  assert.equal(canonicalizeUrl(null), null);
  assert.equal(canonicalizeUrl(undefined), null);
  assert.equal(canonicalizeUrl("not a url"), null);
  assert.equal(canonicalizeUrl("ftp://example.com/foo"), null);
});

// ─── normalizeHeadline ───────────────────────────────────────────────────────

test("normalizeHeadline: lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(
    normalizeHeadline("  Trump,  Petro Meet — Discuss   New Deal!  "),
    "trump petro meet discuss new deal"
  );
});

test("normalizeHeadline: smart quotes and curly apostrophes normalize to straight", () => {
  // After punctuation stripping the apostrophe is gone either way; what
  // matters is that the two variants normalize to the same string.
  assert.equal(
    normalizeHeadline("Petro’s response"),
    normalizeHeadline("Petro's response")
  );
  assert.equal(
    normalizeHeadline("“Breaking” update"),
    normalizeHeadline('"Breaking" update')
  );
});

test("normalizeHeadline: returns '' for missing / non-string input", () => {
  assert.equal(normalizeHeadline(undefined), "");
  assert.equal(normalizeHeadline(null), "");
  assert.equal(normalizeHeadline(""), "");
  assert.equal(normalizeHeadline("   "), "");
  assert.equal(normalizeHeadline(42), "");
});

// ─── Strict merge rule: URL + headline + time window ─────────────────────────

test("merge: canonical URL + exact normalized headline + time within window collapses", () => {
  const items = [
    makeItem({ sourceId: "wp-nat-1", feedId: "wp-national", minutesAgo: 32 }),
    makeItem({ sourceId: "wp-world-1", feedId: "wp-world", minutesAgo: 30 }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.unique[0]._duplicates.length, 1);
});

test("merge: tracking-param differences do not prevent URL+headline match", () => {
  const items = [
    makeItem({
      sourceId: "a",
      url: "https://example.com/x?utm_source=feed-a",
    }),
    makeItem({
      sourceId: "b",
      url: "https://example.com/x?utm_source=feed-b&fbclid=zzz",
    }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
});

test("merge: cross-publisher merge is allowed when URL+headline+time-window match", () => {
  // Same canonical URL surfaced under two different outlet names (e.g. a
  // syndicated wire piece preserved at the same URL).  Strict-mode policy
  // permits cross-outlet merging when the URL+headline+time gate passes —
  // outlet identity is not itself a gate.
  const items = [
    makeItem({
      sourceId: "reuters-1",
      feedId: "reuters",
      outlet: "Reuters",
      url: "https://wire.example.com/story",
      headline: "Shared wire headline",
      minutesAgo: 20,
    }),
    makeItem({
      sourceId: "ap-1",
      feedId: "ap",
      outlet: "AP",
      url: "https://wire.example.com/story",
      headline: "Shared wire headline",
      minutesAgo: 25,
    }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.duplicateCount, 1);
});

// ─── No-merge guards (strict policy) ─────────────────────────────────────────

test("no-merge: canonical URL matches but normalized headlines differ", () => {
  // Same URL recycled to host two distinct pieces — headline disagreement is
  // the signal that we must not merge.
  const items = [
    makeItem({
      sourceId: "a",
      url: "https://example.com/recycled",
      headline: "Trump and Petro discuss tariffs",
    }),
    makeItem({
      sourceId: "b",
      url: "https://example.com/recycled",
      headline: "Different article entirely",
    }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicateCount, 0);
});

test("no-merge: canonical URL + headline match but |Δ minutesAgo| > PUBLISH_WINDOW_MINUTES", () => {
  // Window guard: same URL+headline at far-apart times implies a long-delayed
  // republish or a URL recycle, not a same-tick syndication. Stay distinct.
  const items = [
    makeItem({
      sourceId: "early",
      url: "https://example.com/timely",
      headline: "Shared headline",
      minutesAgo: 10,
    }),
    makeItem({
      sourceId: "late",
      url: "https://example.com/timely",
      headline: "Shared headline",
      minutesAgo: 10 + PUBLISH_WINDOW_MINUTES + 5,
    }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 2, "items outside the time window must not merge");
  assert.equal(result.duplicateCount, 0);
});

test("no-merge: identical headlines but different canonical URLs do NOT merge", () => {
  const items = [
    makeItem({
      sourceId: "a",
      url: "https://example.com/a",
      headline: "More of the men being deported now have lived in the U.S. for years.",
    }),
    makeItem({
      sourceId: "b",
      url: "https://example.com/b",
      headline: "More of the men being deported now have lived in the U.S. for years.",
    }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 2, "title-only match must not collapse distinct URLs");
});

test("no-merge: different paths on same host stay distinct", () => {
  const items = [
    makeItem({ sourceId: "a", url: "https://example.com/news/article-a" }),
    makeItem({ sourceId: "b", url: "https://example.com/news/article-b" }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 2);
});

test("no-merge: same path different host stays distinct", () => {
  const items = [
    makeItem({ sourceId: "wp", url: "https://www.washingtonpost.com/x" }),
    makeItem({ sourceId: "ap", url: "https://www.apnews.com/x" }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 2);
});

// ─── No-URL items: merge on exact normalized headline only ───────────────────

test("no-URL merge: exact normalized headline collapses to one (no time gate)", () => {
  const items = [
    makeItem({ sourceId: "a", url: "", headline: "Same Headline Text" }),
    makeItem({ sourceId: "b", url: "", headline: "Same Headline Text" }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.duplicateCount, 1);
});

test("no-URL merge: tolerates punctuation / case / whitespace variance via normalizeHeadline", () => {
  const items = [
    makeItem({ sourceId: "a", url: "", headline: "  Petro’s   response! " }),
    makeItem({ sourceId: "b", url: "not a url", headline: "Petro's response" }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
});

test("no-URL items with different headlines stay singletons", () => {
  const items = [
    makeItem({ sourceId: "a", url: "", headline: "Headline one" }),
    makeItem({ sourceId: "b", url: "", headline: "Headline two" }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicateCount, 0);
});

test("no-URL items with empty headlines never merge (insufficient signal)", () => {
  const items = [
    makeItem({ sourceId: "a", url: "", headline: "" }),
    makeItem({ sourceId: "b", url: "", headline: "   " }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicateCount, 0);
});

// ─── Tie-break order: evidence → freshness → weight → feedId → sourceId ──────

test("tie-break: richer evidence wins when freshness/weight equal", () => {
  // Both items share canonical URL + same default headline + same minutesAgo
  // → in one merge cluster.  Evidence richness is the first tie-break.
  const items = [
    makeItem({
      sourceId: "thin",
      body: ["one"],
      byline: "",
    }),
    makeItem({
      sourceId: "rich",
      body: ["this is a much longer body with substantially more text content"],
      byline: "Named Reporter",
    }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.unique[0].sourceId, "rich");
});

test("tie-break: fresher minutesAgo wins when evidence tied (and within window)", () => {
  // Both items: same canonical URL, same default headline.  Bodies and bylines
  // identical → evidence richness equal.  |Δ minutesAgo| = 40 ≤ PUBLISH_WINDOW_MINUTES
  // so they DO merge; the fresher one (smaller minutesAgo) wins.
  const items = [
    makeItem({ sourceId: "older", minutesAgo: 50, body: ["same"], byline: "" }),
    makeItem({ sourceId: "fresher", minutesAgo: 10, body: ["same"], byline: "" }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.unique[0].sourceId, "fresher");
});

test("tie-break: higher feed weight wins when evidence and freshness tied", () => {
  const base = { minutesAgo: 30, body: ["same"], byline: "" };
  const items = [
    makeItem({ sourceId: "a", feedId: "f-a", weight: 50, ...base }),
    makeItem({ sourceId: "b", feedId: "f-b", weight: 90, ...base }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.unique[0].sourceId, "b");
});

test("tie-break: feedId lex wins when evidence, freshness, weight tied", () => {
  const base = { minutesAgo: 30, body: ["same"], byline: "", weight: 80 };
  const items = [
    makeItem({ sourceId: "src-1", feedId: "feed-zz", ...base }),
    makeItem({ sourceId: "src-2", feedId: "feed-aa", ...base }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.unique[0].feedId, "feed-aa");
});

test("tie-break: sourceId lex is the final guaranteed tiebreaker", () => {
  const base = {
    feedId: "feed-shared",
    weight: 80,
    minutesAgo: 30,
    body: ["same"],
    byline: "",
  };
  const items = [
    makeItem({ sourceId: "src-zz", ...base }),
    makeItem({ sourceId: "src-aa", ...base }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(result.unique[0].sourceId, "src-aa");
});

// ─── Determinism / idempotence ───────────────────────────────────────────────

test("determinism: shuffled input produces the same canonical winner", () => {
  const a = makeItem({
    sourceId: "a",
    feedId: "f-a",
    weight: 50,
    minutesAgo: 40,
    body: ["short"],
  });
  const b = makeItem({
    sourceId: "b",
    feedId: "f-b",
    weight: 90,
    minutesAgo: 10,
    body: ["this body is longer to win evidence richness handily"],
  });
  const c = makeItem({
    sourceId: "c",
    feedId: "f-c",
    weight: 70,
    minutesAgo: 30,
    body: ["medium body text"],
  });
  // All three share the default canonical URL + default headline, and all
  // pairwise gaps are ≤ PUBLISH_WINDOW_MINUTES → single merge cluster.
  const orderings = [
    [a, b, c],
    [c, a, b],
    [b, c, a],
    [c, b, a],
  ];
  const winners = orderings.map((ordering) => dedupeSourceItems(ordering).unique[0].sourceId);
  for (const w of winners) assert.equal(w, "b");
});

test("determinism: items at time-window boundary cluster identically regardless of input order", () => {
  // Three items all sharing URL+headline; minutesAgo 0, PUBLISH_WINDOW_MINUTES,
  // PUBLISH_WINDOW_MINUTES + 1.  First two within window; third just outside.
  const inWindow1 = makeItem({ sourceId: "in1", minutesAgo: 0, body: ["x"], byline: "" });
  const inWindow2 = makeItem({
    sourceId: "in2",
    minutesAgo: PUBLISH_WINDOW_MINUTES,
    body: ["x"],
    byline: "",
  });
  const outside = makeItem({
    sourceId: "out",
    minutesAgo: PUBLISH_WINDOW_MINUTES + 1,
    body: ["x"],
    byline: "",
  });
  const orderings = [
    [inWindow1, inWindow2, outside],
    [outside, inWindow1, inWindow2],
    [inWindow2, outside, inWindow1],
  ];
  for (const ord of orderings) {
    const result = dedupeSourceItems(ord);
    // in1+in2 merge (gap == window), out stays singleton → 2 emitted groups
    assert.equal(result.unique.length, 2);
    assert.equal(result.duplicateCount, 1);
    const survivors = result.unique.map((u) => u.sourceId).sort();
    assert.deepEqual(survivors, ["in1", "out"]);
  }
});

test("time window is anchor-based strict, NOT chain/transitive: [0, 50, 100] with window=60 → 2 clusters", () => {
  // Three items sharing canonical URL + normalized headline; minutesAgo = 0,
  // 50, 100.  With PUBLISH_WINDOW_MINUTES=60 the policy is anchor-based
  // strict: the first item (minutesAgo=0) anchors cluster A; 50 joins
  // (50-0=50 ≤ 60); 100 does NOT join cluster A (100-0=100 > 60) and seeds
  // cluster B as its own anchor.
  //
  // A chain/transitive interpretation (forbidden) would have folded all
  // three into one cluster — 0↔50 close, 50↔100 close — even though the 0
  // and 100 items are 100 minutes apart, violating the close-window
  // guarantee.  The MVP posture is false-merge-averse: this test pins the
  // strict semantics so a future refactor toward chain-merging is a
  // deliberate, visible change.
  //
  // Hard-coded minutesAgo (rather than expressing in terms of
  // PUBLISH_WINDOW_MINUTES) to keep the cluster-boundary math obvious.
  assert.equal(PUBLISH_WINDOW_MINUTES, 60, "test pins behavior at window=60");
  const items = [
    makeItem({ sourceId: "t0",   minutesAgo: 0,   body: ["x"], byline: "" }),
    makeItem({ sourceId: "t50",  minutesAgo: 50,  body: ["x"], byline: "" }),
    makeItem({ sourceId: "t100", minutesAgo: 100, body: ["x"], byline: "" }),
  ];
  const result = dedupeSourceItems(items);

  // ── Shape ────────────────────────────────────────────────────────────────
  assert.equal(result.unique.length, 2, "anchor-strict: {t0,t50} merge; {t100} singleton");
  assert.equal(result.duplicateCount, 1, "exactly one fold (t50 → t0); t100 is NOT chain-merged");

  // ── Survivor identity ────────────────────────────────────────────────────
  // Output order is first-seen of each emitted cluster.  Cluster A emerges
  // first (it contains the first-seen key, anchored at t0) and Cluster B
  // (t100) emerges after.
  const survivorIds = result.unique.map((u) => u.sourceId);
  assert.deepEqual(
    survivorIds,
    ["t0", "t100"],
    "cluster A winner first (t0, fresher of the merged pair), then singleton t100"
  );

  // ── Cluster A: explicit winner + provenance ──────────────────────────────
  // Body / byline / weight all identical between t0 and t50; evidence
  // richness tie → tie-break falls through to freshness → t0 (minutesAgo=0)
  // beats t50 (minutesAgo=50).
  const clusterAWinner = result.unique[0];
  assert.equal(clusterAWinner.sourceId, "t0", "freshness tie-break elects t0 within {t0, t50}");
  assert.ok(Array.isArray(clusterAWinner._duplicates));
  assert.equal(clusterAWinner._duplicates.length, 1, "exactly one loser folded into the winner");
  assert.equal(
    clusterAWinner._duplicates[0].sourceId,
    "t50",
    "t50 must be the recorded loser — proving it joined cluster A, not cluster B"
  );

  // ── Cluster B: singleton, no provenance ──────────────────────────────────
  // The chain-merge interpretation would have folded t100 INTO cluster A
  // and erased it from the unique list; under anchor-strict it must be its
  // own singleton with no `_duplicates` attached.
  const clusterBSingleton = result.unique[1];
  assert.equal(clusterBSingleton.sourceId, "t100");
  assert.equal(
    Object.prototype.hasOwnProperty.call(clusterBSingleton, "_duplicates"),
    false,
    "t100 is a singleton — must NOT carry _duplicates"
  );
});

// ─── Provenance ──────────────────────────────────────────────────────────────

test("winner carries _duplicates with loser provenance (internal-only)", () => {
  const items = [
    makeItem({
      sourceId: "wp-nat-1",
      feedId: "wp-national",
      outlet: "Washington Post — National",
      weight: 90,
      body: ["short"],
      byline: "",
    }),
    makeItem({
      sourceId: "wp-world-1",
      feedId: "wp-world",
      outlet: "Washington Post — World",
      weight: 90,
      body: ["a longer body wins evidence richness"],
      byline: "",
    }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  const winner = result.unique[0];
  assert.equal(winner.sourceId, "wp-world-1");
  assert.equal(winner._duplicates.length, 1);
  assert.equal(winner._duplicates[0].sourceId, "wp-nat-1");
  assert.equal(winner._duplicates[0].feedId, "wp-national");
  assert.equal(winner._duplicates[0].outlet, "Washington Post — National");
});

test("output is free of internal _canonicalUrl / _normHeadline annotations", () => {
  const items = [
    makeItem({ sourceId: "solo", url: "https://example.com/x", headline: "Solo headline" }),
  ];
  const result = dedupeSourceItems(items);
  assert.equal(result.unique.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.unique[0], "_canonicalUrl"),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.unique[0], "_normHeadline"),
    false
  );
});
