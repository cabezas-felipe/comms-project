# 07-ops

Operational SoTs that are neither product requirements nor application code.

| Doc | Purpose |
| --- | --- |
| [model-pricing.md](./model-pricing.md) · [model-pricing.json](./model-pricing.json) | LLM / embedding token rates for `estimated_cost_usd` / live `costUsd` |
| [ingestion-pricing.md](./ingestion-pricing.md) · [ingestion-pricing.json](./ingestion-pricing.json) | NewsAPI.ai + X unit rates for ingestion spend digests |

## Slack (`tempo-comms.slack.com`)

| Channel | Purpose | Secret |
| --- | --- | --- |
| **`#ops-pricing-models`** | Weekly model unit catalog + **daily** model spend | `TEMPO_OPS_SLACK_WEBHOOK_URL` |
| **`#ops-pricing-ingestion`** | Weekly ingestion unit catalog + **daily** ingestion spend | `TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION` |
| **`#model-extraction-organization`** / **`-function`** / **`-role`** / **`-geography`** / **`-source`** | Extraction resolve queues | `TEMPO_OPS_SLACK_WEBHOOK_URL_EXTRACTION_{ORG,FUNCTION,ROLE,GEOGRAPHY,SOURCE}` |

`#model-extraction-source` is a new press alias or a new X handle. See [model--extraction--v1.md](../02-product/prds/model--extraction--v1.md).

## Cadence (14:00 UTC)

| Workflow | Schedule | Posts |
| --- | --- | --- |
| [daily-ops-spend.yml](../.github/workflows/daily-ops-spend.yml) | Daily `0 14 * * *` | Ingestion + model **spend** digests (shell until build wires data) |
| [weekly-pricing-catalog-review.yml](../.github/workflows/weekly-pricing-catalog-review.yml) | Monday `0 14 * * 1` | Both **unit catalogs** (`in_sync` heartbeat; doc-diff parsers at build) |

Legacy alias: [model-pricing-review.yml](../.github/workflows/model-pricing-review.yml) (`workflow_dispatch` only).

## Scripts

| Script | Role |
| --- | --- |
| [scripts/sync-model-pricing.mjs](./scripts/sync-model-pricing.mjs) | Sync / check model SoT ↔ API runtime copy (`06-engineering/apps/api/...`) |
| [scripts/post-pricing-catalog-review.mjs](./scripts/post-pricing-catalog-review.mjs) | Weekly catalog post (`CATALOG=model\|ingestion`) |
| [scripts/post-ingestion-spend-digest.mjs](./scripts/post-ingestion-spend-digest.mjs) | Daily ingestion $/day shell |
| [scripts/post-model-spend-digest.mjs](./scripts/post-model-spend-digest.mjs) | Daily model $/day shell |
