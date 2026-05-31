# Runbook — Ingestion cache warmer (`write_error`)

Scope: the scheduled **Ingestion cache warmer** GitHub workflow
([`.github/workflows/ingestion-warm.yml`](../../.github/workflows/ingestion-warm.yml))
running [`apps/api/src/ops/ingestion-warm.mjs`](../apps/api/src/ops/ingestion-warm.mjs).

## Reading the log

The warmer emits one single-line JSON summary tagged `[ingestion-warm]`. Grep
the workflow run for it:

```
grep '\[ingestion-warm\]' <run-log>
```

Stable fields: `ok`, `skippedReason` (failures only), `error`, `itemCount`,
`feedCount`, `written`, `durationMs`. As of Slice 20 the `error` field is a
serialized, actionable string — supabase/PostgREST errors are rendered as a
compact JSON of `message`/`code`/`details`/`hint`/`status` instead of the old
opaque `[object Object]`.

## `skippedReason=write_error` — operator checklist

`write_error` means the read succeeded but `writeRecentItems` upsert into
`ingestion_recent_items` returned a supabase error. The warmer code is doing the
right thing (it fails closed and exits 1 so cron retries); the cause is almost
always **env/schema-side**. Use `error.code` to triage:

| `code` | Meaning | Operator action |
| --- | --- | --- |
| `42501` | permission denied for table | Grant the service role write access: `grant insert, update on table ingestion_recent_items to service_role;`. Verify the run uses the **service-role** key, not the anon key. |
| `42P01` | undefined table | Table missing — run the migration that creates `ingestion_recent_items` against the target project. |
| `PGRST204` / `PGRST205` | column/table not in PostgREST schema cache | Migration not applied to this project, or schema cache stale — reload it (Supabase: API → "Reload schema cache") or redeploy migrations. |
| `23505` | unique violation on `source_id` | Batch dedupe regression — should not occur (`buildRecentItemRows` dedupes by `source_id`); capture the row and file a bug. |
| `42703` | undefined column | Row shape drifted from schema — reconcile `projectRow` columns with the table. |
| `status` 401/403 (no `code`) | auth/transport rejection | Re-check `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` repo secrets (Settings → Secrets and variables → Actions); confirm the key belongs to the same project as the URL. |

### Secret / env verification

1. Repo secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present and
   point at the **same** project (a `missing_supabase_env` reason means one is
   unset).
2. The key is the **service role** key (writes bypass RLS); the anon key yields
   `42501`.
3. The migration creating `ingestion_recent_items` (columns: `source_id`,
   `feed_id`, `url`, `headline`, `snippet`, `published_at`, `fetched_at`,
   `expires_at`; PK/unique on `source_id`) has been applied to that project.

## Other `skippedReason` values

- `missing_supabase_env` — a required secret is unset (see above).
- `supabase_client_failed` — client construction threw; `error` carries the cause.
- `read_threw` — the live feed read threw before any write (network/manifest);
  not a cache problem.
- `write_threw` — the upsert call itself threw (transport); `error` carries the
  serialized cause including `code`/`status` when present.
