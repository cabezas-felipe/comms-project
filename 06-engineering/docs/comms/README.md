# Comms (transactional)

Design SoT lives in Paper: [Tempo · 07 - Comms](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/p-9-0/1002-0) (`c01 · Magic link`).

**Paper frames:** Desktop · Message canvas **600×fit** · Mobile · Check **390×fit** (same template). Not product UI viewports — see [viewports](../../../03-design/design-system/foundations/viewports.md).

| Artifact | Role |
| --- | --- |
| [magic-link-onboarding.html](magic-link-onboarding.html) | Supabase Magic Link template (onboarding) — paste into Dashboard or `content_path` · `max-width: 600px` |
| [DECISIONS.md D-073](../../DECISIONS.md) | TTL **900s (15 min)** + variable locks |
| [onboarding--v1.md](../../../02-product/prds/onboarding--v1.md) | Product copy + funnel |

## Build checklist (magic link)

1. Set **Email OTP expiration** to **900** seconds (Dashboard or `auth.email.otp_expiry = 900`).
2. Set subject to `Your Tempo link`.
3. Paste HTML from `magic-link-onboarding.html` into the Magic Link template.
4. Confirm redirect allowlist / `emailRedirectTo` for web + iOS (not shown in the email body).
5. Send a test to an invited `users` email and confirm expiry copy matches the project TTL.
