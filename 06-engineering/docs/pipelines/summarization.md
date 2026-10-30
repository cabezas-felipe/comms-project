# Summarization — pipeline SoT

> **Stage:** Summarization · **Status:** Stub · **Last updated:** 28 Oct 2026  
> **Altitude:** Engineer pipeline for the factual article-summary LLM. Invoked from ingestion; not a substitute for the ingestion rules pipeline.

**Related**

- Product PRD: [model--summarization--v1.md](../../../02-product/prds/model--summarization--v1.md)
- Product contract: [summarization.md](../../../02-product/contracts/summarization.md) (locked)
- Prompt: [summarization.md](../prompts/summarization.md) (TBD)
- Evals: [summarization.md](../evals/summarization.md)
- Ingestion orchestrator (TBD): [ingestion.md](./ingestion.md)
- Pattern: sibling [extraction.md](./extraction.md)

---

## Stub

**Trigger:** New press article URI during shared-pool ingest (hourly clock or warm), when a vendor body is present in memory.

**Out of scope here:** NewsAPI/X drains, compliance, chip tagging, metastory writer (those are ingestion / metastory pipelines).

**Planned steps (not locked for build):** validate URI new → call summarization prompt with body in memory → validate factual article summary → persist summary + run row (source-reader snippet when present) → discard body (never persist truncated body as excerpt) → hand off to tagging / pool.

Mermaid and idempotency keys land when the contract locks.
