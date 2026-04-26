# Button

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [color](../foundations/color.md) · [spacing / radius](../foundations/spacing.md) · [typography](../foundations/typography.md) · [motion](../foundations/motion-and-feedback.md)

## Purpose

Primary and secondary actions with clear urgency handling.

## Variants

- `primary`: `--primary` background, `--primary-foreground` label
- `secondary`: `--card` background, `--border` border, `--foreground` label
- `ghost`: transparent background, `hsl(var(--primary))` label
- `critical`: `--destructive` background, `--destructive-foreground` label (destructive / high-risk only)

## States

Default, hover, active, disabled, focus-visible (`--ring`).

## Token usage

- Background: `--primary` / `--destructive` (via `hsl(var(...))`)
- Text: `--primary-foreground` or `--foreground`
- Radius: `rounded-md` (default for buttons — [spacing](../foundations/spacing.md))
- Padding: `py-2 px-4` (tighten vertical with `py-1` only if control height still ≥ practical click target)
- Typography: label uses `font-sans`, `font-medium` or `font-semibold`; `text-sm` or `text-base`
- Motion: transitions use `--transition-base`; respect `prefers-reduced-motion` via [tokens.css](../tokens/tokens.css)

## Content rules

1. Verb-first labels (`Review update`, `Send response`).
2. Avoid more than one primary button in the same action group.
