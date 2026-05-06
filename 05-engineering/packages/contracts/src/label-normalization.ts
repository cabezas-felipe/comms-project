/**
 * Deterministic synonym maps for normalizing model extraction output to canonical labels.
 * Applied at both the runtime merge path (server) and eval scoring.
 * All map lookups are by lowercase key; values are the canonical form to use.
 */

// Topic variant → canonical label used in the gold dataset.
export const TOPIC_SYNONYMS: Readonly<Record<string, string>> = {
  // Security
  "security cooperation": "Security policy",
  "national security": "Security policy",
  "border security": "Border policy",
  "security incidents": "Security policy",
  // Energy
  "energy": "Energy policy",
  // Migration / border
  "immigration policy": "Migration policy",
  "deportation": "Deportation policy",
  "deportation policy": "Deportation policy",
  "asylum policy": "Migration policy",
  "visa policy": "Migration policy",
  // Health
  "global health": "International health",
  "global public health": "International health",
  "disease outbreaks": "International health",
  "outbreak response": "International health",
  "vaccine updates": "Public health policy",
  "vaccine messaging": "Public health policy",
  "vaccine rollout": "Public health policy",
  "public health messaging": "Public health",
  // Sanctions
  "economic sanctions": "Sanctions enforcement",
  "sanctions": "Sanctions enforcement",
  // Trade / customs
  "trade tariffs": "Trade policy",
  "tariff policy": "Trade policy",
  "customs delays": "Customs policy",
  // Humanitarian
  "humanitarian operations": "Humanitarian aid",
  "humanitarian assistance": "Humanitarian aid",
  // Diplomacy
  "bilateral relations": "Diplomatic relations",
};

// Keyword variant → canonical term.
// Covers common plural forms and verbose phrases observed in model output.
export const KEYWORD_SYNONYMS: Readonly<Record<string, string>> = {
  // Plural → singular normalization
  "outbreaks": "outbreak",
  "vaccines": "vaccine",
  // Multi-word verbose → canonical single term
  "asylum court": "asylum",
  "deportation flights": "deportation",
  "deportation notices": "deportation",
  "border corridors": "border",
  "border pressure": "border",
  "labor disputes": "labor",
  "visa announcements": "visa",
  "organized crime framing": "organized crime",
  // Single canonical term expansions
  "security incidents": "security",
  "diplomatic tone": "diplomacy",
};

// Source name alias → canonical outlet name.
// Covers the most common model abbreviations and "The …" prefixes.
export const SOURCE_NAME_ALIASES: Readonly<Record<string, string>> = {
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
};

/** Map a model-produced topic label to its canonical form, or return it unchanged. */
export function normalizeTopicLabel(topic: string): string {
  const trimmed = topic.trim();
  return TOPIC_SYNONYMS[trimmed.toLowerCase()] ?? trimmed;
}

/** Map a model-produced keyword to its canonical form, or return it unchanged. */
export function normalizeKeywordLabel(keyword: string): string {
  const trimmed = keyword.trim();
  return KEYWORD_SYNONYMS[trimmed.toLowerCase()] ?? trimmed;
}

/** Map a model-produced source name to its canonical outlet name, or return it unchanged. */
export function normalizeSourceName(name: string): string {
  const trimmed = name.trim();
  return SOURCE_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
