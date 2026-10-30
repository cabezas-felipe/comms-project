# Card

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md)

## Variants

### Monitoring card

Groups a cluster of related story signals — e.g. a source cluster, a theme summary, or an implication set — into a scannable unit.

| Property | Value |
| --- | --- |
| Background | `--surface-raised` (default) · `--surface-page` (active/selected) |
| Border | `--border` |
| Radius | `rounded-lg` |
| Padding | `p-4` or `p-5` |
| Title | `font-display` (Newsreader), `text-lg`, `font-semibold`, `--ink-primary` |
| Metadata (source, time) | `font-sans`, `text-sm`, `--ink-muted` |
| Body / snippet | `font-sans`, `text-sm` or `text-base`, `--ink-secondary` (press source-reader snippet = Tempo article summary when present — not publisher body) |

### Rising-signal card

A monitoring card containing a Rising-status story. Adds a **3px left rail** in `--status-rising` to the card's leading edge.

| Property | Value |
| --- | --- |
| Left rail | `3px` solid `--status-rising` — full card height |
| Title | `--ink-primary` |
| Status indicator | [Story-status pill](badge.md) ("Rising") required alongside title or metadata |

### Brief section card

Used to group the Morning Brief's implication strip and related actions.

| Property | Value |
| --- | --- |
| Background | `--surface-page` |
| Border | `1px solid --border` |
| Radius | `rounded-lg` |
| Section label | `font-sans`, `text-xs`, uppercase tracking, `--ink-muted` |

## Usage rules

1. **One primary message per card.** If a card needs to convey two distinct stories, it should be two cards.
2. **Muted metadata keeps the headline dominant.** Do not bump `--ink-secondary` into headline territory for source or time labels.
3. **Active selection uses `--surface-page`**, not `--status-rising-soft`. Reserve Rising-soft for explicit story-status tinting in narrative rows.
4. **Rising-signal rail is `≥ 3px` wide, full card height.** Never a dot or a thin underline alone — pair with the status pill.
5. **Do not animate card height on status changes.** Use instant swap or a single overlay per [motion.md](../foundations/motion-and-feedback.md).
