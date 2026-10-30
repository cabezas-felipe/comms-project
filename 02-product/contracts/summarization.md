# Summarization — product contract

> **Stage:** Summarization · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 28 Oct 2026 (A2′ body custody + story-tagging)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Invoke owner: [ingestion.md](./ingestion.md) (locked)
- Model PRD: [model--summarization--v1.md](../prds/model--summarization--v1.md)
- Prompt (TBD): [summarization.md](../../06-engineering/docs/prompts/summarization.md)
- Pipeline (stub): [summarization.md](../../06-engineering/docs/pipelines/summarization.md)
- Evals / gold (stubs): [summarization.md](../../06-engineering/docs/evals/summarization.md) · [summarization.gold.json](../../06-engineering/docs/evals/summarization.gold.json)
- Runs schema: [summarization-runs.dbml](../../06-engineering/docs/data/summarization-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/6ae28ffced134e407e37a6d0)
- Parallel same-tick stage: [story-tagging.md](./story-tagging.md) (locked) — chips; body discard only after all same-tick consumers finish when body is present ([IR-05](./ingestion.md))
- Downstream consumer: [metastory.md](./metastory.md) (locked) · [model--metastory--v1.md](../prds/model--metastory--v1.md) · [dashboard--v1.md](../prds/dashboard--v1.md) (source-reader snippet)
- Vendor body posture: [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) (`articleBodyLen` transient; body not stored)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Product principles: [principles.md](../principles.md) (esp. pp1)

Full LLM stack (prompt / pipeline / runs / evals) lives in eng siblings. This contract owns product meaning — not prompt text or gold cases.

---

## Purpose

For each new press URI, while the vendor body is in memory only, write one factual English **article summary** (who/what/where/when as the article reports them — not why it matters). Persist that summary for clustering, later refreshes, and the **source-reader snippet**. Body discard is owned by the **ingestion orchestrator** after all same-tick consumers finish ([IR-05](./ingestion.md)) — not by this stage alone. X posts are not summarized — post text is the record. Invoked by ingestion; this stage owns the summary’s product meaning and LLM stack, not fetch, story-tagging, or metastory copy.

---

## Who it’s for

Solo bilateral / institutional comms operators ([pp1](../principles.md)). They need to **scan** a source in-app before acting. NewsAPI.ai does not return a publisher excerpt, so the article summary is both the clustering stand-in and the **source-reader snippet** (labeled as Tempo’s summary — not the article — with Open original).

---

## Problem

Metastory grouping and refresh need more than a headline, and operators need a scannable snippet in d08 / source reader — but Tempo must not retain publisher bodies, and NewsAPI.ai has **no excerpt field** (only `body`, optionally truncated in-place via `articleBodyLen`). Without one factual, English, Tempo-owned **article summary** per press URI (when a body was available), the pool is too thin for clustering **and** in-app scan is title-only. X already has full post text — it must not be run through this stage.

---

## Solution (target)

### Happy path

1. **Trigger:** Ingestion signals a **new** press `uri` with vendor body present **in memory only** (clock or warm).
2. **Skip:** X posts; press URIs that already have an article summary; invokes with **no body** → do not run; do not invent from title/excerpt alone.
3. **Generate:** One LLM call with **title + body** for a factual English article summary (who/what/where/when as reported — not so-what). On failure, **one** automatic retry in the same invoke while the body remains in memory (2 attempts total).
4. **Validate:** Structured/product checks (non-empty; policy bars as eng defines) — no prompt text in this contract.
5. **Persist:** Write **article summary** for that `uri` (+ summarization-run lineage when the runs schema exists).
6. **Body custody:** Never store, log, or show the body. Summarization releases the body back to the **ingestion orchestrator**, which keeps it **in memory for the same tick** until **story-tagging** and same-tick **metastory what-happened** (if any) also finish ([ST-14](./story-tagging.md) · [MR-08](./metastory.md) · [IR-05](./ingestion.md)); the orchestrator then discards it. Summarization must not assume it is the final discard point.
7. **Return:** Success or failure to ingestion (failure → keep-list without summary; pool tick continues; source reader shows title + meta + Open original only).

### Explicit product lines

