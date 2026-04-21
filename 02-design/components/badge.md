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

- Font: `font.family.ui`, `type.size.xs`, `font.weight.medium` ([typography](../foundations/typography.md) — `xs` reserved for badges)
- Shape: `radius.pill`
- Padding: `space.1` vertical, `space.2` horizontal; use `space.0` only between stacked icon + badge if needed ([spacing](../foundations/spacing.md))
- Min height: **22px** target for tap/readability ([color](../foundations/color.md) minimums table)
- Semantic fills: pair `*.soft` background with `*.base` text for warning/critical/success variants

## Rules

1. Keep labels short (one to three words).
2. Reserve critical badges for genuinely high-priority items.
3. Avoid placing more than three badges in a single row.