# Source reader

**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md)
**Related:** [Layout shell](../components/layout-shell.md) · [Large sheet](large-sheet.md) · [Metastory open](metastory-open.md) · [Back affordance](../components/back-affordance.md) · [Modal](../components/modal.md)
**Principles:** [dp3 — Always within reach](../../principles.md) · [dp5 — Trust through navigability](../../principles.md)

> Working pattern (v1.2.51+). Locked from Dashboard · Source reader specimens (desktop docked · mid overlay · mobile large sheet). Mobile sheet shares **Handle + 44 chrome → body** with Settings ([large-sheet](large-sheet.md)). Progressive learning: in-product snippet before optional outbound to the original. **28 Oct 2026:** press snippet = Tempo **article summary** (not publisher body / not truncated NewsAPI `body`); NewsAPI has no excerpt field — see [summarization SR-07](../../../02-product/contracts/summarization.md).

## Purpose

Let the operator check how one monitored outlet frames the metastory **without leaving Tempo**, then optionally open the original. Keeps judgment (open metastory) in reach while drilling one source.

## When

Tap a **Sources** cell on an open metastory. Dismiss returns to that open row (Sources still visible). Does **not** replace metastory open; it layers on top of it.

## Content contract (all shells)

One contract — shell differs by viewport.

| Field | Traditional | Social | Required |
| --- | --- | --- | --- |
| Outlet / handle | Display name | `@handle` | Must |
| Author | Byline when present | Omit (handle is the identity) | When present |
| Published | Absolute calendar + clock (e.g. `28 Sep · 2:39p`) — **not** relative age | Same | Must |
| Title | Article headline | Omit fake headline; post text is the piece | Traditional must |
| Snippet | Tempo **article summary** when present (labeled — not the article). If summary missing: omit snippet (title + meta + Open original only). Never show publisher body or truncated NewsAPI `body`. Reserved keep-list `excerpt` is for a future outlet/feed teaser only (usually NULL today). | Post text (truncate when long) | Press: when summary exists · Social: must |
| Outbound | Article URL | Post deeplink | Must when URL exists |

**Do not show:** traditional/social prose labels, ■/◯ kind glyphs in the reader, sentiment, engagement counts, prestige/rank, images (v0), publisher body, unlabeled summary presented as the article.

### Snippet disclosure (press)

| Rule | Detail |
| --- | --- |
| Voice | Quiet line that the text is **Tempo’s summary** of the article — not the article itself |
| CTA | Recommend / encourage **Open original** for the full piece |
| Fail | No summary → no invented filler; title + outlet/author/time + Open original |

### Outbound CTA

| Rule | Detail |
| --- | --- |
| Copy | **`Open original`** + quiet **↗** (`--ink-secondary` / muted stroke) |
| Placement | **End of reading path** (after snippet, or after title/meta when snippet omitted) — progressive learning before leave-app |
| Style | Ghost / quiet text — **not** Primary (F); leave-app is optional after the snippet |
| Not | Repeating the outlet name as the only label; uppercase chrome metadata for the CTA |

### Chrome

| Element | Treatment |
| --- | --- |
| Surface | `--surface-chrome` (white) — **not** `--surface-raised` ([layout-shell](../components/layout-shell.md): nav/sidebar = raised · source reader = chrome) |
| Close | × top-right (`--ink-muted`) — dismiss, not step-back ([modal](../components/modal.md) × family) |
| Mobile sheet | **Handle + 44 chrome** (empty left · × right) → **16** body air → outlet / meta in **body** ([large-sheet](large-sheet.md)) |
| Desktop / mid | Outlet (or `@handle`) + × in the panel header is fine — different shell; do not invent a sheet-height chrome band |
| Internal hairlines | **None** under the header — hierarchy from type + spacing. Panel/sheet edge seam uses `--border` |
| Reader scrim | Mid + mobile: `--ink-primary` **30%** over the open dashboard (no backdrop blur). Lighter than [modal](../components/modal.md) **45%** — judgment stays readable. Desktop docked has **no** scrim |

