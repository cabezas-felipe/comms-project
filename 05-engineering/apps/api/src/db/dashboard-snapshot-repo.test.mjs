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

const { readSnapshot, writeSnapshot, writeSnapshotMeta, getLockedTitles, insertTitleLocks } = await import(
  "./dashboard-snapshot-repo.mjs"
);

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const USER_ID = "test-user-snapshot";

const SAMPLE_PAYLOAD = {
  contractVersion: "2026-04-22-slice1",
  stories: [
    {
      id: "story-1",
      metaStoryId: "story-1",
      title: "Test Story",
      subtitle: "A subtitle.",
      geographies: ["US"],
      topic: "Diplomatic relations",
      takeaway: "Takeaway",
      summary: "Summary.",
      whyItMatters: "Why.",
      whatChanged: "Changed.",
      priority: "standard",
      outletCount: 1,
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

test("insertTitleLocks + getLockedTitles: inserts and retrieves locks", async () => {
  const userId = "lock-test-user";
  await insertTitleLocks(userId, [
    { metaStoryId: "ms-alpha", title: "Alpha Title", subtitle: "Alpha subtitle." },
    { metaStoryId: "ms-beta", title: "Beta Title", subtitle: "Beta subtitle." },
  ]);
  const locks = await getLockedTitles(userId, ["ms-alpha", "ms-beta"]);
  assert.equal(locks.size, 2);
  assert.deepEqual(locks.get("ms-alpha"), { title: "Alpha Title", subtitle: "Alpha subtitle." });
  assert.deepEqual(locks.get("ms-beta"), { title: "Beta Title", subtitle: "Beta subtitle." });
});

test("getLockedTitles: only returns locks for requested IDs", async () => {
  const userId = "lock-partial-user";
  await insertTitleLocks(userId, [
    { metaStoryId: "ms-1", title: "Story 1", subtitle: "Sub 1." },
    { metaStoryId: "ms-2", title: "Story 2", subtitle: "Sub 2." },
  ]);
  const locks = await getLockedTitles(userId, ["ms-1"]);
  assert.equal(locks.size, 1);
  assert.ok(locks.has("ms-1"));
  assert.ok(!locks.has("ms-2"));
});

test("title/subtitle lock: second insertTitleLocks does not overwrite existing lock (ON CONFLICT DO NOTHING)", async () => {
  const userId = "lock-immutable-user";
  await insertTitleLocks(userId, [
    { metaStoryId: "ms-locked", title: "Original Title", subtitle: "Original subtitle." },
  ]);
  // Attempt to overwrite with a different title — must be silently ignored
  await insertTitleLocks(userId, [
    { metaStoryId: "ms-locked", title: "New Title", subtitle: "New subtitle." },
  ]);
  const locks = await getLockedTitles(userId, ["ms-locked"]);
  assert.deepEqual(locks.get("ms-locked"), {
    title: "Original Title",
    subtitle: "Original subtitle.",
  });
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