- **Source-reader snippet** — when present, article summary is the d08 / source-reader snippet for press; chrome must label it as **Tempo’s summary** (not the article) and keep **Open original** as the path to the publisher piece ([source-reader](../../03-design/design-system/patterns/source-reader.md)).
- **One article summary per `uri`** — when present, title + article summary are what later stages embed/cluster on for press **and** what the source reader shows as snippet.
- **No body → no invoke** — metastory may embed title (+ excerpt if ever present) when article summary is absent; that fallback locks in [metastory.md](./metastory.md). Source reader then has no snippet.
- **Provider must not train** on the body.
- Prompt / SKU / gold → eng siblings after this contract locks.

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Press URIs that had a body in memory get a usable English article summary for metastory / embed **and** in-app scan |
| **Early signal** | Same-tick success within ≤2 attempts; body never persisted |
| **Guardrail** | No so-what voice; no body echo into storage/UI; summary never presented as the article itself — disclosure + Open original — failure-mode detail in evals later |

Operational / qualitative only for v1 — no invented analytics event names until instrumentation locks.

---

## Scope

### In

- Factual English **article summary** for new press `uri`s from transient body (title + body as model input)
- Same-invoke retry (max 2 attempts); never retain body (orchestrator discard after same-tick consumers)
- Product rules: who/what/where/when; source-reader snippet (labeled); one summary per `uri`; no-train on body; no URL scrape for body
- Stage I/O; expectation of prompt / pipeline / **summarization-runs** / evals siblings (artifacts may still be TBD)

### Out / non-goals

- X post summarization
- Title/excerpt-only invoke when body is missing (no substitute summary without body)
- Fetch, drains, compliance ([ingestion.md](./ingestion.md)); story chips ([story-tagging.md](./story-tagging.md))
- Metastory title / what happened / what changed / clustering / embed fallback rules (beyond the handoff note)
- Why this matters / what comes next
- Presenting article summary **as** the article (vs labeled Tempo summary + Open original)
- Storing, logging, or displaying publisher body
- Filling `excerpt` from truncated vendor `body` / `articleBodyLen`
- Scraping the article URL to obtain body
- Cross-tick / backfill summarization retry (MVP)
- Prompt text, formula math, gold cases in this doc
- Keyword/concept drain language D (ingestion retrieval)

---

## Locked rules

| ID | Rule |
|----|------|
| **SR-01** | **Press only** — run for new press `uri`s with body in memory; **X is never summarized** |
| **SR-02** | **Transient body** — body used in memory only; never store, log, or show; provider must not train on it. Same-tick **story-tagging** and **metastory what-happened** may still read the body via the ingestion orchestrator before final discard ([ST-14](./story-tagging.md) · [MR-08](./metastory.md) · [IR-05](./ingestion.md)) |
| **SR-03** | **Factual frame** — who/what/where/when as the article reports; **not** why this matters / so-what / what comes next |
| **SR-04** | **English (MVP)** — article summary is English even when the body is not |
| **SR-05** | **One per `uri`** — at most one stored article summary; do not invent if body absent or both attempts fail |
| **SR-06** | **Same-invoke retry** — at most **one** automatic retry (2 attempts total) while body remains in memory; **no** cross-tick / backfill retry in MVP |
| **SR-07** | **Source-reader snippet** — when present, article summary is the press snippet in d08 / source reader; must be labeled as Tempo’s summary (not the article); Open original remains required. Supersedes the prior “internal only / title+excerpt chrome” lock (28 Oct 2026) |
| **SR-08** | **Downstream use** — when present, title + article summary are what later stages embed / cluster on for press (metastory owns how; may use title + excerpt if summary absent and excerpt ever present) |
| **SR-09** | **Invoke owner** — ingestion triggers; summarization owns summary meaning + LLM stack (prompt/pipeline/runs/evals) |
| **SR-10** | **No URL scrape** — do not open the publisher URL to obtain body |
| **SR-11** | **Lineage** — [summarization-runs.dbml](../../06-engineering/docs/data/summarization-runs.dbml); one row per LLM attempt; skip/no-model paths insert no row |

---

## Stage I/O

### Inputs

