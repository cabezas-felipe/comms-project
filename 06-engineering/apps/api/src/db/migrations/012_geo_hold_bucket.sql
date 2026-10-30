-- Migration 012: geo hold bucket
-- Stores items that failed geo-confidence thresholds but are not outright
-- irrelevant — they may be promoted when confidence improves or thresholds
-- are relaxed.  One row per user; items column is a JSONB array.

CREATE TABLE IF NOT EXISTS geo_hold_bucket (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  items      JSONB       NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);

ALTER TABLE geo_hold_bucket ENABLE ROW LEVEL SECURITY;

-- Service-role has full access (used by the API); authenticated users have no
-- direct table access (all access goes through the API layer).
GRANT SELECT, INSERT, UPDATE, DELETE ON geo_hold_bucket TO service_role;
