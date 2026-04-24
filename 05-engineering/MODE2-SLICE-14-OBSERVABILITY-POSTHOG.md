# Slice 14 — Observability + PostHog Analytics Wiring

**Branch:** `build/slice14-observability-posthog`
**Status:** Complete
**Decision:** D-032

---

## What was built

A fail-safe, two-layer PostHog integration:


| Layer                                       | Where                  | Key file                       |
| ------------------------------------------- | ---------------------- | ------------------------------ |
| Shared event schemas + PostHog sink factory | `packages/analytics`   | `posthog-sink.ts`, `events.ts` |
| Server-side telemetry (API)                 | `apps/api/src`         | `telemetry.mjs`                |
| Frontend PostHog init helper                | `04-prototype/src/lib` | `analytics.ts`                 |


---

## What is tracked

### Server-side events (`apps/api`)


| Event                     | Tier      | When                                       | Key properties                                                                             |
| ------------------------- | --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `api_dashboard_requested` | primary   | Successful `GET /api/dashboard`            | `storyCount`, `normErrorCount`, `limitApplied`, `fallbackCount`, `totalCostUsd`, `aiModel` |
| `settings_updated`        | secondary | Successful `PUT /api/settings`             | `topicCount`, `geoCount`, `sourceCount`                                                    |
| `api_error`               | guardrail | 500 on `/api/dashboard` or `/api/settings` | `route`, `statusCode`, `message`                                                           |


### Frontend events (`04-prototype`) — unchanged from prior slices


| Event               | Tier      | Triggered by          |
| ------------------- | --------- | --------------------- |
| `dashboard_viewed`  | primary   | Dashboard page load   |
| `story_expanded`    | secondary | Story card expand     |
| `source_opened`     | secondary | Opening a source link |
| `source_open_error` | guardrail | Source open failure   |


All events include `tier` and `$lib` as PostHog properties for easy filtering.

---

## Env setup

### API server (`apps/api/.env`)

```dotenv
# PostHog server-side key (sk-phc-... format).
# Leave empty (default) to disable server analytics — no crash, events dropped.
POSTHOG_API_KEY=phc-your-key-here

# Override ingest host (optional). EU cloud: https://eu.i.posthog.com
# POSTHOG_HOST=https://us.i.posthog.com
```

### Frontend (`04-prototype/.env.local`)

```dotenv
VITE_POSTHOG_API_KEY=phc-your-key-here
# VITE_POSTHOG_HOST=https://us.i.posthog.com
```

Then wire the init in `04-prototype/src/main.tsx` (one line, not done in this slice):

```tsx
import { initPostHog } from "@/lib/analytics";
initPostHog();
```

---

## How to validate tracking locally

### Server-side (API)

1. Set `POSTHOG_API_KEY=phc-test` and run `npm run dev:api`.
2. Hit `GET http://localhost:8787/api/dashboard`.
3. Check PostHog → **Live Events** — you should see `api_dashboard_requested`.
4. To verify without real credentials: run `npm run test:api` — the `telemetry.test.mjs` suite mocks `globalThis.fetch` and asserts correct payload shape.

**Dry-run (no PostHog account needed):**

```bash
# Start a local netcat listener
nc -l 8765 &

# Point the API at it (port, not a real PostHog host)
POSTHOG_API_KEY=phc-test POSTHOG_HOST=http://localhost:8765 node src/server.mjs
```

Hit the dashboard endpoint and watch the raw HTTP POST appear in the netcat output.

### Frontend

1. Add `VITE_POSTHOG_API_KEY` to `.env.local` and call `initPostHog()` from `main.tsx`.
2. Open the dashboard — PostHog **Live Events** shows `dashboard_viewed`.
3. Expand a story → `story_expanded` appears.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  packages/analytics                                  │
│                                                      │
│  events.ts        ← canonical Zod schemas for all   │
│                     frontend + server events         │
│                                                      │
│  sink.ts          ← setAnalyticsSink / emit (frontend│
│                     side state)                      │
│                                                      │
│  posthog-sink.ts  ← createPostHogSink(options)       │
│                     fetch-based, no-SDK, fire-forget │
└───────────────┬─────────────────────────────────────┘
                │ dist/ (compiled)
       ┌────────┴──────────┐
       │                   │
04-prototype          apps/api
analytics.ts          telemetry.mjs
initPostHog() ─┐      trackServerEvent() ─┐
               │                          │
          setAnalyticsSink          fetch (inline)
          (createPostHogSink)        → POSTHOG_HOST/capture/
               │
          fetch → POSTHOG_HOST/capture/
```

Both layers use raw `fetch` against PostHog's HTTP capture API — no PostHog SDK dependency. Frontend events are emitted through the existing `emitAnalyticsEvent` / `setAnalyticsSink` abstraction. Server events are fire-and-forget with their own simple module.

---

## Privacy / safety notes

- **No PII captured.** No user names, emails, article content, or identifiers are sent to PostHog. All properties are operational (counts, model names, durations, costs).
- **Session IDs are ephemeral.** The frontend `distinctId` is generated fresh per session and stored only in `sessionStorage` (cleared on tab close). No persistent fingerprinting.
- **Server events use a static ID.** `tempo-api-server` is the server-side `distinct_id`. There is no user attribution at the API layer — appropriate for a single-operator tool.
- **Fail-safe.** All PostHog calls are fire-and-forget. Fetch failures are swallowed. Missing `POSTHOG_API_KEY` → zero network calls, zero crashes.
- **EU data residency.** Set `POSTHOG_HOST=https://eu.i.posthog.com` (and `VITE_POSTHOG_HOST=https://eu.i.posthog.com`) to route all telemetry through PostHog's EU cloud if required.

---

## Files changed


| File                                                     | Change                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/analytics/src/events.ts`                       | +3 server-side event schemas + builders; added to discriminated union |
| `packages/analytics/src/posthog-sink.ts`                 | **new** — fetch-based PostHog sink factory                            |
| `packages/analytics/src/posthog-sink.test.ts`            | **new** — 7 tests                                                     |
| `packages/analytics/src/index.ts`                        | export posthog-sink + new event builders/schemas                      |
| `packages/analytics/tsconfig.json`                       | +`"types": ["node"]` for fetch type coverage                          |
| `packages/analytics/tsconfig.build.json`                 | +`posthog-sink.ts` in includes                                        |
| `apps/api/src/telemetry.mjs`                             | **new** — server-side PostHog integration                             |
| `apps/api/src/telemetry.test.mjs`                        | **new** — 4 tests                                                     |
| `apps/api/src/server.mjs`                                | import telemetry; wire 3 event call sites                             |
| `apps/api/package.json`                                  | +`telemetry.test.mjs` in test script                                  |
| `apps/api/.env.example`                                  | +PostHog env var documentation                                        |
| `04-prototype/src/lib/analytics.ts`                      | +`initPostHog()` export                                               |
| `05-engineering/DECISIONS.md`                            | +D-032 (prepended)                                                    |
| `05-engineering/MODE2-SLICE-14-OBSERVABILITY-POSTHOG.md` | **new** (this file)                                                   |


---

## Test results (as shipped)

```
npm run test:api       → 51 tests, 0 failures  (+4 from telemetry.test.mjs)
npm run test:packages  → 18 tests, 0 failures  (+7 from posthog-sink.test.ts)
npm run test:prototype →  9 tests, 0 failures  (no change)
npm run build          → exits 0
npx eslint (prototype) → exits 0
node --check server.mjs → exits 0
```

