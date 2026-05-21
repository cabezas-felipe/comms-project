// Shared publisher-label derivation for RSS manifests (JSON + Supabase).
// Used by feed-reader `mapEntry` and feed-manifest-repo `listIngestionFeeds`.

// Section suffix after whitespace-bordered em / en / hyphen dash.
const FEED_NAME_SECTION_SEPARATOR = /\s+[—–-]\s+/;

// Multi-word publisher + hyphenated section without spaces around the dash
// (e.g. "Washington Post-Politics"). Requires whitespace before the hyphen so
// single-token hyphenated names (e.g. "Al-Monitor") are not split.
const FEED_NAME_HYPHEN_SECTION = /^(.+\s+\S+)-(\S+)$/;

/**
 * Derive a publisher brand from a section-qualified feed or entity name.
 *
 * Priority:
 *   1. Strip trailing section after spaced em/en/hyphen dash (" — Politics")
 *   2. Strip trailing section after hyphen when the name has multiple words
 *      ("Washington Post-Politics")
 *   3. Return the full trimmed name when no section suffix is detected
 *
 * Returns `null` only for non-strings or empty/whitespace input so callers
 * can chain fallbacks without emitting `"null"`.
 */
export function derivePublisherFromFeedName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;

  if (FEED_NAME_SECTION_SEPARATOR.test(trimmed)) {
    const head = trimmed.split(FEED_NAME_SECTION_SEPARATOR, 1)[0].trim();
    if (head.length > 0) return head;
  }

  const hyphenMatch = trimmed.match(FEED_NAME_HYPHEN_SECTION);
  if (hyphenMatch) {
    const head = hyphenMatch[1].trim();
    if (head.length > 0) return head;
  }

  return trimmed;
}
