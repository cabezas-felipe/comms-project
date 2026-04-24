# Decisions log

Engineering and Tempo build-out decisions (intake, slices, tooling). Reverse chronological: newest first.

### 2026-04-24 - D-036 - Slice 18 hardening: enforce 401 on protected API routes

#### Context

Follow-on to D-035 on the same branch. Slice 18's initial implementation called `resolveUserId` on the three protected routes but silently fell back to global settings when the resolver returned null. The policy change requires an explicit 401 gate — no silent fallback — on `GET /api/settings`, `PUT /api/settings`, and `GET /api/dashboard`.

#### Decision

- **`server.mjs`:** Introduced `export const _auth = { resolver: resolveUserId }` — a mutable hook on a plain object so tests can inject a deterministic resolver without a live Supabase instance. Introduced `requireAuth(req, res)` that calls `_auth.resolver`, sends `401 { message }` on null, and returns the user ID on success. Applied to all three protected routes. On `PUT /api/settings`, the auth check now precedes payload validation (previously it was after). `GET /api/dashboard` now passes `userId` to `readSettings` instead of reading the global key.
- **`server.routes.test.mjs`:** Added `_auth` to the import. Set `_auth.resolver = async () => TEST_USER_ID` at module level so all existing tests authenticate deterministically without Supabase. Added three new 401 tests (one per protected route) using `try/finally` to safely override and restore the resolver. Test count: 51 → 54.
- **`04-prototype/.env.example`:** Fixed misleading single-port example for the Supabase redirect URL allowlist. Clarified that the callback URL is built from `window.location.origin` at runtime and that operators must register every origin they use (Supabase does not support port wildcards for localhost).

#### Why

- The silent-fallback pattern let any unauthenticated caller read and overwrite any user's settings (or the global key), which violates the per-user isolation goal of slice 18.
- The `_auth` object hook (mutable property on an exported const) is the idiomatic ESM approach for test injection without a mocking library — exported `let` bindings cannot be reassigned from outside the module.
- Moving the auth check before payload validation on PUT ensures the API never leaks whether a payload is valid to an unauthenticated caller.

#### Consequences

- `npm run test:api` → 54 tests, 0 failures.
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- Unauthenticated callers to the three protected routes now always receive 401; no partial data is returned.

### 2026-04-24 - D-035 - Slice 18: real Supabase Auth (magic link) + per-user settings

#### Context

Slice 18 (branch `build/slice17-auth-flow-import`). In-scope: frontend auth wiring (`04-prototype`), API auth middleware (`05-engineering/apps/api`), settings persistence keyed by user ID, and required env var / redirect-URL documentation. Out of scope: UI redesign, mobile changes, onboarding settings save, broad refactor.

#### Decision

- **Frontend auth (`src/lib/auth.tsx`):** Replaced the simulated `localStorage.getItem === "1"` pattern with real Supabase Auth. `AuthProvider` initializes from `supabase.auth.getSession()`, subscribes to `onAuthStateChange`, and exposes `user`, `session`, and `loading` in context. `signIn(email, type)` calls `signInWithOtp` with an `emailRedirectTo` that embeds the `type` query param so the callback can distinguish new vs. returning users.
- **New `AuthCallback` page:** Handles the Supabase magic-link redirect at `/auth/callback`. Routes to `/onboarding` for `type=signup` and `/dashboard` for `type=login`. The Supabase JS SDK processes the URL fragment automatically; `onAuthStateChange` fires in the provider and flips `isAuthenticated`.
- **Settings scoping (frontend):** `fetchSettingsPayload` and `saveSettingsPayload` now call `supabase.auth.getSession()` before each request. They scope the localStorage cache key to `tempo.settings.v1.{user_id}` and include `Authorization: Bearer {access_token}` in API calls. Degrades gracefully when Supabase is unconfigured.
- **API auth middleware (`server.mjs`):** Added `resolveUserId(req)` which extracts the Bearer token, calls `supabase.auth.getUser(token)` with the service-role client (JWT verification), and returns the user UUID. Returns `null` when no token or Supabase is unconfigured. `GET /api/settings` and `PUT /api/settings` pass the resolved ID to the repo layer.
- **Settings repo (`settings-repo.mjs`):** `readSettings(userId)` and `writeSettings(payload, userId)` now accept an optional `userId`. Supabase adapter uses key `user:{uuid}`; file adapter uses `settings_user_{userId}.json`. Unauthenticated calls (no userId) continue to use the global key — all existing tests pass unchanged.
- **Schema:** No DDL change. Per-user settings use a key-prefix convention (`user:{uuid}`) within the existing `settings` table. A migration file (`002_user_settings.sql`) documents the convention and provides RLS policy snippets for a future slice.
- **`ProtectedRoute`:** Added `loading` guard to prevent flash-redirect to `/` while session is being restored on initial load.

#### Why

- The simulated auth (`localStorage === "1"`) had no user identity, making per-user settings impossible. Real Supabase Auth provides a stable `user.id` that can key both the client-side localStorage cache and the server-side DB row.
- Key-prefix approach (`user:{uuid}`) avoids a schema migration on the `settings` table while preserving backward compatibility with file-adapter deployments and all existing tests.
- `supabase.auth.getUser(token)` with the service-role client is the recommended Supabase pattern for server-side JWT verification — it validates the token against the Auth server, not just locally.

#### Consequences

- `npm run test:api` → 51 tests, 0 failures (unchanged).
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- Operator must add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to `04-prototype/.env` and `SUPABASE_SERVICE_ROLE_KEY` to the API `.env` for real auth to function. Without these vars both layers degrade gracefully (settings fall back to global key; auth UX shows a toast error on submit).
- Operator must whitelist `/auth/callback` in Supabase Auth → URL Configuration → Redirect URLs.
- Slice 18 is closed.

### 2026-04-23 - D-034 - Slice 16: staging handoff runbook (no code changes)

#### Context

Slice 16 (branch `build/slice16-next`). In-scope: `MODE2-SLICE-16-STAGING-HANDOFF.md` (new), `DECISIONS.md` (this entry). Objective: produce a staging-handoff artifact targeted at deploying to a remote host and granting the first external user access — distinct from Slice 15's local/internal beta checklist.

#### Decision

- Added `05-engineering/MODE2-SLICE-16-STAGING-HANDOFF.md` documenting:
  - **Env var matrix** for both API and frontend layers, with staging-specific values (absolute `TEMPO_DATA_DIR` path, `TEMPO_AI_MOCK_ONLY=true` as the safe staging default, `VITE_*` vars baked at build time, EU PostHog host option).
  - **Exact startup commands** for a remote host: `npm install` → `npm run build` → `node apps/api/src/server.mjs` in the background → static frontend served via `npx serve` or reverse proxy. Includes reverse-proxy guidance (nginx / Caddy) for same-domain `/api/*` forwarding.
  - **Smoke-test checklist** executed from outside the staging host (external `curl` and clean browser session), covering infrastructure reachability, auth redirect flow, persistence across API restart, and PostHog event confirmation.
  - **Failure and rollback steps** for the three most likely staging failure modes: API won't start (env misconfiguration paths named), data lost after restart (file path vs Supabase seat), blank frontend (reverse proxy or CORS). Full rollback is git checkout + rebuild + data restore.
  - **Go/no-go checklist** with 7 technical gates (T1–T7) and 5 operational gates (O1–O5), each with explicit GO criteria and a binary pass/fail status column. A single NO-GO item blocks handoff.
- No code changes made. All four validation gates pass unchanged.

#### Why

- Slice 15 addressed internal operator readiness (single developer, local machine, no external users). Slice 16 is necessary because staging introduces three qualitatively different constraints: (1) the operator is not physically present when the external user first accesses the system, (2) the frontend is a static build (not Vite dev server) requiring explicit build-time env var baking, and (3) a formal go/no-go gate is needed before any external party touches the system.
- The reverse proxy startup path and `VITE_*` build-time variable note are staging-specific concerns not covered in Slice 15 and not derivable from reading the local dev setup.
- The go/no-go table gives the operator a single, auditable decision artifact — important when handing off to a non-technical external user who cannot diagnose failures independently.

#### Consequences

- `npm run test:api` → 51 tests, 0 failures (unchanged).
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- No behavioral changes to the API, prototype, or shared packages.
- Slice 16 is closed. The staging handoff runbook is the canonical artifact for first external-user deployment.

### 2026-04-23 - D-033 - Slice 15: beta readiness checklist (no code changes)

#### Context

Slice 15 (branch `build/slice14-observability-posthog`). In-scope: `MODE2-SLICE-15-BETA-READINESS-CHECKLIST.md` (new), `DECISIONS.md` (this entry). Objective: produce a production-readiness artifact for beta handoff — env var reference, startup steps, smoke-test checklist, rollback procedure, and launch day checklist — without any UI, auth, or feature changes.

#### Decision

