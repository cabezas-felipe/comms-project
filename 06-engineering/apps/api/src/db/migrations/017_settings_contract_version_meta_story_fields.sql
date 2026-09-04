-- Migration 017: Allow meta-story-fields contract version on settings
--
-- The app CONTRACT_VERSION bumped to 2026-05-19-meta-story-fields but some
-- environments still enforce settings_contract_version_check from the slice1
-- rollout. Onboarding atomic save (save_settings_with_narrative) then fails
-- with: new row for relation "settings" violates check constraint
-- "settings_contract_version_check".

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_contract_version_check;

ALTER TABLE settings
  ADD CONSTRAINT settings_contract_version_check
  CHECK (contract_version IN ('2026-04-22-slice1', '2026-05-19-meta-story-fields'));

ALTER TABLE settings
  ALTER COLUMN contract_version SET DEFAULT '2026-05-19-meta-story-fields';
