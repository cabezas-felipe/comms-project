# AI usage guide

Use this file when prompting Cursor, Claude Code, v0, or other prototyping tools.

## Instruction block (copy-paste)

Use the design system in `03-design/design-system/` as the source of truth.

Required references:

1. `03-design/design-system/tokens/design-tokens.json` — canonical token values (Option-C semantic names)
2. `03-design/design-system/tokens/tokens.css` — CSS custom properties
3. `03-design/design-system/foundations/*.md` — color, typography, spacing, motion, **viewports**
4. `03-design/design-system/components/*.md` — component behavior and constraints
5. `03-design/design-system/patterns/monitoring-workflow.md` — domain pattern
6. `03-design/design-system/patterns/dashboard-filters.md` — home Mode / Select / Always-on
7. `03-design/design-system/patterns/metastory-open.md` — in-feed story expand
8. `03-design/design-system/patterns/form-intro.md` — onboarding / Account headline + continuous support
9. `03-design/design-system/components/back-affordance.md` — mobile back chevron · desktop destination title (`Your dashboard`)
10. `03-design/design-system/patterns/account-menu.md` — Settings trigger → docked panel (desktop) ≡ sheet (mobile)
11. `03-design/design-system/patterns/system-surfaces.md` — splash · generic fatal error
12. `03-design/design-system/patterns/scope-gates.md` — Tags / Context hard gates + thin counsel
13. `03-design/design-system/foundations/viewports.md` — artboard sizes (`1440×900` · `1024×768` · `390`)

**Prototype note:** `05-prototype/src/index.css` uses shadcn-style names (`--background`, `--foreground`, `--ember`). See `03-design/design-system/ds-mapping.md` for the bridge.

Constraints:

