# Metastory — product contract

> **Stage:** Metastory · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 3 Nov 2026 (B3 design Locked incl. DB/DBML D-106)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Upstream (locked): [ingestion.md](./ingestion.md) · [summarization.md](./summarization.md) · [story-tagging.md](./story-tagging.md)
- Model PRD: [model--metastory--v1.md](../prds/model--metastory--v1.md)
- Prompts: [metastory-boundary.md](../../06-engineering/docs/prompts/metastory-boundary.md) (Locked D-101) · [metastory-writer.md](../../06-engineering/docs/prompts/metastory-writer.md) (Locked D-103)
- Pipeline: [metastory.md](../../06-engineering/docs/pipelines/metastory.md) (Locked B3 · L1–L7) — embed → propose → deterministic repair → boundary → material gate → writer
- Evals / gold (call-kind only; arbiter-locked): index [metastory.md](../../06-engineering/docs/evals/metastory.md) · [metastory-boundary.md](../../06-engineering/docs/evals/metastory-boundary.md) · [metastory-boundary.gold.json](../../06-engineering/docs/evals/metastory-boundary.gold.json) (18 · D-104) · [metastory-writer.md](../../06-engineering/docs/evals/metastory-writer.md) · [metastory-writer.gold.json](../../06-engineering/docs/evals/metastory-writer.gold.json) (23 · D-105)
- Runs schema: [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) (Locked B3 · D-106) · [dbdiagram](https://dbdiagram.io/d/6ae28fb1ed134e407e37a484) (`call_kind` = boundary \| writer)
- Downstream: [personalization.md](./personalization.md) (locked) · [model--personalization--v1.md](../prds/model--personalization--v1.md) · [dashboard--v1.md](../prds/dashboard--v1.md) (join, feed rank, rising/source-order meaning; UX chrome)
- Transient body posture: [api-newsapi-ai.md](../../06-engineering/docs/api-newsapi-ai.md) (body in memory only; not stored)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Product principles: [principles.md](../principles.md) (esp. pp1, pp2)
- Eng decision (carry): [D-091](../../06-engineering/DECISIONS.md)
- Historical eng notes (not product SoT for new work): [what-changed-spec.md](../../06-engineering/docs/what-changed-spec.md) — product meaning of what changed is this contract

Full LLM stack (prompt / pipeline / runs / evals) lives in eng siblings. No formula math, prompt text, or gold cases here. Ops/metrics detail (D-088, `#ops-pricing-models`) lives on the model PRD + ops SoTs.

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

1. **Input:** Tagged stories from the shared pool (post-ingestion / summarization / story-tagging for this tick). Invoked by ingestion clock/warm **handoff** — not by UX.
2. **Embed text:** Press → title + article summary if present, else title + excerpt if present, else title only. X → post text. Prefer `article_summary` (and other English keep-list fields when present) over raw non-English title/body for model/embed input; never drop a story for source language. Skip re-embed when embed model + text hash unchanged.
3. **Cluster propose** via embeddings among **already admitted** stories (do not admit new ones; `post_download` paraphrase-keep exception only).
4. **Deterministic event-grain repair** (adapted split-healer intent): catch geo-alone over-merges; keep unrelated events split; bundle continuous election-cycle coverage; prefer defer/ambiguous over wrong atomize. Thresholds live in eng siblings.
5. **Boundary check** (model, ≤2 attempts): confirm / split / merge at **event** grain — chips do **not** force merge.
6. **Id stability:** reuse metastory id when the event continues (membership may grow/shrink **+n/−n**); mint id only for new events **after** a successful writer persist (**title + subtitle + what_happened** — [MR-06](#locked-rules) / [D-102](../../06-engineering/DECISIONS.md)); update membership as stories attach/split/merge.
7. **Shared-run material gate:** when a prior shared run exists, cheap deterministic check whether anything material moved (membership + stable stored evidence + prior shared copy). **None** → keep last-good shared copy; do not invent what-changed. First mint → writer must return title + subtitle + what_happened; `what_changed` may be null.
8. **Shared writer** (≤2 attempts): title, subtitle, what happened, what changed.
   - **What happened:** same-tick bodies for **new** press members still in memory + article summaries / X text for others; prior what happened as continuity.
   - **What changed:** prior vs **current** run of that shared view (not per-user last-seen).
   - **Persist rule:** INSERT / keep a `metastories` row only when the writer produced **title + subtitle + what_happened** (all non-empty). **`what_changed` may be null on first mint only**. Never surface incomplete shared cards in the feed (dashboard also filters — B5).
   - **Title wording (eng craft):** prefer prior title text unless rename/rewrite is warranted — not part of id scheme.
9. **On writer failure after retries:**
   - **Existing metastory (last-good exists):** keep **last good** shared text; if boundary/membership already succeeded, **commit membership** and leave copy on last good (partial success).
   - **New event (no last-good):** **do not mint** the `metastories` row and **do not** attach membership; retry next tick — no orphan id, no blank card.
10. **Hand off:** shared metastories + **story membership** (story ↔ metastory) → dashboard **join** / **feed membership** → personalization. Feed chrome / open view → [dashboard--v1.md](../prds/dashboard--v1.md).

Press keep-list reminder: when a body was summarized, Tempo stores **title + article summary** (+ metadata + URL); nullable **`excerpt`** only if a true outlet/feed teaser ever exists (NewsAPI → usually NULL). Body is never stored. Article summary is also the source-reader snippet ([SR-07](./summarization.md)).

### Explicit product lines

- Rising / feed rank / source order / beat-fit pre-cluster / feed overflow caps / user-refresh watermark → [dashboard--v1.md](../prds/dashboard--v1.md) (not live model labels here)
- Why this matters / what comes next → personalization
- Prompt / similarity thresholds / gold → eng siblings in B3; embed → [D-094](../../06-engineering/DECISIONS.md); boundary/writer SKUs → [D-095](../../06-engineering/DECISIONS.md) (Sonnet 5.5 only)

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Same real-world event keeps one metastory id; shared what happened / what changed stay trustworthy as coverage grows |
| **Early signal** | Low id churn across ticks; boundary and writer each succeed within ≤2 attempts or last-good held; new mint only after title+subtitle+what_happened; membership can commit with last-good copy lag only when last-good exists |
| **Guardrail** | No body stored; no chip-forced merges; what changed ≠ per-user last-seen — failure-mode detail in evals later |

Thin PostHog `metastory_invoke` is **specified** on the [model PRD](../prds/model--metastory--v1.md) under [D-088](../../06-engineering/DECISIONS.md) (per `call_kind` boundary \| writer; not instrumented until build). This contract does not invent further product analytics event names.

---

## Scope

### In

- Embed eligible text; cluster propose; **deterministic event-grain repair**; boundary; **metastory id** stability + **story membership** (story ↔ metastory)
- **Shared-run material gate** before writer (when prior run exists)
- Shared title, **subtitle**, what happened, what changed (prior vs current run)
- Same-tick body read for new press members; English shared **outputs** (MVP); boundary and writer each ≤2 attempts; last-good on writer fail when it exists; new mint requires **title + subtitle + what_happened**; partial success = membership + last-good only when last-good exists
- Embed fallback (title + article summary else title + excerpt if any else title; X = post text); prefer `article_summary` / English keep-list fields for model input when present
- Lineage: [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) (`call_kind` boundary \| writer; embed/cluster-propose are not run rows)

### Out / non-goals

- Fetch, drains, compliance ([ingestion.md](./ingestion.md)); story-chip apply ([story-tagging.md](./story-tagging.md)); summarization prompts
- Inventing chips; merging solely because chips match
- Why this matters / what comes next / practice notes
- User join / **feed membership** (source ∧ ≥1 chip); feed ranking; rising/source-order **formulas**; live rising labels from this stage
- Beat-fit pre-cluster / cluster input cap; feed overflow / thin-on-beat caps; user-refresh watermark
- Per-user “what changed since you looked”
- Storing publisher body; scraping the article URL; owning a translator stage
- Prompt text, similarity-threshold math, gold cases in this doc (embed dims locked in pipeline/DBML — D-094)
- Dual-maintaining product meaning in legacy [what-changed-spec.md](../../06-engineering/docs/what-changed-spec.md)
- UX triggers or operator-facing chrome (dashboard owns display)

---

## Locked rules

| ID | Rule |
|----|------|
| **MR-01** | **Event grain** — cluster as real-world **events**, not topic buckets or single-incident micro-slices |
| **MR-02** | **Chips ≠ identity** — shared tags do not by themselves merge stories into one metastory |
| **MR-03** | **Embeddings do not admit** — group only already-retrieved stories; exception: `post_download` paraphrase keep |
| **MR-04** | **Embed text** — press: title + article summary if present, else title + excerpt if present, else title only; X: post text |
| **MR-05** | **Id stability + boundary** — preserve **metastory id** across runs when the event continues (**membership may grow/shrink +n/−n** without forcing a new id); mint only for new events **after a successful writer persist** (**title + subtitle + what_happened** per [MR-06](#locked-rules) / [D-102](../../06-engineering/DECISIONS.md)); **story membership** updates as stories attach/split/merge under boundary. New event + writer fail both attempts → no row, no membership. Membership SoT = `metastory_stories`: soft detach; re-attach to same pair **resurrects**; concurrent current M:N allowed; pool leave (`stories.removed_at`) sets `detached_at` |
| **MR-06** | **Shared copy** — title, subtitle, what happened, what changed are **shared** (same for all users who see that metastory). **Successful persist requires title + subtitle + what_happened** (non-empty). **`what_changed` null only on first mint** (expected); later runs write it when the material gate invokes the writer. Empty required fields → fail attempt, do not mint/overwrite as success ([D-102](../../06-engineering/DECISIONS.md)) |
| **MR-07** | **English outputs (MVP)** — shared title / subtitle / what happened / what changed in English. Source language does **not** gate membership; prefer `article_summary` (and other English keep-list fields when present) over raw non-English title/body for model/embed input |
| **MR-08** | **What happened inputs** — same-tick bodies for **new** press members still in memory; article summaries / X text / prior what happened for continuity; never store body |
| **MR-09** | **What changed** — prior vs **current** run of that shared view — not per-user last-seen |
| **MR-10** | **Generative retry** — **boundary** and **writer** each ≤2 attempts per invoke (independent `trigger_id`s; see [metastory-runs](../../06-engineering/docs/data/metastory-runs.dbml) `call_kind`). On final **writer** fail keep **last good** shared text when it exists. Partial success (membership + last-good) **only** if last-good exists; otherwise fail closed for mint. On final **boundary** fail → keep prior metastory graph if any; do not invent merges |
| **MR-11** | **No body retention / no URL scrape** — after this stage’s same-tick what-happened read (if any), body discard still waits until **all** same-tick consumers finish: summarization (if invoked) + story-tagging + this what-happened path ([IR-05](./ingestion.md)); do not open publisher URL |
| **MR-12** | **Not live posture labels** — rising/stable/falling are not model outputs here; feed/source rank owned by dashboard |
| **MR-13** | **Lineage** — [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml); one row per LLM attempt; `call_kind` = boundary \| writer; embed / cluster-propose out of runs |

---

## Stage I/O

### Inputs

- Tagged shared stories for this tick (press + X) with keep-list fields + chips (chips may be empty)
- Press: title, article summary (if any), excerpt (if any — usually NULL on NewsAPI), metadata; **body in memory only for new URIs this tick**
- X: post text + metadata (any language)
- Prefer `article_summary` / English keep-list fields for model/embed input when present; never drop a story for source language
- Prior metastory rows: ids, membership, last shared copy
- Clock / warm orchestration signal (via ingestion path) — **not** a UX trigger

### Outputs

- **Metastory ids** (stable or new)
- **Story membership:** story ↔ metastory
- Shared fields: title, subtitle, what happened, what changed
- Success / degraded signal; metastory-run lineage when schema exists

### Edges

- Empty pool → no metastories invented
- Embed/cluster fail → keep prior metastory graph if any; do not admit by similarity from outside the pool
- Boundary fail after ≤2 attempts → keep prior metastory graph if any; do not invent merges / new membership from a failed boundary
- Material gate **none** (prior run exists) → keep last-good shared copy; do not invent what-changed
- Writer fail after ≤2 attempts → if **last good** exists: keep it; if boundary/story membership succeeded, **commit story membership** (copy may lag one tick). If **new** event with no last-good: **no** `metastories` row, **no** membership
- No article summary → embed title (+ excerpt if present); what happened may be thinner
- Split/merge → id rules per MR-05; no chip-forced merge; +n/−n membership OK when event continues
- Body absent for new press → no same-tick body path; use summary (or title/excerpt) only
- After same-tick what-happened use, ingestion orchestrator discards body only when summarization (if invoked) + story-tagging + this what-happened path have all finished (never stored) — [IR-05](./ingestion.md)

### Handoff

- Join → **feed membership** + feed rank + rising/source-order meaning → [dashboard--v1.md](../prds/dashboard--v1.md)
- Why this matters / what comes next → [personalization.md](./personalization.md)

---

## Runtime gap (build phase)

**Target:** Embed → cluster propose → deterministic event-grain repair → boundary → id/membership → shared-run material gate → shared writer, orchestrated on the shared clock / warm via ingestion handoff (with summarization / story-tagging same-tick as applicable).

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
| 28 Oct 2026 | Mint / title | INSERT only after successful writer persist; **amended D-102:** require title+subtitle+what_happened (not title alone); new event + writer fail → no row/membership; partial success only when last-good exists; no archive col / copy-hash in v0 |
| 28 Oct 2026 | `metastory_stories` | Soft M:N; resurrect on re-attach; `attached_at` = current spell; concurrent current membership OK; reverse `story_id` index; pool remove → detach; no `end_reason` in v0 |
| 28 Oct 2026 | A2′ body custody | MR-11 / edges: orchestrator discards only after summarization + story-tagging + this stage’s same-tick read |
| 28 Oct 2026 | Boundary ≤2 + craft split | MR-10 covers boundary + writer retries; prompts/evals split by call kind; runs ERD landed |
| 28 Oct 2026 | Related links | Point at boundary/writer prompts + evals + [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) (no monolithic `prompts/metastory.md`) |
| 3 Nov 2026 | MVP carry-over | As-is→to-be posture locked P1–P11 — encoded in [pipelines/metastory.md](../../06-engineering/docs/pipelines/metastory.md) + prompt/eval stubs; Eng: [D-091](../../06-engineering/DECISIONS.md) |
| 3 Nov 2026 | B3 X1–X4 | UX **A** (no UX trigger; chrome → dashboard); Data **A**; Ops **A** (`#ops-pricing-models`; embed SKU+N → pipeline/DBML); Metrics **B** (D-088 `metastory_invoke` per `call_kind`) |
| 3 Nov 2026 | B3 contract C1–C10 | Shell refresh **B** posture; Related **A**; Purpose unchanged; Happy path + Scope + Runtime aligned to repair + material gate; Success analytics line → D-088; MR-05/07 clarify **B**; I/O **A** with article_summary input preference wording |
| 3 Nov 2026 | B3 L2 / D-094 | Embed **`text-embedding-3-small` / `vector(1536)`**; pricing catalog = to-be inventory only |
| 3 Nov 2026 | B3 L3a / D-095 | Boundary+writer **`claude-sonnet-5-5` only** (same-SKU retry; no Opus escalate) |
| 3 Nov 2026 | B3 L3b / D-096 | Propose **0.65** · split Jaccard **0.22** · drop election-bundle Jaccard (continuity = boundary+gold) |
| 3 Nov 2026 | B3 L4 / D-097 | Membership uncapped; LLM evidence cap **12**; composite rank; UI source-list → dashboard |
| 3 Nov 2026 | B3 L5 / D-098 | `trigger_kind` = `clock` \| `warm` only; IR-14 does not invoke metastory |
| 3 Nov 2026 | B3 L6 / D-099 | Mermaid + idempotency keys (embed/boundary/writer skips; input_hash as sent) |
| 3 Nov 2026 | B3 L7 / D-100 | Ops bag budget + deferred recluster **parked** for MVP |
| 3 Nov 2026 | B3 boundary prompt D-101 | `metastory-boundary-v1` Locked (JSON judge; R1–R3) |
| 3 Nov 2026 | B3 D-102 | MR-06: successful persist requires title+subtitle+what_happened; what_changed null only first mint; feed completeness + ≤5 → dashboard |
| 3 Nov 2026 | B3 writer prompt D-103 | `metastory-writer-v1` Locked (JSON copy; W1–W3) |
| 3 Nov 2026 | B3 gold D-104 · D-105 | Boundary + writer gold arbiter-locked |
| 3 Nov 2026 | B3 DB/DBML D-106 | `tempo.dbml` §§8–9 + `metastory-runs.dbml` review Locked — no column changes; runs Status Locked B3 |
| 3 Nov 2026 | B3 D-107 | Writer optional `same_tick_body` for new press (MR-08 / IR-05); boundary stays body-free; eng prompts/pipeline aligned |
| 5 Nov 2026 | d05 soft lengths (stub) | Why-primary hierarchy: what_happened **1–2 / ~250–350**; what_changed **1–2 / ~200–300** (soft/advisory). Why / what-next owned by personalization. Stubbed then thickened same day. |
| 5 Nov 2026 | d05 length fold | Soft bars folded into [metastory-writer](../../06-engineering/docs/prompts/metastory-writer.md) §5 + eval advisory; keep `metastory-writer-v1` (pre-runtime). Do not treat archived summary-longest doctrine as live SoT. |
| 5 Nov 2026 | d05 gold thicken | Evidence-earned B′ on writer gold + carve-outs stay thin; soft length advisory only |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| Model PRD | [model--metastory--v1.md](../prds/model--metastory--v1.md) — **B3 Locked** |
| Pipeline | [pipelines/metastory.md](../../06-engineering/docs/pipelines/metastory.md) — **L1–L9 Locked** (incl. 15s timeout / concurrency / PostHog / `same_tick_body` D-107) |
| Prompts / gold | [metastory-boundary](../../06-engineering/docs/prompts/metastory-boundary.md) · [metastory-writer](../../06-engineering/docs/prompts/metastory-writer.md) (d05 soft length in system rules) · gold arbiter-locked (D-104 / D-105) + d05 thicken 5 Nov 2026 |
| Runs schema | [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) **Locked B3** (D-106) |
| Ops revisit | Parked D-100 (budget · deferred recluster); skip → D-099 — [pipeline §7](../../06-engineering/docs/pipelines/metastory.md#7-ops-revisit-bag) |
| Build | Wire runtime path; do not port `cluster-v4` |
| B5 | Share-pack chrome |
