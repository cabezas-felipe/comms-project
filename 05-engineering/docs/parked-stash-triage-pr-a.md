# Parked stash triage — PR A

Read-only audit of `git stash@{0}` (`On fix/supabase-migrations-010-014: phase0-defer-mixed-scope-files`) against current `origin/main`. The branch `parked/triage-pass-1` is at `4771fdd` (= `origin/main` HEAD, working tree clean) for the duration of this triage; no runtime behavior is changed by PR A.

Stabilization context: PR #20 (hybrid recall + diagnostics), PR #21 (watermark-skip diagnostics + tests), and PR #22 (ingestion/source guardrails: allowlist, active feed gating, env alias compatibility) are already merged on `main`. The bulk of the stash predates those merges and has been independently re-implemented (often more carefully) on `main`.

## Summary

- **31 paths** in stash@{0} (26 tracked + 5 untracked).
- **18 obsolete** — fully superseded by #20/#21/#22; drop from stash plan.
- **10 keep now** — split across PR B (scripts/ops) and PR C (prototype).
- **1 keep now** — `05-engineering/package-lock.json`, but regenerate fresh via `npm install` in PR B rather than restore from stash.
- **2 partial** — `05-engineering/README.md` and `05-engineering/apps/api/package.json` carry both keep-now and obsolete-now content; cherry-pick on restore (see notes).
- **0 deferred** — nothing in the stash is "valid but wrong slice".

## Verification of "obsolete" classifications

For every file marked obsolete I extracted the stash version and compared against current `main`:

