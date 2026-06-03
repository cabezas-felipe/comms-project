# Cold-start v1

Scope: brand-new users where the app has no prior dashboard snapshot and only knows the user's email plus onboarding narrative.

## Goal

Deliver a fast, accurate first dashboard experience for new users while preserving trust (fail-closed clustering, no fabricated fallback stories).

## Locked decisions

| Item | Decision |
|---|---|
| Trigger | `priorSnapshot === null` at refresh start |
| First profile | `cold_start` (onboarding handoff only) |
| Geo behavior on cold start | Process Lane 1 + lexical; defer all Lane 2 to hold |
| Cluster model | Sonnet (no Haiku swap) |
| Cluster timeout | 45s max per attempt, return sooner if call completes sooner |
| Cluster attempts | 2 |
| Cluster input cap | 10 items to `clusterFn` |
| Onboarding save behavior | Option A: block on save + extraction success |
| Prefetch behavior | Start refresh on successful onboarding save |
| Job join contract | `PUT /api/settings` returns `refreshJobId`; dashboard polls status endpoint |
| Success threshold | At least 1 meta-story is enough for cold start |
| Retry profile | Default profile (not `cold_start`) |
| Background updates | Silent merge on subsequent refreshes |
| Ingestion warm | Out of scope for now |
| Extraction deterministic fallback | Deprioritized |
| Alternate clustering model for latency | Out of scope |

## SLO targets

- p50: submit onboarding to first meta-story visible <= 30s
- p95: submit onboarding to first meta-story visible <= 45s

## API and UI behavior

1. User submits onboarding narrative.
2. Backend saves settings and runs extraction (blocking for accuracy).
3. On extraction success, backend starts one cold-start refresh and returns `refreshJobId`.
4. Dashboard joins that in-flight work by polling refresh status.
5. Progress phases shown to user:
   - `ingesting`
   - `matching`
   - `clustering`
6. If cold-start refresh succeeds with >=1 story, render dashboard.
7. If it fails, show clustering-failed UI and route Retry through default refresh profile.
8. Subsequent refreshes silently merge improved results.

## Out of scope in this slice

- Scheduled ingestion warming.
- Haiku (or any lower-quality) clustering fallback.
- Deterministic extraction fallback path.

## QA

Manual smoke checklist for this flow: [Cold-start QA — manual smoke runbook](./runbook-refresh-slo.md#cold-start-qa--manual-smoke-runbook).
