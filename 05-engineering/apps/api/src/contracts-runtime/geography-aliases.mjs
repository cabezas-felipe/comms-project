// Runtime-local mirror of `@tempo/contracts/src/geography-aliases.ts`.

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
    if (setting.trim().toLowerCase() === canonicalLower) return setting;
  }
  return null;
}
