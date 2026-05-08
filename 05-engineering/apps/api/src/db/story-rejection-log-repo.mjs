// Internal rejection log for stories dropped during grounding verification.
// Phase 3 (strict trust posture) drops any story with a grounding failure
// from the dashboard payload.  Those drops are persisted here — separate
// from `dashboard_snapshots` and never exposed to clients — so they can be
// analyzed offline (which prompts hallucinate, which evidence maps fail, etc.).
//
// Persistence:
//   - File adapter:    data/story_rejections_{userId}.json (rolling array,
//                      capped at MAX_RETAINED most-recent entries to bound
//                      growth in dev/test setups).
//   - Supabase adapter: story_rejections table (append-only inserts; retention
//                      managed at the DB layer if/when needed).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isSupabaseEnabled, getSupabaseClient } from "./client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

const MAX_RETAINED = 200;

function dataDir() {
  return process.env.TEMPO_DATA_DIR ?? path.join(PACKAGE_ROOT, "data");
}

function rejectionsFile(userId) {
  return path.join(dataDir(), `story_rejections_${userId}.json`);
}

// ─── File adapter ─────────────────────────────────────────────────────────────

async function readRejectionsFile(userId) {
  try {
    const raw = await fs.readFile(rejectionsFile(userId), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Stable identity for a rejected story.  Prefers `meta_story_id` when present;
 * otherwise falls back to a deterministic hash over the (sorted, deduped)
 * `source_item_ids`.  The fallback prevents two distinct rejected stories in
 * the same run from collapsing into one dedup key when the model didn't yet
 * assign a meta_story_id.
 *
 * Returns "" only when both meta_story_id is missing AND there are no source
 * IDs to hash — in which case the dedup key still carries reason+watermark
 * which are sufficient for in-run uniqueness in that degenerate edge case.
 */
export function storyIdentity(record) {
  const id = record?.meta_story_id;
  if (id != null && String(id).trim()) return String(id).trim();
  const ids = Array.isArray(record?.source_item_ids)
    ? record.source_item_ids.map((x) => String(x ?? "")).filter(Boolean)
    : [];
  if (ids.length === 0) return "";
  const sorted = [...new Set(ids)].sort().join(",");
  return "src:" + createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

/**
 * Stable dedup key (Phase 4): `storyIdentity|reason|watermark`.
 * Records sharing this key within the retention window are coalesced — a
 * watermark-stable refresh that re-encounters the same failure does not
 * generate duplicate rejection rows.  When meta_story_id is missing, the
 * identity falls back to a hash of the source_item_ids so distinct stories
 * cannot accidentally share a key.
 */
export function dedupKey(record) {
  return [
    storyIdentity(record),
    record?.reason_code ?? "",
    record?.watermark ?? "",
  ].join("|");
}

async function appendRejectionsFile(userId, newRecords) {
  if (!Array.isArray(newRecords) || newRecords.length === 0) {
    return { inserted: 0, deduped: 0 };
  }
  const existing = await readRejectionsFile(userId);
  const seenKeys = new Set(existing.map(dedupKey));
  let deduped = 0;
  const inserted = [];
  for (const r of newRecords) {
    const k = dedupKey(r);
    if (seenKeys.has(k)) {
      deduped++;
      continue;
    }
    seenKeys.add(k);
    inserted.push(r);
  }
  if (inserted.length === 0) return { inserted: 0, deduped };
  // Newest first; keep only MAX_RETAINED to avoid unbounded growth.
  const combined = [...inserted, ...existing].slice(0, MAX_RETAINED);
  const file = rejectionsFile(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(combined, null, 2), "utf8");
  return { inserted: inserted.length, deduped };
}

// ─── Supabase adapter ─────────────────────────────────────────────────────────

async function readRejectionsSupabase(userId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("story_rejections")
    .select("meta_story_id, reason_code, source_item_ids, debug_payload, watermark, dedup_key, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_RETAINED);
  if (error) throw new Error(`[story-rejection-log-repo] read failed: ${error.message}`);
  return data ?? [];
}

async function appendRejectionsSupabase(userId, newRecords) {
  if (!Array.isArray(newRecords) || newRecords.length === 0) {
    return { inserted: 0, deduped: 0 };
  }
  const supabase = getSupabaseClient();
  // Phase 4 dedup: upsert with ignoreDuplicates on (user_id, dedup_key) — the
  // unique index added in migration 014 is what enforces single-record-per-key
  // across runs at the DB layer.  We compute dedup_key client-side too so the
  // file adapter can match the same semantics without an index.
  const rows = newRecords.map((r) => ({
    user_id: userId,
    meta_story_id: r.meta_story_id ?? null,
    reason_code: r.reason_code,
    source_item_ids: r.source_item_ids ?? [],
    debug_payload: r.debug_payload ?? null,
    watermark: r.watermark ?? null,
    dedup_key: dedupKey(r),
    created_at: r.created_at ?? new Date().toISOString(),
  }));
  const { error, data } = await supabase
    .from("story_rejections")
    .upsert(rows, { onConflict: "user_id,dedup_key", ignoreDuplicates: true })
    .select("dedup_key");
  if (error) throw new Error(`[story-rejection-log-repo] insert failed: ${error.message}`);
  const inserted = (data ?? []).length;
  return { inserted, deduped: rows.length - inserted };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist a batch of dropped-story rejection records for the given user.
 * No-ops on empty input.  Records carry a reason code describing why grounding
 * verification failed; `watermark` lets the dedup key (Phase 4) collapse
 * repeated identical drops across watermark-stable refreshes.
 *
 * @param {string} userId
 * @param {Array<{
 *   meta_story_id?: string,
 *   reason_code: string,
 *   source_item_ids?: string[],
 *   debug_payload?: object,
 *   watermark?: string,
 *   created_at?: string,
 * }>} records
 * @returns {Promise<{ inserted: number, deduped: number }>}
 */
export async function appendRejections(userId, records) {
  if (isSupabaseEnabled()) return appendRejectionsSupabase(userId, records);
  return appendRejectionsFile(userId, records);
}

/**
 * Read the most-recent rejection records for the user (newest first, capped
 * at MAX_RETAINED).  Returns [] when none exist.  Internal/admin use only —
 * not exposed via dashboard routes.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function readRejections(userId) {
  if (isSupabaseEnabled()) return readRejectionsSupabase(userId);
  return readRejectionsFile(userId);
}

export const REJECTION_LOG_MAX_RETAINED = MAX_RETAINED;
