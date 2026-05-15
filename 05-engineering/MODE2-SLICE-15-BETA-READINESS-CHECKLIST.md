# Slice 15 — Beta Readiness Checklist

**Branch:** `build/slice14-observability-posthog`
**Status:** Complete
**Decision:** D-033

---

## 1. Required env vars

### API server (`apps/api/.env`)


| Variable                    | Required    | Default / Notes                                                                  |
| --------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `TEMPO_API_PORT`            | No          | `8787` — port the API listens on                                                 |
| `TEMPO_DATA_DIR`            | No          | `./data` — override for test isolation                                           |
| `SUPABASE_URL`              | Conditional | Required if using Supabase for settings persistence; omit for file-based storage |
| `SUPABASE_SERVICE_ROLE_KEY` | Conditional | Required when `SUPABASE_URL` is set; bypasses RLS                                |
| `SUPABASE_ANON_KEY`         | Conditional | Alternative to service-role key (respects RLS)                                   |
| `TEMPO_AI_SUMMARY_MODEL`    | No          | `mock-openai-mini` — use `anthropic:<model>` for real AI                         |
| `TEMPO_AI_CLASSIFIER_MODEL` | No          | `mock-anthropic-haiku`                                                           |
| `TEMPO_AI_SAFETY_MODEL`     | No          | `mock-openai-mini`                                                               |
| `TEMPO_AI_TIMEOUT_MS`       | No          | `1200` — milliseconds before AI falls back to heuristic                          |
| `TEMPO_AI_MOCK_ONLY`        | No          | Unset — set to `true` to force all requests through mock providers               |
| `TEMPO_ANTHROPIC_API_KEY`   | Conditional | Required when `TEMPO_AI_SUMMARY_MODEL=anthropic:<model>`                         |
| `ANTHROPIC_API_KEY`         | Conditional | SDK default fallback if `TEMPO_ANTHROPIC_API_KEY` is unset                       |
| `TEMPO_OPENAI_API_KEY`      | Conditional | Required when using `openai:<model>` prefix                                      |
| `TEMPO_OPENAI_BASE_URL`     | No          | `https://api.openai.com/v1`                                                      |
| `POSTHOG_API_KEY`           | No          | Unset — omit to disable analytics entirely; no crash                             |
| `POSTHOG_HOST`              | No          | Defaults to US cloud; set `https://eu.i.posthog.com` for EU                      |


### Frontend (`04-prototype/.env.local`)


| Variable               | Required | Default / Notes                                      |
| ---------------------- | -------- | ---------------------------------------------------- |
| `VITE_POSTHOG_API_KEY` | No       | Unset — omit to disable frontend analytics; no crash |
| `VITE_POSTHOG_HOST`    | No       | Defaults to US cloud when unset                      |


**Minimum beta config (no real AI, no Supabase, no analytics):** no `.env` file needed — all defaults are safe.

---

## 2. Local startup steps

```bash
# 1. Install dependencies (run once, or after any package change)
cd 05-engineering
npm install

# 2. Build shared packages (required before dev or production build)
npm run build:packages

# 3. Start both API and prototype in one terminal
npm run dev
#   API → http://localhost:8787
#   Web → http://localhost:5173

# --- OR start each layer separately ---

# API only
npm run dev:api

# Prototype only (separate terminal)
cd 04-prototype
npm run dev
```

**With real AI (optional):**

```bash
# apps/api/.env
TEMPO_AI_SUMMARY_MODEL=anthropic:claude-haiku-4-5
TEMPO_ANTHROPIC_API_KEY=sk-ant-your-key
```

### Dashboard story pool — DC prototype (local)

Use when hand-testing the **hourly refresh / story pool** with real models ([pool spec](docs/dashboard-story-pool-spec.md), Chunk **N2**). Do **not** set `TEMPO_AI_MOCK_ONLY=true` on this path.

**Key handling policy (required):**

- Document only env **variable names** in Markdown; never paste real key values.
- Store real secrets only in local env or an approved secret manager.
- Required vars for real-model story-pool validation: `TEMPO_ANTHROPIC_API_KEY` and `TEMPO_OPENAI_API_KEY`.
- Supported provider aliases (runtime fallback): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
- Set `TEMPO_AI_MOCK_ONLY=false` (or leave unset) for real-model validation runs.

```bash
# apps/api/.env — Anthropic (onboarding, clustering, geo when wired)
TEMPO_ANTHROPIC_API_KEY=sk-ant-your-key
TEMPO_AI_CLASSIFIER_MODEL=anthropic:claude-opus-4-7
TEMPO_AI_CLASSIFIER_FALLBACK_MODEL=anthropic:claude-sonnet-4-6
TEMPO_AI_CLUSTER_MODEL=anthropic:claude-sonnet-4-6
TEMPO_AI_GEO_ASSESS_MODEL=anthropic:claude-haiku-4-5-20251001

# OpenAI — embedding recall only
TEMPO_OPENAI_API_KEY=sk-your-openai-key
TEMPO_OPENAI_EMBEDDING_MODEL=text-embedding-3-small
TEMPO_RECALL_MODE=hybrid_strict
TEMPO_EMBED_TOP_K=80
TEMPO_EMBED_MAX_ITEMS=250
```

