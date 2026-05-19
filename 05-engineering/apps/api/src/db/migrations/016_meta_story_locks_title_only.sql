-- Migration 016: meta_story_locks → title-only locks
--
-- Product rule (meta-story fields PR — Prompt 1): on first publish, only the
-- meta-story's `title` is frozen across refreshes.  The `subtitle` field
-- carries clustering context (one-sentence placement of the story) and must
-- re-render every refresh as the evidence shifts, so we stop locking it.
--
-- Strategy:
--   - Drop the NOT NULL constraint on `subtitle` so new inserts can omit it.
--   - Leave existing `subtitle` values in place (historical, ignored at read
--     time by `dashboard-snapshot-repo.mjs:getLockedTitlesSupabase` which now
--     only `SELECT`s `title`).
--   - No backfill / DELETE — keeping the legacy values is harmless and
--     preserves auditability of what the frozen subtitle used to be.

ALTER TABLE meta_story_locks
  ALTER COLUMN subtitle DROP NOT NULL;
