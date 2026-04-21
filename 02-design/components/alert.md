# Alert

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [color](../foundations/color.md) · [spacing / radius](../foundations/spacing.md) · [motion](../foundations/motion-and-feedback.md)

## Purpose

Show contextual system or workflow states requiring attention.

## Variants

- `info`: `color.accent.soft` background + `color.accent.base` title/icon
- `success`: `color.success.soft` + `color.success.base`
- `warning`: `color.warning.soft` + `color.warning.base`
- `critical`: `color.critical.soft` + `color.critical.base`

## Required content

- Status label (`Warning`, `Critical`, etc.)
- One sentence explanation
- Optional next action link/button

## Token usage

- Radius: `radius.lg` when the alert is a panel; `radius.md` for compact inline banners
- Padding: `space.4`; gap icon → text `space.3`
- Border (optional): `color.border.default` or variant-colored **≥ 3px** left rail per [color](../foundations/color.md) minimums
- Motion: appear/settle with opacity ≤ `motion.duration.fast`; no lateral shimmer ([motion](../foundations/motion-and-feedback.md))

## Rules

1. Do not rely on color alone; include icon and text label.
2. Critical alerts should include a direct recovery action.
3. Keep no more than one critical alert visible per view unless incidents are independent.