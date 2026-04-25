/**
 * Returns true when a Supabase auth error signals OTP rate-limiting.
 * Checks `.status === 429` first (the Supabase AuthError surface), then
 * falls back to known rate-limit message patterns for resilience.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["status"] === 429) return true;
  const msg = typeof e["message"] === "string" ? e["message"] : "";
  return /rate.?limit|too many request/i.test(msg);
}