## Shell switch

| Viewport | Trigger | Shell |
| --- | --- | --- |
| **Desktop** | `≥ lg` (~1024px) | **Docked** right panel — feed pushes left |
| **Mid** | `< lg` and not phone compact | **Right overlay** + scrim — feed layout unchanged |
| **Mobile** | Phone compact (~390) | **Large bottom sheet** + scrim |

Mid is a responsive state of the same reader — not a third product platform. Canonical happy-path comps live on UX/UI; mid lives with UI states. Mid **artboard** = **`1024 × 768`** ([viewports](../foundations/viewports.md)).

## Desktop

| Rule | Detail |
| --- | --- |
| Shell | **Docked right panel** below app top bar (Tempo · Account stay full-bleed) |
| Layout | Left column = title · filters · feed (pushed); right = source reader full remaining height |
| Width | ~400px panel; left seam `1px` `--border` / `--border-strong` |
| Feed gutter while open | **24px** inline (match panel content inset) — closed dashboard stays **40px** |
| Open body | Next\|Actions **stacks**; drop two-up Actions `padding-top` align ([metastory-open](metastory-open.md)) — feed column is compressed |
| Not | Pushing top-bar chrome; overlay modal over the feed; jump straight to external URL |

## Mid-width

| Rule | Detail |
| --- | --- |
| Artboard | **`1024 × 768`** — specimen [Mid · Source reader](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/KNA-0) |
| Shell | **Right overlay** (~400px) under Tempo · Account — does **not** push the feed |
| Behind | Dimmed open metastory (scrim = `--ink-primary` **30%**) — judgment perceptible; feed **inert** while open. Lighter than [modal](../components/modal.md) **45%** so the open body stays readable |
| Open body | **Full desktop** two-up (H\|C · Next\|Actions with Actions `~22px` top padding) — overlay does not compress the column |
| Sources | Desktop key-five + **`+n`** (same as wide desktop) |
| Dismiss | × · scrim tap · Esc — read-only detail; scrim dismiss is allowed (unlike identity modals) |
| Reference width | ~**834×900** specimen (below `lg`; tablet-class) |
| Not | Docked push-left; mobile bottom sheet; live feed under the overlay |

## Mobile

| Rule | Detail |
| --- | --- |
| Shell | **Large bottom sheet** (~85–90% viewport height) over the open dashboard |
| Behind | Dimmed open metastory (scrim = `--ink-primary` **30%**) — judgment stays perceptible (same reader strength as mid; not modal **45%**) |
| Sheet | `--surface-chrome`; top corners ~12px; handle + **44 chrome** → **16** body air ([large-sheet](large-sheet.md)) |
| Gutter | **24px** inline (shared sheet / onboarding rhythm) |
| Body | Outlet / handle → author · time → title / post → snippet → `Open original` ↗ — not inside the 44 chrome |
| Dismiss | × and/or swipe-down / scrim — return to open metastory |
| Not | Push-left split; default fullscreen takeover (loses metastory context); thin peek-only sheet |

Fullscreen takeover is an explicit exception only if product later proves the sheet fails interrupt-check — not the MVP default.

## Platform split (summary)

| | Desktop | Mid | Mobile |
| --- | --- | --- | --- |
| Presentation | Docked panel | Right overlay + scrim | Large bottom sheet |
| Feed layout | Pushed / compressed | Unchanged (under scrim) | Unchanged (under scrim) |
| Open body | Stacks | Full desktop two-up | Mobile stack |
| Content | Same contract | Same contract | Same contract |
| Metastory | Visible beside panel | Visible under scrim | Visible under scrim |

## Related Sources rail change

Sources cells open the **source reader**, not the external URL directly. Outbound lives on `Open original` inside the reader. Relative time stays on the Sources rail (`12m`); absolute time is reader-only.
