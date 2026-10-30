# Metastory — product contract

> **Stage:** Metastory · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 28 Oct 2026 (A4 runs + boundary ≤2; prompt/eval split)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Upstream (locked): [ingestion.md](./ingestion.md) · [summarization.md](./summarization.md)
- Model PRD: [model--metastory--v1.md](../prds/model--metastory--v1.md)
- Prompts (stubs): [metastory-boundary.md](../../06-engineering/docs/prompts/metastory-boundary.md) · [metastory-writer.md](../../06-engineering/docs/prompts/metastory-writer.md)
- Pipeline (stub): [metastory.md](../../06-engineering/docs/pipelines/metastory.md) — embed → cluster propose → boundary → writer
- Evals / gold (stubs): index [metastory.md](../../06-engineering/docs/evals/metastory.md) · [metastory-boundary.md](../../06-engineering/docs/evals/metastory-boundary.md) · [metastory-boundary.gold.json](../../06-engineering/docs/evals/metastory-boundary.gold.json) · [metastory-writer.md](../../06-engineering/docs/evals/metastory-writer.md) · [metastory-writer.gold.json](../../06-engineering/docs/evals/metastory-writer.gold.json)
- Runs schema: [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/6ae28fb1ed134e407e37a484) (`call_kind` = boundary \| writer)
- Downstream: [personalization.md](./personalization.md) (locked) · [model--personalization--v1.md](../prds/model--personalization--v1.md) · [dashboard--v1.md](../prds/dashboard--v1.md) (join, feed rank, rising/source-order meaning)
- Transient body posture: [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) (body in memory only; not stored)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Product principles: [principles.md](../principles.md) (esp. pp1, pp2)
- Historical eng notes (not product SoT for new work): [what-changed-spec.md](../../06-engineering/docs/what-changed-spec.md) — product meaning of what changed is this contract

Full LLM stack (prompt / pipeline / runs / evals) lives in eng siblings. No formula math, prompt text, or gold cases here.

---

## Purpose

From tagged stories in the shared pool, form **event-grained** metastories: embed eligible text, propose clusters, apply model boundary checks, preserve metastory ids across refreshes, and write shared title, subtitle, what happened, and what changed (compared to the previous run of that shared view). Shared chips aid retrieval and user join elsewhere — they do **not** by themselves mean two stories are the same metastory. This stage does not own why/what-next, feed join, or rising/source-order formulas.

---

## Who it’s for

Solo bilateral / institutional comms operators ([pp1](../principles.md)). Shared metastory copy is what every viewer of that event sees; personal so-what comes later.

---

## Problem

Coverage of one real-world event arrives as many tagged stories. Without event-grained clustering, stable ids, and shared what happened / what changed (prior vs current run), the operator reconstitutes the narrative on every refresh — and chip overlap alone would falsely merge unrelated events (e.g. different countries’ elections) into one blob.

---

## Solution (target)

### Happy path

1. **Input:** Tagged stories from the shared pool (post-ingestion / summarization for this tick).
2. **Embed text:** Press → title + article summary if present, else title + excerpt if present, else title only. X → post text.
3. **Cluster propose** via embeddings among **already admitted** stories (do not admit new ones; `post_download` paraphrase-keep exception only).
4. **Boundary check** (model, ≤2 attempts): confirm / split / merge at **event** grain — chips do **not** force merge.
5. **Id stability:** reuse metastory id when the event continues; mint id only for new events; update membership as stories attach.
6. **Shared writer** (≤2 attempts): title, subtitle, what happened, what changed.
   - **What happened:** same-tick bodies for **new** press members still in memory + article summaries / X text for others; prior what happened as continuity.
   - **What changed:** prior vs **current** run of that shared view (not per-user last-seen).
   - **Persist rule:** INSERT / keep a `metastories` row only when the writer produced at least a **title** (`title` NOT NULL in SoT). Subtitle may be null. Never surface untitled metastories in the feed.
7. **On writer failure after retries:**
   - **Existing metastory (last-good exists):** keep **last good** shared text; if boundary/membership already succeeded, **commit membership** and leave copy on last good (partial success).
   - **New event (no last-good):** **do not mint** the `metastories` row and **do not** attach membership; retry next tick — no orphan id, no blank card.
8. **Hand off:** shared metastories + **story membership** (story ↔ metastory) → dashboard **join** / **feed membership** → personalization.

Press keep-list reminder: when a body was summarized, Tempo stores **title + article summary** (+ metadata + URL); nullable **`excerpt`** only if a true outlet/feed teaser ever exists (NewsAPI → usually NULL). Body is never stored. Article summary is also the source-reader snippet ([SR-07](./summarization.md)).

