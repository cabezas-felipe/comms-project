# Back affordance

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [typography](../foundations/typography.md) · [spacing and radius](../foundations/spacing-and-radius.md)
**Related:** [Button](button.md) (Ghost) · [Modal](modal.md) (× dismiss — not back) · [Layout shell](layout-shell.md) · [Narrative row](narrative-row.md) (expand chevron — not back)
**Principles:** [dp1 — Calm by default](../../principles.md)

> Working pattern (v1.2.17). Encoded from Account sheet chrome + onboarding Check inbox mobile; Link expired (`o02c`) aligned to the same chevron. Onboarding mobile title-lock (empty 44px Nav when no back) locked so form headlines share one vertical origin across the journey.

## Purpose

Navigate to a **previous step or parent surface** without competing with the screen’s Primary. Two treatments — platform-specific — keep hierarchy calm and consistent.

## When to use which

| Context | Treatment |
| --- | --- |
| **Mobile** — onboarding step, Account sheet, recovery states (e.g. link expired) | **Chevron-only** |
| **Desktop** — in-app sheets (Account, Terms, similar) | **Text link** naming the parent with its page title — sentence case, no period (e.g. `Your dashboard`, `Your scope`). Not bare `Back`. Not `Back to …` unless a future surface lacks a `Your …` title. |
| **Desktop** — onboarding Value / Email / Check inbox family | **No in-UI back** — browser history |
| Modal dismiss | Use modal **×** — not this pattern ([modal](modal.md)) |
| Feed expand / collapse | Use narrative-row chevron — not this pattern ([narrative-row](narrative-row.md)) |

## Mobile — chevron

| Property | Value |
| --- | --- |
| Glyph | Left chevron (‹), stroke only |
| Stroke | `--ink-primary` (`#141416`) — Paper/prototype: `var(--color-ink)` |
| Stroke weight | `1.5` |
| Line caps | `square` |
| Glyph size | **24×24** |
| Hit target | **≥44×44** (wrap glyph in a centered hit frame) |
| Label | **None** — do not put a destination word (`Email`, `Settings`) beside the chevron. Form intro / page title names the job ([large-sheet](../patterns/large-sheet.md) · [form-intro](../patterns/form-intro.md)) |
| Accessible name | `Back` |
| Placement | Top of the form / sheet nav row (**≥44** hit) |
| Role | Ghost chrome ([button](button.md)) — ink, not muted |

**Do not** use `--ink-muted` for mobile back. Muted is for metadata, modal ×, and narrative expand chevrons — subordinate chrome, not step navigation.

## Desktop — text link (in-app)

| Property | Value |
| --- | --- |
| Copy | Parent page title, sentence case, no period — e.g. `Your dashboard`, `Your scope`. Matches Tempo ownership voice (`Your dashboard.`, `Your scope.`). Accessible name may still be `Back to {title}` for AT. Not bare `Back`. Not `Back to your dashboard`. |
| Font | `font-sans` (Inter), **13px** / **16** line-height, **medium** (500) |
| Color | `--ink-primary` |
| Role | Ghost ([button](button.md)) |
| Placement | Sheet chrome left (with optional section label after a hairline) |

## Desktop — onboarding split

On Value + Email, Check inbox, Link expired, and sibling onboarding desktops: **omit** an in-UI back control. Rely on browser history. Keeps the form region calm (dp1) and matches the locked product call for that family.

## Usage rules

1. **One back pattern per platform** — do not mix chevron + “Back” text on mobile, or invent a desktop chevron for Account sheets.
2. **Destination clarity on desktop** — use the parent’s page title (`Your dashboard`, `Your scope`).
3. **Do not confuse with dismiss or expand** — modal × and narrative ∨/∧ stay `--ink-muted` and are documented elsewhere.
4. **Hit target** — mobile chevron must remain ≥44×44 even when the glyph is 24×24.
5. **Onboarding mobile title-lock** — reserve a **44px** top Nav row on every mobile onboarding form screen in the journey (email → check inbox → profile → extracting → review), whether or not a chevron is present. Screens without back leave the row **empty** (no glyph, not interactive). This keeps form headlines on one vertical origin so entering/leaving Check inbox (or any chevron step) does not jump the title up/down. Same continuity idea as paired Extracting → Review ([motion](../foundations/motion-and-feedback.md)).
6. **Empty slot ≠ “no back” product state** — the blank 44px row is **layout chrome**, not a designed “back is unavailable” message. Do not style it as a disabled control. Do not invent a muted ghost chevron to “explain” the gap.
7. **Settings / reader large sheet** — same **44** chrome metrics as onboarding Nav. Overlay adds handle + **×**. Empty left when no step-back (Index · reader) — layout lock, not waste ([large-sheet](../patterns/large-sheet.md)).

## Anti-patterns

| Avoid | Why |
| --- | --- |
| `--ink-muted` mobile back | Reads as metadata; weaker than Ghost chrome; drifts from Account / Check inbox specimens |
| 20×20 glyph without 44 hit | Fails touch baseline |
| Round-cap chevron as the default | Specimens use square caps — keep one geometry |
| Desktop onboarding chevron | Conflicts with browser-back decision for that family |
| Bare `Back` on Account desktop | Loses parent orientation |
| `Back to your dashboard` / `Back to Account` | Instructional; drifts from Tempo `Your …` title voice — prefer `Your dashboard` / `Your scope` |
| Treating modal × rules as back rules | Different job (dismiss interrupt vs navigate step) |
| Dropping the 44px row on non-chevron onboarding mobiles | Titles jump when entering/leaving Check inbox (or other chevron steps) |
| Fake / disabled chevron in the title-lock slot | Implies back; use an empty reserved row instead |
| Row label beside ‹ on Settings / form sheets | Redundant with form intro; breaks shared mobile stack |
| 28×28 back hit on sheets | Fails touch baseline — keep ≥44 |
| Dropping the 44 chrome band on Index / reader sheets | Body origin drifts vs L1 / onboarding |
