// Deterministic geography alias map for Phase 3 meta-story tagging.
//
// Goal: when the evidence bundle for a meta-story mentions a city, region, or
// other token that maps to a canonical geography (e.g. "Beijing" → "China"),
// the tagger may emit the canonical label — but only when that canonical label
// is present in the user's `settings.geographies` vocabulary.  The alias map
// is purely deterministic (no model lookup, no fuzzy matching) so the output
// stays auditable and reproducible across runs.
//
// Authoring notes:
//   - Keys are stored lowercase; lookups must lowercase the evidence token
//     before consulting the map.
//   - Canonical labels are stored in Title Case for readability, but matching
//     against settings is case-insensitive — the emitted string uses the
//     settings' own spelling so the UI stays consistent.
//   - Never expand the map to multi-step chains (alias → alias → canonical).
//     One-shot lookup only; the resolver should not recurse.
//   - This map is intentionally modest in v1; growth happens when product
//     evidence demonstrates a missed alias is causing real label drops.
//   - "Latin America" follows the example called out in the Phase 3 brief.
//     Region-level canonicals (Latin America, European Union) are allowed
//     when the settings vocabulary admits them; otherwise the alias is silently
//     dropped by the settings gate.

export const GEOGRAPHY_ALIASES: Readonly<Record<string, string>> = {
  // ─── China ──────────────────────────────────────────────────────────────
  "beijing": "China",
  "shanghai": "China",
  "shenzhen": "China",
  "guangzhou": "China",
  "hong kong": "China",
  // ─── Japan ──────────────────────────────────────────────────────────────
  "tokyo": "Japan",
  "osaka": "Japan",
  "kyoto": "Japan",
  // ─── Russia ─────────────────────────────────────────────────────────────
  "moscow": "Russia",
  "saint petersburg": "Russia",
  "st petersburg": "Russia",
  // ─── Ukraine ────────────────────────────────────────────────────────────
  "kyiv": "Ukraine",
  "kiev": "Ukraine",
  // ─── United States ──────────────────────────────────────────────────────
  "washington": "United States",
  "washington dc": "United States",
  "washington d.c.": "United States",
  "new york": "United States",
  "new york city": "United States",
  "los angeles": "United States",
  // ─── Mexico ─────────────────────────────────────────────────────────────
  "mexico city": "Mexico",
  "guadalajara": "Mexico",
  // ─── Colombia ───────────────────────────────────────────────────────────
  "bogota": "Colombia",
  "bogotá": "Colombia",
  "medellin": "Colombia",
  "medellín": "Colombia",
  "cali": "Colombia",
  // ─── Brazil ─────────────────────────────────────────────────────────────
  "brasilia": "Brazil",
  "brasília": "Brazil",
  "sao paulo": "Brazil",
  "são paulo": "Brazil",
  "rio de janeiro": "Brazil",
  // ─── Argentina ──────────────────────────────────────────────────────────
  "buenos aires": "Argentina",
  // ─── Peru ───────────────────────────────────────────────────────────────
  "lima": "Peru",
  // ─── Chile ──────────────────────────────────────────────────────────────
  "santiago": "Chile",
  // ─── Latin America (regional canonical) ─────────────────────────────────
  "montevideo": "Latin America",
  "caracas": "Latin America",
  // ─── United Kingdom ─────────────────────────────────────────────────────
  "london": "United Kingdom",
  // ─── France ─────────────────────────────────────────────────────────────
  "paris": "France",
  // ─── Germany ────────────────────────────────────────────────────────────
  "berlin": "Germany",
  // ─── European Union (regional canonical) ────────────────────────────────
  "brussels": "European Union",
  // ─── Canada ─────────────────────────────────────────────────────────────
  "ottawa": "Canada",
  "toronto": "Canada",
};

/**
 * Resolve an evidence token to its canonical geography label, gated by the
 * user's settings vocabulary.
 *
 * Returns the canonical entry from `settingsGeographies` (preserving its
 * casing) when:
 *   1. `token` (case-insensitive) is present in `GEOGRAPHY_ALIASES`, AND
 *   2. the alias's canonical label appears (case-insensitive) in
 *      `settingsGeographies`.
 *
 * Returns `null` when either gate fails — never emits the alias token itself,
 * and never emits a canonical label the user hasn't opted into.  This is the
 * single seam Phase 3 relies on for the "alias evidence term → canonical
 * settings geography term" rule.
 */
// Synonym map used by `resolveGeographyAlias` so a configured short-form
// geography (e.g. "US") still resolves long-form alias canonicals
// ("United States") that come out of the alias table.  Kept tightly scoped
// to canonical settings spellings; widen only when a new geography enters
// the contract.  Mirrored verbatim in `apps/api/src/contracts-runtime/`.
export const GEOGRAPHY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  US: ["U.S.", "U.S", "USA", "U.S.A.", "U.S.A", "United States"],
  Colombia: ["Colombia", "Colombian", "Bogota", "Bogotá"],
};

export function resolveGeographyAlias(
  token: string,
  settingsGeographies: readonly string[]
): string | null {
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
    // (b) Synonym-aware match (D-064a). The alias map uses long-form
    // canonicals ("United States"); users frequently configure short forms
    // ("US"). Treat them as equivalent via GEOGRAPHY_SYNONYMS and return the
    // user's configured spelling. Synonym-key lookup is case-insensitive so a
    // lowercase "us" setting still resolves.
    const synsKey = Object.keys(GEOGRAPHY_SYNONYMS).find(
      (k) => k.toLowerCase() === settingLower
    );
    const syns = synsKey ? GEOGRAPHY_SYNONYMS[synsKey] : null;
    if (
      syns &&
      syns.some(
        (s) => typeof s === "string" && s.trim().toLowerCase() === canonicalLower
      )
    ) {
      return setting;
    }
  }
  return null;
}
