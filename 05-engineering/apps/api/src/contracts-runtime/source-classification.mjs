// Runtime-local mirror of `@tempo/contracts/src/source-classification.ts`.

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

function isSocial(source) {
  if (source.startsWith("@")) return true;
  const lower = source.toLowerCase();
  return SOCIAL_SUBSTRINGS.some((kw) => lower.includes(kw));
}

export function classifySources(sources) {
  const traditionalSeen = new Set();
  const socialSeen = new Set();
  const traditionalSources = [];
  const socialSources = [];

  for (const raw of sources) {
    const s = String(raw).trim();
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
