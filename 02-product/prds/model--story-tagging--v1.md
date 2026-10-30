# Story-tagging model — apply shared vocab chips to stories

Mark each stored shared story with every topic, keyword, and geography in Tempo’s shared catalogs that the story text supports. One constrained model call; catalog IDs only.

Status: Draft  
Owner: Felipe  
Update: 28 Oct 26  
Intent: ship  
Execution spec: waived by PM until build focus

**Stub.** Full model stack (prompt, pipeline, runs, evals) — same treatment as other LLM stages. Stage name is **story-tagging** (apply marks to the shared pool). Distinct from **extraction**, which creates user chips and grows catalogs. Prompts / pipelines / evals land when this model is in build focus. Product behavior SoT: locked contract.

**SoT (planned)**

- Product contract: [story-tagging.md](../contracts/story-tagging.md) (locked)
- Prompt: [story-tagging.md](../../06-engineering/docs/prompts/story-tagging.md) (TBD)
- Pipeline: [story-tagging.md](../../06-engineering/docs/pipelines/story-tagging.md) (TBD) — invoked from ingestion
- Runs schema: [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml) (A4 stub)
- Evals: [story-tagging.md](../../06-engineering/docs/evals/story-tagging.md) · [story-tagging.gold.json](../../06-engineering/docs/evals/story-tagging.gold.json)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37) — `story_topics` / `story_keywords` / `story_geographies`

**Siblings**

- Ingestion rules (fetch, keep-list, compliance, clock, invoke): [ingestion.md](../contracts/ingestion.md) (locked) — [IR-08](../contracts/ingestion.md)
- Extraction (user chips + catalog growth): [model--extraction--v1.md](./model--extraction--v1.md)
- Summarization (article summary; not chips): [model--summarization--v1.md](./model--summarization--v1.md)
- Metastory / dashboard consumers: [model--metastory--v1.md](./model--metastory--v1.md) · [dashboard--v1.md](./dashboard--v1.md)

**Locked product rules (process)**

- One call → topics + keywords + geographies (IDs only; no invented chips)
- Aperture = full shared catalogs at invoke time
- Press: title + body in memory on admit; **title only** when body absent; X: `text`; re-tag on IR-14 text change; no press re-tag from article summary alone
- Replace-set into `story_*` joins; fail open for pool; fail closed for inventing chips; ≤2 attempts same invoke
- Keywords: stricter “text supports the match term” bar than topics/geos
- Same-tick with summarization: order flexible; body discarded only after both finish when body present

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Join and chip chrome need durable story↔vocab marks; deterministic match under-tags a growing open lexicon; press body is write-once.

**Why now:** Shared pool + `story_*` schema exist; without an evaluable apply stage, marks stay undefined.

**Gaps:** Contract thicken, prompt, pipeline, runs ERD, eval craft. `PM input required` for SKU.

---

## Goals

- Every new shared story is tagged in one constrained invoke from the richest available text (≤2 attempts).
- Guardrails: catalog IDs only; no lexicon growth from this stage; pool admit not blocked on tag fail; title-only when press body missing.

---

## Solution

### Overview

Stub. Triggered by ingestion on admit (and X text replace). Output = replace-set on `story_topics` / `story_keywords` / `story_geographies` + story-tagging_runs row when schema exists.

### Scope

**In:** Constrained T/K/G story-chip apply, lineage, evals.  
**Out:** User-chip extraction; catalog INSERTs; fetch drains; article summary; metastory writer; dashboard join UX.

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stage named story-tagging | Distinct from extraction “create tags”; applies marks to stories | 28 Oct 26 | Naming conflict |
| Keywords in same model call as topics/geos | One body-in-memory operation; simpler orchestrate/eval | 28 Oct 26 | Keyword soft-match noise in gold |
| Full model stack (not a paragraph in ingestion) | Evaluable consistency; same LLM discipline as summarization | 28 Oct 26 | If rules prove enough in gold |
| Stub PRD + stub contract | Align artifact map before prompt/evals | 28 Oct 26 | Contract lock |
| Contract locked (ST-01…14) | Title-only when no body; ≤2 retries; ST-14 body custody | 28 Oct 26 | Contract change |
| SKU | `PM input required` | 28 Oct 26 | Build focus |
