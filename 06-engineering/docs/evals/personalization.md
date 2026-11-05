# Personalization — eval / gold SoT

> **Stage:** Personalization (why this matters · what comes next) · **Status:** Arbiter-locked (5 Nov 2026) · **Last updated:** 5 Nov 2026  
> **Altitude:** Code checks + human gold. **No LLM judge.** Advisory until promote gate. Suite **N=24** arbiter-locked (`p-01`…`24`).

**Related**

- Product contract: [personalization.md](../../../02-product/contracts/personalization.md) (PR-01…14)
- Model PRD: [model--personalization--v1.md](../../../02-product/prds/model--personalization--v1.md) (B4 design Locked · build deferred)
- Prompt: [personalization.md](../prompts/personalization.md) (**Locked** Pr1–Pr6)
- Pipeline: [personalization.md](../pipelines/personalization.md) (B4 design Locked · D-108 · PR-14)
- Practice notes: [practice-notes/](../../../02-product/practice-notes/README.md) · seed [practice-notes.seed.json](../data/practice-notes.seed.json) v2
- Gold: [personalization.gold.json](./personalization.gold.json) (24; arbiter-locked; advisory until promote)
- Pattern: sibling [metastory-writer.md](./metastory-writer.md)

**Domain arbiter:** Felipe (PM).

---

## 1. Posture (Ev1 A)

| Rule | Lock |
|------|------|
| Checks | **Code** (JSON / Mode keys / pp5 denylist shared with pipeline V3 / why-only shape) + **human arbiter** vs reference `expected` |
| LLM judge | **None** |
| Soft length / org-voice / retell / practice-note fit | Offline advisory + human |
| Expected strings | Arbiter-reference — **not** hard CI string equality |
| Suite | **Synthetic-first** (24 cases) |
| Flywheel | None yet (stage unshipped) |
| Advisory | Until promote gate |

---

## 2. Failure modes (Ev2 — one suite)

| ID | Failure mode | Check |
|----|--------------|-------|
| **PF-01** | Stakeholders named in **why** | Code / heuristics + human |
| **PF-02** | Function or practice-note framing in **why** | Code / heuristics + human |
| **PF-03** | pp5 prescribe on why or what-next | **Code** — share seed with pipeline [§4.1](../pipelines/personalization.md); prefer false negatives over broad tokens |
| **PF-04** | Retells what happened / what changed | Soft / human |
| **PF-05** | Ignores practice note / wrong case family | Soft / human |
| **PF-06** | Regenerates when cache unchanged | **Later** — pipeline harness at build (not gold copy) |
| **PF-07** | Why-only invents `what_comes_next` | **Code** (schema / Mode) |

Soft length bars (advisory): why **2–3 / ~350–450**; what-next **1–2 / ~250–350**.

---

## 3. Suite map (Ev3′ A / Ev4 A)

**24** cases (`p-01`…`24`): all synthetic; English outputs; modes **both-fields** (22) · **why-only** (2).

| Block | Ids | Intent |
|-------|-----|--------|
| Family happies | p-01…10 | One case per practice-note family |
| Cross-function | p-11…14 | **Same grounding**; vary function + note |
| Why-only | p-15…16 | Empty function; missing note (PF-07) |
| PF baits | p-17…24 | PF-01…05, PF-03×2, PF-04×2, PF-05×2 |

| Id | Function | Family | Stress | Mode | PF |
|----|----------|--------|--------|------|-----|
| p-01 | communications | framing_drift | happy_family | both | — |
| p-02 | communications | inbound_statement | happy_family | both | — |
| p-03 | communications | correction | happy_family | both | — |
| p-04 | communications | misinfo | happy_family | both | — |
| p-05 | policy | external_signal | happy_family | both | — |
| p-06 | policy | principal_brief | happy_family | both | — |
| p-07 | operations | continuity_risk | happy_family | both | — |
| p-08 | operations | escalation_threshold | happy_family | both | — |
| p-09 | partnerships | partner_impact | happy_family | both | — |
| p-10 | partnerships | counterpart_shift | happy_family | both | — |
| p-11 | communications | — | cross_function | both | — |
| p-12 | policy | — | cross_function | both | — |
| p-13 | operations | — | cross_function | both | — |
| p-14 | partnerships | — | cross_function | both | — |
| p-15 | null | — | why_only_empty_function | why-only | PF-07 |
| p-16 | policy | — | why_only_missing_note | why-only | PF-07 |
| p-17 | communications | inbound_statement | prescribe_bait | both | PF-03 |
| p-18 | communications | framing_drift | stakeholder_in_why_bait | both | PF-01 |
| p-19 | policy | external_signal | function_lens_in_why_bait | both | PF-02 |
| p-20 | operations | continuity_risk | retell_bait | both | PF-04 |
| p-21 | communications | misinfo | wrong_family_bait | both | PF-05 |
| p-22 | partnerships | partner_impact | prescribe_what_next_bait | both | PF-03 |
| p-23 | policy | principal_brief | retell_why_bait | both | PF-04 |
| p-24 | operations | escalation_threshold | note_obedience_happy | both | PF-05 |

**Gold schema (Ev4 A):** see examples in [personalization.gold.json](./personalization.gold.json) — `input` carries the same content as the prompt user wire (gold nests practice note as `practice_note.body`; prompt labels it `Practice note: … text:`); bodies from [practice-notes.seed.json](../data/practice-notes.seed.json) **v2** (why-only: `practice_note` null); `expected` arbiter-reference; `arbiter.status` **locked** on all 24.

---

## 4. Code checks (harness)

| Check | Meaning |
|-------|---------|
| `valid_json` | Parse object |
| `mode_keys_both` | `why_this_matters` + `what_comes_next` non-empty |
| `mode_keys_why_only` | `why_this_matters` only; no inventing next |
| `no_what_comes_next` | Key absent or null on why-only |
| `denylist_pp5` | Shared with pipeline V3 prescribe seed |
| `english_only` | EN output (arbiter owns name accents) |
| `soft_length_advisory` | Record vs soft bars — does not fail CI in B4 |
| `stakeholder_not_in_why` | Heuristic for PF-01 (expand in harness) |
| `no_function_lens_in_why` | Heuristic for PF-02 (expand in harness) |

---

## 5. Arbiter pass

**Status:** **Locked** 5 Nov 2026 (Felipe) — all `p-01`…`24`.

Cross-function / why-only / farm-bill PF baits share one why string when why-inputs match. Soft length advisory. No em dashes in `expected` or practice-note bodies (seed v2).

---

## 6. Decision log

| Date | Lock | Choice |
|------|------|--------|
| 5 Nov 2026 | Ev1 | Code + human; no LLM judge; synthetic-first **A** |
| 5 Nov 2026 | Ev2 | One suite PF-01…05 + PF-07; PF-06 pipeline later |
| 5 Nov 2026 | Ev3′ | ~22–24 → **24** cases; family + cross-function + why-only + baits **A** |
| 5 Nov 2026 | Ev4 | Gold schema A; expected arbiter-reference |
| 5 Nov 2026 | Encode | Gold drafted |
| 5 Nov 2026 | Arbiter | All 24 locked (Felipe); shared why for same why-inputs; house style no em dashes |

**Next (build):** Implement code checks (`ds-coder` / harness). Seed v2 import + migrate. Advisory until promote.
