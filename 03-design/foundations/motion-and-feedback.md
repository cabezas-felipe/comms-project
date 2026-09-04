# Motion and feedback

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Motion tokens


| CSS var / value              | Value                             |
| ---------------------------- | --------------------------------- |
| `--transition-base`          | `180ms cubic-bezier(0.2, 0, 0, 1)` |
| `--motion-easing-editorial`  | `cubic-bezier(0.2, 0, 0, 1)`      |


In Tailwind: use `transition-[property]` with `duration-[120|180|260]` and `ease-[editorial]` as needed. `--transition-base` covers the common case (hover/focus at 180ms).

## Interaction guidance

1. Favor **opacity** and **short position** changes over dramatic transforms (no bounce, no large parallax).
2. Use shorter durations (≈120ms) for hover/focus, `--transition-base` (180ms) for panel transitions, longer durations (≈260ms) only for larger state changes (e.g. mode banner).
3. **Do not** animate layout properties that reflow the monitoring feed (e.g. animating `height` on many rows at once); prefer instant swap or a single overlay.

## Reduced motion (`prefers-reduced-motion`)

**Prototypes and shipped UI:** Respect `prefers-reduced-motion: reduce`.

- `tokens.css` sets `--transition-base` to `0ms` under the media query — non-essential transitions snap instantly.
- Keep **meaningful** feedback: do not remove error text or focus rings; replace motion with **instant** state or a single opacity cross-fade ≤ **one frame** of perceived change.
- Avoid auto-playing motion in the feed chrome (no ambient pulsing headers).

## Loading and skeletons

- Prefer **opacity pulse** on placeholders, with duration ≤ 120ms.
- **No lateral shimmer** (no sliding gradient) on **feed/list** skeletons — it competes with scanning and reads as "live" content moving.
- One **global** loading bar at top is acceptable if it moves in a single axis and does not loop aggressively.

## Feedback model (semantic, with copy)

- **Info:** `--accent` surface + `--ember` indicator (rail, icon, or link) — never rely on motion alone.
- **Success:** `--signal-positive` semantic + short confirmation string.
- **Warning:** `--signal-warning` semantic + explicit next action.
- **Critical:** `--destructive` semantic + high-priority action path.

Avoid hidden status changes. Every significant state shift should include **visible text** (or an accessible name exposed to assistive tech), not only color or animation.
