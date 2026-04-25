const SOCIAL_SUBSTRINGS = [
  "twitter",
  "x.com",
  "instagram",
  "youtube",
  "tiktok",
  "reddit",
  "facebook",
  "linkedin",
];

function isSocial(source: string): boolean {
  if (source.startsWith("@")) return true;
  const lower = source.toLowerCase();
  return SOCIAL_SUBSTRINGS.some((kw) => lower.includes(kw));
}

export interface ClassifiedSources {
  traditionalSources: string[];
  socialSources: string[];
}

/**
 * Splits a flat array of source strings into traditional and social buckets.
 *
 * Rules:
 *   - Trim each entry; skip empties.
 *   - Social if it starts with "@" or contains a known social platform substring.
 *   - Otherwise traditional.
 *   - Dedupe within each bucket (case-insensitive key, first occurrence wins).
 *   - Output order matches first-occurrence order in the input.
 */
export function classifySources(sources: string[]): ClassifiedSources {
  const traditionalSeen = new Set<string>();
  const socialSeen = new Set<string>();
  const traditionalSources: string[] = [];
  const socialSources: string[] = [];

  for (const raw of sources) {
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();

    if (isSocial(s)) {
      if (!socialSeen.has(key)) {
        socialSeen.add(key);
        socialSources.push(s);
      }
    } else {
      if (!traditionalSeen.has(key)) {
        traditionalSeen.add(key);
        traditionalSources.push(s);
      }
    }
  }

  return { traditionalSources, socialSources };
}
