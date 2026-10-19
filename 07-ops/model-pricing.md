# Model pricing (ops SoT)

Canonical rates for Tempo `estimated_cost_usd` / live `costUsd` and cost reviews.

| Artifact | Role |
| --- | --- |
| [`model-pricing.json`](./model-pricing.json) | **SoT** — rates by bare `model_id` (no `anthropic:` prefix) |
| [`../05-engineering/apps/api/src/ai/pricing/model-prices.json`](../05-engineering/apps/api/src/ai/pricing/model-prices.json) | **Runtime copy** for the API deploy root (must match SoT) |

## Rules

- Compute cost at **call / run write** time: tokens × rates in the then-current table. Do not rewrite historical rows when rates change.
- Do **not** fetch provider pricing pages on each LLM call.
- After editing the SoT JSON, sync the runtime copy:

```bash
node 07-ops/scripts/sync-model-pricing.mjs
# or from 05-engineering:
npm run sync:model-pricing
```

- Price changes: update JSON → sync → short note in [`../05-engineering/DECISIONS.md`](../05-engineering/DECISIONS.md) → PR.
- When engineering folders renumber (`05` → `06`), update the sync script `destDir` once.

## Weekly review

GitHub Action [`.github/workflows/model-pricing-review.yml`](../.github/workflows/model-pricing-review.yml) posts to Slack (`TEMPO_OPS_SLACK_WEBHOOK_URL`) every Monday with the stamped catalog and provider review links. Channel: **`#ops-pricing-models`** (`tempo-comms.slack.com`) — Incoming Webhook → repo secret.
