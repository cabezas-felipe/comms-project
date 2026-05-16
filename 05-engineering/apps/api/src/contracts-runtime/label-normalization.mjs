// Runtime-local mirror of `@tempo/contracts/src/label-normalization.ts`.  See
// `./schemas.mjs` header for rationale.  Parity test enforces equivalence.

export const TOPIC_SYNONYMS = Object.freeze({
  "security cooperation": "Security policy",
  "national security": "Security policy",
  "border security": "Border policy",
  "security incidents": "Security policy",
  "energy": "Energy policy",
  "immigration policy": "Migration policy",
  "deportation": "Deportation policy",
  "deportation policy": "Deportation policy",
  "asylum policy": "Migration policy",
  "visa policy": "Migration policy",
  "global health": "International health",
  "global public health": "International health",
  "disease outbreaks": "International health",
  "outbreak response": "International health",
  "vaccine updates": "Public health policy",
  "vaccine messaging": "Public health policy",
  "vaccine rollout": "Public health policy",
  "public health messaging": "Public health",
  "economic sanctions": "Sanctions enforcement",
  "sanctions": "Sanctions enforcement",
  "trade tariffs": "Trade policy",
  "tariff policy": "Trade policy",
  "customs delays": "Customs policy",
  "humanitarian operations": "Humanitarian aid",
  "humanitarian assistance": "Humanitarian aid",
  "bilateral relations": "Diplomatic relations",
});

export const KEYWORD_SYNONYMS = Object.freeze({
  "outbreaks": "outbreak",
  "vaccines": "vaccine",
  "asylum court": "asylum",
  "deportation flights": "deportation",
  "deportation notices": "deportation",
  "border corridors": "border",
  "border pressure": "border",
  "labor disputes": "labor",
  "visa announcements": "visa",
  "organized crime framing": "organized crime",
  "security incidents": "security",
  "diplomatic tone": "diplomacy",
});

export const SOURCE_NAME_ALIASES = Object.freeze({
  "nyt": "New York Times",
  "the new york times": "New York Times",
  "ny times": "New York Times",
  "wsj": "Wall Street Journal",
  "ap": "Associated Press",
  "ap news": "Associated Press",
  "bbc news": "BBC",
  "bbc world service": "BBC",
  "bbc world": "BBC",
  "hill": "The Hill",
  "the hill": "The Hill",
});

export function normalizeTopicLabel(topic) {
  const trimmed = String(topic).trim();
  return TOPIC_SYNONYMS[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeKeywordLabel(keyword) {
  const trimmed = String(keyword).trim();
  return KEYWORD_SYNONYMS[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeSourceName(name) {
  const trimmed = String(name).trim();
  return SOURCE_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeSourceIdentity(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}
