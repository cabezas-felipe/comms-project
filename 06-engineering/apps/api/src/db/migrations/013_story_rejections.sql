-- Migration 013: story rejection log (Phase 3 strict grounding)
-- Append-only record of meta-stories dropped from the dashboard during
-- grounding verification.  Internal — never returned in dashboard responses.
-- Used for analysis (which prompts hallucinate, which evidence maps fail,
-- aggregate reason-code trends).

CREATE TABLE IF NOT EXISTS story_rejections (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  meta_story_id   TEXT,
  reason_code     TEXT         NOT NULL,
  source_item_ids JSONB        NOT NULL DEFAULT '[]',
  debug_payload   JSONB,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS story_rejections_user_created_idx
  ON story_rejections (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS story_rejections_reason_idx
  ON story_rejections (reason_code);

ALTER TABLE story_rejections ENABLE ROW LEVEL SECURITY;

-- Service-role only — clients never read this table directly.
GRANT SELECT, INSERT, DELETE ON story_rejections TO service_role;
GRANT USAGE, SELECT ON SEQUENCE story_rejections_id_seq TO service_role;
