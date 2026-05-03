#!/usr/bin/env node
/**
 * One-time seed: reads apps/api/data/source-feeds.json and upserts rows into
 * source_entities + source_feed_mapping so Supabase becomes the source of truth
 * for GET /api/ingestion/sources (Phase 3 Option B).
 *
 * Usage:
 *   SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
 *     node apps/api/src/db/source-feeds-import.mjs
 *
 * Idempotent: safe to re-run. Existing rows are updated in place.
 * Existing rows with status='verified' keep their status — this script never
 * downgrades a verified mapping to mapped.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FEEDS_FILE = path.resolve(__dirname, "../../data/source-feeds.json");

// Maps source-feeds.json "kind" → source_entities "kind"
const ENTITY_KIND = { rss: "traditional", social: "social" };

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[import] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }

  const supabase = createClient(url, key);

  const raw = await fs.readFile(FEEDS_FILE, "utf8");
  const { feeds } = JSON.parse(raw);
  console.log(`[import] Read ${feeds.length} feeds from source-feeds.json`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const feed of feeds) {
    const entityKind = ENTITY_KIND[feed.kind] ?? "traditional";

    // Upsert source_entities keyed on (kind, canonical_name).
    const { data: entityData, error: entityError } = await supabase
      .from("source_entities")
      .upsert(
        { canonical_name: feed.name, kind: entityKind },
        { onConflict: "kind,canonical_name", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (entityError || !entityData) {
      console.error(`[import] SKIP "${feed.id}": entity upsert failed — ${entityError?.message}`);
      skipped++;
      continue;
    }

    const entityId = entityData.id;

    // Check existing mapping status so we never downgrade 'verified' → 'mapped'.
    const { data: existing } = await supabase
      .from("source_feed_mapping")
      .select("id, status")
      .eq("source_entity_id", entityId)
      .maybeSingle();

    const preserveVerified = existing?.status === "verified";

    const mappingRow = {
      source_entity_id: entityId,
      manifest_feed_id: feed.id,
      ingestion_weight: feed.weight,
      active: feed.active,
      status: preserveVerified ? "verified" : "mapped",
    };

    if (feed.kind === "rss") {
      mappingRow.rss_url = feed.url;
    } else {
      mappingRow.social_profile_url = feed.url;
    }

    const { error: mappingError } = await supabase
      .from("source_feed_mapping")
      .upsert(mappingRow, { onConflict: "source_entity_id" });

    if (mappingError) {
      console.error(`[import] SKIP "${feed.id}": mapping upsert failed — ${mappingError.message}`);
      skipped++;
      continue;
    }

    if (existing) {
      updated++;
      console.log(`[import] updated  ${feed.id} → ${feed.name}`);
    } else {
      inserted++;
      console.log(`[import] inserted ${feed.id} → ${feed.name}`);
    }
  }

  console.log(`\n[import] Done. inserted=${inserted} updated=${updated} skipped=${skipped}`);
}

main().catch((err) => {
  console.error("[import] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
