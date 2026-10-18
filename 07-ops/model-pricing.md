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

## Weekly review

GitHub Action [`.github/workflows/model-pricing-review.yml`](../.github/workflows/model-pricing-review.yml) posts to Slack (`TEMPO_OPS_SLACK_WEBHOOK_URL`) every Monday with the stamped catalog and provider review links. Channel: **`#ops-pricing-models`** (`tempo-comms.slack.com`) — Incoming Webhook → repo secret.

## Related

- Extraction runs: [`../06-engineering/docs/data/extraction-runs.dbml`](../06-engineering/docs/data/extraction-runs.dbml)
- Model PRD: [`../02-product/prds/model--extraction--v1.md`](../02-product/prds/model--extraction--v1.md)
