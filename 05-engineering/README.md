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
| Ingestion cache warmer — scheduled full-manifest fetch (no `feedIds`) that keeps `ingestion_recent_items` warm so refreshes hit the cache instead of a live RSS fetch; runs hourly at `:35` via GHA. | [`ingestion-warm.mjs`](apps/api/src/ops/ingestion-warm.mjs), [`.github/workflows/ingestion-warm.yml`](../.github/workflows/ingestion-warm.yml) | [Ingestion cache warmer](#ingestion-cache-warmer-phase-1-slice-34) |
| Translation-first normalization (Phase 3) — non-English source evidence (`item.lang`) is translated ES→EN **post-geo, pre-recall** so English settings match Spanish items; dual-text retains original `headline`/`body` + adds `normalizedHeadline`/`normalizedBody`; bounded + fail-open; coverage/degraded in `_meta.translation`. Code default OFF; **enabled in preview + production now (Sprint B1, controlled rollout)** via `TEMPO_TRANSLATION_ENABLED=true`; rollback is the same flag set to `false`. | [`evidence-translator.mjs`](apps/api/src/ingestion/evidence-translator.mjs), wired in [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) | [D-067](DECISIONS.md), [`.env.example`](apps/api/.env.example), [runbook](docs/runbook-translation-activation.md) |
| English meta-story from non-English sources (Phase 3) — clustering (`cluster-v3`) and the whatChanged writer emit English `title`/`subtitle`/`summary`/`whatChanged` even when sources are Spanish, grounding on normalized EN evidence; the whatChanged **structural gate stays on the raw headline** (language-stable deltas). | [`prompts.mjs`](apps/api/src/ai/prompts.mjs) (`CLUSTERING_PROMPT_VERSION`), [`what-changed-engine.mjs`](apps/api/src/dashboard/what-changed-engine.mjs), `withNormalizedEvidence` in [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) | [D-068](DECISIONS.md) |
| Spanish readiness status (Phase 3) — extraction, translation-first normalization, and English-output guardrails are **code-complete**; the 6 Spanish feeds (La Silla Vacía, Semana, Infobae) are now **activated in the manifest across Phase 4 Slices 16–18 (complete)** — all enumerated in `source-feeds.json` as `active=true`, `lang=es`; production translation is wired and **enabled in preview + production (Sprint B1)** via `TEMPO_TRANSLATION_ENABLED=true` under controlled monitoring (rollback: set it to `false`). | [`evidence-translator.mjs`](apps/api/src/ingestion/evidence-translator.mjs) | [D-067](DECISIONS.md), [D-068](DECISIONS.md), [runbook](docs/runbook-translation-activation.md) |

Detailed rationale: [dashboard-story-pool-walkthrough.md](docs/dashboard-story-pool-walkthrough.md). Operator scenarios: [dashboard-story-pool-scenario-map.md](docs/dashboard-story-pool-scenario-map.md).
Cold-start orchestration spec: [cold-start-v1.md](docs/cold-start-v1.md).
Meta-story pipeline (split-healer · max-5 overflow cap · deferred re-cluster) operator close-out — pre-flight reset, `?debug=1` checks, rollback levers: [runbook-meta-story-pipeline.md](docs/runbook-meta-story-pipeline.md).

Cold-start clustering envelope (PR B Step 2): the `cold_start` profile keeps the locked 45s per-attempt clustering timeout and 2 attempts, but bounds the **sum** of those attempts with a wall-clock budget (`COLD_START_CLUSTER_TOTAL_BUDGET_MS_DEFAULT = 60000`) in [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs). The first attempt gets the full 45s; a retry inherits only the budget the first attempt left behind (floored at `CLUSTER_CALL_MIN_TIMEOUT_MS`). This caps the worst-case clustering span at ~60s (instead of two back-to-back 45s timeouts ≈ 90s) so cold-start `pipelineMs` trends under the 90s `PIPELINE_SLOW_MS` budget; trust is unchanged (still 2 attempts, fail-closed, PR B Step 1 recovery untouched). The cap is surfaced on `_meta.profile.clusterTotalBudgetMs` and the `[pipeline.profile]` log line.

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

The Supabase manifest's `active` flag is the **primary** lever that decides which feeds run during ingestion. **By default the runtime allowlist is derived from the manifest itself**: every structurally eligible feed (active RSS row with a valid URL) contributes its publisher to the allowlist, so an active feed ingests without any matching env edit. `TEMPO_RSS_ALLOWLIST` is an **optional narrowing override** — set it only when you want to restrict ingestion to a subset of the otherwise-eligible publishers (e.g. incident response, staging). `TEMPO_INGESTION_ALLOWLIST` is accepted as a legacy alias for backwards compatibility; new configuration should use `TEMPO_RSS_ALLOWLIST`.

Resolution precedence (first match wins): explicit `opts.allowlist` (code) → `TEMPO_RSS_ALLOWLIST` → `TEMPO_INGESTION_ALLOWLIST` (legacy) → **manifest-derived default** → permissive (no filter). There is no hardcoded publisher default — removing the allowlist env entirely falls through to the manifest-derived set, not to a WaPo-only list.

**Batch 1 env setup** (set on the API project, e.g. `apps/api/.env` locally or Vercel env for `tempo-api`):

```
TEMPO_RSS_INGESTION=live
# Optional narrowing override — omit it to ingest every active manifest feed.
# Kept here as the explicit Batch 1 scope; with the manifest-derived default
# this line is no longer required for WaPo + Reuters to ingest.
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

**`source-feeds.json` is the single source of truth for the canonical feed list.** The import script ends with a deactivation sweep: any `source_feed_mapping` row whose `manifest_feed_id` is **not** in the JSON file is flipped to `active=false` (logged by ID, e.g. `reuters-world`). Legacy/placeholder IDs (`reuters-world`, NYT, etc.) must remain **inactive** — only the canonical feeds enumerated in `source-feeds.json` are `active=true` (Batch 1: 4 WaPo + Reuters Americas + Reuters US; Phase 2: the AP and Bloomberg sets). To retire a feed, remove it from the JSON and re-run the import; the sweep deactivates it automatically. The sweep never reactivates rows and never touches rows already inactive. The script **exits non-zero** if the sweep errors or if any feed was skipped due to an upsert failure, so a partial sync fails loudly in CI.

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

To open up beyond Phase 1, **unset** the narrowing override so ingestion falls through to the manifest-derived default (every active feed ingests):

```sh
# In your API environment (.env or process env): remove / comment out the line.
# unset TEMPO_RSS_ALLOWLIST
```

> `TEMPO_RSS_ALLOWLIST=*` does **not** act as a wildcard — entries are matched as substrings of feed names, and no feed name contains a literal `*`, so that value would block every feed. To admit everything, unset the variable (manifest-derived default) rather than setting a wildcard.

## Dashboard trust controls (Slice 1)

Three knobs and one locked policy govern how the refresh pipeline fails safe so users never see fabricated or low-signal stories.

**Fail-closed clustering (locked policy).** LLM clustering runs once; on throw/timeout it retries **once** (plus the Option B recovery attempt below). When the LLM path fails terminally the pipeline does **not** immediately go dark — it first attempts the strict relevance-gated **deterministic rescue** described in **Production refresh outcomes** below. Only when that rescue finds **zero eligible items** does the pipeline publish **zero meta-stories** (empty dashboard) — a **true fail-closed**. It never ships `gracefulFallbackClustering` "General Updates"-style buckets to users — an empty dashboard is the honest signal that clustering failed with nothing eligible to rescue. Diagnostics are persisted under `_meta`: `usedFallbackClustering` (**true means clustering failed AND the deterministic rescue published zero stories**, i.e. a true fail-closed; it flips back to `false` when the rescue publishes), `clusteringFailureReason` (`timeout` \| `error` \| `null`), `clusteringFailureSubtype` (finer attribution of the reason — `parse` \| `provider_request` \| `timeout_budget` \| `unknown` \| `null`; see **Failure subtype taxonomy** below), `clusteringAttempts`, `clusteringLatencyMs` (per-attempt). See [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) and scenario-map row **I-fallback**.

**Auto-recovery tier (Option B, PR B + A2).** Before falling closed, **any** terminal primary failure — **both error-class** (`clusteringFailureReason = error`, i.e. parse/schema-style) **and timeout-class** (`clusteringFailureReason = timeout`) — triggers **one** bounded recovery attempt on a **reduced** candidate set (50% of the cluster-input cap, floor 6 items), **only when that genuinely shrinks the input** (when the set is already at/below the floor there is nothing to reduce, so recovery is skipped). A2 extends the original error-only tier to timeout-class because a smaller candidate set is a lighter, faster round-trip that can beat the budget the full set blew. If recovery parses cleanly its stories publish normally (and `usedFallbackClustering` flips back to `false`, `clusteringFailureReason` to `null`); if it fails, the **fail-closed outcome above is preserved unchanged** (zero stories) and the deterministic rescue is attempted next. It never emits `gracefulFallbackClustering` buckets — trust posture is unchanged. Additive `_meta` diagnostics: `clusteringRecoveryAttempted`, `clusteringRecoverySucceeded`, `clusteringRecoveryReason` (`error` \| `timeout` \| `null`), `clusteringRecoverySubtype` (same taxonomy as the failure subtype, for the recovery attempt's own failure); the recovery attempt is also counted in `clusteringAttempts` / `clusteringLatencyMs`.

**Production refresh outcomes (deterministic rescue) — operator interpretation.** A refresh no longer maps "LLM clustering failed" one-for-one to "empty dashboard." There are **three** outcomes, surfaced on `_meta.refreshStatus` (`ok | degraded | failed`). Full spec: [cold-start v1: Refresh outcomes](docs/cold-start-v1.md#refresh-outcomes-post-phase-a--b).

| `_meta` field | Values | Operator reading |
|---|---|---|
| `refreshStatus` | `ok` \| `degraded` \| `failed` | **The verdict — read this first.** `ok` = LLM clustering (or Option B recovery) published. `degraded` = LLM clustering failed but the strict deterministic rescue **shipped** ≥1 bounded story (a real publish, **not** an outage). `failed` = **0 stories shipped** (true fail-closed) — either nothing cleared the deterministic gate, **or** a rescue built stories that were all dropped before publish (so `usedDeterministicClustering=true` can appear on a `failed` run); a prior healthy snapshot is preserved when one exists, see `usedPriorSnapshot`. |
| `clusteringLlmFailed` | `true` \| `false`/absent | `true` whenever the **LLM** clustering path failed terminally and the deterministic builder ran. Present on **both** `degraded` and `failed`, so on its own it does **not** tell you whether anything shipped — read `refreshStatus` (the verdict) to tell a shipped rescue (`degraded`) from a hard failure (`failed`). |
| `usedDeterministicClustering` | `true` \| `false`/absent | `true` when the deterministic fallback **builder** produced ≥1 raw story and the pipeline adopted them (builder-stage involvement) — **not** a guarantee that any shipped. It is **attribution, not the verdict**: those raw stories can still be dropped by later grounding/publish shaping, so a run can be `refreshStatus=failed` **with** `usedDeterministicClustering=true` (a fully-dropped rescue → 0 shipped). Read `refreshStatus` for the verdict (`degraded` = ≥1 shipped, `failed` = 0 shipped); use this flag only to attribute *which path ran*. `false`/absent when the builder never ran (clean LLM success or recovery). |
| `deterministicClusteringDiagnostics` | `{ inputCount, eligibleCount, outputCount, excludedReasons }` \| absent | Counts-only (no story bodies) from the deterministic **builder**. `outputCount` is what the builder produced, **not** what shipped: on a `failed` run a low `outputCount` means nothing cleared the strict topic+keyword bar, while a **non-zero** `outputCount` on a `failed` run means the builder produced stories that were then dropped before publish (0 shipped). `excludedReasons` is a bucketed histogram of why items were dropped at the gate. |
| `upgradeRefreshScheduled` | `true` \| absent | `true` when a `degraded` rescue scheduled a **background default-profile LLM upgrade** (B5) to replace the deterministic snapshot shortly. Fire-and-forget; never blocks or fails the foreground response. Absent on `ok`, `failed`, and preserved-prior continuity runs. |
| `upgradeRefreshReason` | `degraded_deterministic_rescue` \| absent | The reason tag paired with `upgradeRefreshScheduled`. A second degraded run while an upgrade is already in-flight is **joined (de-duped)**, not stacked — it logs `[dashboard.upgrade] … already in-flight — skipping duplicate` and leaves these fields absent on that response. |

> **`clusteringFailureReason` / `clusteringFailureSubtype` on a `degraded` run is attribution, not a verdict.** They are **retained** on a `degraded` run to record *why the LLM path failed* even though the deterministic rescue then shipped stories. A non-null `clusteringFailureReason` alone is **not** a hard failure — read `refreshStatus` (the verdict) before treating a run as down. It is a hard fail-closed exactly when `refreshStatus: "failed"`. Don't infer the verdict from any single diagnostic flag: `usedFallbackClustering` and `usedDeterministicClustering` are attribution and can disagree with the headline on edge cases (a fully-dropped rescue ends `failed` with `usedDeterministicClustering=true` and `usedFallbackClustering=false`).

**Log-side observability.** Each real-provider clustering round-trip also emits one stable, greppable line — prefix `[cluster-engine.obs]` — recording which execution path it took: `mode=structured|legacy`, `result=ok|fallback|fail`, plus `model`, `maxTokens`, `stopReason`, `errorClass`, and `fallbackTo=legacy` (only on a structured→legacy recovery). The three outcomes are: structured success (`result=ok`), structured parse failed then the safe-trim/legacy repair recovered (`result=fallback`), and both paths failed (`result=fail`, on stderr). This is diagnostics-only — it never alters clustering behavior, the returned stories, or the fail-closed policy above. See [`cluster-engine.mjs`](apps/api/src/ai/cluster-engine.mjs).

**Failure subtype taxonomy (diagnostics only).** When clustering fails closed, the coarse `clusteringFailureReason` is additionally classified into a stable, snake_case **subtype** for triage:

| subtype | meaning | typical fix family |
| --- | --- | --- |
| `parse` | model output couldn't be parsed/validated into the clustering contract (JSON/schema/empty payload) | parse-resilience hardening |
| `provider_request` | the provider call itself failed or returned an unusable envelope (missing API key, auth, rate-limit, overload, transport fault, empty provider response) | guarded provider/transport mitigation |
| `timeout_budget` | the clustering wall-clock budget was exhausted (timed out / aborted) | budget-envelope adjustment |
| `unknown` | a non-timeout failure we couldn't attribute to a class above — a non-empty `unknown` rate is itself a signal the taxonomy needs another bucket | improve attribution first |

The legacy reason is **derived from** the subtype (`timeout_budget`→`timeout`, everything else→`error`), so the existing `clusteringFailureReason` contract is byte-identical and the subtype is purely additive. Classifier: `classifyClusteringFailureSubtype()` in [`cluster-engine.mjs`](apps/api/src/ai/cluster-engine.mjs) (pure, deterministic). The **same** subtype is surfaced consistently on **(1)** the immediate refresh response `_meta.clusteringFailureSubtype`, **(2)** the run-outcome rollup `_meta.outcomes.clusteringFailureSubtype`, **(3)** the persisted snapshot read path — `GET /api/dashboard` lifts it from `_lastRunMeta` into `_meta` ([`dashboard-snapshot-repo.mjs`](apps/api/src/db/dashboard-snapshot-repo.mjs)), and **(4)** the probe summary's `clusteringFailureSubtypes` histogram (read via `extractClusteringFailureSubtype()` — top-level `_meta` first, falling back to the outcomes rollup for older snapshots). It is **visibility/diagnostics only — it never changes gate thresholds, fail-closed behavior, or the published stories.**

| Env var | Default | Scope | Purpose |
|---------|---------|-------|---------|
| `TEMPO_AI_CLUSTER_TIMEOUT_MS` | `60000` | clustering only | Per-attempt timeout for the cluster round-trip. Deliberately larger than the global `TEMPO_AI_TIMEOUT_MS` because clustering is the single largest AI call; **does not** raise the timeout for other AI stages. The cluster model stays **Sonnet** (`TEMPO_AI_CLUSTER_MODEL`). |
| `TEMPO_EMBED_MIN_SIMILARITY` | `0.35` | embedding recall | Minimum cosine for a **semantic-only** top-K item to enter the `hybrid_strict` union. Keyword/topic hits always pass regardless of score; only embedding-proximity additions are gated, so a weak/off-beat neighbor can't widen recall into noise. Range `[0,1]`; `0` disables the floor. Diagnostics: `recall.minSimilarityThreshold`, `recall.similarityRejected`. |

**Liveblog / near-duplicate collapse.** The cross-feed deduper ([`source-deduper.mjs`](apps/api/src/ingestion/source-deduper.mjs)) also folds rolling-coverage items — headlines matching `Live updates:` / `Live update:` / `Live blog:` are keyed by the normalized subject after the marker and merged within `PUBLISH_WINDOW_MINUTES`, keeping the newest snapshot and attaching the rest as internal `_duplicates`. WaPo “Quick Post” live items that omit the `Live updates:` prefix are not collapsed yet; extend `LIVEBLOG_PREFIX_RE` when those patterns are confirmed in feed data.

**Slice 2 — prototype empty-state honesty + golden eval.** The prototype API layer ([`api.ts`](../04-prototype/src/lib/api.ts)) lifts the clustering diagnostics off `_meta` (`clusteringFailed`, `clusteringFailureReason`, `clusteringAttempts`, `clusteringLatencyMs`), and the dashboard ([`Dashboard.tsx`](../04-prototype/src/pages/Dashboard.tsx) + [`StateBlocks.tsx`](../04-prototype/src/components/StateBlocks.tsx)) renders a **dedicated "Couldn't compose stories this refresh" empty state** when `clusteringFailed` is true — distinct from the quiet-beat "No stories yet" copy — so a fail-closed run reads as "retry", not "nothing matched". The [dashboard refresh golden eval](apps/api/src/ai/evals/README.md#dashboard-refresh-golden-slice-2) (`npm run eval:dashboard-refresh-golden`) is the hermetic regression guard for fail-closed clustering, no degraded titles, liveblog dedupe, and the recall floor.

**Slice 3 — run diagnostics for manual E2E.** A debug-only diagnostics panel ([`DashboardRunDiagnostics.tsx`](../04-prototype/src/components/DashboardRunDiagnostics.tsx)) surfaces the latest fetch's clustering / funnel / recall / selection blocks lifted from `_meta` so a manual re-test can see *why* the dashboard is empty or thin without reading server logs. It is hidden in normal use and shows only when `VITE_UX_TEST_MODE=true` **or** the URL carries `?debug=1`.

**Slice 4 — env hygiene + embed-floor calibration.** [`apps/api/.env.example`](apps/api/.env.example) now documents the full recall/precision knob set (`TEMPO_RECALL_MODE`, `TEMPO_EMBED_MIN_SIMILARITY`, `TEMPO_EMBED_TOP_K`/`MAX_ITEMS`, `TEMPO_BEAT_FIT_THRESHOLD`) with explicit "embed floor ≠ beat-fit" warnings. Local calibration workflow for a thin dashboard: restart the API with `TEMPO_EMBED_MIN_SIMILARITY` swept across **0.35–0.45** (production default is **0.35**; `0` disables the floor), open the dashboard with `?debug=1`, and watch `diag-recall` → `similarityRejected` / `floor=` to see how many semantic-only adds the floor held back. The embed floor (cosine, recall stage) and beat-fit threshold (blended precision, default 0.20 — D-063) are different stages on different scales; see [DECISIONS.md → D-063 addendum](DECISIONS.md).

**Slice 5 — embed-floor calibration harness.** `npm run eval:dashboard-calibration` sweeps `TEMPO_EMBED_MIN_SIMILARITY` across **0 / 0.35 / 0.40 / 0.45** and prints an objective table (`similarityRejected`, `finalStories`, `finalRelevant`, Reuters count, liveblog collapse) per floor, so a default change is evidence-driven rather than guessed. It enforces the same hard guardrails as the golden eval (no fail-closed clustering, no degraded titles, Reuters present, liveblog collapses) at every floor; the floor metrics themselves are advisory. **Production default is 0.35; change it only when a committed run shows systematic loss at 0.35.** See [evals README → Embed-floor Calibration](apps/api/src/ai/evals/README.md#embed-floor-calibration-slice-5).

**Slice 6 — CI dashboard quality gate + JSON artifacts.** `npm run eval:dashboard-quality-gate` is the single CI-grade entry point: it runs the golden eval **and** the calibration sweep in one hermetic command, exits non-zero if either regresses, and writes a machine-readable calibration JSON artifact (default `.artifacts/dashboard-calibration.json`; `npm run eval:dashboard-calibration:json` writes `tmp/dashboard-calibration.json`). The JSON (`harness`/`version`-stamped, per-floor metrics + guardrail pass/reasons + `overall`) lets CI and reviewers diff runs over time. **Floor-change ship/no-ship policy:** changing `DEFAULT_EMBED_MIN_SIMILARITY` off **0.35** requires (1) the quality gate green at the candidate floor, (2) a manual `?debug=1` quality review confirming rejected items are genuinely off-beat, and (3) committed evidence (the calibration artifact for 0.35 vs the candidate) in the PR notes. See [evals README → Dashboard Quality Gate](apps/api/src/ai/evals/README.md#dashboard-quality-gate-slice-6).

### Recall tuning band + validation (Sprint B3)

Guidance for **safely tuning recall** on multi-geo beats (e.g. the Colombia–US embassy beat) **without changing runtime defaults**. The default `TEMPO_EMBED_MIN_SIMILARITY=0.35` stays as-is; this is a measure-first workflow, not a default flip.

**Three separate stages — do not conflate them.** Recall is a pipeline, not one knob. An item reaches clustering only after clearing all three, in order:

1. **Lexical pass** — `applyTopicKeywordFilter` (+ the geo *lexical* gate). Whole-word topic/keyword hits, plus a configured-geography lexical mention, admit an item. This pass is **not** controlled by `TEMPO_EMBED_MIN_SIMILARITY`. Diagnostics: `recall.topicKeywordBreakdown` (`topicOnly` / `keywordOnly` / `both` / `geoLexicalOnly` / `neither` / `pass`) and the `[pipeline.topic-keyword]` log line.
2. **Semantic widening** — `hybrid_strict` embedding union. *Adds* semantic-only neighbors that the lexical pass missed, gated by the **cosine similarity floor** `TEMPO_EMBED_MIN_SIMILARITY`. Lexical hits always pass regardless of score; the floor gates **only** the embedding-driven additions. Diagnostics: `recall.minSimilarityThreshold`, `recall.similarityRejected`, `recall.finalRelevant`.
3. **Beat-fit threshold** — `TEMPO_BEAT_FIT_THRESHOLD` (default `0.20`, [D-063](DECISIONS.md)). A blended **precision** score applied *after* recall, on a **different scale**. Diagnostics: the `[pipeline.beat-fit]` log line.

> ⚠️ **The similarity floor is not the beat-fit threshold.** `TEMPO_EMBED_MIN_SIMILARITY` (cosine `[0,1]`, recall *widening* stage) and `TEMPO_BEAT_FIT_THRESHOLD` (blended precision, recall *narrowing* stage) are different stages on different scales. Never copy a value from one to the other — e.g. setting the cosine floor to `0.20` because that is the beat-fit default would silently collapse the floor. See [DECISIONS.md → D-063 addendum](DECISIONS.md).

**Recommended exploratory band:** `TEMPO_EMBED_MIN_SIMILARITY` **0.35 → 0.40**. `0.35` is the production default (recall-widening, low end of the band). `0.40` is the conservative upper end for an exploratory tightening run. Going above `0.45` over-trims semantic adds; `0` disables the floor (debug baseline only). Multi-geo embassy beats lean on semantic widening to bridge Spanish↔English phrasing that the lexical pass misses, so they are **more sensitive to floor changes than single-geo beats** — measure before tightening.

**Validation checklist (compare candidates without committing a default):**

```bash
cd 05-engineering/apps/api
# 1. Hermetic floor sweep — guardrails + per-floor metrics across 0 / 0.35 / 0.40 / 0.45
npm run eval:dashboard-calibration            # add :verbose for per-row detail
# 2. CI-grade gate (golden + sweep in one) — must stay green at the candidate floor
npm run eval:dashboard-quality-gate
# 3. Multi-beat recall-widening guard (proves a tighter floor didn't starve a beat)
npm run eval:dashboard-dual-beat
# 4. Optional manual run: restart the API with a candidate floor, open ?debug=1
#    TEMPO_EMBED_MIN_SIMILARITY=0.40 npm run dev   # then read the diag-recall panel
```

Inspect these diagnostics (in `_meta` / the run-diagnostics `?debug=1` panel / server logs) at each candidate floor:

| Diagnostic | Where | Read it for |
|---|---|---|
| `recall.finalRelevant` | `_meta.recall` / `[pipeline.recall]` | total items that survived recall — the headline recall volume |
| `recall.similarityRejected` | `_meta.recall` / calibration table | semantic-only adds the floor held back this run |
| `recall.topicKeywordBreakdown` | `_meta.recall` / `[pipeline.topic-keyword]` | whether loss is lexical (`neither`/`geoLexicalOnly`) vs semantic |
| `geoLane2DeferredCount` | `_meta.geoLane2DeferredCount` / `[pipeline.geo] lane2_deferred=` | geo-stage budget shedding — deferred items never reached recall (rule out before blaming the floor) |
| `usedFallbackClustering` | `_meta.usedFallbackClustering` | must be `false`; `true` means clustering fail-closed (0 stories) — unrelated to the floor, but invalidates the comparison |
| `pipelineMs` | `_meta.timings.pipelineMs` / `[pipeline.timings]` | refresh latency stayed within SLO at the candidate floor |

**What "good" looks like:** guardrails **PASS** at the candidate floor (no fail-closed clustering, no degraded titles, Reuters/must-see sources still present, liveblog still collapses); `similarityRejected` rises gently as the floor rises; rejected items are genuinely off-beat on `?debug=1` review; `finalRelevant` and story count stay healthy; `geoLane2DeferredCount` ≈ 0 and `usedFallbackClustering=false` (so the comparison is apples-to-apples).

**Too strict** (floor too high): `similarityRejected` climbs sharply, `finalRelevant`/story count drops, must-see or cross-language sources disappear, and `?debug=1` shows on-beat items being rejected. **Too loose** (floor too low / `0`): `similarityRejected` ≈ 0 but off-beat neighbors leak into clustering — thin/incoherent stories, noise the lexical pass would never have admitted.

**Suggested next-step experiment (no default change):** Run the calibration sweep against a captured embassy-beat fixture (mixed `lang=es`/`en`, implicit geo) and read `0.35` vs `0.40`. If `0.40` holds all guardrails AND its extra `similarityRejected` items are off-beat on `?debug=1` review, that is *evidence toward* a future tightening — but per the [Slice 6 ship/no-ship policy](#dashboard-trust-controls-slice-1) a default change still requires the quality gate green plus the committed calibration artifact (`0.35` vs candidate) in the PR. B3 stops at the evidence; it does not flip the default.

### Manual golden re-test

Run after the think-tank onboarding blurb is saved (topics: economy / elections / Trump / Iran / inflation / gas; sources: Washington Post + Reuters; geographies: US / Iran). Append `?debug=1` to the dashboard URL to read the run-diagnostics panel while checking:

- [ ] Onboarding blurb saved; settings show **WaPo + Reuters**.
- [ ] Refresh completes; `_meta.usedFallbackClustering === false` (or the **"Couldn't compose stories this refresh"** clustering-failed UI shows if it's `true`).
- [ ] **≥2 meta-stories** with real titles (not `* Updates` / "General Updates").
- [ ] **≥1 Reuters-sourced** item in the pool or key stories.
- [ ] No **Spelling Bee** (liveblog) duplicate stack collapsed into one meta-story.
- [ ] `npm run eval:dashboard-refresh-golden` passes locally (hermetic regression guard — see [evals README](apps/api/src/ai/evals/README.md#dashboard-refresh-golden-slice-2)).
- [ ] (Optional, before any floor change) `npm run eval:dashboard-calibration` — compare floors and confirm guardrails hold; pair the table with `?debug=1` quality review.
- [ ] (CI / pre-PR) `npm run eval:dashboard-quality-gate` — golden + calibration in one command; must exit `0`.

## Clustering reliability probe (live gate)

`npm run cluster:probe` ([`scripts/cluster-reliability-probe.mjs`](apps/api/scripts/cluster-reliability-probe.mjs)) hammers `POST /api/dashboard/refresh` for one user N times and enforces the clustering reliability gate. Use it to baseline reliability before/after a clustering change.

> **Before a pilot or a clustering-reliability merge,** run the full [Clustering MVP readiness gate](docs/clustering-mvp-gate.md) — the operator checklist that wraps the quality gate, this probe, and a manual golden sanity pass, with a signoff template and failure triage.

> **Live probe** — requires the API server running (`npm run dev`) and, for `--email`, Supabase admin env (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `apps/api/.env`). It only *observes* refresh responses; it does not change product behavior.

```sh
cd 05-engineering/apps/api
npm run cluster:probe -- --email <your-invited-email>          # 20 runs, 3s cooldown (defaults)
npm run cluster:probe -- --user-id <uuid> --runs 20
npm run cluster:probe -- --email <email> --runs 30 --cooldown-ms 5000 --base-url http://localhost:8787
npm run cluster:probe -- --email <email> --mode cold-start --require-recompute --runs 20 --base-url http://localhost:8787
```

`--email` is the preferred, portable mode (uses `x-recognized-email`); `--user-id` runs a single preflight first and exits clearly if the server's `x-user-id` path is not accepted. `--mode cold-start` targets `?profile=cold_start` and scopes latency to recompute runs. `--require-recompute` keeps sampling until it collects the requested recompute count (bounded by an attempt cap) and exits non-zero on insufficient recompute sample quality.

**Gate (pass requires both):** `successRate >= 0.95` (fraction of runs with `_meta.usedFallbackClustering === false`) **and** `medianStories >= 2` (median `stories.length`). Default `N = 20` runs.

**Pass/fail:** exits `0` only when the reliability gate passes; otherwise exits **non-zero** and prints which threshold failed. In recompute-enforced runs (`--require-recompute`), the probe adds an independent sample-quality gate: if the recompute target is not met, it exits non-zero with `SAMPLE-QUALITY FAIL` even when success-rate and story-count thresholds pass.

The final summary JSON includes baseline fields (`runs`, `successRate`, `medianStories`, `p95PipelineMs`, `clusteringFailureReasons`, `clusteringFailureSubtypes`, `refreshSkippedReasons`) plus Step 4.1 transparency fields (`latencyScope`, `recomputeRuns`, `skippedRuns`, `latencyRunsCounted`, `requireRecompute`, `recomputeTarget`, `recomputeTargetMet`, `attempts`). `clusteringFailureSubtypes` is a histogram of the **Failure subtype taxonomy** above — it splits the coarse `clusteringFailureReasons` `error` bucket into `parse` / `provider_request` / `unknown` for triage. The probe reads the subtype from each response's top-level `_meta.clusteringFailureSubtype`, falling back to `_meta.outcomes.clusteringFailureSubtype` for older servers. It is diagnostics only and **never feeds the pass/fail gate**. Pure helpers are unit-tested offline in [`scripts/cluster-reliability-probe.test.mjs`](apps/api/scripts/cluster-reliability-probe.test.mjs).

### Nightly clustering reliability workflow (background monitoring)

**Workflow:** `Cluster reliability nightly` ([`.github/workflows/cluster-reliability-nightly.yml`](../.github/workflows/cluster-reliability-nightly.yml)) runs the probe above against a deployed API every night and uploads the results. It is **background monitoring only** — the manual [Clustering MVP readiness gate](docs/clustering-mvp-gate.md) is still required before pilots and before merging clustering-reliability changes.

- **Cadence:** `15 4 * * *` (04:15 UTC nightly), plus manual `workflow_dispatch`. The minute (`:15`) is offset from the hourly cadence-tick (`:05`) and ingestion-warm (`:35`) jobs and away from the 09:00 UTC source-digest, so the scheduled jobs don't contend for runner capacity.
- **Thresholds:** owned entirely by the probe (`successRate >= 0.95` **and** `medianStories >= 2`). The job **fails when the probe exits non-zero** — no threshold logic is duplicated in the workflow.
- **Where to view runs/artifacts:** GitHub → **Actions** → **"Cluster reliability nightly"** → a run → **Artifacts**: `cluster-reliability-nightly-<run_id>` contains `cluster-probe.log` (full probe stdout/stderr) and `cluster-probe-summary.json` (extracted summary). Artifacts upload even on failure (retained 30 days).
- **Required repo secrets** (Settings → Secrets and variables → Actions): `CLUSTER_PROBE_EMAIL` (invited test user), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `TEMPO_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`). A missing secret fails the run fast with a clear message before any live HTTP.
- **Manual dispatch + input overrides:** Actions → "Cluster reliability nightly" → **Run workflow**. Optional inputs (all default to the probe's own defaults): `runs` (default `20`), `cooldown_ms` (default `3000`), `base_url` (default `https://tempo-gray-psi.vercel.app`). Example: `runs=30`, `cooldown_ms=5000`, `base_url=https://tempo-gray-psi.vercel.app`.

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

## Ingestion cache warmer (Phase 1 Slice 3–4)

Background: Slice 3 added the [ingestion warmer](apps/api/src/ops/ingestion-warm.mjs) — a standalone ops script that fetches the full active manifest and upserts the rows into the `ingestion_recent_items` Tier-A cache. Slice 4 puts it on a schedule so the cache stays warm without manual invocation, letting interactive `POST /api/dashboard/refresh` calls hit the cache instead of paying the live RSS fetch latency.

- **What runs on schedule:** [`.github/workflows/ingestion-warm.yml`](../.github/workflows/ingestion-warm.yml) runs hourly at `:35` (`cron: "35 * * * *"`) and on manual `workflow_dispatch`. The `:35` offset is deliberate — it stays clear of the cadence-tick workflow at `:05` so the two scheduled jobs don't contend for the same top-of-hour runner capacity.
- **What it calls:** [`apps/api/src/ops/ingestion-warm.mjs`](apps/api/src/ops/ingestion-warm.mjs) calls `readFeedItems(dataDir)` with **no `feedIds`** — a full-manifest fetch across every active feed (deliberately *not* the per-user scoped fetch the cache-miss path uses) — then writes the mapped items via `writeRecentItems({ supabase, items })` from [`recent-items-cache.mjs`](apps/api/src/ingestion/recent-items-cache.mjs). It imports those helpers directly and never boots the HTTP app.
- **Expected logs:** One single-line JSON summary per run, tagged `[ingestion-warm]`. Fields: `ok`, `startedAt`, `itemCount`, `feedCount`, `written`, `durationMs`, `skippedReason` (failures only), and `error` (failures only — a serialized, actionable supabase error string of `message`/`code`/`details`/`hint`/`status`, never the old opaque `[object Object]`; triage table in [`runbook-ingestion-warm.md`](docs/runbook-ingestion-warm.md)). Inspect by grepping the workflow run output for `[ingestion-warm]`.
- **Failure semantics:**
  - Exit `0` on success — **including a clean warm of zero items** (an empty manifest is not a failure).
  - Exit `1` only on fatal errors: missing `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (`skippedReason: "missing_supabase_env"`), supabase client construction failure (`"supabase_client_failed"`), the live read throwing (`"read_threw"`), or the cache write throwing (`"write_threw"`) / returning an error envelope (`"write_error"`).
- **Where to inspect:** GitHub → Actions → "Ingestion cache warmer" → most recent run → `Run ingestion warm` step. The `[ingestion-warm]` line is the structured signal; the preceding `Run started at …` echo confirms the workflow reached the step.
- **Secrets:** Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the same pair the cadence tick uses) under repo Settings → Secrets and variables → Actions before enabling the schedule. The warmer writes with the service role, so a service-role key is required — it exits `1` with `skippedReason: "missing_supabase_env"` if either is absent.

**Local invocation** (for debugging — requires `apps/api/.env` with Supabase creds):

```sh
node apps/api/src/ops/ingestion-warm.mjs
```

## Refresh latency & expansion-safe ingestion (Phase 1 Slices 5–8)

Operator-facing knobs and contracts that landed with source expansion. See [D-066](DECISIONS.md) for the decision record and [why-this-matters spec §12.2](docs/why-this-matters-spec.md) for the writer detail.

- **Parallel why-it-matters concurrency.** The per-story implications writer runs in a bounded parallel pool sized by `TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY` — **default `4`, clamped to `1..6`** (invalid values fall back to `4`). Raising it trades provider fan-out for lower refresh latency; keep it within the bounds. Response **story order stays deterministic (R1)** regardless of writer completion order.
- **`_meta.timings` per-stage latency.** Refresh responses now carry `_meta.timings` (persisted via `_lastRunMeta.timings`) with both ingestion and pipeline stage wall-clocks: `ingestionMs`, `preClusterMs`, `recallMs`, `clusterMs`, `whatChangedMs`, `whyMs`, `pipelineMs`. This is the first surface for "why was this refresh slow?".
- **Expansion-safe allowlist contract.** **Do** leave `TEMPO_RSS_ALLOWLIST` **unset** during source expansion so fetch scope derives from the active manifest feeds — newly-activated publishers ingest automatically. **Don't** carry a legacy narrow allowlist (e.g. `washington post,reuters`) into an expansion rollout: a stale env silently blocks new feeds (the "Reuters-class block"). Set it only to *intentionally* constrain fetch scope, as temporary/explicit narrowing. See [`apps/api/.env.example`](apps/api/.env.example).

## X ingestion pilot validation (Phase 1)

The X (Twitter) ingestion path reads recent tweets for handles in a user's `socialSources` and merges them into the refresh pool alongside RSS — fail-open, so RSS still renders if X fails. Use this checklist to validate the **@petrogustavo pilot** end-to-end.

**1. Set env vars** (`apps/api/.env`; server-side only — never `VITE_*`):

```sh
TEMPO_X_INGESTION_ENABLED=true
TEMPO_X_BEARER_TOKEN=...          # App-only Bearer; never logged
TEMPO_X_HANDLE_ALLOWLIST=petrogustavo   # pilot gate (see note below)
```

**2. Save settings** for the pilot user with the social handle(s) under `socialSources` (e.g. `@petrogustavo`) via `PUT /api/settings`.

**3. Trigger a refresh** — `POST /api/dashboard/refresh`.

**4. Verify ingestion** via the read-only diagnostics endpoint `GET /api/dashboard/refresh/meta` (returns `{ ok, meta }`; `meta` is the last run's `_meta`, or `null` with no snapshot). On a healthy pilot run, assert under `meta.ingestion.x`:

- `enabled === true`
- `handlesFetched >= 1`
- `tweetsReturned > 0`
- `degraded === false`

A tweet from `@petrogustavo` clustered into a meta-story confirms the full path (read → merge → cluster).

**4a. Trace where social items are lost** via `meta.funnel.social` — an additive, per-stage count of `kind:"social"` items mirroring the main funnel (`totalNormalized`, `afterTimeWindow`, `afterSourceSelection`, `afterGeoFilter`, `afterTopicKeyword`, `afterBeatFit`, `afterDedupe`) plus `inPublishedStories` (count of social sources in the final stories; `null` on a watermark-skip), `primaryDropStageForSocial` / `largestDropCountForSocial` / `dropsByStage` (where the biggest social drop happened), and selection context (`socialSelectionApplied`, `matchedSocialSourceCount`, `matchedSocialSources`). Pure observability — it never changes selection/ranking. Grep the one-line `[pipeline.funnel.social]` log for the same counts. Example: `afterSourceSelection > 0` but `inPublishedStories === 0` isolates the loss to clustering/grounding, not source selection.

**4b. Pinpoint the POST-DEDUPE stage** via `meta.funnel.social.postDedupe` — when `afterDedupe > 0` but `inPublishedStories === 0`, this block names the exact stage between the clustering candidate set and final publish: `clusterInputSocialCount`, `clusterOutputClusterCount` (clusters with >=1 social source), `afterGroundingSocialStoryCount`, `afterOverflowCapSocialStoryCount`, and `publishedSocialSourceCount` (mirrors `social.inPublishedStories`). Attribution: `primaryPostDedupeDropStage` (`cluster_output` | `grounding` | `overflow_cap` | `none`), `largestPostDedupeDropCount`, and `dropsByPostDedupeStage`. Small capped (<=25) id arrays — `socialSourceItemIdsAtDedupe`, `socialMetaStoryIdsAfterGrounding`, `socialMetaStoryIdsAfterOverflowCap` — make a specific dropped item/story traceable. On a watermark-skip the post-cluster counts are `null` (those stages didn't run). One-line log: `[pipeline.funnel.social.post_dedupe]`. Example: `clusterOutputClusterCount > 0` but `afterGroundingSocialStoryCount === 0` → grounding is dropping the social story.

**5. Verify fail-open** — disable the token (unset/blank `TEMPO_X_BEARER_TOKEN`) or otherwise force an X failure, then refresh again. RSS continuity must hold:

- the dashboard still returns stories derived from RSS
- `meta.ingestion.x.degraded === true` (with an entry under `errors`)

> **Pilot → full rollout:** `TEMPO_X_HANDLE_ALLOWLIST` is a pilot guardrail — when set, only those handles are fetched even if a user follows more. To expand from the pilot to **all** selected handles, **unset** `TEMPO_X_HANDLE_ALLOWLIST`.

> **Phase 2 (multi-handle):** with the allowlist unset, the reader ingests **every** handle in `settings.socialSources`, fetched with bounded parallelism (`TEMPO_X_HANDLE_CONCURRENCY`, default 3, clamped 1..5) for a safe rate-limit posture. One bad handle is isolated — its tweets are dropped and `_meta.ingestion.x.degraded=true` with an `errors[]` entry, while every other handle still merges. Per-handle counts surface additively under `_meta.ingestion.x.tweetsByHandle`.

Wiring: [`x-api-client.mjs`](apps/api/src/ingestion/x-api-client.mjs), [`x-reader.mjs`](apps/api/src/ingestion/x-reader.mjs), merge + `_meta.ingestion.x` in [`server.mjs`](apps/api/src/server.mjs); env reference in [`apps/api/.env.example`](apps/api/.env.example).

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
