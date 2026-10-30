import { isSupabaseEnabled, getSupabaseClient } from "./client.mjs";

const TABLE = "source_aliases";

/**
 * Reads operator-curated source aliases from Supabase and returns a normalized
 * alias map shaped for `source-matcher.aliasAndNormalize`:
 *   key:   normalized alias the user might type (lower/trim — matcher lookup form)
 *   value: canonical source string (matched against feed name / publisher)
 *
 * This lets operators add new traditional-source aliases at the data layer so
 * user-entered names resolve at refresh time WITHOUT a redeploy.
 *
 * Schema (Phase 0 source registry):
 *   source_aliases(alias_raw, alias_normalized, source_entity_id)
 *     → source_entities(id, canonical_name, ...)
 * The matcher's value must be the entity's `canonical_name`, reached via the
 * `source_entity_id` foreign key (PostgREST embed on the `source_entities`
 * relationship — same pattern as feed-manifest-repo).
 *
 * Returns `{}` when Supabase is not enabled (file-based mode). Throws on query
 * failure — the caller decides fail-open behavior (the refresh path catches and
 * falls back to the repo's static alias map).
 *
 * @param {{ supabase?: import('@supabase/supabase-js').SupabaseClient }} [opts]
 *   Optional injected client (tests); defaults to the singleton when enabled.
 * @returns {Promise<Record<string, string>>}
 */
export async function readSourceAliasMap(opts = {}) {
  const supabase = opts.supabase ?? (isSupabaseEnabled() ? getSupabaseClient() : null);
  if (!supabase) return {};

  const { data, error } = await supabase
    .from(TABLE)
    .select("alias_raw, alias_normalized, source_entities ( canonical_name )");

  if (error) {
    throw new Error(`[source-aliases-repo] read failed: ${error.message}`);
  }

  const map = {};
  for (const row of data ?? []) {
    if (!row || typeof row !== "object") continue;
    // PostgREST returns the embedded to-one relationship as an object (or an
    // array in some configs); tolerate both shapes defensively.
    const entity = Array.isArray(row.source_entities)
      ? row.source_entities[0]
      : row.source_entities;
    const canonical =
      entity && typeof entity.canonical_name === "string" ? entity.canonical_name.trim() : "";
    if (!canonical) continue;

    // Key on the DB-normalized form (matcher looks up by trim+lowercase); also
    // index the raw spelling's lower/trim so variants that don't fully collapse
    // to alias_normalized still resolve. Both point at the same canonical.
    const normalizedKey =
      typeof row.alias_normalized === "string" ? row.alias_normalized.trim().toLowerCase() : "";
    const rawKey = typeof row.alias_raw === "string" ? row.alias_raw.trim().toLowerCase() : "";
    if (normalizedKey) map[normalizedKey] = canonical;
    if (rawKey) map[rawKey] = canonical;
  }
  return map;
}
