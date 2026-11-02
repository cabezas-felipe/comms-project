# Summarization — eval / gold SoT

> **Stage:** Summarization (factual press article summary at ingest) · **Status:** Locked (B2 craft + arbiter gold) · **Last updated:** 2 Nov 2026 (coherence pass)  
> **Altitude:** Eval craft + gold. Advisory until a promote gate exists. No LLM judge in B2.  
> **Domain arbiter:** Felipe (PM) — **22/22 cases locked** in chat (1 Nov 2026).

**Related**

- Product PRD: [model--summarization--v1.md](../../../02-product/prds/model--summarization--v1.md)
- Product contract: [summarization.md](../../../02-product/contracts/summarization.md) (locked — SR-01…13)
- Prompt: [summarization.md](../prompts/summarization.md) (`summarization-v1` — Locked B2)
- Pipeline: [summarization.md](../pipelines/summarization.md) (Locked B2) — runtime V1–V3; soft checks offline
- Gold: [summarization.gold.json](./summarization.gold.json) (Locked B2; arbiter 22/22)
- Runs: [summarization-runs.dbml](../data/summarization-runs.dbml) (Locked B2) · [dbdiagram](https://dbdiagram.io/d/6ae28ffced134e407e37a6d0)
- Pattern: `06-engineering/docs/evals/{stage}.md` · sibling [extraction.md](./extraction.md) · [story-tagging.md](./story-tagging.md)

---

## 1. Architecture (E1)

| Layer | Role |
|-------|------|
| **Deterministic / `ds-coder`** | Empty / plain-string / so-what denylist / optional soft length — align pipeline V1–V3 + offline soft band |
| **Human gold** | 22 authored cases: title + body + reference `expected.article_summary` + `rubric_notes` |
| **LLM judge** | **Out of scope** for B2 (`ds-judge` / `ds-validator` deferred) |
| **Posture** | **Advisory** until promote gate; empty `examples` is **not** a pass |

Free-text factuality (F2/F5/F6) is **human arbiter vs body + expected** — not exact-match P/R. `expected.article_summary` is a reference, not a string-equality gate.

---

## 2. Failure modes (E2)

| ID | Failure mode | Measurable how? | Priority |
|----|--------------|-----------------|----------|
| **F1** | So-what / editorial voice | Code denylist (pipeline §4.1) + human | Now |
| **F2** | Invents facts not in title+body | Human vs body / expected | Now |
| **F3** | Long body echo / near-verbatim | Offline overlap heuristic + human | Now |
| **F4** | Empty / non-prose envelope | Code (V1–V2) | Now |
| **F5** | Pads unsupported 4W / world knowledge | Human | Now |
| **F6** | Weak/wrong ES→EN (or invents when uncertain) | Human | Now |
| **F7** | Too long / digest-like (soft density) | Soft band + human | Next |
| **F8** | UI: summary shown as the article | **Out of model eval** — dashboard / source-reader chrome | Later / not here |

---

## 3. Dimensions + size (E3–E4)

| Dimension | Values |
|-----------|--------|
| **D1 Language** | `en` · `es` · `mixed_within_body` |
| **D2 Article shape** | `wire_complete_4w` · `thin_incomplete_4w` · `quote_heavy` · `long_digressive` |
| **D3 Stress** | `happy` · `so_what_bait` · `entity_dense` · `translation_uncertain` |

**Mix (E4=B):** mostly **synthetic** (sum-01…18) + **2–4 shortened `derived_real`** (sum-19…22) sampled from wired RSS feeds in [`source-feeds.json`](../../apps/api/data/source-feeds.json). Product SoT remains NewsAPI admit + transient body — RSS is a **sampling aid only**, not the runtime target. Derived bodies are **shortened feed teasers** (title + description), not scraped full articles (copyright / SR-02 / SR-10).

---

## 4. Tuple map (E5)

| id | D1 | D2 | D3 | source |
|----|----|----|----|--------|
| sum-01 | en | wire_complete_4w | happy | synthetic |
| sum-02 | en | thin_incomplete_4w | happy | synthetic |
| sum-03 | en | quote_heavy | happy | synthetic |
| sum-04 | en | long_digressive | happy | synthetic |
| sum-05 | en | wire_complete_4w | so_what_bait | synthetic |
| sum-06 | en | thin_incomplete_4w | so_what_bait | synthetic |
| sum-07 | en | wire_complete_4w | entity_dense | synthetic |
| sum-08 | en | quote_heavy | entity_dense | synthetic |
| sum-09 | es | wire_complete_4w | happy | synthetic |
| sum-10 | es | thin_incomplete_4w | happy | synthetic |
| sum-11 | es | wire_complete_4w | translation_uncertain | synthetic |
| sum-12 | es | thin_incomplete_4w | translation_uncertain | synthetic |
| sum-13 | es | wire_complete_4w | so_what_bait | synthetic |
| sum-14 | mixed_within_body | wire_complete_4w | happy | synthetic |
| sum-15 | mixed_within_body | quote_heavy | translation_uncertain | synthetic |
| sum-16 | en | long_digressive | so_what_bait | synthetic |
| sum-17 | en | long_digressive | entity_dense | synthetic |
| sum-18 | es | quote_heavy | entity_dense | synthetic |
| sum-19 | en | wire_complete_4w | happy | derived_real |
| sum-20 | es | wire_complete_4w | happy | derived_real |
| sum-21 | en | thin_incomplete_4w | happy | derived_real |
| sum-22 | en | wire_complete_4w | entity_dense | derived_real |

---

## 5. Gold schema (E6)

`schemaVersion`: `summarization-gold-v1` · `promptVersion`: `summarization-v1`

Per example:

| Field | Rule |
|-------|------|
| `id` | `sum-NN` |
| `source` | `synthetic` \| `derived_real` |
| `language` / `shape` / `stress` | D1–D3 enums above |
| `title` / `body` | Model inputs (single URI grain) |
| `expected.article_summary` | Arbiter **reference** English prose (not exact-match gate) |
| `code_checks` | Subset of `non_empty` · `plain_string` · `denylist` · `soft_length` |
| `rubric_notes` | 4W present / omit traps / provenance for derived_real |
| Body length | Keep short for git; derived_real = shortened RSS teaser |

Optional provenance for derived_real lives in `rubric_notes` (`feed_id`, sample date, link) — not a separate schema field in v1.

---

## 6. `ds-coder` checklist (offline / harness later)

| Check | Aligns | Notes |
|-------|--------|-------|
| `non_empty` | V1 | Trim → non-empty |
| `plain_string` | V2 | Reject JSON envelope / markdown-only heading as whole payload |
| `denylist` | V3 | Pipeline §4.1 patterns (case-insensitive substring) |
| `soft_length` | F7 offline | Soft band ~2–4 sentences; advisory — not a runtime fail in B2. **Follow-up (carry-over):** add ≥1 long-body fixture and score F7 before treating density as proven on full NewsAPI bodies |
| Body-echo overlap | F3 offline | Heuristic only; threshold TBD at harness |

**Not code-gated in B2:** factual invention, ES→EN quality, unsupported 4W pad — human arbiter.

---

## 7. Arbiter pass

**Done (1 Nov 2026):** Felipe locked sum-01…22 in chat (sum-12 expected tightened for less hedging; sum-20 Semana not Infobae).

Re-open a case only if prompt/pipeline changes force gold drift. Still **advisory** until a promote gate.

---

## 8. Decision log (B2)

| Date | Lock | Choice |
|------|------|--------|
| 1 Nov 2026 | E1 | Code + human gold; advisory; no judge |
| 1 Nov 2026 | E2 | F1–F8 as tabled |
| 1 Nov 2026 | E3 | ~20–24 cases; D1–D3 |
| 1 Nov 2026 | E4 | Mostly synthetic + 2–4 shortened `derived_real` |
| 1 Nov 2026 | E5 | Tuples sum-01…22 |
| 1 Nov 2026 | E6 | Schema as tabled |
| 1 Nov 2026 | E7 | Write evals + fill gold; derived_real from wired RSS teasers |
| 1 Nov 2026 | Arbiter | sum-01…22 locked in chat |
| 2 Nov 2026 | Coherence pass | Related + runs pointer; skip/no-model paths do not emit `summarization_invoke` (PRD/D-088) |
| 2 Nov 2026 | Carry-over | Keep V3 denylist; no hard length runtime; F7/long-body soft_length remains advisory follow-up |

---

## 9. Next

1. Harness / `ds-coder` wiring at build (`engineer-ai` + `ds-coder`) — advisory until promote gate.  
2. Migrate [summarization-runs.dbml](../data/summarization-runs.dbml) to Supabase at build; instrument `summarization_invoke`.  
3. F7 / long-body: add ≥1 long-article fixture and score advisory `soft_length` (carry-over follow-up — not a runtime gate).
