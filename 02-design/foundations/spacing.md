# Spacing

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Spacing scale

The scale below maps to Tailwind spacing utilities. CSS vars (`--space-*`) are not defined at runtime — apply via Tailwind classes.


| Step | Value | Tailwind | Typical use                                                   |
| ---- | ----- | -------- | ------------------------------------------------------------- |
| 0    | 2px   | `gap-px` / `p-px` | Hairline gaps, stacked label tightness, divider-adjacent text |
| 1    | 4px   | `gap-1` / `p-1` | Tight icon/text separation                                  |
| 2    | 8px   | `gap-2` / `p-2` | Small gaps in controls                                      |
| 3    | 12px  | `gap-3` / `p-3` | Compact list rows                                           |
| 4    | 16px  | `gap-4` / `p-4` | Default component padding                                   |
| 5    | 20px  | `gap-5` / `p-5` | Card internals                                              |
| 6    | 24px  | `gap-6` / `p-6` | Section spacing                                             |
| 8    | 32px  | `gap-8` / `p-8` | Large panel spacing                                         |
| 10   | 40px  | `gap-10` / `p-10` | Page-level block spacing                                  |


## List density vs card density

Use **one scale**; change **feel** by which step you use vertically, not by inventing off-system pixels. For **monitoring feeds**, prefer the **tighter end** of the scale between rows (for example `gap-2` between stacked lines or `gap-3` between row blocks). For **cards, drawers, and drafting chrome**, keep **breathing room**: internal padding at `p-4` or higher so summaries and actions stay legible. Do not tighten cards and lists at the same time—adjust **one** region per iteration so you can tell what helped.

## Radius — defaults by component


| Use                                   | Tailwind class | Rationale                                                           |
| ------------------------------------- | -------------- | ------------------------------------------------------------------- |
| **Cards, panels, modals**             | `rounded-lg`   | Calm, institutional surfaces; matches monitoring + drafting panes   |
| **Buttons, inputs, compact controls** | `rounded-md`   | Slightly sharper so actions read as controls, not as document pages |
| **Small chips, nested UI**            | `rounded-sm`   | Optional; keep nested corners ≤ parent radius                       |
| **Badges, pills**                     | `rounded-full` | Clear "tag" affordance                                              |


All three derive from `--radius: 0.25rem` via Tailwind's `borderRadius` config (`lg = --radius`, `md = calc(--radius - 1px)`, `sm = calc(--radius - 2px)`).

## Layout rhythm rules

1. Use `p-4` (16px) as baseline spacing for most component internals.
2. Distinguish list density with **vertical** spacing first (`gap-2`–`gap-3`); avoid changing padding, font size, and border weight all at once.
3. Keep actions grouped with `gap-2`–`gap-3` internal gaps and `gap-4`–`gap-6` separation from body content.
4. Use `gap-px` / `p-px` only where **2px** is intentional (hairlines); do not replace `gap-2` or `gap-3` for "normal" gaps.
