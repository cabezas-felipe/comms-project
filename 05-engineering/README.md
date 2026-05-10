# Engineering workspace

All Node workspace tooling for Tempo lives here: `package.json`, `package-lock.json`, `apps/web`, and `packages/*`. Engineering decisions: [`DECISIONS.md`](DECISIONS.md).

The Lovable reference UI stays in [`../04-prototype`](../04-prototype) and depends on shared packages via `file:../05-engineering/packages/...`.

## Commands

Run from **this directory** (`05-engineering/`):

| Command | Purpose |
|--------|---------|
| `npm install` | Install workspace packages and link `apps/web` to `@tempo/*`. |
| `npm run build:packages` | Build `@tempo/contracts` and `@tempo/analytics` to `dist/`. |
| `npm run dev` | Build packages, then start the prototype Vite dev server. |
| `npm run build` | Build packages, then production-build the prototype. |
| `npm run test:packages` | Unit tests for contracts + analytics. |
| `npm run test:prototype` | Prototype Vitest suite. |

After changing shared packages, run `npm run build:packages` before prototype dev/build if types or `dist/` outputs change.

## Supabase migrations

Migrations live in `apps/api/src/db/migrations/*.sql` and are applied in lexical order via the `db:migrate` runner. Each successful apply records a row in `public.schema_migrations`, so reruns are no-ops.

**One-time setup** — add a postgres connection string to `apps/api/.env`:

```
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@db.<project-ref>.supabase.co:5432/postgres
```

Find it in Supabase Dashboard → your project → "Connect" button → URI (or Project Settings → Database). The pooler URL works too if the region matches; use the direct host shown above when in doubt.

**Apply pending migrations:**

```sh
npm run db:migrate --workspace=@tempo/api          # apply all pending
npm run db:migrate:dry --workspace=@tempo/api      # list pending only
```

**Backfill the ledger** for migrations applied before the runner existed (or applied manually in the SQL editor):

```sh
npm run db:migrate --workspace=@tempo/api -- --mark-applied=001_initial.sql,002_user_settings.sql
```

This inserts ledger rows without executing the SQL. Use it once per environment to bring the tracker in sync; every subsequent migration runs through the runner.

**Deploy order with a migration in flight:**

1. `npm run db:migrate --workspace=@tempo/api` against the target environment's `DATABASE_URL` first.
2. Deploy API + frontend together once the migration is confirmed.

## Source scope (Phase 1: Washington Post only)

The Supabase manifest's `active` flag is the **primary** lever that decides which feeds run during ingestion. The runtime guard `TEMPO_RSS_ALLOWLIST` (defaults to `washington post`) is defense-in-depth — it filters again at fetch time. `TEMPO_INGESTION_ALLOWLIST` is accepted as a legacy alias for backwards compatibility; new configuration should use `TEMPO_RSS_ALLOWLIST`.

The `db:scope:*` scripts wrap the manifest writes safely. They record every row they disable in a `public.phase1_disabled_feeds` tracker table (created on first run) so `restore` only touches rows that this script disabled — never rows that were already inactive for unrelated reasons.

```sh
npm run db:scope:verify --workspace=@tempo/api          # read-only state dump (+ JSON via -- --json)
npm run db:scope:apply:dry --workspace=@tempo/api       # preview the apply without writing
npm run db:scope:apply --workspace=@tempo/api           # disable non-WaPo rows + record in tracker
npm run db:scope:restore:dry --workspace=@tempo/api     # preview the restore
npm run db:scope:restore --workspace=@tempo/api         # restore prev_active to recorded rows + clear tracker
```

`apply` is idempotent (re-running on a fully applied state is a no-op). `restore` consults the tracker first; if the tracker is empty, it does nothing.

To open up beyond Phase 1 you also need to remove the runtime guard:

```sh
# In your API environment (.env or process env):
TEMPO_RSS_ALLOWLIST=*
```

## Deployment

### Prerequisites

| Tool | Setup |
|------|-------|
| Vercel CLI | `npm i -g vercel` (or use `npx vercel`) |
| Authenticated | `vercel login` |
| Frontend linked | `cd ../04-prototype && npx vercel link` (one-time; creates `.vercel/project.json` — keep local, do not commit unless the team intentionally standardizes project linkage in-repo) |

Required env vars (set in Vercel project dashboard, not locally):

| Variable | Where |
|----------|-------|
| `VITE_SUPABASE_URL` | Vercel → Frontend project → Environment Variables |
| `VITE_SUPABASE_ANON_KEY` | Vercel → Frontend project → Environment Variables |

### Staging (preview deploy)

```sh
npm run deploy:frontend
```

Vercel prints a preview URL. Share for review before promoting to production.

### Production deploy sequence

If this release includes a DB migration, run `npm run db:migrate --workspace=@tempo/api` against the target environment first (see [Supabase migrations](#supabase-migrations)).

```sh
npm run deploy:frontend:prod
npm run verify:api:health
```

### Post-deploy verification

**API health check** (automated by `verify:api:health`):

```sh
curl https://tempo-gray-psi.vercel.app/health
```

**Settings migration check** (manual — run in Supabase SQL editor):

```sql
-- column exists and is populated
SELECT key, contract_version FROM settings;

-- data JSON no longer contains contractVersion (expected: 0)
SELECT COUNT(*) FROM settings WHERE data ? 'contractVersion';
```

Or run `npm run verify:settings:migration` to print the queries to your terminal.

### API deployment

The API (`apps/api`) is a **separate Vercel project** (`tempo-gray-psi`). It is not deployed by this workspace's scripts. Recommended options:

- **Vercel dashboard GitHub integration** — connect `apps/api` as the root directory of the `tempo-gray-psi` project; Vercel deploys automatically on push to `main`.
- **Manual deploy** — `cd apps/api && npx vercel --prod`

The frontend proxies all `/api/*` requests to the API project via `04-prototype/vercel.json`; both projects must be current for the app to function correctly.
