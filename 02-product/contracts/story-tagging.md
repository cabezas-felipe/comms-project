# Story-tagging — product contract

> **Stage:** Story-tagging · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 28 Oct 2026 (A2′ body custody)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Invoke owner: [ingestion.md](./ingestion.md) (locked) — [IR-08](./ingestion.md) · [IR-14](./ingestion.md) (X text replace → re-invoke)
- Model PRD: [model--story-tagging--v1.md](../prds/model--story-tagging--v1.md)
- Prompt (TBD): [story-tagging.md](../../06-engineering/docs/prompts/story-tagging.md)
- Pipeline (TBD): [story-tagging.md](../../06-engineering/docs/pipelines/story-tagging.md)
- Evals / gold (TBD): [story-tagging.md](../../06-engineering/docs/evals/story-tagging.md) · [story-tagging.gold.json](../../06-engineering/docs/evals/story-tagging.gold.json)
- Runs schema: [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/6ae28fe9ed134e407e37a621)
- Upstream catalogs / user chips: [extraction.md](./extraction.md) (locked) · [model--extraction--v1.md](../prds/model--extraction--v1.md)
- Parallel same-tick stage: [summarization.md](./summarization.md) (locked) — does **not** own chips; body discard only after **all** same-tick consumers finish when body is present ([IR-05](./ingestion.md))
- Downstream: [metastory.md](./metastory.md) (locked) · [dashboard--v1.md](../prds/dashboard--v1.md) (join / chip chrome)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37) — `story_topics` / `story_keywords` / `story_geographies`
- Product principles: [principles.md](../principles.md) (esp. pp1, pp2)

Full LLM stack (prompt / pipeline / runs / evals) lives in eng siblings when this stage is in build focus. This contract owns product meaning — not prompt text or gold cases.

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
3. **Catalog aperture:** Full shared **`topics` / `keywords` / `geographies`** catalogs at invoke time (open lexicon grown by extraction) — not only one user’s active chips.
4. **Generate** (≤2 attempts): **One** LLM call with text + catalog ID/label snapshot → subset of topic, keyword, and geography **IDs** the text supports. Keywords: strict match-term bar (text supports the term); topics/geos: semantic OK within catalog only. Vendor concepts may inform eng hints only — must not become Tempo chips unless the ID exists in shared catalogs.
5. **Persist:** **Replace-set** into `story_topics` / `story_keywords` / `story_geographies` (delete absent marks; upsert present). No soft-delete / origin columns on these joins.
6. **Return:** Success or failure to ingestion. Failure → story may remain in pool **without** (or with prior) chips; do not block the pool tick (**fail open for pool**, fail closed for inventing chips).

Same-tick order vs summarization (and vs metastory what-happened when body is used) is **flexible**, as long as **all** same-tick body consumers finish before the orchestrator discards the body when body is present ([IR-05](./ingestion.md)).

### Explicit product lines

- **Story chips ≠ user chips** — extraction owns user scope; this stage only marks shared stories.
- **No invented chips** — output IDs must exist in catalogs; never create catalog rows from this stage.
- **One operation** — topics + keywords + geographies in a single invoke.
- Prompt / SKU / gold → eng siblings when build focuses this stage.

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Stored stories carry shared-vocab marks usable for join / chrome without inventing scope |
| **Early signal** | Same-tick tag on admit; IR-14 text change re-tags X; title-only path when press body missing; body never persisted for tagging |
| **Guardrail** | No invented chips; press not re-tagged from summary alone — failure-mode detail in evals later |

Operational / qualitative only for v1 — no invented analytics event names until instrumentation locks.

---

## Scope

### In

- Constrained story-chip apply (T/K/G IDs) for press + X from richest available text (title+body, title-only, or X text)
- Replace-set persistence to `story_*` joins; re-tag on X text change (IR-14)
- Product rules: full shared catalogs; no invent; one call; ≤2 attempts; fail-open pool
- Stage I/O; expectation of prompt / pipeline / **story-tagging-runs** / evals siblings (TBD)

### Out / non-goals

- Creating or editing **user** chips / catalogs ([extraction.md](./extraction.md))
- Fetch, drains, compliance, keep-list field matrices, clock/warm jobs, IR-14 job implementation ([ingestion.md](./ingestion.md) owns invoke + IR-14)
- Article summary ([summarization.md](./summarization.md))
- Metastory clustering / shared copy; dashboard join / feed membership / chip chrome ownership
- Inventing catalog labels; growing the lexicon from story text
- Re-tagging press from `article_summary` after body discard; Get-articles backfill for re-tag
- Treating vendor concepts as Tempo chips without a catalog ID
- Soft-delete / origin columns on `story_*` joins
- Prompt text, gold cases, SKU choice in this doc

