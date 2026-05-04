import { isSupabaseEnabled, getSupabaseClient } from "./client.mjs";

const TABLE = "user_onboarding_narratives";

/**
 * Appends a new onboarding narrative row for the user and marks any prior
 * current row as not current.  No-op when Supabase is not configured.
 *
 * Called only after a successful settings write (Pattern A).  Never mutates
 * previously stored raw_text rows — only the is_current pointer moves.
 */
export async function appendOnboardingNarrative(userId, rawText) {
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
