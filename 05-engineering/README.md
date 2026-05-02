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
