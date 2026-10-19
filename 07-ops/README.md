# 07-ops

Operational SoTs that are neither product requirements nor application code.

| Doc | Purpose |
| --- | --- |
| [model-pricing.md](./model-pricing.md) · [model-pricing.json](./model-pricing.json) | LLM / embedding token rates for cost estimates |

Slack: **`#ops-pricing-models`** (`tempo-comms.slack.com`) for pricing reviews (source digest may keep its own webhook until consolidated).

Runtime copy for live API: `05-engineering/apps/api/src/ai/pricing/model-prices.json` — sync with `node 07-ops/scripts/sync-model-pricing.mjs`.
