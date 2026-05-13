import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSupabaseEnabled, getSupabaseClient } from "./client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

function dataDir() {
  return process.env.TEMPO_DATA_DIR ?? path.join(PACKAGE_ROOT, "data");
}

function snapshotFile(userId) {
  return path.join(dataDir(), `dashboard_snapshot_${userId}.json`);
}

function locksFile(userId) {
  return path.join(dataDir(), `meta_story_locks_${userId}.json`);
}

function holdBucketFile(userId) {
  return path.join(dataDir(), `geo_hold_bucket_${userId}.json`);
}

// ─── File adapter ─────────────────────────────────────────────────────────────
//
// `lastCheckedAt` is persisted INSIDE the payload as `_lastCheckedAt` so we
// don't need a separate column / file field.  On read we lift it out of the
// payload and into `_meta.lastCheckedAt` so callers see the same shape regardless
// of storage backend.  Persisted blobs from before this field existed simply
// omit it — clients fall back to `refreshedAt` for display.

function liftSnapshotMeta(payload, refreshed_at) {
  const { _lastCheckedAt, ...rest } = payload ?? {};
  const meta = { refreshedAt: refreshed_at, hasSnapshot: true };
  if (typeof _lastCheckedAt === "string") meta.lastCheckedAt = _lastCheckedAt;
  return { ...rest, _meta: meta };
}

async function readSnapshotFile(userId) {
  try {
    const raw = await fs.readFile(snapshotFile(userId), "utf8");
    const { payload, refreshed_at } = JSON.parse(raw);
    return liftSnapshotMeta(payload, refreshed_at);
  } catch {
    return null;
  }
}

