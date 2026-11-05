# Metastory model — cluster and shared event copy

Turn tagged shared stories into stable metastories with shared title, subtitle, what happened, and what changed.

Status: Design Locked (B3) — build deferred  
Owner: Felipe  
Update: 3 Nov 26  
Intent: ship

**Thin ship shell.** Do not duplicate the MR table, prompt text, or gold — change those in the SoTs below first. This PRD owns **invoke / build sequencing**, runtime gap vs today, and agent-ready **Execution**. Behavior SoT: locked [contract](../contracts/metastory.md) (MR-01…13). Clustering (embeddings + boundary) and the shared writer live in this stage — not separate product contracts.

**SoT (behavior — not a second copy here)**

- Product contract: [metastory.md](../contracts/metastory.md) (locked — B3 shell refresh D-092)
- Prompts: [metastory-boundary.md](../../06-engineering/docs/prompts/metastory-boundary.md) (Locked D-101) · [metastory-writer.md](../../06-engineering/docs/prompts/metastory-writer.md) (Locked D-103)
- Pipeline: [metastory.md](../../06-engineering/docs/pipelines/metastory.md) (Locked B3 · L1–L7 · D-106)
- Runs schema: [metastory-runs.dbml](../../06-engineering/docs/data/metastory-runs.dbml) (Locked B3 · D-106) · [dbdiagram](https://dbdiagram.io/d/6ae28fb1ed134e407e37a484)
- Product ERD: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) §§8–9 · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Evals / gold (call-kind only; arbiter-locked): index [metastory.md](../../06-engineering/docs/evals/metastory.md) · [metastory-boundary](../../06-engineering/docs/evals/metastory-boundary.md) (18 · D-104) · [metastory-writer](../../06-engineering/docs/evals/metastory-writer.md) (23 · D-105)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Eng decisions: [D-091](../../06-engineering/DECISIONS.md) (carry) · [D-092](../../06-engineering/DECISIONS.md) (contract shell) · [D-094](../../06-engineering/DECISIONS.md)–[D-106](../../06-engineering/DECISIONS.md)

**Siblings**

- Ingestion (handoff owner): [ingestion.md](../contracts/ingestion.md) (locked)
- Summarization: [summarization.md](../contracts/summarization.md) (locked) · [model--summarization--v1.md](./model--summarization--v1.md)
- Story-tagging: [story-tagging.md](../contracts/story-tagging.md) (locked) · [model--story-tagging--v1.md](./model--story-tagging--v1.md)
- Personalization: [model--personalization--v1.md](./model--personalization--v1.md)
- Dashboard UX (chrome / join / rank): [dashboard--v1.md](./dashboard--v1.md)
- Extraction: [model--extraction--v1.md](./model--extraction--v1.md)

**Ops pricing:** [07-ops/model-pricing.json](../../07-ops/model-pricing.json) (SoT — LLM **and** embedding token rates; **to-be inventory only** — D-094) · runtime copy under API `pricing/model-prices.json` · Slack `#ops-pricing-models`: **daily** model spend digest + **Monday** unit-price catalog review. No separate embed Slack channel.

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Many articles and posts about one event fragment attention; the operator needs one durable event object that stays stable as coverage grows.

**Why now:** Shared pool + keep-list + story-tagging + summarization locks are in place; without stable metastories the feed cannot ship. Contract shell refreshed for B3 (D-092).

**Gaps (B3):** Must-coherence Closed — summarization Constraints↔SR + story-tagging Constraints↔ST Locked (3 Nov 2026). **B4 personalization design Locked** (build deferred — [model--personalization--v1.md](./model--personalization--v1.md)). Metastory design Locked incl. DB/DBML (D-106). Build deferred. Product meaning lives in the [contract](../contracts/metastory.md).

**d05 soft length (done 5 Nov 2026):** `what_happened` / `what_changed` soft bars folded into [metastory-writer](../../06-engineering/docs/prompts/metastory-writer.md) + evals; gold evidence-earned thicken + carve-outs — closed before B5.

