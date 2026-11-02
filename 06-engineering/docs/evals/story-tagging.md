# Story-tagging — eval / gold SoT

> **Stage:** Story-tagging (shared-vocab chip apply at ingest) · **Status:** Locked (B2a — E1–E6 + gold arbiter) · **Last updated:** 2 Nov 2026  
> **Altitude:** Eval craft + gold. Advisory until a promote gate exists. No LLM judge in B2a.  
> **Domain arbiter:** Felipe (PM)

**Related**

- Product PRD: [model--story-tagging--v1.md](../../../02-product/prds/model--story-tagging--v1.md)
- Product contract: [story-tagging.md](../../../02-product/contracts/story-tagging.md) (locked — ST-01…15)
- Prompt: [prompts/story-tagging.md](../prompts/story-tagging.md) (`story-tagging-v1` — Locked B2a)
- Pipeline: [pipelines/story-tagging.md](../pipelines/story-tagging.md) (Locked B2a) — runtime V1–V2; invent/wrong-shelf drop; keyword bar offline
- Gold: [story-tagging.gold.json](./story-tagging.gold.json) (Locked B2a)
- Runs: [story-tagging-runs.dbml](../data/story-tagging-runs.dbml) (Locked B2a) · [dbdiagram](https://dbdiagram.io/d/6ae28fe9ed134e407e37a621)
- Pattern: `06-engineering/docs/evals/{stage}.md` · sibling [summarization.md](./summarization.md) · [extraction.md](./extraction.md)

---

## 1. Architecture (E1) — PM locked

| Layer | Role |
|-------|------|
| **Deterministic / `ds-coder`** | Schema/empty (pipeline V1–V2); unknown + wrong-shelf drop behavior; optional set precision/recall vs expected IDs after normalize/dedupe |
| **Human gold** | Cases: story text + catalog aperture + expected `topic_ids` / `keyword_ids` / `geography_ids` + `rubric_notes` |
| **LLM judge** | **Out of scope** for B2a (`ds-judge` / `ds-validator` deferred) |
| **Posture** | **Advisory** until promote gate; empty `examples` is **not** a pass |

Over/under-tag and keyword-bar judgment are **human arbiter vs expected** — not an LLM judge. Invent / wrong-shelf / schema are **code**.

**Out of model eval:** dashboard join / chip chrome UX.

---

## 2. Failure modes (E2) — PM locked

| ID | Failure mode | Measurable how? | Priority |
|----|--------------|-----------------|----------|
| **F1** | Invents IDs / labels not in aperture | Code (drop) + human if invent attempted | Now |
| **F2** | Wrong-shelf IDs (e.g. topic id in `keyword_ids`) | Code (drop) + human | Now |
| **F3** | Empty / unparseable JSON (V1–V2) | Code | Now |
| **F4** | Over-tags topics/geos (unsupported catalog rows) | Human vs expected | Now |
| **F5** | Under-tags topics/geos (misses clear supports) | Human vs expected | Now |
| **F6** | Keyword bar too loose (stretch) or too strict (miss clear term) | Human vs expected | Now |
| **F7** | Bilingual / paraphrase miss on topic/geo | Human vs expected | Now |
| **F8** | Join/chrome UX wrong | **Out of model eval** — dashboard | Later / not here |

---

## 3. Dimensions + size (E3–E4) — PM locked

| Dimension | Values |
|-----------|--------|
| **D1 Language** | `en` · `es` · `mixed` |
| **D2 Text shape** | `press_title_body` · `press_title_only` · `x_text` |
| **D3 Stress** | `happy` · `invent_bait` · `wrong_shelf_bait` · `keyword_strict` · `paraphrase_bilingual` · `under_tag_risk` |

**Mix (E4):** ~**20–24** cases — mostly **synthetic** + **2–4 `derived_real`** sampled from wired RSS feeds in [`source-feeds.json`](../../apps/api/data/source-feeds.json) (same posture as summarization: RSS is a **sampling aid only**, not the runtime NewsAPI admit SoT). Derived bodies = shortened feed teasers (title + description), not scraped full articles.

**Empty aperture:** **one code-only / skip fixture** (ST-15) — asserts skip LLM, empty replace-set, no run row, no PostHog. **Not** a model-invoke gold case (no prompt call). Lives in evals doc + harness as `kind: skip` (or sibling code test); does not consume a model-gold slot.

---

## 4. Tuple map (E5) — PM locked

| id | D1 | D2 | D3 | source |
|----|----|----|----|--------|
| st-01 | en | press_title_body | happy | synthetic |
| st-02 | en | press_title_only | happy | synthetic |
| st-03 | en | x_text | happy | synthetic |
| st-04 | en | press_title_body | invent_bait | synthetic |
| st-05 | en | press_title_body | wrong_shelf_bait | synthetic |
| st-06 | en | press_title_body | keyword_strict | synthetic |
| st-07 | en | press_title_body | paraphrase_bilingual | synthetic |
| st-08 | en | press_title_body | under_tag_risk | synthetic |
| st-09 | es | press_title_body | happy | synthetic |
| st-10 | es | press_title_only | happy | synthetic |
| st-11 | es | x_text | keyword_strict | synthetic |
| st-12 | es | press_title_body | paraphrase_bilingual | synthetic |
| st-13 | es | press_title_body | invent_bait | synthetic |
| st-14 | mixed | press_title_body | happy | synthetic |
| st-15 | mixed | press_title_body | paraphrase_bilingual | synthetic |
| st-16 | en | x_text | invent_bait | synthetic |
| st-17 | en | press_title_only | under_tag_risk | synthetic |
| st-18 | es | press_title_body | under_tag_risk | synthetic |
| st-19 | en | press_title_body | happy | derived_real |
| st-20 | es | press_title_body | happy | derived_real |
| st-21 | en | press_title_only | happy | derived_real |
| st-22 | en | x_text | keyword_strict | derived_real |

**Skip fixture (not model gold):** `st-skip-01` — empty aperture · `kind: skip` · code-only (ST-15).

**X sampling:** Prefer `ingestion_recent_items` cache / X warm path (`x:{handle}`, e.g. `petrogustavo`, `whitehouse`) — not `source-feeds.json` RSS. If no usable cached X text, substitute synthetic `x_text` and note in gold `source` / `rubric_notes`.

---

## 5. Gold schema (E6) — PM locked

`schemaVersion`: `story-tagging-gold-v1` · `promptVersion`: `story-tagging-v1`

Per **model** example (`st-NN`):

| Field | Rule |
|-------|------|
| `id` | `st-NN` |
| `kind` | `model` |
| `source` | `synthetic` \| `derived_real` |
| `language` / `shape` / `stress` | D1–D3 |
| `title` / `body` / `text` | Per D2 (unused fields `""`) |
| `catalog` | Fixture aperture: `topics[]` `{id,name}` · `keywords[]` `{id,name}` · `geographies[]` `{id,name_normalized}` — **stable gold UUIDs**, not live DB |
| `expected.topic_ids` / `keyword_ids` / `geography_ids` | Arbiter-locked sets (order-insensitive; set P/R after normalize/dedupe) |
| `code_checks` | Subset of `schema` · `no_invent` · `no_wrong_shelf` · `dedupe` |
| `rubric_notes` | Why those ids; traps; derived_real provenance |

**Skip fixture** (`st-skip-01`): `kind: skip` · empty `catalog` · `expected.outcome: skip` · `code_checks`: `skip_no_llm` · `empty_replace_set` · `no_run_row` · `no_posthog` — expect no LLM / empty replace-set / no run row / no `story_tagging_invoke`.

---

## 6. `ds-coder` checklist (offline / harness later)

| Check | Aligns | Notes |
|-------|--------|-------|
| `schema` | V1–V2 | Parse JSON with three ID arrays |
| `no_invent` | F1 / ST-07 | Every output id ∈ per-kind aperture (after drop, none remain outside) |
| `no_wrong_shelf` | F2 | No topic id in keyword/geo arrays (etc.) |
| `dedupe` | Pipeline | Unique ids per array |
| Set P/R | F4–F7 advisory | vs `expected.*` after normalize — human arbiter still owns over/under |
| `skip_no_llm` / `empty_replace_set` / `no_run_row` / `no_posthog` | ST-15 / D-088 | **Skip fixture only** (`st-skip-01`) — no model call |

**Not code-gated in B2a:** paraphrase/bilingual quality, keyword stretch judgment — human arbiter.

---

## 7. Arbiter pass

**Locked (B2a gold):** st-skip-01 + st-01…22 arbiter-locked (Felipe, 2 Nov 2026). Suite ready for harness; advisory until a promote gate.

---

## Decision log (B2a)

| Date | Lock | Choice |
|------|------|--------|
| 2 Nov 2026 | **E1** | PM locked: code checks + human gold; no judge; advisory; arbiter = Felipe; set P/R optional vs expected IDs |
| 2 Nov 2026 | **E2** | PM locked: F1–F7 Now; F8 out of model eval |
| 2 Nov 2026 | **E3–E4** | PM locked: D1–D3 as tabled; ~20–24 cases; synthetic + 2–4 derived_real from RSS wiring; 1 empty-aperture **code-only skip** fixture (not model gold) |
| 2 Nov 2026 | **E5** | PM locked: st-01…22 tuple map + st-skip-01; st-22 derived_real X with synthetic fallback if needed |
| 2 Nov 2026 | **E6 schema** | PM locked: `story-tagging-gold-v1` fields as tabled; hermetic fixture UUIDs; fill + arbiter next |
| 2 Nov 2026 | **Gold arbiter** | Felipe locked st-skip-01 + st-01…22; st-22 from X warm cache (`x:whitehouse`); empty geos on that case; suite Locked B2a |
| 2 Nov 2026 | Coherence pass | Skip `code_checks` include `no_posthog`; §6 lists skip checks; dims match gold |
