# Model pricing (ops SoT)

Canonical rates for Tempo `estimated_cost_usd` and cost reviews.

| Artifact | Role |
| --- | --- |
| [`model-pricing.json`](./model-pricing.json) | **SoT** — rates by bare `model_id` (no `anthropic:` prefix) |
| [`../06-engineering/apps/api/src/ai/pricing/model-prices.json`](../06-engineering/apps/api/src/ai/pricing/model-prices.json) | **Runtime copy** for the API deploy root (must match SoT) |

## Rules

- Compute cost at **run write** time: tokens × rates in the then-current table. Do not rewrite historical rows when rates change.
- Do **not** fetch provider pricing pages on each LLM call.
- After editing the SoT JSON, sync the runtime copy:

```bash
node 07-ops/scripts/sync-model-pricing.mjs
```

- Price changes: update JSON → sync → short note in [`../06-engineering/DECISIONS.md`](../06-engineering/DECISIONS.md) → PR.
- Weekly **intent:** auto doc-fetch → **diff** vs SoT → Slack (`in_sync` or `drift` / `fetch_fail`) → **human merge**. No silent auto-commit of rates. Parsers land at build; until then Monday posts a stamped-catalog **heartbeat**.

## Cadence (Slack `#ops-pricing-models`)

| When | What | Workflow / secret |
| --- | --- | --- |
| **Daily 14:00 UTC** | Spend digest ($/day from `*_runs.estimated_cost_usd`) | [daily-ops-spend.yml](../.github/workflows/daily-ops-spend.yml) · `TEMPO_OPS_SLACK_WEBHOOK_URL` |
| **Monday 14:00 UTC** | Unit-price catalog heartbeat / diff | [weekly-pricing-catalog-review.yml](../.github/workflows/weekly-pricing-catalog-review.yml) · same secret |

Sibling ingestion rates: [ingestion-pricing.md](./ingestion-pricing.md).

## Related

- Extraction runs: [`../06-engineering/docs/data/extraction-runs.dbml`](../06-engineering/docs/data/extraction-runs.dbml)
- Model PRD: [`../02-product/prds/model--extraction--v1.md`](../02-product/prds/model--extraction--v1.md)
- Ops index: [README.md](./README.md)
