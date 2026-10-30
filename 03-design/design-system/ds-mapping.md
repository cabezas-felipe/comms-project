# DS mapping — decision log

**Version:** 1.2.6
**Date:** 13 Sep 2026
**Source:** Paper exploration file (Gravel & Fire selection, Sep 2026); onboarding CTA system (F/G), Sep 2026; Account modal pattern, Sep 2026; Dashboard chrome white lock, Sep 2026; see [changelog.md](changelog.md)

**Sync status:** `03-design/design-system/` reflects v1.2.49 (Gravel & Fire + Newsreader + calm outline buttons; readiness = clean muted Secondary full opacity / ready Primary / in-flight = same muted chrome + busy verb only — no opacity wash; button labels locked `text-sm` 14px; Critical fill for destructive confirm; Tags \| Context; one width rule across breakpoints; no em dashes in product UI; paired-state skeleton continuity; modal + keyboard collision-only lift; `--surface-chrome` for top bars / modal panels / source reader / Settings panel). `05-prototype/src/index.css` color values match v1.1.0+; **button component styles in the prototype may still use solid primary fill** — prefer [components/button.md](components/button.md) until an eng retarget. The prototype retains shadcn-style variable names (`--background`, `--foreground`, `--ember`, etc.) for shadcn component compatibility — see "Prototype naming bridge" below.

## Source of truth

The canonical design system is defined in [tokens/design-tokens.json](tokens/design-tokens.json), mirrored in [tokens/tokens.css](tokens/tokens.css). Both use Option-C semantic names (`--surface-page`, `--ink-primary`, `--status-rising`, etc.).

The prototype (`05-prototype/src/index.css`) consumes shadcn-style names and is kept in sync with equivalent HSL values. If the two diverge, `03-design/design-system/` wins — fix the prototype.

The Paper file remains the source of *intent* (visual direction, component specimens); individual artboards are not pixel-authoritative where they conflict with this document.

## Foundational decisions (v1.1.0–1.2.0)

| # | Question | Decision | Rationale |
| --- | --- | --- | --- |
| 1 | Color system | **Gravel & Fire** — cool near-white base (`#F8F8F8`), single Rising copper accent (`#B85C28`), cool blue-gray Stable/Falling neutrals | Cool ground + warm copper accent creates "calm by default, urgent when earned" without earthy warmth that reads as "too brown" in user testing. Warm Newsreader serif supplies the human warmth the palette steps back from. |
| 2 | Token naming | **Option C — comms-specific semantic** (`--surface-page`, `--ink-primary`, `--status-rising`, etc.) | Domain legibility: immediately readable by any agent or engineer building Tempo-specific components |
| 3 | Token architecture | **2-layer** — palette (`--gf-*`) + semantic aliases | Rebrand-proof; matches the PassPlate precedent from `passplate/03-design/design-system/` |
| 4 | Display font | **Newsreader + Inter** | Newsreader is designed for on-screen editorial news; superior legibility at mixed sizes vs Cormorant/Playfair; upright weight carries authority without the fragility of thin-stroke classical serifs. Warm editorial serif intentionally contrasts the cool palette — provides human warmth while the chrome stays precise. |
| 5 | Directory structure | `03-design/design-system/` subdirectory | Demarcates DS from other `03-design/` artifacts (principles, archive); matches PassPlate structure |
| 6 | color-preview.html | Removed (git history) | Color fully documented in `foundations/color.md` + tokens; HTML preview created maintenance overhead disproportionate to its value |
| 7 | Prototype scope | Prototype token values updated in this pass; shadcn variable names preserved | No current testers; purely aesthetic shift. Token names will be aligned in a future refactor when shadcn dependency is revisited |
| 8 | Falling status color | `#909098` (cool blue-gray, ~3.1:1 contrast) | Intentional de-emphasis; previously `#B4B4BC` failed readability at ~1.9:1. New value creates visible three-tier hierarchy: Rising 4.9:1 → Stable 4.9:1 → Falling 3.1:1. |
| 9 | Button primary / secondary / readiness | **Primary (F)** = white/page + ink outline; **Secondary (G)** = white/page + `--border-strong` outline + **ink** label. Clean/incomplete **and** in-flight → Secondary shell + muted label at **full opacity** (CGU). Busy = label verb only (`Saving…`). Ready → F. Labels = **`text-sm` (14px)**. Critical = filled `--destructive`. Opacity wash on muted CTAs **retired**. Solid ink fill retired as everyday primary. | Calm-by-default (dp1): solid ink CTAs overpowered screens; opacity-faded Saves became unreadable on page. Muted label + busy verb keeps CTAs findable. See [button.md](components/button.md). |
| 10 | Modal / dismiss / readiness / keyboard | Scrim + ink-edged white panel; × top-right (no redundant Cancel by default); inputs stay `--surface-raised`; Primary only when required fields are ready; keyboard keeps panel centered unless field/CTA would collide | Account Update email (Empty + Keyboard). Separation from `--surface-page`; calm density; field≠CTA. See [modal.md](components/modal.md). |
| 11 | Top bar / chrome white | **`--surface-chrome`** (`#FFFFFF`) for product top bars and modal panels; `--surface-raised` reserved for inputs, sidebars, recessed panels | Paper Account + Dashboard Directions already used white; raised top bars read as form chrome. Three-surface stack: page · chrome · raised. See [layout-shell.md](components/layout-shell.md), [color.md](foundations/color.md). |
| 12 | Back affordance | **Mobile** = ink chevron (24×24 in ≥44 hit); **desktop in-app** = destination page title Ghost text (`Your dashboard`, `Your scope`); **desktop onboarding** = browser only. Not muted; distinct from modal × and narrative expand | Account + Check inbox specimens; Link expired aligned. Step nav ≠ dismiss/metadata. See [back-affordance.md](components/back-affordance.md). |
| 13a | Large sheet | **Handle + 44 chrome → 16 body air → content.** Equal Index rows; legal **32** section gap. Form stack shared with onboarding. | Locks sheet/onboarding rhythm. See [large-sheet.md](patterns/large-sheet.md). |
| 13 | Account menu | Trailing **`Settings`** → docked panel / large sheet. Primary: **Email** (noun) · Sign out · Delete (verbs). Legal: inline `Terms · Privacy`. × only. | Noun destinations + verb actions; legal as middot footer. See [account-menu.md](patterns/account-menu.md). |

