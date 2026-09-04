# Badge

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [color](../foundations/color.md) · [spacing / radius](../foundations/spacing.md) · [typography](../foundations/typography.md)

## Purpose

Compact categorical or state labeling in lists, cards, and timelines.

## Variants

- `neutral`
- `accent`
- `success`
- `warning`
- `critical`

## Token usage

- Font: `font-sans`, `text-xs`, `font-medium` ([typography](../foundations/typography.md) — `text-xs` reserved for badges)
- Shape: `rounded-full`
- Padding: `py-1 px-2`; use `gap-px` only between stacked icon + badge if needed ([spacing](../foundations/spacing.md))
- Min height: **22px** target for tap/readability ([color](../foundations/color.md) minimums table)
- Semantic fills: pair `--ember-soft` bg with `--ember` text for warning/emphasis; `--accent` bg with `--signal-positive` text for success; `--destructive` text for critical treatment

## Rules

1. Keep labels short (one to three words).
2. Reserve critical badges for genuinely high-priority items.
3. Avoid placing more than three badges in a single row.
