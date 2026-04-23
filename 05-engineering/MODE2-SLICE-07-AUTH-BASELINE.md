# Mode 2 — Slice 7 (closed): auth baseline + guarded routes

## 1) Slice objective

Implement a minimal auth baseline that protects private routes while preserving existing onboarding and app UI flow.

## 2) Scope and exclusions

- In scope:
  - Local auth session provider/hook
  - Route guard component
  - Protected routing for dashboard/settings/archive
  - Onboarding login and redirect behavior
  - Header logout affordance
- Out of scope:
  - Server-issued tokens
  - User identity model
  - Role/permission matrix

## 3) Design-system discovery and source-of-truth choice

- Source of truth remains `04-prototype` components/tokens.
- No new visual primitives introduced.

## 4) Design-system mapping

- Existing page layouts retained.
- Added only a logout icon button reusing current header button styling.

## 5) Implementation summary

- Added auth provider/hook:
  - `[../04-prototype/src/lib/auth.tsx](../04-prototype/src/lib/auth.tsx)`
- Added guard wrapper:
  - `[../04-prototype/src/components/ProtectedRoute.tsx](../04-prototype/src/components/ProtectedRoute.tsx)`
- Updated routing in `[../04-prototype/src/App.tsx](../04-prototype/src/App.tsx)`:
  - Wrapped `/dashboard`, `/settings`, and `/archive/*` in `ProtectedRoute`.
- Updated onboarding in `[../04-prototype/src/pages/Onboarding.tsx](../04-prototype/src/pages/Onboarding.tsx)`:
  - Calls `login()` on submit and redirects authenticated users to dashboard.
- Updated header in `[../04-prototype/src/components/AppHeader.tsx](../04-prototype/src/components/AppHeader.tsx)`:
  - hides when unauthenticated
  - adds logout button

## 6) State coverage (loading/empty/error/success)

- Route-access state:
  - unauthenticated → redirect to onboarding
  - authenticated → access private routes

## 7) Accessibility and responsive results

- Button semantics preserved for new logout action.
- No responsive layout changes.

## 8) Quality gate status

- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass
- `cd 04-prototype && npx eslint src/App.tsx src/pages/Onboarding.tsx src/components/AppHeader.tsx src/components/ProtectedRoute.tsx src/lib/auth.tsx` — pass (warnings only)

## 9) Risks and follow-up

- Auth is currently local/session-based and not secure for production.
- Next roadmap slice should start ingestion pipeline v0 + ranking endpoint and plan server-backed auth replacement path.

## 10) Audit rebuild notes (2026-04-23)

**Auditor:** Claude Code (claude-sonnet-4-6), branch `audit/claude-rebuild-slice7`

**Outcome:** No code changes required. All five in-scope files matched the slice objective exactly.

**Verification summary:**

| Check | Result |
|---|---|
| `AuthProvider` session key + localStorage read/write | Correct — `tempo.auth.session.v1`, `useMemo` stable value |
| `ProtectedRoute` unauthenticated redirect | Correct — `<Navigate to="/onboarding" replace state={{ from: location.pathname }}>` |
| `App.tsx` private route wrapping | Correct — all six archive sub-routes plus `/dashboard` and `/settings` wrapped |
| `Onboarding.tsx` login + redirect | Correct — `login()` called before `navigate("/dashboard")`, `<Navigate>` for already-authenticated |
| `AppHeader.tsx` visibility + logout | Correct — hides on `/`, `/onboarding`, and unauthenticated; `LogOut` button calls `logout()` |
| `npm run build` | Pass |
| `npm run test:prototype` | Pass — 9 tests (6 api adapter + 2 settings-api + 1 example) |
| `eslint` on slice files | Pass — 1 pre-existing warning (`react-refresh/only-export-components` in `auth.tsx`) |

**Decision recorded:** D-024 in `05-engineering/DECISIONS.md`.