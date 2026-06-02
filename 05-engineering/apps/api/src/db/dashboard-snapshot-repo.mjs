import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "../contracts-runtime/index.mjs";
import { isSupabaseEnabled, getSupabaseClient } from "./client.mjs";

/** Dashboard contract versions we lift to `CONTRACT_VERSION` on read. */
const LEGACY_DASHBOARD_CONTRACT_VERSIONS = new Set(["2026-04-22-slice1"]);

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
//
// `_lastRunMeta` (M3b / P1) carries last-run diagnostics (funnel, recall,
// beatFit, clusterModel, embeddingModel) so `GET /api/dashboard` can explain
// what happened without re-running the pipeline.  Lifted into `_meta.*` on
// read.  Older snapshots without it simply omit those keys.

// Phase 2 trust cleanup: emitted payloads must always carry `story.tags` with
// the three-axis shape (`{ topics, keywords, geographies }`).  Older snapshots
// persisted before Phase 1/2 may pre-date the `tags` field or carry a partial
// shape (e.g. only `topics`).  This normalizer runs at the load boundary so
// the strict display schema can assume the shape — no destructive migration,
// just a read-time coercion to empty arrays where evidence is absent.  String
// axes are filtered to keep only string entries; unknown payload shapes pass
// through with safe empty defaults rather than crashing the dashboard read.
function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string");
}

function normalizeStoryTags(tags) {
  const t = tags && typeof tags === "object" ? tags : {};
  return {
    topics: normalizeStringArray(t.topics),
    keywords: normalizeStringArray(t.keywords),
    geographies: normalizeStringArray(t.geographies),
  };
}

// Meta-story fields PR (Prompt 1): the emitted contract removed `takeaway`
// and made `subtitle` required.  Legacy snapshots (pre-bump) carry a
// `takeaway` string and may not carry `subtitle`.  Migrate at the load
// boundary so the strict display schema can assume the new shape:
//   - If `subtitle` is missing/empty and `takeaway` is present, lift
//     `takeaway` into `subtitle`.
//   - Always drop the `takeaway` key on load so it never round-trips back
//     to disk (writes already omit it; this prevents it leaking out via
//     intermediate updates).
function migrateLegacyTakeaway(story) {
  if (!story || typeof story !== "object") return story;
  const { takeaway, subtitle, ...rest } = story;
  const hasSubtitle = typeof subtitle === "string" && subtitle.length > 0;
  if (hasSubtitle) return { ...rest, subtitle };
  if (typeof takeaway === "string" && takeaway.length > 0) {
    return { ...rest, subtitle: takeaway };
  }
  return { ...rest, subtitle };
}

function normalizeStoriesForLoad(stories) {
  if (!Array.isArray(stories)) return [];
  return stories.map((s) => {
    if (!s || typeof s !== "object") return s;
    const migrated = migrateLegacyTakeaway(s);
    return { ...migrated, tags: normalizeStoryTags(migrated.tags) };
  });
}

/**
 * Lift legacy dashboard snapshot root `contractVersion` so persisted blobs
 * written before the meta-story fields PR still pass strict validation on GET.
 * Story-level `takeaway` → `subtitle` is handled separately in
 * `migrateLegacyTakeaway`.
 */
function migrateLegacyContractVersion(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const version = payload.contractVersion;
  if (version === CONTRACT_VERSION) return payload;
  if (typeof version === "string" && LEGACY_DASHBOARD_CONTRACT_VERSIONS.has(version)) {
    return { ...payload, contractVersion: CONTRACT_VERSION };
  }
  return payload;
}

