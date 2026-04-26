# DS mapping — 02-design ↔ 04-prototype alignment

**Version:** 0.3.0  
**Date:** 2026-04-26  
**Branch:** feat/lovable-ds

## Source of truth

The active design system is defined in **`04-prototype/src/index.css`** and **`04-prototype/tailwind.config.ts`**. The Lovable import (`04-prototype/_imports/lovable-20260426/design-system/`) is a reference snapshot that matches the prototype exactly.

`02-design/tokens/` is documentation — it mirrors the prototype's CSS variables for agent and designer reference. It is not consumed at build time.

## What changed in this alignment (0.3.0)

| Area | Pre-0.3.0 (02-design) | Aligned (matches 04-prototype) |
|---|---|---|
| Color format | Flat hex (`#4F6887`) | HSL triplets (`14 80% 48%`) — shadcn pattern |
| CSS var names | `--color-accent-base`, `--font-ui`, etc. | `--ember`, `--primary`, `--background`, etc. |
| Primary accent | Blue-grey `#4F6887` (`--color-accent-base`) | Deep ink `--primary` + ember `--ember` (orange-red) |
| Font — display/heading | Helvetica Neue | Fraunces (serif) |
| Font — sans/ui | Helvetica Neue | Inter |
| Font — body | Calluna | Inter (no separate body serif in prototype) |
| Font — mono | generic `ui-monospace` | JetBrains Mono |
| Radius | 4-step scale (`sm/md/lg/pill`) | Single `--radius: 0.25rem` + calc variants |
| Spacing CSS vars | `--space-0` through `--space-10` | No CSS vars; use Tailwind spacing classes |
| Status tokens | `success`, `warning`, `critical`, `highlight` | `--signal-positive`, `--signal-warning`, `--destructive` |
| Dark mode | Not defined | `.dark {}` class variant defined |

## Token name mapping (old → new)

| Old var | New var | Light HSL value |
|---|---|---|
| `--color-bg-default` | `--background` | `38 30% 96%` |
| `--color-bg-subtle` | `--surface` | `36 24% 93%` |
| `--color-surface-default` | `--card` / `--surface-raised` | `0 0% 100%` |
| `--color-surface-selected` | `--secondary` | `36 18% 88%` |
| `--color-border-default` | `--border` | `36 14% 82%` |
| `--color-border-strong` | `--rule` | `222 12% 70%` |
| `--color-text-primary` | `--foreground` | `222 25% 12%` |
| `--color-text-muted` | `--muted-foreground` | `222 10% 40%` |
| `--color-text-inverse` | `--primary-foreground` | `38 30% 96%` |
| `--color-accent-base` | `--primary` (actions) + `--ember` (emphasis) | `222 30% 14%` / `14 80% 48%` |
| `--color-accent-soft` | `--accent` | `36 22% 87%` |
| `--color-success-base` | `--signal-positive` | `152 45% 32%` |
| `--color-warning-base` | `--signal-warning` | `36 85% 42%` |
| `--color-critical-base` | `--destructive` | `0 70% 42%` |
| `--color-highlight-base` | `--ember` | `14 80% 48%` |
| `--color-focus-ring` | `--ring` | `222 30% 14%` |
| `--font-heading` | `font-display` Tailwind class | Fraunces, Georgia, serif |
| `--font-ui` | `font-sans` Tailwind class | Inter, system-ui, sans-serif |
| `--radius-sm/md/lg/pill` | `--radius` + calc | `0.25rem` base |

## Retired tokens

These vars existed in `02-design/tokens/tokens.css` pre-0.3.0 but were never used in `04-prototype`:

`--color-bg-*` · `--color-surface-*` · `--color-border-*` · `--color-text-*` · `--color-accent-*` · `--color-success-*` · `--color-warning-*` · `--color-critical-*` · `--color-highlight-*` · `--color-focus-ring` · `--font-heading` · `--font-ui` · `--font-body` · `--font-mono` · `--weight-*` · `--type-*` · `--leading-*` · `--space-0` through `--space-10` · `--radius-sm` · `--radius-md` · `--radius-lg` · `--radius-pill` · `--motion-fast` · `--motion-base` · `--motion-slow` · `--motion-easing-standard`

## Spacing note

The spacing scale (2px–40px) in `foundations/spacing.md` remains valid as design guidance. The prototype applies spacing via Tailwind utility classes (`p-4`, `gap-3`, etc.) — no `--space-*` CSS vars are defined at runtime.

## Ember vs old accent

The old `--color-accent-base` (`#4F6887`, blue-grey) was a single action/emphasis color. In the new system this role is split: **`--primary`** (`hsl(222 30% 14%)`, deep ink) handles primary actions; **`--ember`** (`hsl(14 80% 48%)`, warm orange-red) handles urgency cues, priority indicators, and "what changed" emphasis. The `highlight` token is retired — ember covers that role.
