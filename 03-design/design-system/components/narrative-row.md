# Narrative row

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md) · [motion](../foundations/motion-and-feedback.md)
**Related:** [Story-status pill](badge.md) · [Metastory open state](../patterns/metastory-open.md)

## Purpose

The primary scanning unit in Tempo's dashboard feed. Each row is one meta-story with status, quiet tags, headline, one-line dek, and evidence meta. Rows are how a solo comms operator triages what changed and what needs attention — typically a ranked set of **≤5** items on home.

## Anatomy

```
[status pill]  [tags · desktop max 3 · mobile max 1 · +n]   [relative · n sources]  [chevron]
[headline]
[dek — one line]
[open body — when expanded; see metastory-open]
[freshness — after last row only; see Time and evidence]
```

No left status rail. Whole row is the tap target. Trailing **chevron** marks expand/collapse on every row.

## Expand / collapse (chevron)

| State | Chevron | Behavior |
| --- | --- | --- |
| Collapsed | ∨ (points down) | `--ink-muted`; trailing in meta-right with evidence |
| Open | ∧ (points up) | Same placement; flips to show dismiss |
| Interaction | — | Whole-row tap toggles; chevron is the explicit affordance (accordion pattern) |
| Single open | — | Only one row expanded at a time |

Do **not** use text “Close” or +/- as the primary collapse control.

> **Not step-back.** For previous screen / parent sheet, use [back affordance](back-affordance.md) (`--ink-primary` chevron or `Back to {Destination}`) — not this muted expand control.

## Status signal (pills-only)

| Signal | Rule |
| --- | --- |
| **Status pill** | Mandatory. Rising / Stable / Falling via [story-status pill](badge.md). This is the **primary** status cue. |
| **Left rail** | **Do not use** on narrative rows. Rails stay for [alerts](alert.md) and optional dense [cards](card.md) — not the home feed. |
| **Headline color** | Always `--ink-primary`. Do not tint Stable / Falling headlines by status; the pill carries status so the feed stays calm (dp1). |
| **Headline weight** | Rising / Stable: `font-semibold`. Falling: `font-medium` (slight de-emphasis without color shift). |

## Variants

### Rising row

| Property | Value |
| --- | --- |
| Status pill | [Story-status pill](badge.md) — Rising |
| Row background | `--surface-page` · optional `--status-rising-soft` tint on hover only |
| Headline | `font-display` (Newsreader), `text-lg`, `font-semibold`, `--ink-primary` |
| Dek | `font-sans`, `text-sm`, `--ink-muted`, one line |
| Tags | Quiet text, not interactive — see Tag rules |
| Evidence meta | Right of pill row — see Time and evidence |
| Chevron | Trailing; ∨ collapsed / ∧ open |

### Stable row

Same structure as Rising. Pill = Stable. Headline weight `font-semibold`, color `--ink-primary`.

### Falling row

Same structure. Pill = Falling. Headline weight `font-medium`, color `--ink-primary`.

## Tag rules

| Rule | Detail |
| --- | --- |
| Unique | No duplicate tags on one row |
| Cap | Desktop: max **3** visible. Mobile: max **1** visible. Overflow as `+n` with **no** middot before `+n` (e.g. `Migration +2`) |
| Priority | Filter matches first · then Topics → Keywords → Geographies |
| Style | `font-sans`, `text-sm`, `--ink-muted` — not chips, **not tappable** |

