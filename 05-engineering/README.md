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

## Supabase deploy order

When shipping the `contract_version` column (migration 003):

1. **Run migration first** — apply `apps/api/src/db/migrations/003_contract_version_column.sql` in the Supabase SQL editor before deploying any new API code.
2. **Verify** — in the SQL editor:
   ```sql
   -- column exists and is populated
   SELECT key, contract_version FROM settings;

   -- data JSON no longer contains contractVersion
   SELECT COUNT(*) FROM settings WHERE data ? 'contractVersion';
   -- expected: 0
   ```
3. **Deploy API and frontend together** — once the migration is confirmed clean.

Migration status (closeout): migration `003_contract_version_column` has been applied on the Tempo Supabase project, `settings.contract_version` is populated, and `settings.data` no longer contains `contractVersion` keys.

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

If this release includes a DB migration, complete the [Supabase deploy order](#supabase-deploy-order) steps first.

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
