-- Migration 014: rejection-log dedup (Phase 4 hardening)
-- Adds watermark + stable dedup key to story_rejections so refreshes that
-- re-encounter the same failure under an unchanged watermark do not generate
-- duplicate rows (idempotency).

ALTER TABLE story_rejections
  ADD COLUMN IF NOT EXISTS watermark TEXT,
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- Unique on (user_id, dedup_key) — the upsert path uses this for ignoreDuplicates.
CREATE UNIQUE INDEX IF NOT EXISTS story_rejections_user_dedup_uidx
  ON story_rejections (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
