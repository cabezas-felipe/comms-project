-- Migration 018: publisher_display_name on source_entities
--
-- Explicit publisher brand for dashboard outlet labels (B1 in the
-- publisher-outlet spec). Section-level canonical_name values (e.g.
-- "The Washington Post — World") keep their feed/entity identity for
-- matching; publisher_display_name is what mapEntry surfaces as outlet.
--
-- Nullable for backward compat; listIngestionFeeds falls back to
-- derivePublisherFromFeedName(canonical_name) when unset.

ALTER TABLE source_entities
  ADD COLUMN IF NOT EXISTS publisher_display_name TEXT;
