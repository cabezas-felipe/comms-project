# Clustering MVP readiness gate (operator checklist)

A pre-pilot manual gate for **clustering reliability**. Run it before you trust the dashboard for live work and gate clustering changes on it.

## When to run

Run this checklist when **either** is true:

- **Before pilot sessions** — confirm the dashboard reliably composes real meta-stories for an invited user before putting it in front of a participant.
- **Before merging a clustering-reliability change** — any PR that touches clustering, the refresh pipeline, prompts, or model/timeout config should pass this gate first.

This is a **live** gate: it exercises the real API + Supabase + provider path, not just hermetic unit tests. Budget ~10 minutes.

## Prerequisites

- `apps/api/.env` populated: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and an Anthropic key (`TEMPO_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`).
- An invited test user with onboarding settings saved (think-tank blurb: topics economy / elections / Trump / Iran / inflation / gas; sources Washington Post + Reuters; geographies US / Iran).
- Optional clean slate: `npm run reset:golden-user -- --email <your-invited-email>` (see the [Manual golden re-test](../README.md#manual-golden-re-test) section).

## Checklist

### 1. Start the API

```sh
cd 05-engineering && npm run dev
```

Wait for `@tempo/api listening on http://localhost:8787` before continuing. Keep this running in its own terminal.

### 2. Run the hermetic quality gate

In a second terminal:

```sh
cd 05-engineering/apps/api && npm run eval:dashboard-quality-gate
```

- [ ] Exits `0` (golden eval + calibration sweep both green). This is the offline regression guard — see [evals README → Dashboard Quality Gate](../apps/api/src/ai/evals/README.md#dashboard-quality-gate-slice-6).

### 3. Run the live reliability probe (defaults, `N=20`)

```sh
cd 05-engineering/apps/api
npm run cluster:probe -- --email <your-invited-email>
```

`--email` is the preferred mode (uses `x-recognized-email`). Full usage: [Clustering reliability probe](../README.md#clustering-reliability-probe-live-gate).

### 4. Confirm thresholds

Read the probe's final summary JSON and the exit code:

- [ ] `successRate >= 0.95` (fraction of runs with `_meta.usedFallbackClustering === false`)
- [ ] `medianStories >= 2` (median `stories.length`)
- [ ] Probe process exited `0` (it fails non-zero if either threshold is missed)
- [ ] **Advisory (PR A phase):** `p95PipelineMs <= 90000` (90s) — matches the `pipeline_slow` SLO breach threshold (`PIPELINE_SLOW_MS`, see [refresh SLO runbook](runbook-refresh-slo.md)). Cold-start has a tighter UX target (submit → first meta-story ≤ 45s, [cold-start spec](cold-start-v1.md)); for this phase `p95 <= 90s` is the gate-relevant reference and is **advisory, not blocking**.

### 5. Manual golden-path sanity check

Quick eyeball on the live dashboard for the invited user (no `?debug=1` dependency required):

- [ ] Refresh completes without the **"Couldn't compose stories this refresh"** clustering-failed UI.
- [ ] **≥2 meta-stories** render with real titles — not `* Updates` / "General Updates" placeholder buckets.
- [ ] At least one **Washington Post or Reuters** item is visible in the stories.
- [ ] No obvious duplicate stack (e.g. a liveblog repeated as many near-identical stories).
- [ ] Story titles/subtitles read as English, coherent, and on-topic for the user's settings.

> For deeper inspection, the same outcomes are queryable in logs via the `[cluster-engine.obs]` line (`mode` / `result` / `errorClass`) and on `_meta` (`usedFallbackClustering`, `clusteringFailureReason`, `clusteringAttempts`).

## Signoff template

Copy this block into the PR or pilot prep notes and fill it in:

```
Clustering MVP gate — signoff
- Date/time:        <YYYY-MM-DD HH:MM TZ>
- Operator:         <name>
- Branch / commit:  <branch> @ <short-sha>
- Test user:        <invited-email>

Results
- [1] API started:                    PASS / FAIL
- [2] eval:dashboard-quality-gate:     PASS / FAIL   (exit code: ___)
- [3/4] Live probe (N=20):             PASS / FAIL   (exit code: ___)
      - successRate:        ____   (need >= 0.95)
      - medianStories:      ____   (need >= 2)
      - p95PipelineMs:      ____   (advisory <= 90000)
- [5] Manual golden sanity:            PASS / FAIL

Notes / risks:
- <anything noteworthy: flaky run, slow stage, provider hiccup, env quirk>
```

## If a gate fails — what next

**Quality gate (step 2) fails**
- Read which sub-check regressed (golden vs calibration). Re-run `npm run eval:dashboard-refresh-golden` alone to isolate a golden regression.
- A calibration/floor failure usually means a `DEFAULT_EMBED_MIN_SIMILARITY` or recall change — revisit the floor-change ship/no-ship policy in the README before touching defaults.

**`successRate < 0.95` (too many fallback runs)**
- Inspect the probe's `clusteringFailureReasons` counts. `timeout`-dominated → provider latency or too-tight `TEMPO_AI_CLUSTER_TIMEOUT_MS`; `error`-dominated → parse/schema failures.
- Grep server logs for `[cluster-engine.obs] ... result=fail` and read `errorClass` (`empty_response`, `no_json_region`, `schema_validation_error`, …) to classify the failure mode.
- Confirm the Anthropic key is valid and not rate-limited.

**`medianStories < 2` (thin output)**
- Likely upstream of clustering: check the invited user's settings actually saved (sources/topics present) and that ingestion has warm items. Confirm `_meta.selection` shows matched sources and a non-trivial `relevantItemCount`.
- Re-run `npm run reset:golden-user` and re-seed onboarding if settings look empty, then re-probe.

**`p95PipelineMs` high (advisory)**
- Not blocking for PR A, but note it in signoff. Read `[pipeline.timings]` for the slow refresh to see which stage dominates (`clusterMs` → provider; `geoMs`/`recallMs` → upstream). See the [refresh SLO runbook](runbook-refresh-slo.md).

**Manual sanity fails but probe passed**
- A green probe with a bad-looking dashboard points at content quality (titles, grounding, dedup) rather than reliability. Capture the specific story and file it separately; it does not necessarily block the reliability gate, but record it under notes/risks.
