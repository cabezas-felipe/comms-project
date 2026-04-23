# Mode 2 — Slice 2 (closed)

## 1) Slice objective

Introduce a typed Dashboard read path that validates payload shape with `@tempo/contracts` while preserving the current UI flow.

## 2) Scope and boundaries

- In: Dashboard data loading adapter (`fetchDashboardPayload`), contract validation, Dashboard wiring, and one adapter test.
- Out: backend API service, auth, persistence, ingestion, Settings/Onboarding data paths, and visual redesign.

## 3) Design-system discovery and source-of-truth choice

- Project-local source of truth remains `[04-prototype](../04-prototype)` tokens/components.
- No new primitives were added; existing typography, spacing, and status styles were reused.

## 4) Design-system mapping

- Header zone: preserved existing structure; added low-emphasis loading/error copy.
- Feed zone and card interactions: unchanged markup/behavior.
- Source rail interaction: unchanged behavior and analytics hooks preserved.

## 5) Implementation summary

- Added `[04-prototype/src/lib/api.ts](../04-prototype/src/lib/api.ts)`:
  - `fetchDashboardPayload()` returns a `DashboardPayload` validated by `dashboardPayloadSchema`.
  - Uses `CONTRACT_VERSION` and current mock stories as source data.
- Updated `[04-prototype/src/pages/Dashboard.tsx](../04-prototype/src/pages/Dashboard.tsx)`:
  - Reads stories from adapter-backed state.
  - Keeps existing filtering/headline/source-rail behavior.
  - Adds refresh loading/fallback copy and guardrail event emission on fetch errors.
  - Replaced global `findSource` call with local `findSourceInStories` for loaded data.
- Added test `[04-prototype/src/lib/api.test.ts](../04-prototype/src/lib/api.test.ts)` for adapter contract output.

## 6) State coverage (loading/empty/error/success)

- Loading: “Refreshing stories...” text under dashboard headline.
- Empty: existing empty state remains unchanged when filters produce no stories.
- Error: non-blocking fallback copy (“Using cached stories while refresh recovers.”) plus toast.
- Success: existing feed render path remains unchanged.

## 7) Accessibility and responsive results

- No changes to keyboard interaction patterns for cards/filters/source list.
- Added status copy as plain text in existing semantic structure (no focus-trap changes).
- Existing responsive layout behavior (feed + source rail breakpoints) unchanged.

## 8) Quality gate status

- `cd 05-engineering && npm run build:packages` — pass
- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass
- `cd 04-prototype && npx eslint src/pages/Dashboard.tsx src/lib/api.ts src/lib/api.test.ts` — pass

## 9) Risks and follow-up

- Current adapter still uses in-memory stories internally; this is intentional for bounded scope.
- Follow-up slice should replace adapter internals with a real API call and typed response mapping.
- Recommended next slice: Dashboard API endpoint contract + HTTP adapter + retry/backoff policy.

---

## 10) Rebuild notes (2026-04-23 — D-019)

**Bugs fixed:**

- `fetchDashboardPayload` `catch` block had `AbortError` guard placed after `await sleep()` and after the final-attempt fallback `return`. On any abort hitting the final attempt the error was silently swallowed; on earlier attempts the caller still waited the full backoff before the abort was re-raised. Fixed by checking `AbortError` first.

**Type-safety improvements:**

- Removed three `as` casts from `dtoToStory` in `Dashboard.tsx` (`as Geography[]`, `as Story["topic"]`, `as Source["kind"]`). The `@tempo/contracts` DTO types are structurally identical to the local prototype types; the casts suppressed compiler verification without adding any safety.

**Test coverage added (api.test.ts, 3 new cases):**

- Non-2xx HTTP response → retries then falls back to local payload
- Server response fails `dashboardPayloadSchema` parse → retries then falls back
- `AbortError` → rethrows immediately, fetcher called once, `sleep` never called

**Quality gate (post-rebuild):**

- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — 8 tests pass (5 adapter + 2 settings-api + 1 example)
- `cd 04-prototype && npx eslint src/pages/Dashboard.tsx src/lib/api.ts src/lib/api.test.ts` — pass