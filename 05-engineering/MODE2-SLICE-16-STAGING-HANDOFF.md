# Slice 16 — Staging Handoff

**Branch:** `build/slice16-next`
**Status:** Complete
**Decision:** D-034

---

## What this document covers

Slice 15 covered local and internal-operator readiness (single machine, developer in the loop).
This document covers the next step: deploying to a shared staging server and handing off to the first external user.

Staging assumptions:
- API runs on a remote host (VPS, cloud VM, or equivalent) — not a developer laptop.
- The web frontend is served as a static build (not `npm run dev`).
- At least one external user will access the system over the network.
- The operator (you) is not physically present when the external user first logs in.

---

## 1. Env var matrix

### API server (`apps/api/.env` on the staging host)

| Variable | Staging value | Notes |
|---|---|---|
| `TEMPO_API_PORT` | `8787` (or reverse-proxy port) | Match whatever the reverse proxy forwards to |
| `TEMPO_DATA_DIR` | Absolute path, e.g. `/srv/tempo/data` | Must be writable; survives restarts |
| `SUPABASE_URL` | Your project URL | Omit to use file-based storage at `TEMPO_DATA_DIR` |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase → Settings → API | Required if `SUPABASE_URL` is set |
| `SUPABASE_ANON_KEY` | From Supabase → Settings → API | Alternative to service-role key |
| `TEMPO_AI_SUMMARY_MODEL` | `mock-openai-mini` (safe default) | Change to `anthropic:<model>` only after cost review |
| `TEMPO_AI_MOCK_ONLY` | `true` (recommended for first staging run) | Prevents accidental AI spend during validation |
| `TEMPO_ANTHROPIC_API_KEY` | From Anthropic console | Required only if using real Anthropic models |
| `TEMPO_AI_TIMEOUT_MS` | `2000` | Increase slightly over local default for network latency |
| `POSTHOG_API_KEY` | From PostHog → Project Settings | Set to capture staging usage; EU key if required |
| `POSTHOG_HOST` | `https://eu.i.posthog.com` if EU required | Defaults to US cloud |

### Frontend (`04-prototype/.env.local` — baked into the static build)

| Variable | Staging value | Notes |
|---|---|---|
| `VITE_POSTHOG_API_KEY` | Same PostHog key as API | Set before running `npm run build` |
| `VITE_POSTHOG_HOST` | Same host as API | Must match API-side setting |
| `VITE_API_BASE_URL` | `https://your-staging-host.example.com` | If the prototype uses a base URL env var for the API |

**Important:** `VITE_*` variables are baked into the static build at build time. If you change them, you must rebuild (`npm run build`) and redeploy `dist/`.

---

## 2. Exact startup commands

### Step 1 — On the staging host: install and build

```bash
# Clone or pull the branch
git clone https://github.com/your-org/comms-project.git /srv/tempo
cd /srv/tempo/05-engineering

# Install all workspace dependencies
npm install

# Build shared packages and the frontend static bundle
npm run build
# Produces: 04-prototype/dist/  (serve this with any static HTTP server)
#           packages/contracts/dist/  and  packages/analytics/dist/
```

### Step 2 — Start the API server

```bash
cd /srv/tempo/05-engineering

# Foreground (confirm it starts cleanly, then move to background)
node apps/api/src/server.mjs

# Background with nohup (minimal; use a process manager for production)
nohup node apps/api/src/server.mjs >> /var/log/tempo-api.log 2>&1 &

# Verify
curl http://localhost:8787/health
# Expected: {"ok":true,"service":"@tempo/api"}
```

### Step 3 — Serve the frontend static build

The frontend is a static bundle (`04-prototype/dist/`). Serve it with any HTTP server:

```bash
# Option A: npx serve (zero-config, good for staging)
npx serve /srv/tempo/04-prototype/dist -l 3000

# Option B: nginx (if already installed)
# Point document_root to /srv/tempo/04-prototype/dist
# Add a location block to proxy /api/* → http://localhost:8787

# Option C: Caddy (auto-HTTPS, minimal config)
# Caddyfile:
#   your-domain.example.com {
#     root * /srv/tempo/04-prototype/dist
#     file_server
#     reverse_proxy /api/* localhost:8787
#   }
```

### Reverse proxy note

The frontend uses Vite's proxy during dev (`vite.config.ts`). In production the static bundle makes direct requests to `/api/*`. Either:
- Serve frontend and API on the same domain (reverse proxy `/api/*` to port 8787), or
- Set `VITE_API_BASE_URL` to the full API URL before building (requires confirming the prototype reads this var — check `04-prototype/src/lib/api.ts` and `settings-api.ts`).

The simpler path for staging: same-domain reverse proxy (nginx or Caddy) forwarding `/api/*` to `localhost:8787`.

---

## 3. Smoke-test checklist

Run these from outside the staging host (i.e., from a browser or `curl` on a separate machine) after the full deployment above. All items must pass before handing off to the external user.

### Infrastructure

- [ ] `curl https://your-staging-host.example.com/health` (or `http://` if no TLS yet) → `{"ok":true,"service":"@tempo/api"}`
- [ ] `curl https://your-staging-host.example.com/api/settings` → 200, valid JSON with `contractVersion`
- [ ] `GET /api/ai/models` → `mockOnly: true` (confirms `TEMPO_AI_MOCK_ONLY=true` is set and no real AI spend possible)
- [ ] Static build loads: `https://your-staging-host.example.com/` returns the React app without a 404

