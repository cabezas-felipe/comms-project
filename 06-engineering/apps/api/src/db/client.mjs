import { createClient } from "@supabase/supabase-js";

let _client = null;

/** Returns true when both SUPABASE_URL and a key env var are present. */
export function isSupabaseEnabled() {
  return !!(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
  );
}

/**
 * Throws with a human-readable message if the required Supabase env vars are absent.
 * Call at startup when SUPABASE_URL is set, to catch misconfiguration early.
 */
export function assertSupabaseEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)");
  }
  if (missing.length > 0) {
    throw new Error(
      `[supabase] Missing required env vars: ${missing.join(", ")}.\n` +
        `Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server) or SUPABASE_ANON_KEY (client) to enable Supabase persistence, ` +
        `or leave SUPABASE_URL unset to use file-based storage.`
    );
  }
}

/**
 * Returns the singleton Supabase client.
 * Prefers SUPABASE_SERVICE_ROLE_KEY (server-side, bypasses RLS) over SUPABASE_ANON_KEY.
 */
export function getSupabaseClient() {
  if (_client) return _client;
  assertSupabaseEnv();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? /** @type {string} */ (process.env.SUPABASE_ANON_KEY);
  _client = createClient(/** @type {string} */ (process.env.SUPABASE_URL), key);
  return _client;
}