- Added `05-engineering/MODE2-SLICE-15-BETA-READINESS-CHECKLIST.md` documenting:
  - **Required env vars** for both API and frontend layers, grouped by service (Supabase, AI model routing, PostHog), with Required/Optional/Conditional classification and safe defaults noted.
  - **Local startup steps** covering the common `npm run dev` path plus optional splits for API-only and web-only.
  - **Smoke-test checklist** covering all nine API routes (`/health`, `/api/settings` GET/PUT, `/api/dashboard`, `/api/dashboard?limit`, `/api/ai/models`, `/api/ai/metrics`, `/api/ingestion/sources`), all frontend flows (auth redirect, onboarding, dashboard render, settings persistence, logout), and a persistence verification step.
  - **Rollback checklist** covering process stop, settings file restoration, Supabase row restoration, and PostHog disable.
  - **Launch day checklist** split into pre-launch validation, launch sequence, and 30-minute post-launch monitoring steps.
  - **Known risks at beta** table documenting the four accepted risks: localStorage auth, static ingestion data, unbounded AI cost, and Supabase anon-key RLS gap — each with a severity level and mitigation note.
- No code changes made. All four validation gates passed unchanged before and after this slice.

#### Why

- Slices 11–14 completed the core technical foundation (Supabase persistence, Anthropic wiring, ingestion normalization, PostHog observability). The system can now be handed to a beta operator, but there was no single document describing how to stand it up, verify it, or recover from a failure.
- A runbook-style checklist reduces the risk of misconfiguration during handoff without requiring any further feature work.
- Documenting known risks explicitly (auth model, static ingestion, AI cost, RLS) ensures the beta operator understands the constraints without discovering them in production.

#### Consequences

- `npm run test:api` → 51 tests, 0 failures (unchanged).
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- No behavioral changes to the API, prototype, or shared packages.
- Slice 15 is closed. The beta readiness checklist is the canonical handoff artifact for this build phase.

### 2026-04-23 - D-032 - Slice 14: observability + PostHog analytics wiring

#### Context

Slice 14 (branch `build/slice14-observability-posthog`). In-scope: `packages/analytics/src/` (event schema additions + new PostHog sink module), `apps/api/src/telemetry.mjs` (new), `apps/api/src/server.mjs` (telemetry wiring), `apps/api/src/telemetry.test.mjs` (new), `apps/api/.env.example` (new vars), `apps/api/package.json` (test script), `04-prototype/src/lib/analytics.ts` (PostHog init helper). Objective: wire a production-ready PostHog integration at both the API and frontend layers while keeping fail-safe behavior when env vars are absent.

#### Decision

- Added three server-side event schemas to `packages/analytics/src/events.ts`:
  - `api_dashboard_requested` (tier: primary) — payload: `storyCount`, `normErrorCount`, `limitApplied`, `fallbackCount`, `totalCostUsd`, `aiModel`.
  - `api_error` (tier: guardrail) — payload: `route`, `statusCode`, `message`.
  - `settings_updated` (tier: secondary) — payload: `topicCount`, `geoCount`, `sourceCount`.
  - Each has a matching Zod schema, a typed builder function, and is included in the `analyticsEventSchema` discriminated union.
- Added `packages/analytics/src/posthog-sink.ts`: exports `createPostHogSink({ apiKey, host?, distinctId? })`. Uses platform `fetch` (Node 18+ and browsers) to POST to PostHog's `/capture/` endpoint. No new npm dependency. All fetch failures are swallowed — the sink never throws. Updated `tsconfig.build.json` to include the new file; added `"types": ["node"]` to the base `tsconfig.json` so `fetch` is typed for IDE and vitest.
- Added `apps/api/src/telemetry.mjs`: exports `trackServerEvent(name, properties)`. Reads `POSTHOG_API_KEY` and `POSTHOG_HOST` lazily (at call time, not import time) so test isolation is clean without module re-import tricks. No-op when key is absent. Uses `distinct_id: "tempo-api-server"` (server-side events are not user-attributable at this stage).
- Updated `apps/api/src/server.mjs`: imports `trackServerEvent` and calls it on three paths — `api_dashboard_requested` on successful dashboard response (with story count, cost, fallback count, AI model), `settings_updated` on successful settings write, and `api_error` on 500 failures in both routes.
- Added `apps/api/src/telemetry.test.mjs`: 4 tests covering the no-key no-op path, correct fetch payload when key is set, custom `POSTHOG_HOST` override, and swallowed fetch errors.
- Added `packages/analytics/src/posthog-sink.test.ts`: 7 tests covering sink creation, correct fetch call shape, default host/distinctId fallbacks, error swallowing, and server-side event schema compatibility.
- Added PostHog section to `apps/api/.env.example`: documents `POSTHOG_API_KEY` and `POSTHOG_HOST` with comments about EU cloud and no-key behavior.
- Updated `04-prototype/src/lib/analytics.ts`: added `initPostHog()` — reads `VITE_POSTHOG_API_KEY` and `VITE_POSTHOG_HOST` from the Vite env, generates a session-scoped `distinctId` stored in `sessionStorage` (falls back to `"tempo-anonymous"` when storage is unavailable), and calls `setAnalyticsSink(createPostHogSink(...))`. Must be called from `main.tsx` at app startup; no-op if key is absent.

#### Why

- Fetch-based PostHog capture avoids a new runtime dependency (`posthog-node` / `posthog-js`). The PostHog HTTP capture endpoint is stable and has no SDK requirement for basic event ingestion.
- Lazy env reads in `telemetry.mjs` match the pattern established in D-031 (model-router lazy reads) and keep tests isolated without module lifecycle hacks.
- Adding server-side event schemas to `packages/analytics` (rather than keeping them inline in `.mjs`) gives TypeScript consumers a single canonical reference for all events in the system, even though the API doesn't validate them at runtime.
- Session-scoped `distinctId` in `sessionStorage` avoids persistent user fingerprinting while still allowing funnel analysis within a session — appropriate for a private enterprise tool with a single operator.
- `api_dashboard_requested` captures AI cost and fallback telemetry that was previously only logged to stdout, making it queryable in PostHog dashboards without changing the existing `console.log` paths.

#### Consequences

- `npm run test:api` now runs 51 tests (up from 38; 4 new telemetry tests). All pass.
- `npm run test:packages` now runs 18 analytics tests (up from 11; 7 new posthog-sink tests). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint` exits 0. `node --check server.mjs` exits 0.
- When `POSTHOG_API_KEY` is absent (default dev/test mode), zero PostHog traffic is generated. No runtime crashes, no network calls.
- Frontend PostHog activation requires adding `VITE_POSTHOG_API_KEY` to `04-prototype/.env.local` and calling `initPostHog()` from `main.tsx` (one line, not in scope for this slice).

### 2026-04-23 - D-031 - Slice 13: real Anthropic provider wiring, lazy env, mock-only flag

#### Context

Slice 13 (branch `build/slice13-real-ai-provider-wiring`). In-scope: `apps/api/src/ai/providers/anthropic.mjs` (new), `apps/api/src/ai/model-router.mjs` (updated), `apps/api/src/ai/model-router.test.mjs` (extended), `apps/api/package.json` (new dependency), `apps/api/.env.example` (new vars), `apps/api/src/server.mjs` (startup validation + model endpoint). Objective: wire a production-ready Anthropic execution path through the existing model-router abstraction while keeping mock and fallback paths fully intact.

#### Decision

- Added `src/ai/providers/anthropic.mjs`: wraps `@anthropic-ai/sdk`. Accepts `{ apiKey, model, prompt, timeoutMs }`, creates a scoped `Anthropic` client with SDK-level timeout, calls `messages.create` (max_tokens=256, temperature=0.2), and returns `{ summary, inputTokens, outputTokens }` from actual API usage. Empty-response guard throws rather than silently returning garbage.
- Updated `src/ai/model-router.mjs`:
  - Converted `CAPABILITY_DEFAULTS` from a module-level constant to `getCapabilityDefaults()` (lazy env read), so tests can set `TEMPO_AI_SUMMARY_MODEL` after import without module re-import hacks.
  - `providerFor(model)` now exported. Reads `TEMPO_AI_MOCK_ONLY` at call time; if `"true"`, forces all providers to their mock equivalent regardless of model prefix.
  - Added `resolveModelName(model)` to strip the `anthropic:` or `openai:` prefix before handing the bare model ID to the provider.
  - Added `ANTHROPIC_COSTS` table with per-MTok input/output pricing for Haiku 4.5, Sonnet 4.6, Opus 4.7. When real token counts are available (Anthropic path), the cost calculation uses actuals; all other paths keep the existing heuristic estimate.
  - Added `assertAiConfig(capabilityMap?)` (exported): iterates configured models, throws a human-readable error if a real provider is configured without its API key. Accepts an optional `capabilityMap` argument for testability.
  - `summarizeCluster` routes through the Anthropic provider when `provider === "anthropic"`. Prefers `TEMPO_ANTHROPIC_API_KEY`; falls back to `ANTHROPIC_API_KEY` (SDK default env). Missing key throws immediately (caught by existing fallback handler — no silent failure).
  - All other existing paths (openai-compatible, mock-openai, mock-anthropic) and the heuristic fallback are unchanged.
- Updated `src/server.mjs`: imports `assertAiConfig`; calls it at app init and logs a `console.warn` if misconfigured (non-crashing — fallback keeps the server functional). `GET /api/ai/models` now includes `mockOnly: bool`.
- Added `@anthropic-ai/sdk ^0.91.0` to `apps/api` dependencies.
- Extended `model-router.test.mjs`: 12 new tests covering provider routing (`providerFor` unit tests), `TEMPO_AI_MOCK_ONLY` enforcement, `assertAiConfig` validation (pass/throw cases for both providers), and the full fallback path via lazy env reads (closes the Slice 10 known coverage gap for `providerErrors`/`summarizationFallbacks` counter increments).

#### Why

- The existing `openai-compatible` path required `TEMPO_OPENAI_API_KEY` and showed the correct pattern for real provider wiring; Anthropic follows the same shape.
- Lazy env reads (`getCapabilityDefaults()` at call time) eliminate the need for separate test processes or module re-import tricks to test different model configs — a direct improvement in test ergonomics without changing the public API contract.
- `TEMPO_AI_MOCK_ONLY=true` gives operators a single env toggle to run in mock mode for dev/CI without changing model config. Cheaper than per-model overrides.
- Actual token counts from the Anthropic response replace token estimation on the Anthropic path, making cost telemetry accurate rather than approximate for real API calls.
- `assertAiConfig()` at startup surfaces misconfiguration (real model, missing key) at the first API call via a logged warning rather than silently falling back, matching the fail-fast philosophy established in D-029.

#### Consequences

- `npm run test:api` now runs 38 tests (20 model-router + 6 settings-schema + 5 route-level + 7 settings-repo). All pass. Up from 26.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint` exits 0. Both `node --check` commands exit 0.
- No real Anthropic API calls are made in tests or default dev mode (default model is `mock-openai-mini`). Real provider activation requires explicit `TEMPO_AI_SUMMARY_MODEL=anthropic:<model>` + API key.
- Cost estimates for mock/openai paths remain heuristic (unchanged); Anthropic path uses actual token counts from API response.

