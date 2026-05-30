# Phase 2 pre-flight (before Slice 9)

Run this checklist before activating AP/Bloomberg feeds. Slice 9 only adds feeds
to the Supabase manifest (`active` flag + import); **no env mutation should be
required** if the posture below holds. This doc is the runbook companion to the
expansion-safe contract in [../README.md](../README.md) and the decisions in
[../DECISIONS.md](../DECISIONS.md).

## 1. Allowlist must be unset for expansion

`TEMPO_RSS_ALLOWLIST` must be **unset** (absent / empty) in the deployed
`tempo-api` environments. The runtime allowlist is then derived from the active
manifest feeds, so newly-activated publishers ingest automatically. A stale narrow
allowlist (e.g. `washington post,reuters`) silently blocks new feeds — the
"Reuters-class block" documented in [../DECISIONS.md](../DECISIONS.md).

- Local guidance is consistent: [README.md](../README.md) (precedence + expansion
  contract), [DECISIONS.md](../DECISIONS.md), and
  [apps/api/.env.example](../apps/api/.env.example) all say "leave unset for expansion."
- Resolution lives in
  [apps/api/src/ingestion/feed-reader.mjs](../apps/api/src/ingestion/feed-reader.mjs)
  (`parseAllowlistEnv` / `resolveAllowlist`) and
  [apps/api/src/ingestion/source-matcher.mjs](../apps/api/src/ingestion/source-matcher.mjs).
- Set the env only to *intentionally* narrow scope (incident response / staging),
  and unset it again afterward.

**Verify deployed posture** (read-only) — see "Vercel commands" below.

## 2. Verify ingestion source + matched-feed behavior

Every refresh logs one summary line from
[apps/api/src/server.mjs](../apps/api/src/server.mjs):

```
[refresh] ingestionSource=<live|live_scoped|cache> items=<n> matchedFeeds=<n> ingestionMs=<ms>
```

- `ingestionSource=live` — full manifest fetch (the expected steady-state path).
- `ingestionSource=live_scoped` — scoped fetch on cache miss (matched feed ids only).
- `ingestionSource=cache` — served from the recent-items cache.

In all cases the feed set is **manifest-derived**, not env-pinned. After a Slice 9
manifest edit, confirm `matchedFeeds` increases by the number of feeds you
activated. If feeds you expect are missing from `matchedFeeds` while
`TEMPO_RSS_ALLOWLIST` is set, the env is masking the manifest — stop and unset it.

## 3. Cache warmer / cadence logs

The warmer and cadence tick are **scheduled GitHub Actions jobs** (not Vercel),
complementary per [DECISIONS.md D-066](../DECISIONS.md):

- [`.github/workflows/cadence-tick.yml`](../../.github/workflows/cadence-tick.yml)
  — drives due-user refreshes. Log tag `[cadence-tick]`.
- [`.github/workflows/ingestion-warm.yml`](../../.github/workflows/ingestion-warm.yml)
  — keeps the recent-items cache primed so cache-miss latency stays low. Log tag
  `[ingestion-warm]`.

Inspect via GitHub → Actions → the respective workflow → most recent run. Confirm
both are running on schedule (and their Supabase secrets are set) before relying
on new feeds. Local debug invocation:
`node apps/api/src/ops/ingestion-warm.mjs` (requires `apps/api/.env` Supabase creds).

## 4. Intake matrix is ready

Each AP/Bloomberg feed in [feed-url-matrix.md](feed-url-matrix.md) must be moved
from `proposed` to `validated` (URL fetches, parses, language confirmed) before it
is added to the manifest.

## Vercel commands

The API project is linked locally (`apps/api/.vercel/project.json`), but the
`vercel` CLI is not installed in this workspace, so deployed env posture could not
be verified automatically.

**Read-only verification** (run from `05-engineering/apps/api`):

```bash
vercel env ls
# Expected: NO row for TEMPO_RSS_ALLOWLIST (Production, and Preview if used).
```

**If a narrow allowlist is still pinned** — removal is destructive; get explicit
approval first, then:

```bash
# before:
vercel env ls
# remove (repeat per target environment that has it):
vercel env rm TEMPO_RSS_ALLOWLIST production
vercel env rm TEMPO_RSS_ALLOWLIST preview
# after — confirm absence:
vercel env ls
```

Redeploy/restart so the running instance picks up the unset value, then confirm a
`[refresh]` line shows the expected `matchedFeeds` count.

## Slice 9 — AP pilot activation note

The AP pilot (Slice 9) activates two feeds — `ap-world-latin-america` and
`ap-us` (`publisher = Associated Press`, `language = en`) — sourced from
`rss.app` **proxy** endpoints, mirroring the existing Reuters pilot feeds rather
than canonical AP enterprise RSS. This is a deliberate prototype constraint to
activate the pilot now; migration to an approved canonical AP endpoint is a
drop-in URL swap on the same `feed_id`s (no manifest id/name change). Bloomberg
remains out of scope (Slice 11/12). See
[feed-url-matrix.md](feed-url-matrix.md) for per-row status.

## Ready for Slice 9 when

- Deployed `TEMPO_RSS_ALLOWLIST` is **unset** in all targeted environments.
- A manifest edit yields a `[refresh]` line with `matchedFeeds` reflecting the new feeds.
- Cache warmer / cadence logs are healthy on schedule.
- Target feed URLs are `validated` in [feed-url-matrix.md](feed-url-matrix.md).
