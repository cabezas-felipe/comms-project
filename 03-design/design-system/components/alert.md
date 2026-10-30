# Alert

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [motion](../foundations/motion-and-feedback.md)

## Variants

### Info

For neutral system messages or contextual guidance. Not for story status.

| Property | Value |
| --- | --- |
| Background | `--surface-raised` |
| Left rail / icon | `--ink-muted` |
| Title | `--ink-primary` |

### Warning

For operational caution — system limitations, degraded signals, stale data. Never for story status.

| Property | Value |
| --- | --- |
| Background | `--surface-raised` |
| Left rail / icon | `--signal-warning` |
| Title | `--ink-primary` |

### Critical

For high-urgency operational alerts requiring immediate action — missed send window, API failure, authentication error.

| Property | Value |
| --- | --- |
| Background | `--surface-raised` with `--destructive` left rail |
| Left rail | `3px` solid `--destructive`, full alert height |
| Title | `--destructive` |

## Required content

- Status label in title ("Warning", "Connection error", etc.)
- One sentence explanation
- Optional: recovery action link or button

## Token usage

| Property | Value |
| --- | --- |
| Radius | `rounded-lg` (panel alerts) · `rounded-md` (compact inline banners) |
| Padding | `p-4` |
| Icon → text gap | `gap-3` |
| Border (optional) | `--border` or variant-colored `≥ 3px` left rail |
| Appear motion | Opacity fade ≤ `--transition-base`; no lateral slide |

## Usage rules

1. **Do not use alerts for story status.** Rising / Stable / Falling is expressed through [narrative-row.md](narrative-row.md) and [badge.md](badge.md) — not alerts.
2. **Do not rely on color alone.** Every alert includes an icon and a text label.
3. **Critical alerts include a direct recovery action.** Do not leave the user with a dead-end error.
4. **No more than one critical alert per view** unless incidents are independently actionable.
