# Runbook — Dashboard refresh SLO gates (`[refresh.slo]` / `[refresh.slo.gate]`)

Scope: the in-process SLO gate evaluated on every dashboard refresh settle
([`apps/api/src/ops/refresh-slo.mjs`](../apps/api/src/ops/refresh-slo.mjs),
wired from `emitRefreshObservability` in
[`apps/api/src/server.mjs`](../apps/api/src/server.mjs)).

This is **advisory only** — it emits log lines and an additive `_meta.slo`
surface. It never alters the refresh payload, never blocks a response, and
never changes trust behavior (fail-closed continuity, interactive profile, and
Slice 3 terminal-failure semantics are unchanged).

## Reading the logs

Two grep keys per refresh:

```
grep '\[refresh.slo.gate\]' <log>   # one machine-readable JSON snapshot per settle
grep '\[refresh.slo\] breach='<log> # one line per breach (only when breaching)
```

`[refresh.slo.gate]` JSON fields (stable): `pipelineMs`, `clusterTimeoutRate`,
`clusterFailureRate`, `windowSize` (attempt-only window depth), `storiesPublished`,
`emptyKind`, `profile`, `geoBudgetHit`, `geoLane2Deferred`, `enrichment`,
`breaches`. The same snapshot (plus `breachDetails` with per-breach action
hints) is mirrored on the refresh response `_meta.slo`.

`emptyKind` distinguishes a healthy quiet beat from a fail-closed:
`has_stories` | `legitimate_empty` | `clustering_failed`. It is derived from the
**terminal** `usedFallbackClustering` flag only — never from Slice 3 repair
diagnostics.

## Window sampling rules (don't misread the rates)

`clusterTimeoutRate` / `clusterFailureRate` are over an **attempt-only** rolling
window of the last `CLUSTER_TIMEOUT_WINDOW` (10) refreshes that *attempted*
clustering. No-attempt refreshes (watermark short-circuit, zero candidates) are
**not** sampled, so a stream of no-ops can't dilute the rate (no false calm).
Rate breaches only fire once the window is **full** (no cold-start trip).

**Terminal-failure guard:** a recovered parse-repair run (Slice 3) publishes
stories with no terminal failure, so it samples the window as *non-timeout,
non-failure*. Repair diagnostics (`clusteringRepairRawFailureClass` /
`clusteringRepairSchemaErrorBucket`) are deliberately **not** counted — they are
non-null on recovered runs and would overcount failures.

## Breaches → meaning → first checks → safe knobs

| `breach=` | Meaning | First checks | Safe knob / when to rollback vs investigate |
| --- | --- | --- | --- |
| `pipeline_slow` | One refresh exceeded `PIPELINE_SLOW_MS` (90s) end-to-end. | Read `[pipeline.timings]` for the same refresh: which stage dominates (`geoMs` / `clusterMs` / `recallMs`)? | If `clusterMs` dominates → provider latency; investigate Anthropic. If it's the **interactive** profile and `geoMs`+`clusterMs` are near budget, the 12000/22000 envelope is expected — only tune if chronic. |
| `cluster_timeout_rate` | >0.2 of the attempt window **timed out**. | Check Anthropic status / region latency; check `clusterTimeoutMs` (interactive 22000). | Provider-latency signal. Safe knob: raise `TEMPO_INTERACTIVE_CLUSTER_TIMEOUT_MS`. **Rollback** the interactive profile (revert to default cadence) if the spike correlates with a recent profile change; otherwise **investigate the provider**. |
| `cluster_failure_rate` | >0.5 of the attempt window **failed closed** (timeout OR error). | If timeouts are low but this is high → schema/auth/error, not latency. Read Slice 3 buckets (`clusteringRepairSchemaErrorBucket`) on `_meta` / `[cluster-engine]` logs. | NOT a timeout-tuning case. Investigate clustering provider output / API key / prompt-contract drift. Do **not** raise timeouts to mask it. |
| `geo_budget_pressure` | Geo stage hit its wall-clock budget AND deferred Lane 2 work to the hold path. | Deferred items are **never dropped** (re-evaluated next refresh — Slice 6). Check `geoBudgetMsUsed` vs `geoBudgetMsConfigured` and geo provider latency. | Throughput signal, not correctness. Safe knob: raise `TEMPO_INTERACTIVE_GEO_STAGE_BUDGET_MS` (interactive default 12000). If chronic on the interactive path, consider profile rollback; if geo-assess latency is high, investigate the geo provider. |

