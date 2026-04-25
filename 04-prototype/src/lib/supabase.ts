import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const hasValidSupabaseConfig =
  typeof supabaseUrl === "string" &&
  /^https?:\/\//.test(supabaseUrl) &&
  typeof supabaseAnonKey === "string" &&
  supabaseAnonKey.length > 0 &&
  supabaseAnonKey !== "undefined" &&
  supabaseAnonKey !== "null";

/**
 * Keep local prototype usable even when Supabase env vars are missing.
 * In that case we expose a minimal auth stub that reports "not signed in"
 * and throws only when sign-in is attempted.
 */
export const supabase =
  hasValidSupabaseConfig
    ? createClient(supabaseUrl, supabaseAnonKey)
    : {
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({
            data: {
              subscription: {
                unsubscribe: () => {},
              },
            },
          }),
          signInWithOtp: async () => ({
            data: { user: null, session: null },
            error: new Error(
              "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
            ),
          }),
          signOut: async () => ({ error: null }),
        },
      };
