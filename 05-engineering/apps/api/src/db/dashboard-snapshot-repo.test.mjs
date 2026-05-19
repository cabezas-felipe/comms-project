import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Set TEMPO_DATA_DIR before importing the module so the file adapter resolves
// to an isolated temp directory.
const tmpDir = await mkdtemp(path.join(tmpdir(), "tempo-snapshot-repo-test-"));
process.env.TEMPO_DATA_DIR = tmpDir;
// Ensure Supabase is disabled for these tests.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { readSnapshot, writeSnapshot, writeSnapshotMeta, getLockedTitles, insertTitleLocks, mergeEverSeenMetaStoryIds, extractEverSeenFromSnapshot } = await import(
  "./dashboard-snapshot-repo.mjs"
);

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const USER_ID = "test-user-snapshot";

const SAMPLE_PAYLOAD = {
  contractVersion: "2026-05-19-meta-story-fields",
  stories: [
    {
      id: "story-1",
      metaStoryId: "story-1",
      title: "Test Story",
      subtitle: "A subtitle.",
      geographies: ["US"],
      topic: "Diplomatic relations",
      summary: "Summary.",
      whyItMatters: "Why.",
      whatChanged: "Changed.",
      priority: "standard",
      outletCount: 1,
      // Phase 2: every emitted story carries the three-axis tags object.
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      sources: [],
    },
  ],
};

// ─── readSnapshot / writeSnapshot ─────────────────────────────────────────────

test("readSnapshot: returns null when no snapshot exists", async () => {
  const result = await readSnapshot("no-snapshot-user");
  assert.equal(result, null);
});

test("writeSnapshot + readSnapshot: persists and retrieves payload", async () => {
  await writeSnapshot(USER_ID, SAMPLE_PAYLOAD);
  const result = await readSnapshot(USER_ID);
  assert.ok(result !== null);
  assert.equal(result.contractVersion, SAMPLE_PAYLOAD.contractVersion);
  assert.equal(result.stories.length, 1);
  assert.equal(result.stories[0].title, "Test Story");
});

// Phase 2 trust cleanup: legacy snapshots persisted before the `tags` field
// existed — or with a partial/non-object tags value — must still load.  The
// snapshot loader normalizes them to the three-axis shape at the boundary so
// strict consumers (display schema, dashboard UI) can rely on the contract
// without a destructive write-time migration.
test("readSnapshot: legacy snapshot without story.tags loads with normalized empty tags", async () => {
  const userId = "legacy-no-tags-user";
  const legacyPayload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "legacy-1",
        metaStoryId: "legacy-1",
        title: "Legacy Story",
        subtitle: "Sub.",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "S",
        whyItMatters: "W",
        whatChanged: "C",
        priority: "standard",
        outletCount: 1,
        // No `tags` field on disk (legacy shape).
        sources: [],
      },
    ],
  };
  await writeSnapshot(userId, legacyPayload);
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.deepEqual(result.stories[0].tags, { topics: [], keywords: [], geographies: [] });
});

test("readSnapshot: partial story.tags axes are filled in with empty arrays", async () => {
  const userId = "legacy-partial-tags-user";
  const partialPayload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "partial-1",
        title: "Partial Tags",
        subtitle: "Partial sub.",
        geographies: ["US"],
        summary: "S",
        whyItMatters: "W",
        whatChanged: "C",
        priority: "standard",
        outletCount: 1,
        // Only one axis carried in legacy persistence — others must be filled.
        tags: { topics: ["Diplomatic relations"] },
        sources: [],
      },
    ],
  };
  await writeSnapshot(userId, partialPayload);
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.deepEqual(result.stories[0].tags, {
    topics: ["Diplomatic relations"],
    keywords: [],
    geographies: [],
  });
});

