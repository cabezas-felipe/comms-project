# Slice 11 — Supabase Production Data Foundation

**Branch:** `build/slice11-supabase-foundation`
**Date:** 2026-04-23
**Status:** Complete

---

## Goal

Introduce a Supabase-backed persistence layer for settings while preserving current app behavior in tests and local dev. Free-tier-first; Pro-upgrade path documented but not required.

---

## What was built

### New: `apps/api/src/db/`


| File                     | Purpose                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.mjs`             | Supabase client factory. `isSupabaseEnabled()` — returns true only when `SUPABASE_URL` + a key var are set. `assertSupabaseEnv()` — throws with a human-readable message at startup if partially configured. `getSupabaseClient()` — lazy singleton, prefers `SUPABASE_SERVICE_ROLE_KEY` (server-side) over `SUPABASE_ANON_KEY`. |
| `settings-repo.mjs`      | Adapter pattern: `readSettings()` / `writeSettings()` route to the file-based or Supabase backend depending on env. Exports `DEFAULT_SETTINGS` so server.mjs has a single authoritative source for the contract version.                                                                                                         |
| `schema.sql`             | Initial schema. Run once against your Supabase project via the SQL editor or `supabase db push`.                                                                                                                                                                                                                                 |
| `settings-repo.test.mjs` | 7 tests covering the file adapter and env-validation helpers, including fail-fast behavior for partial Supabase configuration.                                                                                                                                                                                                   |


### Modified: `apps/api/src/server.mjs`

Removed local `ensureSettingsFile`, `readSettings`, `writeSettings`, `DEFAULT_SETTINGS`. These are now imported from `./db/settings-repo.mjs`. All other server behavior is unchanged.

### New: `apps/api/.env.example`

Documents every env var with inline notes. Copy to `.env` and fill in values to activate Supabase.

---

## Schema overview

```sql
-- In use now
settings   (key TEXT PK, data JSONB, updated_at TIMESTAMPTZ)

-- Placeholders for future slices
stories    (id, cluster_id, raw JSONB, created_at)
summaries  (id, story_id FK, model, prompt_version, summary, meta JSONB, created_at)
```

RLS is enabled on all tables. The server-side API uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS. Anon-key row policies are deferred until Supabase Auth is introduced.

---

## Activating Supabase

1. Create a project at [app.supabase.com](https://app.supabase.com).
2. Copy `apps/api/.env.example` → `apps/api/.env`.
3. Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Settings → API).
4. Run the schema: paste `src/db/schema.sql` into the Supabase SQL editor and execute.
5. Start the API — settings are now persisted in Supabase.

Leave `SUPABASE_URL` unset (or omit the `.env` file) to use file-based storage. No behavioral change.

---

## Auth baseline and migration path

**Current state (Slice 11):** Auth is localStorage-backed (`tempo.auth.session.v1` in `04-prototype/src/lib/auth.tsx`). Credentials are not persisted server-side. Settings are global (no per-user scope).

**Migration path to Supabase Auth (future slice):**

1. Add `@supabase/auth-ui-react` (or custom flow) to `04-prototype`.
2. Replace the localStorage session with Supabase `signIn` / `signOut`; propagate the JWT to the API via `Authorization: Bearer <token>`.
3. On the API side, verify the JWT using Supabase's `auth.getUser(token)` helper.
4. Add `user_id UUID` column to `settings` + row-level policies so each user sees only their own settings.
5. Remove the `global_settings` key; scope reads/writes to the authenticated user's ID.

**This slice does not implement any of the above.** It only establishes the foundation (client singleton, env validation, schema, adapter seam) so the migration above is a minimal incremental change.

---

## Free-tier now — Pro trigger conditions


| Trigger                                   | Why it requires Pro                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Scheduled ingestion (pull news on a cron) | Requires `pg_cron` or Edge Function cron — available on Pro                                      |
| DB size > 500 MB                          | Free tier limit; Pro extends to 8 GB                                                             |
| Realtime live monitoring feeds            | Realtime broadcast/presence is limited on Free (100 concurrent connections); Pro removes the cap |
| Custom domain for auth redirects          | Pro feature                                                                                      |
| Daily backups older than 7 days           | Free keeps 7 days; Pro extends to 30                                                             |


**Free tier is sufficient for:** settings persistence, story/summary storage at prototype scale, basic auth (up to 50,000 MAU), and the full schema above.

---

## Validation results

```
npm run test:api      → 26/26 pass (8 model-router + 6 settings-schema + 5 route-level + 7 settings-repo)
npm run build         → exit 0
npm run test:prototype → 9/9 pass
npx eslint src/lib/api.ts vite.config.ts → exit 0
node --check server.mjs → exit 0
```

---

## Risks and follow-up


| Risk                                                                     | Mitigation                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Supabase client singleton holds stale connection after network partition | Supabase JS client auto-reconnects; acceptable at prototype scale                                                  |
| `SUPABASE_SERVICE_ROLE_KEY` accidentally committed                       | `.env` is in `.gitignore`; `.env.example` uses placeholder values only                                             |
| Settings schema mismatch between JSON file and Supabase DB               | Zod validation on PUT `/api/settings` is the authoritative contract; both adapters receive a pre-validated payload |
| RLS disabled for server-side key — no row isolation                      | Intentional for single-tenant prototype; add user-scoped policies in the auth slice                                |
| `stories` / `summaries` tables are placeholders — no ingestion yet       | Documented as placeholders; extend in the ingestion slice                                                          |


---

## Rebuild note (2026-04-23 — D-029)

**Partial Supabase config now fails loudly instead of silently falling back.**

The original routing in `readSettings()` / `writeSettings()` used `isSupabaseEnabled()`, which returns `false` when `SUPABASE_URL` is set but key vars are absent. A partially configured deployment (URL present, no key) would silently use file storage, hiding the misconfiguration.

**Fix:** routing now checks `process.env.SUPABASE_URL` directly and calls `assertSupabaseEnv()` before entering the Supabase path. If the URL is set but a key var is missing, the function rejects immediately with a human-readable error naming the missing variable. File adapter behavior (no `SUPABASE_URL`) is unchanged.

Two tests were added to `settings-repo.test.mjs` to pin this contract:

1. `SUPABASE_URL` set + no key → `readSettings()` rejects with missing key message.
2. `SUPABASE_URL` unset → file adapter returns a valid settings object.

See D-029 in `DECISIONS.md` for full rationale.