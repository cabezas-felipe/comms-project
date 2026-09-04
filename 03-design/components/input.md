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

- Surface: `--input` / `--card`
- Border: `--border`; error: `--destructive` (border or ring, plus message — not color-only)
- Radius: `rounded-md` (default for inputs — [spacing](../foundations/spacing.md))
- Focus ring: `--ring`
- Value text: `--foreground`
- Placeholder / helper: `--muted-foreground`
- Typography: **visible label** — `font-sans`, `text-sm`. **Single-line values** (`text`, `search`) — `font-sans`, `text-sm` or `text-base`. **Textarea** (longer notes) — `font-sans`, `text-base`
- Padding (internals): `py-2 px-3` unless a dense filter row uses `px-2`
- Motion: focus ring transition uses `--transition-base`; no layout-affecting animations on the feed row the input sits in

## Rules

1. Always pair with a visible label.
2. For errors, show `--destructive` semantic color plus explanatory text ([color minimums](../foundations/color.md) apply to any error stripe).
3. Keep helper text concise and action-oriented.
