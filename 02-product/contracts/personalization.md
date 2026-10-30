# Personalization — product contract

> **Stage:** Personalization · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 28 Oct 2026 (feed membership UI gate; resurrect)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Upstream shared copy: [metastory.md](./metastory.md) (locked)
- Profile / user scope chips: [extraction.md](./extraction.md) (locked) · [model--extraction--v1.md](../prds/model--extraction--v1.md)
- Warm / clock orchestration: [ingestion.md](./ingestion.md) (locked)
- Model PRD: [model--personalization--v1.md](../prds/model--personalization--v1.md)
- Prompt (TBD): [personalization.md](../../06-engineering/docs/prompts/personalization.md)
- Practice notes (TBD): authored in **Phase B4 with prompt craft**, before gold — not in this contract
- Pipeline (TBD): [personalization.md](../../06-engineering/docs/pipelines/personalization.md)
- Evals / gold (stubs): [personalization.md](../../06-engineering/docs/evals/personalization.md) · [personalization.gold.json](../../06-engineering/docs/evals/personalization.gold.json)
- Runs schema: [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/6ae28fcfaac33014104ead45)
- Feed join / rank / chip chrome: [dashboard--v1.md](../prds/dashboard--v1.md)
- Product principles: [principles.md](../principles.md) (esp. pp1, pp5)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Historical only (not live SoT): [why-this-matters--field-doctrine.md](./archive/why-this-matters--field-doctrine.md)

Full LLM stack lives in eng siblings. No formula math, prompt text, practice-note prose, or gold cases here.

---

## Purpose

For each metastory that remains in the user’s feed after join, write per-user **why this matters** and **what comes next** in English: ground in shared metastory text (including what happened / what changed), shape with function, priorities, org priorities, practice note, and (for what comes next) stakeholders. Skip regeneration when those inputs are unchanged. Do not own join, feed rank, shared metastory copy, or practice-note authorship in this doc.

---

## Who it’s for

Solo bilateral / institutional comms operators ([pp1](../principles.md)).

---

## Problem

Shared metastory copy explains the event, not what it means for *this* operator’s readiness. Without why this matters and what comes next — grounded in what happened, shaped by function/priorities/(stakeholders), constrained by [pp5](../principles.md) and a fixed practice note — the user re-does analytical judgment every refresh, or Tempo drifts into prescribing actions.

---

## Solution (target)

### Happy path

1. **Gate:** Only metastories in this user’s **feed membership** after **join** (source ∧ ≥1 chip — join owned by dashboard; personalization consumes the member set).
2. **Load grounding:** Shared title, subtitle, what happened, what changed (source list as needed).
3. **Load profile:** Function, personal priorities, org priorities; stakeholders **only** for what comes next; fixed **practice note** for that function (not live-fetched).
4. **Skip:** If cache-key input classes unchanged since last success → keep stored why / what-next; no model call.
5. **Generate** (≤2 attempts): English why this matters + what comes next per locked input/output rules.
6. **Persist** on user↔metastory **feed membership** (+ personalization-run lineage when schema exists).
7. **On final fail:** keep **last good** per-user copy; do not blank the open story.

### Input kinds

| Kind | Fields | Role |
|------|--------|------|
| **Grounding (shared)** | Title, subtitle, what happened, what changed (+ source list as needed) | What the model **reads** about this event |
| **Profile (per-user)** | Function + personal priorities + org priorities; stakeholders for what comes next only; practice note | How to frame readiness for this operator |
| **Output constraints** | — | Must not retell grounding; must not name stakeholders in why; must not prescribe send/publish/decide |

### Explicit product lines

- Practice-note **text** → Phase B4 with prompt (before gold)
- Feed order / rising / source order / chip chrome → dashboard
- Out of feed → **no new generate**; prior personalizations **retained** for traceability; not shown in UI

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Feed members get useful readiness copy without prescriptions |
| **Early signal** | Skip hits when inputs unchanged; generate succeeds within ≤2 attempts or last-good held |
| **Guardrail** | No stakeholders in why; no send/publish/decide; no retell of what happened / what changed — failure-mode detail in evals later |

Operational / qualitative only for v1 — no invented analytics event names until instrumentation locks.

---

## Scope

### In

- Why this matters + what comes next for **current** feed members
- Grounding + profile/practice-note split; skip-if-unchanged; English MVP; ≤2 attempts; last-good on fail
- Cache-key **input classes** (algorithm in pipeline)
- Retain prior personalizations when membership ends (traceability); no generate while out of feed
- Lineage: [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) (no row on PR-08 skip)
- Pointer: practice-note text authored in B4 with prompt

### Out / non-goals

- Join predicate; feed rank; rising/source-order formulas; chip display chrome
- Shared metastory writer / clustering / embeddings
- Fetch / summarization / body handling
- Practice-note **prose** in this contract; prompt text; gold cases
- Prescriptive send/publish/decide; stakeholders named in why this matters
- Retelling what happened / what changed as the field body
- Personalizing metastories **not** in the user’s feed (no new generate)
- Hard-deleting prior personalizations when a metastory leaves the feed
- Archived why-this-matters doctrine as live SoT

---

## Locked rules

