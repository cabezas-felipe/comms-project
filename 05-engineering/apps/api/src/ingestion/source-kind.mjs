// Shared ingestion-kind mapper.
//
// Source manifests / cache rows carry an INGESTION kind (`"rss"` for traditional
// RSS publishers, `"social"` for social handles), but the dashboard contract
// (`@tempo/contracts` `dashboardPayloadSchema`) only admits the CONTRACT kinds
// `"traditional" | "social"` on `sources[].kind`. The live feed-reader path
// already emits `"traditional"`; the cache-reconstruction path previously
// forwarded the raw manifest kind (`"rss"`), which then failed schema validation
// and silently emptied the dashboard. This is the single mapping both paths use.
//
// Mirrors the long-standing `ENTITY_KIND = { rss: "traditional", social:
// "social" }` mapping in `../db/source-feeds-import.mjs` (now reused there).

/**
 * Map an ingestion kind to a contract kind.
 *
 *   "rss"          -> "traditional"
 *   "social"       -> "social"
 *   "traditional"  -> "traditional"   (already a contract kind; passthrough)
 *   unknown/empty/null/non-string -> "traditional"  (safe default)
 *
 * @param {unknown} kind
 * @returns {"traditional" | "social"}
 */
export function mapIngestionKindToContractKind(kind) {
  if (kind === "social") return "social";
  // "rss", "traditional", unknown, empty, null, and non-strings all resolve to
  // the safe contract default so a cache/manifest row can never carry a
  // schema-invalid kind into the pipeline.
  return "traditional";
}
