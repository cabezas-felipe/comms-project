-- Migration 007: Add ingestion_weight and active columns to source_feed_mapping
--
-- Purpose
-- -------
-- Phase 3 (Option B) promotes Supabase as the source of truth for the ingestion
-- feed manifest.  GET /api/ingestion/sources now reads from source_feed_mapping
-- (joined with source_entities) instead of source-feeds.json when Supabase is
-- enabled.  Two fields are needed to replicate the full manifest contract:
--
--   ingestion_weight  — relative ingestion priority (0–100, default 50).
--                       Mirrors the "weight" field in source-feeds.json.
--   active            — whether this feed is currently being ingested (default true).
--
-- Idempotency
-- -----------
-- ADD COLUMN IF NOT EXISTS is safe to re-run on any environment that already has
-- the column.  The CHECK constraint is dropped before re-adding so a re-run after
-- a partial apply doesn't fail with "constraint already exists".

ALTER TABLE source_feed_mapping
  ADD COLUMN IF NOT EXISTS ingestion_weight INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS active           BOOLEAN NOT NULL DEFAULT TRUE;

-- Re-entrant constraint: drop first so the ADD is always idempotent.
ALTER TABLE source_feed_mapping
  DROP CONSTRAINT IF EXISTS source_feed_mapping_ingestion_weight_range;

ALTER TABLE source_feed_mapping
  ADD CONSTRAINT source_feed_mapping_ingestion_weight_range
    CHECK (ingestion_weight BETWEEN 0 AND 100);
