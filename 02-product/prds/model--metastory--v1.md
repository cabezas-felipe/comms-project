# Metastory model — cluster and shared event copy

Turn tagged shared stories into stable metastories with shared title, subtitle, what happened, and what changed.

Status: Draft  
Owner: Felipe  
Update: 27 Oct 26  
Intent: ship  
Execution spec: waived by PM until product contract locks

**Stub.** Clustering (embeddings + boundary) and the shared writer live in this stage. Do not invent prompts or thresholds here.

**Thin ship shell.** Behavior SoT will be the product contract; this PRD owns invoke / build sequencing once the contract exists.

**SoT (planned)**

- Product contract: [metastory.md](../contracts/metastory.md) (locked)
- Prompts (stubs): [metastory-boundary.md](../../06-engineering/docs/prompts/metastory-boundary.md) · [metastory-writer.md](../../06-engineering/docs/prompts/metastory-writer.md)
- Pipeline (stub): [metastory.md](../../06-engineering/docs/pipelines/metastory.md)
- Runs schema: [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/6ae28fb1ed134e407e37a484)
- Evals (stubs): index [metastory.md](../../06-engineering/docs/evals/metastory.md) · [metastory-boundary](../../06-engineering/docs/evals/metastory-boundary.md) · [metastory-writer](../../06-engineering/docs/evals/metastory-writer.md)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)

**Siblings**

- Ingestion (rules) + summarization handoff: [ingestion.md](../contracts/ingestion.md) (locked) · [summarization.md](../contracts/summarization.md) (locked) · [model--summarization--v1.md](./model--summarization--v1.md)
- Personalization: [model--personalization--v1.md](./model--personalization--v1.md)
- Dashboard UX: [dashboard--v1.md](./dashboard--v1.md)
- Extraction: [model--extraction--v1.md](./model--extraction--v1.md)

**Includes (this stage)**

- Embeddings over stored press title + article summary (else title + excerpt if any, else title) / X post text (do not admit stories the query missed, except locked `post_download` paraphrase keep)
- Cluster proposal → model boundary check → preserve metastory id across runs
- Shared title, subtitle, what happened, what changed (previous vs current run of that view)
- Rising / stable / falling are **not** live model labels here — frozen score later; product meaning on dashboard

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Many articles and posts about one event fragment attention; the operator needs one durable event object that stays stable as coverage grows.

**Why now:** Shared pool + keep-list + chip tagging are locked; without stable metastories the feed cannot ship.

**Gaps:** Prompt/pipeline/eval **bodies** (stubs + runs ERD landed A4). `PM input required` for model SKUs and similarity thresholds (document later, not invent now).

---

## Goals

- Same event keeps one metastory id across hourly refreshes; new stories attach or split/merge under model boundary rules.
- Shared copy is identical when evidence matches; what changed compares prior vs current run of that view.
- Guardrails: no publisher body stored; no invented chips; fail closed to last good shared text when the writer fails.

---

## Solution

### Overview

Stub. Input = tagged stories in the shared pool. Output = metastory rows + membership + shared fields. Clustering is **inside** this stage, not a separate product contract.

### Scope

**In:** Embeddings, clustering/boundary, shared metastory fields, id stability, metastory-runs lineage.  
**Out:** Fetch/compliance/tagging; per-user why/what next; feed UX; formula weights for rising/source/feed.

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stub PRD; clustering owned here | Embeddings + writer are one metastory stage | 27 Oct 26 | Contract draft |
| What changed = prior vs current run | Product lock; replaces user-relative ever-seen engine | 27 Oct 26 | Eval fails on drift |
| Contract locked (MR-01…13) | Event grain; chips ≠ id; embed fallback; writer ≤2 + last good; partial success A | 27 Oct 26 | Contract change |