## Locked behavior (do not "fix" via SLO tuning)

- Fail-closed clustering continuity (Slice 1) and the prior-healthy-snapshot
  preservation are unchanged — `clustering_failed` empty is intentional.
- Interactive profile is locked at geo 12000 / clusterTimeout 22000 /
  **clusterMaxAttempts 2** (Slice 4.1). The attempt count is never lowered to
  shave latency.
- Slice 3 terminal-failure classification (`clusteringFailureReason` /
  `usedFallbackClustering`) is the only failure signal the gate reads.

## Thresholds (env-free constants, in `refresh-slo.mjs`)

`PIPELINE_SLOW_MS=90000`, `CLUSTER_TIMEOUT_WINDOW=10`,
`CLUSTER_TIMEOUT_RATE_THRESHOLD=0.2`, `CLUSTER_FAILURE_RATE_THRESHOLD=0.5`.
These are deterministic and unit-tested
([`refresh-slo.test.mjs`](../apps/api/src/ops/refresh-slo.test.mjs)); change them
with a code review, not an env override.

---

# Cold-start QA — manual smoke runbook

Operational checklist for the onboarding → cold-start refresh → dashboard
join/retry flow (Slices 1–11). Run top-to-bottom; capture the evidence in §5.
Spec: [`cold-start-v1.md`](./cold-start-v1.md).

## 1. Preconditions

- [ ] User has **no prior dashboard snapshot** (fresh user, or snapshot cleared).
- [ ] Onboarding narrative present (non-empty `onboardingRawText`).
- [ ] Auth/identity valid (Supabase bearer or recognized-email prototype identity).
- [ ] App (`04-prototype`) **and** API (`05-engineering/apps/api`) both running.

## 2. Core flow

- [ ] Onboarding save → `PUT /api/settings` responds `200` with
      `_meta.extractionStatus === "succeeded"` **and** `_meta.refreshJobId` (=== userId).
      Log: `[onboarding.prefetch] user=<id> extraction=succeeded prefetch=started refreshJobId=<id>`.
- [ ] Dashboard enters JOIN mode: progress text (`data-testid="cold-start-progress"`)
      shows a phase line (Gathering sources… / Matching your beat… / Assembling stories…).
- [ ] No duplicate refresh: `POST /api/dashboard/refresh` is **not** fired while JOIN is active.
- [ ] Status polling reaches a terminal state — `GET /api/dashboard/refresh-status/:jobId`
      returns `status: "done"` or `"failed"`.
      Log: `[dashboard.refresh-status] user=<id> jobId=<id> result=ok status=<…> phase=<…>`.
- [ ] **Success:** `done` → dashboard renders ≥1 story when available (else legitimate-empty copy).
- [ ] **Failure:** `failed` → clustering-failed UX (`data-testid="dashboard-clustering-failed"`)
      with a retry control; no hidden auto-retry.

## 3. Retry-default (Slice 10)

- [ ] Clicking retry (clustering-failed **or** error state) fires
      `POST /api/dashboard/refresh?profile=default`.
      Log: `[dashboard.refresh] user=<id> profileRequested=default profileEffective=default`.
- [ ] Retry clears JOIN state — `cold-start-progress` is gone after the click.
- [ ] Retry does **not** re-enter stale join polling (no further `refresh-status` calls).
- [ ] Before any retry, the onboarding first paint still uses the interactive path
      (`/api/dashboard/refresh?interactive=1`), not the default endpoint.

## 4. Timeout & terminal-error

- [ ] JOIN timeout: when the job never settles, polling stops at the 60s budget,
      a non-blocking warning toast shows, and the loader falls back to the normal path.
- [ ] Terminal HTTP short-circuit: a `403`/`404` from `refresh-status` ends JOIN
      **immediately** (single poll), warning toast + fallback — no full 60s wait.
      Log: `[dashboard.refresh-status] … result=forbidden` / `result=not_found`.

## 5. Evidence checklist

Capture for each run:

- **Logs:** `[onboarding.prefetch]`, `[dashboard.refresh-status]`,
  `[dashboard.refresh] profileRequested=default …`.
- **`_meta` fields:** `extractionStatus`, `refreshJobId` (settings save);
  `profile.name` (effective) and `profileRequested` (only when a gate fired) on refresh.
- **UI markers:** `cold-start-progress`, `dashboard-clustering-failed`,
  `dashboard-empty`, warning toast on timeout/short-circuit.
- **Notes:** phase sequence observed, terminal state, retry endpoint, pass/fail per §2–§4.
