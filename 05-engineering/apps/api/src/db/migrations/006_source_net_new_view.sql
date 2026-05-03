-- Migration 006: v_source_net_new_24h — daily unmapped-source view
--
-- Purpose
-- -------
-- Surfaces source_registry_events from the last 24 hours that have NOT yet been
-- fully mapped through the alias → entity → feed-mapping pipeline.  Used by the
-- daily source-delta-digest ops script to build a Slack digest of net-new sources
-- that an operator still needs to map.
--
-- "Fully mapped" definition (consistent with product decisions)
-- -------------------------------------------------------------
-- A raw_string is considered mapped when:
--   1. normalize_source_alias(raw_string) matches source_aliases.alias_normalized
--   2. that alias resolves to a source_entities row
--   3. that entity has a source_feed_mapping row with status IN ('mapped', 'verified')
--
-- Notes
-- -----
-- - No ORDER BY at view level; consumers sort in their own queries.
-- - ARRAY_AGG sample_user_ids is capped to 5 elements via array slice [1:5].
-- - COUNT is cast to int for clean JSON serialisation from PostgREST.
-- - CREATE OR REPLACE is safe to re-run (idempotent).

CREATE OR REPLACE VIEW v_source_net_new_24h AS
SELECT
  e.raw_string,
  e.kind,
  MIN(e.created_at)                         AS first_seen_at,
  MAX(e.created_at)                         AS last_seen_at,
  COUNT(*)::int                             AS times_seen,
  (ARRAY_AGG(DISTINCT e.user_id))[1:5]      AS sample_user_ids
FROM source_registry_events e
WHERE e.created_at >= NOW() - INTERVAL '24 hours'
  AND NOT EXISTS (
    SELECT 1
    FROM   source_aliases    sa
    JOIN   source_entities   se  ON se.id  = sa.entity_id
    JOIN   source_feed_mapping sfm ON sfm.entity_id = se.id
    WHERE  sa.alias_normalized = normalize_source_alias(e.raw_string)
      AND  sfm.status IN ('mapped', 'verified')
  )
GROUP BY e.raw_string, e.kind;

-- service_role must be able to SELECT the view so the API key can query it.
GRANT SELECT ON v_source_net_new_24h TO service_role;