## Token mapping — Option C → shadcn (prototype bridge)

Components and agents should use **Option-C names** when writing design documentation. The prototype uses **shadcn names** for shadcn component compatibility. Values are equivalent.

| Option-C name (docs) | Shadcn name (prototype) | v1.1.0 HSL value | Hex approx. |
| --- | --- | --- | --- |
| `--surface-page` | `--background` | `0 0% 97%` | `#F8F8F8` |
| `--surface-chrome` | `--color-white` / `--color-chrome` (Paper) · use `#FFFFFF` in prototype until bridged | `0 0% 100%` | `#FFFFFF` |
| `--surface-raised` | `--surface` / `--card` | `38 21% 93%` | `#F0EDE8` |
| `--border` | `--border` / `--input` | `30 8% 90%` | `#E8E6E4` |
| `--border-strong` | `--rule` (sidebar / strong edge) | `20 8% 86%` | `#DEDAD8` |
| `--ink-primary` | `--foreground` / `--primary` | `240 5% 8%` | `#141416` |
| `--ink-secondary` | `--card-foreground` | `240 2% 32%` | `#505054` |
| `--ink-muted` | `--muted-foreground` | `240 3% 55%` | `#888890` |
| `--status-rising` | `--ember` | `22 64% 44%` | `#B85C28` |
| `--status-rising-soft` | `--ember-soft` | `35 57% 88%` | `#F2E4D0` |
| `--status-stable` | `--secondary-foreground` (partial) | `240 4% 42%` | `#686870` |
| `--status-stable-soft` | `--secondary` / `--accent` | `240 11% 89%` | `#E0E0E6` |
| `--status-falling` | — (prototype token) | `240 4% 58%` | `#909098` |
| `--status-falling-soft` | — (prototype token) | `240 11% 93%` | `#EAEAEE` |
| `--signal-positive` | `--signal-positive` | `152 45% 32%` | — |
| `--signal-warning` | `--signal-warning` | `36 85% 42%` | — |
| `--destructive` | `--destructive` | `0 70% 42%` | — |
| `--ring` | `--ring` | `22 64% 44%` | `#B85C28` |

## Before → after (v1.0.0 Sienna Signal → v1.1.0 Gravel & Fire)

