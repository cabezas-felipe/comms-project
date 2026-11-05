# Personalization — product contract

> **Stage:** Personalization · **Altitude:** Product contract (not a PRD) · **Status:** Locked · **Last updated:** 5 Nov 2026 (B4 design Locked · D-110; why-only / PR-14; `personalized_at` = why success)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.  
> **Intent:** ship

**Related**

- Upstream shared copy: [metastory.md](./metastory.md) (locked)
- Profile / user scope chips: [extraction.md](./extraction.md) (locked) · [model--extraction--v1.md](../prds/model--extraction--v1.md)
- Warm / clock orchestration: [ingestion.md](./ingestion.md) (locked)
- Model PRD: [model--personalization--v1.md](../prds/model--personalization--v1.md) (B4 design Locked · build deferred)
- Prompt: [personalization.md](../../06-engineering/docs/prompts/personalization.md) (**Locked** — Pr1–Pr6)
- Practice notes: [practice-notes/](../practice-notes/README.md) (all four F-pass Locked; non-comms 🟠 provisional) · seed [practice-notes.seed.json](../../06-engineering/docs/data/practice-notes.seed.json) v2 · handoff [practice-notes-seed.md](../../06-engineering/docs/data/practice-notes-seed.md) · research [practice-notes--research-brief.md](../practice-notes--research-brief.md) · catalog [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) `practice_notes` — **what comes next only**
- Pipeline: [personalization.md](../../06-engineering/docs/pipelines/personalization.md) (B4 design Locked · D-108 carry · PR-14)
- Evals / gold: [personalization.md](../../06-engineering/docs/evals/personalization.md) · [personalization.gold.json](../../06-engineering/docs/evals/personalization.gold.json) (24 cases; arbiter-locked 5 Nov 2026; advisory until promote)
- Runs schema: [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) (D-109 · D-110) · [dbdiagram](https://dbdiagram.io/d/6ae28fcfaac33014104ead45)
- Feed join / rank / chip chrome / share pack: [dashboard--v1.md](../prds/dashboard--v1.md) (B5 for share package composition)
- Product principles: [principles.md](../principles.md) (esp. pp1, pp5)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Historical only (not live SoT): [why-this-matters--field-doctrine.md](./archive/why-this-matters--field-doctrine.md)

Full LLM stack lives in eng siblings. No formula math, prompt text, practice-note prose, SKU/timeout integers, or gold cases here. Ops/metrics detail (D-088, `#ops-pricing-models`) lives on the model PRD + ops SoTs.

---

## Purpose

For each metastory that remains in the user’s feed after join, write per-user **why this matters** (always when why-inputs exist) and **what comes next** when function + practice note are present — English, normally **one invoke** for both. Ground in shared metastory text (including what happened / what changed). Shape **why** with org priorities and personal priorities for a **share-safe** so-what (suitable to paste with shared fields to contacts). Shape **what comes next** with function, priorities, stakeholders, and the function’s practice note — user-only readiness, non-directive. When function is empty/unresolved or practice-note body is missing → **why-only** (no silent default function; no invent note). Skip regeneration when cache-key inputs are unchanged. Do not own join, feed rank, shared metastory copy, feed/open chrome (CTA / empty what-next slot → [dashboard--v1.md](../prds/dashboard--v1.md)), or practice-note authorship in this doc.

---

## Who it’s for

Solo bilateral / institutional comms operators ([pp1](../principles.md)).

---

## Problem

Shared metastory copy explains the event, not what it means for readiness. Without a shareable **why this matters** (priorities-shaped so-what) and a private **what comes next** (function- and stakeholder-shaped, constrained by [pp5](../principles.md) and a fixed practice note), the user re-does analytical judgment every refresh, or Tempo drifts into prescribing actions — or why copy that only fits one role fails when shared with contacts.

---

## Solution (target)

### Happy path

0. **Signal:** Ingestion **clock** or **warm** recompute for this user only — **no UX event** triggers personalization ([ingestion](./ingestion.md) IR-10 / clock handoff → join → this stage).
1. **Gate:** Only metastories in this user’s **feed membership** after **join** (source ∧ ≥1 chip — join owned by dashboard; personalization consumes the member set).
2. **Load grounding:** Shared title, subtitle, what happened, what changed (source list as needed).
3. **Load profile:** Org priorities + personal priorities (for why and what-next); function + stakeholders + fixed **practice note** for that function (**what comes next only**; note not live-fetched).
4. **Skip:** If cache-key input classes unchanged since last success → keep stored why / what-next; no model call.
5. **What-next gate:** Empty/unresolved function **or** missing practice-note body → **why-only** path (do not invent function or note). Else **both-fields** path.
6. **Generate** (≤2 attempts, **one invoke**): English why; plus what comes next when not gated — per locked input/output rules.
7. **Persist** on user↔metastory **feed membership** (+ personalization-run lineage when schema exists); set **`personalized_at`** on successful **why** write (`what_comes_next` may stay null when gated).
8. **On final fail:** keep **last good** per-user copy; do not blank the open story (no canned state-template fallbacks).

### Input kinds

| Kind | Fields | Role |
|------|--------|------|
| **Grounding (shared)** | Title, subtitle, what happened, what changed (+ source list as needed) | What the model **reads** about this event |
| **Why profile** | Org priorities + personal priorities | Share-safe so-what emphasis (org/situation voice) |
| **What-next profile** | Function + personal priorities + org priorities + stakeholders + practice note | Private readiness framing |
| **Output constraints** | — | Must not retell grounding; must not name stakeholders in why; must not prescribe send/publish/decide; why must stay share-safe |

### Explicit product lines

- Practice-note **text** → Locked F-pass + seed v2 (what comes next only)
- Feed order / rising / source order / chip chrome / share-pack UI → dashboard (B5)
- Out of feed → **no new generate**; prior personalizations **retained** for traceability; not shown in UI

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Feed members get useful readiness copy without prescriptions; why remains intelligible if shared with contacts |
| **Early signal** | Skip hits when inputs unchanged; generate succeeds within ≤2 attempts or last-good held |
| **Guardrail** | No stakeholders / function lens / practice-note framing in why; no send/publish/decide; no retell of what happened / what changed (either field); why uses org/situation voice — failure-mode detail in evals |

Invoke / spend measurement → [D-088](../../06-engineering/DECISIONS.md) + model PRD (`personalization_invoke`, runs, `#ops-pricing-models`). Copy quality → evals/gold — not a PostHog quality score.

---

## Scope

### In

- Why this matters + what comes next for **current** feed members (one invoke)
- Grounding + split profile (why vs what-next); skip-if-unchanged; English MVP; ≤2 attempts; last-good on fail
- Cache-key **input classes** (algorithm in pipeline)
- Retain prior personalizations when membership ends (traceability); no generate while out of feed
- Lineage: [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) (no row on PR-08 skip)
- Pointer: practice-note text Locked F-pass + seed v2 (what-next only)

### Out / non-goals

- Join predicate; feed rank; rising/source-order formulas; chip display chrome; share-pack chrome
- Shared metastory writer / clustering / embeddings
- Fetch / summarization / body handling
- Practice-note **prose** in this contract; prompt text; gold cases; SKU / timeout / concurrency integers
- Prescriptive send/publish/decide; stakeholders named in why this matters
- Function or practice-note framing in why this matters
- Retelling what happened / what changed as the field body (why or what-next)
- Personalizing metastories **not** in the user’s feed (no new generate)
- Hard-deleting prior personalizations when a metastory leaves the feed
- Runtime implication taxonomy, intro/steady/evolving state machine, doctrine retrieval corpus, May-era why trace blob
- Archived why-this-matters doctrine as live SoT; subtitle-echo `whyItMatters`
- UX regenerate control or stage settings UI

---

## Locked rules

| ID | Rule |
|----|------|
| **PR-01** | **Feed members only** — personalize only metastories in this user’s **current** feed after join (`user_feed_membership.ended_at IS NULL`); no new generate when out of feed |
| **PR-02** | **Grounding** — model may read shared title, subtitle, what happened, what changed (source list as needed) |
| **PR-03** | **Why this matters inputs** — org priorities + personal priorities + grounding (PR-02); **not** function, practice note, or stakeholders |
| **PR-04** | **What comes next inputs** — grounding + function + personal priorities + org priorities + stakeholders + practice note for that function |
| **PR-05** | **Output: why** — so-what / readiness in **org/situation voice** suitable to share with contacts; personal priorities may **weight emphasis only** (no second-person personal-priority address); must **not** use a function lens or practice-note framing; must **not** retell what happened/what changed; must **not** name stakeholders; must **not** prescribe send/publish/decide |
| **PR-06** | **Output: what comes next** — prepares a possible step; non-directive ([pp5](../principles.md)); must **not** retell what happened/what changed; no send/publish/decide |
| **PR-07** | **Practice-note rule** — one fixed note per function (communications, policy, operations, partnerships); not live-looked-up; **text Locked** ([practice-notes/](../practice-notes/README.md) F-pass + seed v2); used for **what comes next only** (not why) |
| **PR-08** | **Skip if unchanged** — if cache-key input classes unchanged since last success, do not regenerate |
| **PR-09** | **Cache-key classes** — one key for both fields: grounding fields used + org priorities + personal priorities + function + stakeholders + practice-note id/version; hash/algorithm in pipeline |
| **PR-10** | **English (MVP)** |
| **PR-11** | **Writer retry** — ≤2 attempts same invoke; when **both** fields are requested, both must validate (no half-persist of a both-fields attempt); when what-next is **pre-gated** (empty function or missing note), **why-only** invoke/persist is allowed; on final fail keep **last good** per-user copy; no canned state-template fallbacks |
| **PR-12** | **Lineage + retention** — [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) (attempt rows only; PR-08 skip inserts none); prior personalizations **retained** when membership ends (soft-end). Re-join **resurrects** the same row (clear end; keep copy + cache). **`personalized_at`** set when **why** is successfully written (card may list with `what_comes_next` null when gated). Never blank why; never invent what-next. Feed/open chrome for missing what-next / complete-function CTA → [dashboard--v1.md](../prds/dashboard--v1.md). New member + why writer fail → hide from UI and retry (row may exist for join SoT). No `admitted_at` spell column in v0 |
| **PR-13** | **Not owned here** — join, feed rank, rising/source-order, chip chrome, empty what-next CTA, share-pack chrome, shared metastory copy |
| **PR-14** | **What-next gate** — empty/unresolved function **or** missing practice-note body → withhold what-next; still generate why when PR-03 inputs + grounding allow; **no** silent default to communications; **no** CTA / account instruction inside model copy |

---

## Stage I/O

### Inputs

- User feed membership set (metastories after join)
- Shared grounding per metastory: title, subtitle, what happened, what changed (+ source list as needed)
- Profile: org priorities, personal priorities; function, stakeholders, practice note (what-next path)
- Practice note for function (id/version + text when authored) — what-next only
- Prior cached why / what-next + last cache-key classes (for skip)
- Recompute signal: ingestion **clock** or **warm** only — **no UX event**

### Outputs

- Why this matters (English) on user↔metastory **feed membership**; what comes next when not gated (else null)
- `personalized_at` set on successful **why** write
- Skip vs generated flag; personalization-run lineage when schema exists

### Edges

- Not in current **feed membership** → **no new generate**; do not show personalization in UI; **retain** prior rows / runs for traceability
- Skip hit → return cached copy; no model call
- Empty/unresolved function **or** missing practice-note body → **why-only** ([PR-14](#locked-rules)); on successful why-only regen, pipeline sets `what_comes_next` **NULL** (no stale last-good what-next)
- Writer fail after ≤2 → last good copy (hide if none for why)
- **Atomic success (both-fields path)** — when both fields are requested, invoke succeeds only when **both** why and what-next are valid; no half-persist of a both-fields attempt (last-good both, or hide)
- **Why-only path** — pre-gate (PR-14): why may persist alone; `what_comes_next` null; display/CTA → dashboard
- Empty priorities/stakeholders → may still run why with grounding; what-next needs function + note + grounding when not gated; do not invent profile
- Shared copy unchanged but profile changed → regenerate (cache miss)
- No silent default function (e.g. communications); no invent practice note

### Handoff

- **Join** → feed membership / feed rank / rising / user-chip chrome / what-next-null chrome / share pack → [dashboard--v1.md](../prds/dashboard--v1.md)
- Shared title / what happened / what changed / **metastory id** → [metastory.md](./metastory.md)

---

## Runtime gap (build phase)

**Target:** Join-gated why (+ what-next when not PR-14 gated) with share-safe why inputs, practice-note hook, skip-if-unchanged, atomic both-fields when both requested, why-only when gated, and retention as above.

**Today:** B4 **design Locked** ([D-110](../../06-engineering/DECISIONS.md)). Prototype `whyItMatters` / enrichment paths and [archived field doctrine](./archive/why-this-matters--field-doctrine.md) remain **legacy** until build matches this contract. Carry map: [pipelines/personalization.md](../../06-engineering/docs/pipelines/personalization.md) ([D-108](../../06-engineering/DECISIONS.md)). **Build deferred:** migrate DBML, seed import, advisory harness, invoke + `personalization_invoke` wire.

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 26–27 Oct 2026 | Process (plan thread) | Polished B input split; practice-note rule; skip if unchanged; feed members only |
| 27 Oct 2026 | Charter | Stage contract **A**; dashboard owns join/rank/chips chrome |
| 27 Oct 2026 | Grounding | Shared copy incl. what happened / what changed is explicit model context |
| 27 Oct 2026 | Practice notes | Rule here; text authored with prompt — **done** F-pass + seed v2 (5 Nov) |
| 27 Oct 2026 | Language / retry | English MVP; ≤2 attempts; last good on fail |
| 27 Oct 2026 | Out of feed | No new generate; retain prior personalizations; UI current members only |
| 27 Oct 2026 | Missing notes | ~~Block all generates~~ → **superseded 5 Nov by PR-14:** missing note → why-only (still generate why when inputs allow) |
| 27 Oct 2026 | Purpose / Who / Problem | **B** / **A** / **A** |
| 27 Oct 2026 | Solution / Scope | Happy path **B**; In/Out **B**; cache-key classes in contract |
| 27 Oct 2026 | PR-01…13 | Locked rules as tabled; one cache key for both fields — **PR-14** added 5 Nov (why-only gate) |
| 27 Oct 2026 | Stage I/O | **B** |
| 27 Oct 2026 | Related / Success / Runtime | **B** / **B** / **B** |
| 27 Oct 2026 | Artifact | **Locked** — [personalization.md](./personalization.md) |
| 27 Oct 2026 | A2 | Feed membership term aligned with dashboard join |
| 28 Oct 2026 | Feed membership SoT | Resurrect on re-join; UI gate on personalized_at; membership may lag copy in DB; no admitted_at in v0 |
| 4 Nov 2026 | P5 share-safe why (P16) | Why inputs = org + personal priorities + grounding; function + practice note + stakeholders → what-next only; one cache key still unions both; missing notes → **PR-14 why-only** (not a full-stage block) |
| 4 Nov 2026 | PR-05 org-voice (P17) | Why output = share-safe org/situation voice; personal priorities weight only; no function/practice-note framing in why |
| 4 Nov 2026 | Encode carry | P1–P14 + artifact A → [pipelines/personalization.md](../../06-engineering/docs/pipelines/personalization.md); [D-108](../../06-engineering/DECISIONS.md) |
| 4 Nov 2026 | B4 X1–X4 | UX **A** (clock\|warm only; d05 display; share chrome B5); Data **A**; Ops **A′+M** (Sonnet / 15s / concurrency 2 clamp 1–4 → PRD/pipeline); Metrics **A** (D-088) |
| 4 Nov 2026 | B4 contract C1–C7 | Related/Success **A**; Purpose **A**; Happy path signal **A**; Success/Scope **A**; PR-06 anti-retell **B**; I/O trigger + atomic both-fields **B**; Runtime/log **A** |
| 5 Nov 2026 | Why-only gate (PR-14) | Empty function or missing note → why-only; `personalized_at` = why success; atomic both-fields only when both requested; no default to communications; display/CTA → dashboard PRD |
| 5 Nov 2026 | d05 soft lengths + note shape (C1) | Why 2–3/~350–450; next 1–2/~250–350; note uncapped posture+3 prefer+3 avoid+0–3 families (bullets); full up to 4; metastory happened/changed soft bars stubbed then thickened same day (writer + gold) |
| 5 Nov 2026 | d05 metastory length done | Soft bars folded into [metastory-writer](../../06-engineering/docs/prompts/metastory-writer.md) + evals; gold evidence-earned thicken + carve-outs — closed before B5 |
| 5 Nov 2026 | Practice notes F-pass + E1-B | Four function artifacts Locked; seed fixture + build handoff; `source_refs` JSON text on row; pp5 code eval hook |
| 5 Nov 2026 | Ev1–4 + runs | Eval suite 24 cases; `trigger_kind` = `clock` \| `warm` ([D-109](../../06-engineering/DECISIONS.md)) |
| 5 Nov 2026 | Arbiter | All 24 gold cases locked (Felipe); seed practice notes **v2** (no em dashes) |
| 5 Nov 2026 | DB/DBML | B4 design Locked — no column changes ([D-110](../../06-engineering/DECISIONS.md)) |

---

## Next foundations (not this doc)

| Artifact | Notes |
|----------|-------|
| Build | Migrate `practice_notes` + `personalization_runs`; seed from [practice-notes.seed.json](../../06-engineering/docs/data/practice-notes.seed.json) v2; wire invoke + advisory harness (PF-03 / mode); `personalization_invoke` |
| **d05 metastory length** | Done 5 Nov 2026 — soft bars in [metastory-writer](../../06-engineering/docs/prompts/metastory-writer.md) + evals (keep v1); gold evidence-earned thicken + carve-outs |
| B5 | Share-pack chrome / composition → [dashboard--v1.md](../prds/dashboard--v1.md) |