test("readSnapshot: non-object story.tags coerces to empty three-axis shape", async () => {
  const userId = "legacy-bogus-tags-user";
  const bogusPayload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "bogus-1",
        title: "Bogus Tags",
        subtitle: "Bogus sub.",
        geographies: [],
        summary: "S",
        whyItMatters: "W",
        whatChanged: "C",
        priority: "standard",
        outletCount: 0,
        tags: "not-an-object",
        sources: [],
      },
    ],
  };
  await writeSnapshot(userId, bogusPayload);
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.deepEqual(result.stories[0].tags, { topics: [], keywords: [], geographies: [] });
});

// ─── Meta-story fields PR (Prompt 1): legacy takeaway → subtitle adapter ─────

test("readSnapshot: legacy snapshot with `takeaway` and no `subtitle` lifts takeaway into subtitle on load", async () => {
  const userId = "legacy-takeaway-user";
  const legacyPayload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "legacy-takeaway-1",
        title: "Old Story",
        // No subtitle on disk — legacy shape.  `takeaway` carried the
        // one-liner that has since been renamed to `subtitle`.
        takeaway: "Old takeaway used as headline preview.",
        geographies: ["US"],
        summary: "Summary.",
        whyItMatters: "Why.",
        whatChanged: "Changed.",
        priority: "standard",
        outletCount: 1,
        tags: { topics: [], keywords: [], geographies: [] },
        sources: [],
      },
    ],
  };
  await writeSnapshot(userId, legacyPayload);
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.equal(result.stories[0].subtitle, "Old takeaway used as headline preview.");
  // Read adapter must strip `takeaway` so it never leaks back out.
  assert.equal(Object.prototype.hasOwnProperty.call(result.stories[0], "takeaway"), false);
});

test("readSnapshot: legacy snapshot with both `takeaway` and `subtitle` keeps subtitle and drops takeaway", async () => {
  const userId = "legacy-both-user";
  const legacyPayload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "legacy-both-1",
        title: "Coexisting Story",
        subtitle: "Real subtitle.",
        takeaway: "Old leftover takeaway — should be dropped.",
        geographies: ["US"],
        summary: "Summary.",
        whyItMatters: "Why.",
        whatChanged: "Changed.",
        priority: "standard",
        outletCount: 1,
        tags: { topics: [], keywords: [], geographies: [] },
        sources: [],
      },
    ],
  };
  await writeSnapshot(userId, legacyPayload);
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.equal(result.stories[0].subtitle, "Real subtitle.");
  assert.equal(Object.prototype.hasOwnProperty.call(result.stories[0], "takeaway"), false);
});

test("readSnapshot: result includes _meta.hasSnapshot = true", async () => {
  const result = await readSnapshot(USER_ID);
  assert.ok(result !== null);
  assert.equal(result._meta?.hasSnapshot, true);
  assert.ok(typeof result._meta?.refreshedAt === "string");
});

test("writeSnapshot: overwrites existing snapshot on second call", async () => {
  const updated = { ...SAMPLE_PAYLOAD, stories: [] };
  await writeSnapshot(USER_ID, updated);
  const result = await readSnapshot(USER_ID);
  assert.ok(result !== null);
  assert.equal(result.stories.length, 0);
});

// ─── getLockedTitles / insertTitleLocks ───────────────────────────────────────

test("getLockedTitles: returns empty map when no locks exist", async () => {
  const locks = await getLockedTitles("no-locks-user", ["ms-1", "ms-2"]);
  assert.equal(locks.size, 0);
});

test("insertTitleLocks + getLockedTitles: inserts and retrieves title-only locks", async () => {
  const userId = "lock-test-user";
  await insertTitleLocks(userId, [
    { metaStoryId: "ms-alpha", title: "Alpha Title" },
    { metaStoryId: "ms-beta", title: "Beta Title" },
  ]);
  const locks = await getLockedTitles(userId, ["ms-alpha", "ms-beta"]);
  assert.equal(locks.size, 2);
  // Title-only locks: `subtitle` must not appear on the returned shape.
  assert.deepEqual(locks.get("ms-alpha"), { title: "Alpha Title" });
  assert.deepEqual(locks.get("ms-beta"), { title: "Beta Title" });
});

