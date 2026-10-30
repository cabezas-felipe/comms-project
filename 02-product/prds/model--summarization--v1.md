# Summarization model — factual article summary at ingest

Write one factual Tempo article summary per new press URI from the vendor body in memory, then discard the body. The summary is stored for clustering / later refreshes and is the **source-reader snippet** (labeled as Tempo’s summary).

Status: Draft  
Owner: Felipe  
Update: 28 Oct 26  
Intent: ship  
Execution spec: waived by PM until product contract locks

**Stub.** Full model stack (contract, prompt, pipeline, runs, evals) — same treatment as other LLM stages. Stage name is **summarization** (standard NLP job name). Stored field: **article summary** (avoid bare “summary,” which collides with Paper’s what-happened Summary). X posts are **not** summarized; post text is the record.

**SoT (planned)**

- Product contract: [summarization.md](../contracts/summarization.md) (locked)
- Prompt: [summarization.md](../../06-engineering/docs/prompts/summarization.md) (TBD)
- Pipeline: [summarization.md](../../06-engineering/docs/pipelines/summarization.md) (TBD) — invoked from ingestion
- Runs schema: [summarization-runs.dbml](../../06-engineering/docs/data/summarization-runs.dbml) (A4 stub)
- Evals: [summarization.md](../../06-engineering/docs/evals/summarization.md) · [summarization.gold.json](../../06-engineering/docs/evals/summarization.gold.json)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)

**Siblings**

- Ingestion rules (fetch, keep-list, compliance, tags, clock): [ingestion.md](../contracts/ingestion.md) (locked)
- Metastory consumer of article summaries: [model--metastory--v1.md](./model--metastory--v1.md)
- Dashboard: [dashboard--v1.md](./dashboard--v1.md)

**Locked product rules (process)**

- Who/what/where/when as the article reports them — not why this matters
- Body never stored, logged, or shown; provider must not train on it
- Source reader snippet = article summary when present (labeled Tempo summary + Open original); no NewsAPI excerpt today ([SR-07](../contracts/summarization.md))
- One article summary per URI; embed title + article summary
- Never fill keep-list `excerpt` from truncated vendor `body`

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Metastory grouping and in-app source scan need more than a headline, without retaining publisher bodies — and NewsAPI.ai provides no excerpt field.

**Why now:** Keep-list + source-reader locks require a durable Tempo-owned stand-in for the body.

**Gaps:** Contract, prompt, pipeline, runs, eval craft. `PM input required` for SKU.

---

## Goals

- Every new press URI **with body in memory** gets one factual English article summary before the body is dropped (≤2 attempts same invoke).
- Guardrails: no so-what; summary never presented **as** the article (must be labeled + Open original); **fail closed** for body retention and for inventing a summary; **fail open** for admitting the URI (keep-list without summary — ingestion). No body → skip (no title/excerpt-only invoke).

---

## Solution

### Overview

Stub. Triggered on new press URI during ingestion. Output = stored article-summary field + summarization_runs row.

### Scope

**In:** Press article summarization, lineage, evals.  
**Out:** X post text; shared metastory writer; fetch drains; story-chip apply ([model--story-tagging--v1.md](./model--story-tagging--v1.md)).

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stage named summarization; field article summary | NLP-standard stage; avoid “brief” (capital-brief collision) and bare “summary” (UI what-happened) | 27 Oct 26 | Naming conflict in Paper/DB |
| Full model stack (own pipeline, not only a paragraph in ingestion) | Stored text other models depend on; same LLM discipline as extraction | 27 Oct 26 | If summarization proves trivial deterministic |
| Stub PRD created pending contract | Align artifact map | 27 Oct 26 | Contract draft |
| Fail posture aligned to contract | Fail closed body + no invent; fail open URI; no excerpt-only invoke; English MVP; 1 same-invoke retry | 27 Oct 26 | Contract change |
| SR-07: summary = source-reader snippet | NewsAPI has no excerpt; operators need in-app scan | 28 Oct 26 | Counsel / UX copy fail |
