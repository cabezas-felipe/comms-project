# Mode 2 — Slice 18: Real Auth + Per-User Settings Persistence

**Branch:** `build/slice17-auth-flow-import`  
**Builder:** Claude Code  
**Reviewer:** Codex

---

## Objective

Replace simulated localStorage auth with real Supabase Auth (email magic link) and ensure settings are stored and loaded per authenticated user.

---

## What changed

### 04-prototype — frontend

| File | Change |
|------|--------|
| `src/lib/supabase.ts` | **New.** Browser Supabase client using `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`. |
| `src/lib/auth.tsx` | **Rewritten.** `AuthProvider` now initializes from `supabase.auth.getSession()` and subscribes to `onAuthStateChange`. `signIn(email, type)` sends a real OTP via `signInWithOtp`, with `emailRedirectTo` embedding the `type` param so the callback can route new vs. returning users. `logout` calls `supabase.auth.signOut()`. Context now exposes `user`, `session`, and `loading` in addition to `isAuthenticated`. |
| `src/lib/settings-api.ts` | **Updated.** `fetchSettingsPayload` and `saveSettingsPayload` now read the active session to (1) scope localStorage cache to `tempo.settings.v1.{user_id}` and (2) send `Authorization: Bearer {access_token}` to the API. Supabase errors are caught so the functions degrade gracefully when `VITE_SUPABASE_URL` is unset. |
| `src/lib/settings-api.test.ts` | **Updated.** Added `vi.mock('@/lib/supabase', ...)` returning a fixed test session so tests exercise the user-scoped key path without real network calls. |
| `src/pages/auth/AuthEmail.tsx` | **Updated.** `handleSubmit` calls `signIn(email, type)` (real OTP) instead of navigating directly. Shows a "Sending…" disabled state while the OTP request is in flight. Catches errors and shows a toast. |
| `src/pages/auth/CheckEmail.tsx` | **Updated.** Removed the prototype-only "I clicked the link" simulator. Page is now a pure confirmation screen; the real magic link drives the rest of the flow. |
| `src/pages/auth/AuthCallback.tsx` | **New.** Handles the `emailRedirectTo` redirect from Supabase. The Supabase client automatically processes the token fragment from the URL. `onAuthStateChange` fires in `AuthProvider`, `isAuthenticated` becomes true, and `AuthCallback` routes to `/onboarding` (signup) or `/dashboard` (login) based on the `?type=` query param. |
| `src/pages/Onboarding.tsx` | **Updated.** Removed `login()` call and `isAuthenticated → <Navigate>` guard. User is already authenticated when they arrive (they clicked the magic link); calling `login()` on a simulated basis is no longer valid. Form submit now just navigates to `/dashboard`. |
| `src/components/ProtectedRoute.tsx` | **Updated.** Added `loading` guard: returns `null` while session is being restored to prevent a flash redirect to `/` before the session is known. |
| `src/App.tsx` | **Updated.** Added `/auth/callback` route (→ `AuthCallback`). |
| `.env.example` | **New.** Documents `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and reminds operators to add `/auth/callback` to Supabase redirect URL allowlist. |

### 05-engineering — API

| File | Change |
|------|--------|
| `apps/api/src/db/settings-repo.mjs` | **Updated.** `readSettings(userId)` and `writeSettings(payload, userId)` now accept an optional `userId`. When provided, Supabase uses key `user:{user_uuid}`; file adapter uses `settings_user_{userId}.json`. Unauthenticated calls (no userId) continue to use `global_settings` / `settings.json` — backward compatible with all existing tests. |
| `apps/api/src/server.mjs` | **Updated.** Added `resolveUserId(req)`: extracts the Bearer token from `Authorization`, calls `supabase.auth.getUser(token)` with the service-role client to verify and return the user UUID. Returns `null` when no token is present, Supabase is unconfigured, or the token is invalid. `GET /api/settings` and `PUT /api/settings` now call `resolveUserId(req)` and pass the result to `readSettings`/`writeSettings`. |
| `apps/api/.env.example` | **Updated.** Noted that `SUPABASE_SERVICE_ROLE_KEY` is required for JWT verification, and added a cross-reference to the frontend `.env.example`. |
| `apps/api/src/db/migrations/001_initial.sql` | **New.** Migration baseline marker for slice 11 schema. |
| `apps/api/src/db/migrations/002_user_settings.sql` | **New.** Documents the key-prefix convention (`user:{uuid}` vs `global_settings`), explains why no DDL change is needed, and provides the RLS policy snippet for a future slice that exposes settings directly via anon key. |

---

## Env vars required

### Frontend (`04-prototype/.env`)

| Var | Required | Description |
|-----|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Supabase project URL (Settings → API) |
| `VITE_SUPABASE_ANON_KEY` | Yes | Anon (public) key — safe for browser |

### API (`05-engineering/apps/api/.env`)

| Var | Required | Description |
|-----|----------|-------------|
| `SUPABASE_URL` | Yes (for Supabase path) | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (for JWT verify) | Service-role key — server-only, never expose |

### Supabase dashboard configuration

Add the following to **Auth → URL Configuration → Redirect URLs**:
- `http://localhost:8080/auth/callback` (local dev)
- `https://your-staging-domain/auth/callback` (staging)

