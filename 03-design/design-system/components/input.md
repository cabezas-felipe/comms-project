# Input

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md) · [motion](../foundations/motion-and-feedback.md)

## Variants

- `text` — single-line structured entry (filter, metadata field)
- `search` — single-line with leading search icon; used for feed filtering
- `textarea` — multi-line for short notes and draft metadata

## States

Rest, focus, filled, error, disabled.

## Token usage

| Property | Value |
| --- | --- |
| Surface | `--surface-raised` |
| Border (rest) | `--border` |
| Border (error) | `--destructive` (border or ring, plus error message — not color alone) |
| Radius | `rounded-md` |
| Focus ring | `--ring` (`--status-rising` hue) |
| Value text | `--ink-primary` |
| Label font | `font-sans`, `text-sm`, `font-medium`, `--ink-muted` |
| Label casing | **Sentence case** — never `uppercase` / tracked small caps |
| Value font (`text`, `search`) | `font-sans`, `text-sm` or `text-base` |
| Value font (`textarea`) | `font-sans`, `text-base` |
| Placeholder / helper / example | `--ink-muted`; optional `e.g. …` when illustrating expected answer shape |
| Padding | Comfortable default: `py-4 px-[18px]` (match onboarding email / modal fields, min-height ~52px). Dense filter rows only: `px-2` / tighter. Avoid CTA-tight padding that makes the value kiss the border. |
| Focus transition | `--transition-base`; no layout-affecting animation on surrounding feed rows |

## Usage rules

1. **Always pair with a visible label.** Never rely on placeholder text alone as the label.
2. **Form field labels use sentence case** (`Email`, `Your priorities`). Do not use uppercase tracking — that pattern is reserved for **section metadata** in monitoring chrome (see [card](card.md), [narrative-row](narrative-row.md), [color](../foundations/color.md)).
3. **Label casing and style stay stable across rest, focus, filled, and error.** Do not switch to uppercase when a field is answered.
4. **Error states show `--destructive` border plus explanatory text.** Color alone is insufficient.
5. **Keep helper text concise and action-oriented.** Prefer "Enter the outlet name" over generic "Required field."
6. **Do not animate the feed column height** when an input within it gains focus.
7. **Never style an input like a Primary button.** Fill stays `--surface-raised` in rest, focus, and filled. Focus may add a stronger ink border or `--ring`; do not switch the field to white/page + ink outline (that is [button Primary (F)](button.md)).
8. **Resting border is quiet** (`--border` / `--border-strong`). Reserve `1.5px` `--ink-primary` for focus (or error uses `--destructive`).
