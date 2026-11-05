# Personalization model — why this matters and what comes next

Write per-user readiness copy for metastories that remain in that user’s feed: why this matters and what comes next.

Status: B4 design Locked — build deferred  
Owner: Felipe  
Update: 5 Nov 26  
Intent: ship

**Thin ship shell.** Do not duplicate the PR table, prompt text, or gold — change those in the SoTs below first. This PRD owns **invoke / build sequencing**, runtime gap vs today, and agent-ready **Execution**. Behavior SoT: locked [contract](../contracts/personalization.md) (PR-01…14). One invoke returns why + what-next when not gated; **why-only** when function/note gated ([PR-14](../contracts/personalization.md)).

**SoT (behavior — not a second copy here)**

- Product contract: [personalization.md](../contracts/personalization.md) (locked — P5 share-safe why; B4 C-pass C1–C7)
- Prompt: [personalization.md](../../06-engineering/docs/prompts/personalization.md) (**Locked** Pr1–Pr6) · practice notes: [practice-notes/](../practice-notes/README.md) · seed [practice-notes.seed.json](../../06-engineering/docs/data/practice-notes.seed.json) v2 · handoff [practice-notes-seed.md](../../06-engineering/docs/data/practice-notes-seed.md) — **what comes next only**
- Pipeline: [personalization.md](../../06-engineering/docs/pipelines/personalization.md) (B4 design Locked · D-108 carry · PR-14)
- Runs schema: [personalization-runs.dbml](../../06-engineering/docs/data/personalization-runs.dbml) (D-109 · D-110) · [dbdiagram](https://dbdiagram.io/d/6ae28fcfaac33014104ead45)
- Evals / gold: [personalization.md](../../06-engineering/docs/evals/personalization.md) · [personalization.gold.json](../../06-engineering/docs/evals/personalization.gold.json) (24 cases; arbiter-locked 5 Nov 2026; advisory until promote)
- Product ERD: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) §10 feed membership + `practice_notes` · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Eng decisions: [D-088](../../06-engineering/DECISIONS.md) (invoke) · [D-108](../../06-engineering/DECISIONS.md) (carry) · [D-109](../../06-engineering/DECISIONS.md) / [D-110](../../06-engineering/DECISIONS.md) (runs / DB close)

**Siblings**

- Metastory (shared copy): [metastory.md](../contracts/metastory.md) (locked) · [model--metastory--v1.md](./model--metastory--v1.md)
- Ingestion (clock / warm): [ingestion.md](../contracts/ingestion.md) (locked)
- Dashboard UX (join / chrome / share pack): [dashboard--v1.md](./dashboard--v1.md)
- Extraction (function + priorities + stakeholders): [model--extraction--v1.md](./model--extraction--v1.md)

**Ops pricing:** [07-ops/model-pricing.json](../../07-ops/model-pricing.json) (SoT) · runtime copy under API `pricing/model-prices.json` · Slack `#ops-pricing-models`: **daily** model spend digest + **Monday** unit-price catalog review.

**Locked product rules (process)** — contract is full SoT; summary only:

- **Why this matters:** grounding + org priorities + personal priorities; share-safe **org/situation voice**; personal priorities may weight emphasis only; does **not** use function, practice note, or stakeholders; does **not** retell grounding; no prescribe send/publish/decide
- **What comes next:** grounding + function + priorities + org priorities + stakeholders + practice note; non-directive; must **not** retell grounding; never send/publish/decide (pp5)
- Fixed practice note per function — **what-next only**; four notes Locked (seed v2)
- One invoke returns both fields when not gated; **why-only** when function empty or note missing ([PR-14](../contracts/personalization.md)); skip when cache inputs unchanged; feed members only; last-good / hide; `personalized_at` = why success; atomic both-fields only when both requested

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Shared event copy is not enough to act with judgment; the operator needs a shareable so-what and a private non-directive next step — without role-only why copy that breaks when pasted to contacts.

**Why now:** Shared metastory path is Locked; personalization is the per-user layer; share/copy wedge needs share-safe why. B4 **design Locked** ([D-110](../../06-engineering/DECISIONS.md)).

**Build deferred:** migrate `practice_notes` + `personalization_runs`; seed import (v2); wire prompt + advisory harness; instrument `personalization_invoke`. SKU / timeout / concurrency already locked in X3 (prompt/pipeline). Product meaning lives in the [contract](../contracts/personalization.md).

### Runtime gap (current vs target)