---

## Validation results

```
npm run test:api      → 51 tests, 0 failures
npm run test:packages → 18 tests, 0 failures
npm run test:prototype → 9 tests, 0 failures
npm run build         → exits 0
```

---

## Remaining risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `VITE_SUPABASE_URL` unset at build time | Medium | Client degrades gracefully: `getSession()` returns null, settings fall back to localStorage with global key; `signIn` will throw and show a toast. |
| `SUPABASE_SERVICE_ROLE_KEY` unset | Low | `resolveUserId` returns null → settings fall back to global key; auth verification is skipped. API still works but without per-user isolation. |
| Magic link redirect URL not whitelisted | Medium | Supabase blocks the redirect; user sees an error from Supabase. Operator must add `/auth/callback` to the allowlist before testing. |
| Session lost on browser close (depending on Supabase config) | Low | Supabase JS SDK v2 persists sessions in localStorage by default (`persistSession: true`). Standard behavior; no special handling needed. |
| Onboarding settings not saved to API | Low | Onboarding form is cosmetic (existing behavior). User configures settings in the Settings page. Accepted for this slice. |

---

## Strict scope confirmation

- [x] Real magic-link auth via `supabase.auth.signInWithOtp`
- [x] Routes preserved: `/`, `/auth/:mode`, `/auth/check-email`; `/auth/callback` added
- [x] Session restored on app load via `getSession()` + `onAuthStateChange`
- [x] Logout calls `signOut()` only — no data deletion
- [x] Settings keyed by authenticated user ID (localStorage + API)
- [x] Returning user loads their previous settings after login
- [x] No UI redesign
- [x] No dashboard/archive behavior changes
- [x] No mobile changes
- [x] No broad refactor

---

## Auth-hardening pass (same branch, follow-on)

### Policy enforced

- `GET /api/settings`, `PUT /api/settings`, `GET /api/dashboard` require a valid Bearer token.
- Missing or invalid token → **401** with a JSON `message` field. No silent fallback to global/shared settings.
- Dashboard reads settings for the authenticated user (`readSettings(userId)`), not the global key.

### Changes

| File | Change |
|------|--------|
| `apps/api/src/server.mjs` | Added `export const _auth = { resolver: resolveUserId }` — a mutable hook that tests inject. Added `requireAuth(req, res)` helper that calls `_auth.resolver`, sends 401 on null, and returns the user ID. Replaced `resolveUserId` calls in all three protected routes with `requireAuth`. Auth check on PUT `/api/settings` moved before payload validation. Dashboard now calls `readSettings(userId)`. |
| `apps/api/src/server.routes.test.mjs` | Imports `_auth` from server. Sets `_auth.resolver = async () => TEST_USER_ID` at module level so all existing tests authenticate deterministically (no live Supabase needed). Adds three new tests asserting 401 for each protected route when `_auth.resolver` returns null; each uses `try/finally` to safely restore the default resolver. Test count: 51 → 54. |
| `04-prototype/.env.example` | Clarified that the redirect URL is constructed from `window.location.origin` at runtime; removed the implication that port 8080 is canonical; listed both default Vite ports (5173 and 8080); noted Supabase does not support port wildcards. |

### Validation results

```
npm run test:api       → 54 tests, 0 failures  (+3 new 401 tests)
npm run test:packages  → 18 tests, 0 failures
npm run test:prototype →  9 tests, 0 failures
npm run build          → exits 0
```
