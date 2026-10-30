# Ingestion — product contract

> **Stage:** Ingestion · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 29 Oct 2026 (B1 gaps 1–7 + pipeline SoT)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer pipeline / vendor / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Vendor consumption: [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) · [api-x.md](../../06-engineering/docs/api-x.md)
- Summarization (invoke target): contract [summarization.md](./summarization.md) (locked) · PRD [model--summarization--v1.md](../prds/model--summarization--v1.md)
- Story-tagging (invoke target): contract [story-tagging.md](./story-tagging.md) (locked) · PRD [model--story-tagging--v1.md](../prds/model--story-tagging--v1.md)
- Upstream scope: [extraction.md](./extraction.md) · [model--extraction--v1.md](../prds/model--extraction--v1.md)
- Warm triggers (UX): [onboarding--v1.md](../prds/onboarding--v1.md) (Start monitoring) · [account--v1.md](../prds/account--v1.md) (Context Save)
- Downstream handoff: [metastory.md](./metastory.md) (locked) · [model--metastory--v1.md](../prds/model--metastory--v1.md) · [personalization.md](./personalization.md) (locked) · [model--personalization--v1.md](../prds/model--personalization--v1.md)
- Feed join / UX: [dashboard--v1.md](../prds/dashboard--v1.md) (source ∧ ≥1 chip)
- Pipeline (locked B1): [ingestion.md](../../06-engineering/docs/pipelines/ingestion.md)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Product principles: [principles.md](../principles.md) (esp. pp1, pp2, pp7)

No `model--ingestion` PRD — rules live in this contract. No LLM prompt or gold ownership here.

---

## Purpose

Fetch and maintain Tempo’s **shared** press + X story pool from the union of users’ sources and terms: two NewsAPI drains, X `fetch_mode` lanes, keep-list persistence, X compliance + edit re-read, story-chip tagging **invoke**, and the 60‑minute clock with warm-on-widen. Invoke summarization for new press URIs (when body is present) and story-tagging for new stories (body never stored). This stage does **not** own article-summary or story-tagging prompts, metastory clustering/copy, or per-user join / why / what-next.

---

## Who it’s for

Solo bilateral / institutional comms operators ([pp1](../principles.md)). Ingestion is not a user-facing surface; it exists so their monitoring feed can stay current within the scope they confirmed.

---

## Problem

Monitoring fails if the pool is built the wrong way — per-user fetches that miss union OR-logic, retained publisher bodies, a stale pool after a scope widen, or chips the user never had ([pp2](../principles.md)). The operator needs one shared, lawful, chip-tagged press + X pool that refreshes on a predictable clock and warms when scope widens.

---

## Solution (target)

### Happy path

