# Brand seed (v0)

This document captures your preferred palette and type choices and maps them into semantic roles used by the token files.

## Inputs received

### Primary colors

- Blue: `#4F6887`
- Orange: `#D15400`
- Core dark: `#454545`

### Secondary colors

- Green: `#68874F`
- Yellow: `#CEBA71`
- Purple: `#6E4F87` (identity / print only — **removed from UI tokens** in v0.2.0; see semantic mapping note)
- Red/Brown: `#87524F`

### Typography

- Headers and signposting: `Helvetica Neue`
- Body and longform content: `Calluna` (load via webfont or host app; fall back to Georgia / Times)

## Semantic mapping for v0


| Semantic role             | Token path           | Value             | Why                                                                                               |
| ------------------------- | -------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| Accent primary            | `color.accent.`*     | `#4F6887`         | Stable, professional action color for primary controls                                            |
| Warning / urgency         | `color.warning.*`    | `#D15400`         | Strong separation from accent for attention states                                                |
| Critical                  | `color.critical.*`   | `#922B2E` (token) | **UI-critical:** redder than brand `#87524F` so small indicators do not read as “another orange.” |
| Success                   | `color.success.`*    | `#68874F`         | Lower-arousal positive confirmation                                                               |
| Highlight / subtle notice | `color.highlight.*`  | `#CEBA71`         | Non-critical callout background only                                                              |
| Core text dark            | `color.text.primary` | `#454545`         | Main content ink on light backgrounds                                                             |


**Note (v0.2.0):** Purple `#6E4F87` is **not** a UI token anymore — use `accent.soft`, `border.`*, and `text.muted` for a second visual channel (tags, charts) without adding another hue to status semantics.

## Pushback and challenge notes

1. **Resolved (Step 0, option B):** Tokens use `#922B2E` for `critical.base` instead of brand swatch `#87524F` so warning orange and critical do not merge at small sizes. Your original red-brown stays the **brand reference** for print or non-UI use.
2. `#CEBA71` should not be used for warning text on white; keep it for backgrounds, tags, or fills with dark text.
3. `#454545` works well for body text, but metadata should not be much lighter than this if scans are time-sensitive.
4. If `Calluna` is not licensed/loaded in a prototype host, body rendering may shift. Keep a deterministic serif fallback stack in tokens.

## Future token pass (Step C — after prototype stress-test)

When real screens exist, consider adding **structural** tokens (same roles, clearer affordances), for example:

- `color.critical.border` — strong border for alert chrome only
- `color.warning.border` — paired with warning fills
- `color.critical.onSoft` — text/icon color guaranteed on `critical.soft`

Add only what a screen proves is missing; avoid token sprawl.

## Next iteration trigger

After one prototype pass, revisit if warning vs critical still confuse in quick-glance tasks; then promote items from the future token pass above.