function liftSnapshotMeta(payload, refreshed_at) {
  const migratedPayload = migrateLegacyContractVersion(payload);
  const { _lastCheckedAt, _lastRunMeta, stories, ...rest } = migratedPayload ?? {};
  const meta = { refreshedAt: refreshed_at, hasSnapshot: true };
  if (typeof _lastCheckedAt === "string") meta.lastCheckedAt = _lastCheckedAt;
  if (_lastRunMeta && typeof _lastRunMeta === "object") {
    if (_lastRunMeta.funnel !== undefined) meta.funnel = _lastRunMeta.funnel;
    if (_lastRunMeta.recall !== undefined) meta.recall = _lastRunMeta.recall;
    // Slice 14: translation-first normalization diagnostics. Optional for
    // backward compat with snapshots written before the translation stage.
    if (_lastRunMeta.translation !== undefined) meta.translation = _lastRunMeta.translation;
    if (_lastRunMeta.beatFit !== undefined) meta.beatFit = _lastRunMeta.beatFit;
    if (_lastRunMeta.clusterModel !== undefined) meta.clusterModel = _lastRunMeta.clusterModel;
    if (_lastRunMeta.embeddingModel !== undefined) meta.embeddingModel = _lastRunMeta.embeddingModel;
    // Clustering fail-closed diagnostics (Slice 1): surface timeout/error
    // reason, attempt count, and per-attempt latency on dashboard reads.
    // Optional for back-compat with snapshots written before Slice 1.
    if (_lastRunMeta.usedFallbackClustering !== undefined) meta.usedFallbackClustering = _lastRunMeta.usedFallbackClustering;
    if (_lastRunMeta.clusteringFailureReason !== undefined) meta.clusteringFailureReason = _lastRunMeta.clusteringFailureReason;
    if (_lastRunMeta.clusteringAttempts !== undefined) meta.clusteringAttempts = _lastRunMeta.clusteringAttempts;
    if (_lastRunMeta.clusteringLatencyMs !== undefined) meta.clusteringLatencyMs = _lastRunMeta.clusteringLatencyMs;
    // Phase 4: per-axis semantic tag-mapping aggregate (topics + keywords)
    // + the `geographies.semanticApplied: false` lock stamp.  Optional for
    // backward compat with snapshots written before Phase 4.
    if (_lastRunMeta.tags !== undefined) meta.tags = _lastRunMeta.tags;
    // What-changed (Phase 4) run-level diagnostics: first-seen / unchanged /
    // changed counts plus LLM / gate signal breakdowns.  Optional for
    // backward compat with snapshots written before the delta engine
    // shipped.
    if (_lastRunMeta.whatChanged !== undefined) meta.whatChanged = _lastRunMeta.whatChanged;
    // Why-this-matters (Phase 5) run-level diagnostics: pass / fallback /
    // lowConfidence counts plus writer-stage latency.  Optional for
    // backward compat with snapshots written before the implications
    // writer shipped.
    if (_lastRunMeta.whyItMatters !== undefined) meta.whyItMatters = _lastRunMeta.whyItMatters;
    // Slice 5: progressive whyItMatters enrichment state (deferred / pending /
    // completed / total / upgradeLatencyMs).  Surfaced on GET so the client's
    // poll loop can read `_meta.whyEnrichment.pending` and stop at 0.  Optional
    // for backward compat with snapshots written before Slice 5.
    if (_lastRunMeta.whyEnrichment !== undefined) meta.whyEnrichment = _lastRunMeta.whyEnrichment;
    // Slice 7: per-stage wall-clock timings (ingestion + pipeline). Optional —
    // absent on pre-Slice-7 snapshots, so older reads simply omit the key.
    if (_lastRunMeta.timings !== undefined) meta.timings = _lastRunMeta.timings;
    // Slice 3: run-level outcome rollup + the server-resolved ingestion source.
    // Optional for back-compat with snapshots written before Slice 3.
    if (_lastRunMeta.outcomes !== undefined) meta.outcomes = _lastRunMeta.outcomes;
    if (_lastRunMeta.ingestionSource !== undefined) meta.ingestionSource = _lastRunMeta.ingestionSource;
  }
  // `_everSeenMetaStoryIds` (what-changed history set) and
  // `_whyItMattersTraces` (why-this-matters trace map) pass through via
  // `...rest` so the route handler can read them off the returned
  // snapshot for the next refresh (history merge + watermark replay).
  // Intentionally NOT lifted into `_meta` — both are internal-only;
  // `stripPersistedFields` in server.mjs is the gate that removes them
  // before responding.
  return { ...rest, stories: normalizeStoriesForLoad(stories), _meta: meta };
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
    return JSON.parse(raw); // { [metaStoryId]: { title } } — legacy rows may also carry `subtitle`
  } catch {
    return {};
  }
}

// Meta-story fields PR (Prompt 1): locks are title-only.  Legacy rows may
// still carry a `subtitle` key from before this PR; strip it on read so the
// server-side apply path can't accidentally re-freeze subtitle copy.
function projectTitleLock(row) {
  if (!row || typeof row !== "object") return null;
  if (typeof row.title !== "string" || row.title.length === 0) return null;
  return { title: row.title };
}

