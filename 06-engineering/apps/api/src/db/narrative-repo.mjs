import { isSupabaseEnabled, getSupabaseClient } from "./client.mjs";

const TABLE = "user_onboarding_narratives";

/**
 * Returns the trimmed raw_text of the user's current onboarding narrative row,
 * or null if Supabase is not enabled, no current row exists, or raw_text is blank.
 * Throws on DB/query failure.
 */
export async function readCurrentOnboardingNarrative(userId) {
  if (typeof userId !== "string" || !userId.trim()) return null;
  if (!isSupabaseEnabled()) return null;
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from(TABLE)
    .select("raw_text")
    .eq("user_id", userId)
    .eq("is_current", true)
    .maybeSingle();

  if (error) {
    throw new Error(`[narrative-repo] read failed: ${error.message}`);
  }

  if (!data || typeof data.raw_text !== "string" || !data.raw_text.trim()) {
    return null;
  }

  return data.raw_text.trim();
}

/**
 * Appends a new onboarding narrative row for the user and marks any prior
 * current row as not current.  No-op when Supabase is not configured, userId
 * is blank/non-string, or rawText is blank/non-string.
 *
 * Called only after a successful settings write (Pattern A).  Never mutates
 * previously stored raw_text rows — only the is_current pointer moves.
 */
export async function appendOnboardingNarrative(userId, rawText) {
  if (typeof userId !== "string" || !userId.trim()) return;
  if (typeof rawText !== "string" || !rawText.trim()) return;
  if (!isSupabaseEnabled()) return;
  const supabase = getSupabaseClient();

  // Demote existing current row(s) before inserting the new one.
  const { error: demoteError } = await supabase
    .from(TABLE)
    .update({ is_current: false })
    .eq("user_id", userId)
    .eq("is_current", true);

  if (demoteError) {
    throw new Error(`[narrative-repo] demote failed: ${demoteError.message}`);
  }

  const { error: insertError } = await supabase
    .from(TABLE)
    .insert({ user_id: userId, raw_text: rawText });

  if (insertError) {
    throw new Error(`[narrative-repo] insert failed: ${insertError.message}`);
  }
}
