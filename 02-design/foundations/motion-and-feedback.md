# Motion and feedback

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Motion tokens


| Token                    | Value                        |
| ------------------------ | ---------------------------- |
| `motion.duration.fast`   | 120ms                        |
| `motion.duration.base`   | 180ms                        |
| `motion.duration.slow`   | 260ms                        |
| `motion.easing.standard` | `cubic-bezier(0.2, 0, 0, 1)` |


In CSS mirrors: `--motion-fast`, `--motion-base`, `--motion-slow`, `--motion-easing-standard`.

## Interaction guidance

1. Favor **opacity** and **short position** changes over dramatic transforms (no bounce, no large parallax).
2. Use `**motion.duration.fast`** for hover/focus, `**motion.duration.base`** for panel transitions, `**motion.duration.slow`** only for larger state changes (e.g. mode banner).
3. **Do not** animate layout properties that reflow the monitoring feed (e.g. animating `height` on many rows at once); prefer instant swap or a single overlay.

## Reduced motion (`prefers-reduced-motion`)

**Prototypes and shipped UI:** Respect `prefers-reduced-motion: reduce`.

- Treat motion durations as **effectively zero** for non-essential transitions (see `[tokens.css](../tokens/tokens.css)` media query).
- Keep **meaningful** feedback: do not remove error text or focus rings; replace motion with **instant** state or a single opacity cross-fade ≤ **one frame** of perceived change.
- Avoid auto-playing motion in the feed chrome (no ambient pulsing headers).

## Loading and skeletons

- Prefer **opacity pulse** on placeholders, with duration ≤ `**motion.duration.fast`**.
- **No lateral shimmer** (no sliding gradient) on **feed/list** skeletons — it competes with scanning and reads as “live” content moving.
- One **global** loading bar at top is acceptable if it moves in a single axis and does not loop aggressively.

## Feedback model (semantic, with copy)

- **Info:** neutral surface + **accent** indicator (rail, icon, or link) — never rely on motion alone.
- **Success:** `success` semantic + short confirmation string.
- **Warning:** `warning` semantic + explicit next action.
- **Critical:** `critical` semantic (UI red token) + high-priority action path.

Avoid hidden status changes. Every significant state shift should include **visible text** (or an accessible name exposed to assistive tech), not only color or animation.