**Not Sources overflow.** Tag `+n` is inert metadata (same muted treatment as the tags). Open-body Sources `+n` on desktop is a **tappable** disclose control (`--ink-primary` + medium) — see [metastory-open — Sources](../patterns/metastory-open.md#sources). Do not style them the same.

## Time and evidence

Right-aligned on the meta row with tags, **before** the chevron:

`{relative} · {n} sources`

| Piece | Format | Example |
| --- | --- | --- |
| Relative | Compact unit, **no** `ago` | `12m`, `2h` — see [typography — time notation](../foundations/typography.md#time-notation-product-ui) |
| Absolute clock (freshness, elsewhere) | `h:mm` + lowercase `a`/`p`, **no space** | `12:51p`, `9:05a` |
| Evidence noun | Always **sources** | `8 sources` |

Do not mix `PM` / `AM` with compact `m` / `h` on the same product surfaces. See [typography — time notation](../foundations/typography.md#time-notation-product-ui).

### Feed freshness (footer)

After the **last** narrative row in the feed column (document flow), not viewport-sticky.

**On schedule**

`Next update in ~{duration}`  
`Updated {absolute clock}`

| Rule | Detail |
| --- | --- |
| Placement | Sibling after the last row inside the feed stack — all Dashboard states (All · Editing · Idle · Open), desktop and mobile |
| Not | Fixed / sticky to the bottom of the viewport or artboard chrome |
| Style | `font-sans`, `text-xs`, both lines `--ink-muted` |
| Why | Freshness is system status for the brief, not ambient chrome; it travels with the feed end (dp1) |

**Stale / delayed** (pipeline behind schedule — and **refresh fail** with prior feed; same UI)

`Next update delayed`  
`Updated {absolute clock}`  
`Update now`

| Rule | Detail |
| --- | --- |
| Placement | Same footer slot as on-schedule freshness |
| Hierarchy | Status (secondary) → last success (muted) → action (`Update now`, `--ink` + `font-medium`) as third line. Story before agency. **Equal** `gap` between all three lines (same as two-line freshness) — do not add extra space before the action; ink/weight carry affordance |
| Style | Delay `--ink-secondary`; clock `--ink-muted`; `Update now` `--ink` medium — quiet text action, not a button |
| Shared with | Refresh fail after `Updating…` snaps here (no toast, no distinct fail string). Routine delay uses the same band |
| Not | `--signal-warning` ink; Alert · Warning (reserve for sustained do-not-trust + recovery); Rising misuse; toast as primary signal; Populate error while feed exists; `Update now` first in the stack |
| Why | Surfaces uncertainty (dp6) and voluntary pull under pressure without urgency chrome (dp1) |
| Specimens | 06: [Home · Stale freshness](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/P79-0) |

**Refreshing** (scheduled soft refresh — prior feed stays; content may change)

`Updating…`  
`Updated {absolute clock}`

| Rule | Detail |
| --- | --- |
| Placement | Same footer slot as on-schedule / stale freshness |
| Style | First line `--ink-secondary`; clock stays `--ink-muted` (last successful update). No progress hairline in the footer |
| Interaction | Fully interactive. Open metastory stays pinned until the user closes it or opens another (even if it drops from the new feed) |
| Settle | Silent → on-schedule freshness. Fail with prior feed → **Stale** (+ `Update now`; not Populate error). Empty-shell fail → Populate error |
| Sequence | Stale → Refreshing → settle (same slot) |
| Specimens | 06: [Home · Refresh](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/PPD-0) |

## Separators (hairlines)

| Rule | Detail |
| --- | --- |
| Between rows | `1px` solid `--border` (`#E8E6E4`) under each row **except** the last |
| Open under-dek | Same token, weight, and **length** as between-row hairlines (full row / feed measure). Do not shorten or inset when the row is open — see [metastory-open](../patterns/metastory-open.md) |
| Not | Full cards, heavy rules, or status-colored dividers |
| Why | Without a left rail, soft hairlines restore row boundaries for scan (dp4) while keeping calm density. Matched length keeps open/closed rhythm stable |

## Open state

Expanded content, labels, spacing, Actions / Sources, and platform-honest brief CTAs live in [metastory-open.md](../patterns/metastory-open.md). Implication-style judgment is **Why this matters** in that pattern (no status wash by default).

**Surface:** Meta / title / dek stay `--surface-page`. Only the open body uses `--surface-raised` with `16px` inset padding — see metastory-open Container.

## Token usage summary

| Property | Rising | Stable | Falling |
| --- | --- | --- | --- |
| Pill bg | `--status-rising-soft` | `--status-stable-soft` | `--status-falling-soft` |
| Pill text | `--status-rising` | `--status-stable` | `--status-falling` |
| Headline | `--ink-primary` | `--ink-primary` | `--ink-primary` |
| Hairline | `--border` | `--border` | `--border` |
| Chevron | `--ink-muted` | `--ink-muted` | `--ink-muted` |

## Usage rules

1. **Status pill is mandatory; left rail is forbidden** on narrative rows in the dashboard feed.
2. **Hairlines between meta-stories** (not after the last). Prefer `--border` over `--border-strong`.
3. **Whole-row tap** toggles open/closed. **Chevron on every row** (∨ / ∧) — not text Close.
4. **Single expand** at a time on the home feed.
5. **Do not animate row height** during status changes. Instant swap only.
6. **Do not reorder rows mid-session without a visible explanation.**
7. **Mobile tags: max 1 + `+n`.** Desktop stays max 3.
8. **Freshness after the last row only** — never sticky to the viewport bottom.
