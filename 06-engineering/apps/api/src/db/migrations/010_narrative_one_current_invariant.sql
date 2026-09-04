-- Migration 010: narrative_one_current_invariant
--
-- Enforces the invariant: at most one row per user_id may have is_current = true
-- in user_onboarding_narratives.  The application already maintains this via an
-- explicit demote step before each insert, but without a DB constraint a race
-- condition or a direct write could silently violate it.
--
-- Cleanup runs before index creation because CREATE UNIQUE INDEX fails
-- immediately if existing rows already violate the constraint.  The UPDATE below
-- resolves any pre-existing duplicates so the index can be created cleanly.

-- Step 1: demote duplicate current rows, keeping the newest per user.
WITH keepers AS (
  SELECT DISTINCT ON (user_id) id
  FROM  user_onboarding_narratives
  WHERE is_current = true
  ORDER BY user_id, submitted_at DESC, id DESC
)
UPDATE user_onboarding_narratives
SET    is_current = false
WHERE  is_current = true
  AND  id NOT IN (SELECT id FROM keepers);

-- Step 2: enforce the invariant at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS user_onboarding_narratives_one_current_per_user_idx
  ON user_onboarding_narratives (user_id)
  WHERE is_current = true;
