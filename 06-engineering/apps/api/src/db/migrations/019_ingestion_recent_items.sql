-- Migration 019: ingestion_recent_items (Tier-A ephemeral fetch cache)
--
-- Sub-slice 2.2 establishes the write-path cache for recently-fetched and
-- normalized RSS items.  Multiple users' refreshes share one upstream fetch
-- per cache TTL.  The refresh read path stays on the live fetch in 2.2; the
-- refresh-from-cache wiring lands in Sub-slice 2.3.
--
-- Posture (mirrors other internal tables — story_rejections, meta_story_locks):
--   - Internal, service-role only.  Clients never read or write this table.
--   - RLS enabled with no policies → anon/authenticated get default-deny.
--   - Append/upsert by `source_id`; `purgeExpired` deletes rows past expires_at.
--
-- Indexes: feed_id supports per-feed lookups (2.3 read path); expires_at
-- supports the purge job's range scan.

CREATE TABLE IF NOT EXISTS public.ingestion_recent_items (
  source_id     TEXT         PRIMARY KEY,
  feed_id       TEXT         NOT NULL,
  url           TEXT,
  headline      TEXT,
  snippet       TEXT,
  published_at  TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS ingestion_recent_items_feed_id_idx
  ON public.ingestion_recent_items (feed_id);

CREATE INDEX IF NOT EXISTS ingestion_recent_items_expires_at_idx
  ON public.ingestion_recent_items (expires_at);

ALTER TABLE public.ingestion_recent_items ENABLE ROW LEVEL SECURITY;

-- Service-role only — clients never read or write this table directly.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingestion_recent_items TO service_role;