1. Build **shared** query aperture from the **union** of **all accounts with live confirmed scope**: traditional sources + topics/geos (concepts) + keywords + X handles (`fetch_mode`).
2. On the **60‑min clock** (and on **warm when scope widens**, always including onboarding Start monitoring): run **two NewsAPI Stream drains** (concepts-only · keywords-only; never both families on one request); run **X** `word_search` / `post_download` lanes; dedupe press by vendor `uri`, X by post id.
3. For each **new admit** (first active pool membership for that press `uri` or X post id, including **resurrect** of a soft-removed row): **persist keep-list first** (no publisher body) → hold body **in memory only** when the vendor returned one → same-tick consumers (**summarization** when press + body present; **story-tagging**; **metastory** handoff — order flexible) → **discard** body only after those consumers that need it have finished. Summarization writes **`article_summary`** when it succeeds ([summarization.md](./summarization.md)); story-tagging writes **`story_*`** replace-sets when it succeeds ([story-tagging.md](./story-tagging.md)); ingestion owns keep-list hub + invoke/orchestration only. For **new** X posts: persist keep-list (**text is the record**; no summarization) → **invoke story-tagging** on `text` → hand metastory.
4. Hand **every newly admitted shared story** to metastory (**same tick**), including when story chips are empty or tagging failed. Chips gate **feed join**, not clustering ([MR-02](./metastory.md) · [dashboard--v1.md](../prds/dashboard--v1.md)). For new press with body, keep body in memory through same-tick metastory what-happened when needed, then discard only after **summarization** (if invoked), **story-tagging**, and **metastory what-happened** (if any) have finished ([SR-02](./summarization.md) · [ST-14](./story-tagging.md) · [MR-08](./metastory.md)).
5. On the **60‑min clock:** **batch compliance** per locked X rules; drop as required.
6. On a **shorter X edit-re-read job** (~**10–15 min**): for posts whose `published_at` is still inside the vendor edit window (~30 min), **Get posts by ids** once per eligibility pass and replace keep-list `text` if changed ([IR-14](#locked-rules)); on text change → **re-invoke story-tagging**. No extra DB column — eligibility from `published_at`; upserts are idempotent.
7. **Join / feed membership** and feed UX → [dashboard--v1.md](../prds/dashboard--v1.md). Personalization consumes feed membership only.

Autosuggest source/concept URI resolve stays **settings-time** (onboarding / account path), not on the poll — see [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md).

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Downstream metastory / feed utility — on-beat stories present in the shared pool; publisher bodies never retained |
| **Early signal** | Warm-after-widen runs shared fetch when aperture grew; clock tick completes without storing body; compliance failure retries next tick without wiping the pool |

Operational / qualitative only for v1 — no invented analytics event names until instrumentation locks.

---

## Scope

### In

- Union shared aperture from **all accounts with live confirmed scope**
- Two NewsAPI Stream drains; X `fetch_mode` lanes; language D as a product rule
- Keep-list persistence; summarization **invoke** for new press admits with body; story-tagging **invoke** for new admits (+ X text replace); metastory **handoff** on every new admit
- Admit identity / active-duplicate no-op / soft-removed resurrect ([IR-15](#locked-rules))
- X compliance; X edit re-read (short job)
- 60‑min shared clock; warm-C; edit-re-read cadence stub (~10–15 min)
- Poll cursors / compliance job state / warm triggers as job state

### Out / non-goals

- Article-summary prompts, gold, or model SKU (summarization stage) — including writing `article_summary` (summarization owns the column)
- Story-chip prompts, gold, or model SKU ([story-tagging.md](./story-tagging.md)) — including writing `story_*` (story-tagging owns those joins)
- Metastory embeddings, clustering, shared copy, id stability
- Why this matters / what comes next / practice notes (personalization)
- Dashboard join/UX as owned behavior (handoff only: source ∧ ≥1 chip)
- Vendor endpoint/field matrices (live in `api-*`)
- Rising / source-order / feed-rank **formula math**
- `model--ingestion` PRD; LLM prompt ownership
- Single Stream request with keyword + concept families (AND drop)
- Get articles backfill; storing / logging / showing publisher body
- Invented chips (story-tagging fail-closed); join-only warm when scope widens
- Per-user fetch as the shared-pool SoT
- RSS / local feed-reader as target aperture (legacy — see runtime gap)
- **v1 pool GC / aperture-driven soft-remove** on scope narrow or “no live user still needs this story” ([IR-16](#locked-rules))
- Activity-windowed union (last-N-days sign-in) — product aperture is all live scopes
- MVP keep-list **metadata refresh** on active duplicate Stream/X hits

---

## Locked rules

| ID | Rule |
|----|------|
| **IR-01** | **Shared pool** — one press + X pool from the **union** of **all accounts with live confirmed scope** (sources and terms); tag in Tempo; vendors do not attach per-user tags. Inactivity pruning of contributors is out of v1 |
| **IR-02** | **Two NewsAPI drains** — concepts-only and keywords-only; never both families on one request; union/dedupe by article `uri` in Tempo |
| **IR-03** | **Language D** — `lang` on keyword drains per observed source language (plus original wording); omit on concept drains. Params: [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) |
| **IR-04** | **X `fetch_mode`** — per handle: `word_search` (default) or `post_download`. Lanes: [api-x.md](../../06-engineering/docs/api-x.md) |
| **IR-05** | **Keep-list (press)** — on admit, **persist keep-list first** (title, outlet, author, time, URL, vendor URI; nullable **`excerpt`** reserved for a future **outlet-/feed-provided** teaser only — NewsAPI.ai has no excerpt field today → leave **NULL**; never fill from truncated `body` / `articleBodyLen`). Body **transient only** — in memory until **summarization** (if invoked), **story-tagging**, and same-tick **metastory what-happened** (if any) finish, then discard (order flexible among those consumers). **`article_summary`** is written by the summarization stage when it succeeds (also source-reader snippet — [SR-07](./summarization.md)); ingestion does not own that column. Never store/log/show body. Soft priors / returned details: [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) |
| **IR-06** | **Keep-list (X)** — persist locked post/author fields; **text is the record**; no summarization; remove/replace on delete, edit, protect, suspend, withhold. Fields: [api-x.md](../../06-engineering/docs/api-x.md) |
| **IR-07** | **Compliance B** — batch compliance on the **shared 60‑min clock**; if the job is priced per-ID → daily job (still Tempo-owned). Drop/replace pool rows per mapped reasons. Edit re-read is **not** this rule — see IR-14 |
| **IR-08** | **Story-tagging invoke** — **after keep-list store** (and on IR-14 X text change), call [story-tagging](./story-tagging.md) so every shared-catalog topic/keyword/geography the text supports is marked (**story chips**; no invented chips). Press with no body → still invoke (**title only**). This contract owns **trigger/handoff only** — product meaning + LLM stack + `story_*` writes live on the story-tagging stage. Distinct from the user’s confirmed scope chips (extraction) |
| **IR-09** | **Clock** — shared refresh every **60 minutes** (NewsAPI drains, X fetch lanes, compliance). Does **not** by itself satisfy the X edit window |
| **IR-10** | **Warm C** — always ensure that user’s join/personalization recompute; shared fetch when scope **widens** aperture (new/changed traditional source URI, topic/geo concept URI, keyword string, or X handle / `fetch_mode`); onboarding Start monitoring always widens; unchanged sign-in reads last good feed until the clock. Scope **narrow** does not trigger shared fetch and does not remove pool rows ([IR-16](#locked-rules)) |
| **IR-11** | **Summarization invoke** — new press admit **with body in memory** → call summarization stage; **skip** when body is absent (no title/excerpt-only invent). This contract owns trigger/handoff only; summarization owns `article_summary` |
| **IR-12** | **Settings-time URI resolve** — Suggest sources/concepts at onboarding/settings, not on the poll |
| **IR-13** | **No Get articles backfill** — Stream (+ X polls) only for v0 retrieval |
| **IR-14** | **X edit re-read (stub)** — separate job every **~10–15 minutes**; select `x_posts` with `published_at` still inside the ~**30‑min** vendor edit window; **Get posts by ids**; replace `text` when changed. **No** `edit_window_until` / `edit_reread_at` column — eligibility from `published_at`; re-fetch while in window is idempotent. Endpoint: [api-x.md](../../06-engineering/docs/api-x.md). Exact minutes + pricing cap: thicken in eng pipeline when built |
| **IR-15** | **Admit / reappear** — **New admit** = first **active** pool membership for that press `uri` or X post id, **or** reappear of a **soft-removed** row (**resurrect** → treat as new admit). **Active duplicate** (already in pool, `removed_at` null) → **no-op** for summarization, story-tagging, and metastory-admit; MVP does **not** refresh keep-list metadata on that hit. IR-14 text change remains the X re-tag exception |
| **IR-16** | **Narrow / no v1 pool GC** — when scope shrinks, next clock/warm uses the smaller union; **do not** soft-remove shared stories because a user narrowed or because no live user currently “needs” the row. Removals = X compliance (IR-07) or rare operator. Join/feed hide what the user no longer matches |

**Handoff (not IR rules):** **Join** (source ∧ ≥1 of the user’s chips) → **feed membership** owned by [dashboard--v1.md](../prds/dashboard--v1.md); [personalization.md](./personalization.md) runs only on current members. **Metastory** receives every new admit same tick (chips optional). Embeddings admit exception (`post_download` paraphrase keep) → [metastory.md](./metastory.md). `includeArticleLinks` stays out → [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md).

---

## Stage I/O

### Inputs

- Union of **all accounts with live confirmed scope**: traditional source URIs, topic/geo concept URIs, keyword strings, X handles + `fetch_mode`
- Warm trigger: onboarding Start monitoring · Account Context Save (widen vs join-only / narrow)
- Shared clock tick
- Vendor responses per [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) and [api-x.md](../../06-engineering/docs/api-x.md)
- Summarization result for a new press admit (article summary) — or skip/failure signal
- Story-tagging result (T/K/G ID sets) — or failure/skip signal

### Outputs

- Shared story rows (press by `uri`, X by post id) with keep-list fields; press may gain **`article_summary`** when summarization succeeded (column owned by that stage)
- **Story chips** via story-tagging replace-set on `story_*` when tagging succeeded (joins owned by that stage)
- Updated cursors / compliance job state / warm metadata
- **Every new admit** available to metastory same tick (body still in memory for new press with body until summarization if any, story-tagging, and metastory same-tick what-happened — if any — complete)
- Warm ensures that user’s join + personalization recompute (join / feed membership owned by dashboard)

### Edges

- **No body** on new press admit → persist keep-list → **skip** summarization → still invoke story-tagging (**title only**) → hand metastory → nothing to discard
- Summarization fail → keep-list remains **without** article summary; do not store body; do not block the rest of the pool tick (**fail open for pool**, fail closed for body); source reader has no snippet; still tag + hand metastory
- Story-tagging fail → story remains in pool **without** new chips (or keep prior marks on re-tag); do not block pool tick (**fail open for pool**, fail closed for inventing chips); **still hand metastory**
- Compliance job fail → keep pool as-is; retry next clock
- Drain / X lane fail → degrade that lane; other lanes continue
- Empty union aperture → no vendor fetch; no invented scope
- Widen=false warm (incl. narrow-only save) → no shared fetch; still ensure user recompute; **no** pool GC
- **Active duplicate** `uri` / post id → one stored row; **no** summarization / story-tagging / metastory-admit; no MVP metadata refresh
- **Soft-removed reappear** → resurrect as **new admit** (full admit path)
- Duplicate admit retry → keep-list upsert + story-tagging replace-set remain idempotent

---

## Runtime gap (build phase)

This contract describes the **target**: NewsAPI.ai Stream + X per [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) and [api-x.md](../../06-engineering/docs/api-x.md).

**Today’s prototype** still centers RSS / local feed-reader paths. Treat that path as **legacy** until build reconciles runtime to this contract. Foundation docs must not treat RSS allowlists as the product aperture.

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 26–27 Oct 2026 | Process (plan thread) | Shared pool, two drains, language D, keep-list, compliance B, chip tagging B, 60‑min clock, warm triggers |
| 27 Oct 2026 | Charter | Rules-only stage contract; no `model--ingestion` PRD; no LLM prompt/gold ownership |
| 27 Oct 2026 | Warm | **C** — recompute user path always; shared fetch on aperture widen; Start monitoring always widens |
| 27 Oct 2026 | Purpose / Who / Problem | Rules orchestrator; pp1 operator; monitoring continuity pain |
| 27 Oct 2026 | Solution / Scope | Happy path B; In/Out B; language D + `fetch_mode` as one-line product rules |
| 27 Oct 2026 | IR-01…13 | Locked rules inventory as tabled |
| 27 Oct 2026 | Stage I/O | Inputs/Outputs/Edges; summarization fail-open for pool; warm ensures user recompute |
| 27 Oct 2026 | Related / Success / Analytics | Sibling map B; thin success B; prose-only signals (no event names yet) |
| 27 Oct 2026 | Runtime gap | Target NewsAPI + X; RSS prototype = legacy |
| 27 Oct 2026 | Artifact | **Locked** — [ingestion.md](./ingestion.md) |
| 27 Oct 2026 | A2 | Story chips vs user chips; join → dashboard feed membership; same-tick body through metastory |
| 28 Oct 2026 | Excerpt / IR-05 | `excerpt` nullable reserved; NewsAPI → NULL; never truncated body; article summary is UI snippet via summarization SR-07 |
| 28 Oct 2026 | **IR-14** edit re-read | Stub: ~10–15 min job over recent `published_at` (~30 min window); not on 60‑min clock; no extra `x_posts` column; lives in this contract (no `model--ingestion` / dedicated PRD) |
| 28 Oct 2026 | **IR-08** → story-tagging | Chip apply is LLM stage [story-tagging.md](./story-tagging.md); ingestion owns invoke only (parallel to IR-11 summarization) |
| 28 Oct 2026 | A2′ body custody | Discard press body only after summarization + story-tagging + same-tick metastory what-happened (if any); IR-05 / happy path / outputs aligned |
| 29 Oct 2026 | **B1 Gap 1** | Persist keep-list first (no body); siblings own `article_summary` / `story_*`; orchestrator discard after same-tick consumers |
| 29 Oct 2026 | **B1 Gap 2** | Every new admit → metastory same tick; empty/failed chips OK; chips gate feed join only |
| 29 Oct 2026 | **B1 Gap 3 / IR-15** | Active duplicate → LLM + metastory-admit no-op; soft-removed reappear → resurrect as new admit; no MVP metadata refresh |
| 29 Oct 2026 | **B1 Gap 4** | No body → skip IR-11; still IR-08 title-only; hand metastory; nothing to discard |
| 29 Oct 2026 | **B1 Gap 5 / IR-16** | No v1 pool GC on narrow; join/aperture only |
| 29 Oct 2026 | **B1 Gap 6** | Union = all accounts with live confirmed scope |
| 29 Oct 2026 | **B1 Gap 7** | Related → Pipeline (stub); IR-10 keeps `fetch_mode` change as shared-fetch widen |
| 29 Oct 2026 | **B1 pipeline** | [pipelines/ingestion.md](../../06-engineering/docs/pipelines/ingestion.md) locked — jobs/triggers/admit/observability |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| [pipelines/ingestion.md](../../06-engineering/docs/pipelines/ingestion.md) | **Locked (B1)** — implement GHA digests / `ingestion-pricing` / auto-diff in ops pass |
| [story-tagging.md](./story-tagging.md) · [model--story-tagging--v1.md](../prds/model--story-tagging--v1.md) | Contract locked — eng stack when in build focus |
| LLM `*-runs.dbml` siblings | Landed A4 — see [data README](../../06-engineering/docs/data/README.md) (ingestion itself has no runs page) |