### Runtime gap (current vs target)

| Dimension | Live today (prototype) | Target (this PRD + contract) |
| --- | --- | --- |
| Trigger | Per-user dashboard **refresh** megapipe | Ingestion **clock / warm handoff** — no UX trigger |
| Sequence | One LLM cluster call groups **and** writes (title/subtitle/summary/tags/claims…); healer/caps around it | Embed → propose → deterministic repair → boundary → id/membership → material gate → writer |
| Identity | Evidence-hash id + prior-snapshot Jaccard/topic reuse (“title lock”) | Stable **UUID**; preserve when event continues (**+n/−n** OK); mint only after successful **title** write ([MR-05](../contracts/metastory.md)) |
| Shared fields | title, subtitle, summary, tags, associated_entities, factual_claims, … | **Only** title, subtitle, what_happened, what_changed ([MR-06](../contracts/metastory.md)); chips via story-tagging / membership chrome |
| What changed | Per-user / ever-seen 3-state engine (“your last refresh”) | Prior vs **current shared run** ([MR-09](../contracts/metastory.md)); material gate; null OK on first mint |
| Language | English meta-story fields; normalized evidence for writers when present | Shared **outputs** English ([MR-07](../contracts/metastory.md)); sources may be any language; prefer `article_summary` for model input when present |
| Lineage | Snapshot / `_meta` diagnostics; no stage `*_runs` SoT | `metastory_runs`: one row per **LLM attempt**; `call_kind` = boundary \| writer; embed/propose ≠ runs ([MR-13](../contracts/metastory.md)) |
| Evals | Dashboard / cluster hermetic suites (megapipe-shaped) | Split **boundary** + **writer** gold; P0 grounding (no runtime claims); advisory until trusted; no LLM judge in B3 |
| Embed | Mixed recall / cluster embedding use inside refresh | `story_embeddings` ([MR-04](../contracts/metastory.md) text); **`text-embedding-3-small` / `vector(1536)`** (D-094); skip when model + `embedded_text_hash` unchanged; not a chat prompt; not a runs row |

Do **not** treat prototype `cluster-v4` / refresh megapipe / user-relative what-changed as the target world.

---

## Goals

- Same real-world event keeps one metastory id across ticks; membership may grow/shrink (**+n/−n**) without forced id churn; split/merge under boundary + deterministic repair.
- Shared copy trustworthy: English outputs; what changed = prior vs current **shared** run; fail closed on invent merges / blank mint / spurious deltas; last-good when it exists.
- Guardrails: no publisher body stored; chips ≠ identity; grounding enforced in **writer evals** (no runtime claims schema).
- Measurement: `metastory_runs` + `#ops-pricing-models` + advisory gold + thin `metastory_invoke` ([D-088](../../06-engineering/DECISIONS.md)) — not a quality score.

---

## Solution

### Overview

Ingestion hands every new admit (and clock/warm pool work) to metastory → **embed** eligible text → **cluster propose** → **deterministic event-grain repair** → **boundary** (≤2, Sonnet 5.5) → **id / membership** → **shared-run material gate** → **writer** (≤2, Sonnet 5.5) → persist shared fields + membership → hand off to dashboard **join** / personalization. Exact thresholds and Mermaid live in eng siblings; SKUs D-094/D-095.

### Operator-visible

Operator does **not** trigger metastory. They see shared title / subtitle / what happened / what changed on the feed and open metastory; chrome, join, and rank owned by [dashboard--v1.md](./dashboard--v1.md). Why / what next → personalization.

### Scope

**In:**

- Embed + propose + deterministic repair + boundary + material gate + writer invoke sequencing
- Id stability + `metastory_stories` membership; persist four shared fields only
- Lineage (`metastory_runs`); specified `metastory_invoke`; ops pricing via models channel (incl. embed rates)

**Out:**