| Area | v1.0.0 (Sienna Signal) | v1.1.0 (Gravel & Fire) |
| --- | --- | --- |
| Color system name | Sienna Signal | Gravel & Fire |
| Palette prefix | `ss-*` | `gf-*` |
| Background | `40 18% 97%` (#F7F5F0 — warm parchment) | `0 0% 97%` (#F8F8F8 — cool near-white) |
| Surface raised | `38 20% 91%` (#EDE9E2) | `38 21% 93%` (#F0EDE8 — warm-tinted sidebar) |
| Border | `38 17% 82%` (#D8D2C8) | `30 8% 90%` (#E8E6E4 — cooler, lighter) |
| Border strong | — (single border token) | `20 8% 86%` (#DEDAD8 — sidebar / strong edges) |
| Ink primary | `40 11% 11%` (#1E1C18 — warm dark) | `240 5% 8%` (#141416 — near-neutral dark) |
| Ink secondary | `27 10% 32%` (#5A5048 — warm brown-gray) | `240 2% 32%` (#505054 — cool blue-gray) |
| Ink muted | `35 10% 56%` (#9A9080 — warm neutral) | `240 3% 55%` (#888890 — cool blue-gray) |
| Rising accent | `18 77% 41%` (#B84818 — sienna) | `22 64% 44%` (#B85C28 — copper) |
| Rising soft | `30 69% 87%` (#F5DEC8) | `35 57% 88%` (#F2E4D0) |
| Stable | `37 10% 49%` (#8A8070 — warm gray) | `240 4% 42%` (#686870 — cool blue-gray) |
| Stable soft | `36 30% 87%` (#E8E0D4) | `240 11% 89%` (#E0E0E6 — cool lavender-gray) |
| Falling | `40 16% 71%` (#C0B8A8 — warm pale) | `240 4% 58%` (#909098 — cool blue-gray, darker for readability) |
| Falling soft | `41 24% 90%` (#ECE8E0) | `240 11% 93%` (#EAEAEE — cool pale) |
| Focus ring | `18 77% 41%` (sienna) | `22 64% 44%` (copper — unified with Rising) |
| Shadows | warm HSL values | cool HSL values |

## Before → after (v0.3.0 Fraunces/ember → v1.0.0 Sienna Signal)

| Area | v0.3.0 | v1.0.0 |
| --- | --- | --- |
| Display font | Fraunces (variable optical serif) | Newsreader (optical editorial serif) |
| Background | `38 30% 96%` (warm off-white) | `40 18% 97%` (parchment) |
| Foreground / ink | `222 25% 12%` (blue-ink) | `40 11% 11%` (#1E1C18 — warm dark) |
| Primary action | `222 30% 14%` (blue-ink) | `40 11% 11%` (same as ink) |
| Emphasis accent | `--ember: 14 80% 48%` (orange-red) | `--status-rising: 18 77% 41%` (#B84818 — warm sienna) |
| Status system | `--ember` only for urgency | `--status-rising` / `--status-stable` / `--status-falling` three-state |
| Token names (docs) | shadcn-style | Option-C semantic |
| Token names (proto) | shadcn-style | shadcn-style (preserved for component compat) |

## Documented exceptions

1. **`.dark` mode in the prototype** — dark-mode token values have not been tuned to Gravel & Fire equivalents. They retain v0.3.0 structure and will need a dedicated tuning pass when dark-mode is actively used.
2. **`--signal-positive`, `--signal-warning`, `--destructive`** — operational status tokens are unchanged from v0.3.0. They remain green/amber/red as standard UI conventions; no semantic conflict with Gravel & Fire's story-status system.

## Retired / never-adopted

| Token | Status | Reason |
| --- | --- | --- |
| `--gradient-ember` | Retired | Gradient was decorative; Gravel & Fire uses flat fills only |
| Fraunces font | Retired (v1.0.0) | Replaced by Newsreader |
| `--primary: 222 30% 14%` (blue-ink) | Retired | Foreground and primary actions now use near-neutral dark `#141416` |
| `ss-*` palette prefix | Retired (v1.1.0) | Replaced by `gf-*` (Gravel & Fire) |
| Sienna Signal warm parchment base | Retired (v1.1.0) | Replaced by Gravel & Fire cool near-white |
| `color-preview.html` | Removed | Deleted from archive; recover from git history if needed |
| `03-design/ds-mapping.md` (v0.3.0) | Archived | See [token-mapping--v0.3-flat-hex-to-shadcn.md](../archive/token-mapping--v0.3-flat-hex-to-shadcn.md) |

## Historical mappings

Pre-v0.3.0 token history (flat hex → HSL shadcn alignment) is preserved in [token-mapping--v0.3-flat-hex-to-shadcn.md](../archive/token-mapping--v0.3-flat-hex-to-shadcn.md).
