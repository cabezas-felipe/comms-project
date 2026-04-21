# Color

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Design intent

The system is built for monitoring-heavy workflows: calm base surfaces, clear primary actions, and unambiguous status signaling.

## Semantic groups


| Group                                 | Purpose                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bg`, `surface`, `border`             | Page structure and panel hierarchy                                                         |
| `surface.selected`, `border.selected` | **List/table selection** — neutral cool tint; keeps `accent` for actions and “new”         |
| `text`                                | Readability for scanning and drafting                                                      |
| `accent`                              | Primary actions, links, “new since last check” emphasis — **not** whole-row selection fill |
| `success`, `warning`, `critical`      | Operational status and urgency                                                             |
| `highlight`                           | Non-urgent “look here” (chips, soft fills) — distinct from warning escalation              |
| `focusRing`                           | Keyboard accessibility visibility                                                          |


## Brand-based mappings

- Accent: blue `#4F6887`
- Warning: orange `#D15400`
- Critical: UI red `#922B2E` (tokens; clearer vs warning orange). Brand reference red-brown `#87524F` remains in [archive/brand-seed.md](../archive/brand-seed.md).
- Success: green `#68874F`
- Highlight: yellow `#CEBA71`
- Primary text dark: `#454545`

## Usage rules

1. Keep warning and critical paired with **icon + visible text label** (not color-only dots).
2. Never use `critical` for default actions.
3. Use highlight yellow as background or pill fill; avoid yellow body text on light surfaces.
4. New information indicators should use **accent** patterns (left rail + label), not success.
5. Preserve contrast for body text at AA targets.
6. **Selection:** use `color.surface.selected` and optionally `color.border.selected` for the active row or cell. Do **not** fill an entire selected row with `accent.soft` — reserve accent for actions and “new” cues.

## Minimums (Step 1 — recommended defaults for prototypes)

These exist so v0/Cursor builds do not collapse into unreadable 1px cues.


| Cue                                                   | Minimum                                             | Notes                                             |
| ----------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| Status left rail (`warning` / `critical` / `success`) | **3px** wide                                        | Full row height or card height segment            |
| “New” accent rail                                     | **3px**                                             | Pair with a text label or badge                   |
| Status badge                                          | **height 22px**; **padding** ≥ `space.2` horizontal | Use `type.size.xs` or `sm` inside                 |
| Warning / critical in a list                          | **Icon + label**                                    | Label can be short (`Urgent`) but must be present |


## Preview

Single canonical preview and rationale: [color-preview.html](../color-preview.html).