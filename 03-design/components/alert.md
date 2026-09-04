# Alert

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [color](../foundations/color.md) · [spacing / radius](../foundations/spacing.md) · [motion](../foundations/motion-and-feedback.md)

## Purpose

Show contextual system or workflow states requiring attention.

## Variants

- `info`: `--accent` background + `--ember` title/icon (neutral emphasis)
- `success`: `--accent` background + `--signal-positive` title/icon
- `warning`: `--ember-soft` background + `--signal-warning` title/icon
- `critical`: `--destructive-foreground` text on `--destructive` background, or `--destructive` left-rail on `--card` bg for softer treatment

## Required content

- Status label (`Warning`, `Critical`, etc.)
- One sentence explanation
- Optional next action link/button

## Token usage

- Radius: `rounded-lg` when the alert is a panel; `rounded-md` for compact inline banners
- Padding: `p-4`; gap icon → text `gap-3`
- Border (optional): `--border` or variant-colored **≥ 3px** left rail per [color](../foundations/color.md) minimums
- Motion: appear/settle with opacity ≤ `--transition-base`; no lateral shimmer ([motion](../foundations/motion-and-feedback.md))

## Rules

1. Do not rely on color alone; include icon and text label.
2. Critical alerts should include a direct recovery action.
3. Keep no more than one critical alert visible per view unless incidents are independent.
