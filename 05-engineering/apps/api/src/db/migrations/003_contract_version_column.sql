-- Migration 003: Extract contract_version from settings JSON into a dedicated column
--
-- Before:  settings.data JSONB = { contractVersion, topics, keywords, geographies,
--                                   traditionalSources, socialSources }
-- After:   settings.contract_version TEXT NOT NULL  (new dedicated column)
--          settings.data JSONB = { topics, keywords, geographies,
--                                  traditionalSources, socialSources }
--
-- Steps are ordered to allow a safe, idempotent run:
--   add column → backfill → strip JSON key → enforce NOT NULL → set default

-- 1. Add column as nullable so backfill can proceed without constraint violations.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS contract_version TEXT;

-- 2. Backfill from existing JSON data when the key is present.
UPDATE settings
SET   contract_version = data->>'contractVersion'
WHERE contract_version IS NULL
  AND data->>'contractVersion' IS NOT NULL;

-- 3. Apply current constant as fallback for any rows that had no contractVersion in JSON.
UPDATE settings
SET   contract_version = '2026-04-22-slice1'
WHERE contract_version IS NULL;

-- 4. Remove contractVersion from data JSON (idempotent — safe if key is already absent).
UPDATE settings
SET   data = data - 'contractVersion'
WHERE data ? 'contractVersion';

-- 5. Enforce NOT NULL now that every row has a value.
ALTER TABLE settings ALTER COLUMN contract_version SET NOT NULL;

-- 6. Default for future inserts so INSERT without the column stays valid.
ALTER TABLE settings ALTER COLUMN contract_version SET DEFAULT '2026-04-22-slice1';