### Auth flow (simulating the external user)

- [ ] Navigating directly to `/dashboard` redirects to `/onboarding` (auth guard active)
- [ ] Completing onboarding form lands on `/dashboard`
- [ ] Dashboard shows story cards (sourced from `source-items.json` fixture)
- [ ] Settings page loads, shows defaults; a PUT succeeds and the value survives a page reload
- [ ] Logout returns to `/onboarding`; `/dashboard` redirects again after logout

### Persistence

- [ ] Make a settings change; restart the API process (`kill $(pgrep -f server.mjs) && nohup node apps/api/src/server.mjs ...`); reload Settings — the change is still present (verifies file or Supabase persistence on the remote host)

### Observability

- [ ] If PostHog configured: PostHog Live Events shows `api_dashboard_requested` within 30 seconds of a dashboard load
- [ ] API stdout / log file shows no ERROR lines after a full smoke-test run

---

## 4. Failure and rollback steps

### API won't start

1. Check the log: `tail -50 /var/log/tempo-api.log`
2. Common causes:
   - `SUPABASE_URL` set but key missing → error message names the missing variable; unset `SUPABASE_URL` to fall back to file storage
   - `TEMPO_AI_SUMMARY_MODEL=anthropic:...` but no API key → startup warning logged; set `TEMPO_AI_MOCK_ONLY=true` to suppress
   - Port conflict → change `TEMPO_API_PORT`
3. Re-run `node apps/api/src/server.mjs` in foreground to see the full error before returning to background.

### Settings or data lost after restart

- File-based storage: check that `TEMPO_DATA_DIR` points to a persistent path (not a temp directory). Run `ls -la $TEMPO_DATA_DIR` to confirm `settings.json` exists.
- Supabase: verify the `settings` row exists in Supabase Table Editor. If the table is empty, the API will seed defaults on next write — no crash, but previous settings are gone.

### Frontend shows blank page or 404 on `/api/*`

1. Confirm the reverse proxy is running and correctly forwarding `/api/*` to port 8787.
2. Check browser console for a CORS or mixed-content error (HTTP frontend + HTTPS API or vice versa).
3. Re-run `npm run build` if `VITE_*` variables changed since the last build.

### Full rollback

1. Stop the API: `kill $(pgrep -f server.mjs)`
2. Check out the previous known-good tag or commit: `git checkout <prior-tag>`
3. Rebuild: `cd 05-engineering && npm install && npm run build`
4. Restore `data/settings.json` from backup if available (or delete to reset to defaults).
5. Restart the API and re-run the smoke-test checklist.

---

## 5. Go / no-go checklist

Complete this checklist on the staging host before granting the external user access. Every item must be **GO** for handoff to proceed. A single **NO-GO** blocks the handoff.

### Technical gates

| # | Check | GO criteria | Status |
|---|---|---|---|
| T1 | All validation commands pass | `test:api` 0 failures, `test:packages` 0 failures, `test:prototype` 0 failures, `build` exits 0 | |
| T2 | API health endpoint reachable externally | `GET /health` returns 200 from outside the host | |
| T3 | Mock-only mode confirmed | `GET /api/ai/models` shows `"mockOnly": true` (or real AI cost limit is accepted) | |
| T4 | Auth guard active | Unauthenticated `/dashboard` redirects to `/onboarding` from a clean browser | |
| T5 | Settings persist across API restart | Verified per §3 persistence check | |
| T6 | No 500 errors in log | API stdout/log shows no `500` or unhandled exception after full smoke test | |
| T7 | Frontend loads over the network | React app renders without JS errors in the browser console | |

### Operational gates

| # | Check | GO criteria | Status |
|---|---|---|---|
| O1 | Data backup in place | `data/settings.json` backed up, or Supabase row can be restored from dashboard | |
| O2 | Log access confirmed | Operator can read API logs in real time (ssh + tail, or log aggregator) | |
| O3 | Rollback procedure tested | Operator has run the rollback steps in §4 at least once (on staging, not production) | |
| O4 | External user briefed | User knows: (a) auth is local-only, (b) content is fixture data, (c) how to report issues | |
| O5 | Known risks acknowledged | All five risks from Slice 15 §5 have been reviewed and accepted for this staging context | |

### Known risks carried from beta (unchanged)

| Risk | Severity | Accepted for staging? |
|---|---|---|
| Auth is localStorage-only; session bypass via DevTools | High | Acceptable for single known external user; do not use with untrusted parties |
| `source-items.json` is static fixture data | Medium | User must be informed content does not update automatically |
| Real AI costs unbounded if key is set | Medium | Mitigated by `TEMPO_AI_MOCK_ONLY=true` during staging |
| Supabase anon-key RLS policies not defined | Medium | Mitigated by using service-role key server-side only |
| PostHog events fire-and-forget (silent drop on failure) | Low | Acceptable |

**Handoff decision:**

```
All T1–T7 and O1–O5 → GO:   proceed with external user access
Any item → NO-GO:           block handoff, resolve the item, re-run checklist
```
