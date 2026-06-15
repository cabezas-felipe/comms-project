# Cold-start v1

Scope: brand-new users where the app has no prior dashboard snapshot and only knows the user's email plus onboarding narrative.

## Goal

Deliver a fast, accurate first dashboard experience for new users while preserving trust. When LLM clustering succeeds the run is `ok`. When LLM clustering fails terminally the pipeline no longer always ships zero stories: it attempts a **strict, relevance-gated deterministic fallback** (topic+keyword gated singleton meta-stories — never generic `"<Topic> Updates"` buckets). If that fallback publishes, the run is `degraded` (still honest — no fabricated stories). Only when neither the LLM nor the deterministic fallback yields an eligible story does the run **fail closed** (zero stories). See [Refresh outcomes (post Phase A + B)](#refresh-outcomes-post-phase-a--b).

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

## Refresh outcomes (post Phase A + B)

A cold-start (and every) refresh now resolves to one of **three** outcomes, surfaced on `_meta.refreshStatus`. The earlier "LLM fails ⇒ always zero stories" model is no longer accurate — a strict deterministic rescue sits between success and hard failure.

| Outcome | `_meta.refreshStatus` | Stories | What happened | Key `_meta` signals |
|---|---|---|---|---|
| **LLM success** | `ok` | ≥1 LLM meta-story | LLM clustering (or its bounded recovery) produced stories. | `refreshFailure: null`, `usedDeterministicClustering` absent/false, `clusteringLlmFailed` absent/false |
| **LLM fail + deterministic rescue** | `degraded` | ≥1 deterministic singleton story | LLM clustering failed terminally; the **strict relevance-gated deterministic fallback** published bounded singleton meta-stories. A real, bounded publish — **not** a failure. | `refreshFailure` non-null (retained LLM-failure attribution), `clusteringLlmFailed: true`, `usedDeterministicClustering: true`, `deterministicClusteringDiagnostics` present, `upgradeRefreshScheduled: true` (see B5 below) |
| **LLM fail + no shipped fallback story** | `failed` | 0 (fail closed) | LLM clustering failed and the final response shipped zero stories. That can happen because no item cleared the strict topic+keyword gate, **or** because deterministic rescue output was later dropped before publish (for example by grounding). The dashboard is empty — the honest signal that this refresh could not compose stories. The **prior snapshot is preserved** when one exists (`usedPriorSnapshot: true`), so the user keeps their last good dashboard rather than seeing it wiped. | `refreshFailure` non-null, `clusteringLlmFailed: true`, `usedDeterministicClustering` may be `true` or `false` (diagnostic), `usedPriorSnapshot` true when a prior snapshot was re-served |

**Deterministic fallback is strict and relevance-gated.** It builds singleton meta-stories **only** from beat-fit survivors that pass the same deterministic **topic+keyword** relevance bar the rest of the pipeline enforces, ordered by the pre-cluster relevance scorer ([`relevance-gated-fallback.mjs`](../apps/api/src/dashboard/relevance-gated-fallback.mjs)). It **never** calls `gracefulFallbackClustering` and never emits generic `"<Topic> Updates"` buckets — an item that does not clear the gate produces no story. This is what keeps the `degraded` outcome honest. The `failed` outcome above is exactly the case where this strict gate admits zero items.

**B5 — background default-profile upgrade after a degraded rescue.** When a refresh resolves `degraded` (deterministic rescue published), the API schedules a **fire-and-forget background default-profile LLM refresh** so a healthy LLM run can **replace** the degraded snapshot moments later ([`startDefaultProfileUpgrade` in `server.mjs`](../apps/api/src/server.mjs)). It runs the full default profile (`refreshProfile: null`), is per-user in-flight guarded (a second degraded run joins/no-ops rather than stacking upgrades), and **never blocks or fails the foreground response**. The foreground response carries `_meta.upgradeRefreshScheduled: true` (and `upgradeRefreshReason`) so the client knows a retry is coming. A preserved-prior continuity run (a true fail-closed re-serve) does **not** schedule an upgrade — only an actual deterministic rescue does.

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
6. Refresh resolves to one of three outcomes (see [Refresh outcomes](#refresh-outcomes-post-phase-a--b)):
   - `ok` — LLM clustering produced ≥1 story; render the dashboard.
   - `degraded` — LLM clustering failed but the strict deterministic fallback published ≥1 story; render those stories, and a background default-profile LLM upgrade is scheduled to replace them shortly (B5).
   - `failed` — neither LLM nor deterministic fallback yielded a story; show clustering-failed UI and route Retry through the default refresh profile. The prior snapshot is preserved when one exists.
7. Subsequent refreshes (including the scheduled B5 upgrade) silently merge improved results.

## Out of scope in this slice

- Scheduled ingestion warming.
- Haiku (or any lower-quality) **LLM** clustering fallback. (Distinct from the strict relevance-gated **deterministic** clustering fallback shipped in Phase B — that is offline/no-LLM and now in production; see [Refresh outcomes](#refresh-outcomes-post-phase-a--b).)
- Deterministic **extraction** fallback path.

## QA

Manual smoke checklist for this flow: [Cold-start QA — manual smoke runbook](./runbook-refresh-slo.md#cold-start-qa--manual-smoke-runbook).
