-- Enable RLS on operational tables that previously shipped with RLS disabled.
-- Supabase security advisor: anon/authenticated roles could read/write these
-- rows when RLS was off. With RLS enabled and no policies, those roles get
-- the default deny; service_role and other bypass paths keep working as before.
--
-- Applied to production via Supabase MCP on 2026-05-12.

ALTER TABLE IF EXISTS public.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.phase1_disabled_feeds ENABLE ROW LEVEL SECURITY;