### 2026-04-23 - D-030 - Slice 12: ingestion sources foundation — normalization layer + feed declaration

#### Context

Slice 12 (branch `build/slice12-ingestion-sources`). In-scope: `apps/api/src/ingestion/` (new), `apps/api/data/source-feeds.json` (new), `apps/api/src/server.mjs` (wiring), `apps/api/src/server.routes.test.mjs` (new test + seed), `apps/api/package.json` (test script), `MODE2-SLICE-12-INGESTION-SOURCES.md` (new). Objective: move ingestion from a direct static-file read to an explicit normalized pipeline while keeping the dashboard contract and all existing behavior stable.

#### Decision

- Added `src/ingestion/source-normalizer.mjs`: exports `normalizeSourceItem(raw)` and `normalizeSourceItems(rawItems)`.
  - `normalizeSourceItem` coerces known fields to canonical types, defaults optional fields, and throws on any missing required field (`clusterId`, `sourceId`, `outlet`, `kind`, `weight`, `url`, `minutesAgo`, `headline`, `body`).
  - `normalizeSourceItems` processes an array, skips invalid items (reports `{ index, error }` in an `errors[]` array) rather than aborting — one bad feed item must not kill the pipeline.
- Added `src/ingestion/feed-reader.mjs`: exports `readFeedItems(dataDir)` — thin abstraction over `source-items.json`. Swap this function to activate RSS, DB, or HTTP-based ingestion without touching normalization or downstream logic.
- Added `src/ingestion/source-normalizer.test.mjs`: 8 unit tests covering the happy path, optional-field defaults, string-body coercion, two missing-required-field cases, valid-batch pass-through, mixed-batch skipping with error reporting, and non-array TypeError.
- Modified `src/server.mjs`: removed `readSourceItems()` and `SOURCE_ITEMS_FILE`; imported `readFeedItems` and `normalizeSourceItems`; dashboard handler now passes through the normalization step and logs any skipped items. Added `GET /api/ingestion/sources` route (reads `source-feeds.json`; 500 on error).
- Added `data/source-feeds.json`: declares 6 source feeds (4 RSS + 2 social) with `id`, `name`, `kind`, `url`, `weight`, `active` fields. URLs are placeholders — no live fetching in this slice.
- Updated `src/server.routes.test.mjs`: seeds `source-feeds.json` in the isolated tmpDir; added test asserting `GET /api/ingestion/sources` returns 200 with a typed `feeds[]` array.
- Updated `package.json` test script: added `src/ingestion/source-normalizer.test.mjs`.

#### Why

- The direct `readSourceItems()` → `buildDashboardPayload()` path had no normalization seam: raw JSON was consumed as-is with no field coercion or validation. A single malformed item (wrong type, missing field) would either silently produce wrong output or throw inside the dashboard handler with no actionable error.
- Introducing a named normalization boundary makes the ingestion contract explicit: anything upstream of `normalizeSourceItems` can change shape; anything downstream (clustering, ranking, AI summarization) sees a consistent object.
- `readFeedItems` makes the data source swappable in one place. The next ingestion slice can replace the file read with RSS fetching, a Supabase query, or a webhook payload without modifying any of the ranking or AI layers.
- `source-feeds.json` documents declared sources as a machine-readable manifest. This is the intended config surface for a future feed-management UI and for the operator to understand which outlets are in scope.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 35 tests (8 model-router + 6 settings-schema + 6 route-level + 7 settings-repo + 8 normalizer). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- Dashboard contract (`dashboardPayloadSchema`) and all existing route behaviors are unchanged. Frontend consumers see no difference.
- `GET /api/ingestion/sources` is a new read-only endpoint; no auth guard in this slice (consistent with other API routes at this stage).
- Gap: `readFeedItems` still reads from `source-items.json` — no live RSS fetching yet. Next ingestion slice should replace `feed-reader.mjs` internals and add an RSS parsing/normalization path.
- Gap: `stories` and `summaries` Supabase tables remain unpopulated. Slice 13 can wire normalized items into the `stories` table behind the ingestion-repo boundary.

### 2026-04-23 - D-029 - Slice 11 durability fix: fail fast on partial Supabase config

#### Context

Post-build audit of Slice 11 (branch `build/slice11-supabase-foundation`). The original `readSettings()` / `writeSettings()` routing used `isSupabaseEnabled()`, which returns `false` when `SUPABASE_URL` is set but key vars are absent. This means a partially configured deployment (URL present, key missing) silently falls through to file storage — masking misconfiguration instead of surfacing it.

In-scope: `apps/api/src/db/settings-repo.mjs`, `apps/api/src/db/settings-repo.test.mjs`.

#### Decision

- Replace `isSupabaseEnabled()` routing in `readSettings()` and `writeSettings()` with an explicit `process.env.SUPABASE_URL` check followed by an `assertSupabaseEnv()` call.
- Behavior: if `SUPABASE_URL` is set → call `assertSupabaseEnv()` (throws on missing key) then use Supabase path. If `SUPABASE_URL` is unset → use file adapter. Silent fallback is no longer possible when `SUPABASE_URL` is present.
- Import: swap `isSupabaseEnabled` import for `assertSupabaseEnv` in `settings-repo.mjs`; `isSupabaseEnabled` is still exported from `client.mjs` for external callers.
- Add two tests to `settings-repo.test.mjs`: (1) `SUPABASE_URL` set + no key → `readSettings()` rejects with missing key message; (2) `SUPABASE_URL` unset → file adapter returns valid settings object. Existing 5 tests unchanged.

#### Why

- Silent fallback hides operator misconfiguration: a deployment with `SUPABASE_URL` set but no key would appear to work (using file storage) while never writing to Supabase. The error only surfaces later, at a data-loss point, not at startup.
- `assertSupabaseEnv()` already existed in `client.mjs` with the correct error message; applying it at the routing call site costs nothing and gives a human-readable failure on first use.

#### Consequences

- `readSettings()` / `writeSettings()` now throw immediately if `SUPABASE_URL` is set without a key — operators see a clear error at the first API call rather than silent file fallback.
- Deployments without `SUPABASE_URL` are unaffected; file adapter path is unchanged.
- `npm run test:api` now runs 26 tests (8 model-router + 6 settings-schema + 5 route-level + 7 settings-repo). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). Validation gates unchanged.

### 2026-04-23 - D-028 - Slice 11: Supabase production data foundation (Free-tier-first, Pro-ready)

#### Context