- Fetch/compliance; story-chip apply; summarization prompts
- Why / what next; feed UX / overflow / beat-fit pre-cluster / watermark
- Rising formulas; runtime claims schema; user-relative what-changed
- Prompt text, gold cases (siblings); threshold knobs advisory in pipeline (D-096)
- No Must REQ table — gates live as [MR-*](../contracts/metastory.md) + Execution Constraints below

---

## Execution spec (agent-ready)

**Goal:** On ingestion handoff for tagged shared-pool stories, form or update event-grained metastories: embed → propose → repair → boundary → membership/id → material gate → writer; persist **title+subtitle+what_happened** (required) and what_changed (null OK first mint) per [D-102](../../06-engineering/DECISIONS.md); never retain publisher body in this stage.

**Inputs**

- Tagged shared stories for the tick (press + X; chips may be empty)
- Keep-list fields; prefer `article_summary` for model/embed input when present; same-tick body only for new press when still in memory ([MR-08](../contracts/metastory.md))
- Prior metastories + membership + last shared copy
- Invoke signal: clock or warm via ingestion (closed `trigger_kind` → runs DBML in B3)

**Outputs**

- `metastories` row(s) when writer persist succeeds (**title+subtitle+what_happened** — [D-102](../../06-engineering/DECISIONS.md); or last-good retained)
- `metastory_stories` membership updates (soft detach / resurrect)
- `story_embeddings` upserts when embed runs
- Success / degraded signal to orchestrator
- `metastory_runs` rows per LLM attempt (`call_kind` boundary \| writer); skip/no-model → no row
- Thin PostHog `metastory_invoke` when instrumented (specified below)

**Core logic**

1. **Embed** eligible text per [MR-04](../contracts/metastory.md) → `story_embeddings`; skip when embed model + `embedded_text_hash` unchanged. Not a chat call; not a runs row.
2. **Cluster propose** among already-admitted stories ([MR-03](../contracts/metastory.md)).
3. **Deterministic event-grain repair** (adapted healer intent) — thresholds in pipeline.
4. **Boundary** ≤2 attempts → `metastory_runs` (`call_kind=boundary`); fail closed → keep prior graph ([MR-10](../contracts/metastory.md)).
5. **Id / membership** per [MR-05](../contracts/metastory.md): reuse UUID when event continues (+n/−n OK); mint only after successful writer persist (title+subtitle+what_happened — [D-102](../../06-engineering/DECISIONS.md)).
6. **Shared-run material gate** when prior run exists: none → keep last-good; do not invent what-changed. First mint → writer for title+subtitle+what_happened; `what_changed` may be null.
7. **Writer** ≤2 attempts → `call_kind=writer`: title, subtitle, what_happened, what_changed per D-102 requiredness. Prefer **prior title text** unless rename warranted. English outputs ([MR-07](../contracts/metastory.md)).
8. Persist / last-good / no blank mint per [MR-10](../contracts/metastory.md); hand off to join / personalization.

**Edge cases**

- Empty pool → invent nothing.
- Embed/propose fail → keep prior graph; do not admit by similarity from outside the pool.
- Boundary fail both attempts → prior graph; no invented merges/membership.
- Writer fail, last-good exists → keep copy; membership may commit (partial success).
- Writer fail, new event → no row, no membership.
- No article summary → thinner embed / what-happened; still English outputs when writing.
- Non-English sources → still process; never drop for language.

**Constraints** (agent-scannable; contract remains full MR SoT — no Must REQ table)