| ID | Rule |
|----|------|
| **PR-01** | **Feed members only** — personalize only metastories in this user’s **current** feed after join (`user_feed_membership.ended_at IS NULL`); no new generate when out of feed |
| **PR-02** | **Grounding** — model may read shared title, subtitle, what happened, what changed (source list as needed) |
| **PR-03** | **Why this matters inputs** — function + personal priorities + org priorities + practice note; **not** stakeholders |
| **PR-04** | **What comes next inputs** — PR-03 inputs + stakeholders + practice note |
| **PR-05** | **Output: why** — so-what / readiness; must **not** retell what happened/what changed; must **not** name stakeholders; must **not** prescribe send/publish/decide |
| **PR-06** | **Output: what comes next** — prepares a possible step; non-directive ([pp5](../principles.md)); no send/publish/decide |
| **PR-07** | **Practice-note rule** — one fixed note per function (communications, policy, operations, partnerships); not live-looked-up; **text authored in B4 with prompt** |
| **PR-08** | **Skip if unchanged** — if cache-key input classes unchanged since last success, do not regenerate |
| **PR-09** | **Cache-key classes** — one key for both fields: grounding fields used + function + personal priorities + org priorities + stakeholders + practice-note id/version; hash/algorithm in pipeline |
| **PR-10** | **English (MVP)** |
| **PR-11** | **Writer retry** — ≤2 attempts same invoke; on final fail keep **last good** per-user copy |
| **PR-12** | **Lineage + retention** — [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) (attempt rows only; PR-08 skip inserts none); prior personalizations **retained** when membership ends (soft-end). Re-join **resurrects** the same row (clear end; keep copy + cache). UI shows a feed/open card only when why + what-next are present (`personalized_at` set) — never blank copy; new member + writer fail → hide from UI and retry (row may exist for join SoT). No `admitted_at` spell column in v0 |
| **PR-13** | **Not owned here** — join, feed rank, rising/source-order, chip chrome, shared metastory copy |

---

## Stage I/O

### Inputs

- User feed membership set (metastories after join)
- Shared grounding per metastory: title, subtitle, what happened, what changed (+ source list as needed)
- Profile: function, personal priorities, org priorities, stakeholders
- Practice note for function (id/version + text when authored)
- Prior cached why / what-next + last cache-key classes (for skip)
- Clock / warm signal that user path should recompute

### Outputs

- Why this matters + what comes next (English) on user↔metastory **feed membership**
- Skip vs generated flag; personalization-run lineage when schema exists

### Edges

- Not in current **feed membership** → **no new generate**; do not show personalization in UI; **retain** prior rows / runs for traceability
- Skip hit → return cached copy; no model call
- Missing practice-note text (pre-B4) → **block new generates**; last good may remain
- Writer fail after ≤2 → last good copy
- Empty priorities/stakeholders → may still run with function + practice note + grounding; do not invent profile
- Shared copy unchanged but profile changed → regenerate (cache miss)

### Handoff

- **Join** → feed membership / feed rank / rising / user-chip chrome → [dashboard--v1.md](../prds/dashboard--v1.md)
- Shared title / what happened / what changed / **metastory id** → [metastory.md](./metastory.md)

---

## Runtime gap (build phase)

**Target:** Join-gated why / what-next with skip-if-unchanged, practice-note hook, and retention as above.

**Today:** Prototype `whyItMatters` / enrichment paths and [archived field doctrine](./archive/why-this-matters--field-doctrine.md) are **legacy** for product meaning until build matches this contract. Practice-note text is absent until Phase B4.

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 26–27 Oct 2026 | Process (plan thread) | Polished B input split; practice-note rule; skip if unchanged; feed members only |
| 27 Oct 2026 | Charter | Stage contract **A**; dashboard owns join/rank/chips chrome |
| 27 Oct 2026 | Grounding | Shared copy incl. what happened / what changed is explicit model context |
| 27 Oct 2026 | Practice notes | Rule here; **text in B4 with prompt** (before gold); remind on model PRD stub |
| 27 Oct 2026 | Language / retry | English MVP; ≤2 attempts; last good on fail |
| 27 Oct 2026 | Out of feed | No new generate; retain prior personalizations; UI current members only |
| 27 Oct 2026 | Missing notes | Block new generates until B4 notes exist |
| 27 Oct 2026 | Purpose / Who / Problem | **B** / **A** / **A** |
| 27 Oct 2026 | Solution / Scope | Happy path **B**; In/Out **B**; cache-key classes in contract |
| 27 Oct 2026 | PR-01…13 | Locked rules as tabled; one cache key for both fields |
| 27 Oct 2026 | Stage I/O | **B** |
| 27 Oct 2026 | Related / Success / Runtime | **B** / **B** / **B** |
| 27 Oct 2026 | Artifact | **Locked** — [personalization.md](./personalization.md) |
| 27 Oct 2026 | A2 | Feed membership term aligned with dashboard join |
| 28 Oct 2026 | Feed membership SoT | Resurrect on re-join; UI gate on personalized_at; membership may lag copy in DB; no admitted_at in v0 |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| Phase B4 | Practice notes → prompt → eval craft → gold → build |
| Thicken [model--personalization--v1.md](../prds/model--personalization--v1.md) | B4 practice-note reminder already on stub |
| Runs schema | Landed A4 — [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) |
