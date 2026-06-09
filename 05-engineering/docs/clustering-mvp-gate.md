# Clustering MVP readiness gate (operator checklist)

A pre-pilot manual gate for **clustering reliability**. Run it before you trust the dashboard for live work and gate clustering changes on it.

## When to run

Run this checklist when **either** is true:

- **Before pilot sessions** — confirm the dashboard reliably composes real meta-stories for an invited user before putting it in front of a participant.
- **Before merging a clustering-reliability change** — any PR that touches clustering, the refresh pipeline, prompts, or model/timeout config should pass this gate first.

This is a **live** gate: it exercises the real API + Supabase + provider path, not just hermetic unit tests. Budget ~10 minutes.

> **Background monitoring (not a substitute):** the `Cluster reliability nightly` GitHub Actions workflow runs the same reliability probe automatically every night and uploads the log + summary JSON ([README → Nightly clustering reliability workflow](../README.md#nightly-clustering-reliability-workflow-background-monitoring)). It catches drift between gate runs, but this manual gate is still **required** before pilots and before merging clustering-reliability changes.

## Prerequisites

- `apps/api/.env` populated: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and an Anthropic key (`TEMPO_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`).
- An invited test user with onboarding settings saved (think-tank blurb: topics economy / elections / Trump / Iran / inflation / gas; sources Washington Post + Reuters; geographies US / Iran).
- Optional clean slate: `npm run e2e:reset-user -- --email <your-invited-email>` (see the [Manual golden re-test](../README.md#manual-golden-re-test) section).

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

### 3. Run the live reliability probe (cold-start, recompute-enforced, `N=20`)

```sh
cd 05-engineering/apps/api
npm run cluster:probe -- --email <your-invited-email> --mode cold-start --require-recompute --runs 20 --cooldown-ms 3000 --base-url http://localhost:8787
```

`--email` is the preferred mode (uses `x-recognized-email`). This Step 4.1 command enforces a recompute-quality sample for cold-start latency and fails non-zero if that sample is insufficient (`SAMPLE-QUALITY FAIL`). Full usage: [Clustering reliability probe](../README.md#clustering-reliability-probe-live-gate).

### 4. Confirm thresholds

Read the probe's final summary JSON and the exit code:

- [ ] `successRate >= 0.95` (fraction of runs with `_meta.usedFallbackClustering === false`)
- [ ] `medianStories >= 2` (median `stories.length`)
- [ ] Probe process exited `0` (it fails non-zero if reliability thresholds are missed **or** recompute sample quality is insufficient)
- [ ] `recomputeTargetMet === true` in summary JSON (sample quality is decision-grade)
- [ ] `p95PipelineMs <= 90000` (90s) in cold-start mode — Step 4.1 hard perf gate (aligns to the `pipeline_slow` SLO threshold; see [refresh SLO runbook](runbook-refresh-slo.md))

**The four criteria above are the full GO/NO-GO gate — GO requires ALL of them.** `clusteringFailureSubtypes` is **diagnostics only** and never part of the pass/fail decision; you read it (next) only to *triage* a failing `successRate`.

#### Reading the subtype histogram (GO/NO-GO interpretation)

The summary JSON's `clusteringFailureSubtypes` splits the coarse `error` bucket into actionable classes (see [README → Failure subtype taxonomy](../README.md#dashboard-trust-controls-slice-1)):

- **GO sample** — `successRate >= 0.95` with `clusteringFailureSubtypes` empty (`{}`) or only a stray non-dominant entry. Record it; **do not** apply a fix (see the null-result note below).
- **NO-GO sample** — `successRate < 0.95`. Read the **dominant** subtype to decide the single fix:
  - `parse` → model output couldn't be parsed/validated → parse-resilience hardening.
  - `provider_request` → provider/transport fault (missing key, auth, rate-limit, overload, empty response) → one guarded provider/transport mitigation (and confirm the Anthropic key/quota first).
  - `timeout_budget` → clustering wall-clock budget exhausted → one budget-envelope adjustment (no cap broadening).
  - `unknown` → unattributable non-timeout failure → improve attribution for that signature first (or the smallest safe fallback for the exact observed pattern).

### 5. Manual golden-path sanity check

Quick eyeball on the live dashboard for the invited user (no `?debug=1` dependency required):

- [ ] Refresh completes without the **"Couldn't compose stories this refresh"** clustering-failed UI.
- [ ] **≥2 meta-stories** render with real titles — not `* Updates` / "General Updates" placeholder buckets.
- [ ] At least one **Washington Post or Reuters** item is visible in the stories.
- [ ] No obvious duplicate stack (e.g. a liveblog repeated as many near-identical stories).
- [ ] Story titles/subtitles read as English, coherent, and on-topic for the user's settings.

> For deeper inspection, the same outcomes are queryable in logs via the `[cluster-engine.obs]` line (`mode` / `result` / `errorClass`) and on `_meta` (`usedFallbackClustering`, `clusteringFailureReason`, `clusteringFailureSubtype`, `clusteringAttempts`) — the subtype is also surfaced on persisted `GET /api/dashboard` reads, so a thin/empty dashboard can be triaged without re-running the probe.

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
      - p95PipelineMs:      ____   (need <= 90000 in cold-start mode)
      - recomputeTargetMet: ____   (need true)
- [5] Manual golden sanity:            PASS / FAIL

Notes / risks:
- <anything noteworthy: flaky run, slow stage, provider hiccup, env quirk>
```

## If a gate fails — what next

**Quality gate (step 2) fails**
- Read which sub-check regressed (golden vs calibration). Re-run `npm run eval:dashboard-refresh-golden` alone to isolate a golden regression.
- A calibration/floor failure usually means a `DEFAULT_EMBED_MIN_SIMILARITY` or recall change — revisit the floor-change ship/no-ship policy in the README before touching defaults.

**`successRate < 0.95` (too many fallback runs)** — drive the fix off the **dominant subtype**, one fix at a time:
1. Inspect `clusteringFailureSubtypes` (finer than `clusteringFailureReasons`) and identify the **single dominant** subtype. If it's a tie or unclear, collect a larger decision-grade sample before acting.
2. Apply **exactly one** minimal-risk fix for that subtype only (see the per-subtype fix families under "Reading the subtype histogram" above). No bundled fixes; preserve fail-closed behavior; do not change gate thresholds.
3. **Re-run this strict gate** (step 3) to confirm the dominant subtype's incidence dropped and `successRate >= 0.95`, with no fail-closed regression.
- For deeper classification, grep server logs for `[cluster-engine.obs] ... result=fail` and read `errorClass` (`empty_response`, `no_json_region`, `schema_validation_error`, …).
- Confirm the Anthropic key is valid and not rate-limited (a `provider_request`-dominated histogram points here first).

> **Null-result discipline.** If a decision-grade sample shows **no failures** (`successRate` passes, `clusteringFailureSubtypes` empty), record the null result and signoff — **do not** apply a speculative fix. Changing behavior to address a failure mode that isn't occurring risks regressing a passing gate and is not attributable to evidence.

**`medianStories < 2` (thin output)**
- Likely upstream of clustering: check the invited user's settings actually saved (sources/topics present) and that ingestion has warm items. Confirm `_meta.selection` shows matched sources and a non-trivial `relevantItemCount`.
- Re-run `npm run e2e:reset-user` and re-seed onboarding if settings look empty, then re-probe.

**`p95PipelineMs` high (advisory)**
- Not blocking for PR A, but note it in signoff. Read `[pipeline.timings]` for the slow refresh to see which stage dominates (`clusterMs` → provider; `geoMs`/`recallMs` → upstream). See the [refresh SLO runbook](runbook-refresh-slo.md).

**Manual sanity fails but probe passed**
- A green probe with a bad-looking dashboard points at content quality (titles, grounding, dedup) rather than reliability. Capture the specific story and file it separately; it does not necessarily block the reliability gate, but record it under notes/risks.