### Explicit product lines

- Rising / feed rank / source order → [dashboard--v1.md](../prds/dashboard--v1.md) (not live model labels here)
- Why this matters / what comes next → personalization
- Prompt / similarity thresholds / gold → eng siblings after this contract locks

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Same real-world event keeps one metastory id; shared what happened / what changed stay trustworthy as coverage grows |
| **Early signal** | Low id churn across ticks; boundary and writer each succeed within ≤2 attempts or last-good held; new mint only after title; membership can commit with last-good copy lag only when last-good exists |
| **Guardrail** | No body stored; no chip-forced merges; what changed ≠ per-user last-seen — failure-mode detail in evals later |

Operational / qualitative only for v1 — no invented analytics event names until instrumentation locks.

---

## Scope

### In

- Embed eligible text; cluster propose + boundary; **metastory id** stability + **story membership** (story ↔ metastory)
- Shared title, **subtitle**, what happened, what changed (prior vs current run)
- Same-tick body read for new press members; English shared copy (MVP); boundary and writer each ≤2 attempts; last-good on writer fail when it exists; new mint requires title; partial success = membership + last-good only when last-good exists
- Embed fallback (title + article summary else title + excerpt if any else title; X = post text)
- Lineage: [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) (`call_kind` boundary \| writer; embed/cluster-propose are not run rows)

### Out / non-goals

- Fetch, drains, compliance ([ingestion.md](./ingestion.md)); story-chip apply ([story-tagging.md](./story-tagging.md)); summarization prompts
- Inventing chips; merging solely because chips match
- Why this matters / what comes next / practice notes
- User join / **feed membership** (source ∧ ≥1 chip); feed ranking; rising/source-order **formulas**; live rising labels from this stage
- Per-user “what changed since you looked”
- Storing publisher body; scraping the article URL
- Prompt text, similarity-threshold math, gold cases in this doc
- Dual-maintaining product meaning in legacy [what-changed-spec.md](../../06-engineering/docs/what-changed-spec.md)

---

## Locked rules

| ID | Rule |
|----|------|
| **MR-01** | **Event grain** — cluster as real-world **events**, not topic buckets or single-incident micro-slices |
| **MR-02** | **Chips ≠ identity** — shared tags do not by themselves merge stories into one metastory |
| **MR-03** | **Embeddings do not admit** — group only already-retrieved stories; exception: `post_download` paraphrase keep |
| **MR-04** | **Embed text** — press: title + article summary if present, else title + excerpt if present, else title only; X: post text |
| **MR-05** | **Id stability + boundary** — preserve **metastory id** across runs when the event continues; mint only for new events **after a successful title write**; **story membership** updates as stories attach/split/merge under boundary. New event + writer fail both attempts → no row, no membership. Membership SoT = `metastory_stories`: soft detach; re-attach to same pair **resurrects**; concurrent current M:N allowed; pool leave (`stories.removed_at`) sets `detached_at` |
| **MR-06** | **Shared copy** — title, subtitle, what happened, what changed are **shared** (same for all users who see that metastory). **Title required** on every persisted row; subtitle optional |
| **MR-07** | **English (MVP)** — shared copy in English |
| **MR-08** | **What happened inputs** — same-tick bodies for **new** press members still in memory; article summaries / X text / prior what happened for continuity; never store body |
| **MR-09** | **What changed** — prior vs **current** run of that shared view — not per-user last-seen |
| **MR-10** | **Generative retry** — **boundary** and **writer** each ≤2 attempts per invoke (independent `trigger_id`s; see [metastory-runs](../../06-engineering/docs/data/metastory-runs.dbml) `call_kind`). On final **writer** fail keep **last good** shared text when it exists. Partial success (membership + last-good) **only** if last-good exists; otherwise fail closed for mint. On final **boundary** fail → keep prior metastory graph if any; do not invent merges |
| **MR-11** | **No body retention / no URL scrape** — after this stage’s same-tick what-happened read (if any), body discard still waits for summarization + story-tagging when they share the tick ([IR-05](./ingestion.md)); do not open publisher URL |
| **MR-12** | **Not live posture labels** — rising/stable/falling are not model outputs here; feed/source rank owned by dashboard |
| **MR-13** | **Lineage** — [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml); one row per LLM attempt; `call_kind` = boundary \| writer; embed / cluster-propose out of runs |

---

## Stage I/O

### Inputs

- Tagged shared stories for this tick (press + X) with keep-list fields + chips
- Press: title, article summary (if any), excerpt (if any — usually NULL on NewsAPI), metadata; **body in memory only for new URIs this tick**
- X: post text + metadata
- Prior metastory rows: ids, membership, last shared copy
- Clock / warm orchestration signal (via ingestion path)

