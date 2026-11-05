# Metastory boundary — eval / gold SoT

> **Stage:** Metastory · **Call:** Boundary · **Status:** Arbiter-locked (G1=A′ / D-104) · **Last updated:** 3 Nov 2026  
> **Altitude:** Code checks + human gold. **No LLM judge.** Advisory until promote gate. Empty `examples` is **not** a pass — suite now has 18 cases.

**Related**

- Product contract: [metastory.md](../../../02-product/contracts/metastory.md) (locked)
- Model PRD: [model--metastory--v1.md](../../../02-product/prds/model--metastory--v1.md)
- Prompt: [metastory-boundary.md](../prompts/metastory-boundary.md) (Locked D-101)
- Pipeline: [metastory.md](../pipelines/metastory.md)
- Sibling eval: [metastory-writer.md](./metastory-writer.md)
- Gold: [metastory-boundary.gold.json](./metastory-boundary.gold.json)
- Index: [metastory.md](./metastory.md)
- Eng: [D-104](../../DECISIONS.md)

**Domain arbiter:** Felipe (PM).

---

## 1. Posture

| Rule | Lock |
|------|------|
| Checks | **Code** (JSON/schema/ids) + **human arbiter** vs `expected` |
| LLM judge | **None** |
| Advisory | Until promote gate; do not ship as blocking CI without arbiter lock |

---

## 2. P0 failure modes

| ID | Failure mode |
|----|----------------|
| **B-F1** | Chip-forced merge |
| **B-F2** | Unrelated same-geography events merged |
| **B-F3** | Continuous event / cycle atomized — continuity SoT (D-096) |
| **B-F4** | Id churn on +n/−n membership when event continues |
| **B-F5** | False merge under ambiguity (prefer defer/fragment) |
| **B-F6** | Ignore sound propose — or invent merges when should fail closed |

**P1:** healer override; non-English / mixed members; `merge_candidates` path.

---

## 3. Suite map (G1=A′ / D-104)

**18** cases (arbiter-locked): mostly synthetic + **3 derived_real** (mb-16…18); languages **en / es / mixed**.

| Id | Lang | Stress | Mode | Source |
|----|------|--------|------|--------|
| mb-01 | en | happy confirm | B-F6 | synthetic |
| mb-02 | es | happy confirm | B-F6 | synthetic |
| mb-03 | en | chip_force | B-F1 | synthetic |
| mb-04 | en | same_geo_unrelated | B-F2 | synthetic |
| mb-05 | es | same_geo_unrelated | B-F2 | synthetic |
| mb-06 | en | continuity | B-F3 | synthetic |
| mb-07 | es | continuity | B-F3 | synthetic |
| mb-08 | en | membership_delta | B-F4 | synthetic |
| mb-09 | en | ambiguous_defer | B-F5 | synthetic |
| mb-10 | es | ambiguous_defer | B-F5 | synthetic |
| mb-11 | en | invent_merge | B-F5/F6 | synthetic |
| mb-12 | en | healer_override | P1 | synthetic |
| mb-13 | mixed | bilingual_members | P1 | synthetic |
| mb-14 | en | merge_path | B-F6 | synthetic |
| mb-15 | en | press+x happy | B-F6 | synthetic |
| mb-16 | en | happy | B-F6 | derived_real |
| mb-17 | es | happy | B-F6 | derived_real |
| mb-18 | en | same_geo_unrelated | B-F2 | derived_real |

`derived_real`: RSS teaser anchors (same posture as summarization) + synthetic companions — **not** scraped full articles; **not** runtime NewsAPI SoT.

---

## 4. Code checks (harness)

| Check | Meaning |
|-------|---------|
| `valid_json` | Parse object with required keys |
| `decision_enum` | `confirm` \| `split` \| `merge` \| `defer` |
| `ids_subset` | All `member_story_ids` ∈ input members |
| `confirm_one_cluster` / `merge_one_cluster` | Exactly one cluster when expected |
| `split_ge_2` | ≥2 clusters when expected split |
| `defer_or_split_no_merge` | decision ∈ {defer, split}; not a single merged cluster of unrelated ids |

Optional model `reason` is ops-only — **not** a code check / not in `expected`.

Human arbiter owns event-grain judgment quality beyond code.

---

## 5. Threshold / healer calibration

See [index](./metastory.md) and pipeline D-096. Continuity misses → prompt+gold (**B-F3**) before reintroducing election-bundle Jaccard.

**Evidence cap (D-097):** tune cap/weights if gold shows missing outlets or mushy redundancy.

---

## 6. Arbiter pass

**Locked:** Felipe · 3 Nov 2026 · mb-01…18 (see per-case `arbiter` in gold).

**Arbiter protocol (locked with suite):**
- `split` = confident unrelated / wrong propose (`proposed_cluster` already co-grouped).
- `defer` = unsure same-event, or refuse `merge_candidates` union (no invented merge).
- Continuity (B-F3): long cycles may split when evidence justifies; do not unjustifiably atomize when members clearly continue the same event.

**Next:** Boundary **N=18 stays** (arbiter-locked). Writer gold Locked (D-105). Must coherence Closed. B4 personalization design Locked (build deferred).
