# Badge

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md)

## Variants

### Story-status pill

The primary badge type in Tempo. A pill-shaped label indicating whether a narrative is Rising, Stable, or Falling. Always renders upright (no italic).

| Status | Background | Text | Label |
| --- | --- | --- | --- |
| Rising | `--status-rising-soft` (`#F2E4D0`) | `--status-rising` (`#B85C28`) | "Rising" |
| Stable | `--status-stable-soft` (`#E0E0E6`) | `--status-stable` (`#686870`) | "Stable" |
| Falling | `--status-falling-soft` (`#EAEAEE`) | `--status-falling` (`#909098`) | "Falling" |

Hex matches [color](../foundations/color.md) / [design-tokens.json](../tokens/design-tokens.json). Soft fill + ink-on-soft text — **never** solid Rising fill with white label. Stable / Falling are cool-gray steps (not warm gravel) so only Rising earns copper.

Font: `font-sans`, `text-xs`, `font-semibold`, uppercase tracking. Shape: `rounded-full`. Padding: `py-1 px-2`. Min height: **22px**.

### Categorical label

A non-status badge for **editable membership** in a list: onboarding scope verify, Account · Your scope (Topics / Keywords / Geographies / Sources). Typically shown with a remove control (×).

Font: `font-sans`, `text-xs`, `font-medium`. Background: `--surface-raised`. Text: `--ink-secondary`. Shape: `rounded-full`. Padding: `py-1 px-2`.

**Not for:** home dashboard Mode / Select / Always-on, or quiet tags on [narrative rows](narrative-row.md). Those stay **free-floating text** — see [dashboard filters](../patterns/dashboard-filters.md).

### Signal label (operational)

For operational system states (not story status). Used sparingly inside alerts and error states.

| Variant | Background | Text |
| --- | --- | --- |
| Success | `--signal-positive` at 10% opacity | `--signal-positive` |
| Warning | `--signal-warning` at 10% opacity | `--signal-warning` |
| Destructive | `--destructive` at 10% opacity | `--destructive` |

Always paired with an icon and visible text label — never color alone.

## Usage rules

1. **Story-status pills are always one of three values** — Rising, Stable, Falling. Do not invent new status labels or colors without a DS change.
2. **Signal labels are for operational UI states only** — not for story status. Do not use `--signal-warning` as a proxy for "important story."
3. Keep labels short (one to three words).
4. Do not place more than one story-status pill per narrative row — the pill is the primary status cue ([narrative-row](narrative-row.md) is pills-only; no left rail on feed rows).
5. Min height of **22px** for any pill — never smaller, for readability and tap target.
6. **Two tag languages:** Removable **categorical pills** = edit membership (onboarding / Account scope). **Free text** = dashboard filter chrome and narrative-row meta. Do not use pills for Mode / Select / Always-on.
