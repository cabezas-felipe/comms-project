# Color

Source of truth: [tokens/design-tokens.json](../tokens/design-tokens.json), mirrored in [tokens/tokens.css](../tokens/tokens.css).

## Design intent

Tempo's color system — **Gravel & Fire** — is built for monitoring-heavy workflows run by solo bilateral comms operators. The base is a cool near-white canvas that reads clean and minimal across long sessions. The sole expressive accent is the copper Rising tone, which earns its prominence through story-status semantics: it only appears when a narrative is actively gaining traction.

The deliberate pairing — warm copper on a cool neutral ground, rendered in a warm editorial serif (Newsreader) — creates a "calm by default, urgent when earned" dynamic. At rest the interface reads like a clean broadsheet. When something rises, the copper breaks the neutral field and demands attention. Stable and Falling states use progressively de-emphasized cool-gray neutrals, letting information hierarchy drive scanning rather than ambient decoration.

One primary status color (Rising copper) so it never competes with itself. Stable and Falling are tonal steps in the same cool-gray family — never competing hues. Destructive and signal tokens are reserved for operational UI states (errors, warnings) and kept strictly distinct from story-status semantics.

## Two-layer token architecture

Every color is defined twice:

1. **Palette layer** (`--gf-*`) in `design-tokens.json` under `color.palette` — raw HSL values. Never referenced directly in component code.
2. **Semantic layer** (`--surface-page`, `--ink-primary`, `--status-rising`, etc.) — aliases the palette by role. This is what components and agents should reference.

A palette change (e.g. a warmth shift) only touches the palette layer once; every component using `--status-rising` picks it up automatically.

> **Prototype note:** `05-prototype/src/index.css` uses shadcn-style names (`--background`, `--foreground`, `--ember`, etc.) for shadcn component compatibility. See [ds-mapping.md](../ds-mapping.md) for the complete bridge between Option-C names and shadcn names.

## Semantic groups

| Token group | Hex approx. | Purpose |
| --- | --- | --- |
| `--surface-page` | `#F8F8F8` | Page background — cool near-white canvas |
| `--surface-chrome` | `#FFFFFF` | Top bars, modal panels, onboarding action panels (email / scope), **source reader** — pure white app chrome |
| `--surface-raised` | `#F0EDE8` | Sidebar, inputs, recessed panels (warm counterpoint) |
| `--border` | `#E8E6E4` | Main dividers, hairlines |
| `--border-strong` | `#DEDAD8` | Sidebar border, stronger edges |
| `--ink-primary` | `#141416` | Headlines, body copy, strong UI text |
| `--ink-secondary` | `#505054` | Captions, outlet names, secondary labels |
| `--ink-muted` | `#888890` | Timestamps, metadata, low-priority labels |
| `--status-rising` | `#B85C28` | Story gaining traction — the one expressive accent |
| `--status-rising-soft` | `#F2E4D0` | Rising badge background |
| `--status-stable` | `#686870` | Story holding steady |
| `--status-stable-soft` | `#E0E0E6` | Stable badge background |
| `--status-falling` | `#909098` | Story losing momentum |
| `--status-falling-soft` | `#EAEAEE` | Falling badge background |
| `--signal-positive` | — | Confirmation / success operational states |
| `--signal-warning` | — | Caution — always paired with icon + text label |
| `--destructive` | — | Irreversible actions and error states |
| `--ring` | `#B85C28` | Keyboard focus visibility — same hue as Rising |

## Usage rules

1. **`--status-rising` is the only expressive accent.** Do not introduce a second warm accent for CTAs or highlights. Everyday actions use the [button](../components/button.md) outline system: **Primary (F)** = ink border; **Secondary (G)** = `--border-strong` border — not solid ink fill and not Rising.
2. **Story status never uses color alone.** Every Rising / Stable / Falling indicator must pair with a text label via the [story-status pill](../components/badge.md). Feed rows are **pills-only** — no left status rail ([narrative-row](../components/narrative-row.md)). Rails remain for [alerts](../components/alert.md) and optional dense [cards](../components/card.md).
3. **`--signal-warning` and `--destructive` are operational, not editorial.** They signal UI errors, confirmations, and system warnings — never story status. Do not use them as a proxy for "important story."
4. **`--status-rising` is never used for primary navigation or actions.** It is reserved for urgency cues, Rising-status indicators, and focus rings.
5. **Preserve AA contrast for body text.** `--ink-primary` on `--surface-page` and `--ink-secondary` on `--surface-raised` are the primary pairs — do not swap them for decorative reasons. `--ink-muted` is only for genuinely subordinate content at `text-sm` or larger.
6. **Do not confuse the three surfaces.** `--surface-page` = canvas; `--surface-chrome` = top bars, modal panels, and **source reader** (pure white); `--surface-raised` = inputs, sidebars, drafting notes, metastory open body. Top bars and source reader must not use `--surface-raised` (reads as form/recessed chrome, not reading chrome). See [layout-shell](../components/layout-shell.md) and [modal](../components/modal.md).
7. **Selection state** uses `--surface-raised` as the active-row fill — not `--status-rising-soft`. Reserve Rising-soft for story-status soft fills (badges).
8. **Focus ring** (`--ring`) uses the Rising hue. This is intentional: it creates a single copper-accent story across urgency, emphasis, and interaction — without adding a competing color.
9. **Section metadata labels** ("SITUATION", "WHAT CHANGED", "KEY SOURCES"): use `--ink-muted` (`#888890`) with uppercase tracking — structural feed/card chrome only, not form field labels (those stay sentence case; see [input](../components/input.md) and [typography](typography.md)).

## Status semantics

| Status | Meaning | When to use |
| --- | --- | --- |
| Rising | Narrative gaining traction; needs attention before drafting | Active media cycle, new angles emerging, source count climbing |
| Stable | Narrative holding steady; monitor but no immediate action | Story in steady state; no significant shifts since last check |
| Falling | Narrative losing momentum; deprioritize | Story fading from coverage; low risk of being caught unprepared |

These three are story-status slots — they are never interchangeable with `--signal-*` or `--destructive`.

## Contrast calibration

The three status tiers are calibrated for scannable hierarchy on `--surface-page` (`#F8F8F8`):

| Tier | Color | Approx. contrast | Notes |
| --- | --- | --- | --- |
| Rising | `#B85C28` | ~4.9:1 | WCAG AA pass; copper breaks neutral field |
| Stable | `#686870` | ~4.9:1 | WCAG AA pass; cool blue-gray, readable |
| Falling | `#909098` | ~3.1:1 | Intentional de-emphasis; headlines readable, clearly receded vs Stable |

Falling is a deliberate design choice — it signals low priority through reduced contrast, not invisibility. The headline must remain identifiable at a glance.

## Accessibility baseline

- **Focus:** `--ring` must be visible on all interactive elements. Never suppress the focus ring.
- **Contrast:** All body text at `--ink-primary` or `--ink-secondary` must meet WCAG AA. `--ink-muted` should only appear at `text-sm` (14px) or larger.
- **Color-only information:** No story status, urgency, or diff is conveyed by color alone. Every color cue pairs with a text label, icon, or pattern.

These are not polish items. They apply from the first prototype.
