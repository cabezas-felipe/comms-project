-- Migration 011: dashboard_snapshots + meta_story_locks
--
-- dashboard_snapshots: one row per user, stores the last successfully computed
-- dashboard payload as JSONB.  Refreshed on bootstrap (funnel entry to dashboard)
-- and hourly via POST /api/dashboard/refresh.
--
-- meta_story_locks: one row per (user_id, meta_story_id). Stores the immutable
-- title + subtitle for a meta-story once it is first created.  Application code
-- uses ON CONFLICT DO NOTHING semantics — once a lock exists it is never updated.
-- This enforces the MVP invariant: no silent renames across refreshes.

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  user_id      UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  payload      JSONB       NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboard_snapshots_refreshed_at_idx
  ON dashboard_snapshots (refreshed_at DESC);

ALTER TABLE dashboard_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE dashboard_snapshots TO service_role;

CREATE TABLE IF NOT EXISTS meta_story_locks (
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  meta_story_id TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  subtitle      TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, meta_story_id)
);

ALTER TABLE meta_story_locks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE meta_story_locks TO service_role;
