# Mode 2 — Slice 8 (closed): ingestion v0 + ranking endpoint

## 1) Slice objective

Implement a local ingestion and ranking path for Dashboard payload generation, replacing static dashboard JSON reads.

## 2) Scope and exclusions

- In scope:
  - local ingestion input dataset
  - API endpoint `GET /api/dashboard`
  - story clustering/ranking logic
  - frontend adapter endpoint update
  - dev proxy update
- Out of scope:
  - remote ingestion jobs
  - message queues/schedulers
  - AI summarization

## 3) Design-system discovery and source-of-truth choice

- Source of truth remains `04-prototype`.
- No component/token changes.

## 4) Design-system mapping

- Dashboard visuals and interactions unchanged.
- Data source only changed under the adapter boundary.

## 5) Implementation summary

- Added ingestion dataset:
  - `[apps/api/data/source-items.json](apps/api/data/source-items.json)`
- Updated API server:
  - `[apps/api/src/server.mjs](apps/api/src/server.mjs)`
  - Added `readSourceItems`, `buildDashboardPayload`, `rankStories`, and endpoint `GET /api/dashboard`
  - Uses settings scope filters (topics/geographies/sources) before clustering and ranking
- Updated frontend integration:
  - `[../04-prototype/src/lib/api.ts](../04-prototype/src/lib/api.ts)` now fetches `/api/dashboard`
  - `[../04-prototype/vite.config.ts](../04-prototype/vite.config.ts)` proxies `/api/dashboard` to local API

## 6) State coverage (loading/empty/error/success)

- Existing dashboard loading/error/fallback states retained.
- Adapter fallback to in-memory stories still protects failures.

## 7) Accessibility and responsive results

- No markup/interaction changes.

## 8) Quality gate status

- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass
- `cd 04-prototype && npx eslint src/lib/api.ts vite.config.ts` — pass
- `node --check 05-engineering/apps/api/src/server.mjs` — pass

## 9) Risks and follow-up

- Ranking heuristic is intentionally simple (weight + freshness).
- Next roadmap slice: AI summarization guardrailed path over ranked clusters.

## 10) Rebuild notes (2026-04-23 audit pass — D-025)

- All functional requirements were present and correct on entry: `source-items.json`, `buildDashboardPayload`, `rankStories`, `GET /api/dashboard`, `api.ts` endpoint, and Vite proxy all verified.
- Gap identified: no route-level test for `GET /api/dashboard`, violating the D-017 pattern.
- Fix: added one test in `apps/api/src/server.routes.test.mjs` — seeds a minimal `source-items.json` fixture to `tmpDir`, calls `GET /api/dashboard`, asserts HTTP 200, `contractVersion`, `stories.length === 1`, `dashboardPayloadSchema` conformance, and `aiSummaryMeta` stripping.
- API test count: 13 → 14 (3 model-router + 6 settings-schema + 5 route-level).
- All validation gates pass on exit.