test("getLockedTitles: only returns locks for requested IDs", async () => {
  const userId = "lock-partial-user";
  await insertTitleLocks(userId, [
    { metaStoryId: "ms-1", title: "Story 1" },
    { metaStoryId: "ms-2", title: "Story 2" },
  ]);
  const locks = await getLockedTitles(userId, ["ms-1"]);
  assert.equal(locks.size, 1);
  assert.ok(locks.has("ms-1"));
  assert.ok(!locks.has("ms-2"));
});

test("title lock: second insertTitleLocks does not overwrite existing lock (ON CONFLICT DO NOTHING)", async () => {
  const userId = "lock-immutable-user";
  await insertTitleLocks(userId, [{ metaStoryId: "ms-locked", title: "Original Title" }]);
  // Attempt to overwrite with a different title — must be silently ignored
  await insertTitleLocks(userId, [{ metaStoryId: "ms-locked", title: "New Title" }]);
  const locks = await getLockedTitles(userId, ["ms-locked"]);
  assert.deepEqual(locks.get("ms-locked"), { title: "Original Title" });
});

test("getLockedTitles: legacy lock rows with `subtitle` are projected to title-only on read", async () => {
  // Simulate a lock row written under the old shape (when subtitle was also
  // locked).  The file adapter's read path must strip subtitle so the
  // server-side apply path can't re-freeze it.
  const userId = "legacy-lock-shape-user";
  const fs = await import("node:fs/promises");
  const dataPath = path.join(tmpDir, `meta_story_locks_${userId}.json`);
  await fs.writeFile(
    dataPath,
    JSON.stringify({
      "ms-legacy": { title: "Legacy Title", subtitle: "Legacy Subtitle — should not surface." },
    }),
    "utf8"
  );
  const locks = await getLockedTitles(userId, ["ms-legacy"]);
  assert.deepEqual(locks.get("ms-legacy"), { title: "Legacy Title" });
  assert.equal(
    Object.prototype.hasOwnProperty.call(locks.get("ms-legacy"), "subtitle"),
    false,
    "legacy subtitle must be stripped on read so it can't be applied to refreshed stories"
  );
});

test("insertTitleLocks: no-op for empty array", async () => {
  await assert.doesNotReject(() => insertTitleLocks("any-user", []));
});

test("getLockedTitles: returns empty map for empty IDs array", async () => {
  const locks = await getLockedTitles("any-user", []);
  assert.equal(locks.size, 0);
});

// ─── writeSnapshotMeta / lastCheckedAt round-trip ─────────────────────────────

test("writeSnapshotMeta + readSnapshot: lastCheckedAt round-trips through _meta.lastCheckedAt", async () => {
  const userId = "meta-roundtrip-user";
  await writeSnapshot(userId, SAMPLE_PAYLOAD);
  const initial = await readSnapshot(userId);
  // Initial write doesn't set _lastCheckedAt — server.mjs is responsible for
  // populating it on full runs.  The repo must omit lastCheckedAt rather than
  // back-fill it with refreshed_at, so clients can detect the older shape.
  assert.equal(initial._meta.lastCheckedAt, undefined);

  const checkedAt = "2026-05-12T15:00:00.000Z";
  await writeSnapshotMeta(userId, { lastCheckedAt: checkedAt });
  const after = await readSnapshot(userId);
  assert.equal(after._meta.lastCheckedAt, checkedAt);
  // refreshedAt is preserved by writeSnapshotMeta — only the check stamp moves.
  assert.equal(after._meta.refreshedAt, initial._meta.refreshedAt);
  // Stories unchanged.
  assert.equal(after.stories.length, SAMPLE_PAYLOAD.stories.length);
  // Internal storage key must not leak at the top level — it's lifted into _meta.
  assert.equal(after._lastCheckedAt, undefined);
});

test("writeSnapshotMeta: no-op when no snapshot exists for user", async () => {
  await assert.doesNotReject(() =>
    writeSnapshotMeta("ghost-user", { lastCheckedAt: "2026-05-12T15:00:00.000Z" })
  );
  const result = await readSnapshot("ghost-user");
  assert.equal(result, null);
});

