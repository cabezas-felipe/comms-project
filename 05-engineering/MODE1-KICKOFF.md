# Mode 1 Kickoff Artifact - Engineer Intake Rebuild

Date: 2026-04-22

## Suitability check

- Current model: Codex 5.3
- Assigned role: Reviewer (Mode 1 architecture/risk gate)
- Suitability for this step: High (audit and plan only, no broad rewrite)

## 1) Risk summary (top 3 risks)

1. **Architecture gap risk (highest):** Current project is a frontend prototype with no production backend, auth, persistence, or ingestion pipeline. Shipping directly from this baseline would create reliability and data-integrity exposure.
2. **Quality gate incompleteness risk:** Lint and test scripts exist, but tests are effectively placeholders and there is no evidence of CI enforcement, dependency scanning, migration validation, or integration tests for ingestion/ranking paths.
3. **Generated-code inheritance risk:** The codebase includes generated/prototype scaffolding and broad dependencies not all tied to immediate scope; without intentional narrowing, execution can drift and increase maintenance burden.

## 2) System map

- **Auth and data access pathways**
  - No auth layer found.
  - Data is in-memory mock content from `src/data/stories.ts`.
- **Secret and environment handling**
  - No secret management or runtime environment contract observed.
- **App structure**
  - Frontend: React + Vite + TypeScript + Tailwind + shadcn-style UI components.
  - Backend: none.
  - Data/jobs/AI pipelines: none implemented.
  - Analytics instrumentation: none implemented.
- **Runtime and dependency inventory**
  - Rich UI stack and large dependency set in `[04-prototype/package.json](../04-prototype/package.json)`.
  - Prototype routes and pages are implemented and navigable.
- **Test and CI state**
  - Vitest is configured.
  - Current tests are minimal (example pass test), not validating core behavior.
  - CI workflow not identified in this run.

## 3) Keep/refactor/rewrite table


| Area                                                                                             | Decision          | Confidence | Why                                                                       | Immediate action                                                               |
| ------------------------------------------------------------------------------------------------ | ----------------- | ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `[04-prototype/src/components/ui](../04-prototype/src/components/ui)`                            | Keep              | High       | UI primitives are stable and aligned with prototype speed                 | Reuse as design-system baseline for first slices                               |
| `[04-prototype/src/App.tsx](../04-prototype/src/App.tsx)` and route shell                        | Keep              | High       | Route structure already matches converged prototype map                   | Preserve navigation contract as migration baseline                             |
| `[04-prototype/src/pages](../04-prototype/src/pages)` (Onboarding, Dashboard, Settings, Archive) | Refactor          | Medium     | UX is strong prototype quality but coupled to local state and mock data   | Introduce data-access boundaries without changing UX behavior                  |
| `[04-prototype/src/data/stories.ts](../04-prototype/src/data/stories.ts)`                        | Rewrite           | High       | Static mock data is useful for demos but unsafe as production data source | Replace with typed API/domain adapters behind interface                        |
| `[04-prototype/src/lib/derive.ts](../04-prototype/src/lib/derive.ts)`                            | Refactor          | Medium     | Good deterministic logic but embedded in UI-only context                  | Move to shared domain module with tests                                        |
| Backend/auth/ingestion/analytics layers (missing)                                                | Rewrite (net-new) | High       | Not present, required for production behavior                             | Create clean backend foundation and contracts before advanced features         |
| Test strategy and CI gates                                                                       | Rewrite           | High       | Existing tests do not protect regressions                                 | Add required gate pipeline (typecheck, lint, unit, integration, security scan) |


## 4) Rebuild path recommendation

- **Selected path:** Rebuild-first with selective keep/refactor from prototype.
- **Why this path:** The current state is ideal as product UX reference but not a safe production base due to missing platform layers.

### Proposed vertical slices (3-7)

1. **Slice 1 - Platform skeleton + typed contracts + analytics event schema** (no auth, no ingestion yet).
2. **Slice 2 - Dashboard read path from backend mock API through typed adapter** (preserve UI).
3. **Slice 3 - Settings persistence path (local DB + API) with optimistic UX parity**.
4. **Slice 4 - Auth baseline + guarded routes** (minimal surface).
5. **Slice 5 - Ingestion pipeline v0 + ranking endpoint (small corpus)**.
6. **Slice 6 - AI summarization guardrailed path (cost/retry/timeouts)**.

### Acceptance criteria pattern per slice

- User-visible behavior is unchanged or clearly improved.
- Data contract is typed and versioned.
- Required tests exist for touched core logic.
- Instrumentation events are emitted for key interactions.

### Rollback note pattern per slice

- Feature-flag or route-level fallback to previous stable path.
- Revertable schema/API changes (forward/backward migration plan where applicable).

## 5) Proposed first slice (scope, DoD, rollback)

### Scope (bounded)

- Create production repo skeleton under `[05-engineering/](README.md)` for web execution baseline:
  - `[05-engineering/apps/web](apps/web)` (initially wrapping current prototype structure)
  - `[05-engineering/packages/contracts](packages/contracts)` (shared types and API DTOs)
  - `[05-engineering/packages/analytics](packages/analytics)` (event names + payload schemas only)
- Add typed contracts for:
  - Story, Source, Trend, Dashboard payload, Settings payload.
- Add analytics event schema with `primary -> secondary -> guardrail` mapping and event definitions for:
  - `dashboard_viewed` (primary)
  - `story_expanded`, `source_opened` (secondary)
  - `source_open_error` (guardrail)
- No backend/auth/DB migration in this first slice.

### Definition of done

- One user flow preserved: open Dashboard, expand story, open source rail.
- <= 5 files touched in existing prototype paths; new package files allowed.
- Typecheck and lint pass for touched surfaces.
- Unit tests added for contract validation and event schema guards.
- Decision logged in `[DECISIONS.md](DECISIONS.md)`.

### Rollback

- Keep current `04-prototype` app entrypoint intact.
- New skeleton/components are additive and removable without impacting existing runtime.

## 6) Quality gates status (configured/missing)

### Configured

- TypeScript project config exists.
- ESLint config and `npm run lint` script exist.
- Vitest config and `npm run test` script exist.

### Missing or not yet enforced

- CI enforcement pipeline for required gates.
- Security/dependency scan.
- Migration validation process (for future DB changes).
- Integration tests for ingestion/ranking paths (not yet present).
- Performance budget check.

## 7) Escalation recommendation + confirmation prompt

- **Mode recommendation:** Stay in Mode 1 for one more short step, then move to Mode 2.
- **Why**
  - First-slice boundaries are clear; npm workspace and `apps/`* / `packages/`* live under `[05-engineering/](README.md)`.
  - Quality gate commands should be explicitly locked (exact scripts to treat as required).
  - This avoids rework while preserving momentum.
- **Preconditions met checklist**
  - Architecture/risk audit complete
  - Rebuild path selected
  - First-slice acceptance criteria defined
  - Required quality gates configured
  - Rollback path defined
  - Slice is small and bounded
- **Open blockers**
  - Confirm desired monorepo layout convention (`apps/packages` vs single-app with internal modules).
  - Confirm gate baseline for this repository (`lint`, `typecheck`, `test`, and chosen security scanner).
- **Proposed first mode 2 slice**
  - Implement platform skeleton + contracts + analytics schema as additive structure, preserving current prototype runtime.
- **Confirmation prompt**
  - Do you want to escalate to mode 2 for this slice?