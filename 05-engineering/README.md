# Engineering workspace

All Node workspace tooling for Tempo lives here: `package.json`, `package-lock.json`, `apps/web`, and `packages/*`. Engineering decisions: [`DECISIONS.md`](DECISIONS.md).

The Lovable reference UI stays in [`../04-prototype`](../04-prototype) and depends on shared packages via `file:../05-engineering/packages/...`.

## Key behaviors (canonical sources)

| Behavior | Canonical source | Doc |
|----------|------------------|-----|
| Onboarding extraction policy — hygiene-only, no fixed allowlists, Unicode-safe, MVP handle shape | [`onboarding-extractor.mjs`](apps/api/src/ai/onboarding-extractor.mjs) top-of-file comment block | [story-pool spec § Onboarding extraction](docs/dashboard-story-pool-spec.md#onboarding-extraction-open-vocabulary-hygiene-only) |
| Lexical recall whole-word matching (`\b<token>\b`) | [`applyTopicKeywordFilter` in `refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) | [story-pool spec § Ingress funnel](docs/dashboard-story-pool-spec.md#ingress-funnel-pre-candidate) |
| Embedding union (`hybrid_strict`) — recall widening, degraded reasons, profile-axis diagnostics | [`embedding-recall.mjs`](apps/api/src/ingestion/embedding-recall.mjs) | [story-pool spec § Observability](docs/dashboard-story-pool-spec.md#observability) |
| Settings save → manual dashboard refresh trigger | [`refresh-context.tsx` `triggerDashboardRefresh`](../04-prototype/src/lib/refresh-context.tsx), [`Settings.tsx` save success branch](../04-prototype/src/pages/Settings.tsx) | [story-pool spec § Settings save to dashboard refresh](docs/dashboard-story-pool-spec.md#settings-save-to-dashboard-refresh) |
| Beat-fit precision gate — MVP recall-first default `0.20`, env-tunable | [`readBeatFitThreshold()` in `beat-fit-scorer.mjs`](apps/api/src/dashboard/beat-fit-scorer.mjs), [`applyBeatFitFilter` in `refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) | [D-063](DECISIONS.md), [semantic beat-fit runbook](docs/runbook-semantic-beat-fit.md) |
| What-changed delta engine — 3-state `story.whatChanged` (first-seen / unchanged / changed) via deterministic gate + optional Haiku + Sonnet. **Default ON for prototype dev** via `bootstrapApiEnv()` in [`server.mjs`](apps/api/src/server.mjs); tests (`NODE_ENV=test`) and `TEMPO_AI_MOCK_ONLY=true` still skip the LLM-bound stages. Set `TEMPO_AI_DELTA_ENABLED=false` to disable explicitly. | [`what-changed-engine.mjs`](apps/api/src/dashboard/what-changed-engine.mjs), pipeline call site in [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) | [what-changed spec](docs/what-changed-spec.md), [handoff](docs/what-changed-handoff.md), [D-065](DECISIONS.md) |
| Server-side refresh cadence — `REFRESH_INTERVAL_MS` (1h) drives both the client heartbeat and the scheduled cadence-tick orchestrator; both branches converge on `_lastCheckedAt` and the shared `_refreshExecutor.execute` path. | [`refresh-cadence.mjs`](apps/api/src/contracts-runtime/refresh-cadence.mjs), [`due-user-orchestrator.mjs`](apps/api/src/dashboard/due-user-orchestrator.mjs), [`cadence-tick.mjs`](apps/api/src/ops/cadence-tick.mjs) | [Server-side cadence tick](#server-side-cadence-tick-sub-slice-25) |

Detailed rationale: [dashboard-story-pool-walkthrough.md](docs/dashboard-story-pool-walkthrough.md). Operator scenarios: [dashboard-story-pool-scenario-map.md](docs/dashboard-story-pool-scenario-map.md).

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

**Environments (as of 2026-05-21):** Tempo uses a **single** Supabase project (`Tempo`, ref `kdkzvcwlhgivvjwziqpr`). Local `apps/api/.env`, Vercel **Production – tempo-api**, and **Preview – tempo-api** all point at that database via `DATABASE_URL` / `SUPABASE_URL`. There is no separate staging Postgres — run `db:migrate:dry` against each `DATABASE_URL` you use; if it reports pending files, apply before deploy.

**Migration 018 (`publisher_display_name`):** Adds `source_entities.publisher_display_name` for dashboard outlet labels. Schema change is idempotent (`ADD COLUMN IF NOT EXISTS`). After apply, optional one-time catalog backfill for section-style `canonical_name` rows (em dash separator):

```sql
UPDATE source_entities
SET publisher_display_name = trim(split_part(canonical_name, ' — ', 1))
WHERE kind = 'traditional'
  AND canonical_name LIKE '% — %'
  AND (publisher_display_name IS NULL OR publisher_display_name = '');
```

Re-run `source-feeds-import.mjs` when `source-feeds.json` carries explicit `publisher` fields. B2 derivation in code covers rows still null at read time.

## Source scope (Batch 1: Washington Post + Reuters)

The Supabase manifest's `active` flag is the **primary** lever that decides which feeds run during ingestion. The runtime guard `TEMPO_RSS_ALLOWLIST` is defense-in-depth — it filters again at fetch time. `TEMPO_INGESTION_ALLOWLIST` is accepted as a legacy alias for backwards compatibility; new configuration should use `TEMPO_RSS_ALLOWLIST`.

**Batch 1 env setup** (set on the API project, e.g. `apps/api/.env` locally or Vercel env for `tempo-api`):

```
TEMPO_RSS_INGESTION=live
TEMPO_RSS_ALLOWLIST=washington post,reuters
TEMPO_RSS_MAX_ITEMS_TOTAL=150
TEMPO_RSS_MAX_ITEMS_PER_FEED=20
```

NYT remains inactive in the Supabase manifest pending licensing — do not flip it to active without sign-off.

**Sync the manifest from `source-feeds.json` → Supabase** (canonical import utility, idempotent, never downgrades `verified` → `mapped`):

```sh
SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
  node apps/api/src/db/source-feeds-import.mjs
```

Use the service-role key (not the anon key) — the upserts touch `source_entities` and `source_feed_mapping` directly. After import, regenerate the catalog with `npm run source-catalog:generate` to refresh `SOURCE-REGISTRY-CATALOG.generated.md`. The catalog shows **active mappings only** (inactive rows are filtered at query time) — Reuters Batch 1 rows appear there only after `source-feeds-import.mjs` runs and the rows land as `active=true` in Supabase.

**`source-feeds.json` is the single source of truth for the canonical feed list.** The import script ends with a deactivation sweep: any `source_feed_mapping` row whose `manifest_feed_id` is **not** in the JSON file is flipped to `active=false` (logged by ID, e.g. `reuters-world`). Legacy/placeholder IDs (`reuters-world`, NYT, etc.) must remain **inactive** — only the 6 canonical Batch 1 feeds (4 WaPo + Reuters Americas + Reuters US) are `active=true`. To retire a feed, remove it from the JSON and re-run the import; the sweep deactivates it automatically. The sweep never reactivates rows and never touches rows already inactive. The script **exits non-zero** if the sweep errors or if any feed was skipped due to an upsert failure, so a partial sync fails loudly in CI.

### Sub-slice 1.2 validation — WaPo-only baseline smoke

Not required for Sub-slice 1.1 completion. Run before enabling Reuters in user settings (Sub-slice 1.3) to confirm the WaPo path is a known-good baseline. From `05-engineering/`:

```sh
TEMPO_RSS_INGESTION=live TEMPO_RSS_ALLOWLIST='washington post,reuters' \
TEMPO_RSS_MAX_ITEMS_TOTAL=150 TEMPO_RSS_MAX_ITEMS_PER_FEED=20 \
node --input-type=module -e "
  import('./apps/api/src/ingestion/feed-reader.mjs').then(async ({ readFeedItems }) => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile('apps/api/data/source-feeds.json', 'utf8')).feeds;
    const wapoOnly = manifest.filter(f => f.publisher === 'The Washington Post');
    const items = await readFeedItems(process.cwd(), { manifestLoader: () => wapoOnly });
    console.log('items:', items.length, 'outlets:', [...new Set(items.map(i => i.outlet))]);
  });
"
```

Healthy output prints `[feed-reader.live] feeds=4 skipped=0 failed=0 parsed=N returned=N` and a single outlet (`The Washington Post`).

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

## Dashboard trust controls (Slice 1)

Three knobs and one locked policy govern how the refresh pipeline fails safe so users never see fabricated or low-signal stories.

**Fail-closed clustering (locked policy).** Clustering runs once; on throw/timeout it retries **once**; if the retry also fails the pipeline publishes **zero meta-stories** (empty dashboard). It never ships `gracefulFallbackClustering` "General Updates"-style buckets to users — an empty dashboard is the honest signal that clustering failed. Diagnostics are persisted under `_meta`: `usedFallbackClustering` (**true means clustering failed and zero stories were published**, not “degraded fallback buckets shipped”), `clusteringFailureReason` (`timeout` \| `error` \| `null`), `clusteringAttempts`, `clusteringLatencyMs` (per-attempt). See [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) and scenario-map row **I-fallback**.

| Env var | Default | Scope | Purpose |
|---------|---------|-------|---------|
| `TEMPO_AI_CLUSTER_TIMEOUT_MS` | `25000` | clustering only | Per-attempt timeout for the cluster round-trip. Deliberately larger than the global `TEMPO_AI_TIMEOUT_MS` because clustering is the single largest AI call; **does not** raise the timeout for other AI stages. The cluster model stays **Sonnet** (`TEMPO_AI_CLUSTER_MODEL`). |
| `TEMPO_EMBED_MIN_SIMILARITY` | `0.40` | embedding recall | Minimum cosine for a **semantic-only** top-K item to enter the `hybrid_strict` union. Keyword/topic hits always pass regardless of score; only embedding-proximity additions are gated, so a weak/off-beat neighbor can't widen recall into noise. Range `[0,1]`; `0` disables the floor. Diagnostics: `recall.minSimilarityThreshold`, `recall.similarityRejected`. |

**Liveblog / near-duplicate collapse.** The cross-feed deduper ([`source-deduper.mjs`](apps/api/src/ingestion/source-deduper.mjs)) also folds rolling-coverage items — headlines matching `Live updates:` / `Live update:` / `Live blog:` are keyed by the normalized subject after the marker and merged within `PUBLISH_WINDOW_MINUTES`, keeping the newest snapshot and attaching the rest as internal `_duplicates`. WaPo “Quick Post” live items that omit the `Live updates:` prefix are not collapsed yet; extend `LIVEBLOG_PREFIX_RE` when those patterns are confirmed in feed data.

## Server-side cadence tick (Sub-slice 2.5)

Background: Sub-slice 2.4 added the [due-user orchestrator](apps/api/src/dashboard/due-user-orchestrator.mjs) — pure due-selection (`selectDueUsers`), anchor extraction from `dashboard_snapshots` (`listSnapshotAnchors`), and `runDueRefreshes` which iterates due users through the shared `_refreshExecutor.execute` path. 2.4 left the orchestrator without a caller: the interactive `POST /api/dashboard/refresh` only fires when a browser is open.

**2.5 fills the gap with a scheduled, internal-only tick:**

- **What runs on schedule:** [`.github/workflows/cadence-tick.yml`](../.github/workflows/cadence-tick.yml) runs hourly at `:05` (`cron: "5 * * * *"`) and on manual `workflow_dispatch`. Cadence matches `REFRESH_INTERVAL_MS = 1h` from [`refresh-cadence.mjs`](apps/api/src/contracts-runtime/refresh-cadence.mjs) — the smallest cadence that produces ≥1 tick per refresh window per user without thrashing.
- **What it calls:** [`apps/api/src/ops/cadence-tick.mjs`](apps/api/src/ops/cadence-tick.mjs) invokes `_dueUserOrchestrator.runDueRefreshes()` verbatim — no due-selection or executor logic is reimplemented in 2.5. The same in-flight guard, watermark short-circuit, snapshot persistence, and `_lastCheckedAt` anchor write the interactive path uses also apply here.
- **Expected logs:** One single-line JSON summary per tick, tagged `[cadence-tick]`. Fields: `ok`, `candidates`, `due`, `ran`, `errors`, `kinds` (e.g. `{ran: 1, unchanged: 2}`), `skippedReason`, `intervalMs`, `startedAt`. Inspect by grepping the workflow run output for `[cadence-tick]`.
- **Failure semantics:**
  - Exit `0` when `skippedReason === "none"`. **Per-user errors are counted in `summary.errors` and do NOT fail the job** — one bad user cannot squelch the next scheduled tick.
  - Exit `1` only for true orchestrator-level failures: missing `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, anchor list throw (`skippedReason: "list_threw"`), anchor list error (`skippedReason: "list_error"`), or `runDueRefreshes` itself rejecting (`skippedReason: "orchestrator_threw"` in the log).
- **Where to inspect:** GitHub → Actions → "Due-user refresh cadence tick" → most recent run → `Run cadence tick` step. The `[cadence-tick]` line is the structured signal; the preceding `Run started at …` echo confirms the workflow reached the step.
- **Secrets:** Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` under repo Settings → Secrets and variables → Actions before enabling the schedule. The tick exits `1` with `skippedReason: "missing_supabase_env"` if either is absent, so the failure surface is loud.

**Local invocation** (for debugging — requires `apps/api/.env` with Supabase creds):

```sh
node apps/api/src/ops/cadence-tick.mjs
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

**API tuning (optional):** Beat-fit threshold defaults to **`0.20`** for MVP recall ([D-063](DECISIONS.md)). To restore the legacy precision-first gate without redeploying code, set on the API project:

```sh
TEMPO_BEAT_FIT_THRESHOLD=0.40
# What-changed delta engine — defaulted ON for prototype dev by bootstrapApiEnv;
# set to "false" to disable in environments where the LLM-bound stages should
# stay off.  TEMPO_AI_MOCK_ONLY=true also skips the LLM stages.
TEMPO_AI_DELTA_ENABLED=true
```

See [runbook-semantic-beat-fit.md](docs/runbook-semantic-beat-fit.md) for semantic beat-fit flags and rollback.

The API (`apps/api`) is a **separate Vercel project** (`tempo-gray-psi`). It is not deployed by this workspace's scripts. Recommended options:

- **Vercel dashboard GitHub integration** — connect `apps/api` as the root directory of the `tempo-gray-psi` project; Vercel deploys automatically on push to `main`.
- **Manual deploy** — `cd apps/api && npx vercel --prod`

The frontend proxies all `/api/*` requests to the API project via `04-prototype/vercel.json`; both projects must be current for the app to function correctly.
