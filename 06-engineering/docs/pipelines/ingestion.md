# Ingestion — pipeline / runtime SoT

> **Stage:** Ingestion · **Status:** Locked (B1) · **Last updated:** 2 Nov 2026 (MVP carry-over)  
> **Altitude:** Engineer pipeline SoT (pre-runtime). Product rules live in the [contract](../../../02-product/contracts/ingestion.md) — this file owns jobs, triggers, sequences, data binds, failure matrix, and observability pointers. No LLM prompt or gold ownership.

**Related**

- Product contract: [ingestion.md](../../../02-product/contracts/ingestion.md) (locked)
- Vendors: [api-newsapi-ai.md](../api-newsapi-ai.md) · [api-x.md](../api-x.md)
- Invoke targets: [summarization.md](./summarization.md) ([contract](../../../02-product/contracts/summarization.md)) · [story-tagging.md](./story-tagging.md) ([contract](../../../02-product/contracts/story-tagging.md)) · [metastory.md](./metastory.md) ([contract](../../../02-product/contracts/metastory.md))
- UX triggers: [onboarding--v1.md](../../../02-product/prds/onboarding--v1.md) · [account--v1.md](../../../02-product/prds/account--v1.md)
- Feed join / cutover UX: [dashboard--v1.md](../../../02-product/prds/dashboard--v1.md)
- Data: [tempo.dbml](../data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Ops pricing: [07-ops/README.md](../../../07-ops/README.md) · [ingestion-pricing.json](../../../07-ops/ingestion-pricing.json) · [ingestion-pricing.md](../../../07-ops/ingestion-pricing.md) (sibling to [model-pricing.md](../../../07-ops/model-pricing.md))
- Pattern: stage pipelines live at `06-engineering/docs/pipelines/{stage}.md`

---

## 1. Purpose

Orchestrate **when** shared-pool ingestion runs, **how** clock / warm / IR-14 jobs sequence, **admit** + same-tick consumer barriers, and **what** we observe for ops cost — without owning article-summary or story-chip prompts/gold, metastory writer logic, dashboard join UX, or Database library column definitions.

---

## 2. Jobs and triggers

Three Tempo jobs (modular monolith). User join/personalization recompute is a **signal** from warm/clock handoff — not a fourth ingestion job.

| Job | Cadence / trigger | Does |
|-----|-------------------|------|
| **Shared clock** | Every hour at **`:00`** | Union aperture → NewsAPI two drains + X lanes → admits → **compliance** (IR-07) |
| **Warm** | UX event (below) | Widen → shared fetch + admits + ensure user recompute; narrow/unchanged → **recompute only** (no shared fetch, no compliance) |
| **X edit re-read** | Every **15 min** at **`:10 / :25 / :40 / :55`** | IR-14 Get posts by ids → text replace → story-tagging re-invoke on change |

### 2.1 Warm UX map

Warm runs **after successful scope commit** on Account paths; onboarding Start / o05e re-trigger warm per PRD.

| Surface | CTA | Ingestion |
|---------|-----|-----------|
| **o05** | Start monitoring → | Warm trigger accepted → **always widen** + shared fetch |
| **o05e** | Try again → | Re-trigger warm (ensure/restart) |
| **a02a / a02g** (Tags) · **a03a / a03f** (Context) | Save | After **successful scope commit** → widen diff → shared fetch if widen; always ensure that user’s recompute |
| **a02i** (Tags) · **a03g** (Context) | Try again | After **successful scope commit** (recover) → same as Save |

Unchanged sign-in: last-good feed until clock ([dashboard](../../../02-product/prds/dashboard--v1.md) · IR-10). Screens/copy → PRDs / Paper — not duplicated here.

### 2.2 Widen vs narrow (Item 2)

Compare previous vs next **live confirmed** aperture: traditional `sourceUri`, topic/geo `conceptUri`, keyword string, X handle, `fetch_mode`.

- **Widen:** any add, or any `fetch_mode` change, or Start monitoring → shared fetch + user recompute  
- **Narrow / unchanged:** removals only or no set change → **no** shared fetch; still ensure user recompute; **no** pool GC (IR-16)

Union aperture contributors: **all accounts with live confirmed scope** (IR-01).

---

## 3. Shared-fetch tick sequence

Applies to **clock** and **warm-on-widen** (not IR-14).

```mermaid
flowchart TD
  aperture[Build_union_aperture]
  drains[NewsAPI_two_drains_parallel]
  xlanes[X_fetch_mode_lanes_parallel]
  admit[Per_item_IR15_admit_or_noop]
  compliance[Compliance_IR07_clock_only]
  recompute[Ensure_user_recompute_signal]
  aperture --> drains
  aperture --> xlanes
  drains --> admit
  xlanes --> admit
  admit --> compliance
  admit --> recompute
  compliance -.->|warm_skip| recompute
```

| Step | Rule |
|------|------|
| 1. Aperture | Union of live confirmed scopes |
| 2. Vendors | Two NewsAPI Stream drains (concepts \| keywords); X `word_search` / `post_download` by `fetch_mode`; lane-fail → degrade that lane |
| 3. Per item | IR-15: new admit / resurrect → §4; active duplicate → no-op |
| 4. Compliance | **Clock only**, after fetch/admit; fail → keep pool; retry next `:00` |
| 5. Warm | Steps 1–3 + user recompute; **no** compliance |

Empty aperture → no vendor fetch; no invented scope.

---

## 4. Per-admit path and body custody

**New admit** = first active pool membership for press `uri` / X post id, or soft-removed **resurrect**.

### Press (body present)

1. Persist keep-list **first** (no body)  
2. Fan-out same-tick consumers (**order flexible / parallel OK**): summarization (if invoked) · story-tagging · metastory handoff (including same-tick **what-happened** when that path reads body — [MR-08](../../../02-product/contracts/metastory.md) / [IR-05](../../../02-product/contracts/ingestion.md))  
3. **Barrier** — wait for each **invoked** consumer’s terminal signal (success \| fail-open \| skip). Skip counts as terminal — including summarization skip when `article_summary` already present ([SR-05](../../../02-product/contracts/summarization.md))  
4. Discard body only after the barrier (never store/log/show)  

### Press (no body)

Persist → **skip** summarization → story-tagging (title only) → metastory → nothing to discard.

### X

Persist keep-list (`text` is the record) → story-tagging on `text` → metastory (no summarization).

### Active duplicate (IR-15)

No summarization, no story-tagging, no metastory-admit; **no** MVP keep-list metadata refresh.

Every new admit is handed to metastory **same tick**, including zero chips / tagging failure (chips gate **feed join**, not clustering).

---

## 5. AI invoke boundaries

Ingestion **orchestrates** only. Sibling stages own prompts, retries (≤2), and column writes.

| Target | Passes | Waits for | Target must not |
|--------|--------|-----------|-----------------|
| **Summarization** | `story_id`, `uri`, title, body in memory, `trigger_kind` (`clock` \| `warm`). Stage **mints its own** `trigger_id` for `summarization_runs` / `summarization_invoke` — not shared with story-tagging or metastory | success \| fail \| skip (**no body**, or `article_summary` already present incl. resurrect — [SR-05](../../../02-product/contracts/summarization.md)) | Discard body alone; invent summary; store/log body |
| **Story-tagging** | `story_id`, kind, text (title+body \| title \| X text), `trigger_kind` (`clock` \| `warm` \| `x_edit`). Stage **mints its own** `trigger_id` for `story_tagging_runs` / `story_tagging_invoke` | success \| fail \| skip (empty aperture) | Invent chips; discard body. Mark disposition: **admit** final fail → no new marks; **IR-14** final fail → empty replace-set ([ST-06](../../../02-product/contracts/story-tagging.md)); empty aperture → empty replace-set ([ST-15](../../../02-product/contracts/story-tagging.md)) |
| **Metastory** | Admitted `story_id`(s); body handle if still in memory (writer optional `same_tick_body` — [MR-08](../../../02-product/contracts/metastory.md) / [D-107](../../DECISIONS.md); boundary body-free); tick / job correlation id (orchestrator-owned — not an LLM-stage `trigger_id`). Boundary/writer each mint their own LLM `trigger_id` | Handoff completion (incl. same-tick what-happened when used) / degrade for **this** handoff | Discard body (orchestrator owns after barrier — [IR-05](../../../02-product/contracts/ingestion.md)); invent chips; fail the pool tick on handoff degrade |

Sibling **writes** (`article_summary`, `story_*`, metastory tables) are owned by those stages — ingestion does not write them.

**`trigger_id` spine:** each LLM stage mints a new UUID when it enters the generate path (shared by ≤2 attempts). Ingestion does **not** assign one shared UUID across summarization + story-tagging + metastory for the same admit. Metastory boundary and writer each mint their own `trigger_id` (do not reuse across `call_kind`). Post-join **personalization** also stage-mints its own `trigger_id` (not shared with admit-tick LLMs). Correlate same-tick work via `story_id` + clock/warm job, not a cross-stage `trigger_id`.

---

## 6. IR-14 (edit re-read)

| Lock | Value |
|------|--------|
| Cadence | `:10 / :25 / :40 / :55` (clear of clock `:00`) |
| Eligibility | `x_posts` with `published_at` still inside ~**30‑min** vendor edit window |
| Call | Chunked `Get posts by ids`; upsert `text` when changed → re-invoke story-tagging |
| Cap | **No MVP $-cap**; window + chunking only; fail-open keep prior text |
| Pricing | Usage facts → PostHog; $ in daily digest (§9) |

---

## 6.1 Vendor HTTP + aperture (MVP carry-over)

| Lock | Value |
|------|--------|
| Press + X runtime | **NewsAPI.ai Stream + X** only — RSS feed-reader, manifest allowlists, and `ingestion_recent_items` cache-warmer are **not** live product ingestion paths (legacy / quarantine until deleted) |
| Story identity | Press **`uri`** / X **post id** only — **no** cross-URL/headline deduper on top of vendor identity |
| X aperture | Handles + `fetch_mode` from **live confirmed scope union** only; env may gate client on/off + credentials — **not** which handles belong in the pool |
| Per-request timeout | **12000** ms default (env-overridable); NewsAPI uses the same unless vendor docs force otherwise |
| X handle concurrency | **3** parallel handles default (env-overridable) |
| Not this stage | `source-matcher`, `embedding-recall`, `evidence-translator` (and similar as-is personalization/recall under `ingestion/`) — **out** of Tempo ingestion SoT; join/personalization owns per-user selection |

---

## 7. Data map (existing tables only)

Field-level SoT: [tempo.dbml](../data/tempo.dbml) / [Database library](https://dbdiagram.io/d/Database-library-6ab4852e58694256127b2a37). Pipeline does **not** redefine columns. Missing field → ERD change, not invent here.

| Job / step | Reads | Writes |
|------------|-------|--------|
| Aperture / widen diff | Live scope memberships (all live confirmed users) | None |
| NewsAPI drains | `newsapi_drain_cursors`; aperture sets | Cursor advance on success |
| X lanes | `x_word_search_cursor`; `x_post_download_cursors`; handles + `fetch_mode` | Those cursors on success |
| Admit keep-list | `stories` + subtype by `uri` / post id | Upsert `stories` + `press_articles` \| `x_posts` (no body); resurrect clears `removed_at` |
| Summarization / tagging / metastory | Invoke only | **Sibling stages** write `article_summary`, `story_*`, metastory tables |
| Compliance | Active X ids/authors; `x_compliance_jobs` | Job rows; soft-remove `stories.removed_*` |
| IR-14 | `x_posts` in window | Upsert `text` when changed |
| Warm recompute | Triggering `user_id` | Signal only — join/personalization tables not owned here |

**Not ingestion metering:** cursors / compliance jobs = **pipeline state**, not cost facts (§9).

---

## 8. Failure / degrade / idempotency

| Failure | Behavior |
|---------|----------|
| One NewsAPI drain fails | Degrade that drain; other drain + X continue |
| One X lane / handle fails | Degrade that lane/handle; others continue |
| Empty aperture | No vendor fetch |
| Summarization fail/skip | Keep-list stays; still tag + metastory; no body store |
| Story-tagging fail / skip | Story stays; still metastory; no invented chips. **Admit** final fail → sibling writes no new marks; **IR-14 text-change** final fail → sibling **empty replace-set** (clear priors — [ST-06](../../../02-product/contracts/story-tagging.md)); empty aperture → empty replace-set ([ST-15](../../../02-product/contracts/story-tagging.md)) |
| Metastory handoff degrade | Body discarded after barrier; keep-list kept; cluster retry per metastory rules |
| Compliance fail/expired | Pool unchanged; retry next `:00` |
| IR-14 lookup fail | Keep prior `text`; retry next IR-14 slot |
| Active duplicate | No-op (idempotent) |
| Warm trigger fail (o05e) | No onboarding scope confirm until warm accepts |
| Clock/warm overlap | Idempotent admits (IR-15); cursors advance only on lane success |

**Idempotency keys:** press `uri`, X post id, IR-14 text equality, cursor watermarks.

---

## 9. Observability and cost

### 9.1 PostHog (usage facts)

Family: **operational efficiency** (metering + job health) — not UX funnels (those live on onboarding/dashboard walks). No LLM eval/gold for this stage.

| Event | When | Properties (no body/text PII) |
|-------|------|-------------------------------|
| `ingestion_job_completed` | End of clock / warm-widen / IR-14 / compliance attempt | `job_kind`, `ok` \| `degraded`, `duration_ms`, counts (`articles_returned`, `ids_requested`, `ids_returned`, `text_changed`, …), `lanes_degraded[]`, `trigger` |

No per-article PostHog events. No new Supabase usage table in v1.

### 9.2 Unit prices (weekly)

- SoT: [ingestion-pricing.json](../../../07-ops/ingestion-pricing.json) (+ [md](../../../07-ops/ingestion-pricing.md)) — envelope like [model-pricing](../../../07-ops/model-pricing.md)  
- **Mondays 14:00 UTC** with models; channel **`#ops-pricing-ingestion`** · secret `TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION`  
- Intent: auto doc-fetch → **diff** → Slack (`in_sync` / `drift` / `fetch_fail`) → **human merge**; always post Monday heartbeat  
- Do not fetch prices on ingest runs; do not auto-write SoT without human merge  
- X `usage` / `credits` = **later actuals reconcile**, not the rate-card SoT  
- Workflow: [weekly-pricing-catalog-review.yml](../../../.github/workflows/weekly-pricing-catalog-review.yml) · [D-086](../../DECISIONS.md)

### 9.3 Daily spend digest

- Channel: **`#ops-pricing-ingestion`** · **daily 14:00 UTC** (same hour as weekly / model digests)  
- Lead: **estimated $/day**; then $/run (or avg) and breakdown by `job_kind`  
- Per-call detail optional/collapsed  
- Formula: yesterday’s PostHog facts × stamped rates (`price_as_of`)  
- **No MVP $-caps** on vendor calls  
- Workflow: [daily-ops-spend.yml](../../../.github/workflows/daily-ops-spend.yml) (shell until PostHog + SKUs wired)

Model daily spend (from `*_runs.estimated_cost_usd`) → `#ops-pricing-models` via the same daily workflow — see [07-ops/README.md](../../../07-ops/README.md).

---

## 10. Runtime gap (build phase)

**Target:** NewsAPI.ai Stream + X per vendor docs; jobs and admits as above ([§6.1](#61-vendor-http--aperture-mvp-carry-over)).

**Today’s prototype** may still use RSS / local feed-reader / cache-warmer / env handle allowlists. Treat as **legacy** — not a second live SoT. Do not treat RSS allowlists or `TEMPO_X_HANDLE_ALLOWLIST` as the product aperture. Do not port cross-feed URL+headline dedupe or embedding-recall into the IR admit path.

---

## 11. Out of this document

- Product IR rules / In-Out → [contracts/ingestion.md](../../../02-product/contracts/ingestion.md)  
- Vendor field matrices → [api-newsapi-ai.md](../api-newsapi-ai.md) · [api-x.md](../api-x.md)  
- Summarization / story-tagging / metastory prompts, gold, runs → sibling pipelines / PRDs / evals  
- Dashboard join, last-good, rising formulas → [dashboard--v1.md](../../../02-product/prds/dashboard--v1.md)  
- Column-level ERD → [tempo.dbml](../data/tempo.dbml)  
- Slack failure paging / runbooks → later platform ops  
- Wiring PostHog `ingestion_job_completed` facts + live SKU rates into the landed GHA digests ([daily-ops-spend.yml](../../../.github/workflows/daily-ops-spend.yml) · [weekly-pricing-catalog-review.yml](../../../.github/workflows/weekly-pricing-catalog-review.yml)) — envelope exists; facts/rates at build  
- Model daily cost digest channel ownership → [07-ops/README.md](../../../07-ops/README.md)
- As-is `source-matcher` / `embedding-recall` / dashboard personalization → join / dashboard / metastory (not IR admit)

---

## Decision log (B1)

| Date | Lock | Choice |
|------|------|--------|
| 29 Oct 2026 | Jobs | Three jobs: clock `:00`, warm (UX), IR-14 `:10/:25/:40/:55` |
| 29 Oct 2026 | UX warm | o05 / o05e / Account Save+Try again (a02* Tags, a03* Context) after successful scope commit |
| 29 Oct 2026 | Widen | Set diff; Start always widen; `fetch_mode` change = widen |
| 29 Oct 2026 | Shared-fetch sequence | Fetch → admit → compliance clock-only |
| 29 Oct 2026 | Admit | Persist → fan-out → barrier → discard; always hand metastory |
| 29 Oct 2026 | AI fences | Thin invoke I/O; siblings own writes |
| 29 Oct 2026 | IR-14 | 15‑min offsets; no MVP $-cap |
| 29 Oct 2026 | Data | Thin job→table map; cursors ≠ metering |
| 29 Oct 2026 | Failure matrix | Fail-open pool; active duplicate no-op |
| 29 Oct 2026 | Cost / PostHog | `ingestion_job_completed`; `ingestion-pricing`; daily `#ops-pricing-ingestion`; weekly auto-diff+human with models |
| 29 Oct 2026 | Artifact | **Locked** — this file |
| 2 Nov 2026 | ST-06 handoff | Story-tagging fail matrix + AI fence: admit vs IR-14 mark disposition; empty-aperture skip — aligns contract Edges + [ST-06](../../../02-product/contracts/story-tagging.md) / [ST-15](../../../02-product/contracts/story-tagging.md) |
| 2 Nov 2026 | Related | `ingestion-pricing` files are live envelope (not “planned”); story-tagging Related → pipeline + contract |
| 2 Nov 2026 | Coherence ↔ contract | Fix §9 cross-refs; admit barrier ↔ IR-05 / SR-05 / MR-08; Out = wire facts into landed GHA (not “implement workflows”) |
| 2 Nov 2026 | Cross-stage `trigger_id` | Ingestion passes `trigger_kind` (+ story context); each LLM stage mints its own `trigger_id` — not one UUID shared across summarization + story-tagging + metastory (boundary/writer separate) + personalization post-join |
| 2 Nov 2026 | Carry-over 1 | **A** — NewsAPI + X only; retire RSS/manifest/cache-warmer as live product ingestion |
| 2 Nov 2026 | Carry-over 2 | **A** — identity = `uri` / post id only; no cross-URL/headline merge |
| 2 Nov 2026 | Carry-over 3 | **A** — X handles from live scope union; env ≠ handle aperture |
| 2 Nov 2026 | Carry-over 4 | **A** — vendor HTTP **12s**/request; X concurrency **3** |
| 2 Nov 2026 | Carry-over 5 | **A** — matcher / embedding-recall / evidence-translator out of ingestion SoT |
