import { isSupabaseEnabled, getSupabaseClient } from "./client.mjs";

/**
 * Returns only the rows that are new in nextPayload relative to previousPayload.
 * previousPayload null/undefined → treat previous arrays as empty (first-save semantics).
 * Matching is exact (no normalization at this stage).
 *
 * @param {{ userId: string, previousPayload: object|null, nextPayload: object }} args
 * @returns {{ user_id: string, raw_string: string, kind: string }[]}
 */
export function computeDeltaRows({ userId, previousPayload, nextPayload }) {
  const prevTraditional = new Set(previousPayload?.traditionalSources ?? []);
  const prevSocial = new Set(previousPayload?.socialSources ?? []);

  // Dedupe within the incoming payload before delta comparison so a repeated
  // string in one request never produces more than one row for that kind.
  const nextTraditional = new Set(nextPayload.traditionalSources ?? []);
  const nextSocial = new Set(nextPayload.socialSources ?? []);

  return [
    ...[...nextTraditional]
      .filter((s) => !prevTraditional.has(s))
      .map((raw_string) => ({ user_id: userId, raw_string, kind: "traditional" })),
    ...[...nextSocial]
      .filter((s) => !prevSocial.has(s))
      .map((raw_string) => ({ user_id: userId, raw_string, kind: "social" })),
  ];
}

/**
 * Inserts source_registry_events rows for sources newly added in nextPayload vs previousPayload.
 * No-ops when Supabase is not configured or when there are no new sources.
 * Errors are logged but never re-thrown — callers must not depend on sync succeeding.
 *
 * @param {{ userId: string, previousPayload: object|null, nextPayload: object }} args
 */
export async function recordSourceRegistryEventsFromSettings({ userId, previousPayload, nextPayload }) {
  if (!isSupabaseEnabled()) return;

  const rows = computeDeltaRows({ userId, previousPayload, nextPayload });
  if (rows.length === 0) return;

  try {
    const { error } = await getSupabaseClient().from("source_registry_events").insert(rows);
    if (error) {
      console.error(`[source-registry] insert failed for user ${userId}: ${error.message}`);
    }
  } catch (err) {
    console.error(
      `[source-registry] unexpected error for user ${userId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
