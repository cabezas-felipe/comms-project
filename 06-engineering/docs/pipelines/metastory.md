# Metastory — pipeline SoT

> **Stage:** Metastory · **Status:** Stub · **Last updated:** 28 Oct 2026  
> **Altitude:** Engineer pipeline for embed → cluster propose → boundary LLM → shared writer LLM. One pipeline owns both generative calls.

**Related**

- Product contract: [metastory.md](../../../02-product/contracts/metastory.md) (locked)
- Model PRD: [model--metastory--v1.md](../../../02-product/prds/model--metastory--v1.md)
- Prompts: [metastory-boundary.md](../prompts/metastory-boundary.md) · [metastory-writer.md](../prompts/metastory-writer.md)
- Evals: [metastory-boundary.md](../evals/metastory-boundary.md) · [metastory-writer.md](../evals/metastory-writer.md)
- Runs: [metastory-runs.dbml](../data/metastory-runs.dbml)
- Upstream: [ingestion.md](./ingestion.md) · [summarization.md](./summarization.md) · story-tagging (when landed)
- Pattern: sibling [extraction.md](./extraction.md)

---

## Stub

**Trigger:** Clock / warm after tagged shared stories are available for the tick.

**Steps (not locked for build):**

1. **Embed** eligible text per MR-04 → `story_embeddings` (embed SKU; skip when model+hash unchanged). Not an LLM chat call; not a `metastory_runs` row.
2. **Cluster propose** — vector similarity / thresholds among already-admitted stories (deterministic on embeddings).
3. **Boundary** (≤2 attempts) — generative LLM confirm / split / merge at event grain → `metastory_runs` (`call_kind=boundary`).
4. **Id / membership** — reuse or prepare mint; soft M:N per MR-05 (mint only after successful title write).
5. **Writer** (≤2 attempts) — title, subtitle, what happened, what changed → `metastory_runs` (`call_kind=writer`); persist shared copy rules per contract.
6. **Handoff** — join / feed membership → personalization.

**Out of scope here:** drains, compliance, story-chip apply, why/what-next, rising formulas.

Mermaid, idempotency keys, and embed-threshold math land in Phase B3.
