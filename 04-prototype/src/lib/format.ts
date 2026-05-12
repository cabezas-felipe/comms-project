export function timeAgo(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatRefreshTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatClock(date);
}

/**
 * Display-only formatter for dashboard keyword pills.  Keywords in settings
 * are often stored lowercase ("oil", "petroleum"); next to canonical-cased
 * topics ("Migration policy") and geographies ("Colombia") that looks
 * inconsistent in the pill row.  This helper title-cases each whitespace-
 * separated word, while preserving tokens that are already all uppercase
 * (so acronyms like "OFAC" and "US" pass through unchanged).
 *
 * Presentation-only: callers MUST keep using the raw canonical value for
 * filtering, selection state, keys, and test IDs.
 */
export function formatKeywordLabel(value: string): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/).map(titleCaseToken).join(" ");
}

function titleCaseToken(token: string): string {
  if (!token) return token;
  // Preserve already-uppercase tokens (acronyms like OFAC, US, USA).  The
  // /[A-Za-z]/ guard avoids treating pure-numeric or punctuation tokens as
  // "already cased" — they fall through to the default branch.
  if (/[A-Za-z]/.test(token) && token === token.toUpperCase()) return token;
  const lower = token.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
