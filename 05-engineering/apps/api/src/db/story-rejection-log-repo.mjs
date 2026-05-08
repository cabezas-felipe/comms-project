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

async function appendRejectionsFile(userId, newRecords) {
  if (!Array.isArray(newRecords) || newRecords.length === 0) return;
  const existing = await readRejectionsFile(userId);
  // Newest first; keep only MAX_RETAINED to avoid unbounded growth.
  const combined = [...newRecords, ...existing].slice(0, MAX_RETAINED);
  const file = rejectionsFile(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(combined, null, 2), "utf8");
}

// ─── Supabase adapter ─────────────────────────────────────────────────────────

async function readRejectionsSupabase(userId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("story_rejections")
    .select("meta_story_id, reason_code, source_item_ids, debug_payload, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_RETAINED);
  if (error) throw new Error(`[story-rejection-log-repo] read failed: ${error.message}`);
  return data ?? [];
}

async function appendRejectionsSupabase(userId, newRecords) {
  if (!Array.isArray(newRecords) || newRecords.length === 0) return;
  const supabase = getSupabaseClient();
  const rows = newRecords.map((r) => ({
    user_id: userId,
    meta_story_id: r.meta_story_id ?? null,
    reason_code: r.reason_code,
    source_item_ids: r.source_item_ids ?? [],
    debug_payload: r.debug_payload ?? null,
    created_at: r.created_at ?? new Date().toISOString(),
  }));
  const { error } = await supabase.from("story_rejections").insert(rows);
  if (error) throw new Error(`[story-rejection-log-repo] insert failed: ${error.message}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist a batch of dropped-story rejection records for the given user.
 * No-ops on empty input.  Records carry a reason code describing why grounding
 * verification failed; debug_payload may include claim/evidence counts.
 *
 * @param {string} userId
 * @param {Array<{
 *   meta_story_id?: string,
 *   reason_code: string,
 *   source_item_ids?: string[],
 *   debug_payload?: object,
 *   created_at?: string,
 * }>} records
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
