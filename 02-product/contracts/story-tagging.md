# Story-tagging — product contract

> **Stage:** Story-tagging · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 2 Nov 2026 (MVP carry-over coherence)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Invoke owner: [ingestion.md](./ingestion.md) (locked) — [IR-08](./ingestion.md) · [IR-14](./ingestion.md) (X text replace → re-invoke)
- Model PRD: [model--story-tagging--v1.md](../prds/model--story-tagging--v1.md)
- Prompt: [story-tagging.md](../../06-engineering/docs/prompts/story-tagging.md) (`story-tagging-v1` — Locked B2a)
- Pipeline: [story-tagging.md](../../06-engineering/docs/pipelines/story-tagging.md) (Locked B2a)
- Evals / gold (Locked B2a): [story-tagging.md](../../06-engineering/docs/evals/story-tagging.md) · [story-tagging.gold.json](../../06-engineering/docs/evals/story-tagging.gold.json) (st-skip-01 + st-01…22)
- Runs schema: [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/6ae28fe9ed134e407e37a621)
- Upstream catalogs / user chips: [extraction.md](./extraction.md) (locked) · [model--extraction--v1.md](../prds/model--extraction--v1.md)
- Parallel same-tick stage: [summarization.md](./summarization.md) (locked) — does **not** own chips; body discard only after **all** same-tick consumers finish when body is present ([IR-05](./ingestion.md))
- Downstream: [metastory.md](./metastory.md) (locked) · [dashboard--v1.md](../prds/dashboard--v1.md) (join / chip chrome)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37) — `story_topics` / `story_keywords` / `story_geographies`
- Product principles: [principles.md](../principles.md) (esp. pp1, pp2)

Full LLM stack (prompt / pipeline / runs / evals) is **Locked B2a** in eng siblings; runtime wire deferred. This contract owns product meaning — not prompt text or gold cases.

---

## Purpose

For each stored shared story, while the richest text is available, mark every **topic, keyword, and geography** in Tempo’s **shared catalogs** that the text supports (**story chips**). One constrained model call returns catalog IDs only — **no invented chips**. Distinct from the user’s confirmed scope chips ([extraction](./extraction.md)). Invoked by ingestion; this stage owns chip-apply meaning + LLM stack, not fetch, summarization, or metastory copy.

---

## Who it’s for

Solo bilateral / institutional comms operators ([pp1](../principles.md)). They never author story chips; marks exist so join, filter chrome, and retrieval can intersect user scope with the shared pool ([pp2](../principles.md)).

---

## Problem

A shared pool without durable story↔vocab marks cannot support join (source ∧ ≥1 chip) or metastory chip chrome. Deterministic string match over a growing open lexicon under-tags topics/geographies (paraphrase, bilingual). Press **body is discarded** after the admit tick once summarization, story-tagging, and same-tick metastory what-happened (if any) finish ([IR-05](./ingestion.md) · [SR-02](./summarization.md) · [MR-08](./metastory.md)), so first-pass quality must be high — chips are durable annotations, not re-derived from keep-list for press.

---

## Solution (target)

### Happy path

