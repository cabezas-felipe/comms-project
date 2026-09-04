# Color

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Design intent

The system is built for monitoring-heavy workflows: calm base surfaces, clear primary actions, and unambiguous status signaling.

## Semantic groups


| Token group                                          | Purpose                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `--background`, `--surface`, `--surface-raised`      | Page structure and panel hierarchy                                                          |
| `--secondary`, `--accent`                            | **List/table selection** — warm paper tints; keeps `--primary` and `--ember` for actions   |
| `--foreground`, `--muted-foreground`                 | Readability for scanning and drafting                                                       |
| `--primary`                                          | Primary actions, links, deep ink — the default action color                                 |
| `--ember`, `--ember-soft`                            | Priority emphasis, “what changed” cues, urgency indicators — **not** for primary nav        |
| `--signal-positive`, `--signal-warning`              | Operational status and urgency                                                              |
| `--destructive`                                      | Irreversible actions and error states                                                       |
| `--ring`                                             | Keyboard focus visibility                                                                   |


## Brand-based mappings

- Primary action / ink: `--primary` → `hsl(222 30% 14%)` (deep ink)
- Emphasis / priority: `--ember` → `hsl(14 80% 48%)` (warm orange-red)
- Signal positive: `--signal-positive` → `hsl(152 45% 32%)`
- Signal warning: `--signal-warning` → `hsl(36 85% 42%)`
- Destructive: `--destructive` → `hsl(0 70% 42%)`
- Background: `--background` → `hsl(38 30% 96%)` (warm paper)

Legacy brand reference hex values (`#4F6887`, `#D15400`, `#922B2E`, `#68874F`, `#CEBA71`) are archived in [archive/brand-seed.md](../archive/brand-seed.md). They do not map 1:1 to running prototype tokens.

## Usage rules

1. Keep `--signal-warning` and `--destructive` paired with **icon + visible text label** (not color-only dots).
2. Never use `--destructive` for default actions.
3. Use `--ember` for urgency/priority cues and “what changed” indicators; do not use it as a general accent fill.
4. New information indicators should use `--ember` patterns (left rail + label), not `--signal-positive`.
5. Preserve contrast for body text at AA targets.
6. **Selection:** use `--secondary` (`hsl(36 18% 88%)`) for the active row or cell. Do **not** fill an entire selected row with `--ember-soft` — reserve ember for priority cues.

## Minimums (recommended defaults for prototypes)

These exist so v0/Cursor builds do not collapse into unreadable 1px cues.


| Cue                                                         | Minimum                                    | Notes                                              |
| ----------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Status left rail (`signal-warning` / `destructive` / positive) | **3px** wide                            | Full row height or card height segment             |
| “New” ember rail                                            | **3px**                                    | Pair with a text label or badge                    |
| Status badge                                                | **height 22px**; **padding** ≥ `p-2` horizontal | Use `text-xs` or `text-sm` inside           |
| Warning / destructive in a list                             | **Icon + label**                           | Label can be short (`Urgent`) but must be present  |


## Preview

Single canonical preview and rationale: [color-preview.html](../color-preview.html).