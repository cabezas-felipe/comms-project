# Extraction foundations — build handoff

> **Status:** Foundations complete (Sessions A–E) · **Written:** 28 Sep 2026  
> **Do not implement from chat memory — use the linked SoTs.**

## What was locked

| Session | Artifact |
|---------|----------|
| A | [02-product/contracts/extraction.md](../../02-product/contracts/extraction.md) |
| B | [docs/prompts/extraction.md](../prompts/extraction.md) (`extraction-v1`) |
| C | [docs/pipelines/extraction.md](../pipelines/extraction.md) |
| D | [docs/data/extraction-runs.dbml](../data/extraction-runs.dbml) · [Extraction runs](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d) · [D-072](../../DECISIONS.md) · [D-073](../../DECISIONS.md) (SKU amend) |
| E | [docs/evals/extraction.md](../evals/extraction.md) · locked [extraction.gold.json](../evals/extraction.gold.json) (24 cases) |

Product data ERD (unchanged owner): [tempo.dbml](../data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37).

UX: [Onboarding happy path](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70H-0) · [O4a Extract fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0).

## Build owners (suggested)

`engineer-orchestrator` → `engineer-ai` (prompt/runner/evals) + `engineer-backend` (Supabase migrations for lanes + `extraction_runs`) + light `engineer-security` (blurbs → LLM).

## MUST checklist (build program)

1. Implement `extraction-v1` from [prompts/extraction.md](../prompts/extraction.md) (one multi-lane call; Opus 5.5 → Sonnet 5.5 per D-073).
2. Implement pipeline from [pipelines/extraction.md](../pipelines/extraction.md) (O4a fail-closed; Review before live; DBML chip merge).
3. Migrate product schema toward [tempo.dbml](../data/tempo.dbml); persist attempts per [extraction-runs.dbml](../data/extraction-runs.dbml).
4. **Promote** [docs/evals/extraction.gold.json](../evals/extraction.gold.json) → `apps/api/src/ai/evals/extraction.gold.json`; wire runner; **retire** legacy onboarding extraction gold/command as default.
5. Score the 24 locked cases in [docs/evals/extraction.gold.json](../evals/extraction.gold.json). Do not import the legacy inventory in [docs/evals/extraction.md](../evals/extraction.md) §5.
6. Keep extraction eval **advisory** until trusted. Chip acceptance is the PostHog event `extraction_chip_acceptance`, specified in the [extraction PRD](../../../02-product/prds/model--extraction--v1.md). It is not an eval. The LLM judge is later.
7. **SKU cutover (D-073):** after gold on Opus 5.5 → Sonnet 5.5 — (a) `DEFAULT_EXTRACTION_*` in [`model-router.mjs`](../../apps/api/src/ai/model-router.mjs), (b) Vercel `TEMPO_AI_CLASSIFIER_MODEL` / `TEMPO_AI_CLASSIFIER_FALLBACK_MODEL`, (c) retire Opus 4.7 / Sonnet 4.6 from staging handoffs + eval runner literals. Local `.env` may already match for experiments; `.env.example` keeps mock defaults + target comments.

## Explicitly out of this foundation

- Runner/code changes (except docs)
- LLM-as-judge
- PostHog instrumentation of `extraction_chip_acceptance` and `extraction_invoke` (both specified in the extraction PRD)
- Single-lane settings extract
- Metastory / what-changed / why eval stacks

## Runtime gap reminder

Prototype may still be single-narrative `extract-v8` until reconcile. Foundations describe the **target**.
