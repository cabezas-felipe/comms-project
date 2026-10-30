# Layout shell

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [spacing and radius](../foundations/spacing-and-radius.md) · [color](../foundations/color.md) · [motion](../foundations/motion-and-feedback.md) · [pattern: monitoring workflow](../patterns/monitoring-workflow.md) · [pattern: source reader](../patterns/source-reader.md)

## Purpose

Provide a stable, persistent frame for the monitor → draft → close loop. The layout never reorganizes itself during a session — only emphasis changes.

## Base layout

| Region | Surface | Function |
| --- | --- | --- |
| Top bar | `--surface-chrome` (white) + `--border` / `--border-strong` bottom edge | Brand + key destinations (e.g. Tempo · Account); global mode/status |
| Left rail / sidebar | `--surface-raised`, `--border` right edge | Navigation, saved views, source lists |
| Main content | `--surface-page` | Monitoring feed / story list |
| Optional right panel | `--surface-raised` (drafting / notes) · `--surface-chrome` (source reader · **Settings panel**) | Drafting context and notes stay raised; **source reader** and ephemeral **Settings** panel use chrome white. Identity opens via [Account menu](../patterns/account-menu.md) — docked when open, not a persistent always-on rail |

## Token usage

| Property | Value |
| --- | --- |
| Page background | `--surface-page` |
| Top bar / modal panel / source reader | `--surface-chrome` |
| Sidebar / drafting notes / input surface | `--surface-raised` |
| Panel borders | `--border` |
| Page padding | `p-6` |
| Panel gaps | `gap-4` |
| Section spacing | `gap-6` to `gap-8` |
| Top bar / rail internals | `px-4` horizontal · `py-3` vertical |
| Mode emphasis changes | Color + label only — no large positional animation |

## Usage rules

1. **Top bar is chrome white, not raised.** Use `--surface-chrome` for Dashboard, Account, and other product shells so the bar sits slightly above the cool page without the warm raised tint. `--surface-raised` stays for inputs, sidebars, and recessed panels — never as the default top bar fill. **Nav/sidebar = raised · source reader = chrome** (reading pane, not recessed chrome).
2. **Keep top-level navigation persistent** across mode changes (calm → fast-public). Navigation should never move.
3. **Preserve panel positions between modes.** Only emphasis (color, label, prominence) should change — not layout.
4. **Reduce horizontal reflow.** Column widths stay fixed; content within columns updates.
5. **Do not animate the height of the entire feed column** on mode switch. Use a static layout with a banner at the top per [motion.md](../foundations/motion-and-feedback.md).
6. **The drafting panel is always reachable without navigation** — it exists in the shell, not behind a modal or a new route.
7. **Back / leave-sheet chrome** — follow [back affordance](back-affordance.md). Account desktop uses Ghost destination titles (`Your dashboard`, `Your scope`); Account mobile uses an ink chevron. Do not invent a third treatment for shell leave.
8. **Account identity** — desktop trailing control = **`Settings`** → [Account menu](../patterns/account-menu.md) docked panel; mobile = **`Settings`** sheet + scrim. Same rows (email · Terms · Privacy · Sign out · Delete account). Panel/sheet chrome = × only (no title echo). Left chrome = `Your dashboard` / `Your scope` (destination title). Do not use email as the trigger, a persistent Account rail, or flat peer links in the top bar.