Slice 11 (branch `build/slice11-supabase-foundation`). In-scope: `apps/api/src/db/` (new), `apps/api/.env.example` (new), `apps/api/src/server.mjs` (settings wiring), `apps/api/package.json` (dependency + test script), `MODE2-SLICE-11-SUPABASE-FOUNDATION.md` (new). Objective: introduce a Supabase-backed persistence layer for settings while preserving existing file-based behavior in tests and local dev.

#### Decision

- Added `src/db/client.mjs`: Supabase client factory with `isSupabaseEnabled()`, `assertSupabaseEnv()`, and `getSupabaseClient()`. Client is only initialized when `SUPABASE_URL` + (`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY`) are present; otherwise no Supabase code runs.
- Added `src/db/settings-repo.mjs`: adapter that routes `readSettings()`/`writeSettings()` to either the file-based or Supabase implementation based on env. Exports `DEFAULT_SETTINGS` so server.mjs can reference `contractVersion` without a local duplicate.
- Added `src/db/schema.sql`: initial schema for `settings`, `stories` (placeholder), and `summaries` (placeholder). RLS enabled on all tables; server-side access via `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. Anon-key policies deferred to the auth slice.
- Added `src/db/settings-repo.test.mjs`: 5 tests covering file-adapter read/write, `isSupabaseEnabled` returns false without env, `assertSupabaseEnv` error messages for each missing-var case.
- Modified `src/server.mjs`: removed local `ensureSettingsFile`, `readSettings`, `writeSettings`, and `DEFAULT_SETTINGS`; imported equivalents from `./db/settings-repo.mjs`. `SETTINGS_FILE` constant removed; file path is now encapsulated in the repo.
- Added `@supabase/supabase-js ^2.0.0` to `apps/api` dependencies.
- Added `.env.example` documenting all env vars with inline notes on Free vs. Pro usage.

#### Why

- Adapter pattern keeps existing file-based path intact — tests and local dev need zero credentials.
- `SUPABASE_SERVICE_ROLE_KEY` is preferred over `SUPABASE_ANON_KEY` for server-side to bypass RLS (correct pattern for a trusted backend). Both are supported so operators can start with the anon key if they have not yet rotated credentials.
- `assertSupabaseEnv()` gives a human-readable startup error rather than a cryptic `createClient` failure when an operator partially configures the env.
- Schema separates `settings` (in use), `stories`, and `summaries` (placeholders) so future ingestion slices have a documented landing zone without schema churn.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 24 tests (8 model-router + 6 settings-schema + 5 route-level + 5 settings-repo). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- Supabase is inactive unless both `SUPABASE_URL` and a key var are set — no behavioral change for existing deployments.
- Auth is unchanged (localStorage-backed). Migration path to Supabase Auth is documented in `MODE2-SLICE-11-SUPABASE-FOUNDATION.md`; implementation is deferred to a future slice.
- Pro triggers: pg_cron for scheduled ingestion, DB size past 500 MB, realtime for live monitoring feeds — all documented in the slice artifact.

### 2026-04-23 - D-027 - Slice 10 audit pass: AI router hardening verified, snapshot isolation test added

#### Context

Audit pass of Slice 10 (branch `audit/claude-rebuild-slice10`). In-scope files reviewed: `apps/api/src/ai/prompts.mjs`, `apps/api/src/ai/providers/openai-compatible.mjs`, `apps/api/src/ai/model-router.mjs`, `apps/api/src/ai/model-router.test.mjs`, `apps/api/src/server.mjs`. Objective: harden the AI model-routing layer with prompt versioning, provider-ready path, and runtime telemetry counters.

#### Decision

- No functional code changes required. All Slice 10 functional requirements were already present and correct.
- Added one test to `[apps/api/src/ai/model-router.test.mjs](apps/api/src/ai/model-router.test.mjs)`:
  1. `getAiMetrics returns an isolated snapshot, not a live reference` — mutates the returned copy and verifies that a subsequent `getAiMetrics()` call is unaffected. This pins `return { ...aiMetrics }` as an explicit regression guard on the accessor contract.

#### Why

- `getAiMetrics()` returns `{ ...aiMetrics }` to prevent callers from directly mutating the internal counter state. The existing tests did not verify this isolation guarantee; without the test, a regression from `return { ...aiMetrics }` to `return aiMetrics` would be invisible to CI.
- All other Slice 10 requirements were verified in place: `SUMMARY_PROMPT_VERSION` propagated in both success and fallback `meta`, all four counter increments wired in the correct branches (`summarizationRequests` on every call; `providerErrors` + `summarizationFallbacks` on every error; `summarizationTimeouts` conditionally on timeout-message match), `GET /api/ai/metrics` endpoint returns `{ metrics: getAiMetrics() }`, and the `openai-compatible` provider path is activated when the model prefix is `openai:` and `TEMPO_OPENAI_API_KEY` is set.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 19 tests (8 model-router + 6 settings-schema + 5 route-level). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0. `node --check model-router.mjs` exits 0.
- Known gap: `summarizationFallbacks`, `providerErrors`, and `summarizationTimeouts` counter increments are not covered by tests. `CAPABILITY_DEFAULTS` is frozen at module load time; triggering the catch block requires either a mock injection seam or a separate test file run in a fresh process with `TEMPO_AI_SUMMARY_MODEL=openai:test` (no API key). Flagged as follow-up for the next hardening slice.
- Slice 10 is closed; AI router hardening (prompt versioning, provider-ready path, telemetry counters) is ready for any future slice that wires production provider credentials.

### 2026-04-23 - D-026 - Slice 9 audit pass: AI architecture verified, guardrail + fallback test coverage added

#### Context

Audit pass of Slice 9 (branch `audit/claude-rebuild-slice9`). In-scope files reviewed: `apps/api/src/ai/providers/mock-openai.mjs`, `apps/api/src/ai/providers/mock-anthropic.mjs`, `apps/api/src/ai/guardrails.mjs`, `apps/api/src/ai/model-router.mjs`, `apps/api/src/ai/model-router.test.mjs`, `apps/api/src/server.mjs`. Objective: introduce an MVP AI model architecture with capability routing and guardrailed summarization integrated into dashboard payload generation.

#### Decision

- No functional code changes required. All Slice 9 functional requirements were already present and correct.
- Added four tests to `[apps/api/src/ai/model-router.test.mjs](apps/api/src/ai/model-router.test.mjs)`:
  1. `summarizeCluster meta contains all expected fields on success path` — verifies every `meta` field is present and typed (capability, model, provider, elapsedMs, timedOut, fallbackUsed, promptTokens, outputTokens, costUsd, promptVersion) and that `timedOut` and `fallbackUsed` are false on the happy path.
  2. `withTimeout resolves when promise completes before deadline` — direct unit test of the `withTimeout` guardrail with a fast promise and long deadline.
  3. `withTimeout rejects with timeout message when deadline is exceeded` — direct unit test: a never-resolving promise + 10ms deadline → rejects with the exact error message `"AI summarization timed out"`. This pins the timeout mechanism and error message as an explicit assertion.
  4. `heuristicSummary returns non-empty string that includes cluster title` — verifies the fallback text generator returns a non-empty string and includes the cluster title, confirming the heuristic path is exercisable without provider dependency.

#### Why

- The timeout/fallback execution path is the critical reliability guarantee of Slice 9. The prior test suite only covered the happy path; any regression in `withTimeout` or `heuristicSummary` would have been invisible to CI.
- Testing `withTimeout` and `heuristicSummary` as direct unit tests (imported into `model-router.test.mjs`) avoids needing a mocking framework — both functions are pure enough to test in isolation with `node:test` alone.
- The complete meta-field assertion pins the cost-observability contract; if any field is dropped from `summarizeCluster`'s return shape, the test fails immediately.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 18 tests (7 model-router + 6 settings-schema + 5 route-level). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- The `withTimeout` deadline-exceeded test is the authoritative regression guard for the timeout guardrail; changing the timeout message or the error shape will fail it.
- Slice 9 is closed; AI architecture MVP (mock providers + capability routing + guardrailed summarization + cost metadata) is ready for Slice 10 (AI router hardening).

### 2026-04-23 - D-025 - Slice 8 audit pass: ingestion + ranking endpoint verified, dashboard route test added

#### Context

Audit pass of Slice 8 (branch `audit/claude-rebuild-slice8`). In-scope files reviewed: `apps/api/data/source-items.json`, `apps/api/src/server.mjs`, `04-prototype/src/lib/api.ts`, `04-prototype/vite.config.ts`. Objective: implement a local ingestion and ranking path for Dashboard payload generation, replacing static dashboard JSON reads.

#### Decision

- No functional code changes required. All Slice 8 functional requirements were already present and correct.
- Added one route-level test for `GET /api/dashboard` to `[apps/api/src/server.routes.test.mjs](apps/api/src/server.routes.test.mjs)`, per the D-017 pattern ("Any future route addition should include a corresponding entry in `server.routes.test.mjs`").
- Test seeds a minimal `source-items.json` fixture to the isolated `tmpDir` before server import; verifies HTTP 200, `contractVersion`, stories array length, `dashboardPayloadSchema` conformance, and `aiSummaryMeta` stripping (D-016).

#### Why

- D-017 established that route additions require route-level HTTP tests. The dashboard endpoint was added in Slice 8 but lacked HTTP-level verification. The functional implementation was correct; only the test gap needed closing.
- Without the test, a regression in dataset loading, filtering, clustering, or response-stripping logic would be invisible to the API test suite.

#### Consequences

- `cd 05-engineering/apps/api && npm test` now runs 14 tests (3 model-router + 6 settings-schema + 5 route-level). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- Slice 8 is closed; ingestion v0 + ranking endpoint is ready for Slice 9 (AI architecture summary).

### 2026-04-23 - D-024 - Slice 7 audit pass: auth baseline + guarded routes verified, no code changes required

#### Context

Audit pass of Slice 7 (branch `audit/claude-rebuild-slice7`). In-scope files reviewed: `04-prototype/src/lib/auth.tsx`, `04-prototype/src/components/ProtectedRoute.tsx`, `04-prototype/src/App.tsx`, `04-prototype/src/pages/Onboarding.tsx`, `04-prototype/src/components/AppHeader.tsx`. Objective: implement a minimal auth baseline that protects private routes while preserving the existing onboarding and app UI flow.

#### Decision

- No code changes required. All Slice 7 functional requirements were already present and correct.
- `AuthProvider` uses localStorage-backed session (`tempo.auth.session.v1`) with stable `useMemo` value to avoid unnecessary re-renders.
- `ProtectedRoute` redirects unauthenticated users to `/onboarding` with `state={{ from: location.pathname }}` preserved for future post-login redirect use.
- All private routes (`/dashboard`, `/settings`, `/archive`, `/archive/signal-radar`, `/archive/evidence-desk`, `/archive/analyst-briefing`) are wrapped in `ProtectedRoute`.
- `Onboarding` calls `login()` on valid submit and navigates to `/dashboard`; redirects authenticated users immediately with `<Navigate>`.
- `AppHeader` hides for `/`, `/onboarding`, and any unauthenticated state; shows logout button for authenticated sessions.
- All 9 prototype tests pass. `npm run build` exits 0. ESLint exits with warnings only (1 pre-existing `react-refresh/only-export-components` in `auth.tsx` — acceptable, documented in slice artifact).

#### Why

- The audit obligation is to verify correctness against the slice objective. Confirming a passing gate with no regressions is a valid and complete audit outcome.

#### Consequences

- `npm run build` exits 0.
- `cd 05-engineering && npm run test:prototype` exits 0 (9 tests: 6 api adapter + 2 settings-api + 1 example).
- `npx eslint src/App.tsx src/pages/Onboarding.tsx src/components/AppHeader.tsx src/components/ProtectedRoute.tsx src/lib/auth.tsx` exits with warnings only.
- Slice 7 is closed; auth baseline is ready for Slice 8 (ingestion pipeline v0 + ranking endpoint).

### 2026-04-23 - D-023 - Slice 6 audit pass: HTTP + local DB settings flow verified, no code changes required

#### Context

Audit pass of Slice 6 (branch `audit/claude-rebuild-slice6`). In-scope files reviewed: `apps/api/src/server.mjs`, `apps/api/data/settings.json`, `apps/api/package.json`, `05-engineering/package.json`, `04-prototype/vite.config.ts`, `04-prototype/src/lib/settings-api.ts`, `04-prototype/src/lib/settings-api.test.ts`. Objective: replace Settings adapter internals from browser-only localStorage to HTTP-first GET/PUT with localStorage fallback, backed by a local JSON file via the `@tempo/api` Express service.

#### Decision

- No code changes required. All Slice 6 functional requirements were already present and correct.
- All 13 `@tempo/api` tests pass (3 model-router, 4 route tests via supertest, 6 schema unit tests).
- All 9 prototype tests pass (2 settings-api + 6 api adapter + 1 example).
- ESLint on all four in-scope prototype files exits 0.
- `npm run build` exits 0.

#### Why

- `server.mjs` correctly exports `app`, guards `listen` behind direct-run check, and overrides `DATA_DIR` via `TEMPO_DATA_DIR` for test isolation.
- `settings-api.ts` implements HTTP-first with localStorage write-through on success and graceful fallback (mock latency + localStorage or default seed) on any fetch error.
- `vite.config.ts` proxies `/api/settings` and `/api/dashboard` to `http://localhost:8787`.
- `server.routes.test.mjs` exercises the full HTTP route surface (health, invalid→400, valid→200+schema, GET-after-PUT) using supertest with an isolated temp data dir.

