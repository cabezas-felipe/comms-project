# Layout shell

**Tokens:** [design-tokens.json](../tokens/design-tokens.json) · **CSS:** [tokens.css](../tokens/tokens.css)  
**Foundations:** [spacing](../foundations/spacing.md) · [color](../foundations/color.md) · [motion](../foundations/motion-and-feedback.md) · [pattern: monitoring workflow](../patterns/monitoring-workflow.md)

## Purpose

Provide a stable frame for monitoring + drafting without constant visual reorientation.

## Base layout

- Top bar: global mode/status and key actions
- Left rail: navigation and saved views
- Main content: monitoring feed/list and detail panels
- Optional right panel: drafting context / notes

## Token usage

- Page padding: `p-6`
- Panel gaps: `gap-4`
- Section spacing: `gap-6` to `gap-8`
- Top bar / rail interiors: horizontal `px-4`, vertical `py-3`
- Surfaces: `--background` page, `--card` or `--surface-raised` for elevated panes
- Mode emphasis changes: prefer **color + label**, not large motion; respect [motion / reduced motion](../foundations/motion-and-feedback.md)

## Rules

1. Keep top-level navigation persistent across mode changes.
2. Preserve panel positions between calm and fast-public mode; only emphasis should change.
3. Reduce horizontal reflow to lower cognitive switching cost.
4. Do not animate the height of the entire feed column on mode switch; use static layout + banner ([motion](../foundations/motion-and-feedback.md)).