### Outputs

- **Metastory ids** (stable or new)
- **Story membership:** story ↔ metastory
- Shared fields: title, subtitle, what happened, what changed
- Success / degraded signal; metastory-run lineage when schema exists

### Edges

- Empty pool → no metastories invented
- Embed/cluster fail → keep prior metastory graph if any; do not admit by similarity from outside the pool
- Boundary fail after ≤2 attempts → keep prior metastory graph if any; do not invent merges / new membership from a failed boundary
- Writer fail after ≤2 attempts → if **last good** exists: keep it; if boundary/story membership succeeded, **commit story membership** (copy may lag one tick). If **new** event with no last-good: **no** `metastories` row, **no** membership
- No article summary → embed title (+ excerpt if present); what happened may be thinner
- Split/merge → id rules per MR-05; no chip-forced merge
- Body absent for new press → no same-tick body path; use summary (or title/excerpt) only
- After same-tick what-happened use, ingestion orchestrator discards body only when summarization + story-tagging have also finished (never stored) — [IR-05](./ingestion.md)

### Handoff

- Join → **feed membership** + feed rank + rising/source-order meaning → [dashboard--v1.md](../prds/dashboard--v1.md)
- Why this matters / what comes next → [personalization.md](./personalization.md)

---

## Runtime gap (build phase)

**Target:** Embed → boundary → stable ids + membership → shared writer as above, orchestrated on the shared clock / warm with ingestion and summarization.

**Today:** Prototype refresh / clustering / [what-changed-spec.md](../../06-engineering/docs/what-changed-spec.md) paths are **legacy** for product meaning until build matches this contract. Do not dual-maintain product rules in those eng docs.

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 26–27 Oct 2026 | Process (plan thread) | Event grain; embeddings do not admit (+ `post_download` exception); shared copy; what changed = prior vs current run; clustering inside metastory |
| 27 Oct 2026 | Charter | Stage contract **A**; tags ≠ metastory identity |
| 27 Oct 2026 | Same-tick body | In-memory for summarization + same-tick what happened for new press; then discard (28 Oct A2′: also wait for story-tagging) |
| 27 Oct 2026 | Embed fallback | Title + article summary else title + excerpt; X = post text (28 Oct: excerpt usually NULL on NewsAPI → title-only fallback) |
| 28 Oct 2026 | Excerpt / UI | Keep-list excerpt reserved only for true teasers; article summary = source-reader snippet (summarization SR-07) |
| 27 Oct 2026 | Writer | ≤2 attempts; last good on fail; partial success = membership commit + last-good copy |
| 27 Oct 2026 | Language | English shared copy (MVP) |
| 27 Oct 2026 | Ranking home | Feed rank / rising / source order → dashboard |
| 27 Oct 2026 | Purpose / Who / Problem | **B** / **A** / **B** |
| 27 Oct 2026 | Solution / Scope | Happy path **B**; In/Out **B**; subtitle In |
| 27 Oct 2026 | MR-01…13 | Locked rules as tabled |
| 27 Oct 2026 | Stage I/O | **B**; partial success **A** |
| 27 Oct 2026 | Related / Success / Runtime | **B** (+ api-newsapi body line) / **B** / **B** |
| 27 Oct 2026 | Artifact | **Locked** — [metastory.md](./metastory.md) |
| 27 Oct 2026 | A2 | Story membership vs feed membership terms; body discard after same-tick use |
| 28 Oct 2026 | Mint / title | `title` NOT NULL; INSERT only after successful title write; new event + writer fail → no row/membership; partial success only when last-good exists; no archive col / copy-hash in v0 |
| 28 Oct 2026 | `metastory_stories` | Soft M:N; resurrect on re-attach; `attached_at` = current spell; concurrent current membership OK; reverse `story_id` index; pool remove → detach; no `end_reason` in v0 |
| 28 Oct 2026 | A2′ body custody | MR-11 / edges: orchestrator discards only after summarization + story-tagging + this stage’s same-tick read |
| 28 Oct 2026 | Boundary ≤2 + craft split | MR-10 covers boundary + writer retries; prompts/evals split by call kind; runs ERD landed |
| 28 Oct 2026 | Related links | Point at boundary/writer prompts + evals + [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) (no monolithic `prompts/metastory.md`) |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| Thicken [model--metastory--v1.md](../prds/model--metastory--v1.md) | Phase B3 |
| Prompt / pipeline / gold bodies | Phase B3 — stubs already split by call kind |
| Runs schema | Landed A4 — [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) |