#### Consequences

- `npm run build` exits 0.
- `cd 05-engineering/apps/api && npm test` exits 0 (13 tests).
- `cd 05-engineering && npm run test:prototype` exits 0 (9 tests).
- `npx eslint src/lib/settings-api.ts src/lib/settings-api.test.ts src/pages/Settings.tsx vite.config.ts` exits 0.
- Slice 6 is closed; the Settings HTTP/local-DB boundary is ready for Slice 7 (auth baseline + guarded routes).

### 2026-04-23 - D-022 - Slice 5 audit pass: settings persistence verified, one comment correction

#### Context

Audit pass of Slice 5 (branch `audit/claude-rebuild-slice5`). The three in-scope files — `src/lib/settings-api.ts`, `src/lib/settings-api.test.ts`, and `src/pages/Settings.tsx` — were reviewed against the Slice 5 objective (typed, persistent Settings read/write path). All functional requirements were already present: `settingsPayloadSchema` contract validation on both read and write paths, localStorage persistence with graceful fallback to defaults on empty or corrupt state, Settings page `useEffect` load-on-mount with cancellation guard, and `loading`/`saving` UI states. One minor documentation error was found: the JSDoc on `fetchSettingsPayload` referenced "Slice 4 adapter" instead of "Slice 5 adapter".

#### Decision

- Fix JSDoc comment in `settings-api.ts`: "Slice 4 adapter" → "Slice 5 adapter".
- No functional code changes required.

#### Why

- The incorrect slice reference in the comment would mislead future readers about when this module was introduced.
- All validation gates (build, test, lint) passed before and after the fix without any functional change.

#### Consequences

- `npm run build` exits 0.
- `npm run test:prototype` exits 0 (9 tests pass: 6 api adapter + 2 settings-api + 1 example).
- ESLint on the three in-scope files exits 0.
- Slice 5 is closed; the settings persistence boundary is ready for Slice 6 (HTTP/local DB swap).

### 2026-04-23 - D-021 - Slice 4 audit pass: lint baseline verified, no code changes required

#### Context

Audit pass of Slice 4 (branch `audit/claude-rebuild-slice4`). The four in-scope files — `src/components/ui/command.tsx`, `src/components/ui/textarea.tsx`, `src/pages/archive/EvidenceDesk.tsx`, and `tailwind.config.ts` — were reviewed against the Slice 4 objective (clear error-level ESLint failures). All fixes described in the original implementation summary were already present: `CommandDialogProps` and `TextareaProps` use type aliases (not empty interfaces), `Select` is a generic over `T extends string` eliminating `any` casts, and `tailwind.config.ts` uses an ESM `import` instead of `require()`.

#### Decision

- No code changes. Implementation matched the objective exactly.
- Run all required validation commands to confirm gate state before closing the slice.

#### Why

- The audit obligation is to verify correctness, not to add changes. Confirming a passing gate is a valid and complete audit outcome.

#### Consequences

- Targeted ESLint on the four slice files exits 0.
- `npm run lint` exits 0 with 8 warnings (Fast Refresh export warnings in unrelated scaffold files, pre-existing and out of scope).
- `npm run build` and `npm run test:prototype` both exit 0 (9 tests pass).
- Slice 4 is closed; lint can be relied on as a reliable error gate for future slices.

### 2026-04-23 - D-020 - Slice 3 rebuild pass: backoff duration assertions + zero-retry boundary test

#### Context

Audit pass of Slice 3 (branch `audit/claude-rebuild-slice3`). The `api.ts` implementation was already correct — HTTP fetch to `/api/dashboard`, `dashboardPayloadSchema` contract validation, AbortError-first guard in the catch block (corrected in D-019), and linear backoff with local fallback were all in place. Two narrow test gaps remained: (1) the retry test asserted `sleep` was called twice but did not assert the actual backoff duration arguments (200ms, 400ms), leaving the schedule itself unverified by the test suite; (2) there was no test for the `retries: 0` boundary — the path where the adapter falls back immediately on the first failure with no sleep call.

#### Decision