// ─── M3b / P1: _lastRunMeta round-trip ────────────────────────────────────────
//
// Last-run diagnostics (funnel, recall, beatFit, clusterModel, embeddingModel)
// persist inside the payload as `_lastRunMeta` and surface under `_meta.*` on
// read, so `GET /api/dashboard` can explain what happened without re-running
// the pipeline.  Each sub-field is independently optional for backward compat
// with snapshots written before this addition.

test("writeSnapshot + readSnapshot: _lastRunMeta round-trips into _meta.{funnel,recall,beatFit,clusterModel,embeddingModel}", async () => {
  const userId = "lastrun-meta-user";
  const FUNNEL = { executionMode: "full_run", primaryDropStage: "beat_fit", stages: { recall: { in: 10, out: 5 } } };
  const RECALL = { degraded: false, embeddingModel: "text-embedding-3-small" };
  const BEAT_FIT = { version: "v1", enabled: true, threshold: 0.5, recallCount: 5, includedCount: 3, excludedCount: 2, excludeReasonHistogram: {} };
  await writeSnapshot(userId, {
    ...SAMPLE_PAYLOAD,
    _lastRunMeta: {
      funnel: FUNNEL,
      recall: RECALL,
      beatFit: BEAT_FIT,
      clusterModel: "anthropic:claude-sonnet-4-6",
      embeddingModel: "text-embedding-3-small",
    },
  });
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.deepEqual(result._meta.funnel, FUNNEL);
  assert.deepEqual(result._meta.recall, RECALL);
  assert.deepEqual(result._meta.beatFit, BEAT_FIT);
  assert.equal(result._meta.clusterModel, "anthropic:claude-sonnet-4-6");
  assert.equal(result._meta.embeddingModel, "text-embedding-3-small");
  // Internal storage key must not leak at the top level — lifted into _meta.
  assert.equal(result._lastRunMeta, undefined);
});

test("readSnapshot: snapshots without _lastRunMeta omit funnel/recall/beatFit/clusterModel/embeddingModel (backward compat)", async () => {
  const userId = "lastrun-meta-legacy";
  await writeSnapshot(userId, SAMPLE_PAYLOAD);
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "funnel"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "recall"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "beatFit"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "clusterModel"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "embeddingModel"), false);
});

test("readSnapshot: partial _lastRunMeta lifts only the present keys (no undefined placeholders)", async () => {
  const userId = "lastrun-meta-partial";
  await writeSnapshot(userId, {
    ...SAMPLE_PAYLOAD,
    _lastRunMeta: {
      clusterModel: "anthropic:claude-sonnet-4-6",
      embeddingModel: "text-embedding-3-small",
    },
  });
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.equal(result._meta.clusterModel, "anthropic:claude-sonnet-4-6");
  assert.equal(result._meta.embeddingModel, "text-embedding-3-small");
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "funnel"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "recall"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "beatFit"), false);
});

// ─── What-changed Phase 1: ever-seen helpers ─────────────────────────────────

test("mergeEverSeenMetaStoryIds: appends new ids preserving oldest-first order", () => {
  const out = mergeEverSeenMetaStoryIds(["a", "b"], ["c", "d"]);
  assert.deepEqual(out, ["a", "b", "c", "d"]);
});

test("mergeEverSeenMetaStoryIds: dedupes when current overlaps prior; prior keeps its position", () => {
  const out = mergeEverSeenMetaStoryIds(["a", "b", "c"], ["b", "d", "a"]);
  // a/b/c keep their original positions; only "d" is appended.
  assert.deepEqual(out, ["a", "b", "c", "d"]);
});

test("mergeEverSeenMetaStoryIds: empty / null priors are treated as no-history", () => {
  assert.deepEqual(mergeEverSeenMetaStoryIds(null, ["x", "y"]), ["x", "y"]);
  assert.deepEqual(mergeEverSeenMetaStoryIds(undefined, ["x"]), ["x"]);
  assert.deepEqual(mergeEverSeenMetaStoryIds([], ["x"]), ["x"]);
});

