# Slice 17 Auth Import Plan

## Imported from Lovable
- landing route `/` with Log in / Sign up buttons
- auth email entry route `/auth/:mode`
- check-email route `/auth/check-email`
- auth-specific header behavior (hide on `/`, `/auth/*`, `/onboarding`)

## Keep from current app (do not replace)
- existing dashboard/settings/archive pages
- existing API integration and settings persistence
- existing analytics hooks unless explicitly updated
- existing app shell except route additions

## Integration approach
1. Add new auth routes into current app router.
2. Add imported auth pages as new local pages/components.
3. Keep existing onboarding and dashboard behavior.
4. Make auth flow simulate magic link for now (prototype mode).
5. Ensure no changes outside auth flow scope.