- Add `expect(sleep).toHaveBeenNthCalledWith(1, 200)` and `expect(sleep).toHaveBeenNthCalledWith(2, 400)` to the existing "retries and then falls back" test, making the linear backoff schedule an explicit assertion.
- Add a new `retries: 0` test: fetcher called once, sleep not called, payload returns with correct `contractVersion` and `stories.length`. This pins the loop's boundary termination behavior.
- No changes to `api.ts` — implementation was already correct.

#### Why

- Unasserted sleep arguments mean the test only verifies retry count, not the backoff amounts. A regression that doubled all delays (400ms, 800ms) would pass the prior test without detection.
- The zero-retry path is the worst-case first-failure scenario (one attempt, immediate fallback, no delay); verifying it confirms the loop boundary condition at `retries: 0`.

#### Consequences

- `test:prototype` now runs 9 tests (6 api adapter + 2 settings-api + 1 example). All pass.
- Backoff schedule (200ms, 400ms linear) is an explicit assertion; any change to `RETRY_BACKOFF_MS` or the multiplier formula will fail the test.
- ESLint on `api.ts`, `api.test.ts`, `Dashboard.tsx` exits 0.

### 2026-04-23 - D-019 - Slice 2 rebuild pass: AbortError ordering + cast removal + test coverage

#### Context

Audit pass of Slice 2 (branch `audit/claude-rebuild-s1-s10`) found three narrow gaps. (1) The `AbortError` guard in `fetchDashboardPayload` was placed after `await sleep()` and after the final-attempt fallback `return`, making it dead code on the last attempt and causing unnecessary backoff on earlier abort attempts. (2) Three `as` type casts in `dtoToStory` (for `Geography[]`, `Topic`, `SourceKind`) suppressed TypeScript checking at the DTO→UI boundary even though the contract types and local types are structurally identical. (3) `api.test.ts` had no coverage for non-2xx HTTP responses, contract validation failure, or AbortError propagation — the three most important failure modes of the adapter.

#### Decision

- Move `AbortError` guard to the first check in the `catch` block, before the sleep and before the final-attempt fallback. This ensures aborts propagate immediately with no retry delay on any attempt.
- Remove the three `as` casts in `dtoToStory` in `Dashboard.tsx`. `GeographyDto`, `TopicDto`, and `SourceKindDto` from `@tempo/contracts` are structurally identical string-literal unions to their counterparts in `stories.ts`; TypeScript verifies the boundary without a cast.
- Add three adapter tests to `api.test.ts`: (a) non-2xx HTTP → retries then falls back, (b) contract parse failure → retries then falls back, (c) AbortError → rethrows immediately, fetcher called once, sleep never called.
- Remove the stale "Slice 3 adapter" JSDoc comment that incorrectly attributed HTTP fetch behavior to Slice 3 only.

#### Why

- The inverted `AbortError` check was a silent correctness bug: any abort that hit the retry limit would be swallowed and return stale fallback data instead of surfacing the abort signal to the caller.
- Unchecked `as` casts hide future type drift; if either `stories.ts` or `@tempo/contracts` ever diverges, the compiler would not flag `dtoToStory` as broken.
- The three missing test scenarios cover the adapter's most important non-happy-path behaviors; without them a regression in any of those paths would be invisible to CI.

#### Consequences

- `test:prototype` now runs 8 tests (was 5): 5 adapter tests + 2 settings-api tests + 1 example.
- `build`, `test:prototype`, and `lint:prototype:slice` all pass (exit 0).
- AbortError now propagates to the caller on every attempt, not just non-final ones; callers may handle it if needed (current Dashboard `useEffect` cleanup does not explicitly catch AbortError, which is acceptable since the component unmounts the effect on cancel).

### 2026-04-22 - D-018 - Slice 1 rebuild pass 2: url constraint + StoryPriorityDto + test coverage gaps

#### Context

Second audit pass of Slice 1 (branch `audit/claude-rebuild-s1-s10`, after D-015). Found four narrow gaps not caught in the first pass: `sourceSchema.url` accepted empty string; `StoryPriorityDto` type was the only enum without a DTO alias; `buildSourceOpenError` had no dedicated describe block; contracts rejection tests covered only `storySchema`, leaving `dashboardPayloadSchema` and `settingsPayloadSchema` untested for invalid input.

#### Decision

- Add `.min(1)` to `sourceSchema.url` — empty string is not a valid source URL.
- Add `StoryPriorityDto = z.infer<typeof storyPrioritySchema>` and re-export from `index.ts` — consistent with all other enum type aliases.
- Add `describe("buildSourceOpenError")` with happy-path and empty-message rejection tests — brings all four event builders to parity.
- Add rejection tests for `dashboardPayloadSchema` (wrong version) and `settingsPayloadSchema` (missing required field), and an explicit `sourceSchema` describe block (empty url rejection).
- Refactor test fixtures to shared `minimalSource` / `minimalStory` constants to eliminate repetition.

#### Why

- An empty `url` on a source would silently pass contract validation and produce a broken link in the UI. The `.min(1)` guard catches it at the API boundary.
- Missing DTO type alias is an API inconsistency; any consumer needing to type a priority variable would reach for the raw enum string instead of the canonical alias.
- Uncovered event builder paths reduce confidence that builders enforce their own invariants; adding the describe block closes the gap.

#### Consequences

- `test:packages` now runs 8 contracts tests + 11 analytics tests (was 4 + 9).
- `build:packages`, `build`, and `lint:prototype:slice` all still pass (exit 0).
- `StoryPriorityDto` is now a public export of `@tempo/contracts`; consumers can import the type directly.

### 2026-04-22 - D-017 - Follow-up: route-level test coverage for PUT /api/settings

#### Context

D-016 added `settingsPayloadSchema.safeParse()` to `PUT /api/settings` and accompanying schema-only unit tests. A follow-up review (Codex) identified that those tests validate the Zod schema directly but do not exercise actual HTTP route behavior — a handler bug, wrong status code, or missing `express.json()` middleware would go undetected.

#### Decision

- Refactor `[apps/api/src/server.mjs](apps/api/src/server.mjs)` for testability:
  - `DATA_DIR` is now overridable via `TEMPO_DATA_DIR` env var so tests can target an isolated temp directory.
  - `app` is exported; `app.listen()` is guarded behind a direct-run check (`process.argv[1] === __filename`) so importing the module in tests does not start a real server.
- Add `supertest` as a dev dependency to `[apps/api/package.json](apps/api/package.json)`.
- Add `[apps/api/src/server.routes.test.mjs](apps/api/src/server.routes.test.mjs)` with four route-level tests:
  1. `GET /health` sanity check.
  2. `PUT /api/settings` with invalid payload → HTTP 400 + `{message, errors}` shape.
  3. `PUT /api/settings` with valid payload → HTTP 200, response validates against `settingsPayloadSchema`.
  4. `GET /api/settings` after valid PUT → persisted data returned.
- Each test run writes to a fresh `mkdtemp` directory and deletes it in an `after()` hook; no shared state with the production `data/` directory.

#### Why

- Schema-only tests prove the Zod schema works, not that the route wires it correctly.
- Route-level tests catch handler bugs, wrong status codes, and middleware gaps that schema tests miss.
- `TEMPO_DATA_DIR` override is the minimal seam needed; no interface changes, no mocking.

#### Consequences

- `test:api` now runs 13 tests (3 model-router + 6 settings-schema + 4 route-level).
- `server.mjs` runtime behavior for `npm run dev` / `npm start` is unchanged.
- Any future route addition should include a corresponding entry in `server.routes.test.mjs`.

### 2026-04-22 - D-016 - Codex reviewer fix pass: settings validation, contract drift, unsafe cast

#### Context

Codex review of branch `audit/claude-rebuild-s1-s10` found four issues: unvalidated settings writes (HIGH), `aiSummaryMeta` returned in API payload but absent from dashboard contract (MEDIUM), unsafe `as Story[]` cast in Dashboard (MEDIUM), and localStorage auth with no documented risk (LOW).

#### Decision

- **Settings validation (HIGH):** Add `settingsPayloadSchema.safeParse(req.body)` guard to `PUT /api/settings` in `[apps/api/src/server.mjs](apps/api/src/server.mjs)`. Return HTTP 400 with Zod error detail on invalid payload; only call `writeSettings` on validated data. Add `@tempo/contracts` as a workspace dependency to `@tempo/api` so the server can use the canonical schema without duplicating it.
- **Contract drift (MEDIUM):** Choose Option B — strip `aiSummaryMeta` from stories before sending the dashboard HTTP response. The field is internal AI telemetry used for cost logging; it does not belong in the public contract. API response now conforms exactly to `dashboardPayloadSchema`. No schema change required.
- **Unsafe cast (MEDIUM):** Replace `payload.stories as Story[]` with an explicit `dtoToStory(dto: StoryDto): Story` mapper in `[04-prototype/src/pages/Dashboard.tsx](../04-prototype/src/pages/Dashboard.tsx)`. The mapper does a full property-by-property construction, making the DTO→UI type boundary explicit and type-safe.
- **Auth risk (LOW, documented here):** The current auth baseline (D-011) uses `sessionStorage` on the client with no server-side session validation. Any user can access guarded routes by writing a valid session key. This is acceptable for the current prototype stage but must be replaced before any production or shared-access deployment. Next auth slice should introduce server-side session tokens or an identity provider.