| Dimension | Live today (prototype) | Target (this PRD + contract) |
| --- | --- | --- |
| Trigger | Dashboard **refresh** megapipe | Ingestion **clock / warm** → join → personalize — **no UX** trigger |
| Fields | `whyItMatters` only (engine / fallback); no what-comes-next | Why + what-next on `user_feed_membership` |
| Audience / inputs | Everyone-as-comms; taxonomy / state / doctrine stack | Share-safe why (org + personal priorities); what-next (+ function, practice note, stakeholders) |
| Sequence | Refresh-path why writer (± rubric / state templates) | Skip-if-unchanged → one invoke ≤2 → why (+ what-next if not PR-14 gated) → `personalized_at` / last-good hide |
| Lineage | Snapshot / why traces | `personalization_runs` per LLM attempt; no May trace blob |
| Evals | [why-this-matters.gold.json](../../06-engineering/docs/evals/why-this-matters.gold.json) (as-is shaped) | One personalization gold suite; advisory; **no** LLM judge |
| Display | Feed card why | d05 why + what-next bands; share pack chrome → **B5** |
| Ops | As-is why pool concurrency ~4 | Sonnet 5.5; **15s**; member concurrency **2** (clamp 1–4) |

Do **not** treat `why-this-matters-engine` / archived doctrine / subtitle echo as the target world.

---

## Goals

- Feed members get why; what-next when not PR-14 gated; UI when `personalized_at` is set (why success); what-next-null chrome → dashboard.
- Share-safe why + non-directive what-next; skip-if-unchanged; last-good / hide on fail.
- Guardrails: [PR-05](../contracts/personalization.md) / [PR-06](../contracts/personalization.md) (incl. anti-retell on both fields).
- Measurement: `personalization_runs` + `#ops-pricing-models` + advisory gold + thin `personalization_invoke` ([D-088](../../06-engineering/DECISIONS.md)) — not a quality score.

---

## Solution

### Overview

After join updates current feed membership (ingestion clock or warm): for each member → **skip** if [PR-09](../contracts/personalization.md) cache hit → else gate what-next ([PR-14](../contracts/personalization.md)) → one **Sonnet** invoke (≤2 attempts) producing why (+ what-next when not gated) → persist on `user_feed_membership` + set `personalized_at` on why success → `personalization_runs` on LLM attempts. Exact Mermaid / hash serialization live in the pipeline sibling.

### Operator-visible

Operator does **not** trigger personalization. They see why / what-next on the feed and metastory-open (d05); chrome, join, and rank owned by [dashboard--v1.md](./dashboard--v1.md). Share pack composition → **B5**; why copy remains share-safe per contract.

### Scope

**In:**

- One-invoke sequencing (skip → what-next gate → generate → persist)
- Practice-note / function hook (what-next); why-only when gated; atomic both-fields when both requested; `personalized_at` = why success
- Lineage (`personalization_runs`); specified `personalization_invoke`; ops via models channel

**Out:**

- Join / rank / rising / recall / source-matcher; share-pack UI
- Shared metastory copy / clustering / embeddings
- Prompt text, practice-note prose, gold cases (siblings)
- No Must REQ table — gates live as [PR-*](../contracts/personalization.md) + Execution Constraints below

### Metrics — personalization invoke (specified)

Shared LLM stack ([D-088](../../06-engineering/DECISIONS.md)): `personalization_runs` + ops spend + evals/gold, **plus** thin PostHog invoke. Skip-if-unchanged (no model call) does **not** emit. Not a quality score; not feed/share UX analytics.

| Rule | Lock |
| --- | --- |
| When it fires | Once when a personalization **LLM invoke** finishes (success or fail). Skip / out-of-feed paths do **not** emit. Why-only (PR-14 gated) **does** emit when an LLM invoke runs. Attempt 2 is the same invoke — **one** event (**not** per attempt). |
| Event | `personalization_invoke` |
| Properties | `trigger_id` · `trigger_kind` (`clock` \| `warm`) · `outcome` (`success` \| `fail`) · `prompt_version` · `model_id` (attempt that produced the persisted copy, or last attempt on fail) · `error_kind` if fail |
| Left out | Why/next copy text, priority/stakeholder blurbs, practice-note body, gold scores |
| Wiring | Specified, not instrumented |

---

## Execution spec (agent-ready)

**Goal:** On ingestion clock/warm after join, for each current feed member: skip if cache hit; else apply PR-14 what-next gate; ≤2 attempts, one Sonnet invoke → why (+ what-next when not gated); persist why + `personalized_at` (what-next null when gated); write runs on LLM attempts; last-good or hide on fail.

