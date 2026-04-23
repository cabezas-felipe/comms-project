# Mode 2 — Slice 10 (closed): AI router hardening

## 1) Slice objective

Harden the AI model-routing layer with prompt versioning, provider-ready path, and runtime telemetry counters.

## 2) Scope and exclusions

- In scope:
  - prompt template/version module
  - OpenAI-compatible provider adapter path
  - router metrics counters
  - AI metrics API endpoint
  - updated router tests
- Out of scope:
  - persistent metrics datastore
  - non-summarization capability execution
  - frontend AI controls

## 3) Design-system discovery and source-of-truth choice

- No design-system impact; backend-only slice.

## 4) Design-system mapping

- Not applicable (no UI changes).

## 5) Implementation summary

- Added `[apps/api/src/ai/prompts.mjs](apps/api/src/ai/prompts.mjs)`:
  - `buildSummaryPrompt()`
  - `SUMMARY_PROMPT_VERSION = "summary-v1"`
- Added `[apps/api/src/ai/providers/openai-compatible.mjs](apps/api/src/ai/providers/openai-compatible.mjs)`
  - HTTP call path for `openai:<model>` config
- Updated `[apps/api/src/ai/model-router.mjs](apps/api/src/ai/model-router.mjs)`:
  - provider resolution for `openai:` models
  - metrics counters and accessor
  - prompt version in summary metadata
- Updated `[apps/api/src/ai/model-router.test.mjs](apps/api/src/ai/model-router.test.mjs)`:
  - verifies prompt version
  - verifies metrics increment behavior
- Updated `[apps/api/src/server.mjs](apps/api/src/server.mjs)`:
  - exposes `GET /api/ai/metrics`

## 6) State coverage (loading/empty/error/success)

- Existing fallback behavior remains:
  - provider/timeout failures -> heuristic summary + fallback metadata.

## 7) Accessibility and responsive results

- Not applicable (backend-only).

## 8) Quality gate status

- `cd 05-engineering && npm run test:api` — pass
- `cd 05-engineering && npm run build` — pass
- `cd 05-engineering && npm run test:prototype` — pass
- `cd 04-prototype && npx eslint src/lib/api.ts vite.config.ts` — pass
- `node --check 05-engineering/apps/api/src/server.mjs` — pass
- `node --check 05-engineering/apps/api/src/ai/model-router.mjs` — pass

## 9) Risks and follow-up

- Metrics are in-memory only (reset on server restart).
- Next MVP hardening can add persistent telemetry sink + request tracing IDs.

## 10) Audit rebuild notes (2026-04-23)

### Review findings

All Slice 10 functional requirements verified present and correct:

- `apps/api/src/ai/prompts.mjs`: `SUMMARY_PROMPT_VERSION = "summary-v1"` and `buildSummaryPrompt()` both present; prompt includes all cluster fields (title, topic, priority, geographies, sources).
- `apps/api/src/ai/providers/openai-compatible.mjs`: HTTP POST to `TEMPO_OPENAI_BASE_URL` (defaulting to OpenAI), AbortController-backed timeout, `response.ok` guard, empty-content guard.
- `apps/api/src/ai/model-router.mjs`:
  - `aiMetrics` object with all four counters: `summarizationRequests`, `summarizationFallbacks`, `summarizationTimeouts`, `providerErrors`.
  - `getAiMetrics()` returns `{ ...aiMetrics }` — snapshot, not live reference.
  - Counter increments: `summarizationRequests` on every call; `providerErrors` + `summarizationFallbacks` on every catch; `summarizationTimeouts` only when `error.message.includes("timed out")`.
  - `promptVersion: SUMMARY_PROMPT_VERSION` present in both success-path and fallback-path `meta`.
  - `openai-compatible` provider activated when `model.startsWith("openai:")`.
- `apps/api/src/server.mjs`: `GET /api/ai/metrics` wired at line 196, returns `{ metrics: getAiMetrics() }`.

### Single gap found and closed

The `getAiMetrics()` accessor snapshot isolation was not tested. Added to `model-router.test.mjs`:

- `getAiMetrics returns an isolated snapshot, not a live reference` — mutates the returned copy to `summarizationRequests = 99999`, then asserts that a second `getAiMetrics()` call does not reflect the mutation. Guards the `{ ...aiMetrics }` spread as an explicit assertion.

### Known coverage gap (follow-up)

`summarizationFallbacks`, `providerErrors`, and `summarizationTimeouts` counter increments are not covered by tests. `CAPABILITY_DEFAULTS` is frozen at module load time; triggering the catch block from the existing test file is not feasible without either (a) a mock injection seam in the router or (b) a separate test file run in a fresh process with `TEMPO_AI_SUMMARY_MODEL=openai:test` and no `TEMPO_OPENAI_API_KEY`. Flagged for a future hardening slice.

### Validation results

| Command | Result |
|---|---|
| `cd 05-engineering && npm run test:api` | 19 tests, all pass |
| `cd 05-engineering && npm run build` | exits 0 |
| `cd 05-engineering && npm run test:prototype` | 9 tests, all pass |
| `cd 04-prototype && npx eslint src/lib/api.ts vite.config.ts` | exits 0 |
| `node --check apps/api/src/server.mjs` | exits 0 |
| `node --check apps/api/src/ai/model-router.mjs` | exits 0 |