# Summarization model — factual article summary at ingest

Write one factual Tempo **article summary** per new press URI from that URI’s vendor body in memory. Persist the summary for clustering / later refreshes and as the **source-reader snippet** (labeled as Tempo’s summary). Body discard is owned by the **ingestion orchestrator** after same-tick consumers finish — not by this stage alone.

Status: Spec locked (B2) — build deferred  
Owner: Felipe  
Update: 02 Nov 26  
Intent: ship

**Thin ship shell.** Do not duplicate SR table, prompt text, or gold — change those in the SoTs below first. This PRD owns **invoke contract**, runtime gap vs today, build sequencing, and agent-ready Execution. Stage name is **summarization**; stored field is **article summary** (avoid bare “summary,” which collides with Paper’s what-happened Summary). X posts are **not** summarized; post text is the record.

**SoT (behavior — not a second copy here)**

- Product contract: [summarization.md](../contracts/summarization.md) (locked)
- Prompt: [summarization.md](../../06-engineering/docs/prompts/summarization.md) (`summarization-v1` — Locked B2)
- Pipeline: [summarization.md](../../06-engineering/docs/pipelines/summarization.md) (Locked B2)
- Runs schema: [summarization-runs.dbml](../../06-engineering/docs/data/summarization-runs.dbml) (Locked B2) · [dbdiagram](https://dbdiagram.io/d/6ae28ffced134e407e37a6d0)
- Evals / gold: [summarization.md](../../06-engineering/docs/evals/summarization.md) · [summarization.gold.json](../../06-engineering/docs/evals/summarization.gold.json) (Locked B2; arbiter 22/22)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)

**Siblings**

- Ingestion (invoke owner): [ingestion.md](../contracts/ingestion.md) (locked) · [IR-11](../contracts/ingestion.md)
- Story-tagging (parallel same-tick): [model--story-tagging--v1.md](./model--story-tagging--v1.md)
- Metastory consumer: [model--metastory--v1.md](./model--metastory--v1.md)
- Dashboard / source-reader **display**: [dashboard--v1.md](./dashboard--v1.md) · [source-reader](../../03-design/design-system/patterns/source-reader.md)

**Ops pricing:** [07-ops/model-pricing.json](../../07-ops/model-pricing.json) (SoT) · runtime copy under API `pricing/model-prices.json` · Slack `#ops-pricing-models`: **daily** model spend digest (by stage/`model_id`) + **Monday** unit-price catalog review.

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Metastory grouping and in-app source scan need more than a headline, without retaining publisher bodies — and NewsAPI.ai provides no excerpt field.

**Why now:** Keep-list + source-reader locks require a durable Tempo-owned stand-in for the body. B2 design SoTs are Locked; remaining gap is **runtime build** (after sibling models are defined).

**Gaps (build only):** Wire IR-11 invoke → persist `article_summary` → runs rows → `summarization_invoke`; migrate `summarization_runs`; advisory harness. Product meaning lives in the [contract](../contracts/summarization.md).

### Runtime gap (current vs target)

| Dimension | Live today | Target (this PRD + SoTs) |
| --- | --- | --- |
| Trigger | No dedicated summarization invoke on NewsAPI admit | Ingestion [IR-11](../contracts/ingestion.md): new press admit **with body in memory** |
| Skip | N/A (stage not shipped) | X; no body; `article_summary` already present (incl. resurrect) |
| Input | — | That URI’s **title + body** only (in memory; never multi-URI stitch) |
| Prompt | SoT Locked B2 — [prompts/summarization.md](../../06-engineering/docs/prompts/summarization.md); not loaded at runtime yet | Runtime loads `summarization-v1` |
| Output | No Tempo `article_summary` path as product SoT | Persist `press_articles.article_summary` (plain English string) |
| Body custody | — | Release to orchestrator; discard only after same-tick consumers ([IR-05](../contracts/ingestion.md)) — **not** discard inside this stage alone |
| Lineage | DBML Locked B2; not migrated to Supabase | `summarization_runs` per LLM attempt; skips insert no row |
| Source reader | Title (+ meta); prototype paths ≠ article summary | Snippet = article summary when present (labeled Tempo summary + Open original) |
| Evals | Gold Locked B2 (22/22 arbiter); harness not wired | Advisory gold + code checks; **no** LLM judge in B2 |

