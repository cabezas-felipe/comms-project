# Mode 2 — Slice 9 (closed): AI model architecture + summarization

## 1) Slice objective

Introduce an MVP AI model architecture with capability routing and guardrailed summarization integrated into dashboard payload generation.

## 2) Scope and exclusions

- In scope:
  - capability->model map
  - mock AI providers for summarization
  - timeout + fallback + cost metadata guardrails
  - API integration into `/api/dashboard`
  - model map endpoint (`/api/ai/models`)
- Out of scope:
  - external LLM provider credentials
  - production model evaluation framework
  - UI-level model controls

## 3) Design-system discovery and source-of-truth choice

- Source of truth remains `04-prototype`; no visual component changes.

## 4) Design-system mapping

- No UI markup or token changes.
- Dashboard consumes updated summary text through existing contract field.

## 5) Implementation summary

- Added AI provider modules:
  - `[apps/api/src/ai/providers/mock-openai.mjs](apps/api/src/ai/providers/mock-openai.mjs)`
  - `[apps/api/src/ai/providers/mock-anthropic.mjs](apps/api/src/ai/providers/mock-anthropic.mjs)`
- Added guardrails module:
  - `[apps/api/src/ai/guardrails.mjs](apps/api/src/ai/guardrails.mjs)`
- Added model router:
  - `[apps/api/src/ai/model-router.mjs](apps/api/src/ai/model-router.mjs)`
  - capability map + summarization execution + timeout fallback + cost estimate
- Added API tests:
  - `[apps/api/src/ai/model-router.test.mjs](apps/api/src/ai/model-router.test.mjs)`
- Updated dashboard endpoint:
  - `[apps/api/src/server.mjs](apps/api/src/server.mjs)`
  - summaries now generated via router per ranked cluster
  - added `/api/ai/models`

## 6) State coverage (loading/empty/error/success)

- Existing dashboard state handling retained.
- AI timeout/failure path falls back to heuristic summary without breaking payload.

## 7) Accessibility and responsive results

- No frontend interaction or layout changes.

## 8) Quality gate status

- `cd 05-engineering && npm run test:api` — pass
- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass
- `cd 04-prototype && npx eslint src/lib/api.ts vite.config.ts` — pass
- `node --check 05-engineering/apps/api/src/server.mjs` — pass

## 9) Risks and follow-up

- Current providers are mock implementations for architecture validation.
- Next step: wire production provider(s) behind same router interface and add prompt/version controls.

## 10) Rebuild notes (audit pass 2026-04-23)

**Status:** No functional code changes. Implementation matched all Slice 9 objectives. One test coverage gap closed.

**Gap found:** `model-router.test.mjs` only covered the happy path. The two critical reliability mechanisms — `withTimeout` guardrail and `heuristicSummary` fallback — had zero test coverage. Any regression in deadline enforcement or fallback text generation would have been invisible to CI.

**Fix applied:** Added four tests to `model-router.test.mjs` (importing from `guardrails.mjs`):
- `summarizeCluster meta contains all expected fields on success path` — pins entire cost-observability meta shape.
- `withTimeout resolves when promise completes before deadline` — happy path of the guardrail.
- `withTimeout rejects with timeout message when deadline is exceeded` — uses a never-resolving promise + 10ms deadline; asserts exact error message.
- `heuristicSummary returns non-empty string that includes cluster title` — confirms fallback text generator is independently exercisable.

**Gate results after fix:**
- `cd 05-engineering && npm run test:api` — 18 tests, all pass (was 14)
- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — 9 tests, all pass
- `cd 04-prototype && npx eslint src/lib/api.ts vite.config.ts` — pass (exit 0)
- `node --check 05-engineering/apps/api/src/server.mjs` — pass