#### Why

- Unvalidated writes allow arbitrary JSON to overwrite the settings file, breaking all downstream filtering without any error signal.
- Returning undocumented fields in the API payload creates silent client-side schema divergence that is hard to diagnose.
- The `as Story[]` cast masked a real type boundary; the explicit mapper surfaces it.
- Auth risk documentation prevents the "good enough for now" pattern from going unnoticed at handoff.

#### Consequences

- `PUT /api/settings` now returns 400 on invalid payload; callers must send a conformant `SettingsPayload`.
- `GET /api/dashboard` response stories no longer include `aiSummaryMeta`; cost telemetry is server-side only.
- `dtoToStory` is the single mapping point between the contracts DTO and the prototype UI type; update it if either type changes.
- `test:api` now runs 9 tests (3 model-router + 6 settings-validation).
- Auth risk is documented; current localStorage/sessionStorage pattern is baseline-only and must not be carried to production.

### 2026-04-22 - D-015 - Slice 1 audit rebuild: emit signature + test coverage + lint script

#### Context

- Slice 1 review (branch `audit/claude-rebuild-s1-s10`) identified three issues: `emitAnalyticsEvent` double-validated events already built by typed builders (unnecessary overhead, looser types); `buildStoryExpanded` / `buildSourceOpened` / `setAnalyticsSink` had no test coverage; `lint:prototype:slice` npm script was broken (ESLint ran in wrong CWD, always exited 2).

#### Decision

- Change `emitAnalyticsEvent` signature from `(raw: unknown)` to `(event: AnalyticsEvent)` and remove the internal `analyticsEventSchema.parse()` re-parse. Callers needing to validate untrusted input must call `analyticsEventSchema.parse()` explicitly before emit.
- Expand `packages/analytics/src/events.test.ts` from 3 → 9 tests: add coverage for `buildStoryExpanded`, `buildSourceOpened`, invalid-input rejections, and `setAnalyticsSink` custom-sink routing + null-restore.
- Add one negative rejection test to `packages/contracts/src/schemas.test.ts` (missing required fields).
- Fix `lint:prototype:slice` script: replace broken `npm --prefix exec` form with `sh -c 'cd ../04-prototype && npx eslint …'`.

#### Why

- Double-validation was silent overhead on every user action; removing it makes the type boundary explicit (builders own validation, emit owns dispatch).
- Uncovered code paths reduce confidence in the analytics tier model; every event builder and the sink switch now have a test.
- A broken lint gate is as bad as no lint gate — the script now actually verifies the slice files.

#### Consequences

- `emitAnalyticsEvent` is now a typed dispatch function, not a parse-and-dispatch function. Any caller using it with a raw `unknown` payload must add an explicit `analyticsEventSchema.parse()` step.
- `test:packages` now runs 9 analytics tests + 4 contracts tests (was 3 + 3).
- `lint:prototype:slice` exits 0 cleanly.

### 2026-04-22 - D-014 - AI router hardening: prompt versioning + telemetry

#### Context

- AI summarization architecture existed with mock providers and fallback, but lacked explicit prompt version controls and aggregated failure telemetry.

#### Decision

- Add prompt builder/version module `[apps/api/src/ai/prompts.mjs](apps/api/src/ai/prompts.mjs)` with `summary-v1`.
- Add OpenAI-compatible provider path `[apps/api/src/ai/providers/openai-compatible.mjs](apps/api/src/ai/providers/openai-compatible.mjs)` enabled when `TEMPO_OPENAI_API_KEY` is present and summarization model is `openai:<model>`.
- Extend router `[apps/api/src/ai/model-router.mjs](apps/api/src/ai/model-router.mjs)` with in-memory metrics:
  - `summarizationRequests`
  - `summarizationFallbacks`
  - `summarizationTimeouts`
  - `providerErrors`
- Expose telemetry endpoint `GET /api/ai/metrics`.

#### Why

- Preserves pluggability while adding operator visibility and safer rollout controls.
- Enables versioned prompt iteration without implicit behavior drift.

#### Consequences

- API now reports capability map and runtime AI metrics separately.
- Next step can add persistent telemetry sink and production provider credentials flow.

### 2026-04-22 - D-013 - AI capability map + guardrailed summarization

#### Context

- Ingestion/ranking endpoint existed but summary generation remained static text.
- MVP required early AI model architecture with capability mapping and reliability/cost guardrails.

#### Decision

- Add capability-to-model router in `[apps/api/src/ai/model-router.mjs](apps/api/src/ai/model-router.mjs)`:
  - summarization -> `mock-openai-mini`
  - classification -> `mock-anthropic-haiku`
  - safety -> `mock-openai-mini`
- Add mock provider implementations and guardrails:
  - timeout wrapper
  - heuristic fallback summary
  - per-request cost estimate metadata
- Enrich `GET /api/dashboard` to run AI summarization per ranked cluster and expose model map via `GET /api/ai/models`.

#### Why

- Establishes pluggable model architecture now, before vendor/API lock-in.
- Adds baseline reliability and cost observability for AI features in MVP flow.

#### Consequences

- Dashboard summaries are now generated by the AI router layer (with fallback).
- Next roadmap step can focus on production provider wiring and additional AI capabilities.

### 2026-04-22 - D-012 - Ingestion v0 + ranking endpoint for dashboard

#### Context

- Roadmap required a first ingestion/ranking slice after auth baseline.
- Dashboard adapter already supported HTTP with retry/backoff but used static payload files.

#### Decision

- Add source-item ingestion input at `[apps/api/data/source-items.json](apps/api/data/source-items.json)`.
- Add `GET /api/dashboard` in `[apps/api/src/server.mjs](apps/api/src/server.mjs)`:
  - filters source items by settings scope
  - clusters by `clusterId`
  - computes ranked stories (weight+freshness heuristic)
  - returns contract-shaped dashboard payload
- Update frontend adapter endpoint to `/api/dashboard` and add Vite proxy route.

#### Why

- Creates an end-to-end v0 ingestion path with ranking behavior and contract output.
- Keeps implementation local and reversible while progressing roadmap sequence.

#### Consequences

- Dashboard payload now comes from ingestion+ranking logic rather than static dashboard JSON.
- Next roadmap slice remains AI summarization guardrailed path.

### 2026-04-22 - D-011 - Auth baseline with guarded routes

#### Context

- Roadmap next slice after settings HTTP/local DB was auth baseline + guarded routes.
- App previously allowed direct access to dashboard/settings/archive routes without session checks.

#### Decision

- Add client auth baseline in `[04-prototype/src/lib/auth.tsx](../04-prototype/src/lib/auth.tsx)` using local session storage.
- Add route guard component `[04-prototype/src/components/ProtectedRoute.tsx](../04-prototype/src/components/ProtectedRoute.tsx)`.
- Wrap private routes (`/dashboard`, `/settings`, `/archive/*`) in `ProtectedRoute`.
- Update onboarding to establish session on submit and redirect authenticated users to `/dashboard`.
- Add header logout action and hide app chrome when unauthenticated.

#### Why

- Establishes the minimal auth contract needed before deeper backend/user identity work.
- Protects private surfaces while keeping the implementation bounded and reversible.

#### Consequences

- Unauthenticated users are redirected to onboarding for private routes.
- Auth state remains local/session-like for now; next steps can replace internals with server-backed auth.

### 2026-04-22 - D-010 - Settings adapter switched to HTTP local DB

#### Context

- Settings were persisted only in browser `localStorage`, which limited continuity and API realism.
- The roadmap required moving toward production-style boundaries without full backend rollout.

#### Decision

- Add local API service `[05-engineering/apps/api](apps/api)` with `GET/PUT /api/settings` backed by a local JSON DB file.
- Update `[04-prototype/src/lib/settings-api.ts](../04-prototype/src/lib/settings-api.ts)` to use HTTP as the primary read/write path.
- Keep `localStorage` as resilience fallback (offline or API failure) to preserve current UX.
- Update dev orchestration so `cd 05-engineering && npm run dev` runs both API and web.

#### Why

- Introduces production-like transport and persistence boundaries now, while keeping slice scope small.
- Preserves user-facing behavior and adds safer fallback semantics.

#### Consequences

- Settings now persist through a local HTTP API + DB file by default.
- Original roadmap is now back on track; next planned slice is **Auth baseline + guarded routes**.

### 2026-04-22 - D-009 - Settings persistence via typed storage adapter

#### Context

