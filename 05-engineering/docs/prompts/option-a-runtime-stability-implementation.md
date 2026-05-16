# Prompt: Option A runtime stability implementation

You are implementing a production-hardening fix for Vercel runtime stability in `05-engineering/apps/api`.

## Goal

Eliminate `ERR_MODULE_NOT_FOUND` risk caused by API runtime imports that depend on workspace package build artifacts (notably `@tempo/contracts` `dist/*` output). Implement Option A: API runtime must only depend on source files local to the API app at runtime.

## Constraints

- Keep behavior and payload shapes unchanged.
- No broad refactor; keep scope tight to runtime stability.
- Preserve existing tests and add targeted parity coverage.
- Do not change product logic, ranking behavior, or UI behavior.

## Current issue summary

- Production API (`tempo-gray-psi.vercel.app`) returned 500 with `ERR_MODULE_NOT_FOUND` despite successful build.
- Runtime code imports `@tempo/contracts`; package resolution points to `dist/index.js`.
- In Vercel deploy context, dependency on workspace package build output is fragile.

## Required work

1. **Create local runtime-safe contract module(s)** in `apps/api/src/` (example: `src/contracts-runtime/`):
   - Export the runtime pieces API needs today (schemas/normalizers/constants).
   - Use source-only files committed with API code.
2. **Update API runtime imports** so runtime paths no longer import from `@tempo/contracts`.
   - Target runtime files only (server, pipeline, ingestion, onboarding, scorer, etc.).
3. **Keep non-runtime usage deliberate**:
   - Tests/tooling can continue using `@tempo/contracts` if safe.
   - If any test becomes ambiguous, align it to runtime-safe imports where appropriate.
4. **Add parity tests**:
   - Assert runtime module outputs match existing behavior (schema acceptance/rejection, normalizer outputs).
   - Ensure no contract shape drift.
5. **Remove temporary workaround** after Option A is complete:
   - Remove `postinstall` package-build workaround from `05-engineering/package.json` if no longer needed.
6. **Run verification**:
   - API tests: `npm run test --workspace=@tempo/api`
   - (If needed) package tests impacted by moved logic.

## Deliverables

- Code changes implementing Option A runtime decoupling.
- New/updated tests proving parity and guarding regressions.
- A concise summary of:
  - files changed,
  - why runtime is now stable on Vercel,
  - exact commands run and results.

## Acceptance criteria

- No API runtime import path requires `@tempo/contracts` build artifacts.
- Tests pass.
- No response-contract or behavior regressions.
- Ready for preview deploy smoke test (`/health`, `/api/settings`, `/api/dashboard`) before production.