- Do not reference `03-design/archive/` as a source of truth unless explicitly requested.
- Use Tailwind spacing classes (`p-4`, `gap-3`, etc.) for layout; see density guidance in [foundations/spacing-and-radius.md](foundations/spacing-and-radius.md).
- Honor `prefers-reduced-motion` (see [tokens.css](tokens/tokens.css) and [foundations/motion-and-feedback.md](foundations/motion-and-feedback.md)). No lateral shimmer on feed skeletons. When a skeleton/loading screen and its destination share chrome, keep hero and first content band vertically locked (top-align; reserve helper height).
- Do not invent new color values. Use `hsl(var(--token))` with named CSS vars from [tokens/tokens.css](tokens/tokens.css).
- Prefer semantic tokens over hard-coded styles.
- **Font:** `font-display` (Newsreader) for narrative headlines, Brief title, and section headers. `font-sans` (Inter) for all UI chrome, feed metadata, labels, buttons, and body copy. Do not use italic in display roles.
- **Label casing:** Form field labels are **sentence case** (see [input.md](components/input.md)). Uppercase + tracking is only for section metadata in feed/card chrome; never for inputs, and never change casing when a field is filled.
- **Punctuation (product UI):** No em dashes (`—`). Prefer period, comma, or colon. En dash (`–`) OK for ranges (e.g. Colombia–US). See [typography](foundations/typography.md#punctuation-product-ui).
- **Time (product UI):** Relative `12m` / `2h` / `3d` — **no** `ago`; absolute `12:51p` / `9:05a` (lowercase letter, no space). Floor to largest unit. Never `AM`/`PM` beside compact `m`/`h`. See [typography](foundations/typography.md#time-notation-product-ui).
- **Status system:** use `--status-rising` / `--status-stable` / `--status-falling` for story-status semantics. Use `--signal-warning` / `--destructive` for operational system states only. Never swap them.
- **Surfaces:** `--surface-page` = canvas; `--surface-chrome` = top bars, modal panels, **source reader**, and **Account Settings** docked panel / sheet (white); `--surface-raised` = inputs, sidebars, drafting notes, metastory open body — never the default top bar or source reader. Nav/sidebar = raised · source reader / Settings panel = chrome. See [layout-shell](components/layout-shell.md) and [color](foundations/color.md).
- **Account menu:** follow [patterns/account-menu.md](patterns/account-menu.md). Settings docked panel / large sheet. Index: Email · Sign out · Delete; `Terms · Privacy` inline. **Sign out (MVP):** immediate → onboarding O1; no confirm; discard dirty scope. **Delete (MVP):** in-sheet L1 · no email gate · Critical `Delete account` → Critical `Deleting…` → silent O1. **Legal (MVP):** same L1 shell · title in body · `Updated · {date}` · scrollable sections; Privacy = title swap. **Email L1:** ‹ alone (no row label) + × · `Update email.` · support verifies identity · muted until dirty → … → Confirmed with new address.
- **Large sheet:** follow [patterns/large-sheet.md](patterns/large-sheet.md). **Handle + 44 chrome → 16 body air → content** (16 = onboarding Nav→content gap). Index rows equal; legal middot line with **32** section gap. Reader outlet in body.
- **Source reader:** follow [patterns/source-reader.md](patterns/source-reader.md). Same content contract all shells: outlet/`@handle` · author when present · absolute publish time · title (traditional) / post text (social) · snippet (**press** = Tempo article summary when present, labeled + encourage Open original; **never** publisher body) · **`Open original` ↗** at end of reading path. **Desktop (`≥ lg`)** = docked right panel (feed gutter **24px** while open; open body stacks). **Mid (`< lg`)** = right overlay ~400px + scrim (`--ink-primary` **30%**, no blur); feed layout unchanged / inert; open body stays **full desktop** two-up. **Mobile** = large bottom sheet (~85–90%) over same **30%** scrim. Modal / Share: reader-family overlays **30%**; decision modals **45%** translucent over live shell (never solid gray). No kind labels/glyphs; no header hairline; × · scrim · Esc dismiss on overlay/sheet.
- **Back affordance:** follow [components/back-affordance.md](components/back-affordance.md). Mobile = ink chevron 24×24 in ≥44 hit (not `--ink-muted`). Desktop in-app = destination page title Ghost text (`Your dashboard`, `Your scope`) — not `Back to …`. Desktop onboarding Value/Email family = browser back only. **Onboarding mobile:** keep a 44px Nav row on every form step — chevron when back exists, empty layout slot otherwise (title-lock; do not drop the row). Do not reuse modal × or narrative expand chevron rules for step back.
- **Form intro:** follow [patterns/form-intro.md](patterns/form-intro.md). Headline (Newsreader) + one continuous muted support string (Inter) when needed. **Account Tags / Context: omit support** — headline + tabs suffice. Context readiness matches Tags: clean muted `Save →` → dirty Primary `Save →` → in-flight same muted chrome + `Saving…` (no opacity wash). Onboarding form headlines: **36/44** desktop, **32/38** mobile (not `2xl` 24px); tracking `-0.015em`. Soft wrap only; never hard line breaks that stack short sentences as paragraphs. Target ≤2 lines at form measure. Paired loading→filled screens: support `min-height` 48px on desktop **and** mobile. Same continuous-support rule for modal body.
- **Buttons:** follow [components/button.md](components/button.md). **Primary (F)** = white/page + `1.5px` ink border + ink label. **Secondary (G)** = white/page + `1px` `--border-strong` border + ink label. One Primary per region. Labels = Inter `font-medium` **`text-sm` (14px)** everywhere. Prefer `fit-content` width on desktop and mobile (touch via padding/height, not full-bleed). Do not use solid ink fill or Rising/ember as everyday CTAs. Do not use `--surface-raised` as button fill (inputs only). **Readiness:** clean/incomplete → Secondary shell + muted label at **full opacity** (CGU / 70L); ready/dirty → Primary (F); Save/Send in-flight (`Saving…` / `Sending…`) → **same chrome as clean**, busy verb only; Critical in-flight (`Deleting…`) → **keep Critical fill**; Resend after send → **cooldown** (keep `Resend link`, mute X seconds, then re-enable) — **never** opacity-wash muted CTAs, **never** `Resending…`. **Onboarding email:** mute `Send me a link →` until the operator starts typing; then Primary.
- **Scope gates:** follow [patterns/scope-gates.md](patterns/scope-gates.md). Hard: `Add {missing} so Tempo can show stories.` Soft thin: `A thinner scope means fewer stories. Add more below, or {save|start} what you have.` (verb mirrors Primary CTA). Same voice on Tags and Context.
- **System surfaces:** follow [patterns/system-surfaces.md](patterns/system-surfaces.md). Splash = centered Tempo wordmark. Generic error = `Something went wrong.` + `Try again` (Primary). Distinct from Populate error.
- **Viewports:** follow [foundations/viewports.md](foundations/viewports.md). Desktop `1440×900` · mid `1024×768` · mobile `390` fit / keyboard `390×844`.
- **Inputs:** follow [components/input.md](components/input.md). Fill is always `--surface-raised`; never white + ink outline (that is Primary button chrome). Comfortable padding (`py-4`, ~18px inline) unless a dense filter row.
- **Modals:** follow [components/modal.md](components/modal.md). Scrim = `--ink-primary` **45%** translucent over the **live** shell (never solid gray); heavier than reader/Share **30%**. × top-right of panel (`--ink-muted` — dismiss, not back); title and body tightly stacked; prefer × + Esc (no redundant Cancel); short single-job only — long legal copy stays Settings L1 ([account-menu](patterns/account-menu.md)), not a modal. On mobile, keep the panel centered when the keyboard opens; lift only if the focused field or Primary would be covered — never dock the modal to the keyboard like a sheet.
- **Story-status rows:** follow [components/narrative-row.md](components/narrative-row.md). **Pills-only** on the feed — no left status rail. Soft `--border` hairlines between rows (not after the last). Status pill mandatory. Tag cap: desktop max 3, mobile max 1, then `+n`. Trailing chevron on every row (∨ / ∧); single expand. Feed freshness sits after the last row — not viewport-sticky. On schedule: both lines `--ink-muted` (`Next update in ~{duration}` / `Updated {clock}`). Refreshing: `Updating…` in `--ink-secondary`, clock muted; prior feed stays; no footer hairline. Stale / refresh fail (with feed): `Next update delayed` (secondary) → `Updated {clock}` (muted) → `Update now` (`--ink` medium, third line); no toast; not Populate error while stories exist.
- **Metastory open:** follow [patterns/metastory-open.md](patterns/metastory-open.md). Open body only = `--surface-raised` + `16px` padding; meta/title/dek stay `--surface-page`. Hierarchy: Why (full width, Inter 14 same as other bodies + hairline under Why) → equal **H\|C** → equal **Next\|Actions** → Sources. Why label `--ink-secondary`; other labels muted. Desktop: **Copy brief** in Actions column (success → label **`Copied`**, keep Primary F, non-interactive ~1.5–2s, then revert; no muted Resend-cooldown look); Sources below with up to **5 key** (`Outlet` + time) + tappable **`+n`** (one-way); expanded remainder **wraps** (no desktop scroll/fade). **Next\|Actions two-up:** align Copy to Next body (~`22px` Actions `padding-top`). **Stacked** (e.g. source panel open): drop that offset; Next → CTA → Sources = **24px** steps like mobile. Mobile: stack H → C → Next → **Share brief** → Sources **full cluster** horizontal scroll with **peek + trailing fade** when overflowing (no `+n`, no wrap). Share brief → system iOS activity view only (no Tempo **Shared** / success toast; fail/fallback toasts only). No status wash / Newsreader / size step-up on Why. Tag `+n` (muted, inert) ≠ Sources `+n`.
- **Dashboard filters:** follow [patterns/dashboard-filters.md](patterns/dashboard-filters.md). Free-floating text (not pills). Always-on = `--ink-primary` semibold; Select-selected = `--ink-secondary` medium; unselected = `--ink-muted`. **Editing Mode:** open category = `--ink-primary` semibold; contributing-but-closed = `--ink-secondary` medium; empty = muted. Idle Mode: all contributing categories = primary semibold (no open cue). No Done/Clear. Scope-edit removable pills are Account/onboarding only.
- Keep layout stable between calm and fast-public modes. Do not animate feed column height.

## Prompt template

```
Create a prototype screen for [scenario] using the design system in `03-design/design-system/`.
Use semantic tokens only (--status-rising, --ink-primary, etc).
If a needed style is missing, propose a new token with rationale — do not hard-code values.
Apply monitoring-workflow pattern conventions and preserve Rising / Stable / Falling semantics.
Follow typography rules: Newsreader for headlines, Inter for everything else, no italic.
```
