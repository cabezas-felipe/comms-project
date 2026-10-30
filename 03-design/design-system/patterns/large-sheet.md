# Large sheet

**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md)
**Related:** [Source reader](source-reader.md) · [Account menu](account-menu.md) · [Back affordance](../components/back-affordance.md) · [Modal](../components/modal.md) · [Form intro](form-intro.md)
**Principles:** [dp1 — Calm by default](../../principles.md) · [dp3 — Always within reach](../../principles.md)

> Working pattern (v1.2.52). **One chrome band** + **onboarding-aligned body air** on every large sheet. Form L1s share the mobile form stack with onboarding. Fullscreen onboarding mobiles inform sheet rhythm (similar, not exact).

## One stack, two shells

| | **Onboarding mobile** | **Large sheet** (Settings · reader) |
| --- | --- | --- |
| Job | Journey step = the screen | Pseudo-screen over a parent |
| Shell | Full-bleed `--surface-chrome` under status bar | Overlay ~85–90% / ~720px + handle + **30%** scrim |
| Chrome | **44** Nav (‹ or empty title-lock) | **Handle + 44 chrome** (‹ and/or ×) |
| Chrome → content | Column **gap 16** after Nav | Body **padding-top 16** after chrome (same step) |
| Dismiss | None (flow forward / system) | **×** always (top-right of chrome) |
| Body | Form stack / journey content | Form stack · Index list · or reader path |

## Sheet architecture (all large sheets)

```
[ Handle ~18 ]
[ Chrome 44 ]          ← left: ‹ | empty · right: ×
[ Body top air 16 ]    ← matches onboarding Nav → content gap
[ Body content ]
```

| Layer | Spec |
| --- | --- |
| **Handle** | Optional centered drag pill; fixed ~**18** band |
| **Chrome** | **Exactly 44** tall. Inline **24**. Centered row. No vertical padding that grows past 44. No hairline. |
| **Chrome left** | **‹** (≥44 hit) when step-back · **empty 44 slot** when not (Index · reader). Never a muted chevron. |
| **Chrome right** | **×** (`--ink-muted`) |
| **Body top** | **16px** padding-top on every sheet body (Index · L1 · reader) — same as onboarding mobile column `gap` after Nav |
| **Body gutter** | **24px** inline |
| **Body bottom** | ~**28px** padding-bottom |

### Chrome by surface

| Surface | Left | Right | Body starts with (after 16 air) |
| --- | --- | --- | --- |
| Settings Index | empty | × | Primary list |
| Settings L1 | ‹ | × | [Form intro](form-intro.md) |
| Source reader | empty | × | Outlet → meta → title / post → snippet (press = Tempo article summary when present) → `Open original` ↗ |

## Settings Index list

| Layer | Spec |
| --- | --- |
| **Primary rows** | Email · Sign out · Delete — **equal** rhythm: `minHeight` **48**, **symmetric** `paddingBlock` **14**, `align-items: center`. No first-row special case. |
| **Legal footer** | Keep one line `Terms · Privacy` (middot, muted ~14). **Section gap** `padding-top` **32** above the line (not a fourth peer row). Not equal to primary row pitch. |

## Shared mobile form stack (Settings L1 · onboarding cousin)

| Layer | Spec |
| --- | --- |
| **Chrome / Nav** | Sheet **44 chrome**; onboarding **44** Nav |
| **Air after chrome** | **16** (sheet body top · onboarding column gap) |
| **Gutter** | **24** |
| **Form intro** | Newsreader **32** / **38**, `600`, `-0.015em` · support Inter **15** / **24** muted · intro **gap 12** |
| **Fields → CTAs** | Matching readiness · CTA column **gap 12** |

## Shell (overlay only)

| Rule | Detail |
| --- | --- |
| Height | ~**85–90%** (~**720px** on 844) |
| Surface | `--surface-chrome` |
| Top corners | ~**12px** |
| Scrim | `--ink-primary` **30%** |
| Dismiss | × · scrim · Esc · swipe |

## Desktop cousin

Docked ~400px panels: same content contract; not a bottom sheet. Desktop form intro **36** / **44**. Prefer the same **16** air under panel chrome when the panel uses ‹/×.

## Anti-patterns

| Avoid | Why |
| --- | --- |
| Per-sheet chrome heights | Body origin drifts |
| Vertical padding growing chrome past **44** | Same |
| First Index row with `padding-top: 0` to chase ink | Unequal list rhythm — use body **16** air instead |
| Legal as equal-pitch fourth row | Footer/meta, not Settings work |
| Outlet inside the **44** chrome | Inflates chrome; identity in body |
| Modal **45%** scrim on sheets | Keep **30%** |

## Usage rules

1. Every large sheet: Handle → **44 chrome** → **16 body air** → content.
2. Empty left when no step-back; **‹** when step-back; **×** always on overlays.
3. Index primary rows equal; legal = section gap **32** + middot line.
4. Onboarding mobile **gap 16** after Nav is the reference for sheet body air — similar shells, shared rhythm.
