/**
 * E2E-ONLY identity-precedence override.
 *
 * Default (env unset): production-safe precedence — a valid Bearer (Supabase)
 * session wins, and the prototype `x-recognized-email` header is used ONLY as a
 * fallback when no Bearer is present/usable.
 *
 * When `VITE_E2E_IDENTITY_PRECEDENCE=recognized_email`: the prototype
 * recognized-email identity is preferred OVER Bearer, so an e2e recognized-user
 * run cannot be shadowed by a stale persisted Supabase token. This is a test-
 * harness affordance only — never enable it in production.
 *
 * Centralized so the dashboard API (`buildIdentityHeaders`) and the settings API
 * (`getAuthHeaders` / `getStorageKey`) apply the SAME policy and never diverge.
 */
export function isE2EIdentityOverrideEnabled(): boolean {
  return import.meta.env.VITE_E2E_IDENTITY_PRECEDENCE === "recognized_email";
}