- `embeddings.mjs`, `openai-embeddings.mjs`, `embedding-recall.mjs`, `embedding-recall.test.mjs`, `beat-fit-scorer.mjs`, `beat-fit-scorer.test.mjs` — **byte-identical to `main`** (these were "new file" in the stash; the same content shipped via #20). Restoring them is a no-op.
- `model-router.{mjs,test.mjs}`, `onboarding-extractor.{mjs,test.mjs}`, `refresh-pipeline.{mjs,test.mjs}`, `server.mjs`, `server.routes.test.mjs`, `feed-reader.{mjs,test.mjs}`, `source-matcher.{mjs,test.mjs}` — every symbol, test, and behavior the stash adds (e.g. `resolveExtractionChain`, `resolveTimeoutMs`, `summarizeFunnel` / `primaryDropStage` / `formatFunnel`, `applyAllowlistGuard`, `_embeddings.embed`, `priorStoryCount`, `settingsWithNarrative`, `feedIsActive`, the embed-throws-WITH/WITHOUT-lexical route tests) is **already present on `main`**, generally with a more refined contract (see "Conflict routing" below).

## File table

| Path | Bucket | Rationale |
|---|---|---|
| `04-prototype/src/components/StateBlocks.tsx` | keep now (PR C) | Empty/error states updated to match the no-fake-fallback API change; not touched by #20–#22. |
| `04-prototype/src/lib/api.test.ts` | keep now (PR C) | Tests the new `DashboardFetchError` contract. |
| `04-prototype/src/lib/api.ts` | keep now (PR C) | Removes `localFallbackPayload`/`STORIES` fake-data fallback (still present on `main`); introduces typed `DashboardFetchError`. Real product behavior change, prototype-only. |
| `04-prototype/src/pages/Dashboard.test.tsx` | keep now (PR C) | Companion tests for Dashboard error/empty rendering. |
| `04-prototype/src/pages/Dashboard.tsx` | keep now (PR C) | Render error/empty states via `DashboardFetchError.kind`. |
| `04-prototype/src/pages/Onboarding.test.tsx` | keep now (PR C) | New analytics/error-path tests. |
| `04-prototype/src/pages/Onboarding.tsx` | keep now (PR C) | Onboarding analytics + error handling tied to api.ts changes. |
| `05-engineering/README.md` | partial (PR B) | Keep migrations-runner + Phase-1 source-scope sections (they document PR B's scripts). Drop the "Onboarding extraction & dashboard testing" block — the runtime it describes already shipped on `main` and the doc adds limited value as a stale snapshot. **Update before commit:** the WaPo guard env in stash is `TEMPO_INGESTION_ALLOWLIST`; `main`'s primary name is `TEMPO_RSS_ALLOWLIST` (legacy alias retained). Edit the doc to reflect that. |
| `05-engineering/apps/api/package.json` | partial (PR B) | Keep `db:migrate`, `db:migrate:dry`, `db:scope:apply[:dry]`, `db:scope:restore[:dry]`, `db:scope:verify`, the `pg` dependency, and the `scripts/source-scope-phase1.test.mjs` entry in the `test` script. Also opportunistically register `src/ingestion/embedding-recall.test.mjs` and `src/dashboard/beat-fit-scorer.test.mjs` in the `test` script — both files exist on `main` but are **not currently invoked by `npm run test:api`** (real gap, found during triage). |
| `05-engineering/apps/api/scripts/run-migrations.mjs` | keep now (PR B) | Net-new ops tool. Idempotent ledger-backed runner over `src/db/migrations/*.sql`. |
| `05-engineering/apps/api/scripts/source-scope-phase1.mjs` | keep now (PR B) | Net-new ops tool for Phase-1 WaPo scope (apply/restore/verify with self-managed `phase1_disabled_feeds` tracker — no separate migration required). |
| `05-engineering/apps/api/scripts/source-scope-phase1.test.mjs` | keep now (PR B) | Pure unit tests for the source-scope script's planner; depends only on the script itself. |
| `05-engineering/apps/api/src/ai/embeddings.mjs` | obsolete | New-file content is **byte-identical to `main`** (already shipped via #20). |
| `05-engineering/apps/api/src/ai/model-router.mjs` | obsolete | `resolveExtractionChain` already present on `main` with the same defaults and env names. |
| `05-engineering/apps/api/src/ai/model-router.test.mjs` | obsolete | All `resolveExtractionChain` tests already present on `main`. |
| `05-engineering/apps/api/src/ai/onboarding-extractor.mjs` | obsolete | `DEFAULT_EXTRACTION_TIMEOUT_MS` + `resolveTimeoutMs` already on `main`. |
| `05-engineering/apps/api/src/ai/onboarding-extractor.test.mjs` | obsolete | Timeout-resolution tests already on `main`. |
| `05-engineering/apps/api/src/ai/providers/openai-embeddings.mjs` | obsolete | New-file content is **byte-identical to `main`**. |
| `05-engineering/apps/api/src/dashboard/beat-fit-scorer.mjs` | obsolete | New-file content is **byte-identical to `main`**. |
| `05-engineering/apps/api/src/dashboard/beat-fit-scorer.test.mjs` | obsolete | New-file content is **byte-identical to `main`**. |
| `05-engineering/apps/api/src/dashboard/refresh-pipeline.mjs` | obsolete | Funnel diagnostics, beat-fit hook, embedding-recall integration, watermark short-circuit + `priorStoryCount` trap-guard all merged via #20/#21. |
| `05-engineering/apps/api/src/dashboard/refresh-pipeline.test.mjs` | obsolete | All `Phase 1 pairwise`, `primaryDropStage`, `formatFunnel`, `summarizeFunnel`, and `TEMPO_RECALL_MODE=keyword` shim tests already on `main`. **Conflict driver — drop, don't route.** |
| `05-engineering/apps/api/src/ingestion/embedding-recall.mjs` | obsolete | New-file content is **byte-identical to `main`**. |
| `05-engineering/apps/api/src/ingestion/embedding-recall.test.mjs` | obsolete | New-file content is **byte-identical to `main`**. |
| `05-engineering/apps/api/src/ingestion/feed-reader.mjs` | obsolete | Allowlist guard merged via #22. **Contract on `main` is more refined** (`{allowed, blocked}` return shape, `TEMPO_RSS_ALLOWLIST` primary + `TEMPO_INGESTION_ALLOWLIST` legacy alias). Restoring the stash version would regress the env-alias work. **Conflict driver — drop, don't route.** |
| `05-engineering/apps/api/src/ingestion/feed-reader.test.mjs` | obsolete | Main has different but equivalent allowlist tests aligned to `main`'s `{allowed, blocked}` shape. **Conflict driver — drop, don't route.** |
| `05-engineering/apps/api/src/ingestion/source-matcher.mjs` | obsolete | `feedIsActive` filter already enforced on `main` at the eligibility step (#22). |
| `05-engineering/apps/api/src/ingestion/source-matcher.test.mjs` | obsolete | `active=false` exclusion + only-inactive-bucket + fallback-baseline tests already on `main`. |
| `05-engineering/apps/api/src/server.mjs` | obsolete | `_embeddings`, `embedFn`, `priorStoryCount`, `_narrativeRepo.read`, `settingsWithNarrative`, `resolveExtractionChain`, `classifyExtractionError`, `logExtractionConfigOnStartup`, `_meta.{beatFit,recall,funnel}` surfacing all already on `main`. |
| `05-engineering/apps/api/src/server.routes.test.mjs` | obsolete | `_embeddings.embed` deterministic stub + `embedFn throws WITH/WITHOUT lexical hits` route tests already on `main`. |
| `05-engineering/package-lock.json` | regenerate | Stash adds the `pg` family (~147 lines). Don't restore from stash; let `npm install` (run after PR B's `package.json` edit) regenerate the lock cleanly to match the workspace's current dep graph. |

## Conflict routing (from `git stash apply` on this triage branch)

`git stash apply stash@{0}` reported conflicts in **`refresh-pipeline.test.mjs`**, **`feed-reader.mjs`**, and **`feed-reader.test.mjs`**. All three are classified **obsolete** above — the stash content has already shipped on `main` (often with a more refined contract). The right action is **drop these from any restore plan**, not "route to PR D". The branch was reset back to `origin/main` immediately after surfacing the conflict; nothing was committed.

## Recommended PR split

- **PR A — done.** This document. No runtime / packages / lockfile changes.
- **PR B — scripts/ops + docs (next).** Restore the three `apps/api/scripts/*` files, edit `apps/api/package.json` to add the `db:*` scripts + `pg` dep + register the three test files (one new from stash, two already on disk but not in the runner), regenerate `package-lock.json` via `npm install`, and edit `README.md` to add the migrations + Phase-1 source-scope sections (with `TEMPO_RSS_ALLOWLIST` instead of `TEMPO_INGESTION_ALLOWLIST`). Verification: `npm run test:api` passes; `npm run db:migrate:dry` lists pending against a real `DATABASE_URL`.
- **PR C — prototype no-fake-fallback (after B).** Restore the seven `04-prototype/**` files; the change is self-contained (typed `DashboardFetchError`, real empty/error UI, no `STORIES` fallback). Verification: `npm run test:prototype`; smoke the dashboard against the API offline to confirm error/empty surfaces correctly.
- **PR D — not needed.** No residual backend work survives triage; everything else in the stash is obsolete. Keep this slot only as a reservation in case PR B unearths a hidden coupling during restore.

## Next command (PR B kickoff)

Open from `parked/triage-pass-1` (clean) — branch off `origin/main`, restore only the keep-now scripts, then hand-edit `package.json` + `README.md` and let `npm install` regenerate the lockfile:

```sh
git checkout -b phase1/scripts-ops origin/main

git checkout stash@{0} -- \
  05-engineering/apps/api/scripts/run-migrations.mjs \
  05-engineering/apps/api/scripts/source-scope-phase1.mjs \
  05-engineering/apps/api/scripts/source-scope-phase1.test.mjs

# Then hand-edit (see partial-bucket notes above):
#   05-engineering/apps/api/package.json
#   05-engineering/README.md

cd 05-engineering && npm install   # regenerate package-lock.json cleanly
npm run test:api                   # confirm all tests register and pass
```

Do **not** `git checkout stash@{0} --` `package.json`, `package-lock.json`, or `README.md` — those carry obsolete content alongside the keep-now content. Hand-edit instead.
