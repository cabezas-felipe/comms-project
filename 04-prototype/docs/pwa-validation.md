# PWA Baseline Validation

## Purpose / scope

This is the **minimal PWA baseline** validation guide for Tempo. It covers verifying
that the app is installable (Add to Home Screen), launches in standalone mode, and
that the service worker behaves safely — specifically that **API data stays
network-only**. This is an ops/testing handoff, not an architecture deep dive.

In scope: manifest + icons, install flow, standalone launch, SW registration, and a
core smoke pass. Out of scope: offline fallback UX, install-prompt UI, push, and CI/
Lighthouse automation (none of these exist in the baseline yet).

## Preconditions

- **Use an HTTPS preview/production URL** — service workers and install do **not**
  work over local `vite dev` (`http://localhost`). Test against a deployed preview
  or production build.
- The deployed build must already include the **manifest and service worker**. Verify
  by building locally first:

  ```
  npm --prefix 04-prototype run build
  ```

  Confirm `dist/manifest.webmanifest`, `dist/sw.js`, and `dist/workbox-*.js` are
  emitted, then deploy that build.

## iPhone validation checklist (Safari)

> Use Safari — Add to Home Screen install is Safari-only on iOS.

- [ ] Open the app URL in Safari.
- [ ] Tap **Share → Add to Home Screen**.
- [ ] Confirm the **icon and name** ("Tempo") look correct in the Add to Home Screen
      preview.
- [ ] Launch the app **from the Home Screen icon** and confirm it opens in
      **standalone mode** (no Safari address bar / browser chrome).
- [ ] Smoke checks in standalone mode:
  - [ ] Login / onboarding flow works.
  - [ ] Dashboard loads and shows data.
- [ ] Navigate to **`/settings`** and confirm the route loads correctly (deep-link /
      client routing works under the manifest `scope`).

## Android spot-check (optional)

- [ ] Open the app URL in Chrome.
- [ ] Confirm the **install** affordance appears (install icon in the address bar or
      the "Install app" menu item) and installs.
- [ ] Launch the installed app and confirm it opens in **standalone mode**.

## DevTools verification (desktop support checks)

Use Chrome DevTools → **Application** tab against the HTTPS deployment.

- [ ] **Manifest** (Application → Manifest): present and valid; name, icons, and
      `display: standalone` are shown with no errors.
- [ ] **Service worker** (Application → Service Workers): registered and `activated`.
- [ ] **`/api/*` is network-only**: exercise the app (load dashboard, save settings),
      then check Application → **Cache Storage**. API responses (`/api/...`) must
      **not** appear in any cache. In the Network panel, `/api/*` requests should be
      served from the network, not "(ServiceWorker)" cache.

## Rollback guardrails

If the PWA baseline causes problems in testing:

- **Revert the PWA commits** (Prompts 1–3) and redeploy, **or** disable it in place by:
  - removing/commenting the `VitePWA({...})` plugin in `04-prototype/vite.config.ts`, and
  - removing the `registerSW({ immediate: true })` call in `04-prototype/src/main.tsx`,
  - then rebuild and redeploy.
- **Clear site data on test devices** if stale behavior appears (a previously
  registered SW can keep serving old assets):
  - Desktop: DevTools → Application → **Clear storage** → Clear site data (this also
    unregisters the SW).
  - iOS: delete the Home Screen icon, then Settings → Safari → Clear History and
    Website Data (or Advanced → Website Data → remove the site).
  - Android: Chrome → Site settings → Delete data, or uninstall the installed app.

## Sign-off checklist (merge readiness)

- [ ] HTTPS preview/production build verified to include manifest + SW.
- [ ] iPhone: installs, launches standalone, login/onboarding/dashboard/`/settings`
      smoke pass.
- [ ] Android (optional): installs and launches standalone.
- [ ] DevTools: manifest valid, SW registered/activated.
- [ ] `/api/*` confirmed **not** cached (network-only).
- [ ] Rollback steps reviewed and understood.
- [ ] No regressions in `npm --prefix 04-prototype run build` and
      `npm --prefix 04-prototype run test`.
