-- Slice 11: Initial Supabase schema
-- Run via Supabase SQL editor or CLI: supabase db push
--
-- Free-tier-first: works on Supabase Free plan.
-- Pro triggers: add pg_cron for scheduled ingestion, increase DB size past 500 MB,
--               enable realtime for live monitoring feeds.

-- ─── Settings ─────────────────────────────────────────────────────────────────
-- Replaces local data/settings.json.
-- Current key: "global_settings" (single-tenant).
-- Migration path: add user_id column + FK when Supabase Auth is wired (future slice).

CREATE TABLE IF NOT EXISTS settings (
  key              TEXT        PRIMARY KEY,
  data             JSONB       NOT NULL,
  -- data contains only: topics, keywords, geographies, traditionalSources, socialSources
  -- contractVersion was extracted to contract_version via migration 003
  contract_version TEXT        NOT NULL DEFAULT '2026-04-22-slice1',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Stories (placeholder) ────────────────────────────────────────────────────
-- Minimal schema; extend when the ingestion pipeline is built (future slice).

CREATE TABLE IF NOT EXISTS stories (
  id          TEXT        PRIMARY KEY,
  cluster_id  TEXT        NOT NULL,
  raw         JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stories_cluster_id_idx ON stories (cluster_id);
CREATE INDEX IF NOT EXISTS stories_created_at_idx ON stories (created_at DESC);

-- ─── Summaries (placeholder) ──────────────────────────────────────────────────
-- Stores AI-generated summaries keyed to stories (future slice).

CREATE TABLE IF NOT EXISTS summaries (
  id              TEXT        PRIMARY KEY,
  story_id        TEXT        NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  model           TEXT        NOT NULL,
  prompt_version  TEXT        NOT NULL,
  summary         TEXT        NOT NULL,
  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS summaries_story_id_idx ON summaries (story_id);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- RLS enabled on all tables.
-- Server-side API uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS entirely.
-- Anon-key policies will be added when Supabase Auth is introduced (future slice).

ALTER TABLE settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE summaries ENABLE ROW LEVEL SECURITY;
