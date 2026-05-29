// Shared deterministic geo-lexical matching.
//
// This module is the single home for the "does this text mention a configured
// geography?" rules that beat-fit (Stage 2 relevance) relies on, and that the
// recall lexical gate reuses (Slice 2). Extracting it out of beat-fit keeps the
// lexical behavior auditable and prevents the two stages from drifting.
//
// The matcher is purely deterministic (no NER, no model lookup): canonical
// word-boundary token match, GEOGRAPHY_SYNONYMS surface forms (e.g. "U.S."
// whose trailing period defeats `\b`), and GEOGRAPHY_ALIASES gated on the
// configured `settings.geographies` via `resolveGeographyAlias` (D-064). The
// alias path mirrors the `assignGeographies` rule in meta-story-tags.mjs so
// beat-fit and tag-assignment treat alias evidence identically.

import {
  GEOGRAPHY_ALIASES,
  GEOGRAPHY_SYNONYMS,
  resolveGeographyAlias,
} from "../contracts-runtime/index.mjs";

// Precomputed alias entries for the per-item geo loop. Mirrors the structure
// used in meta-story-tags.mjs so beat-fit and tag assignment share identical
// alias-hit rules (D-064).
const ALIAS_ENTRIES = Object.entries(GEOGRAPHY_ALIASES);

// Internal helper — kept module-private (the public surface is geoTextMatches,
// itemMentionsConfiguredGeography, and buildPlainTokenRegex).
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a single case-insensitive, word-bounded alternation regex from a list
// of plain terms. Returns null when no usable term is present. Shared so
// keyword / commodity / geo token checks all use identical boundaries.
export function buildPlainTokenRegex(terms) {
  const cleaned = (terms ?? []).map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
  if (cleaned.length === 0) return null;
  const alternation = cleaned.map(escapeRegex).join("|");
  return new RegExp(`\\b(?:${alternation})\\b`, "i");
}

// Soft-geo lexical synonyms used when item.geographies is empty (very common
// for raw RSS items at the candidate stage). "US" should match "U.S.", "U.S",
// "USA", "United States" in text without depending on NER. The canonical
// table lives in `contracts-runtime/geography-aliases.mjs` so this module and
// `stripKeywordsMatchingGeographies` cannot drift (D-064a).
export function geoTextMatches(text, geo, settingsGeographies) {
  // 1. Word-boundary token match on the canonical name itself.
  const canonicalRe = buildPlainTokenRegex([geo]);
  if (canonicalRe && canonicalRe.test(text)) return true;
  // 2. Synonym list (handles "U.S." which has a period that defeats \b on the
  //    trailing side).
  const synonyms = GEOGRAPHY_SYNONYMS[geo];
  if (synonyms) {
    for (const syn of synonyms) {
      const re = new RegExp(`\\b${escapeRegex(syn)}`, "i");
      if (re.test(text)) return true;
    }
  }
  // 3. D-064: GEOGRAPHY_ALIASES gated on settings.geographies. Mirrors the
  //    `assignGeographies` alias path in meta-story-tags.mjs so beat-fit and
  //    tag-assignment treat alias evidence identically. For each alias key
  //    that resolves (via `resolveGeographyAlias`) to this same `geo` in the
  //    settings list, a whole-word hit in the joined text counts.
  const geoLower = String(geo).trim().toLowerCase();
  if (!geoLower) return false;
  for (const [aliasLower] of ALIAS_ENTRIES) {
    const resolved = resolveGeographyAlias(aliasLower, settingsGeographies);
    if (!resolved || resolved.trim().toLowerCase() !== geoLower) continue;
    const re = new RegExp(`\\b${escapeRegex(aliasLower)}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

// Soft-geo text fallback: return the first configured geography whose lexical
// surface forms appear in `text`, or null when none match. Iteration order
// follows `settingsGeographies` (first match wins) so callers can derive a
// stable reason code (e.g. `geo_text_match:<geo>`). This is the text-only
// branch — explicit `item.geographies` overlap is handled by the caller.
export function itemMentionsConfiguredGeography(text, settingsGeographies) {
  const configured = settingsGeographies ?? [];
  for (const geo of configured) {
    if (geoTextMatches(text, geo, configured)) return geo;
  }
  return null;
}
