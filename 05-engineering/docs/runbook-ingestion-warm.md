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

Phase 3 adds X (social) warm fields: `xEnabled`, `xHandlesWarmed`, `xItemCount`,
`xWritten` (see [X warm](#x-warm-phase-3) below).

## X warm (Phase 3)

After the RSS warm, the warmer optionally fetches a configured list of X handles
and upserts their tweets into the **same** `ingestion_recent_items` cache, so
interactive refreshes serve social handles from cache instead of paying the live
X-API latency. It is **opt-in** and gated twice: the X feature must be enabled
(bearer token present) **and** a non-empty warm list must be configured.

### Required GitHub Actions secrets / variables

Configure under **repo Settings → Secrets and variables → Actions**:

| Kind | Name | Required? | Purpose |
| --- | --- | --- | --- |
| Secret | `SUPABASE_URL` | Yes | Service-role write target (shared with RSS warm). |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | Yes | Warmer writes as the service role. |
| Secret | `TEMPO_X_BEARER_TOKEN` | For X warm | App-only Bearer. **Absent ⇒ X warm skipped, RSS-only success** (not a failure). Never logged. |
| Variable | `TEMPO_X_WARM_HANDLES` | For X warm | Comma-separated pilot handles, e.g. `petrogustavo,whitehouse,rapidresponse47`. A repo **variable** (not a secret) — the handle list is not sensitive. **Unset/empty ⇒ X warm skipped.** |

The workflow pins `TEMPO_X_INGESTION_ENABLED: "true"`; the effective gate is
whether the bearer secret is present (the script reads a missing/blank token as
disabled). So you enable X warm purely by adding the `TEMPO_X_BEARER_TOKEN`
secret and the `TEMPO_X_WARM_HANDLES` variable — no workflow edit needed.

### Verifying a successful X warm

Grep the run log and confirm `xItemCount > 0`:

```
grep '\[ingestion-warm\]' <run-log>
# … "ok":true, "xEnabled":true, "xHandlesWarmed":3, "xItemCount":42, "xWritten":42 …
```

- `xEnabled:false` ⇒ the bearer secret is absent/blank (X disabled) — expected
  for an RSS-only deployment; not an error.
- `xEnabled:true, xHandlesWarmed:0` ⇒ the feature is on but `TEMPO_X_WARM_HANDLES`
  is unset/empty — set the repo variable.
- `xEnabled:true, xHandlesWarmed:N, xItemCount:0` ⇒ handles fetched but no tweets
  in the 24h window (quiet handles) — benign; the cache simply has nothing to
  serve for them this hour.

### Triage: `x_read_threw` / `x_write_threw` / `x_write_error`

These are fatal (exit 1) **only once X warm was attempted** (enabled + handles
set); the RSS warm has already succeeded by then.

| `skippedReason` | Meaning | Operator action |
| --- | --- | --- |
| `x_read_threw` | The X reader threw before any X write (lookup/timeline error). | Check `error` for the X-API status: `401`/`403` ⇒ bad/expired `TEMPO_X_BEARER_TOKEN`; `429` ⇒ rate-limited (trim `TEMPO_X_WARM_HANDLES` or wait for the next hour); network/timeout ⇒ transient, the next hourly warm retries. |
| `x_write_threw` | The X cache upsert call itself threw (transport). | Same transport checks as RSS `write_threw` — `error` carries `code`/`status`. |
| `x_write_error` | The X upsert returned a supabase error envelope. | Identical triage to the RSS [`write_error` table](#skippedreasonwrite_error--operator-checklist) above (`42501` permissions, `42P01` table missing, etc.) — same table, same `ingestion_recent_items` columns. |

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
