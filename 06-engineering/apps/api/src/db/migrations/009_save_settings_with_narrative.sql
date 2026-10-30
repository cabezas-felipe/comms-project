-- Migration 009: save_settings_with_narrative — atomic RPC for settings + narrative
--
-- Problem
-- -------
-- The prior sequential write path (writeSettings → appendOnboardingNarrative) leaves
-- a window where settings are committed in Postgres but the narrative write has not
-- yet happened.  If the narrative insert fails, the API returns 500 but settings are
-- already persisted.  Re-submitting succeeds on the next attempt, but the in-flight
-- failure produces an inconsistent state from the caller's perspective.
--
-- Solution
-- --------
-- A plpgsql function wraps both writes inside a single transaction.  In Postgres, a
-- plpgsql function body executes atomically by default: any unhandled exception causes
-- an automatic ROLLBACK of all statements that ran inside the function.  The caller
-- sees an error, and neither the settings upsert nor the narrative insert is persisted.
--
-- Source registry sync is intentionally kept OUTSIDE this transaction.
-- Rationale: source_registry_events is an append-only observation log used for
-- analytics/deduplication.  Its write already swallows errors internally.  Including
-- it here would require passing an arbitrary array of delta rows as an RPC parameter,
-- adding complexity with no correctness benefit: duplicate or missing registry events
-- on a retry are harmless, while a settings rollback on registry failure would break
-- the user experience for a non-critical subsystem.
--
-- SECURITY DEFINER
-- ----------------
-- The function runs with the privileges of its defining role (postgres/service_role),
-- not the calling role.  This ensures it can write to both tables (which have RLS
-- enabled with no public policies) regardless of the JWT in the calling request.
-- SET search_path = public prevents search_path injection.
--
-- Manual rollback note (operator)
-- --------------------------------
-- If you need to undo a specific onboarding save atomically from the console:
--   BEGIN;
--   DELETE FROM user_onboarding_narratives WHERE user_id = '<uuid>' AND submitted_at = '<ts>';
--   UPDATE settings SET data = '<prior_data>', updated_at = now() WHERE key = 'user:<uuid>';
--   COMMIT;
-- Or simply delete the narrative row; the settings row will reflect the last save.

CREATE OR REPLACE FUNCTION save_settings_with_narrative(
  p_settings_key      TEXT,
  p_settings_data     JSONB,
  p_contract_version  TEXT,
  p_user_id           UUID,
  p_raw_text          TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1. Upsert settings row (mirrors writeSettingsSupabase in settings-repo.mjs).
  INSERT INTO settings (key, data, contract_version, updated_at)
  VALUES (p_settings_key, p_settings_data, p_contract_version, now())
  ON CONFLICT (key) DO UPDATE SET
    data             = EXCLUDED.data,
    contract_version = EXCLUDED.contract_version,
    updated_at       = EXCLUDED.updated_at;

  -- 2. Demote any existing current narrative for this user.
  UPDATE user_onboarding_narratives
  SET is_current = false
  WHERE user_id = p_user_id
    AND is_current = true;

  -- 3. Insert new narrative as the current row.
  --    A raised exception in any of the above rolls back all three statements.
  INSERT INTO user_onboarding_narratives (user_id, raw_text, is_current)
  VALUES (p_user_id, p_raw_text, true);
END;
$$;

-- Service role needs EXECUTE (same pattern as the DML GRANTs in migration 005).
GRANT EXECUTE ON FUNCTION save_settings_with_narrative(TEXT, JSONB, TEXT, UUID, TEXT) TO service_role;
