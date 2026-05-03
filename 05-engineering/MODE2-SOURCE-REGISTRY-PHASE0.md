# Source registry — Phase 0 (Supabase DDL only)

Phase 0 adds **tables and a normalization function** for the append-only source registry. No API or ingestion code yet (see [D-038 in DECISIONS.md](DECISIONS.md)).

## Artifacts in this repo

| Artifact | Purpose |
|----------|---------|
| [`apps/api/src/db/migrations/004_source_registry.sql`](apps/api/src/db/migrations/004_source_registry.sql) | **Run this** on your Supabase project (SQL editor or CLI). |
| [`apps/api/src/db/schema.sql`](apps/api/src/db/schema.sql) | Pointer comment; base slice-11 tables + RLS. New DDL is not duplicated here. |

## Prerequisites

- Supabase project already has the **slice-11 baseline** (`settings`, `stories`, `summaries`) and **migration 003** applied if you use the `settings.contract_version` column (see [`apps/api/src/db/migrations/003_contract_version_column.sql`](apps/api/src/db/migrations/003_contract_version_column.sql)).
- Phase 004 **does not alter** `settings`; it only creates new objects. Safe to apply on top of an existing DB that already runs the API.

## Apply migration 004

1. Open Supabase Dashboard → **SQL Editor** → New query.
2. Paste the **entire** contents of [`004_source_registry.sql`](apps/api/src/db/migrations/004_source_registry.sql).
3. Run once. Re-running is mostly idempotent (`CREATE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`); `ALTER TABLE … ENABLE ROW LEVEL SECURITY` is safe to repeat.

If you use Supabase CLI with linked project: run your usual workflow (for example `supabase db push` or paste the file into the editor) so this file is applied in the same environment as other migrations.

**Supabase MCP (Cursor plugin):** you can run the same DDL with the MCP tool `apply_migration`, passing `name: 004_source_registry` and `query` set to the full contents of [`004_source_registry.sql`](apps/api/src/db/migrations/004_source_registry.sql). That registers the change in Supabase migration history (check with the MCP `list_migrations` tool or the Dashboard migrations list). Use the same `name` as the repo file prefix so operators and automation stay aligned.

## Verify

```sql
-- Tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'source_entities',
    'source_aliases',
    'source_registry_events',
    'source_feed_mapping'
  )
ORDER BY 1;

-- Normalization helper
SELECT normalize_source_alias('  New York Times  ') AS normalized;
-- Expected: 'new york times'
```

## RLS and access

- RLS is **enabled** on all four new tables; **no** `anon` / `authenticated` policies yet (same posture as early `settings` / `stories` / `summaries` in [`schema.sql`](apps/api/src/db/schema.sql)).
- The API’s **service role** client bypasses RLS; future browser-facing reads need explicit policies.

## Model summary (for operators)

- **`source_entities`** — one row per canonical outlet or account (`kind`: `traditional` | `social`).
- **`source_aliases`** — maps normalized spellings to a single entity (`alias_normalized` is globally unique).
- **`source_registry_events`** — append-only log when a user’s settings include a source string (`user_id` = Supabase Auth user UUID; Phase 1 will insert here).
- **`source_feed_mapping`** — at most one row per entity: RSS URL, social profile URL, optional `manifest_feed_id` (for [`source-feeds.json`](apps/api/data/source-feeds.json) feed `id`), `status`, verification fields.

## Next (Phase 1) — done

`PUT /api/settings` now calls [`source-registry-sync.mjs`](apps/api/src/db/source-registry-sync.mjs) after a successful `writeSettings` (see [D-039 in DECISIONS.md](DECISIONS.md)).
