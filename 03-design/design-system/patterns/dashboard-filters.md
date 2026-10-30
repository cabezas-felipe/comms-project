# Dashboard filters

**Foundations:** [color](../foundations/color.md) · [typography](../foundations/typography.md) · [spacing](../foundations/spacing-and-radius.md)
**Related:** [Narrative row](../components/narrative-row.md) · [Monitoring workflow](monitoring-workflow.md)

## Purpose

Home-dashboard chrome for attention triage: choose a lens (Mode), optionally edit tags in a category (Select), and see the committed filter set (Always-on). Free-floating text only — not pills. Removable pill chips belong to **scope editing** (onboarding verify / Account · Your scope), not this chrome.

## Anatomy

```
Mode:       All · Topics · Keywords · Geographies
Select:     [category tags…]          ← editing only; hidden when idle
Always-on:  [committed tags…]         ← hidden when Mode = All
```

## States

| State | Visible rows | When |
| --- | --- | --- |
| **All** | Mode only (`All` active) | Unfiltered home |
| **Filtered · idle** | Mode + Always-on | Lens active; user not editing tags |
| **Filtered · editing** | Mode + Select + Always-on | User opened Topics / Keywords / Geographies to change tags |

Keywords and Geographies use the **same** Select / Always-on logic as Topics. Do not require separate exploration screens for each category.

## Mode

| Rule | Detail |
| --- | --- |
| Options | `All` · `Topics` · `Keywords` · `Geographies` |
| Empty | No Always-on tags in that category → `--ink-muted` + `font-normal` |
| Contributing | Has Always-on tags; not open for edit → `--ink-primary` + `font-semibold` when **idle**; `--ink-secondary` + `font-medium` when **another** category is open |
| Open | Category whose Select row is visible (editing only) → `--ink-primary` + `font-semibold` |
| Multi-active | When Always-on includes tags from more than one category, each contributing category stays non-empty on Mode (e.g. Topics + Geographies). `All` is off. |
| `All` | Clears Always-on; Select hidden |

**Editing vs idle:** Idle uses one loud style for every contributing category (no open cue). Editing splits open vs contributing-closed so “which category am I changing?” is readable without chips or underlines.

## Select (editing)

| Rule | Detail |
| --- | --- |
| Content | Tags in the **open category only** — no second `All` |
| Unselected | `--ink-muted` + `font-normal` |
| Selected (in this picker) | `--ink-secondary` (`#505054`) + `font-medium` |
| Behavior | Tap toggles membership in Always-on immediately |
| Dismiss | Click outside the filter stack, Esc, or switch Mode category → return to **Filtered · idle** (Select hidden). **No Done** control |

## Always-on (committed)

| Rule | Detail |
| --- | --- |
| Content | Live filters across categories (order stable; typically Topics → Keywords → Geographies) |
| Style | `--ink-primary` + `font-semibold` — loudest filter chrome (durable lens) |
| Clear | Last tag off → Mode returns to `All`; or tap Mode · `All` |
| No Clear control | Tap tags on/off; no bulk Clear |

## Layout

| Property | Desktop | Mobile |
| --- | --- | --- |
| Stack gap between Mode / Select / Always-on | `12px` | `12px` |
| Filter stack → first narrative row | `24px` bottom padding | `16px` bottom padding |
| Mobile artboard (Paper / comps) | — | Min **844** tall; **extend height** when content exceeds (same as onboarding non-keyboard mobiles). Keyboard comps stay **844**. |
| Treatment | Free text + gap — **not** pills, chips, or underlines required |

## Do / don’t

1. **Do** keep filter chrome typographic; **don’t** reuse story-status pills or scope-edit chips here.
2. **Do** keep Always-on visually stronger than Select-selected.
3. **Do** split open vs contributing-closed on Mode while editing; **don’t** use the same primary/semibold for both.
4. **Don’t** add Done / Clear / Apply for v1 happy path.
5. **Don’t** invent a third accent for filters — ink steps only.
