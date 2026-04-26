# Design system — Comms prototype (v0)

Lightweight tokens + docs for a **single-user, zero-to-one** prototype. Optimized for tools (Cursor, Claude Code, v0) to read one folder and stay consistent.

## Start here

1. **[Principles](principles.md)** — tone, UX guardrails, what v0 is not.
2. **[Tokens — JSON](tokens/design-tokens.json)** — canonical values for codegen / agents (mirrors `04-prototype` runtime).
3. **[Tokens — CSS](tokens/tokens.css)** — `var(--...)` CSS custom properties matching `04-prototype/src/index.css`.
4. **[Color preview](color-preview.html)** — single canonical swatch + rationale file for this design system.
5. **[AI usage](ai-usage.md)** — copy-paste instructions for prompts.
6. **[DS mapping](ds-mapping.md)** — source-of-truth declaration, old→new token mapping, retired vars.

Archive guardrail: files under `02-design/archive/` are historical context only; agents should default to `foundations/`, `tokens/`, and `components/` unless explicitly asked to use archive artifacts.

## Foundations

- [Color](foundations/color.md)
- [Typography](foundations/typography.md)
- [Spacing](foundations/spacing.md)
- [Motion and feedback](foundations/motion-and-feedback.md)

## Components (specs only — no framework lock-in)

- [Button](components/button.md)
- [Input](components/input.md)
- [Card](components/card.md)
- [Alert](components/alert.md)
- [Badge](components/badge.md)
- [Layout shell](components/layout-shell.md)

## Domain patterns

- [Monitoring-first workflow](patterns/monitoring-workflow.md) — aligned with current research direction.

## Research linkage

Evidence and persona context live under [01-research](../01-research/); primary snapshot: [research-context](../01-research/ops/research-context.md).

## Changelog

See [changelog.md](changelog.md).