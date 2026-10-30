# Summarization — eval / gold SoT

> **Stage:** Summarization (factual press article summary at ingest) · **Status:** Stub · **Last updated:** 28 Oct 2026  
> **Altitude:** Eval craft not started. Gold file is a path stub only (`examples: []`).

**Related**

- Product PRD: [model--summarization--v1.md](../../../02-product/prds/model--summarization--v1.md)
- Product contract: [summarization.md](../../../02-product/contracts/summarization.md) (locked)
- Prompt: [summarization.md](../prompts/summarization.md) (TBD)
- Pipeline: [summarization.md](../pipelines/summarization.md) (TBD)
- Gold stub: [summarization.gold.json](./summarization.gold.json)
- Pattern: `06-engineering/docs/evals/{stage}.md` · sibling [extraction.md](./extraction.md)

---

## Stub

**Domain arbiter:** Felipe (PM).

**Failure modes to pursue (later):** so-what / why-this-matters voice; invents facts not in source; stores or echoes full body (or truncated body as “excerpt”); article summary presented **as** the article (missing Tempo-summary disclosure / Open original); invents summary when body absent; invents source-reader snippet when article summary is NULL.

**Next:** Lock product contract → craft criteria → fill gold (synthetic bodies OK if labeled) → harness. Advisory until trusted. Empty `examples` is **not** a pass.