**Inputs**

- Current feed membership set ([PR-01](../contracts/personalization.md))
- Shared grounding per metastory ([PR-02](../contracts/personalization.md))
- Why profile: org priorities + personal priorities ([PR-03](../contracts/personalization.md))
- What-next profile: function + priorities + stakeholders + practice note ([PR-04](../contracts/personalization.md) · [PR-07](../contracts/personalization.md))
- Prior why / what-next + cache-key classes
- Invoke signal: `clock` \| `warm` (no UX)

**Outputs**

- `why_this_matters` on `user_feed_membership`; `what_comes_next` when not PR-14 gated (else null)
- `personalized_at` set on successful **why** write
- `personalization_cache_key` updated on success
- `personalization_runs` rows per LLM attempt; skip / no-model → no row
- Thin PostHog `personalization_invoke` when instrumented (specified above)

**Core logic**

1. Receive clock/warm recompute for user → load current members ([PR-01](../contracts/personalization.md)).
2. Load grounding + why/what-next profiles ([PR-02](../contracts/personalization.md)…[PR-04](../contracts/personalization.md), [PR-07](../contracts/personalization.md)).
3. **Skip** if cache-key classes unchanged ([PR-08](../contracts/personalization.md) · [PR-09](../contracts/personalization.md)) — no model, no run row.
4. Apply **what-next gate** ([PR-14](../contracts/personalization.md)): empty function or missing note → why-only mode; else both-fields.
5. **Invoke** ≤2 attempts, one prompt ([PR-11](../contracts/personalization.md)); Sonnet 5.5 (X3).
6. Validate: why-only → why valid ([PR-05](../contracts/personalization.md)); both-fields → both valid ([PR-05](../contracts/personalization.md) / [PR-06](../contracts/personalization.md)).
7. Persist why (+ what-next if not gated) + cache key + `personalized_at`; write run row(s).
8. On final fail → last-good or hide ([PR-12](../contracts/personalization.md)).

**Edge cases**

- Out of feed → no new generate; retain prior rows; hide in UI.
- Skip hit → return cached copy; no model call.
- Function empty or note missing → why-only; no default communications; no invent note; CTA → dashboard.
- Writer fail after ≤2 → last-good or hide (no blank why; no state templates).
- Both-fields path with partial model output → **not** success; last-good or hide.
- Empty priorities/stakeholders → may still run why with grounding; what-next needs function + note when not gated; do not invent profile.
- Shared copy unchanged but profile changed → cache miss → regenerate.

**Constraints** (agent-scannable; contract remains full PR SoT — no Must REQ table)

- No UX trigger — ingestion clock/warm only (X1).
- Feed members only — [PR-01](../contracts/personalization.md).
- Why / what-next input split + org-voice why — [PR-03](../contracts/personalization.md)…[PR-05](../contracts/personalization.md), [PR-07](../contracts/personalization.md).
- What-next non-directive; anti-retell on **both** fields — [PR-05](../contracts/personalization.md) · [PR-06](../contracts/personalization.md).
- Skip / one union cache key — [PR-08](../contracts/personalization.md) · [PR-09](../contracts/personalization.md).
- English; ≤2 one invoke; last-good; no state templates — [PR-10](../contracts/personalization.md) · [PR-11](../contracts/personalization.md).
- `personalized_at` = why success; resurrect — [PR-12](../contracts/personalization.md).
- What-next gate / why-only — [PR-14](../contracts/personalization.md).
- Join / rank / what-next-null chrome / share chrome out — [PR-13](../contracts/personalization.md).
- Prompt bodies, Mermaid, hash bytes, gold → prompt / pipeline / evals / DBML.

**Locks** (design closed; build deferred)

