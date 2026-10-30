# Motion and feedback

Source of truth: [tokens/design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Motion tokens

| Token | Value | When to use |
| --- | --- | --- |
| `--transition-base` | `180ms cubic-bezier(0.2, 0, 0, 1)` | Default for hover/focus and panel transitions |
| `--easing-editorial` | `cubic-bezier(0.2, 0, 0, 1)` | Named easing for Tailwind `transition-*` utilities |

In Tailwind: use `transition-[property]` with `duration-[120|180|260]` and `ease-[editorial]` as needed. `--transition-base` covers the common case.

## Interaction guidance

1. **Favor opacity and short position changes** over dramatic transforms. No bounce, no large parallax.
2. **Duration by scope:**
   - `≈120ms` — hover / focus state changes
   - `180ms` (`--transition-base`) — panel and row transitions
   - `≈260ms` — larger state changes (e.g. a mode banner appearing)
3. **Do not animate layout properties** that reflow the monitoring feed (e.g. animating `height` on many rows at once). Prefer an instant swap or a single overlay; the feed must stay scannable during updates.

## Reduced motion (`prefers-reduced-motion`)

- `tokens.css` sets `--transition-base` to `0ms` under `@media (prefers-reduced-motion: reduce)` — non-essential transitions snap instantly.
- Keep **meaningful** feedback: do not remove error text or focus rings. Replace motion with an instant state change or a single opacity cross-fade ≤ one perceived frame.
- **No auto-playing motion** in feed chrome (no ambient pulsing headers, no looping shimmer on the sidebar).

## Loading and skeletons

- Use **opacity pulse** on placeholders, duration ≤ 120ms.
- **No lateral shimmer** (sliding gradient) on feed/list skeletons — it competes with scanning and reads as live content moving.
- One global loading bar at the top is acceptable if it moves in a single axis and does not loop aggressively.
- **Paired-state continuity:** When a loading (or skeleton) screen and its destination share the same chrome, lock the hero and the first content band to the same vertical anchors. Top-align the form stack; reserve helper-line height so copy length and CTAs appearing later do not shift those anchors. Rows below the first band may reflow.

## Feedback model

| State | Color | Motion | Copy requirement |
| --- | --- | --- | --- |
| Info / new content | [Story-status pill](../components/badge.md) Rising (`--status-rising` + soft) | Fade-in, no slide | Label: "Rising" or explicit delta text |
| Stable | Story-status pill Stable | Instant / no animation | Label: "Stable" |
| Falling | Story-status pill Falling | Instant / no animation | Label: "Falling" |
| System success | `--signal-positive` | Short opacity fade | Confirmation string |
| System warning | `--signal-warning` | None beyond reveal | Explicit next action |
| System error / critical | `--destructive` | None beyond reveal | High-priority action path |

Avoid hidden status changes. Every significant state shift must include **visible text** (or an accessible name for assistive tech), not only color or animation.
