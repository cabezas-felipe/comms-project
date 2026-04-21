# Spacing

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Spacing scale


| Token      | Value | Typical use                                                   |
| ---------- | ----- | ------------------------------------------------------------- |
| `space.0`  | 2px   | Hairline gaps, stacked label tightness, divider-adjacent text |
| `space.1`  | 4px   | Tight icon/text separation                                    |
| `space.2`  | 8px   | Small gaps in controls                                        |
| `space.3`  | 12px  | Compact list rows                                             |
| `space.4`  | 16px  | Default component padding                                     |
| `space.5`  | 20px  | Card internals                                                |
| `space.6`  | 24px  | Section spacing                                               |
| `space.8`  | 32px  | Large panel spacing                                           |
| `space.10` | 40px  | Page-level block spacing                                      |


## List density vs card density

Use **one scale**; change **feel** by which step you use vertically, not by inventing off-system pixels. For **monitoring feeds**, prefer the **tighter end** of the scale between rows (for example `**space.2`** between stacked lines or `**space.3**` between row blocks). For **cards, drawers, and drafting chrome**, keep **breathing room**: internal padding at `**space.4` or higher** so summaries and actions stay legible. Do not tighten cards and lists at the same time—adjust **one** region per iteration so you can tell what helped.

## Radius — defaults by component


| Use                                   | Token         | Rationale                                                           |
| ------------------------------------- | ------------- | ------------------------------------------------------------------- |
| **Cards, panels, modals**             | `radius.lg`   | Calm, institutional surfaces; matches monitoring + drafting panes   |
| **Buttons, inputs, compact controls** | `radius.md`   | Slightly sharper so actions read as controls, not as document pages |
| **Small chips, nested UI**            | `radius.sm`   | Optional; keep nested corners ≤ parent radius                       |
| **Badges, pills**                     | `radius.pill` | Clear “tag” affordance                                              |


## Layout rhythm rules

1. Use 16px baseline spacing (`space.4`) for most component internals.
2. Distinguish list density with **vertical** spacing first (`space.2`–`space.3`); avoid changing padding, font size, and border weight all at once.
3. Keep actions grouped with 8–12px internal gaps and 16–24px separation from body content.
4. Use `space.0` only where **2px** is intentional (hairlines); do not replace `space.2` or `space.3` for “normal” gaps.