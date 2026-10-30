# Extraction — product contract

> **Stage:** Extraction · **Altitude:** Product contract (not a PRD) · **Status:** Locked (Session A) · **Last updated:** 27 Oct 2026 (A2 pointer)  
> **Pattern:** Stage contracts live at `02-product/contracts/{stage}.md`. Engineer prompt / pipeline / eval artifacts link here; they do not replace this doc.

**Related**

- UX (locked): [Paper — Onboarding · Happy path](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70H-0)
- Onboarding PRD (Review gate): [onboarding--v1.md](../prds/onboarding--v1.md)
- Data (target): [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library (dbdiagram)](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Prompt SoT (Session B, locked): [extraction.md](../../06-engineering/docs/prompts/extraction.md) (`extraction-v1`)
- Pipeline SoT (Session C, locked): [extraction.md](../../06-engineering/docs/pipelines/extraction.md)
- Extraction runs (Session D, locked): [extraction-runs.dbml](../../06-engineering/docs/data/extraction-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d)
- Eval / gold (Session E, locked): [extraction.md](../../06-engineering/docs/evals/extraction.md) · draft [extraction.gold.json](../../06-engineering/docs/evals/extraction.gold.json)
- Build handoff (exit): [extraction-build-handoff.md](../../06-engineering/docs/evals/extraction-build-handoff.md)
- Product principles: [principles.md](../principles.md) (esp. pp2 — user scope is the ceiling)

---

## Purpose

Turn the user’s five blurbs into **structured scope** Tempo can store, edit, and use to choose which stories to surface — and why.

Extraction is the first intelligence stage. Later monitoring stages depend on this scope being faithful and editable — [ingestion](./ingestion.md), [summarization](./summarization.md), [story-tagging](./story-tagging.md) (locked), [metastory](./metastory.md), [personalization](./personalization.md); UX: [dashboard--v1.md](../prds/dashboard--v1.md). Confirmed **user chips** (topics, keywords, geographies, sources, …) are the join ceiling; **story chips** on the shared pool are applied by [story-tagging](./story-tagging.md) (invoked via [IR-08](./ingestion.md)). This contract does **not** own feed fetch, clustering, story-chip apply, or personalization.

---

## Who it’s for

Solo bilateral / institutional comms operators setting watch-scope during onboarding (and later in account settings). Design unit: one person ([pp1](../principles.md)).

---

## Problem

Free-text blurbs are how users express role, priorities, stakeholders, and sources. Tempo cannot monitor from prose alone. It must derive structured facets **without inventing scope the user did not state**. First-time scope goes live only after the operator confirms chips; later rebuilds extend what they already have and they prune in Account.

---

## Solution (target)

### Five lanes (UX + data)

Paper field labels and the first-principles ERD are the same five facets. Artboard names like “Role” / “Org” are **focus states** on one form, not different products.

| Lane | User field | Primary extract targets |
|------|------------|-------------------------|
| 1 | Your role and organization | Model: `role_submitted`, `organization_submitted`, `function_label` (strings). Post-model: `function_label` → `functions.name` → `function_id`; `organization_submitted` → aliases → `organization_id` |
| 2 | Your priorities | topics, keywords, geographies (`source = personal_priorities`). Topic = collapsed theme; keyword = bare match term. Model rules: [Lanes 2–3](../../06-engineering/docs/prompts/extraction.md) |
| 3 | Your organization's priorities | Same facet rules as lane 2 (`source = organization_priorities`). Do not merge with personal facets |
| 4 | Your stakeholders | per-user `mention` strings only (no shared catalog; extract-only — no user Add/x) |
| 5 | Your sources | traditional press (+ aliases) and X handles |

All five lanes are **in-scope extraction** (one product capability, lane-specific I/O rules).

### Happy path

1. User fills any subset of the five blurbs (all **optional** in v1 — UX strongly suggests; do not block finish).
2. **One LLM call** receives all **filled** blurbs and returns structured extracts for every lane present in that run.
3. **Onboarding:** **Review your scope** is **required** — user confirms or edits chips before scope is live for the dashboard.
4. **Account Context Save (rebuild):** **no Review surface** — write blurbs then invoke; merge new extracts into live chips; operator removes unwanted tags in Tags ([pipeline](../../06-engineering/docs/pipelines/extraction.md) · [account--v1.md](../prds/account--v1.md) · [model--extraction--v1.md](../prds/model--extraction--v1.md)).
5. Chip edits on Review are the onboarding guardrail `extraction_chip_acceptance`. They record what the operator kept. They are not an eval.

### Success

| Layer | Signal |
|-------|--------|
| **North star** | Downstream **retrieval / dashboard utility** — on-beat stories admitted, irrelevant excluded |
| **Early signal** | **Chip acceptance** — PostHog `extraction_chip_acceptance` at a successful onboarding commit. Kept, removed, and added per shelf. It records what the operator kept. It is not an eval. Definition in the [extraction PRD](../prds/model--extraction--v1.md). |

Do not optimize for pretty chip lists that fail retrieval.

---

## Non-goals

- Metastory clustering, what-changed, why-it-matters, or “what you could do” pipelines
- Live schema migrations or wiring Paper → API (build phase)
- Promoting extraction eval to a blocking CI gate (decide later with evidence)
- Forcing all five blurbs before the user can continue
- Closed topic/keyword allowlists as the extraction gate
- Second-pass “enrichment” LLM after the single extraction call
- Thumbs-up / thumbs-down as the primary eval UX (prefer chip edits and downstream utility)
- Rewriting locked Paper onboarding UX
- A second **Review** product for Account / settings Rebuild (MVP)
- Folding AI run lineage into the product Database library ERD (lineage stays a **sibling** diagram/doc)

---

## Runtime gap (build phase)

This contract describes the **target**: five blurbs, five stored lanes, one multi-lane extraction run, **onboarding Review required**, settings Rebuild merge-without-Review.

**Today’s prototype** still centers a **single narrative** → one extract into a settings-shaped blob. Treat that path as **legacy** until build reconciles runtime to this contract and [tempo.dbml](../../06-engineering/docs/data/tempo.dbml). Foundation docs must not assume five-lane migrations already ship.

---

## Decision log (Session A)

| Date | Lock | Choice |
|------|------|--------|
| 27 Sep 2026 | Success | Hybrid — retrieval north star; chip fidelity early proxy |
| 24 Oct 2026 | Success | North star stays retrieval. The early signal is PostHog `extraction_chip_acceptance`. It is not an eval. The 24 gold cases are the advisory eval. |
| 27 Sep 2026 | Scope | All five blurbs are extraction |
| 27 Sep 2026 | Non-goals | As listed above (incl. sibling lineage diagram) |
| 27 Sep 2026 | Target vs live | Target SoT + runtime-gap note |
| 27 Sep 2026 | Invocation | One LLM call across filled blurbs |
| 27 Sep 2026 | Lane table | As written (stakeholders extract-only) |
| 27 Sep 2026 | Review | Required before scope is live (first lock — both surfaces) |
| 27 Sep 2026 | Artifact path | `02-product/contracts/{stage}.md` → `extraction.md` |
| 17 Oct 2026 | Review gate | **Onboarding only.** Settings Rebuild merges live; prune in Account. Aligns pipeline + onboarding PRD. |
| 21 Oct 2026 | Topic vs keyword | Product split lives in the prompt (Lanes 2–3). Contract points there; it does not restate the model rules. |
| 27 Oct 2026 | A2 | User chips vs story chips pointer; monitoring contracts locked |

---

## Next foundations (not this doc)

| Session | Artifact |
|---------|----------|
| B | Done — [prompts/extraction.md](../../06-engineering/docs/prompts/extraction.md) |
| C | Done — [pipelines/extraction.md](../../06-engineering/docs/pipelines/extraction.md) |
| D | Done — [extraction-runs.dbml](../../06-engineering/docs/data/extraction-runs.dbml) · [D-072](../../06-engineering/DECISIONS.md) |
| E | Done — [docs/evals/extraction.md](../../06-engineering/docs/evals/extraction.md) (**BUILD MUST** promote gold) |
