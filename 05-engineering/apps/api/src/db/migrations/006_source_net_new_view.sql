-- Migration 006: v_source_net_new_24h — net-new source digest view
--
-- Purpose
-- -------
-- Provides the daily operator digest: sources that appeared in
-- source_registry_events within the last 24 hours and have not yet been
-- mapped to a verified canonical entity. Query it directly from the Supabase
-- SQL editor, the PostgREST REST API, or the digest script.
--
-- The 24-hour window is evaluated at query time (NOW() - INTERVAL '24 hours'),
-- so the view always reflects "last 24 hours relative to when you run it".
--
-- Columns
-- -------
--   raw_string      text        The exact string the user typed
--   kind            text        'traditional' | 'social'
--   first_seen_at   timestamptz Earliest event in the window
--   last_seen_at    timestamptz Latest event in the window
--   times_seen      integer     Total event count in the window
--   sample_user_ids uuid[]      Up to 3 distinct user IDs (operator context only)
--
-- Exclusion logic
-- ---------------
-- A source is excluded when ALL of the following hold:
--   1. normalize_source_alias(raw_string) matches an alias_normalized in
--      source_aliases, AND
--   2. that alias links to a source_entities row that has a
--      source_feed_mapping row with status IN ('mapped', 'verified').
--
-- Sources with status 'pending' or 'rejected' still appear — pending means
-- the operator hasn't finished; rejected means explicitly out-of-scope.
-- If no source_feed_mapping row exists yet the source always appears.
--
-- Known limitation
-- ----------------
-- resolved_entity_id on source_registry_events is not populated by Phase 1
-- sync (it stays NULL). Exclusion relies entirely on the alias lookup above.
-- If an entity exists but has no alias covering this exact raw_string, the
-- source will keep appearing in the digest until the operator adds an alias.
-- See SOURCE-REGISTRY-PHASE2-PLAYBOOK.md.
--
-- Idempotency: CREATE OR REPLACE VIEW is safe to re-run.

CREATE OR REPLACE VIEW v_source_net_new_24h AS
SELECT
  e.raw_string,
  e.kind,
  MIN(e.seen_at)                        AS first_seen_at,
  MAX(e.seen_at)                        AS last_seen_at,
  COUNT(*)::integer                     AS times_seen,
  -- Slice to at most 3 distinct user IDs — enough for operator context
  -- without exposing the full population. Array order is non-deterministic.
  (array_agg(DISTINCT e.user_id))[1:3]  AS sample_user_ids
FROM source_registry_events e
WHERE
  -- Rolling 24-hour window relative to query time
  e.seen_at >= NOW() - INTERVAL '24 hours'
  -- Exclude sources already mapped/verified via the alias table
  AND NOT EXISTS (
    SELECT 1
    FROM   source_aliases      sa
    JOIN   source_entities     se  ON se.id  = sa.source_entity_id
    JOIN   source_feed_mapping sfm ON sfm.source_entity_id = se.id
    WHERE  sa.alias_normalized = normalize_source_alias(e.raw_string)
      AND  sfm.status IN ('mapped', 'verified')
  )
GROUP BY e.raw_string, e.kind;

-- Note: no ORDER BY here — PostgreSQL rejects ORDER BY at the outer level of
-- a simple view definition. Sort in queries: ORDER BY times_seen DESC, first_seen_at.

-- Grant SELECT to service_role (consistent with migration 005 posture).
-- The digest script and any future automation uses the service role key;
-- no anon/authenticated access is needed.
GRANT SELECT ON v_source_net_new_24h TO service_role;
