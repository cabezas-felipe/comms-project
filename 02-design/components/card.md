# Card

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [color](../foundations/color.md) · [spacing / radius](../foundations/spacing.md) · [typography](../foundations/typography.md)

## Purpose

Group related monitoring information into scannable units.

## Structure

- Optional header (title + metadata)
- Body content
- Optional footer actions

## Token usage

- Background: `color.surface.default` (active context / selection: `color.surface.selected`)
- Border: `color.border.default` (selection: `color.border.selected`)
- Radius: `radius.lg` (cards / panels — [spacing](../foundations/spacing.md))
- Padding: `space.4` or `space.5`; gap header → body `space.3` or `space.4`
- Title: `font.family.heading`, `type.size.lg`, `font.weight.semibold`
- Metadata (source, time, channel): `font.family.ui`, `type.size.sm`, `color.text.muted`
- Optional excerpt or quote: `font.family.body`, `type.size.sm` or `type.size.md`, `color.text.primary`

## Rules

1. Prefer one primary message per card.
2. Use muted metadata for source/time so headline remains dominant.
3. For “new since last check,” add an **accent** left rail **≥ 3px** and a text label ([color](../foundations/color.md)).
4. When a card is the active context, use selection neutrals — not a full `accent` fill ([color](../foundations/color.md)).