async function getLockedTitlesFile(userId, metaStoryIds) {
  const all = await readLocksFileRaw(userId);
  const result = new Map();
  for (const id of metaStoryIds) {
    const lock = projectTitleLock(all[id]);
    if (lock) result.set(id, lock);
  }
  return result;
}

async function insertTitleLocksFile(userId, newLocks) {
  const existing = await readLocksFileRaw(userId);
  let changed = false;
  for (const { metaStoryId, title } of newLocks) {
    if (!existing[metaStoryId]) {
      existing[metaStoryId] = { title };
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
  // Title-only locks (meta-story fields PR — Prompt 1).  We only `SELECT title`
  // so legacy rows whose `subtitle` column still carries data are silently
  // ignored on read.  Migration 016 makes the column nullable so future
  // writes can stop populating it.
  const { data, error } = await supabase
    .from("meta_story_locks")
    .select("meta_story_id, title")
    .eq("user_id", userId)
    .in("meta_story_id", metaStoryIds);
  if (error) throw new Error(`[snapshot-repo] locks read failed: ${error.message}`);
  const result = new Map();
  for (const row of data ?? []) {
    if (typeof row.title === "string" && row.title.length > 0) {
      result.set(row.meta_story_id, { title: row.title });
    }
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
  // Title-only insert (meta-story fields PR — Prompt 1).  Migration 016
  // drops the NOT NULL constraint on `subtitle` so it can stay unset for
  // new rows.  Legacy rows are not rewritten.
  const rows = newLocks.map(({ metaStoryId, title }) => ({
    user_id: userId,
    meta_story_id: metaStoryId,
    title,
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
 * Returns a Map of existing title locks for the given meta-story IDs.
 * Title-only locks (meta-story fields PR — Prompt 1): legacy rows that also
 * stored a `subtitle` are projected to `{ title }` on read.  IDs without a
 * lock are absent from the returned Map.
 * @param {string} userId
 * @param {string[]} metaStoryIds
 * @returns {Promise<Map<string, { title: string }>>}
 */
export async function getLockedTitles(userId, metaStoryIds) {
  if (isSupabaseEnabled()) return getLockedTitlesSupabase(userId, metaStoryIds);
  return getLockedTitlesFile(userId, metaStoryIds);
}

/**
 * Inserts title locks for new meta-stories.  Title-only since the meta-story
 * fields PR — subtitle is intentionally NOT locked so clustering context can
 * re-render every refresh.  Uses ON CONFLICT DO NOTHING semantics — existing
 * locks are never overwritten.
 * @param {string} userId
 * @param {Array<{ metaStoryId: string, title: string }>} newLocks
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

// ─── What-changed: ever-seen meta-story id set ───────────────────────────────
//
// The persisted snapshot payload carries `_everSeenMetaStoryIds: string[]` —
// the union of every `metaStoryId` ever shipped on this user's dashboard.
// Drives the "first-seen" branch of the delta engine.  The field lives on
// the payload alongside `_watermark` / `_selectionMeta` / `_lastCheckedAt`;
// `stripPersistedFields` in server.mjs strips it before responding to
// clients so history scope never leaks.  See `docs/what-changed-spec.md` §4.

/**
 * Reads the ever-seen `metaStoryId` array off a loaded snapshot. Defensive:
 * filters to strings so a corrupt persisted blob can't surface non-string
 * entries into the in-memory set.
 *
 * @param {object|null|undefined} snapshot — result of `readSnapshot(userId)`
 * @returns {string[]}
 */
export function extractEverSeenFromSnapshot(snapshot) {
  const raw = snapshot?._everSeenMetaStoryIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * Merges the prior ever-seen array with the current run's metaStoryIds.
 * Deduplicates while preserving insertion order (oldest-first per spec §4):
 * prior ids keep their original positions; new ids are appended in the order
 * the current refresh emitted them.
 *
 * @param {string[]|null|undefined} priorIds
 * @param {Array<string|null|undefined>} currentMetaStoryIds
 * @returns {string[]}
 */
export function mergeEverSeenMetaStoryIds(priorIds, currentMetaStoryIds) {
  const seen = new Set();
  const out = [];
  const append = (id) => {
    if (typeof id !== "string" || id.length === 0) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  if (Array.isArray(priorIds)) for (const id of priorIds) append(id);
  if (Array.isArray(currentMetaStoryIds)) for (const id of currentMetaStoryIds) append(id);
  return out;
}
