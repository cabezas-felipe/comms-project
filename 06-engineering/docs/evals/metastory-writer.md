# Metastory writer — eval / gold SoT

> **Stage:** Metastory · **Call:** Writer · **Status:** Arbiter-locked (G2=A′+ / D-105 · d05 thicken 5 Nov 2026) · **Last updated:** 5 Nov 2026  
> **Altitude:** Code checks + human gold. **No LLM judge.** Advisory until promote gate. Empty `examples` is **not** a pass — suite has 23 cases. Soft length = advisory (d05).

**Related**

- Product contract: [metastory.md](../../../02-product/contracts/metastory.md) (locked)
- Model PRD: [model--metastory--v1.md](../../../02-product/prds/model--metastory--v1.md)
- Prompt: [metastory-writer.md](../prompts/metastory-writer.md) (Locked D-103)
- Pipeline: [metastory.md](../pipelines/metastory.md)
- Sibling eval: [metastory-boundary.md](./metastory-boundary.md) (arbiter-locked; **N=18 stays** — see D-105)
- Gold: [metastory-writer.gold.json](./metastory-writer.gold.json)
- Index: [metastory.md](./metastory.md)
- Eng: [D-102](../../DECISIONS.md) · [D-103](../../DECISIONS.md) · [D-105](../../DECISIONS.md)

**Domain arbiter:** Felipe (PM).

---

## 1. Posture

| Rule | Lock |
|------|------|
| Checks | **Code** (JSON / requiredness / null rules / denylists) + **human arbiter** vs reference `expected` |
| LLM judge | **None** |
| Expected strings | Arbiter-reference (summarization posture) — **not** hard CI string equality |
| Soft length | **Advisory** — record vs d05 bars; **no** new W-Fx; does **not** fail CI |
| Advisory | Until promote gate |

**Runtime grounding:** No `factual_claims` schema (P10 = D). Grounding = W-F1 vs member evidence.

---

## 2. P0 failure modes

| ID | Failure mode |
|----|----------------|
| **W-F1** | Ungrounded / invented facts (world knowledge, wrong member, fabricated delta) |
| **W-F2** | Missing title, subtitle, or what_happened / blank mint ([D-102](../../DECISIONS.md)) |
| **W-F3** | `what_changed` user-relative / ever-seen instead of prior vs current **shared run** |
| **W-F4** | Spurious / invented drama in `what_changed` when evidence only supports a thin material move (pipeline does **not** invoke writer on `gate=none` — gold uses thin **update** cases) |
| **W-F5** | Body leakage — inventing publisher body beyond Members, or dumping long `same_tick_body` verbatim into shared fields (Members may include same-tick body per MR-08 / D-107) |
| **W-F6** | So-what / why / what-next / prescribe voice in shared fields |
| **W-F7** | Non-English shared copy when sources are ES/other (MR-07) |
| **W-F8** | Unnecessary title rename when prior title still fits (prefer-prior bias) |

---

## 3. Suite map (G2=A′+ / D-105)

**23** cases (`mw-01`…`23`): 20 synthetic + 3 derived_real; member languages **en / es / mixed** → **English** outputs; modes **first_mint** (15) · **update** (8).

| Id | Lang | Mode | Stress | Mode ID |
|----|------|------|--------|---------|
| mw-01 | en | first_mint | happy | W-F2 |
| mw-02 | es | first_mint | es→en | W-F7 |
| mw-03 | en | update | happy_update | W-F3 |
| mw-04 | en | first_mint | invent_facts | W-F1 |
| mw-05 | en | first_mint | so_what_bait | W-F6 |
| mw-06 | en | update | user_relative_bait | W-F3 |
| mw-07 | en | update | thin_material_delta | W-F4 |
| mw-08 | en | update | title_prefer | W-F8 |
| mw-09 | en | update | title_rename | W-F8 |
| mw-10 | mixed | first_mint | bilingual | W-F7 |
| mw-11 | en | first_mint | press+X | W-F2 |
| mw-12 | es | first_mint | continuity | W-F7 |
| mw-13 | en | update | continuity_update | W-F1 |
| mw-14 | en | first_mint | body_leakage | W-F5 |
| mw-15 | en | first_mint | thin_evidence | W-F1 |
| mw-16 | en | update | membership_+n | W-F4 |
| mw-17 | en | first_mint | prescribe_bait | W-F6 |
| mw-18 | mixed | update | mixed_update | W-F7 |
| mw-19 | en | first_mint | derived_real | W-F1 |
| mw-20 | es | first_mint | derived_real | W-F7 |
| mw-21 | en | first_mint | derived_real | W-F1 |
| mw-22 | en | first_mint | requiredness (X-only) | W-F2 |
| mw-23 | en | first_mint | invent_outlet | W-F1 |

---

## 4. Code checks (harness)

| Check | Meaning |
|-------|---------|
| `valid_json` | Parse object with required keys |
| `required_fields_nonempty` | title, subtitle, what_happened non-empty |
| `what_changed_null_first_mint` | `what_changed` is JSON null when mode first_mint |
| `what_changed_nonempty_update` | `what_changed` non-empty string when mode update |
| `english_only` | Shared fields ASCII/Latin English (arbiter owns edge accents in names) |
| `denylist_so_what` | Ban prescribe / “this matters” / what-next voice |
| `denylist_user_relative` | Ban “since you last”, “new to you”, ever-seen framing |
| `grounding_no_invent` | Human/code spot-check vs Members (P0) |
| `title_prefer_ok` | Update cases where prior title should stick |
| `no_body_dump` | No long publisher-body paste |
| `soft_length_advisory` | Record char/sentence vs d05 bars (`what_happened` ~250–350; `what_changed` ~200–300 on update) — **log only**, never fail |

### Soft length (d05)

| Field | Soft sentences | Soft chars |
|-------|----------------|------------|
| `what_happened` | 1–2 | ~250–350 |
| `what_changed` (update) | 1–2 | ~200–300 |

**Carve-outs (may sit under band on purpose):** thin evidence / invent-stress expecteds that must not pad (`mw-04`, `mw-15`, `mw-22`); thin material delta on `what_changed` (`mw-07`); anti-body-dump (`mw-14`). Prefer evidence density; never invent to hit length. Why-primary: personalization why stays the longer open-card band.

---

## 5. Arbiter pass

**Locked:** Felipe · 3 Nov 2026 · mw-01…23. **d05 re-arbiter:** 5 Nov 2026 — evidence-earned thicken + carve-outs (see per-case `arbiter` in gold).

**Arbiter protocol:** Each case reviewed with Mode + prior (if update) + full member evidence (title / article_summary_or_text / outlet / published_at) vs expected — required for W-F1 grounding.

**Next:** Soft length stays advisory until promote. B5 share-pack chrome.
