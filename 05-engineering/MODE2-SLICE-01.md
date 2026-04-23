# Mode 2 — Slice 1 (closed)

## Slice objective

Introduce a minimal production-oriented workspace: shared **contracts** (Zod + `CONTRACT_VERSION`) and **analytics** (tiered events + validated emit), without changing core dashboard behavior.

## Scope and boundaries

- In: npm workspaces under `[05-engineering/](README.md)`, `[packages/contracts](packages/contracts)`, `[packages/analytics](packages/analytics)`, placeholder `[apps/web](apps/web)`, prototype wiring for dashboard analytics only.
- Out: backend, auth, DB, ingestion, replacing mock `STORIES` data, CI hardening, full-repo lint green.

## Definition of done

- Dashboard flow preserved: load dashboard → expand story → open source (still mock content).
- `<= 5` meaningful edits under `04-prototype` (`package.json`, `Dashboard.tsx`, new `src/lib/analytics.ts`).
- Package unit tests for contracts + analytics schemas.
- `npm run build:packages` + prototype `vite build` succeed (commands run from `[05-engineering/](README.md)` per [D-004](DECISIONS.md)).
- ESLint clean on touched prototype files.
- Decision `D-003` in `[DECISIONS.md](DECISIONS.md)`; layout follow-up `D-004`.

## Implementation summary

- `@tempo/contracts`: story/source/trend Zod models, `dashboardPayloadSchema`, `settingsPayloadSchema`, `CONTRACT_VERSION`.
- `@tempo/analytics`: `dashboard_viewed` (primary), `story_expanded` / `source_opened` (secondary), `source_open_error` (guardrail), `emitAnalyticsEvent` + dev-only default sink.
- Prototype: `trackDashboardViewed` on dashboard mount; `trackStoryExpanded` when a card expands; `trackSourceOpened` when a key source is chosen.

## Validation

- `cd 05-engineering && npm run build:packages` — pass  
- `cd 05-engineering && npm run test:packages` — pass  
- `cd 05-engineering && npm run build` (packages + prototype build) — pass  
- `cd 04-prototype && npx eslint src/pages/Dashboard.tsx src/lib/analytics.ts` — pass  
- Note: `eslint .` for the whole prototype still fails on pre-existing files (see `D-003`).

## Rollback

- Remove workspace deps from `04-prototype/package.json`, delete `[05-engineering/packages](packages)` and `[05-engineering/apps](apps)`, remove `[05-engineering/package.json](package.json)`, and revert `Dashboard.tsx` / delete `src/lib/analytics.ts`.

## Rebuild audit notes (2026-04-22, branch audit/claude-rebuild-s1-s10)

Audit decision: [D-015](DECISIONS.md).

### What was good

- Zod schema definitions (`@tempo/contracts`): clean, versioned, fully typed exports. No issues.
- Analytics tier model (primary / secondary / guardrail) and builder pattern: correct and idiomatic.
- Pluggable `setAnalyticsSink` with dev-only default sink: right design for a testable, replaceable analytics boundary.
- `Dashboard.tsx`: analytics wiring, fetch-effect cancellation pattern, and toast/error-track on load failure are all correct.
- Build, test, and lint were all passing before the audit.

### What was improved

| Issue | Fix | File |
|---|---|---|
| `emitAnalyticsEvent(raw: unknown)` re-parsed already-validated events | Changed signature to `(event: AnalyticsEvent)`; removed internal `analyticsEventSchema.parse()` | `packages/analytics/src/sink.ts` |
| `buildStoryExpanded`, `buildSourceOpened`, `setAnalyticsSink` untested | Added 6 new tests (rejections + sink routing + null restore) | `packages/analytics/src/events.test.ts` |
| No negative test in contracts suite | Added rejection test for missing required fields | `packages/contracts/src/schemas.test.ts` |
| `lint:prototype:slice` script exited 2 (wrong CWD) | Replaced `npm --prefix exec` with `sh -c 'cd ../04-prototype && npx eslint …'` | `05-engineering/package.json` |

### Validation after rebuild

- `npm run build` — pass (packages + prototype vite build)
- `npm run test:packages` — pass (9 analytics, 4 contracts)
- `npm run test:prototype` — pass (5 tests)
- `npm run lint:prototype:slice` — pass (exit 0, no errors)

### Remaining risks

- `outletCount` allows `0` but `sources` requires `min(1)` — a story could have `outletCount: 0` while exposing a sources array. The UI displays `outletCount` as the "of N outlets" label; if the API sends 0 the label will read "of 0 outlets" even when sources exist. Not fixed here (cross-field validation is out of Slice 1 scope); flag for when ingestion is real.
- `settingsPayloadSchema` validates `topics` and `geographies` as free strings rather than the enum values in `topicSchema` / `geographySchema`. Intentional for now (extensibility), but could allow invalid enum values to round-trip silently.
- No `occurredAt` format validation beyond `min(1)` — a non-ISO string would pass schema. Low risk while emit is generated internally; revisit if events come from external sources.

## Rebuild pass 2 (2026-04-22, branch audit/claude-rebuild-s1-s10)

Audit decision: [D-018](DECISIONS.md).

### What was good

- All D-015 improvements held: typed emit signature, 9 analytics tests, 4 contracts tests, lint script functional.
- Build, test, and lint all passed before this pass.

### What was improved

| Issue | Fix | File |
|---|---|---|
| `sourceSchema.url: z.string()` accepted empty string | Added `.min(1)` | `packages/contracts/src/schemas.ts` |
| `StoryPriorityDto` type missing (only enum without DTO alias) | Added type + re-export | `packages/contracts/src/schemas.ts`, `src/index.ts` |
| `buildSourceOpenError` had no dedicated describe block | Added happy-path + rejection tests | `packages/analytics/src/events.test.ts` |
| `dashboardPayloadSchema` and `settingsPayloadSchema` had no rejection tests | Added wrong-version + missing-field tests | `packages/contracts/src/schemas.test.ts` |
| Test fixtures duplicated inline across contracts tests | Extracted `minimalSource` / `minimalStory` constants | `packages/contracts/src/schemas.test.ts` |

### Validation after rebuild pass 2

- `npm run build` — pass (packages + prototype vite build)
- `npm run test:packages` — pass (8 contracts, 11 analytics)
- `npm run lint:prototype:slice` — pass (exit 0, no errors)

### Remaining risks (unchanged from pass 1)

- `outletCount` / `sources` cross-field inconsistency (see above)
- `settingsPayloadSchema` free strings vs enums (see above)
- `occurredAt` no ISO format validation (see above)

## Next recommended slice

- **Slice 2:** Dashboard read path from a small typed mock API (or static JSON behind fetch) using `@tempo/contracts`, keeping UI identical.