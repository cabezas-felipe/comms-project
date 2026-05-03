-- Migration 005: Grant service_role DML on source registry tables
--
-- Context
-- -------
-- Phase 0 (004_source_registry.sql) created four source registry tables with RLS
-- enabled and no permissive policies for anon/authenticated roles.  The Supabase
-- service role bypasses RLS row-by-row, but still requires explicit table-level
-- PostgreSQL privileges.  In some Supabase project configurations, tables created
-- after the initial provisioning do not automatically inherit default privileges
-- for the service_role PostgreSQL role.
--
-- Symptom: Phase 1 sync (PUT /api/settings → source_registry_events batch insert)
-- failed with:
--   "permission denied for table source_registry_events"
-- even though the server uses SUPABASE_SERVICE_ROLE_KEY.  A manual GRANT on the
-- live database resolved the failure.  This migration codifies those grants so
-- future environments (new Supabase project, staging) do not hit the same error.
--
-- Scope
-- -----
-- All four Phase 0 source registry tables receive full DML privileges:
--   source_entities          — canonical outlet/account rows
--   source_aliases           — alias → entity mapping
--   source_registry_events   — append-only per-save observation log
--   source_feed_mapping      — operator-managed RSS/social URL mapping
--
-- Idempotency: GRANT is additive and safe to re-run.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE source_entities        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE source_aliases         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE source_registry_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE source_feed_mapping    TO service_role;
