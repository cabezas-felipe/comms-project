# Cold-start v1

Scope: brand-new users where the app has no prior dashboard snapshot and only knows the user's email plus onboarding narrative.

## Goal

Deliver a fast, accurate first dashboard experience for new users while preserving trust (fail-closed clustering, no fabricated fallback stories).

## Locked decisions

| Item | Decision |
|---|---|
| Trigger | `priorSnapshot === null` at refresh start |
| First profile | `cold_start` (onboarding handoff only) |
| Geo behavior on cold start | **Soft (default):** no geo admission gate — all recent candidates continue downstream; nothing deferred/held by geo. **Hard (rollback):** process Lane 1 + lexical, defer all Lane 2 to hold. See [Geo admission mode](#geo-admission-mode). |
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

## Geo admission mode

Geo is **no longer an admission gate by default.** `TEMPO_GEO_ADMISSION_MODE` controls the behavior; the default is `soft`.

- **`soft` (default):** geography never blocks admission. There is no Lane 2 defer, no hold-bucket write, and the Haiku geo assessor is not called. Every recent candidate continues to the downstream recall → beat-fit → clustering stages, which decide relevance. All downstream caps are unchanged (cold-start cluster input cap of 10, clustering timeouts/attempts, etc.). The `cold_start` profile's `deferGeoLane2` has no effect under soft.
- **`hard` (rollback):** the legacy gate. Lane 1 (must-see: selected source + geo signal) is processed to completion; Lane 2 is assessed under the geo budget and the remainder is deferred to the hold bucket. On the `cold_start` profile this defers all of Lane 2.

**Why soft is the default:** the hard gate produced false negatives for election/political-monitoring coverage whose text omits an explicit configured-geography token (e.g. Spanish "elecciones" headlines that never say "Colombia"). Those items carried no lexical geo signal, fell into Lane 2, and were deferred before clustering ever saw them. Soft removes that admission drop; relevance is decided downstream instead.

**Rollback:** set `TEMPO_GEO_ADMISSION_MODE=hard` (unset/empty/invalid all resolve to `soft`; only the exact value `hard` rolls back). No deploy required — the value is read per refresh run. Diagnostics surface the active mode on `_meta.outcomes.geoAdmissionMode` / `geoAdmissionBypassed`.

**Status — `hard` is rollback-only and slated for removal.** The hard gate (lane split, Lane 2 defer, Haiku assessor, and the geo hold bucket) is retained solely as the rollback path; the code lives in `runHardGeoAdmissionGate` (marked `@deprecated`). It is a removal candidate after the soft-default stability milestone. **Before removing,** confirm telemetry shows **no** runs with `_meta.outcomes.geoAdmissionMode === "hard"` (and no `[pipeline.geo] hard admission gate ACTIVE` log lines) over the agreed window (e.g. 30 days). Removing it also retires the `readHeldFn`/`writeHeldFn` hold-bucket path.

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