test("mergeEverSeenMetaStoryIds: empty / null current preserves prior verbatim", () => {
  assert.deepEqual(mergeEverSeenMetaStoryIds(["a", "b"], []), ["a", "b"]);
  assert.deepEqual(mergeEverSeenMetaStoryIds(["a", "b"], null), ["a", "b"]);
});

test("mergeEverSeenMetaStoryIds: drops non-string / empty entries from either side", () => {
  const out = mergeEverSeenMetaStoryIds(["a", null, "", 42, "b"], ["b", undefined, "c"]);
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("mergeEverSeenMetaStoryIds: dedupes within the current array itself", () => {
  const out = mergeEverSeenMetaStoryIds([], ["x", "x", "y", "x"]);
  assert.deepEqual(out, ["x", "y"]);
});

test("extractEverSeenFromSnapshot: returns array as-is filtering non-strings", () => {
  const snapshot = { _everSeenMetaStoryIds: ["a", "", null, "b", 7, "c"] };
  assert.deepEqual(extractEverSeenFromSnapshot(snapshot), ["a", "b", "c"]);
});

test("extractEverSeenFromSnapshot: returns [] for missing / null / non-array values", () => {
  assert.deepEqual(extractEverSeenFromSnapshot(null), []);
  assert.deepEqual(extractEverSeenFromSnapshot(undefined), []);
  assert.deepEqual(extractEverSeenFromSnapshot({}), []);
  assert.deepEqual(extractEverSeenFromSnapshot({ _everSeenMetaStoryIds: "not-an-array" }), []);
});

test("writeSnapshot + readSnapshot: _lastRunMeta.whatChanged round-trips into _meta.whatChanged", async () => {
  const userId = "whatchanged-meta-roundtrip";
  const WHAT_CHANGED = {
    schemaVersion: "whatchanged-v1",
    firstSeen: 2,
    unchanged: 3,
    changed: 1,
    gateStrong: 1,
    gateWeak: 0,
    gateNone: 5,
    classifySkipped: 5,
    classifyCalled: 1,
    classifyMaterialTrue: 1,
    classifyMaterialFalse: 0,
    writeCalled: 1,
    writeOk: 1,
    llmFailed: { classify: 0, write: 0, hallucination: 0 },
    latencyMs: { classify: 42, write: 113 },
    watermarkShortCircuited: false,
    everSeenCount: 6,
    priorStoryCount: 6,
  };
  await writeSnapshot(userId, {
    ...SAMPLE_PAYLOAD,
    _lastRunMeta: { whatChanged: WHAT_CHANGED },
  });
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.deepEqual(result._meta.whatChanged, WHAT_CHANGED);
  // Backward-compat guard: nothing else in _lastRunMeta should leak when only
  // `whatChanged` was set on write.
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "funnel"), false);
  // Internal storage key must not leak at the top level — lifted into _meta.
  assert.equal(result._lastRunMeta, undefined);
});

test("readSnapshot: snapshots without _lastRunMeta.whatChanged omit _meta.whatChanged (backward compat)", async () => {
  const userId = "whatchanged-meta-legacy";
  await writeSnapshot(userId, SAMPLE_PAYLOAD);
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "whatChanged"), false);
});

test("writeSnapshot + readSnapshot: _everSeenMetaStoryIds round-trips on the snapshot (not in _meta)", async () => {
  const userId = "ever-seen-roundtrip-user";
  await writeSnapshot(userId, {
    ...SAMPLE_PAYLOAD,
    _everSeenMetaStoryIds: ["story-1", "story-2"],
  });
  const result = await readSnapshot(userId);
  assert.ok(result !== null);
  // Internal field is preserved on the top-level snapshot so the route handler
  // can merge it on the next refresh.
  assert.deepEqual(result._everSeenMetaStoryIds, ["story-1", "story-2"]);
  // But it must NOT appear under _meta — _meta is what clients see.
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "everSeenMetaStoryIds"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result._meta, "_everSeenMetaStoryIds"), false);
});
