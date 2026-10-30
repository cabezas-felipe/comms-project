# Spacing and radius

Source of truth: [tokens/design-tokens.json](../tokens/design-tokens.json).

## Spacing

No dedicated `--space-*` token layer — the prototype applies spacing via standard Tailwind utilities (`p-4`, `gap-3`, etc.) directly. This matches the PassPlate precedent: where the screens aren't drifting on spacing, a token layer adds a second name for the same numbers without fixing a real failure mode. Usage notes below are documentation, not CSS variables consumed at runtime.

### Scale reference

| Step | Value | Tailwind | Typical use |
| --- | --- | --- | --- |
| 0 | 2px | `gap-px` / `p-px` | Hairline gaps, divider-adjacent text, status-rail gap |
| 1 | 4px | `gap-1` / `p-1` | Tight icon / text separation |
| 2 | 8px | `gap-2` / `p-2` | Small gaps in controls, badge internals |
| 3 | 12px | `gap-3` / `p-3` | Compact monitoring feed rows |
| 4 | 16px | `gap-4` / `p-4` | Default component padding |
| 5 | 20px | `gap-5` / `p-5` | Card internals, generous variant |
| 6 | 24px | `gap-6` / `p-6` | Section spacing |
| 8 | 32px | `gap-8` / `p-8` | Large panel spacing |
| 10 | 40px | `gap-10` / `p-10` | Page-level block spacing |

### Density guidance

Use **one scale**; change **feel** by which step you use vertically. For **monitoring feed rows**, prefer the tighter end (`gap-2`–`gap-3` between stacked lines, `gap-3` between row blocks) — density is a feature here, not a constraint to fight. For **cards, drawers, and drafting chrome**, keep breathing room at `p-4` or higher so summaries and draft-action controls stay legible under time pressure.

Do not tighten cards and feed rows at the same time. Adjust one region per iteration so you can isolate what helped.

## Radius

The system uses a single base value (`--radius: 0.25rem`) with Tailwind calc variants. All components draw from this scale only.

| Role | Tailwind class | Size | Rationale |
| --- | --- | --- | --- |
| Cards, panels, modals | `rounded-lg` | `--radius` ≈ 4px | Calm, institutional surfaces; matches monitoring + drafting panes |
| Buttons, inputs, compact controls | `rounded-md` | `calc(--radius - 1px)` ≈ 3px | Slightly sharper so actions read as controls, not as document pages |
| Small chips, nested UI | `rounded-sm` | `calc(--radius - 2px)` ≈ 2px | Optional; keep nested corners ≤ parent radius |
| Badges, status pills | `rounded-full` | Full pill | Clear "tag" affordance — status pills are always pill-shaped |

## Usage rules

1. **`p-4` (16px) is the baseline** for most component internals. Tighten only with explicit justification (feed rows) or explicit instruction.
2. **Distinguish feed density with vertical spacing first** (`gap-2`–`gap-3`). Avoid changing padding, font size, and border weight simultaneously — you lose the ability to attribute the effect.
3. **Keep actions grouped** with `gap-2`–`gap-3` internal gaps and `gap-4`–`gap-6` separation from body content.
4. **Do not nest a `rounded-lg` inside a `rounded-lg`.** Inner containers should always use a smaller radius step than their parent.
5. **Status-rail minimum: 3px wide.** Use `gap-px` + `p-px` only when targeting a literal 2px hairline. Do not replace `gap-2` or `gap-3` with `gap-px` to "save space" on non-hairline elements.