- No UX trigger — ingestion clock/warm handoff only (X1).
- Chips never force merge / identity — [MR-02](../contracts/metastory.md).
- Embed/propose do not admit outside pool (`post_download` exception only) — [MR-03](../contracts/metastory.md).
- Preserve id when event continues (+n/−n OK); mint only after successful writer persist (title+subtitle+what_happened) — [MR-05](../contracts/metastory.md) · [D-102](../../06-engineering/DECISIONS.md).
- Persist only title / subtitle / what_happened / what_changed; **title+subtitle+what_happened required** on success; what_changed null first mint only — [MR-06](../contracts/metastory.md) · [D-102](../../06-engineering/DECISIONS.md).
- Shared outputs English; don’t drop stories for source language; prefer `article_summary` for model input when present — [MR-07](../contracts/metastory.md).
- What changed = prior vs current **shared** run — not per-user — [MR-09](../contracts/metastory.md).
- Boundary & writer each ≤2; last-good / no blank mint / no invent merges — [MR-10](../contracts/metastory.md).
- Never store/log/show body; discard via orchestrator — [MR-11](../contracts/metastory.md) · [IR-05](../contracts/ingestion.md).
- Runs: one row per LLM attempt; `call_kind` boundary\|writer; embed/propose ≠ runs — [MR-13](../contracts/metastory.md).
- Material gate none → keep last-good; no spurious what-changed — contract Happy path.
- Title-prefer unless rename warranted — writer craft, not id scheme.
- Prompt bodies, Mermaid, thresholds → prompt / pipeline / evals / DBML. Embed: D-094. Boundary/writer SKUs: D-095.

**Open questions** (design Locked; build deferred)

| Question | Lock | Owner |
| --- | --- | --- |
| Boundary / writer model ids | **Locked (D-095):** both `anthropic:claude-sonnet-5-5`; fallback empty = same-SKU 2nd attempt; **no Opus** | Prompt ✓ |
| Embed SKU + `vector(N)` | **Locked:** `text-embedding-3-small` → `vector(1536)`; env `TEMPO_OPENAI_EMBEDDING_MODEL` (D-094) | Pipeline / DBML ✓ |
| Similarity / healer thresholds | **Locked advisory (D-096):** propose cosine **0.65**; split Jaccard **0.22**; **no** election-bundle path (continuity → boundary + B-F3) | Pipeline ✓ |
| Membership vs evidence cap | **Locked (D-097):** membership uncapped; LLM evidence **12**; rank 0.35/0.40/0.15/0.10; UI → dashboard | Pipeline ✓ |
| Closed `trigger_kind` enum | **Locked (D-098):** `clock` \| `warm` — no `x_edit` (IR-14 ≠ metastory) | Runs DBML ✓ |
| Idempotency / Mermaid | **Locked (D-099):** skip keys + thickened sequence | Pipeline ✓ |
| Ops revisit bag (tick budget, deferred recluster) | **Parked MVP (D-100)**; hash skip → D-099 | Pipeline ops ✓ |
| Gold suite size / dimensions | **Locked:** boundary N=18 (D-104); writer N=23 (D-105); advisory until promote | Evals ✓ |
| Advisory vs blocking | **B3 default:** advisory until trusted; no LLM judge | Evals / `engineer-qa` |
| Per-attempt LLM timeout | **Locked:** **15000** ms ceiling (`TEMPO_AI_METASTORY_TIMEOUT_MS`); shared with extraction / summarization / story-tagging / personalization | Pipeline ✓ |

---

## Non-functional requirements

**Security + privacy**

- Publisher body in memory only for same-tick what-happened when applicable; never persist, log, or display ([MR-11](../contracts/metastory.md)).
- Runs store `input_hash`, not body or full publisher payloads.
- Same-tick body only under [MR-08](../contracts/metastory.md) — writer Members may include optional `same_tick_body` for new press still in memory ([D-107](../../06-engineering/DECISIONS.md)); boundary stays body-free; never retain body after IR-05 discard.

**Cost**

- Boundary + writer generative calls stamp `estimated_cost_usd` from [model-pricing.json](../../07-ops/model-pricing.json).
- Embed usage priced from the same catalog (embedding SKUs); not a `metastory_runs` row — track in embed ops / spend digest when wired.
- Visibility via `#ops-pricing-models` (daily spend + Monday unit catalog). Embed D-094; boundary/writer Sonnet 5.5 D-095.