---

## Locked rules

| ID | Rule |
|----|------|
| **ST-01** | **Richest text** — press: **title + body in memory** when body present; press: **title** when body absent; X: keep-list `text`. Never store body for tagging |
| **ST-02** | **Full shared catalogs** — consider every row in `topics` / `keywords` / `geographies` at invoke; not per-user scope alone |
| **ST-03** | **No invented chips** — emit only existing catalog UUIDs; this stage never INSERTs catalog rows |
| **ST-04** | **One call** — topics + keywords + geographies in a single model invoke |
| **ST-05** | **Replace-set** — write `story_topics` / `story_keywords` / `story_geographies` as the full current mark set for that story |
| **ST-06** | **Re-tag** — on IR-14 X `text` change, re-invoke and replace-set; **do not** re-tag press from article summary alone |
| **ST-07** | **Fail open for pool** — tag failure does not drop the story; fail closed for inventing chips |
| **ST-08** | **Distinct from user chips** — marks are shared-pool assertions; join ceiling remains the user’s confirmed chips |
| **ST-09** | **Invoke owner** — ingestion triggers ([IR-08](./ingestion.md)); story-tagging owns meaning + LLM stack |
| **ST-10** | **Keyword bar** — keyword IDs only when the text supports the catalog term as a match term (stricter than topic/geo) |
| **ST-11** | **Retry** — ≤2 attempts same invoke; on final fail → fail-open for pool (ST-07) |
| **ST-12** | **Vendor concepts** — may inform eng hints only; must not become Tempo chips unless the ID exists in shared catalogs |
| **ST-13** | **Lineage** — [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml); one row per LLM attempt; IR-14 no-change inserts no row |
| **ST-14** | **Same-tick body custody** — when body is present, orchestrator discards only after summarization, story-tagging, **and** same-tick metastory what-happened (if any) have finished (order flexible) — [IR-05](./ingestion.md) |

---

## Stage I/O

### Inputs

- `story_id` + kind (press | x)
- Text: press title + body (in memory) when body present; press **title** when body absent; or X `text`
- Snapshot of shared catalog IDs + normalized labels (T/K/G)
- Invoke signal from ingestion (admit or IR-14 text change)

### Outputs

- Sets of `topic_id` / `keyword_id` / `geography_id` for replace-set
- Success / failure signal to ingestion
- Story-tagging-run lineage when schema exists

### Edges

- Press body present → title + body; body absent → **title only** (still run; keyword bar still applies)
- Empty catalog snapshot → no marks; do not invent labels
- Model returns unknown ID → drop that ID (fail closed for invent)
- Attempt 1 fail → one retry; both fail → fail-open for pool (keep story; prior chips if any)
- IR-14 no text change → no re-tag
- IR-14 text change → re-invoke replace-set
- Duplicate admit → idempotent replace-set
- Never re-tag press from `article_summary` alone after body discarded

### Handoff

- Ingestion continues keep-list / summarization / metastory handoff regardless of tag success (pool fail-open).
- Metastory and dashboard consume `story_*` marks; they do not invent chips.

---

## Runtime gap (build phase)

**Target:** Invoked from ingestion on each new story (and X text replace) with constrained model + replace-set + gold.

**Today:** Stage **not shipped**. Schema joins exist; no prompt/evals yet. Do not treat prototype lexical gates as this product SoT.

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
| 28 Oct 2026 | ST-01…14 | Locked rules as tabled; ≤2 retries; vendor concepts ≠ chips |
| 28 Oct 2026 | Stage I/O | **B**; same-tick order flexible until all body consumers done before discard |
| 28 Oct 2026 | Related / Success / Runtime | **B** / **B** / **B** |
| 28 Oct 2026 | Artifact | **Locked** — [story-tagging.md](./story-tagging.md) |
| 28 Oct 2026 | A2′ body custody | ST-14 / Related / Problem aligned to three same-tick consumers (summarization · story-tagging · metastory what-happened) |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| [model--story-tagging--v1.md](../prds/model--story-tagging--v1.md) | Retry + title-only aligned on lock; thicken execution when in build focus |
| prompts / pipelines / evals | Create / thicken when this model is in build focus |
| Runs schema | Landed A4 — [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml) |