Do **not** treat RSS / prototype AI summarization paths as the target world.

---

## Goals

- Every new press URI **with body in memory** and **without** an existing article summary gets one factual English article summary in the same tick (≤2 attempts), before the orchestrator drops the body.
- Guardrails: no so-what; paraphrase-first; soft density (typically 2–4 sentences); summary never presented **as** the article (disclosure + Open original — dashboard chrome); **fail closed** for body retention and inventing a summary; **fail open** for admitting the URI (keep-list without summary — ingestion).
- Model bias: **cost-aware quality** — Haiku-class primary → Sonnet-class quality fallback (exact ids in prompt SoT). Metastory remains the premium surface; article summary must still be trustworthy in source reader.

Success signals stay operational / qualitative for v1 (contract Success table) + thin `summarization_invoke` specified below ([D-088](../../06-engineering/DECISIONS.md#2026-10-31---d-088---shared-thin-_invoke-posthog-events-for-all-llm-stages)) — not a quality score; evals advisory; **no** LLM judge in B2.

---

## Solution

### Overview

Ingestion admits a new press URI → persist keep-list (no body) → hold body in memory → **summarization** (when body present and summary missing) writes `article_summary` + run rows → same-tick story-tagging / metastory what-happened as needed → **orchestrator discards body**. Output is a plain English prose string on `press_articles.article_summary`.

### User flow (operator-visible)

Operator does not trigger summarization directly. They see the result when opening a source from an open metastory (**source reader**): labeled Tempo summary + Open original when `article_summary` is present; title + meta + Open original only when absent.

### Scope

**In:**

- Press article summarization invoke (IR-11), lineage, prompt/pipeline/evals ownership for this stage
- Persist plain-string `article_summary`; source-reader **content** handoff (display chrome = dashboard)

**Out:**

- X post summarization; multi-URI / multi-body stitch; title/excerpt-only invent
- Fetch, drains, compliance (ingestion); story chips (story-tagging); metastory shared copy / clustering
- Presenting summary as the article; storing/logging/showing body; filling `excerpt` from truncated `body`
- Hard character caps, exact model ids, gold cases, prompt text (siblings)
- LLM-as-judge for B2

---

## Execution spec (agent-ready)

**Goal:** On ingestion signal for a new press `uri` with vendor body in memory and no existing `article_summary`, produce one factual English prose article summary, validate, persist, return success/failure; never retain body in this stage.

**Inputs**

- Press `uri` / `story_id` (keep-list already persisted)
- Title + **that URI’s body only** (in memory)
- Invoke signal: clock or warm (`trigger_kind` Locked B2: `clock` \| `warm`)

**Outputs**

- `press_articles.article_summary` (string) on success
- Success / failure to ingestion (failure → no summary; pool tick continues)
- One `summarization_runs` row per LLM attempt (skip/no-model → no row)

**Core logic**

1. Skip if X, no body, or `article_summary` already present (incl. resurrect).
2. Build model input: title + body; fingerprint → `input_hash` (never store body bytes).
3. Call primary (Haiku-class) with `summarization-v1` prompt; on provider/timeout/config error **or** runtime validation fail (V1–V3), escalate to Sonnet-class if attempts remain (≤2 attempts total same invoke — [pipeline](../../06-engineering/docs/pipelines/summarization.md)).
4. Validate runtime bars (non-empty; plain string; so-what denylist). Soft density / body-echo / factuality → offline gold ([evals](../../06-engineering/docs/evals/summarization.md)) — not runtime escalate triggers.
5. Persist article summary; write run row(s); release body to orchestrator (do not discard here).
6. Return outcome to ingestion.

**Edge cases**

- No body → skip; no invent from title/excerpt.
- Non-English body → still invoke; English summary; omit uncertain slots.
- Thin / incomplete 4W → omit unsupported; if nothing usable → fail (no store).
- Both attempts fail → failure signal; no summary; body still held for other same-tick consumers until [IR-05](../contracts/ingestion.md) discard.
- Already has summary → idempotent skip; no MVP overwrite/backfill.

**Constraints**

- Fail closed: body retention, inventing summary, multi-body stitch, URL scrape for body.
- Fail open: URI remain on keep-list without summary.
- Provider must not train on body.
- Exact SKUs, prompt body, Mermaid, overlap thresholds → prompt / pipeline / evals.

**Open questions** (design Locked; build still deferred)

| Question | Lock | Owner |
| --- | --- | --- |
| Exact primary/fallback model ids | **Locked:** `anthropic:claude-haiku-5-5` → `anthropic:claude-sonnet-5-5` | Prompt ✓ |
| Quality-escalate rule (when Haiku → Sonnet) | **Locked:** attempt 1 Haiku; attempt 2 Sonnet on provider/timeout/validation fail | Pipeline ✓ |
| Max body chars sent to model | **Locked:** full vendor body MVP; truncate N deferred | Pipeline ✓ |
| Per-attempt timeout | **Locked:** **15000** ms ceiling (shared with extraction + story-tagging) | Pipeline ✓ |
| Concurrent URI summarizations | **Locked:** **4** (clamp 1–8) | Pipeline ✓ |
| Output length runtime | **Locked:** trim only; no hard char cap / overlap-% gate; soft density + F7 advisory offline | Pipeline ✓ / evals ✓ |
| So-what denylist (V3) | **Locked:** keep 7-phrase list; expand only from gold fails | Pipeline ✓ |
| Closed `trigger_kind` enum | **Locked:** `clock` \| `warm` | Runs DBML ✓ |
| Gold suite size / dimensions | **Locked:** 22 cases (18 synthetic + 4 derived_real); arbiter pass done | Evals ✓ |
| Advisory vs blocking evals | **Locked for B2:** advisory until promote gate; quality via gold/`ds-coder`, not PostHog | Evals / `engineer-qa` ✓ |

---

## Must constraints

| ID | Requirement | Acceptance | Trace |
| --- | --- | --- | --- |
| **REQ-01** | Press only; never summarize X | X admits never call summarization | [SR-01](../contracts/summarization.md) |
| **REQ-02** | Never store, log, or show publisher body; no-train on provider | No body column/logs; runs use `input_hash` only | [SR-02](../contracts/summarization.md) |
| **REQ-03** | Never invent a summary without a usable body; omit unsupported 4W | No title-only invent; empty/unusable → fail | [SR-03](../contracts/summarization.md)·[SR-05](../contracts/summarization.md) |
| **REQ-04** | Body discard only via ingestion orchestrator after same-tick consumers | Stage releases body; does not assume final discard | [IR-05](../contracts/ingestion.md)·[SR-02](../contracts/summarization.md) |
| **REQ-05** | Persist plain English prose string only (not JSON/bullets as stored form) | `article_summary` text column | [SR-05](../contracts/summarization.md)·C2 |
| **REQ-06** | Skip invoke when `article_summary` already present (incl. resurrect) | Idempotent; no MVP overwrite | [SR-05](../contracts/summarization.md) |
| **REQ-07** | Cost-aware model bias: Haiku-class primary → Sonnet-class quality fallback | Prompt/router defaults match bias; Opus not default | P5 B1 |

---

## Non-functional requirements

**Security + privacy**

- Body in memory only for the admit tick; never persist, log, or display.
- Runs store `input_hash`, not body or full prompt dumps of publisher text.
- Provider must not train on the body ([SR-02](../contracts/summarization.md)).
- No pre-LLM PII redaction of body in MVP (`PM input required` only if counsel requires later).

**Cost**

- Default path Haiku-class; Sonnet-class on quality escalate within ≤2 attempts.
- Stamp `estimated_cost_usd` from [07-ops/model-pricing.json](../../07-ops/model-pricing.json) at run write; ensure model ids exist in catalog before live spend.
- Env overrides at build (see `.env.example` `TEMPO_AI_SUMMARIZATION_*`); visibility via `#ops-pricing-models` (**daily** stage spend + **Monday** unit catalog).

**UX handoff (display only)**

- No UX event triggers this stage — ingestion [IR-11](../contracts/ingestion.md) only.
- Operators see `article_summary` in the [source reader](../../03-design/design-system/patterns/source-reader.md) (d08); chrome / disclosure copy owned by [dashboard--v1.md](./dashboard--v1.md).

### Metrics — summarization invoke (specified)

Shared LLM measurement stack ([D-088](../../06-engineering/DECISIONS.md)): `summarization_runs` + ops spend + evals/gold, **plus** a thin PostHog invoke event. Not a quality score; not source-reader UX analytics.

| Rule | Lock |
| --- | --- |
| When it fires | Once when a summarization **LLM invoke** finishes (success or fail). Skip paths (X, no body, summary already present) do **not** emit. Attempt 2 (Sonnet escalate) is the same invoke — **one** event. |
| Event | `summarization_invoke` |
| Properties | `trigger_id` · `trigger_kind` (`clock` \| `warm`) · `outcome` (`success` \| `fail`) · `prompt_version` · `model_id` (attempt that produced the persisted summary, or last attempt on fail) · `error_kind` only when `outcome` is `fail` |
| Left out | Body, article summary text, token counts (runs SoT), gold scores |
| Wiring | Specified, not instrumented. Baseline/target `PM input required` |

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stage named summarization; field article summary | NLP-standard stage; avoid “brief” / bare “summary” collisions | 27 Oct 26 | Naming conflict in Paper/DB |
| Full model stack (own pipeline, not only a paragraph in ingestion) | Stored text other models depend on; same LLM discipline as extraction | 27 Oct 26 | If summarization proves trivial deterministic |
| Fail posture aligned to contract | Fail closed body + no invent; fail open URI; English MVP; 1 same-invoke retry | 27 Oct 26 | Contract change |
| SR-07: summary = source-reader snippet | NewsAPI has no excerpt; operators need in-app scan | 28 Oct 26 | Counsel / UX copy fail |
| B2 P1 thin ship shell | Contract + eng siblings are behavior SoTs; PRD = invoke/build shell | 30 Oct 26 | Agents miss gates without Must |
| B2 P2–P3 runtime gap table | Autopilot must not treat prototype paths as target | 30 Oct 26 | Live path ships |
| B2 P4 Execution un-waived | Contract locked; agent-ready I/O + edges | 30 Oct 26 | — |
| B2 P5 B1 model bias | Haiku→Sonnet cost-aware quality; metastory is premium surface; summary still trust-visible | 30 Oct 26 | Gold shows systematic Haiku fails |
| B2 P6 short Must REQs | Agent-scannable gates; contract remains full SR SoT | 30 Oct 26 | REQ drift vs contract |
| B2 P7 thin NFR; no Path 2 | Custody + cost visible; MVP not a gated experiment | 30 Oct 26 | Kill-switch / canary desired |
| B2 P8 open questions table | Defaults parked on pipeline / prompt / evals / runs | 30 Oct 26 | Each sibling locks |
| B2 X4 `summarization_invoke` | Thin PostHog invoke + shared LLM stack (D-088); no chip-like UX metric | 31 Oct 26 | Instrumented at build |
| B2 hygiene | Status Spec locked; gap/open-Q tables match Locked siblings (D-089) | 1 Nov 26 | Build ships live path |
| Summarization artifact coherence | Align Success/`summarization_invoke`, escalate wording ↔ pipeline V1–V3, ops daily+weekly; contract runtime gap no longer “prompt lands” | 02 Nov 26 | Next stage coherence pass |
| MVP carry-over timeout / length / denylist | **15s**/attempt; trim-only length; keep V3 so-what list; no cluster/claim-join as this stage | 2 Nov 26 | Live digests → soft length escalate; gold F7 |
