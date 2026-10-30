# Metastory boundary — prompt SoT

> **Stage:** Metastory · **Call:** Boundary · **Status:** Stub · **Last updated:** 28 Oct 2026  
> **Altitude:** Prompt text for the event-grain confirm / split / merge LLM. Not the shared-copy writer.

**Related**

- Product contract: [metastory.md](../../../02-product/contracts/metastory.md) (locked) — MR-01, MR-02, MR-05
- Sibling prompt: [metastory-writer.md](./metastory-writer.md)
- Pipeline: [metastory.md](../pipelines/metastory.md)
- Evals: [metastory-boundary.md](../evals/metastory-boundary.md)
- Runs: [metastory-runs.dbml](../data/metastory-runs.dbml) (`call_kind=boundary`)
- Model PRD: [model--metastory--v1.md](../../../02-product/prds/model--metastory--v1.md)

---

## Stub

**Version id (planned):** `metastory-boundary-v1` (lock with first prompt draft in B3).

**Job:** Given embedding-proposed clusters / candidates, confirm, split, or merge at **real-world event** grain. Chips do **not** force merge.

**Not this prompt:** Shared title / what happened / what changed → [metastory-writer.md](./metastory-writer.md). Embed SKU / similarity thresholds → pipeline + product data, not this file.

**SKU:** Deferred to Phase B3 (`PM input required`).

Prompt body lands in B3 after contract I/O stays stable in use (or waived).
