# Story-tagging model — apply shared vocab chips to stories

Mark each stored shared story with every topic, keyword, and geography in Tempo’s shared catalogs that the story text supports. One constrained model call; catalog IDs only.

Status: Spec locked (B2a) — Constraints↔ST coherence Locked (3 Nov 2026); build deferred  
Owner: Felipe  
Update: 03 Nov 26  
Intent: ship

**Thin ship shell.** Do not duplicate ST table, prompt text, or gold — change those in the SoTs below first. This PRD owns **invoke contract**, runtime gap vs today, build sequencing, and agent-ready Execution. Stage name is **story-tagging** (apply marks to the **shared pool** on every new admit — join filters the feed later). Distinct from **extraction**, which creates user chips and grows catalogs. Product behavior SoT: locked [contract](../contracts/story-tagging.md) (ST-01…15).

**SoT (behavior — not a second copy here)**

- Product contract: [story-tagging.md](../contracts/story-tagging.md) (locked)
- Prompt: [story-tagging.md](../../06-engineering/docs/prompts/story-tagging.md) (`story-tagging-v1` — Locked B2a)
- Pipeline: [story-tagging.md](../../06-engineering/docs/pipelines/story-tagging.md) (Locked B2a) — invoked from ingestion
- Evals / gold: [story-tagging.md](../../06-engineering/docs/evals/story-tagging.md) (Locked B2a) · [story-tagging.gold.json](../../06-engineering/docs/evals/story-tagging.gold.json) (22 + skip arbiter-locked)
- Runs schema: [story-tagging-runs.dbml](../../06-engineering/docs/data/story-tagging-runs.dbml) (Locked B2a) · [dbdiagram](https://dbdiagram.io/d/6ae28fe9ed134e407e37a621)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37) — `story_topics` / `story_keywords` / `story_geographies`

**Siblings**

- Ingestion (invoke owner): [ingestion.md](../contracts/ingestion.md) (locked) · [IR-08](../contracts/ingestion.md) · [IR-14](../contracts/ingestion.md)
- Extraction (user chips + catalog growth): [model--extraction--v1.md](./model--extraction--v1.md)
- Summarization (parallel same-tick): [model--summarization--v1.md](./model--summarization--v1.md)
- Metastory / dashboard (join / chrome): [model--metastory--v1.md](./model--metastory--v1.md) · [dashboard--v1.md](./dashboard--v1.md)

**Ops pricing:** [07-ops/model-pricing.json](../../07-ops/model-pricing.json) (SoT) · runtime copy under API `pricing/model-prices.json` · Slack `#ops-pricing-models`: **daily** model spend digest (by stage/`model_id`) + **Monday** unit-price catalog review.

**Locked product rules (process)** — full SoT: [contract ST-01…15](../contracts/story-tagging.md)

- One call → T/K/G IDs only; drop invent; no catalog growth
- Full shared catalogs at invoke; empty aperture → skip (ST-15)
- Press: title+body / title-only; X: `text`; IR-14 re-tag (fail → clear marks); no press re-tag from summary; no re-tag on catalog growth alone
- Replace-set; fail-open pool; ≤2 attempts; ST-14 body custody

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Join (source ∧ ≥1 chip) and metastory/dashboard chip chrome need durable story↔shared-vocab marks. Deterministic string match under-tags a growing open lexicon (paraphrase, bilingual). Press body is discarded after the admit tick, so marks must be right on first pass — not re-derived from keep-list or `article_summary`.

**Why now:** Shared pool + `story_*` joins exist; contract ST-01…15 locked (B2a edge clarity + ingestion handoff); summarization B2 SoTs locked; without an evaluable apply stage, marks stay undefined for join/chrome.

**Gaps (build only):** B2a design siblings Locked (pipeline, prompt, evals/gold, runs DBML). Runtime wire deferred — migrate `story_tagging_runs`, load prompt, advisory harness, `story_tagging_invoke`.

**Not a gap:** product meaning (ST locked); invoke ownership ([IR-08](../contracts/ingestion.md) / [IR-14](../contracts/ingestion.md)); tag **all** new admits (not only feed-visible stories) — join filters later.

### Runtime gap (current vs target)

| Dimension | Live today | Target (this PRD + SoTs) |
| --- | --- | --- |
| Trigger | No dedicated story-tagging invoke | Ingestion [IR-08](../contracts/ingestion.md): every new admit; [IR-14](../contracts/ingestion.md) on X text change |
| Skip | N/A | Empty aperture ([ST-15](../contracts/story-tagging.md)); IR-14 no text change; active duplicate ([IR-15](../contracts/ingestion.md)) |
| Input | — | Richest text + full shared catalog snapshot |
| Prompt / pipeline | Prompt + pipeline Locked B2a (not loaded at runtime yet) | Runtime loads `story-tagging-v1` + pipeline |
| Output | Joins exist; no LLM apply path as product SoT | Replace-set on `story_*` |
| Lineage | A4 stub DBML | Thickened runs; migrate at build |
| Evals | Locked B2a gold + code checks; **no** LLM judge | Advisory harness at build; promote gate later |

Do **not** treat prototype lexical gates as the target world.

---

## Goals

- Every **new admit** (press or X) and every **IR-14 X text change** gets one constrained story-tagging invoke from the richest available text (title+body, title-only, or X `text`) within ≤2 attempts — empty aperture excepted ([ST-15](../contracts/story-tagging.md) skip).
- Guardrails: catalog IDs only (drop invent; no lexicon growth); fail-open for pool; IR-14 final fail → empty replace-set; no press re-tag from `article_summary`; full shared catalogs at invoke (no chunking in v1); no re-tag on catalog growth alone.
- Model bias: **cost-aware quality** — Haiku-class primary → Sonnet-class escalate (exact ids in prompt SoT).
- Success: operational / qualitative ([contract Success](../contracts/story-tagging.md)) + thin `story_tagging_invoke` specified ([D-088](../../06-engineering/DECISIONS.md#2026-10-31---d-088---shared-thin-_invoke-posthog-events-for-all-llm-stages)) — not a quality score; evals advisory; **no** LLM judge in B2a.

---

## Solution

### Overview

Ingestion admits a shared story (or IR-14 replaces X `text`) → invoke story-tagging with richest text + full shared catalog snapshot → one constrained LLM call (≤2 attempts) → validate IDs ∈ aperture → **replace-set** `story_topics` / `story_keywords` / `story_geographies` → run rows when a model ran → return outcome. Empty aperture → skip LLM, empty replace-set, no run row. Same-tick with summarization / metastory what-happened: order flexible; body discard owned by the ingestion orchestrator ([ST-14](../contracts/story-tagging.md) · [IR-05](../contracts/ingestion.md)).

### User flow (operator-visible)

Operator does not trigger tagging. Marks surface indirectly via **dashboard join** (source ∧ ≥1 *user* chip) and metastory chip chrome — display owned by [dashboard--v1.md](./dashboard--v1.md). No story-tagging UI.

### Scope

**In:**

- Constrained T/K/G apply on new admit ([IR-08](../contracts/ingestion.md)) and IR-14 X text change
- Replace-set persistence; lineage; prompt / pipeline / evals ownership for this stage
- Closed `trigger_kind`: `clock` \| `warm` \| `x_edit`

**Out:**

- User chips / catalog growth ([extraction](./model--extraction--v1.md)); fetch, drains, compliance, IR-14 job ([ingestion](../contracts/ingestion.md))
- Article summary; metastory copy / clustering; dashboard join / chrome
- Inventing labels; catalog chunking; re-tag on catalog growth alone; press re-tag from `article_summary`
- Exact SKUs, prompt text, gold cases (siblings)
- LLM-as-judge for B2a

### Metrics — story-tagging invoke (specified)

Shared LLM stack ([D-088](../../06-engineering/DECISIONS.md#2026-10-31---d-088---shared-thin-_invoke-posthog-events-for-all-llm-stages)): `story_tagging_runs` + ops spend + evals/gold, **plus** thin PostHog invoke. Not a quality score; not join/chrome UX analytics.

| Rule | Lock |
| --- | --- |
| When it fires | Once when a story-tagging **LLM invoke** finishes (success or fail). Skip / no-model paths (IR-14 no-change, empty aperture) do **not** emit. Attempt 2 (Sonnet escalate) is the same invoke — **one** event (**not** per attempt). |
| Event | `story_tagging_invoke` |
| Properties | `trigger_id` · `trigger_kind` (`clock` \| `warm` \| `x_edit`) · `outcome` (`success` \| `fail`) · `prompt_version` · `model_id` (attempt that produced the persisted replace-set, or last attempt on fail) · `error_kind` if fail |
| Left out | Chip ID lists, story text, gold scores |
| Wiring | Specified, not instrumented |

---

## Execution spec (agent-ready)

**Goal:** On ingestion signal for every **new shared-story admit** (press or X) or **IR-14 X text change**, produce catalog-ID-only topic/keyword/geography marks from the richest available text + full shared catalog aperture, validate, replace-set, return success/failure/skip; never store publisher body; never invent chips. **Pool-wide** — do not limit tagging to stories that later appear in a user’s feed; [dashboard join](./dashboard--v1.md) filters visibility.

**Inputs**

- `story_id` + kind (`press` \| `x`) (keep-list already persisted)
- Text: press **title + body** (in memory) when body present; press **title only** when body absent; X keep-list **`text`**
- Snapshot of shared catalog IDs + labels (T/K/G) — `topics.name` / `keywords.name` / `geographies.name_normalized` ([tempo.dbml](../../06-engineering/docs/data/tempo.dbml))
- Invoke signal: `trigger_kind` Locked B2a: `clock` \| `warm` \| `x_edit`

**Outputs**

- Replace-set on `story_topics` / `story_keywords` / `story_geographies` (possibly empty)
- Success / failure / skip signal to ingestion (failure or skip → pool tick continues; metastory still handed)
- One `story_tagging_runs` row per LLM attempt (skip / no-model → no row)

**Core logic**

1. Skip LLM if catalog aperture is empty ([ST-15](../contracts/story-tagging.md)) → empty replace-set; no run row.
2. Build model input from richest text + aperture; fingerprint → `input_hash` (never store body bytes).
3. Call primary (Haiku-class) with `story-tagging-v1` prompt; on provider/timeout/config or runtime validation failure, escalate to Sonnet-class if attempts remain (≤2 attempts total same invoke — exact escalate rule in pipeline).
4. Validate: drop unknown / non-aperture / wrong-shelf IDs (no auto-move); dedupe per pipeline; keyword bar offline in eng/evals ([ST-10](../contracts/story-tagging.md)); remaining valid IDs may persist.
5. Persist replace-set (IR-14 final fail → **empty** replace-set); write run row(s); release body to orchestrator (do not discard here).
6. Return outcome to ingestion.

**Edge cases**

- Press body absent → title-only; still run (unless empty aperture).
- Active duplicate → ingestion does not invoke ([IR-15](../contracts/ingestion.md)).
- Admit retry → idempotent replace-set when invoked.
- IR-14 no text change → no invoke; no run row.
- Admit final fail → no new marks written.
- IR-14 text-change final fail → empty replace-set (clear priors).
- Never re-tag press from `article_summary` alone; never re-tag solely because catalogs grew.
- Both attempts fail → fail-open for pool; mark disposition per edges above; still hand metastory.

**Constraints** (agent-scannable; contract remains full ST SoT — no Must REQ table)

- Tag every new admit + IR-14 text change (pool-wide); join does not gate invoke — [ST-09](../contracts/story-tagging.md) · [IR-08](../contracts/ingestion.md)
- Catalog IDs only; drop invent / unknown / wrong-shelf; never INSERT catalogs — [ST-03](../contracts/story-tagging.md) · [ST-07](../contracts/story-tagging.md)
- Never store, log, or show publisher body; provider must not train on it — [ST-01](../contracts/story-tagging.md)
- Body discard only via ingestion orchestrator after same-tick consumers; this stage does not assume final discard — [ST-14](../contracts/story-tagging.md) · [IR-05](../contracts/ingestion.md)
- Replace-set is the full current mark set; IR-14 final fail → empty replace-set — [ST-05](../contracts/story-tagging.md) · [ST-06](../contracts/story-tagging.md)
- Empty aperture → skip LLM; empty replace-set; no run row — [ST-15](../contracts/story-tagging.md)
- Same-invoke retry only: ≤2 attempts total; final fail → fail-open for pool + mark disposition per ST-06 / admit edges — [ST-11](../contracts/story-tagging.md)
- Full shared catalogs at invoke (every T/K/G row); not per-user scope alone — [ST-02](../contracts/story-tagging.md)
- Marks are shared-pool assertions; join ceiling remains the user’s confirmed chips — [ST-08](../contracts/story-tagging.md)
- Fail open: story remains in pool; metastory handoff continues.
- Exact SKUs, prompt body, Mermaid, gold cases → prompt / pipeline / evals.

**Open questions** (design locks for B2a; build still deferred)

| Question | Lock | Owner |
| --- | --- | --- |
| Closed `trigger_kind` enum | **Locked:** `clock` \| `warm` \| `x_edit` | Runs DBML / pipeline ✓ |
| Tag which stories? | **Locked:** every new admit + IR-14 text change (pool-wide); join filters feed | This PRD / contract ✓ |
| Quality-escalate rule (when Haiku → Sonnet) | **Locked:** attempt 1 Haiku-class; attempt 2 Sonnet-class on provider/timeout/validation fail | Pipeline ✓ |
| Exact primary/fallback model ids | **Locked:** `anthropic:claude-haiku-5-5` → `anthropic:claude-sonnet-5-5`; temp 0; max_tokens 1024 | Prompt ✓ |
| Per-attempt timeout / concurrency | **Locked:** **15000** ms ceiling (shared with extraction + summarization + metastory + personalization); concurrent invokes **4** (clamp 1–8) | Pipeline ✓ |
| Post-model / user scope | **Locked:** drop unknown/wrong-shelf + dedupe only; **no** settings clamp, alias/lexical/URL/semantic backfill; join owns user chips | Pipeline ✓ / [ST-02](../contracts/story-tagging.md)·[ST-08](../contracts/story-tagging.md) |
| `input_hash` canonical bytes | **Locked:** `text_payload + "\n---\n" + catalog_payload` (tempo label fields) | Pipeline ✓ / runs DBML ✓ |
| Gold suite size / dimensions | **Locked:** st-skip-01 + st-01…22 (E3–E5) | Evals ✓ |
| Advisory vs blocking evals | **Locked for B2a:** advisory until promote gate; quality via gold/`ds-coder`, not PostHog | Evals / `engineer-qa` |

---

## Non-functional requirements

**Security + privacy**

- Press body in memory only for the admit tick; never persist, log, or display.
- Runs store `input_hash`, not body or full prompt dumps of publisher text.
- Provider must not train on the body when it was sent ([ST-01](../contracts/story-tagging.md)).
- No pre-LLM PII redaction of body/text in MVP (`PM input required` only if counsel requires later).

**Cost**

- Default path Haiku-class; Sonnet-class on escalate within ≤2 attempts.
- Stamp `estimated_cost_usd` from [07-ops/model-pricing.json](../../07-ops/model-pricing.json) at run write; ensure model ids exist in catalog before live spend.
- Env overrides at build (e.g. `TEMPO_AI_STORY_TAGGING_*`); visibility via `#ops-pricing-models` (**daily** stage spend + **Monday** unit catalog).
- Full catalog aperture v1 (no chunking); revisit if cost/quality evidence forces retrieval.

**UX handoff (display only)**

- No UX event triggers this stage — ingestion [IR-08](../contracts/ingestion.md) / [IR-14](../contracts/ingestion.md) only.
- Operators never author story chips; join / chip chrome owned by [dashboard--v1.md](./dashboard--v1.md).

---

## Dependencies & Path 2

- **Depends on:** ingestion invoke + body custody; shared catalogs from extraction; `story_*` in [tempo.dbml](../../06-engineering/docs/data/tempo.dbml).
- **Path 2 (build):** migrate `story_tagging_runs`; wire advisory eval harness; instrument `story_tagging_invoke`. Disable/revert = stop invoke + leave last replace-set (IR-14 fail path still clears when invoke runs and fails). Not a product experiment flag in B2a.

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stage named story-tagging | Distinct from extraction “create tags”; applies marks to stories | 28 Oct 26 | Naming conflict |
| Keywords in same model call as topics/geos | One body-in-memory operation; simpler orchestrate/eval | 28 Oct 26 | Keyword soft-match noise in gold |
| Full model stack (not a paragraph in ingestion) | Evaluable consistency; same LLM discipline as summarization | 28 Oct 26 | If rules prove enough in gold |
| Contract locked (ST-01…15) | B2a edge clarity + title-only; IR-14 fail clears; ST-15 empty aperture | 2 Nov 26 | Contract change |
| Tag all admits (approach A) | Shared pool marks; join filters feed; avoids per-user/circular tagging | 2 Nov 26 | Cost forces post-membership tag (B) |
| `trigger_kind` = `clock` \| `warm` \| `x_edit` | Align summarization admit grain + IR-14 path | 2 Nov 26 | Pipeline/runs rename |
| No LLM judge in B2a | Code checks + human gold; same as summarization B2 | 2 Nov 26 | Promote gate / judge need |
| Exact SKUs + prompt P1–P5 | Prompt Locked B2a: Haiku→Sonnet; wire; invent-hard rules; no few-shots | 2 Nov 26 | Gold forces prompt bump |
| `story_tagging_invoke` | Thin PostHog invoke + shared LLM stack (D-088) | 31 Oct 26 | Instrumented at build |
| B2a C4 Execution un-waived | Agent-ready I/O + Constraints + NFR | 2 Nov 26 | Sibling SoTs lock |
| B2a C0–C5 PRD locked | Gate-by-gate Problem→Goals→Solution→Execution→Constraints/NFR/Path2→Decisions; approach A | 2 Nov 26 | Contract change / sibling lock drift |
| B3 coherence: retire Must REQ table | Align with summarization / metastory P6 — Constraints cite ST-* only; model bias stays Cost NFR; avoid REQ↔ST collision | 3 Nov 26 | Contract ST change |
| B2a coherence ↔ contract/pipeline | Skip named; wrong-shelf; tempo label fields; ops daily+weekly; pipeline Locked in status/gaps | 2 Nov 26 | Further sibling lock |
| B2a runs DBML Locked | D1–D6: `clock`\|`warm`\|`x_edit`; hash; skip=no row; same error_kind spine as summarization ([D-090](../../06-engineering/DECISIONS.md#2026-11-02---d-090---phase-b2a-story-tagging-artifacts-locked-incl-runs-dbml)) | 2 Nov 26 | Migration / schema drift |
| Story-tagging artifact coherence | Cross-check contract ↔ PRD ↔ prompt ↔ pipeline ↔ runs ↔ evals/gold; residual skip/`no_posthog` + Locked-B2a pointer fixes only | 02 Nov 26 | Rule drift / stage reopen |
| MVP carry-over timeout / post-model | **15s**/attempt; concurrency 4; drop/dedupe only; no settings clamp / lexical backfill | 2 Nov 26 | Cost/quality forces aperture retrieval or soft length gate |