**Smoke (models operational):**

```bash
cd 05-engineering/apps/api
curl -s http://localhost:8787/api/ai/models | jq .   # mockOnly=false and capabilityMap routes to real models for DC checks
# Trigger a dashboard refresh; after M3, check response _meta.clusterModel / embedding id
npm run eval:onboarding-extraction   # when touching onboarding extraction
npm run test:api                     # from 05-engineering root
```

**With Supabase (optional):**

```bash
# apps/api/.env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

---

## 3. Smoke-test checklist

Run these after `npm run dev` with default (mock) config. All checks must pass before beta handoff.

### API layer

- `GET http://localhost:8787/health` → `{"ok":true,"service":"@tempo/api"}`
- `GET http://localhost:8787/api/settings` → 200 with valid settings object (contractVersion present)
- `PUT http://localhost:8787/api/settings` with valid payload → 200, payload echoed back
- `PUT http://localhost:8787/api/settings` with invalid payload → 400 with `errors` array
- `GET http://localhost:8787/api/dashboard` → 200, `stories` array present, `contractVersion` matches
- `GET http://localhost:8787/api/dashboard?limit=3` → 200, `stories.length <= 3`
- `GET http://localhost:8787/api/ai/models` → 200, `capabilityMap` present
- `GET http://localhost:8787/api/ai/metrics` → 200, `metrics` object with counter fields
- `GET http://localhost:8787/api/ingestion/sources` → 200, `feeds` array present

### Frontend layer

- `http://localhost:5173/` loads without console errors
- Navigating to `http://localhost:5173/dashboard` without a session redirects to `/onboarding`
- Completing the onboarding form grants access to `/dashboard`
- Dashboard page loads and shows at least one story card
- Settings page loads, shows saved values, and accepts a PUT (verify network tab shows 200)
- Logout button clears session and redirects to onboarding

### Data persistence check

- Save a new topic in Settings
- Stop and restart `npm run dev:api`
- Reload Settings — the topic is still present (verifies file or Supabase persistence)

---

## 4. Rollback checklist

If a beta deployment needs to be reverted:

1. **Stop the API process** — no graceful shutdown needed; it is stateless beyond the data directory.
2. **Revert `apps/api/data/settings.json`** to the previous version (or delete it — the API will recreate defaults on next start).
3. **Restore a prior image / git tag** if running from a deployment artifact.
4. **Supabase only:** if settings were written to Supabase, the previous `settings` row can be restored from the Supabase dashboard → Table Editor → `settings` table. No migration is needed to roll back because the schema is additive and backward-compatible.
5. **PostHog:** no rollback needed — disabling `POSTHOG_API_KEY` stops all event capture immediately with zero behavioral impact.
6. **Verify** by re-running the smoke-test checklist against the reverted version.

---

## 5. Launch day checklist

Complete in order on the day of beta handoff.

### Pre-launch (the day before)

- All four validation commands pass on the branch being deployed:
  ```bash
  cd 05-engineering
  npm run test:api       # must show 0 failures
  npm run test:packages  # must show 0 failures
  npm run test:prototype # must show 0 failures
  npm run build          # must exit 0
  ```
- `apps/api/.env` is populated with production values (Supabase keys if used, PostHog key if used)
- `04-prototype/.env.local` is populated (or omitted for no-analytics mode)
- Supabase schema applied (if using Supabase): run `apps/api/src/db/schema.sql` against the project
- Confirm `TEMPO_AI_MOCK_ONLY` is **not** set to `true` if real AI is intended for beta

### Launch

- Start API: `cd 05-engineering && npm run dev:api` (or equivalent process supervisor command)
- Start web: `cd 04-prototype && npm run dev` (or serve the `dist/` folder from `npm run build`)
- Run smoke-test checklist (§3) end-to-end
- Confirm `GET /api/ai/models` shows expected `capabilityMap` (mock or real)
- Confirm `GET /api/ai/metrics` counters increment after a dashboard load

### Post-launch (first 30 minutes)

- Watch API stdout for `[ai.cost]` log lines — confirms AI summarization path is active
- If PostHog is configured: verify Live Events shows `api_dashboard_requested` after a dashboard load
- If Supabase is configured: verify a settings write persists across an API restart
- No 500 errors in API stdout
- Check browser console — no unhandled errors on the prototype

### Known risks at beta


| Risk                                                                           | Severity | Mitigation                                                                            |
| ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------- |
| Auth is localStorage-only; any user with DevTools can bypass the session guard | High     | Acceptable for controlled beta (single operator); replace before public access        |
| `source-items.json` is static fixture data; no live RSS/API ingestion yet      | Medium   | Operator must manually update the file to refresh content                             |
| AI costs are unbounded if real Anthropic key is set; no per-request cap        | Medium   | Set `TEMPO_AI_MOCK_ONLY=true` to disable real AI if costs are a concern               |
| Supabase anon-key RLS policies are not yet defined; anon access is broad       | Medium   | Use `SUPABASE_SERVICE_ROLE_KEY` for server-side access only; do not expose to browser |
| PostHog is fire-and-forget; failed events are silently dropped                 | Low      | Check PostHog Live Events dashboard to confirm capture is working                     |


