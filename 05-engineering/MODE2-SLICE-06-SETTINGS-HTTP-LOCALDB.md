# Mode 2 — Slice 6 (closed): settings HTTP local DB

## 1) Slice objective

Replace Settings adapter internals from browser-only storage to HTTP + local DB while preserving current screen UX.

## 2) Scope and exclusions

- In scope:
  - local API app (`apps/api`) with `GET/PUT /api/settings`
  - local JSON-backed DB file for settings
  - adapter switch to HTTP-first reads/writes
  - fallback to localStorage on API failure
  - updated test coverage and dev scripts
- Out of scope:
  - auth/user identity
  - remote cloud DB
  - settings sharing across users/devices

## 3) Design-system discovery and source-of-truth choice

- Source of truth remains `04-prototype` design system.
- No token/component-level redesign in this slice.

## 4) Design-system mapping

- Settings UI markup and behavior are preserved.
- Only adapter internals and runtime service wiring changed.

## 5) Implementation summary

- Added local API service:
  - `[apps/api/src/server.mjs](apps/api/src/server.mjs)`
  - `[apps/api/data/settings.json](apps/api/data/settings.json)`
  - `[apps/api/package.json](apps/api/package.json)`
- Updated engineering scripts:
  - `[package.json](package.json)` now includes `apps/api` workspace and runs API+web concurrently in `npm run dev`.
- Updated prototype wiring:
  - `[../04-prototype/vite.config.ts](../04-prototype/vite.config.ts)` proxies `/api/settings` to `http://localhost:8787`.
  - `[../04-prototype/src/lib/settings-api.ts](../04-prototype/src/lib/settings-api.ts)` uses HTTP GET/PUT first, then local fallback.
  - `[../04-prototype/src/lib/settings-api.test.ts](../04-prototype/src/lib/settings-api.test.ts)` covers API success + fallback.

## 6) State coverage (loading/empty/error/success)

- Loading/saving copy in Settings unchanged from prior slice.
- API failure path preserves resilient behavior via local fallback.

## 7) Accessibility and responsive results

- No interaction model changes; keyboard/responsive behavior unchanged.

## 8) Quality gate status

- `cd 05-engineering && npm install` — pass
- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass
- `cd 04-prototype && npx eslint src/lib/settings-api.ts src/lib/settings-api.test.ts src/pages/Settings.tsx vite.config.ts` — pass

## 9) Risks and follow-up

- Local API is single-user local dev only.
- Next roadmap slice (back on original plan): **Auth baseline + guarded routes**.

## 10) Route-test coverage update (D-017 follow-up)

Added after Codex review identified that D-016 schema tests did not exercise actual HTTP route behavior.

- `[apps/api/src/server.mjs](apps/api/src/server.mjs)` — `DATA_DIR` now overridable via `TEMPO_DATA_DIR`; `app` exported; `listen` guarded behind `process.argv[1]` direct-run check.
- `[apps/api/src/server.routes.test.mjs](apps/api/src/server.routes.test.mjs)` — four `supertest`-based route tests: health, invalid→400, valid→200+schema, GET-after-PUT.
- `[apps/api/package.json](apps/api/package.json)` — `supertest ^7.0.0` added to devDependencies; `test` script includes the new file.
- `test:api` total: 13 tests (was 9).

## 11) Rebuild audit notes (2026-04-23, branch audit/claude-rebuild-slice6)

Audit pass against Slice 6 objective. No code changes were required.

**Review findings:**

- `server.mjs` — correct: `DATA_DIR` overridable via `TEMPO_DATA_DIR`; `app` exported; `listen` guarded behind direct-run check; `GET /api/settings` and `PUT /api/settings` fully implemented with schema validation and JSON file persistence.
- `settings-api.ts` — correct: HTTP-first with localStorage write-through on success; full localStorage fallback (including default seed) on any fetch error; comment updated to "Slice 5 adapter" (fixed in D-022).
- `vite.config.ts` — correct: `/api/settings` and `/api/dashboard` proxied to `http://localhost:8787`.
- `server.routes.test.mjs` — correct: 4 supertest route tests with isolated temp `TEMPO_DATA_DIR`; all pass.
- `server.settings.test.mjs` — correct: 6 schema unit tests; all pass.
- `settings-api.test.ts` — correct: 2 vitest tests covering offline fallback and API success path.

**Quality gate results:**

- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass (9 tests)
- `cd 04-prototype && npx eslint src/lib/settings-api.ts src/lib/settings-api.test.ts src/pages/Settings.tsx vite.config.ts` — pass
- `cd 05-engineering/apps/api && npm test` — pass (13 tests)

Decision recorded as **D-023** in `DECISIONS.md`.