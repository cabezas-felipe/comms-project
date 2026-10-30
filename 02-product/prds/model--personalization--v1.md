# Personalization model — why this matters and what comes next

Write per-user readiness copy for metastories that remain in that user’s feed: why this matters and what comes next.

Status: Draft  
Owner: Felipe  
Update: 27 Oct 26  
Intent: ship  
Execution spec: waived by PM until product contract locks

**Stub.** Practice-note text and prompt craft come later. Do not invent copy here.

**SoT (planned)**

- Product contract: [personalization.md](../contracts/personalization.md) (locked)
- Prompt: [personalization.md](../../06-engineering/docs/prompts/personalization.md) (TBD) · practice notes (TBD) — **author four function practice notes in Phase B4 with prompt craft, before filling gold** (communications, policy, operations, partnerships)
- Pipeline: [personalization.md](../../06-engineering/docs/pipelines/personalization.md) (TBD)
- Runs schema: [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) (A4 stub)
- Evals: [personalization.md](../../06-engineering/docs/evals/personalization.md) · [personalization.gold.json](../../06-engineering/docs/evals/personalization.gold.json)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)

**Siblings**

- Metastory (shared copy): [metastory.md](../contracts/metastory.md) (locked) · [model--metastory--v1.md](./model--metastory--v1.md)
- Dashboard UX (feed join + meaning): [dashboard--v1.md](./dashboard--v1.md)
- Extraction (function + priorities + stakeholders): [model--extraction--v1.md](./model--extraction--v1.md)

**Locked product rules (process)**

- Why this matters: so-what from function + user priorities + org priorities; does **not** name stakeholders; equips relay of insight
- What comes next: function + priorities + org priorities + stakeholders; non-directive; never send/publish/decide (pp5)
- Fixed practice note per function (communications, policy, operations, partnerships) — notes authored later
- Skip rewrite when inputs unchanged; only personalize metastories still in that user’s feed

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Shared event copy is not enough to act with judgment; the operator needs a so-what and a non-directive next step grounded in their role and stakeholders.

**Why now:** Shared metastory path is defined; personalization is the per-user layer on top.

**Gaps:** Contract, prompts, practice-note text, runs ERD, eval craft. `PM input required` for SKUs.

---

## Goals

- Feed-ranked metastories get why / what next consistent with pp5 and the locked input split.
- Unchanged inputs do not regenerate wording.
- Guardrails: no stakeholder names in why this matters; no prescribe send/publish.

---

## Solution

### Overview

Stub. Input = metastory shared fields + user function/priorities/org priorities/stakeholders + practice note. Output = cached per-user fields on feed membership.

### Scope

**In:** Why this matters, what comes next, practice-note hook, personalization-runs, skip-if-unchanged.  
**Out:** Clustering/shared copy; feed chrome; frozen feed-rank formula math.

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stub PRD | Align artifact map | 27 Oct 26 | Contract draft |
| Practice notes authored later; rule locked | Same as process lock | 27 Oct 26 | First note draft |
| Contract locked (PR-01…13); B4 notes-with-prompt reminder | Skip-if-unchanged; retain history out of feed; block generate until notes | 27 Oct 26 | Contract change |
