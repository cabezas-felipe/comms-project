# Button

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [color](../foundations/color.md) · [spacing / radius](../foundations/spacing.md) · [typography](../foundations/typography.md) · [motion](../foundations/motion-and-feedback.md)

## Purpose

Primary and secondary actions with clear urgency handling.

## Variants

- `primary`: `color.accent.`* background, `color.text.inverse` label
- `secondary`: `color.surface.default` background, `color.border.default` border, `color.text.primary` label
- `ghost`: transparent background, `color.accent.base` label
- `critical`: `color.critical.base` background, `color.text.inverse` label (destructive / high-risk only)

## States

Default, hover, active, disabled, focus-visible (`color.focusRing`).

## Token usage

- Background: `color.accent.base` / `color.critical.base` (and hover/active tokens when implementing)
- Text: `color.text.inverse` or `color.text.primary`
- Radius: `radius.md` (default for buttons — [spacing](../foundations/spacing.md))
- Padding: `space.2` vertical, `space.4` horizontal (tighten vertical with `space.1` only if control height still ≥ practical click target)
- Typography: label uses `font.family.ui`, `font.weight.medium` or `font.weight.semibold`; `type.size.sm` or `type.size.md`
- Motion: transitions use `motion.duration.fast` + `motion.easing.standard`; respect `prefers-reduced-motion` via [tokens.css](../tokens/tokens.css)

## Content rules

1. Verb-first labels (`Review update`, `Send response`).
2. Avoid more than one primary button in the same action group.