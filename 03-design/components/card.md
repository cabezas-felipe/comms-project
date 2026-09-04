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

- Background: `--card` (active context / selection: `--secondary`)
- Border: `--border`
- Radius: `rounded-lg` (cards / panels — [spacing](../foundations/spacing.md))
- Padding: `p-4` or `p-5`; gap header → body `gap-3` or `gap-4`
- Title: `font-display`, `text-lg`, `font-semibold`
- Metadata (source, time, channel): `font-sans`, `text-sm`, `--muted-foreground`
- Optional excerpt or quote: `font-sans`, `text-sm` or `text-base`, `--foreground`

## Rules

1. Prefer one primary message per card.
2. Use muted metadata for source/time so headline remains dominant.
3. For "new since last check," add an **ember** left rail **≥ 3px** and a text label ([color](../foundations/color.md)).
4. When a card is the active context, use `--secondary` — not a full `--primary` or `--ember` fill ([color](../foundations/color.md)).