| Question | Lock | Owner |
| --- | --- | --- |
| Model SKU | **Locked (X3):** `anthropic:claude-sonnet-5-5`; env `TEMPO_AI_PERSONALIZATION_MODEL`; same-SKU 2nd attempt; **no** Haiku escalate | Prompt ✓ |
| Per-attempt timeout | **Locked:** **15000** ms (`TEMPO_AI_PERSONALIZATION_TIMEOUT_MS`) | Pipeline ✓ |
| Member concurrency | **Locked:** default **2**, clamp **1–4** (`TEMPO_AI_PERSONALIZATION_CONCURRENCY`) | Pipeline ✓ |
| Closed `trigger_kind` enum | **Locked:** `clock` \| `warm` ([D-109](../../06-engineering/DECISIONS.md)) | Runs DBML ✓ |
| `input_hash` canonical bytes | PR-09 classes; exact serialization in pipeline | Pipeline ✓ |
| Practice note text (4 functions) | **Locked** F-pass + [practice-notes.seed.json](../../06-engineering/docs/data/practice-notes.seed.json) **v2**; import at build | Prompt / build |
| Gold suite | **24** cases arbiter-locked; advisory until promote; **no** LLM judge | Evals ✓ |
| DB/DBML review | **Locked** ([D-110](../../06-engineering/DECISIONS.md)) — no column changes | Data ✓ |
| Per-tick $ / cross-user budget | **Parked MVP** (like metastory D-100) | Pipeline ops bag |

---

## Non-functional requirements

**Security + privacy**

- Runs store `input_hash`, not why/next prose or full priority/stakeholder blurbs / practice-note body in hot logs (ids/versions OK).
- Send only PR-03/04 profile fields required for the invoke — do not widen model context with unrelated PII.

**Cost**

- Generative attempts stamp `estimated_cost_usd` from [model-pricing.json](../../07-ops/model-pricing.json); bare ids must exist in catalog before live spend.
- Visibility via `#ops-pricing-models` (daily spend + Monday unit catalog). SKU Sonnet 5.5 (X3).
- Skip / blocked paths → no model spend.

**UX handoff (display only)**

- No UX event triggers this stage — clock/warm only.
- Feed / d05 show when `personalized_at` is set ([PR-12](../contracts/personalization.md)); what-next may be null (chrome → [dashboard--v1.md](./dashboard--v1.md)).
- Share package composition → dashboard **B5**; why remains share-safe copy.

---

## Dependencies & Path 2

- **Depends on:** ingestion clock/warm; dashboard join → feed membership; metastory shared fields; extraction profile lanes 1–4; practice notes for what-next (why may run without).
- **Path 2 (build):** migrate `practice_notes` + `personalization_runs`; seed v2 import; wire prompt + advisory eval harness; instrument `personalization_invoke`. Disable/revert = stop invoke; keep last-good why/next on membership. Not a product experiment flag.

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stub PRD | Align artifact map | 27 Oct 26 | Contract draft |
| Practice notes authored later; rule locked | Same as process lock | 27 Oct 26 | First note draft |
| Contract locked (PR-01…14) | Skip-if-unchanged; retain; **PR-14** why-only when function/note gated (supersedes “block until notes”) | 27 Oct 26 | Contract PR change |
| `personalization_invoke` stub | Thin PostHog (D-088); skip silent | 31 Oct 26 | Instrumented at build |
| P5 share-safe why; process rules synced | Why vs what-next input split | 4 Nov 26 | Contract PR change |
| MVP carry P1–P14 encoded | [pipelines/personalization.md](../../06-engineering/docs/pipelines/personalization.md) §3; [D-108](../../06-engineering/DECISIONS.md) | 4 Nov 26 | Carry reopen |
| B4 P1 thin shell; lift Execution waiver | Contract = PR SoT; PRD = sequencing | 4 Nov 26 | — |
| B4 X1–X4 folded into PRD | UX/Data/Ops/Metrics | 4 Nov 26 | Build |
| SKU Sonnet 5.5; 15s; concurrency 2 (1–4) | X3 A′+M | 4 Nov 26 | Eval/cost evidence |
| `trigger_kind` clock\|warm | P6; runs DBML | 4 Nov 26 | DB artifact |
| Metrics under Solution + `trigger_kind` prop | D-088 peer parity | 4 Nov 26 | Instrument |
| No Must table; Constraints cite PR-\* | Metastory pattern | 4 Nov 26 | — |
| Contract C-pass C1–C7 | Trigger; PR-06 anti-retell; atomic both-fields | 4 Nov 26 | Contract change |
| B4 PRD P1–P10 deepen draft | Execution + NFR + Metrics written | 4 Nov 26 | Pipeline/prompt/evals/DB lock |
| Why-only / PR-14; `personalized_at` = why | Empty function or missing note; dashboard owns chrome | 5 Nov 26 | Contract PR change |
| Gold arbiter-locked (24); seed notes v2 | No LLM judge; house style no em dashes | 5 Nov 26 | Promote / flywheel |
| B4 DB/DBML design Locked (D-110) | No column changes; runs D-109 | 5 Nov 26 | Migrate at build |
