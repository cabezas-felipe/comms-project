# Mode 2 — Slice 4 (closed): lint baseline cleanup

## 1) Slice objective

Clear pre-existing error-level ESLint failures in the prototype so full lint can run as a reliable gate.

## 2) Scope and exclusions

- In scope: four files with current lint errors only.
- Out of scope: warning-only cleanup, component refactors, design changes.

## 3) Design-system discovery and source-of-truth choice

- Source of truth remains `[04-prototype](../04-prototype)`.
- No design-system token or component behavior changes.

## 4) Design-system mapping

- UI behavior and styles preserved.
- Changes are typing/import hygiene only.

## 5) Implementation summary

- `[src/components/ui/command.tsx](../04-prototype/src/components/ui/command.tsx)`:
  - Replaced empty interface with a type alias.
- `[src/components/ui/textarea.tsx](../04-prototype/src/components/ui/textarea.tsx)`:
  - Replaced empty interface with a type alias.
- `[src/pages/archive/EvidenceDesk.tsx](../04-prototype/src/pages/archive/EvidenceDesk.tsx)`:
  - Removed `any` casts by making `Select` generic over string unions.
- `[tailwind.config.ts](../04-prototype/tailwind.config.ts)`:
  - Replaced `require()` plugin import with ESM import.

## 6) State coverage (loading/empty/error/success)

- Not applicable (no runtime state-flow changes).

## 7) Accessibility and responsive results

- No markup or interaction changes.

## 8) Quality gate status

- `cd 04-prototype && npm run lint` — pass (warnings only, 0 errors)
- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass

## 9) Risks and follow-up

- Remaining lint warnings are all Fast Refresh export warnings in shared UI component files.
- Optional follow-up: warning cleanup slice if we want zero-warning lint policy.

## 10) Audit rebuild notes (2026-04-23)

**Branch:** `audit/claude-rebuild-slice4`

**Outcome:** No code changes required. All four slice fixes were already present and correct.

**Verification summary:**

| Command | Result |
|---|---|
| `npx eslint src/components/ui/command.tsx src/components/ui/textarea.tsx src/pages/archive/EvidenceDesk.tsx tailwind.config.ts` | Exit 0, no output |
| `npm run lint` | Exit 0, 8 warnings (Fast Refresh, unrelated scaffold files, pre-existing) |
| `npm run build` (from 05-engineering) | Exit 0 |
| `npm run test:prototype` (from 05-engineering) | Exit 0, 9 tests pass |

**File-by-file audit findings:**

- `command.tsx`: `type CommandDialogProps = DialogProps` — type alias in place, no empty interface.
- `textarea.tsx`: `export type TextareaProps = ...` — type alias in place.
- `EvidenceDesk.tsx`: `function Select<T extends string>` with typed `onChange: (v: T) => void` — generic component eliminates `any`; call sites use `Select<Topic | "All">` and `Select<Geography | "All">` correctly.
- `tailwind.config.ts`: ESM `import tailwindcssAnimate from "tailwindcss-animate"` — no `require()` call present.

**Decision recorded:** D-021 in `DECISIONS.md`.