**UX handoff (display only)**

- No UX event triggers this stage — ingestion handoff only.
- Operators see shared fields on feed / [metastory-open](../../03-design/design-system/patterns/metastory-open.md); chrome owned by [dashboard--v1.md](./dashboard--v1.md).

### Metrics — metastory invoke (specified)

Shared LLM stack ([D-088](../../06-engineering/DECISIONS.md)): `metastory_runs` + ops spend + evals/gold, **plus** thin PostHog invoke. Embed/cluster-propose without an LLM call do **not** emit.

| Rule | Lock |
| --- | --- |
| When it fires | Once per finished **LLM** invoke (`call_kind` boundary \| writer), success or fail — **not** per attempt; **not** on embed/propose/heal; **not** on writer skip / material-gate none |
| Event | `metastory_invoke` |
| Properties | `trigger_id` · `call_kind` (`boundary` \| `writer`) · `outcome` (`success` \| `fail`) · `prompt_version` · `model_id` · `error_kind` if fail |
| Left out | Shared copy text, membership graphs, gold scores |
| Wiring | Specified, not instrumented |

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Clustering owned inside metastory stage | Embeddings + writer are one product unit | 27 Oct 26 | Contract change |
| What changed = prior vs current shared run | Replaces user-relative ever-seen engine | 27 Oct 26 | Eval fails on drift |
| Contract locked (MR-01…13) | Event grain; chips ≠ id; embed fallback; retries + last-good | 27 Oct 26 | Contract change |
| `metastory_invoke` specified | Thin PostHog once per finished LLM **invoke** per `call_kind` (not per attempt; D-088) | 31 Oct 26 | Instrumented at build |
| Writer same-tick body | Optional `same_tick_body` on writer Members (MR-08); boundary body-free (D-107) | 3 Nov 26 | IR-05 / eval W-F5 |
| MVP carry-over P1–P11 | Decompose megapipe; parking lot → dashboard/personalization/ST | 3 Nov 26 | [D-091](../../06-engineering/DECISIONS.md) |
| Caps ownership | Sources/membership ceiling → metastory (int later); feed count → dashboard | 3 Nov 26 | B3/B5 integers |
| Writer title-prefer | Prefer prior title unless rename warranted — not id scheme | 3 Nov 26 | Writer eval W-F8 |
| Ops revisit bag | Per-tick LLM/embed budget · deferred recluster · hash skip | 3 Nov 26 | Pipeline ops thicken |
| B3 X1–X4 | No UX trigger; data A; ops models channel; metrics B | 3 Nov 26 | Build |
| B3 P6 no Must table | Gates = MR-* + Execution Constraints (metastory pattern; SR/ST Must later retired in Must-coherence) | 3 Nov 26 | Constraint drift |
| B3 P8 Constraints 1–12 | Agent-scannable; cite MRs | 3 Nov 26 | Constraint drift |
| B3 P9 Runtime gap rows 1–9 | Autopilot must not port cluster-v4 | 3 Nov 26 | Live path ships |
| Post-B3 reminder | ~~Must coherence~~ → **Closed** (SR+ST Constraints); B4 personalization design Locked (build deferred) | 3 Nov 26 | Personalization build |
| Summarization Constraints↔SR | Retired Must REQ-*; Constraints cite SR-01…06·10 (+ IR-05); model bias stays Cost NFR | 3 Nov 26 | SR rule change |
| Story-tagging Constraints↔ST | Retired Must REQ-*; Constraints cite ST-09·03·07·01·14·05·06·15·11·02·08 (+ IR-08/05); model bias stays Cost NFR | 3 Nov 26 | ST rule change |
| Must-coherence Closed | SR + ST Constraints locked; B4 personalization design Locked | 3 Nov 26 | Personalization build |
| Metastory LLM timeout 15s | Align boundary+writer with extraction / summarization / story-tagging ceilings | 3 Nov 26 | Staging latency evidence |
