# Design system — Tempo (v1.2.60)

Tokens + docs for Tempo's Gravel & Fire design system, encoded from the Paper exploration file into a form Cursor/Claude Code (and any other agent) can read consistently while building the Next.js/shadcn prototype.

## Start here

1. **[Principles](../principles.md)** — UX guardrails: calm by default, scan before read, trust through navigability.
2. **[DS mapping](ds-mapping.md)** — source-of-truth declaration and the full decision log (every token change, what it resolved to, and why).
3. **[Tokens — JSON](tokens/design-tokens.json)** — canonical values for agents / codegen.
4. **[Tokens — CSS](tokens/tokens.css)** — `var(--...)` custom properties consumed by `05-prototype/src/index.css`.
5. **[AI usage](ai-usage.md)** — copy-paste instructions for prompting Cursor/Claude Code.

## Foundations

- [Color](foundations/color.md)
- [Typography](foundations/typography.md)
- [Spacing and radius](foundations/spacing-and-radius.md)
- [Motion and feedback](foundations/motion-and-feedback.md)
- [Viewports](foundations/viewports.md) — desktop `1440×900` · mid `1024×768` · mobile `390` / keyboard `390×844`

## Components

- [Badge](components/badge.md) — status pills and categorical labels
- [Button](components/button.md) — primary (F ink outline), secondary (G rule outline), ghost, critical; readiness (clean + in-flight = muted G full opacity; ready → F); labels `text-sm` (14px)
- [Back affordance](components/back-affordance.md) — mobile chevron (`--ink-primary`) · desktop `Back to {Destination}` · onboarding desktop = browser
- [Card](components/card.md) — monitoring information groupings
- [Input](components/input.md) — text, search, textarea (`--surface-raised`; not Primary chrome)
- [Modal](components/modal.md) — scrim + panel, × dismiss, short single-job dialogs
- [Alert](components/alert.md) — system and workflow state banners
- [Layout shell](components/layout-shell.md) — persistent frame for monitor → draft loop
- [Narrative row](components/narrative-row.md) — Rising / Stable / Falling feed rows (pills-only; chevron expand)

## Domain patterns

- [Monitoring workflow — Monitor → Draft → Close](patterns/monitoring-workflow.md)
- [System surfaces](patterns/system-surfaces.md) — splash · generic fatal error
- [Scope gates](patterns/scope-gates.md) — Tags / Context hard gates + thin counsel
- [Form intro](patterns/form-intro.md) — headline + continuous support (no hard breaks); onboarding / Account / modals
- [Dashboard filters](patterns/dashboard-filters.md) — Mode / Select / Always-on (free text; idle vs editing)
- [Metastory open state](patterns/metastory-open.md) — in-feed expand; Copy brief → `Copied` confirm (desktop) / Share brief (mobile); Sources
- [Source reader](patterns/source-reader.md) — snippet before outbound; desktop docked · mid overlay · mobile large sheet
- [Account menu](patterns/account-menu.md) — Settings Index + Email L1 + Delete L1 + Legal L1; legal `Terms · Privacy`
- [Large sheet](patterns/large-sheet.md) — Handle + 44 chrome → 16 body air; equal Index rows; legal section gap 32

## Product linkage

Requirements and scope live under [02-product](../../02-product/). MVP-era field doctrine (archived): [why this matters — field doctrine](../../02-product/contracts/archive/why-this-matters--field-doctrine.md).

## Changelog

See [changelog.md](changelog.md).
