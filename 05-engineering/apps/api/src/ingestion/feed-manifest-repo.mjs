import { derivePublisherFromFeedName } from "./publisher-from-feed-name.mjs";

/**
 * DB-backed manifest reader for ingestion feeds.
 *
 * Queries source_feed_mapping joined with source_entities and returns an array
 * shaped identically to the items inside source-feeds.json's "feeds" array.
 * Used by GET /api/ingestion/sources when Supabase is enabled (Phase 3 Option B).
 *
 * Returns ALL rows with status "mapped" or "verified" regardless of the active flag.
 * This endpoint reflects catalog/manifest visibility — not an active-only execution list.
 * Callers (e.g. the ingestion runner) are responsible for filtering on active if needed.
 *
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient }} opts
 * @returns {Promise<Array<{ id: string, name: string, publisher?: string, kind: string, url: string, weight: number, active: boolean }>>}
 */
export async function listIngestionFeeds({ supabase }) {
  const { data, error } = await supabase
    .from("source_feed_mapping")
    .select(
      `manifest_feed_id,
       rss_url,
       social_profile_url,
       ingestion_weight,
       active,
       status,
       source_entities ( canonical_name, kind, publisher_display_name )`
    )
    .in("status", ["mapped", "verified"])
    .order("ingestion_weight", { ascending: false });

  if (error) throw new Error(`[feed-manifest-repo] ${error.message}`);

  const feeds = [];
  for (const row of data ?? []) {
    const url = row.rss_url || row.social_profile_url || null;
    if (!url) continue;

    const entity = row.source_entities;
    const kind = row.rss_url ? "rss" : "social";

    // Prefer explicit manifest_feed_id; fallback to a slug derived from entity name.
    const id =
      row.manifest_feed_id ??
      (entity?.canonical_name ?? "unknown")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

    const sectionName = entity?.canonical_name ?? id;
    const feed = {
      id,
      // Section-level name retained for matching, logs, and B2 derivation input.
      name: sectionName,
      kind,
      url,
      weight: row.ingestion_weight,
      active: row.active,
    };
    // Traditional RSS: explicit DB publisher (B1) wins; else derive from
    // section canonical_name (B2). Social rows omit `publisher` — handles are
    // the identity and are not collapsed to a parent brand (spec F1).
    if (entity?.kind === "traditional" && kind === "rss") {
      const explicit = entity?.publisher_display_name;
      const derived =
        typeof explicit === "string" && explicit.trim().length > 0
          ? explicit.trim()
          : derivePublisherFromFeedName(sectionName);
      if (derived) feed.publisher = derived;
    }
    feeds.push(feed);
  }

  // DB already ordered by weight desc; apply secondary sort by name asc for ties.
  feeds.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.name.localeCompare(b.name);
  });

  return feeds;
}
