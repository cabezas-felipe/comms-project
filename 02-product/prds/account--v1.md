# Account — Tags, Context, and scope maintenance

Let a confirmed-scope operator edit watch-scope chips and blurbs on **desktop web** and **iOS native**, and re-run extraction when Context blurbs change — without a second Review product.

Status: Draft  
Owner: Felipe  
Update: 17 Oct 26  
Intent: ship  

**Stub** — Solution walk not started. Lock screens piece by piece (Paper Account · Tags / Context). **Invoke table + `trigger_kind` / `trigger_id` / a03g modes** locked in [model--extraction--v1.md](./model--extraction--v1.md); this file owns Account chrome, copy, and screen walk.

**Related**

- Strategy: [Tempo strategy](../strategy/tempo.md)
- Onboarding (sibling): [onboarding--v1.md](./onboarding--v1.md) — first-time Scope → Review; Account is post-confirmed-scope
- Extraction model (sibling): [model--extraction--v1.md](./model--extraction--v1.md) · contract: [Extraction](../contracts/extraction.md) · pipeline: [extraction.md](../../06-engineering/docs/pipelines/extraction.md)
- Data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Runs lineage: [extraction-runs.dbml](../../06-engineering/docs/data/extraction-runs.dbml) · [Extraction runs](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d)
- DS: [form-intro](../../03-design/design-system/patterns/form-intro.md) · [scope-gates](../../03-design/design-system/patterns/scope-gates.md) · [account-menu](../../03-design/design-system/patterns/account-menu.md)
- Paper: Account artboards on [07 - Comms · c01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/p-9-0/1002-0) (Tags / Context Idle · Editing · Saving; fail specimens TBD in walk)

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator with **confirmed scope** ([Personas](../../01-research/personas.md)).

**Pain:** Scope drifts as priorities and sources change. Operators need to edit chips and blurbs in-place without re-running full onboarding Review.

**Why now:** Onboarding locks first-time path; Account is the maintenance surface for live scope. Extraction Rebuild must not invent a second Review UX (MVP).

**Gaps:** Account screen locks incomplete — stub only until Tags / Context walk.

---

## Goals

- Operator can edit Tags chips and Context blurbs and persist changes.
- Context **Save** / recover CTAs: write blurbs then invoke extraction (`trigger_kind = rebuild`) per model sibling — no Review gate; merge into live chips; operator prunes in Tags.
- Success / metrics: `TBD` until screen walk + PostHog plan.

---

## Solution

### Overview

Account destination: **Your scope.** tabs — **Tags** (chip inventory) · **Context** (five blurbs). Identity / email via Settings chrome ([account-menu](../../03-design/design-system/patterns/account-menu.md)) — out of extraction path.

### Scope

| In | Out |
| --- | --- |
| Tags / Context UX, Save / fail / retry chrome | Extraction model I/O, prompts, gold/evals |
| Blurb writes to five lane tables; handoff to extract invoke | Onboarding O1–O5 |
| PostHog events for Account scope maintenance (when locked) | Dashboard feed ranking |

### Working locks (from extraction Align — not a full screen walk yet)

| Lock | Choice | Date |
| --- | --- | --- |
| Context Save | **Persist + rebuild** — write five blurbs (empty → `NULL`) then invoke with `trigger_kind = rebuild` (**new** `trigger_id`) | 17 Oct 26 |
| Review | **None** on Account — merge live; prune in Tags | 17 Oct 26 |
| Commit atomicity | Any lane write failure ⇒ whole commit failed ⇒ **no** extract invoke | 17 Oct 26 |
| Fail surface | **One** screen **a03g** — dual-mode via client `fail_kind: write \| extract` (not a DB column) | 17 Oct 26 |
| a03g copy (MVP) | **One generic** fail line — not mode-specific | 17 Oct 26 |
| a03g Try again | **write** → re-write blurbs then rebuild (new `trigger_id`); **extract** → `trigger_kind = retry`, **same** `trigger_id` | 17 Oct 26 |

Specimen IDs in flight (Paper): **a03a** / **a03f** (Context Save path), **a03g** (dual-mode fail). Confirm labels in Solution walk.

---

## Execution spec (agent-ready)

`Execution spec: deferred` until Account Solution walk locks screens. Implement Context commit against model/pipeline SoTs; do not invent a Review step.

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stub Account PRD separate from onboarding | Onboarding PRD Out already points here; keeps confirmed-scope maintenance owned | 17 Oct 26 | Merge if Account stays tiny |
| Save = persist + rebuild | Updated blurbs imply scope change; option B from extraction Align | 17 Oct 26 | Evidence Save-without-extract is needed |
| a03g dual-mode (not two screens) | Rare fails; one Account fail UI; Try again branches on client `fail_kind` | 17 Oct 26 | Operators confuse recover path |
| `fail_kind` not in DBML | Ephemeral UI state; extract fails already leave `extraction_runs`; write fails never mint a run | 17 Oct 26 | Need durable audit of write fails |
| a03g generic copy (MVP) | Rare; avoid copy matrix until evidence | 17 Oct 26 | Support tickets need clearer reason |

### Blocking open questions

| Question | Default if unresolved |
| --- | --- |
| Exact Paper specimen map for a03* (Idle / Editing / Saving / a03g) | Walk Paper Account before locking copy |
| Extracting chrome on Account (in-place busy vs full-screen like o04) | Prefer in-sheet busy + then Tags updated; revisit if Paper shows o04-class |
| PostHog event names for Context Save / write-fail | Extract finish is `extraction_invoke` in [model--extraction--v1.md](./model--extraction--v1.md) (`surface = account`). It does not carry `fail_kind`. Write-fail events stay here and include `fail_kind`. Names `account_context_save_*` until that slice |
