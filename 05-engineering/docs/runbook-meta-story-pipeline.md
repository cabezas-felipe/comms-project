# Runbook — Meta-story pipeline close-out (split-healer · overflow cap · deferred re-cluster)

Operator/dev close-out for the post-clustering meta-story work: the deterministic
**split-healer** ([`cluster-split-healer.mjs`](../apps/api/src/dashboard/cluster-split-healer.mjs)),
the **max-5 overflow cap**, the **deferred re-cluster** queue + executor
([`deferred-recluster.mjs`](../apps/api/src/dashboard/deferred-recluster.mjs)), and
the diagnostics that surface them. All of this is the deterministic layer that runs
**after** clustering inside [`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs);
no new LLM step is added by any of it.

Sections map to the implementation slices: **A** = split/English/cap, **B** =
deferred re-cluster, **C** = diagnostics + tests.

---

## 1. Pre-flight checklist

### Happy path — one-command E2E prep (strict identity + reset + gates)

```bash
cd 05-engineering
npm run e2e:prepare-user -- --user-id <userId> --email <email>
```

This is the primary path for a clean E2E run. It is **two-phase** (Phase 4 ·
Step 1) so the baseline can't be re-dirtied during setup:

1. Start the **API only** (`dev:api:clean` with
   `TEMPO_E2E_FORCE_FIRST_FULL_REFRESH=true` + `TEMPO_E2E_STRICT_IDENTITY=true`).
2. `e2e:reset-user`, then `e2e:assert-clean` (post-reset baseline — must pass).
3. **Baseline guard** — a *second* `assert-clean` re-check immediately before the
   web server starts. Web is **not** started until both cleanliness checks pass.
4. Start the **web** dev server, then `e2e:preflight` (`--require-web`,
   `--require-strict-identity`, `--require-web-identity-override`,
   `--identity-email <email>`).

If the guard fails (baseline went dirty between reset and browser startup), the
script exits non-zero with remediation text — almost always a stray
`localhost:8080` tab or dev process touching the user. Close all `:8080` tabs and
rerun. If any gate fails, stop and fix before testing.

After this passes, jump to §2 — the manual steps below are only a fallback. For
real-mode manual E2E execution, interpretation, and the gating policy, see
[Phase 4 E2E Unblock protocol](#phase-4-e2e-unblock-protocol-real-mode-manual-e2e).

### Manual fallback

Use the numbered steps below only if the one-command prep is unavailable or you
need to run a single step in isolation; they are the manual equivalents of what
`e2e:prepare-user` automates.

1. **Start both servers** from `05-engineering/`:
   ```bash
   npm run dev          # build:packages, then concurrently dev:api + dev:web
   # or run the halves separately:
   #   npm run dev:api   # node --watch apps/api/src/main.mjs  (port 8787)
   #   npm run dev:web   # vite dev server in ../04-prototype
   ```
2. **Confirm the API is reachable** (default `TEMPO_API_PORT=8787`, see
   [`main.mjs`](../apps/api/src/main.mjs)):
   ```bash
   curl -s localhost:8787/health        # GET /health → ok
   ```
3. **Reset the test user's state**.
   - **File-based dev path** (default data dir `./data`, override
     `TEMPO_DATA_DIR`). Replace `<userId>` with the run's user id (e.g. the
     `e06…` UX-test user):
   ```bash
   cd 05-engineering/apps/api
   rm -f data/dashboard_snapshot_<userId>.json \
         data/meta_story_locks_<userId>.json \
         data/geo_hold_bucket_<userId>.json \
         data/settings_user_<userId>.json
   ```
   (Narratives are Supabase-only — no file to delete on the local path.)
   - **Supabase-backed path** (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
     enabled): clear this user's rows from:
     - `settings` (`key = user:<userId>`, set `data` to `[]` for a fresh start)
     - `dashboard_snapshots`
     - `meta_story_locks`
     - `story_rejections`
     - `geo_hold_bucket`
     - `user_onboarding_narratives`
     Use your existing reset script/SQL for this repository's E2E flow.
4. **Clear prototype browser storage** (DevTools console on the app origin) so the
   client starts as a clean first-time identity / heartbeat:
   ```js
   localStorage.removeItem("tempo_proto_session");   // recognized identity
   localStorage.removeItem("tempo_did");             // analytics device id
   sessionStorage.removeItem("tempo_sid");           // analytics session id
   Object.keys(localStorage)
     .filter((k) => k.startsWith("tempo.settings.v1"))
     .forEach((k) => localStorage.removeItem(k));     // settings cache (global + per-user)
   ```
   For E2E identity routing, run the web app with:
   `VITE_E2E_IDENTITY_PRECEDENCE=recognized_email`.
5. **Local English E2E** — for a landing → dashboard run that turns the Spanish
   feeds into **English** stories, the translation stage must be live (it is a
   fail-open no-op otherwise — see [`.env.example`](../apps/api/.env.example)
   "Local E2E: Spanish feeds → English stories" and the
   [translation runbook](runbook-translation-activation.md)):
   - Activation is mode-driven: `TEMPO_TRANSLATION_MODE=auto` (the default)
     auto-activates the stage for Spanish feeds. Use `on` to force it; the
     legacy `TEMPO_TRANSLATION_ENABLED` still overrides if set.
   - `TEMPO_OPENAI_API_KEY=<key>` set **and** `TEMPO_AI_MOCK_ONLY` unset (a real
     `translateFn` is wired only on a non-mock box with a key).
   - **Restart the API after changing env** — these are read at process start,
     not per-request (`npm run dev:api`, or restart `npm run dev`).
   - **Verify in the API logs** on the next refresh:
     - `[pipeline.translation] mode=auto … enabled=true …` (the stage is on), and
     - when the candidate pool has Spanish items: `needed>0` **and** `translated>0`.
   - Mock-only / no-key → translation is a no-op; ES stories stay Spanish. This is
     **expected — not a clustering or split-healer regression** (the items simply
     passed through untranslated).

> **Known current limitation — Spanish election lexical recall.** Recall for
> Spanish election terms still depends on the translation stage being live: with
> translation off / mock-only / no key, Spanish-only election items can be missed
> because the keyword filter matches on normalized English evidence. Direct
> Spanish-lexeme recall (matching e.g. `elecciones` without translation) is not
> yet implemented — track expectations accordingly when reviewing an ES run.

---

## 2. Section A — expected outcomes (split / English / cap)

- **Dashboard ships 1–5 stories.** The post-healer **overflow cap** trims any
  excess deterministically (Q6-C survival rank: multi-source → beat-fit → freshness
  → `metaStoryId`). Upstream `0` stories (fail-closed clustering) stays `0` — the
  cap never fabricates.
- **Split-healer output is English when normalized evidence exists.** Split/bundled
  stories read `readHeadline` / `readBody`, so a translated ES cluster yields English
  `title` / `subtitle` / `summary`. With no normalization present, output falls back
  to the original text (safe).
- **Split triggers are tightened:** `disjoint_claim_evidence` splits high-confidence;
  `low_token_overlap` only acts on **normalized English** evidence; ambiguous
  non-English over-merges are **deferred (flagged), not atomized**.
- **Overflow cap diagnostics are available** on `_meta.overflowCap` whenever the cap
  ran (see §4).

## 3. Section B — expected outcomes (deferred re-cluster)

- **`reclusterQueue` appears when ambiguous candidates exist.** B1 scores the A3
  `_reclusterCandidate` flags and emits a ranked, deduped queue (top **2**) on
  `_meta.reclusterQueue` / `reclusterQueueCount`.
- **The deferred executor runs bounded:** after the fast snapshot write,
  fire-and-forget, **≤2 candidates, sequentially, 45s timeout each**. It re-clusters
  only each candidate's source set and grounds the result with the existing pipeline
  grounding.
- **Patching is in place:** a successful + grounded re-cluster replaces only the
  affected story slot(s); the result is still bounded by the max-5 cap. On
  **failure / timeout / invalid / stale generation** the Phase-1 snapshot is left
  unchanged (no dashboard blanking). Outcomes land on `_meta.reclusterExecution`
  on the **next** dashboard read (it runs after the immediate refresh response).

---

## 4. Debug checks (`?debug=1`)

Open the dashboard with `?debug=1` (or set `VITE_UX_TEST_MODE=true`); the
[`DashboardRunDiagnostics`](../../04-prototype/src/components/DashboardRunDiagnostics.tsx)
panel renders (gating: `debugMode = isUxTestMode || searchParams.get("debug") === "1"`).
Inspect these three rows (parsed from the API `_meta`):

| Row (`data-testid`) | Reads | Healthy | Needs attention |
|---|---|---|---|
| **`split/defer:`** (`diag-cluster-split`) | `_meta.clusterSplit` — `in/out`, `splits=(reasons)`, `bundled`, `deferred=(deferReasons)`, `candidates=[ids]` | a few or zero splits; occasional `deferred` with candidate ids listed | every refresh atomizing many splits, or large `deferred` with no follow-up re-cluster resolution |
| **`overflow_cap:`** (`diag-overflow-cap`) | `_meta.overflowCap` | `not_applied (in=N out=N)` with `N≤5` is the normal path | `applied … dropped=K [ids]` **frequently** ⇒ clustering over-producing upstream; confirm the dropped ids are the lowest-ranked |
| **`recluster:`** (`diag-recluster`) | `_meta.reclusterExecution` (falls back to the B1 queued count) | `n/a` (no queue), `pending queued=N` right after a refresh, or `status=completed` on the next read | `status=failed` / `partial_failure` repeatedly, or `pending queued=N` that never resolves to a status (executor not running) |

`status` enum: `noop` · `completed` · `partial_failure` · `failed`.
Per-candidate `outcome` enum: `confirmed` · `split` · `timeout` · `error` · `empty` · `ungrounded` · `not_found`.

The same blocks are available without the UI via the API:
```bash
curl -s localhost:8787/api/dashboard -H "Authorization: Bearer <token>" \
  | jq '._meta | {clusterSplit, overflowCap, reclusterQueueCount, reclusterExecution}'
```

---

## 5. Rollback / safety levers (already in code — no deploy needed)

| Lever | Env knob | Default | Effect when toggled |
|---|---|---|---|
| **Split-healer off** | `TEMPO_CLUSTER_SPLIT_HEALER_ENABLED=false` | `true` | Over-merges are NOT split — a multi-topic cluster ships as one story; no defer flags, so the re-cluster queue stays empty. Instant rollback for any split/defer regression. |
| **Split sensitivity** | `TEMPO_CLUSTER_SPLIT_JACCARD_THRESHOLD` | `0.15` | Higher → splits less (more tolerant of overlap); lower → splits more aggressively. Tune before disabling outright. |
| **Translation mode** | `TEMPO_TRANSLATION_MODE=auto\|on\|off` | `auto` (legacy `TEMPO_TRANSLATION_ENABLED` overrides) | `off` disables ES normalization and can narrow recall for English keywords; `auto` activates only when non-English evidence is present; `on` forces translation attempts always. See the [translation runbook](runbook-translation-activation.md). |
| **Force mocks** | `TEMPO_AI_MOCK_ONLY=true` | unset | All live LLM calls (incl. the production `translateFn`) become deterministic mocks/no-ops; the deferred re-cluster uses the mock cluster path. Use for local/CI determinism. |

The deferred re-cluster executor has **no kill-switch of its own** — it only acts when
`reclusterQueue` is non-empty, and disabling the split-healer (above) empties that
queue, which is the de-facto off switch for Section B.

---

## 6. Test / verification snippet

```bash
cd 05-engineering

# Targeted API tests for this work (fast, hermetic — no providers/network):
npm run test --workspace=@tempo/api -- src/dashboard/refresh-pipeline.test.mjs
npm run test --workspace=@tempo/api -- src/dashboard/cluster-split-healer.test.mjs
npm run test --workspace=@tempo/api -- src/dashboard/deferred-recluster.test.mjs
npm run test --workspace=@tempo/api -- src/server.routes.test.mjs
npm run test --workspace=@tempo/api -- src/db/dashboard-snapshot-repo.test.mjs

# Optional prototype tests (parser + debug panel):
npm --prefix ../04-prototype test    # vitest run

# Full API suite (close-out gate):
npm run test --workspace=@tempo/api
```

---

## One clean E2E pass (Spanish reset scenario)

1. Reset user `<userId>` files + browser storage (§1.3–§1.4).
2. Ensure Spanish E2E env is live (§1.5): `TEMPO_TRANSLATION_MODE=auto`,
   `TEMPO_OPENAI_API_KEY` set, `TEMPO_AI_MOCK_ONLY` unset. Start `npm run dev`.
3. Onboard the user with a bilateral (ES/EN) beat, land on the dashboard, then open
   it with `?debug=1`.
4. Expect: **1–5** stories, English titles/subtitles even for Spanish sources, and:
   - `split/defer:` shows any over-merges split into English stories (or `deferred`
     for ambiguous ES with `candidates=[…]`),
   - `overflow_cap:` `not_applied` for ≤5 (or `applied … dropped=[…]` if clustering
     produced >5),
   - `recluster:` `pending queued=N` immediately, resolving to `status=completed`
     (or `noop`) on the next refresh/read.
5. If anything looks wrong, pull `_meta` via the `curl | jq` line in §4 and use the
   §5 levers to roll back the suspect stage.

### E2E success checklist (English run)

A landing → onboarding → dashboard pass is **green** when all of the following hold
(after the reset in §1.3–§1.4 and the env in §1.5):

- [ ] **1–5 stories visible** on the dashboard (never 0 for a populated beat; never >5).
- [ ] **Story titles and subtitles are in English**, even when the underlying
      sources are Spanish.
- [ ] API logs show `[pipeline.translation] mode=auto … enabled=true` and, when ES
      items were in the pool, `needed>0 translated>0` (per §1.5).
- [ ] **No** `[dashboard.get] … failed schema validation … returning empty` line in
      the API logs (that line means the snapshot fail-closed on read — investigate the
      persisted payload, e.g. an invalid `sources[].kind`).

If stories render but titles are **Spanish**, re-check §1.5: translation is almost
certainly off / mock-only / missing a key — that is expected behavior, not a
clustering or split-healer regression.

---

## Phase 4 E2E Unblock protocol (real-mode manual E2E)

Real-mode E2E (live providers, real refresh) is **manual-required** for this
phase: run it locally and sign off before merge. It is **not** a required PR
status check (see [Gating policy](#gating-policy) below). This section is the
operational contract for running it and reading the result.

### Two-phase prep + baseline guard

`e2e:prepare-user` is two-phase (see [§1](#happy-path--one-command-e2e-prep-strict-identity--reset--gates)):
API-only → reset → assert-clean → **baseline guard re-check** → web → preflight.
The guard exists because an active session hitting the dashboard *during* prep
can re-write rows between reset and the browser step, leaving a baseline that
looked clean at reset time. Web never starts until **both** cleanliness checks
pass; a guard failure is fail-fast with remediation text.

### Pre-run checks (do not skip)

- [ ] **Single active web session.** Exactly one `localhost:8080` tab for the
      whole run — no other tabs or stray dev servers on `:8080`. `prepare-user`
      warns if it sees a process already on `:8080`; heed it.
- [ ] **Clean baseline asserted.** `e2e:assert-clean` PASSes *before* any browser
      step (the guard enforces this, but verify the PASS line in the output).
- [ ] **Strict identity wired.** `prepare-user` preflight is green
      (`--require-strict-identity`, `--require-web-identity-override`).
- [ ] **Real providers (if testing real-mode behavior).** `TEMPO_AI_MOCK_ONLY`
      unset and the relevant key(s) set (e.g. `TEMPO_OPENAI_API_KEY` for ES→EN
      translation, per [§1 Pre-flight checklist](#1-pre-flight-checklist)). Mock-only is fine for
      flow checks but won't exercise real clustering/translation.

### Command sequence (copy-paste)

```bash
cd 05-engineering

# 1. Two-phase prep + baseline guard + preflight (one command)
npm run e2e:prepare-user -- --user-id <uuid> --email <email>

# 2. Re-confirm the baseline PASS (pre-run only; expected to fail AFTER onboarding)
npm run e2e:assert-clean --workspace=@tempo/api -- --user-id <uuid>

# 3. Drive the journey in ONE browser tab:
#      http://localhost:8080/  → enter <email> → expect /onboarding (clean user)
#      submit onboarding → land on dashboard → open dashboard with ?debug=1

# 4. Read the refresh fail-safe contract straight from the API (recognized-email
#    identity, matching the E2E web override):
curl -s -X POST localhost:8787/api/dashboard/refresh \
  -H "x-recognized-email: <email>" \
  | jq '._meta | {refreshStatus, refreshFailure, usedPriorSnapshot, hasSnapshot}'

# 5. Confirm the journey wrote its expected state (NOT a cleanliness check)
#    user_onboarding_narratives >= 1, settings >= 1, dashboard_snapshots >= 1
```

In the UI, the `?debug=1` panel's **`refresh:`** row (`diag-refr`) shows the same
fields (`status=ok|failed`, and on failure `reason / subtype / attempts /
retryable`, plus `usedPriorSnapshot`) — see
[`DashboardRunDiagnostics`](../../04-prototype/src/components/DashboardRunDiagnostics.tsx).

### Result interpretation matrix

The key distinction the [refresh fail-safe contract](../apps/api/src/server.mjs)
makes: **0 stories is not automatically a failure.** Read `_meta.refreshStatus`
first, then the story count.

| Outcome | `_meta` signal | Stories | UI surface | Read it as |
|---|---|---|---|---|
| **Pass / Healthy** | `refreshStatus=ok`, `refreshFailure=null` | ≥1 (populated beat) | story list (debug rows coherent) | Green — done. |
| **Neutral Expected (quiet)** | `refreshStatus=ok`, `refreshFailure=null` | 0 | quiet empty — "No stories yet." (`dashboard-empty`) | Healthy quiet window: feeds simply published nothing on-beat. **Not** a failure. |
| **Actionable Fail** | `refreshStatus=failed`, `refreshFailure` present | 0, **or** prior stories when `usedPriorSnapshot=true` | failure-aware empty (`dashboard-refresh-failed`) **or** stories + warning banner (`dashboard-refresh-banner`) | Refresh failed (parse / timeout / provider). Investigate via the debugging checklist. |
| **Execution Error** | non-200 (e.g. `500`) with no `_meta`, **or** a `prepare-user`/preflight gate failure | n/a | full error state / no run | Code/config/infra problem — not a feed-window artifact. Fix before re-running. |

### Debugging checklist (failed refresh)

Work top-down — the contract is designed so each field narrows the cause:

1. **`_meta.refreshStatus`** — `ok` means the backend is healthy; if the UI still
   looks wrong, it's a **stale UI/session issue**, not a refresh failure (jump to
   the stale-state checks below). `failed` means a genuine backend fail-safe
   response — continue.
2. **`_meta.refreshFailure`**:
   - `reason` — `clustering_failure` (the model stage failed closed) vs
     `pipeline_exception` (the refresh threw and a prior snapshot was served).
   - `subtype` — `parse` (model emitted unparseable output — usually
     deterministic, **`retryable=false`**), `timeout` / `provider_request`
     (transient — **`retryable=true`**, retry is reasonable), `unknown`.
   - `attempts` — always **≥1** on a failure; repeated high attempts point at a
     persistent provider/timeout issue, not a one-off blip.
   - `retryable` — `true` → re-run the refresh; `false` → don't hot-loop, capture
     the run and investigate the model/prompt path.
3. **`_meta.usedPriorSnapshot`** — `true` means the user is seeing **preserved
   prior stories** under a warning banner (the refresh failed but continuity was
   kept); `false` means there was nothing to fall back to (empty failure state).
4. **Differentiate stale UI/session from a backend fail-safe response.** If the
   **API** `curl` shows `refreshStatus=ok` but the **browser** looks stale/empty,
   it is a client-state problem, not a backend failure:
   - Multiple tabs / concurrent sessions open against the same user → close to one.
   - Stale `localStorage` refresh timestamp
     (`tempo_dashboard_last_refresh_attempt_at:<userId>`) → clear it (see
     [first-time browser hygiene](#first-time--colombia-election-manual-e2e)).
   - Re-fetch with the `curl` line above to compare API truth vs. on-screen state.

### Gating policy

- **Required (manual):** a real-mode manual E2E **signoff before merging this
  phase** — run the command sequence above and confirm the result lands in
  *Pass/Healthy* or *Neutral Expected*. Capture the `_meta` fail-safe block (and
  the `?debug=1` rows) in the PR/review notes as evidence.
- **Optional (advisory):** a **nightly advisory smoke** job (e.g. the
  [Live Colombia-election smoke](#live-colombia-election-smoke-advisory)) may run
  on a schedule. It is informational only.
- **Not a PR status check.** Real-mode E2E and the nightly advisory are
  **deliberately excluded** from required PR checks — those remain the two
  hermetic gates
  ([`api-quality-gate.yml`](../../.github/workflows/api-quality-gate.yml),
  [`relevance-path-gate.yml`](../../.github/workflows/relevance-path-gate.yml)).
  Live/real-mode variability must never block a merge; escalate a genuine
  *Actionable Fail* or *Execution Error* instead.

---

## First-time / Colombia-election manual E2E

The canonical manual pass for validating a **clean first-time journey** end to end:
prepared user → onboarding (not dashboard) → on-beat Colombia-election stories. Run
the steps in order; do not skip the pre-run `assert-clean` baseline — it is what
makes the run trustworthy.

1. **Prepare clean user + local stack**
   ```bash
   cd 05-engineering
   npm run e2e:prepare-user -- --user-id <uuid> --email <email>
   ```

2. **Assert baseline is clean** — must **PASS before any browser step**:
   ```bash
   npm run e2e:assert-clean --workspace=@tempo/api -- --user-id <uuid>
   ```
   If it fails, the user is not clean; fix state and re-run before continuing.
   > **`e2e:assert-clean` is pre-run only** — it is a zero-footprint baseline check.
   > After onboarding writes rows it is *expected* to fail, so never use it as a
   > post-run success criterion (see step 6).

3. **Browser hygiene**
   - Use a **single browser tab/session** for the whole run — no concurrent tabs.
   - If you are **not** on the `prepare-user` clean profile, clear the per-user
     refresh timestamp from local storage (DevTools console on the app origin):
     ```js
     localStorage.removeItem("tempo_dashboard_last_refresh_attempt_at:<userId>");
     ```
   - **Stale `localStorage` invalidates the first-time checks** — a lingering
     refresh timestamp makes a clean user look like a returning one.

4. **First-time journey validation**
   - Open `http://localhost:8080/`.
   - Enter the email for the prepared user.
   - **Expected route: `/onboarding`** (NOT `/dashboard`) for a clean user. Landing
     straight on the dashboard means the user was not actually first-time — go back
     to step 2.
   - Submit an onboarding narrative mentioning **Colombia elections + Semana**.

5. **Dashboard validation**
   - Open the dashboard with `?debug=1`.
   - Verify the diagnostics rows render and are **meaningful** —
     selection / funnel / overflow / cap where present (see §4 for how to read
     `split/defer:`, `overflow_cap:`, `recluster:`).
   - Confirm stories are **on-beat (Colombia election)** and not weather / volcano
     noise.

6. **Post-run state capture**
   - Do **not** re-run `e2e:assert-clean` here — a valid run writes rows, so the
     baseline check is *expected* to fail and is not a success signal.
   - Instead, confirm the run wrote the expected artifacts for `<userId>`:
     - `user_onboarding_narratives >= 1` (onboarding persisted)
     - `settings >= 1` (user settings written)
     - `dashboard_snapshots >= 1` (after the refresh completes)
   - This is a sanity check that the journey produced its expected state — not a
     cleanliness check.

### Invalid run conditions

A run does **not** count if any of these were true during it:

- **Partial DB reset *before* the run** — only some tables cleared at baseline,
  especially a lingering `public.settings` row, so step 2's `assert-clean` never
  truly passed. (This is about the pre-run baseline; rows written *during* a valid
  run are expected — see step 6.)
- **Multiple tabs or concurrent sessions** open against the same user mid-run.
- **Stale `localStorage`** refresh timestamp
  (`tempo_dashboard_last_refresh_attempt_at:<userId>`) left over from a prior run.

### Required companion checks

- **Dashboard quality gate** — run alongside the manual pass to confirm story
  quality programmatically:
  ```bash
  npm run eval:dashboard-quality-gate --workspace=@tempo/api
  ```
- **Clustering MVP gate** — see [`clustering-mvp-gate.md`](clustering-mvp-gate.md)
  for the clustering-side acceptance bar referenced by the broader pipeline gates.

---

## Live Colombia-election smoke (advisory)

A single, trustworthy **manual confidence check** that the dashboard relevance
behavior still holds on **live feed data**. It complements the hermetic evals:
those prove the pipeline on fixed fixtures; this one runs the same relevance
pipeline over the live RSS pool the dashboard refresh actually consumes.

- **Purpose** — catch a relevance regression that only shows up on live-shaped
  data (unexpected geo signal, the cap not biting, Decision 5C ordering
  inverting) without waiting for a user to notice.
- **Scope** — validates the live pool + relevance gates (recall, geo precision,
  C1 cluster-input cap, A4 overflow / thin-on-beat geo-noise guard, Decision 5C
  ordering). It is **not** a deterministic product verdict — the verdict depends
  on whatever the feeds carry right now.
- **Non-blocking** — **advisory**, never a required CI gate. Only the live
  *fetch* is non-deterministic; everything downstream is deterministic and
  provider-free (lexical recall + a deterministic cluster stub, **no LLM /
  embedding spend**). See
  [`dashboard-live-colombia-election-core.mjs`](../apps/api/src/ai/evals/dashboard-live-colombia-election-core.mjs)
  and the eval [README](../apps/api/src/ai/evals/README.md).

### Prerequisites

```bash
# 1. Ensure you are on the intended branch with up-to-date code

# 2. Install deps in the engineering workspace
cd 05-engineering
npm ci          # or `npm install`
```

- Run all commands from `05-engineering` (the workspace root).
- **No provider key required.** `eval:dashboard-live-colombia-election` runs the
  relevance pipeline in lexical (`keyword`) recall with a deterministic cluster
  stub — it never calls Anthropic / OpenAI / an embedding provider, so missing
  keys / `TEMPO_AI_MOCK_ONLY` are irrelevant to it.
- The only live dependency is **outbound network** to fetch RSS (the production
  `readFeedItems` live path). A network blip surfaces as a failing *check*, not a
  crash (see "Execution error" below).
- Live data dir defaults to `apps/api/data` (override with `TEMPO_DATA_DIR`).

### Commands (copy-paste runnable)

```bash
cd 05-engineering

# 1. Targeted relevance tests (fast, hermetic — the four relevance suites only)
npm run test:relevance-path --workspace=@tempo/api

# 2. Hermetic acceptance eval (fixed fixture — deterministic verdict)
npm run eval:dashboard-elections-colombia --workspace=@tempo/api

# 3. Live advisory smoke (non-hermetic; exit 0 unless a true execution error)
npm run eval:dashboard-live-colombia-election --workspace=@tempo/api

# 4. Optional — same run, also writing a JSON artifact under apps/api/.artifacts/
npm run eval:dashboard-live-colombia-election:json --workspace=@tempo/api
```

Optional **strict** mode (opt-in gate — non-zero exit on any failed check; use
for an on-demand confidence run when election coverage is known to be live):

```bash
npm run eval:dashboard-live-colombia-election --workspace=@tempo/api -- --strict
```

### How to interpret outcomes

| Outcome | What you see | Read it as |
| --- | --- | --- |
| **Pass / healthy** | `status: OK`, election signal present, checks pass, cap/overflow/5C diagnostics coherent | Live relevance behavior holds — done. |
| **Neutral expected** | one or more checks marked `•`/"neutral" — "cap not exercised", "overflow not exercised", or 5C "not observable in this run" | Normal in a small or quiet window; the scenario simply isn't present. Not a failure. |
| **Actionable fail** | election presence missing across **repeated** windows, incoherent cap diagnostics (clusterInput ≠ cap, drop math off), or a real Decision 5C inversion (configured-geo survives the cap *worse* than cross-country) | Investigate — likely a relevance regression. Follow the escalation path. |
| **Execution error** | `EXECUTION ERROR — …` (pipeline crash / bad config) — exit 1 even in advisory mode | Treat separately from live variability — it's a code/config problem, not a feed-window artifact. |

> A single advisory run printing failed checks **still exits 0** — failures are
> printed for a human, not to gate CI. Only `--strict` (or a true execution
> error) yields a non-zero exit.

### Repeatability (reduce false alarms)

- **Run it 2–3 times across a wider time window** before escalating — live
  windows are noisy, and "no Colombia election coverage right now" is a real,
  non-regression state.
- **Compare against a recent known-good run / artifact** (the `:json` output) —
  look for a *change* in cap coherence or 5C survival rate, not just an absolute
  miss.
- **When escalating, capture evidence**: the full console output **and** the JSON
  artifact (`apps/api/.artifacts/dashboard-live-colombia-election.json`).

### Escalation path (when live smoke looks bad)

1. **Re-run the hermetic acceptance eval** —
   `npm run eval:dashboard-elections-colombia --workspace=@tempo/api`.
2. **Re-run the targeted relevance tests** —
   `npm run test:relevance-path --workspace=@tempo/api`.
3. **Hermetic PASSES but live stays suspect** → log it as a **live-drift
   investigation** (Phase 4.1 input), attaching the captured output + JSON
   artifact. Do **not** block merge on live variability alone.
4. **Hermetic FAILS** → treat as a **regression**: block the merge and fix the
   pipeline before shipping.

### CI context

Two complementary PR gates back this up — the live smoke is intentionally **not**
one of them:

- [`api-quality-gate.yml`](../../.github/workflows/api-quality-gate.yml) — broad
  gate; full api suite + critical suite + hermetic `eval:dashboard-quality-gate`
  on any `05-engineering/**` change.
- [`relevance-path-gate.yml`](../../.github/workflows/relevance-path-gate.yml) —
  narrow, path-filtered relevance gate (`test:relevance-path` +
  `eval:dashboard-elections-colombia`) that also fires on `04-prototype/**`
  relevance surfaces.

The live `eval:dashboard-live-colombia-election` is **advisory by design** and is
deliberately excluded from both required PR checks — run it manually (this
section) or on a schedule.

---

_Canonical behavior sources live in the modules linked above; this runbook is the
operational index, not the spec. Related: [cold-start spec](cold-start-v1.md),
[refresh SLO runbook](runbook-refresh-slo.md), [translation runbook](runbook-translation-activation.md)._
