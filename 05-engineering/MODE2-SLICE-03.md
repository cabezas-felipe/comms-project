# Mode 2 — Slice 3 (closed)

## 1) Slice objective

Move Dashboard reads to an HTTP-style endpoint with contract validation and bounded retry/backoff, while preserving current UI interactions.

## 2) Scope and exclusions

- In scope:
  - HTTP fetch path in `[04-prototype/src/lib/api.ts](../04-prototype/src/lib/api.ts)`
  - Static endpoint payload in `[04-prototype/public/api/dashboard.json](../04-prototype/public/api/dashboard.json)`
  - Adapter tests in `[04-prototype/src/lib/api.test.ts](../04-prototype/src/lib/api.test.ts)`
- Exclusions:
  - Backend service implementation
  - Auth/persistence/ingestion changes
  - Dashboard visual redesign

## 3) Design-system discovery and source-of-truth choice

- Source of truth remains project-local prototype system in `[04-prototype](../04-prototype)`.
- No token/component additions in this slice.

## 4) Design-system mapping

- Dashboard layout and interaction components unchanged.
- Only data loading internals changed.

## 5) Implementation summary

- Replaced in-memory-only adapter with HTTP fetch to `/api/dashboard.json`.
- Added runtime contract parsing using `dashboardPayloadSchema`.
- Added retry/backoff policy:
  - retries: `2`
  - wait schedule: `200ms`, then `400ms`
- Added local fallback payload when all retries fail.
- Added tests for:
  - successful HTTP payload validation
  - retry attempts + fallback behavior

## 6) State coverage (loading/empty/error/success)

- Loading/empty/error/success UX from Slice 2 remains intact.
- This slice changes source reliability, not visual states.

## 7) Accessibility and responsive results

- No markup/navigation changes; keyboard and responsive behavior unchanged from Slice 2.

## 8) Quality gate status

- `cd 05-engineering && npm run build:packages` — pass
- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass
- `cd 04-prototype && npx eslint src/lib/api.ts src/lib/api.test.ts src/pages/Dashboard.tsx` — pass

## 9) Risks and follow-up

- Static endpoint payload currently includes two stories for bounded scope.
- Next slice should add real API endpoint + response mapping parity with full story set.

## 10) Rebuild notes (2026-04-23 — D-020)

### Bugs fixed

- No runtime bug in `api.ts` required fixing in this pass.
- Test gap fixed: retry/backoff schedule was not explicitly asserted.
- Test gap fixed: missing `retries: 0` boundary coverage.

### Type-safety improvements

- No additional type-safety changes were required in this pass.

### Test coverage added (`api.test.ts`, 2 additions)

- Assert backoff duration arguments on retry path:
  - first sleep call = `200`
  - second sleep call = `400`
- Add zero-retry boundary test:
  - `retries: 0` => fetcher called once, sleep not called, fallback payload returned.

### Quality gate (post-rebuild)

- `cd 05-engineering && npm run test:prototype` — pass (9 tests total)
- `cd 04-prototype && npx eslint src/lib/api.ts src/lib/api.test.ts src/pages/Dashboard.tsx` — pass