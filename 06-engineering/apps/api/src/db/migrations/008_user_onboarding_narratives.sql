-- Migration 008: user_onboarding_narratives — append-only free-text storage
--
-- Purpose
-- -------
-- Persist the raw onboarding text the user typed (or spoke → transcribed) so
-- re-extraction and future analytics can reprocess it without touching derived
-- outputs (settings, source_registry_events).  See product decision: Pattern A.
--
-- Data model
-- ----------
-- Append-only with `is_current` flag: a new row is inserted on every successful
-- onboarding save; the previous row(s) are flipped to is_current = false.  The
-- original text is never overwritten or deleted by the application — only the
-- is_current pointer moves.  This satisfies the "immutable original" requirement
-- while keeping the query for the latest narrative simple.
--
-- Foreign key: ON DELETE CASCADE — when a user is removed from auth.users, their
-- narratives are deleted automatically.  This is the safest default for an MVP
-- with no separate "account closure" flow.  If a soft-delete strategy is added
-- later, update the FK to ON DELETE SET NULL and add a deleted_at column.
--
-- Manual deletion path (operator)
-- --------------------------------
-- To purge a specific user's narratives:
--   DELETE FROM user_onboarding_narratives WHERE user_id = '<uuid>';
-- To inspect the current narrative for a user:
--   SELECT raw_text, submitted_at FROM user_onboarding_narratives
--   WHERE user_id = '<uuid>' AND is_current = true;
--
-- RLS posture
-- -----------
-- RLS is enabled; no public (anon/authenticated) read or write policies are
-- added.  All access goes through the server-side API using SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS.  If a future slice needs direct browser reads (e.g., "edit
-- your narrative"), add a SELECT policy scoped to auth.uid() at that time.
-- Explicit GRANT to service_role is included (same pattern as migration 005).

CREATE TABLE IF NOT EXISTS user_onboarding_narratives (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raw_text     TEXT        NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current   BOOLEAN     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS uon_user_id_idx        ON user_onboarding_narratives (user_id);
CREATE INDEX IF NOT EXISTS uon_user_current_idx   ON user_onboarding_narratives (user_id) WHERE is_current = true;

ALTER TABLE user_onboarding_narratives ENABLE ROW LEVEL SECURITY;

-- Service role needs explicit table-level privileges (see migration 005 for context).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_onboarding_narratives TO service_role;
