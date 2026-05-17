// Runtime-local mirror of `@tempo/contracts/src/geography-aliases.ts`.
//
// Parity-checked surface (must stay in lockstep with the contracts package):
// `GEOGRAPHY_ALIASES`, `GEOGRAPHY_SYNONYMS` (added to the contracts package
// in D-064a), and `resolveGeographyAlias`.
//
// Runtime-local only (no parity check): `stripKeywordsMatchingGeographies` —
// it backs server-side settings hygiene + beat-fit lexical matching and lives
// in the API, not the shared contracts package.

export const GEOGRAPHY_ALIASES = Object.freeze({
  "beijing": "China",
  "shanghai": "China",
  "shenzhen": "China",
  "guangzhou": "China",
  "hong kong": "China",
  "tokyo": "Japan",
  "osaka": "Japan",
  "kyoto": "Japan",
  "moscow": "Russia",
  "saint petersburg": "Russia",
  "st petersburg": "Russia",
  "kyiv": "Ukraine",
  "kiev": "Ukraine",
  "washington": "United States",
  "washington dc": "United States",
  "washington d.c.": "United States",
  "new york": "United States",
  "new york city": "United States",
  "los angeles": "United States",
  "mexico city": "Mexico",
  "guadalajara": "Mexico",
  "bogota": "Colombia",
  "bogotá": "Colombia",
  "medellin": "Colombia",
  "medellín": "Colombia",
  "cali": "Colombia",
  "brasilia": "Brazil",
  "brasília": "Brazil",
  "sao paulo": "Brazil",
  "são paulo": "Brazil",
  "rio de janeiro": "Brazil",
  "buenos aires": "Argentina",
  "lima": "Peru",
  "santiago": "Chile",
  "montevideo": "Latin America",
  "caracas": "Latin America",
  "london": "United Kingdom",
  "paris": "France",
  "berlin": "Germany",
  "brussels": "European Union",
  "ottawa": "Canada",
  "toronto": "Canada",
});

export function resolveGeographyAlias(token, settingsGeographies) {
  if (typeof token !== "string") return null;
  const key = token.trim().toLowerCase();
  if (!key) return null;
  const canonical = GEOGRAPHY_ALIASES[key];
  if (!canonical) return null;
  const canonicalLower = canonical.toLowerCase();
  for (const setting of settingsGeographies ?? []) {
    if (typeof setting !== "string") continue;
    const settingTrimmed = setting.trim();
    const settingLower = settingTrimmed.toLowerCase();
    // (a) Exact canonical match — e.g. alias "beijing" → "China" against
    // configured "China".
    if (settingLower === canonicalLower) return setting;
    // (b) D-064a: synonym-aware match. The alias map uses long-form canonical
    // names ("United States") but users frequently configure short-form
    // geographies ("US"). Treat them as equivalent when GEOGRAPHY_SYNONYMS for
    // the configured setting contains the alias canonical (case-insensitive),
    // and return the configured setting spelling. Synonym-key lookup is
    // case-insensitive so a lowercase "us" setting still resolves.
    const synsKey = Object.keys(GEOGRAPHY_SYNONYMS).find(
      (k) => k.toLowerCase() === settingLower
    );
    const syns = synsKey ? GEOGRAPHY_SYNONYMS[synsKey] : null;
    if (syns && syns.some((s) => typeof s === "string" && s.trim().toLowerCase() === canonicalLower)) {
      return setting;
    }
  }
  return null;
}

// Lexical surface forms of configured geographies that the alias map does not
// cover. Used by beat-fit text matching (for "U.S." which breaks word
// boundaries) and by `stripKeywordsMatchingGeographies` (so a keyword like
// "United States" is recognized as equivalent to geo "US" and removed).
//
// Keep tightly scoped to canonical settings spellings; widen only when a new
// geography enters the contract.
export const GEOGRAPHY_SYNONYMS = Object.freeze({
  US: ["U.S.", "U.S", "USA", "U.S.A.", "U.S.A", "United States"],
  Colombia: ["Colombia", "Colombian", "Bogota", "Bogotá"],
});

// Remove keywords that are semantically equivalent to any configured
// geography, so country/region names do not appear in both `settings.keywords`
// and `settings.geographies`. Direction is keywords → geographies only:
// geographies are never altered by this helper.
//
// A keyword matches a configured geo G (case-insensitive, trimmed) when:
//   (a) keyword text equals G itself, or
//   (b) keyword text equals any GEOGRAPHY_SYNONYMS[G] surface form, or
//   (c) keyword text is an alias whose canonical resolves to G via
//       `resolveGeographyAlias` (e.g. "Bogotá" + geo "Colombia",
//       "Moscow" + geo "Russia").
//
// Thematic keywords ("war", "trade", "sanctions") that are not equivalent to
// any configured geo pass through untouched.
export function stripKeywordsMatchingGeographies(keywords, geographies) {
  if (!Array.isArray(keywords)) return [];
  const geos = Array.isArray(geographies) ? geographies : [];
  if (geos.length === 0) return keywords.slice();

  const geoLower = new Set();
  const synonymLower = new Set();
  for (const g of geos) {
    if (typeof g !== "string") continue;
    const trimmed = g.trim();
    if (!trimmed) continue;
    geoLower.add(trimmed.toLowerCase());
    const syns = GEOGRAPHY_SYNONYMS[trimmed];
    if (!syns) continue;
    for (const s of syns) {
      if (typeof s === "string" && s.trim()) {
        synonymLower.add(s.trim().toLowerCase());
      }
    }
  }

  const out = [];
  for (const kw of keywords) {
    if (typeof kw !== "string") continue;
    const trimmed = kw.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (geoLower.has(lower)) continue;
    if (synonymLower.has(lower)) continue;
    if (resolveGeographyAlias(trimmed, geos)) continue;
    out.push(kw);
  }
  return out;
}