- Dashboard already moved behind typed read adapters.
- Settings still used in-memory defaults per render without persistence boundary.

#### Decision

- Add `fetchSettingsPayload()` and `saveSettingsPayload()` in `[04-prototype/src/lib/settings-api.ts](../04-prototype/src/lib/settings-api.ts)`.
- Validate payloads with `settingsPayloadSchema` and `CONTRACT_VERSION`.
- Persist settings to `localStorage` under `tempo.settings.v1` with safe fallback to defaults.
- Wire `[04-prototype/src/pages/Settings.tsx](../04-prototype/src/pages/Settings.tsx)` to load on mount and save through the adapter.

#### Why

- Establishes a swap-ready API boundary while preserving existing Settings UX.
- Gives users durable settings behavior now, without backend dependency.

#### Consequences

- Settings survive page reloads.
- Next slice can replace localStorage internals with HTTP/local DB while reusing page-level logic.

### 2026-04-22 - D-008 - Lint baseline cleanup (error-level)

#### Context

- Full prototype lint failed with 5 error-level issues carried from generated scaffold files.
- These failures created noise and reduced confidence in slice-level lint gates.

#### Decision

- Fix only error-level lint violations in:
  - `[src/components/ui/command.tsx](../04-prototype/src/components/ui/command.tsx)`
  - `[src/components/ui/textarea.tsx](../04-prototype/src/components/ui/textarea.tsx)`
  - `[src/pages/archive/EvidenceDesk.tsx](../04-prototype/src/pages/archive/EvidenceDesk.tsx)`
  - `[tailwind.config.ts](../04-prototype/tailwind.config.ts)`
- Leave existing `react-refresh/only-export-components` warnings unchanged for a future optional cleanup.

#### Why

- Restores a clean error baseline without broad UI refactors.
- Keeps this quality slice small and reversible while unblocking future strict lint checks.

#### Consequences

- `npm run lint` now exits successfully (warnings only).
- Future slices can treat lint failures as new regressions rather than inherited debt.

### 2026-04-22 - D-007 - Slice 3 HTTP adapter with retry/backoff

#### Context

- Slice 2 introduced a typed dashboard adapter but still sourced data directly from in-memory constants.
- Next step required a real HTTP-style read path and retry policy without introducing backend infrastructure yet.

#### Decision

- Update `[04-prototype/src/lib/api.ts](../04-prototype/src/lib/api.ts)` to fetch from `[04-prototype/public/api/dashboard.json](../04-prototype/public/api/dashboard.json)`.
- Validate the fetched payload against `dashboardPayloadSchema`.
- Add bounded retry/backoff (2 retries, linear 200ms step) and fallback to local in-memory payload when retries are exhausted.
- Add adapter tests for HTTP success and retry/fallback behavior.

#### Why

- Keeps the slice narrow while moving the dashboard to a production-like network boundary.
- Improves resilience and observability before introducing a full backend service.

#### Consequences

- Dashboard can now run against static API-like payloads and later swap to a real endpoint with minimal UI changes.
- Temporary static payload currently includes two stories; fallback path still retains full local dataset.

### 2026-04-22 - D-006 - Slice 2 dashboard read path via typed API adapter

#### Context

- Slice 1 established shared contracts and analytics package boundaries.
- Dashboard still read directly from `STORIES` without a typed data-access boundary.

#### Decision

- Add `fetchDashboardPayload()` in `[04-prototype/src/lib/api.ts](../04-prototype/src/lib/api.ts)` as the dashboard read adapter.
- Validate payloads at runtime using `@tempo/contracts` (`dashboardPayloadSchema` + `CONTRACT_VERSION`).
- Keep dashboard UI and interaction behavior unchanged; show subtle loading and fallback copy during refresh.
- Emit guardrail analytics on fetch failure via `trackSourceOpenError`.

#### Why

- Creates a stable seam for a future real API without coupling UI components to transport details.
- Keeps this slice bounded to one flow (Dashboard read path) while improving correctness and observability.

#### Consequences

- Dashboard state now hydrates from the adapter, not only module-local constants.
- Next slice can swap adapter internals from in-memory mock to HTTP without redesigning the screen.

### 2026-04-22 - D-005 - Engineering decisions log location

#### Context

- Root `DECISIONS.md` previously held only engineering entries, while research decisions live under `[01-research/ops](../01-research/ops)`.

#### Decision

- Canonical engineering log is this file: `[DECISIONS.md](DECISIONS.md)`.
- Remove root-level `DECISIONS.md` to avoid duplicate navigation points.

#### Why

- Matches the split between research Markdown and engineering execution.

#### Consequences

- Log new engineering decisions here; prepend new blocks at the top.
- Any historical references to root `DECISIONS.md` are superseded by this location.

### 2026-04-22 - D-004 - Engineering npm workspace under `05-engineering/`

#### Context

- Slice 1 added `package.json`, `apps/web`, and `packages/`* at the repository root, which mixed engineering tooling with the top-level repo layout.

#### Decision

- Move the Node workspace (`package.json`, `package-lock.json`, `apps/`, `packages/`) into this folder (`[package.json](package.json)`).
- Keep `[04-prototype](../04-prototype)` as the UI package; link `@tempo/`* with `file:../05-engineering/packages/...`.
- Run install/dev/build scripts from here (see `[README.md](README.md)`).

#### Why

- Matches the information hierarchy: all engineering-specific tooling and shared packages live next to other engineering artifacts.
- Prototype folder stays a clean Lovable reference without owning the monorepo root.

#### Consequences

- No `package.json` at repo root; onboarding starts at `[README.md](../README.md)` → `cd 05-engineering && npm install`.
- Historical docs that said “repo root” for npm mean `05-engineering/` from D-004 onward.

### 2026-04-22 - D-003 - Mode 2 slice 1: monorepo + contracts + analytics

#### Context

- Mode 1 kickoff approved; first vertical slice is platform skeleton, typed contracts, and analytics event schema without backend/auth/DB.

#### Decision

- ~~Add root `package.json` npm workspaces linking `04-prototype`, `apps/web`, `packages/contracts`, and `packages/analytics`.~~ **Update (D-004):** workspace lives under `[package.json](package.json)` (no `04-prototype` workspace member; prototype installs separately).
- Use `@tempo/contracts` (Zod + versioned dashboard/settings payloads) and `@tempo/analytics` (primary/secondary/guardrail events + validated emit).
- Keep the Lovable UI in `[04-prototype](../04-prototype)`; `[apps/web](apps/web)` is a typed placeholder until migration.
- Link `@tempo/`* from the prototype with `file:../05-engineering/packages/...` (avoids `workspace:`* on older npm).

#### Why

- Establishes shared contracts and analytics before API and ingestion work.
- Preserves the dashboard UX while wiring real event validation and a replaceable sink.

#### Consequences

- ~~From repo root: `npm run build:packages` before `npm run dev` (root script runs both).~~ **Update (D-004):** run those scripts from `[05-engineering/README.md](README.md)`.
- Full-repo `npm run lint` in the prototype still reports pre-existing UI issues; slice hygiene uses targeted lint on changed files until a follow-up cleanup slice.

### 2026-04-22 - D-002 - Separate Prototype and Engineering Artifacts

#### Context

- `[04-prototype](../04-prototype)` contains the Lovable-built reference implementation and related prototype assets.
- Mode 1 kickoff output is an engineering execution artifact used to run rebuild slices and quality gates.

#### Decision

- Keep prototype assets in `[04-prototype](../04-prototype)` only.
- Store engineering execution artifacts here, starting with `[MODE1-KICKOFF.md](MODE1-KICKOFF.md)`.

#### Why

- Preserves a clean boundary between reference prototype work and implementation execution work.
- Reduces accidental coupling or edits to prototype-origin files during engineering phases.
- Makes execution history easier to navigate as more artifacts are added.

#### Consequences

- Future mode outputs, slice briefs, gate checklists, and engineering runbooks go under `05-engineering`.
- `[04-prototype](../04-prototype)` remains the frozen reference baseline unless explicitly updated as prototype work.

### 2026-04-22 - D-001 - Use Skill A as Orchestrator

#### Context

- The current implementation target is the Lovable prototype in `[04-prototype](../04-prototype)`.
- Execution model is locked: `engineer-intake-rebuild` in Mode 1 first, then Mode 2 only after explicit approval.

#### Decision

- Adopt `engineer-intake-rebuild` as the project orchestrator for all execution phases.
- Keep this run in Mode 1 and produce a bounded first-slice recommendation before any build work.

#### Why

- The prototype is UI-heavy and production architecture is not yet present (backend/auth/persistence/CI gates).
- Mode 1 reduces architecture and delivery risk before coding.
- The specialist skill routing is already defined and can be applied per slice.

#### Consequences

- No broad rewrites or multi-slice implementation starts until the first Mode 2 slice is approved.
- Every major tradeoff or scope shift is recorded here before execution.