async function writeSnapshotFile(userId, payload) {
  const file = snapshotFile(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ payload, refreshed_at: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

// Narrow update path: bump `_lastCheckedAt` on the persisted payload without
// rewriting `refreshed_at`.  Used by the refresh route on unchanged / in_flight
// branches so a full page reload still reflects the latest check time.
// No-op when the snapshot doesn't exist on disk yet.
async function writeSnapshotMetaFile(userId, { lastCheckedAt }) {
  const file = snapshotFile(userId);
  let parsed;
  try {
    const raw = await fs.readFile(file, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  parsed.payload = { ...parsed.payload, _lastCheckedAt: lastCheckedAt };
  await fs.writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
}

async function readLocksFileRaw(userId) {
  try {
    const raw = await fs.readFile(locksFile(userId), "utf8");
    return JSON.parse(raw); // { [metaStoryId]: { title, subtitle } }
  } catch {
    return {};
  }
}

async function getLockedTitlesFile(userId, metaStoryIds) {
  const all = await readLocksFileRaw(userId);
  const result = new Map();
  for (const id of metaStoryIds) {
    if (all[id]) result.set(id, all[id]);
  }
  return result;
}

async function insertTitleLocksFile(userId, newLocks) {
  const existing = await readLocksFileRaw(userId);
  let changed = false;
  for (const { metaStoryId, title, subtitle } of newLocks) {
    if (!existing[metaStoryId]) {
      existing[metaStoryId] = { title, subtitle };
      changed = true;
    }
  }
  if (changed) {
    const file = locksFile(userId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(existing, null, 2), "utf8");
  }
}

async function readHoldBucketFile(userId) {
  try {
    const raw = await fs.readFile(holdBucketFile(userId), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeHoldBucketFile(userId, items) {
  const file = holdBucketFile(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(items, null, 2), "utf8");
}

// ─── Supabase adapter ─────────────────────────────────────────────────────────

async function readSnapshotSupabase(userId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("dashboard_snapshots")
    .select("payload, refreshed_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`[snapshot-repo] read failed: ${error.message}`);
  if (!data) return null;
  return liftSnapshotMeta(data.payload, data.refreshed_at);
}

async function writeSnapshotSupabase(userId, payload) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("dashboard_snapshots")
    .upsert({ user_id: userId, payload, refreshed_at: new Date().toISOString() });
  if (error) throw new Error(`[snapshot-repo] write failed: ${error.message}`);
}

// Narrow meta update: re-write only the `payload` JSONB column (with
// `_lastCheckedAt` overlaid) and leave `refreshed_at` untouched.  Skipped
// silently when the row is missing — no insert, since `lastCheckedAt` without
// a real prior snapshot is meaningless.
async function writeSnapshotMetaSupabase(userId, { lastCheckedAt }) {
  const supabase = getSupabaseClient();
  const { data, error: readErr } = await supabase
    .from("dashboard_snapshots")
    .select("payload")
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) throw new Error(`[snapshot-repo] meta read failed: ${readErr.message}`);
  if (!data) return;
  const nextPayload = { ...data.payload, _lastCheckedAt: lastCheckedAt };
  const { error } = await supabase
    .from("dashboard_snapshots")
    .update({ payload: nextPayload })
    .eq("user_id", userId);
  if (error) throw new Error(`[snapshot-repo] meta write failed: ${error.message}`);
}

async function getLockedTitlesSupabase(userId, metaStoryIds) {
  if (!metaStoryIds.length) return new Map();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("meta_story_locks")
    .select("meta_story_id, title, subtitle")
    .eq("user_id", userId)
    .in("meta_story_id", metaStoryIds);
  if (error) throw new Error(`[snapshot-repo] locks read failed: ${error.message}`);
  const result = new Map();
  for (const row of data ?? []) {
    result.set(row.meta_story_id, { title: row.title, subtitle: row.subtitle });
  }
  return result;
}

async function readHoldBucketSupabase(userId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("geo_hold_bucket")
    .select("items")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`[snapshot-repo] hold bucket read failed: ${error.message}`);
  return data?.items ?? [];
}

async function writeHoldBucketSupabase(userId, items) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("geo_hold_bucket")
    .upsert({ user_id: userId, items, updated_at: new Date().toISOString() });
  if (error) throw new Error(`[snapshot-repo] hold bucket write failed: ${error.message}`);
}

async function insertTitleLocksSupabase(userId, newLocks) {
  if (!newLocks.length) return;
  const supabase = getSupabaseClient();
  const rows = newLocks.map(({ metaStoryId, title, subtitle }) => ({
    user_id: userId,
    meta_story_id: metaStoryId,
    title,
    subtitle,
  }));
  const { error } = await supabase
    .from("meta_story_locks")
    .upsert(rows, { onConflict: "user_id,meta_story_id", ignoreDuplicates: true });
  if (error) throw new Error(`[snapshot-repo] locks insert failed: ${error.message}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the persisted dashboard snapshot for the user, or null if none exists.
 * The returned object includes _meta.refreshedAt and _meta.hasSnapshot.
 */
export async function readSnapshot(userId) {
  if (isSupabaseEnabled()) return readSnapshotSupabase(userId);
  return readSnapshotFile(userId);
}

/**
 * Persists the dashboard payload for the user (upsert).
 * @param {string} userId
 * @param {object} payload — { contractVersion, stories: [...] }
 */
export async function writeSnapshot(userId, payload) {
  if (isSupabaseEnabled()) return writeSnapshotSupabase(userId, payload);
  return writeSnapshotFile(userId, payload);
}

/**
 * Updates only the `lastCheckedAt` field of an existing snapshot.  Preserves
 * `refreshed_at` and `stories` — designed for refresh outcomes that don't
 * produce a new pipeline result (watermark unchanged, in-flight skip,
 * error fallback) but still represent "we checked your feeds at this time".
 * Silently no-ops when no prior snapshot exists.
 * @param {string} userId
 * @param {{ lastCheckedAt: string }} meta
 */
export async function writeSnapshotMeta(userId, meta) {
  if (isSupabaseEnabled()) return writeSnapshotMetaSupabase(userId, meta);
  return writeSnapshotMetaFile(userId, meta);
}

/**
 * Returns a Map of existing title/subtitle locks for the given meta-story IDs.
 * IDs without a lock are absent from the returned Map.
 * @param {string} userId
 * @param {string[]} metaStoryIds
 * @returns {Promise<Map<string, { title: string, subtitle: string }>>}
 */
export async function getLockedTitles(userId, metaStoryIds) {
  if (isSupabaseEnabled()) return getLockedTitlesSupabase(userId, metaStoryIds);
  return getLockedTitlesFile(userId, metaStoryIds);
}

/**
 * Inserts title/subtitle locks for new meta-stories.
 * Uses ON CONFLICT DO NOTHING semantics — existing locks are never overwritten.
 * @param {string} userId
 * @param {Array<{ metaStoryId: string, title: string, subtitle: string }>} newLocks
 */
export async function insertTitleLocks(userId, newLocks) {
  if (isSupabaseEnabled()) return insertTitleLocksSupabase(userId, newLocks);
  return insertTitleLocksFile(userId, newLocks);
}

/**
 * Returns the geo hold bucket for the user (items below geo-confidence threshold).
 * Returns an empty array when no bucket exists.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function readHoldBucket(userId) {
  if (isSupabaseEnabled()) return readHoldBucketSupabase(userId);
  return readHoldBucketFile(userId);
}

/**
 * Persists the geo hold bucket for the user (replaces previous bucket).
 * @param {string} userId
 * @param {object[]} items
 */
export async function writeHoldBucket(userId, items) {
  if (isSupabaseEnabled()) return writeHoldBucketSupabase(userId, items);
  return writeHoldBucketFile(userId, items);
}
