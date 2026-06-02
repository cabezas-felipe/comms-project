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
