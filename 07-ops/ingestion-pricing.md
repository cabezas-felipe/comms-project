# Ingestion pricing (ops SoT)

Canonical **unit rates** for Tempo ingestion vendor spend digests (NewsAPI.ai + X). Parallel to [model-pricing.md](./model-pricing.md) (LLM token rates).

| Artifact | Role |
| --- | --- |
| [`ingestion-pricing.json`](./ingestion-pricing.json) | **SoT** — billable SKUs + `review_urls` |
| PostHog `ingestion_job_completed` | Usage **facts** (counts) — see [pipelines/ingestion.md](../06-engineering/docs/pipelines/ingestion.md) §9 |
| No API runtime copy (v1) | Unlike model-pricing; digests read this file from the repo in Actions |

## Rules

- Daily digest: **facts × stamped rates** → estimated `$`. Do **not** rewrite past digests when rates change; stamp `price_as_of`.
- Do **not** fetch provider pricing pages on clock / warm / IR-14.
- **No MVP $-caps** on vendor calls (track only).
- SKU keys / rates: fill and verify at **build**; empty `skus` is an honest stub.
- Rate-card refresh intent: weekly **auto doc-fetch → diff → Slack → human merge** (same as models). Parsers land at build; until then Monday posts a **heartbeat** (`in_sync` or explicit stub status) with stamped catalog + review links.
- X `usage` / `credits` APIs = **later actuals reconcile**, not this rate-card SoT.

## Cadence (Slack `tempo-comms.slack.com`)

| When | What | Channel | Secret |
| --- | --- | --- | --- |
| **Daily 14:00 UTC** | Spend digest ($/day lead) | `#ops-pricing-ingestion` | `TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION` |
| **Monday 14:00 UTC** | Unit-price catalog heartbeat / diff | `#ops-pricing-ingestion` | same |

Workflows: [daily-ops-spend.yml](../.github/workflows/daily-ops-spend.yml) · [weekly-pricing-catalog-review.yml](../.github/workflows/weekly-pricing-catalog-review.yml) (replaces model-only review name).

## Related

- Pipeline: [`../06-engineering/docs/pipelines/ingestion.md`](../06-engineering/docs/pipelines/ingestion.md)
- Vendors: [`../06-engineering/docs/api-newsapi-ai.md`](../06-engineering/docs/api-newsapi-ai.md) · [`../06-engineering/docs/api-x.md`](../06-engineering/docs/api-x.md)
- Models sibling: [model-pricing.md](./model-pricing.md)