- Press `uri` (new to summarization / missing article summary)
- **Title + body** (body required to invoke)
- Invoke signal from ingestion (clock or warm path)

### Outputs

- Article summary string for that `uri` (English, factual)
- Success / failure signal to ingestion
- Summarization-run lineage when schema exists

### Edges

- No body → **skip**; no invented summary; no excerpt-only invoke
- X → never invoked
- Attempt 1 fail → one retry; both fail → failure signal; no summary stored; body still held by orchestrator for other same-tick consumers until IR-05 discard
- Validation fail after model returns → treat as failure (retry once if attempts remain)
- Already has article summary → idempotent skip
- Fail closed for **body retention** and for **inventing** a summary — not for admitting the URI to the shared pool (ingestion fail-open)

### Handoff

- Ingestion continues story-tagging invoke and pool persistence regardless of summarization success ([IR-08](./ingestion.md) · [story-tagging.md](./story-tagging.md), keep-list).
- Metastory may embed **title** (+ **excerpt** only if a true outlet/feed teaser is ever present) when article summary is absent — detail locks in [metastory.md](./metastory.md).
- Source reader with no article summary → title + outlet/author/time + Open original (no invented snippet).

---

## Runtime gap (build phase)

**Target:** Invoked from ingestion on each new press `uri` with body in memory; persist article summary; orchestrator discards body after same-tick consumers; source reader uses article summary as snippet.

**Today:** Article-summary stage is **not shipped**. Do not treat RSS / prototype paths as producing article summaries. Build against this contract + [pipelines/summarization.md](../../06-engineering/docs/pipelines/summarization.md) once prompt/evals land.

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 26–27 Oct 2026 | Process (plan thread) | Transient body → factual stand-in; X not summarized; embed title + summary |
| 27 Oct 2026 | Charter | LLM stage contract **A**; field name **article summary**; full LLM stack in eng siblings |
| 27 Oct 2026 | Fail posture | Fail closed for body + inventing summary; fail open for URI admit (align ingestion) |
| 27 Oct 2026 | Retry | **B** — one same-invoke retry; no cross-tick retry MVP |
| 27 Oct 2026 | Language | English article summary (MVP), even if body is not |
| 27 Oct 2026 | Chip tagging | Not owned here — [story-tagging.md](./story-tagging.md) via ingestion IR-08 |
| 28 Oct 2026 | Story-tagging stage | Sibling LLM stage stubbed; summarization still does not own chips |
| 27 Oct 2026 | Keep-list reminder | Press: article summary (+ nullable excerpt reserved); X: full text |
| 27 Oct 2026 | Purpose / Who / Problem | **B** / **A** / **B** |
| 27 Oct 2026 | Solution / Scope | Happy path **B**; In/Out **B**; runs lineage In as expectation |
| 27 Oct 2026 | SR-01…11 | Locked rules as tabled (SR-07 later superseded) |
| 27 Oct 2026 | Stage I/O | Title + body; no excerpt-only invoke; metastory excerpt fallback note |
| 27 Oct 2026 | Related / Success / Runtime | **B** / **B** / **B** |
| 27 Oct 2026 | Artifact | **Locked** — [summarization.md](./summarization.md) |
| 27 Oct 2026 | A2 | Same-tick body custody → orchestrator / metastory; not immediate discard inside summarization alone |
| 28 Oct 2026 | NewsAPI excerpt | Vendor has **no** separate excerpt field; `articleBodyLen` only truncates `body` — do not persist truncated body as excerpt |
| 28 Oct 2026 | **SR-07 supersede** | Article summary is source-reader snippet (labeled Tempo summary + Open original); overrides prior internal-only chrome |
| 28 Oct 2026 | A2′ body custody | Same-tick consumers = summarization + story-tagging + metastory what-happened; SR-02 / happy path / purpose point to IR-05 |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| [prompts/summarization.md](../../06-engineering/docs/prompts/summarization.md) | Phase B2 |
| Thicken [model--summarization--v1.md](../prds/model--summarization--v1.md) | Fail-posture already aligned; thicken execution later |
| Runs schema | Landed A4 — [summarization-runs.dbml](../../06-engineering/docs/data/summarization-runs.dbml) |
