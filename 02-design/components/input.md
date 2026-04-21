# Input

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [color](../foundations/color.md) · [spacing / radius](../foundations/spacing.md) · [typography](../foundations/typography.md) · [motion](../foundations/motion-and-feedback.md)

## Purpose

Structured text entry for filtering, drafting metadata, and quick capture.

## Variants

- `text`
- `search`
- `textarea` (for short notes)

## States

Rest, focus, filled, error, disabled

## Token usage

- Surface: `color.surface.default`
- Border: `color.border.default`; error: `color.critical.base` (border or ring, plus message — not color-only)
- Radius: `radius.md` (default for inputs — [spacing](../foundations/spacing.md))
- Focus ring: `color.focusRing`
- Value text: `color.text.primary`
- Placeholder / helper: `color.text.muted`
- Typography: **visible label** — `font.family.heading`, `type.size.sm`. **Single-line values** (`text`, `search`) — `font.family.ui`, `type.size.sm` or `type.size.md`. **Textarea** (longer notes) — `font.family.body`, `type.size.md`
- Padding (internals): `space.2` vertical, `space.3` horizontal unless a dense filter row uses `space.2` horizontal
- Motion: focus ring transition `motion.duration.fast`; no layout-affecting animations on the feed row the input sits in

## Rules

1. Always pair with a visible label.
2. For errors, show `critical` semantic color plus explanatory text ([color minimums](../foundations/color.md) apply to any error stripe).
3. Keep helper text concise and action-oriented.