1. **Trigger:** Ingestion signals a **new** shared story (press or X) on clock or warm — or an **X text replace** after [IR-14](./ingestion.md) edit re-read.
2. **Input text:** Press → **title + body in memory** when body is present (same tick as summarization; body not stored). Press → **title only** when body is absent. X → keep-list **`text`**. Do **not** re-tag press from `article_summary` alone after body is gone.
3. **Catalog aperture:** Full shared **`topics` / `keywords` / `geographies`** catalogs at invoke time (open lexicon grown by extraction) — not only one user’s active chips. **Empty aperture** → skip the model; **empty replace-set** (no marks); no run row ([ST-15](#locked-rules)).
4. **Generate** (≤2 attempts): **One** LLM call with text + catalog ID/label snapshot → subset of topic, keyword, and geography **IDs** the text supports. Keywords: strict match-term bar (text supports the term); topics/geos: semantic OK within catalog only. Vendor concepts may inform eng hints only — must not become Tempo chips unless the ID exists in shared catalogs. Unknown / non-aperture / wrong-shelf IDs → **drop** from that array only (no auto-move); remaining valid IDs may still persist (**fail closed for invent**, not fail-the-invoke).
5. **Persist:** **Replace-set** into `story_topics` / `story_keywords` / `story_geographies` (delete absent marks; upsert present). No soft-delete / origin columns on these joins.
6. **Return:** Success or failure to ingestion. Story always stays in the pool (**fail open for pool**). **Admit** final fail → leave marks empty (typical) / unchanged if none were written. **IR-14 text-change** final fail → **empty replace-set** (clear priors — marks must not describe superseded `text`).

Same-tick order vs summarization (and vs metastory what-happened when body is used) is **flexible**, as long as **all** same-tick body consumers finish before the orchestrator discards the body when body is present ([IR-05](./ingestion.md)).

### Explicit product lines

- **Story chips ≠ user chips** — extraction owns user scope; this stage only marks shared stories.
- **No invented chips** — output IDs must exist in catalogs; never create catalog rows from this stage; drop unknown IDs without failing the whole invoke.
- **One operation** — topics + keywords + geographies in a single invoke.
- Prompt / SKU / gold / runs → eng siblings (**Locked B2a**); runtime wire (migrate + harness + invoke) deferred.

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Stored stories carry shared-vocab marks usable for join / chrome without inventing scope |
| **Early signal** | Same-tick tag on admit; IR-14 text change re-tags X; title-only path when press body missing; body never persisted for tagging |
| **Guardrail** | No invented chips; press not re-tagged from summary alone — failure modes F1–F7 in [evals/story-tagging.md](../../06-engineering/docs/evals/story-tagging.md) |

Operational / qualitative only for v1. Thin PostHog invoke `story_tagging_invoke` is **specified** on the [model PRD](../prds/model--story-tagging--v1.md) under [D-088](../../06-engineering/DECISIONS.md#2026-10-31---d-088---shared-thin-_invoke-posthog-events-for-all-llm-stages) (shared LLM measurement stack + runs + evals/gold) — **not instrumented** until build. This contract does not invent further analytics event names.

---

## Scope

### In

- Constrained story-chip apply (T/K/G IDs) for press + X from richest available text (title+body, title-only, or X text)
- Replace-set persistence to `story_*` joins; re-tag on X text change (IR-14)
- Product rules: full shared catalogs; no invent (drop unknowns); one call; ≤2 attempts; fail-open pool; empty aperture skip; IR-14 fail clears marks
- Stage I/O; prompt / pipeline / **story-tagging-runs** / evals siblings Locked B2a (runtime wire deferred)

### Out / non-goals

- Creating or editing **user** chips / catalogs ([extraction.md](./extraction.md))
- Fetch, drains, compliance, keep-list field matrices, clock/warm jobs, IR-14 job implementation ([ingestion.md](./ingestion.md) owns invoke + IR-14)
- Article summary ([summarization.md](./summarization.md))
- Metastory clustering / shared copy; dashboard join / feed membership / chip chrome ownership
- Inventing catalog labels; growing the lexicon from story text
- Re-tagging press from `article_summary` after body discard; Get-articles backfill for re-tag
- Re-tagging solely because shared catalogs grew after admit (press or X) — aperture is point-in-time at invoke
- Treating vendor concepts as Tempo chips without a catalog ID
- Soft-delete / origin columns on `story_*` joins
- Prompt text, gold cases, SKU choice in this doc
- Active-duplicate re-invoke ([IR-15](./ingestion.md) owns no-op); this stage only runs when ingestion invokes it

---

## Locked rules

| ID | Rule |
|----|------|
| **ST-01** | **Richest text** — press: **title + body in memory** when body present; press: **title** when body absent; X: keep-list `text`. Never store body for tagging |
| **ST-02** | **Full shared catalogs** — consider every row in `topics` / `keywords` / `geographies` at invoke; not per-user scope alone |
| **ST-03** | **No invented chips** — emit only existing catalog UUIDs; this stage never INSERTs catalog rows |
| **ST-04** | **One call** — topics + keywords + geographies in a single model invoke |
| **ST-05** | **Replace-set** — write `story_topics` / `story_keywords` / `story_geographies` as the full current mark set for that story |
| **ST-06** | **Re-tag** — on IR-14 X `text` change, re-invoke; on success → replace-set from new text; on **final fail** → **empty replace-set** (clear priors). **Do not** re-tag press from article summary alone |
| **ST-07** | **Fail open for pool** — tag failure does not drop the story. **Fail closed for invent** — drop unknown / non-aperture / **wrong-shelf** IDs (e.g. a topic UUID listed under keywords — drop from that list only; do **not** move to another array); do **not** fail the invoke solely because some IDs were dropped. **IR-14 fail** — do not keep unverified prior marks (empty replace-set per ST-06) |
| **ST-08** | **Distinct from user chips** — marks are shared-pool assertions; join ceiling remains the user’s confirmed chips |
| **ST-09** | **Invoke owner** — ingestion triggers ([IR-08](./ingestion.md)); story-tagging owns meaning + LLM stack. Active duplicate → no invoke ([IR-15](./ingestion.md)) |
| **ST-10** | **Keyword bar** — keyword IDs only when the text supports the catalog term as a match term (stricter than topic/geo) |
| **ST-11** | **Retry** — ≤2 attempts same invoke; on final fail → fail-open for pool (ST-07) + mark disposition per ST-06 / admit edges |
| **ST-12** | **Vendor concepts** — may inform eng hints only; must not become Tempo chips unless the ID exists in shared catalogs |
| **ST-13** | **Lineage** — [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml); one row per LLM attempt; skip / no-model paths (IR-14 no-change, empty aperture) insert **no** row |
| **ST-14** | **Same-tick body custody** — when body is present, orchestrator discards only after summarization, story-tagging, **and** same-tick metastory what-happened (if any) have finished (order flexible) — [IR-05](./ingestion.md) |
| **ST-15** | **Empty aperture** — if the shared catalog snapshot has **no** topic/keyword/geography rows, outcome **`skip`**: **skip** the LLM; empty replace-set (no marks); no run row |

---

## Stage I/O

### Inputs

- `story_id` + kind (press | x)
- Text: press title + body (in memory) when body present; press **title** when body absent; or X `text`
- Snapshot of shared catalog IDs + labels (T/K/G) — label fields from Database library: `topics.name` / `keywords.name` / `geographies.name_normalized`
- Invoke signal from ingestion (admit or IR-14 text change)

### Outputs

- Sets of `topic_id` / `keyword_id` / `geography_id` for replace-set
- Success / failure / **skip** signal to ingestion
- Story-tagging-run lineage when schema exists (no row on skip / no-model)

### Edges

- Press body present → title + body; body absent → **title only** (still run; keyword bar still applies)
- Empty catalog snapshot → outcome **`skip`**: skip LLM; empty replace-set; no run row (ST-15)
- Model returns unknown / non-aperture / **wrong-shelf** ID → **drop** from that array only (no auto-move); persist remaining valid IDs; invoke may still **succeed** (ST-07)
- Attempt 1 fail → one retry; both fail → fail-open for **pool** (keep story). **Admit** final fail → no new marks written. **IR-14 text-change** final fail → **empty replace-set** (clear priors) (ST-06)
- IR-14 no text change → no re-tag; no run row
- IR-14 text change → re-invoke; success → replace-set; final fail → empty replace-set
- **Active duplicate** (already in pool) → ingestion does **not** invoke ([IR-15](./ingestion.md))
- **Admit retry** (same new-admit / resurrect path retried) → idempotent replace-set when invoked
- Never re-tag press from `article_summary` alone after body discarded
- Catalog growth alone → **no** re-tag (Out)

### Handoff

- Ingestion continues keep-list / summarization / metastory handoff regardless of tag success (pool fail-open).
- Metastory and dashboard consume `story_*` marks; they do not invent chips.

---

## Runtime gap (build phase)

**Target:** Invoked from ingestion on each new story (and X text replace) with constrained model + replace-set + gold.

**Today:** Stage **not shipped** at runtime. B2a design siblings (prompt / pipeline / runs DBML / evals+gold) are **Locked**; migrate + harness + invoke instrumentation deferred. Do not treat prototype lexical gates as this product SoT.

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 26–27 Oct 2026 | Process (plan thread) | Chip tagging B — shared vocabulary marks; no invented chips; user join = source ∧ chip |
| 28 Oct 2026 | Databases / charter | LLM stage **story-tagging**; full catalogs; one call; replace-set; body-once; IR-14 re-tag |
| 28 Oct 2026 | Point 0 | Stage contract **A** — apply meaning + LLM stack; ingestion invoke only |
| 28 Oct 2026 | Purpose / Who / Problem | **B** / **A** / **B** |
| 28 Oct 2026 | Solution / Scope | Happy path **B**; In/Out **B**; lineage In as expectation |
| 28 Oct 2026 | Missing body | Tag from **title** (not skip) |
| 28 Oct 2026 | ST-01…14 | Locked rules as tabled; ≤2 attempts; vendor concepts ≠ chips (ST-15 added 2 Nov) |
| 28 Oct 2026 | Stage I/O | **B**; same-tick order flexible until all body consumers done before discard |
| 28 Oct 2026 | Related / Success / Runtime | **B** / **B** / **B** |
| 28 Oct 2026 | Artifact | **Locked** — [story-tagging.md](./story-tagging.md) |
| 28 Oct 2026 | A2′ body custody | ST-14 / Related / Problem aligned to three same-tick consumers (summarization · story-tagging · metastory what-happened) |
| 2 Nov 2026 | B2a Success ↔ D-088 | Success note: `story_tagging_invoke` specified on model PRD (D-088); not instrumented until build — no ST rule change |
| 2 Nov 2026 | B2a edge clarity | (1) Active duplicate ≠ admit retry — align IR-15; (2) drop invent IDs, invoke may succeed; (3) empty aperture → skip LLM / ST-15; (4) no re-tag on catalog growth alone; (5) IR-14 final fail → empty replace-set (ST-06/07) |
| 2 Nov 2026 | B2a coherence ↔ PRD/pipeline | Related pipeline Locked; Outputs + ST-15 name `skip`; ST-07 wrong-shelf no auto-move; catalog labels = tempo name fields; Next foundations refreshed |
| 2 Nov 2026 | Coherence ↔ B2a siblings | Evals/gold + runs DBML Locked; Related/Scope/Runtime/Next no longer TBD; ≤2 **attempts** (not retries) |
| 2 Nov 2026 | Coherence pass | Explicit product lines: eng siblings Locked B2a (not “when build focuses”); wire deferred only |
| 2 Nov 2026 | MVP carry-over | Confirm: LLM + full shared catalog only; no settings clamp on `story_*`; post-model drop/dedupe only; eng **15s**/attempt — [pipeline](../../06-engineering/docs/pipelines/story-tagging.md) |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| [model--story-tagging--v1.md](../prds/model--story-tagging--v1.md) | **Spec locked (B2a PRD)** — Execution + Must + NFR |
| [pipelines/story-tagging.md](../../06-engineering/docs/pipelines/story-tagging.md) | **Locked (B2a)** |
| [prompts/story-tagging.md](../../06-engineering/docs/prompts/story-tagging.md) | **Locked (B2a)** — `story-tagging-v1` |
| [evals/story-tagging.md](../../06-engineering/docs/evals/story-tagging.md) · [story-tagging.gold.json](../../06-engineering/docs/evals/story-tagging.gold.json) | **Locked (B2a)** — advisory harness at build |
| [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml) | **Locked (B2a)** — migrate at build |
