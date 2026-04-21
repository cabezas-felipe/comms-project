# Changelog

## 0.2.1 — 2026-04-18

- Final color decisions confirmed and consolidated: accent `#4F6887`, warning `#D15400`, critical `#922B2E`, success `#68874F`, highlight `#CEBA71`, text primary `#454545`; secondary purple stays removed from UI schema.
- Kept only one preview file: rewrote [color-preview.html](color-preview.html) as the single canonical swatch + rationale artifact; removed `color-preview-harmony.html` and `color-preview-semantic.html`.
- Updated [README.md](README.md) and [foundations/color.md](foundations/color.md) to reference only `color-preview.html`.
- Bumped [tokens/design-tokens.json](tokens/design-tokens.json) `meta.version` to `0.2.1`.

## 0.2.0 — 2026-04-18

- **Removed** `color.secondary.*` from [design-tokens.json](tokens/design-tokens.json) and [tokens.css](tokens/tokens.css) — use `accent.soft`, borders, and `text.muted` for non-status emphasis; [archive/brand-seed.md](archive/brand-seed.md) + [foundations/color.md](foundations/color.md) updated.
- Added semantic preview page (later consolidated into `color-preview.html` in 0.2.1) — accent/warning/text guidance, stoplight vs orange+yellow split, WCAG note for explore green `#758C48`, former purple reference.
- [README.md](README.md) — link to semantic preview; [color-preview.html](color-preview.html) — removed purple swatch.

## 0.1.9 — 2026-04-18

- **Manual revert** (no git in repo): restored `brand-seed.md` and `pushback-review.md` (now archived under `archive/`); reverted `foundations/color.md`, `README.md`, `principles.md`, `CLAUDE.md`, `ai-usage.md`, `tokens/design-tokens.json` `meta` to **0.1.6** / `comms-v0-design-system`; restored full incremental history below. Removed **1.0.0** “clean slate” consolidation per your request.

## 0.1.8 — 2026-04-18

- Added harmony exploration preview (later consolidated into `color-preview.html` in 0.2.1) — optional success / purple / yellow variants, yellow fill+text demos, blue–orange adjacency note.
- [README.md](README.md) — link + renumber “Start here” list.
- [foundations/color.md](foundations/color.md) — link to harmony preview from Preview section.

## 0.1.7 — 2026-04-18

- **Component sync pass:** [components/*.md](components/) — aligned with current tokens (`font.family.ui`, `space.0`, selection colors, motion / reduced-motion, color minimums); each spec links tokens, CSS, and foundations.
- **Repo guidance:** [CLAUDE.md](../CLAUDE.md) — new “Design system (prototypes)” section pointing at `02-design/`.

## 0.1.6 — 2026-04-18

- **Step 4 (B + C):** [foundations/motion-and-feedback.md](foundations/motion-and-feedback.md) — token paths aligned with JSON; reduced-motion guidance; loading/skeleton rules; feedback model copy clarified (`critical` = UI red token).
- **Tokens:** [tokens.css](tokens/tokens.css) — `@media (prefers-reduced-motion: reduce)` sets `--motion-fast|base|slow` to `0ms`. [design-tokens.json](tokens/design-tokens.json) — `motion.reducedMotion.note`; version **0.1.6**.

## 0.1.5 — 2026-04-18

- **Step 3 (A + B + guidance):** [foundations/spacing.md](foundations/spacing.md) — `space.0` (2px); list vs card density note; default **radius** roles (`lg` cards/panels, `md` buttons/inputs, `sm` small, `pill` badges).
- **Tokens:** `space.0` in [design-tokens.json](tokens/design-tokens.json); `--space-0` in [tokens.css](tokens/tokens.css).
- [ai-usage.md](ai-usage.md) — spacing constraint; [input.md](components/input.md) — default `radius.md`.

## 0.1.4 — 2026-04-18

- **Step 2 (recommended B + C):** [foundations/typography.md](foundations/typography.md) — `font.family.ui` for dense monitoring UI; metadata prefers `type.size.sm`+; `xs` for badges only.
- **Tokens:** `font.family.ui` in [design-tokens.json](tokens/design-tokens.json); `--font-ui` in [tokens.css](tokens/tokens.css).
- [ai-usage.md](ai-usage.md) — typography constraint updated.

## 0.1.3 — 2026-04-18

- **Step 1 (recommended B + C):** [foundations/color.md](foundations/color.md) — minimum indicator sizes; selection uses neutrals, not accent fill.
- **Tokens:** `color.surface.selected` (`#EDF2F7`), `color.border.selected` (`#B3C0D4`); mirrored in [tokens.css](tokens/tokens.css).
- [color-preview.html](color-preview.html) — swatches for selection tokens.
- [ai-usage.md](ai-usage.md) — constraint for selection vs accent.

## 0.1.2 — 2026-04-18

- **Step 0 pushback (B):** `color.critical.base` → `#922B2E`, `color.critical.soft` → `#F4E6E7` for clearer separation from `color.warning.base` (`#D15400`). Brand swatch `#87524F` kept as reference in [archive/brand-seed.md](archive/brand-seed.md).
- Documented **future token pass (C)** candidates in brand seed (`critical.border`, `warning.border`, `critical.onSoft`).
- Updated [archive/pushback-review.md](archive/pushback-review.md) Step 0 decision + checklist; [color-preview.html](color-preview.html) shows token vs brand reference.

## 0.1.1 — 2026-04-18

- Body type corrected to **Calluna** everywhere (tokens, foundations, brand seed, AI usage).
- Added [color-preview.html](color-preview.html) for in-browser swatch review.
- Added [archive/pushback-review.md](archive/pushback-review.md) to work through foundation decisions collaboratively.

## 0.1.0 — 2026-04-18

- Created v0 design system structure under `02-design/`.
- Added foundations for color, typography, spacing, and motion/feedback.
- Added machine-readable tokens in JSON and CSS variable formats.
- Added starter component specs: button, input, card, alert, badge, layout shell.
- Added monitoring-first domain pattern tied to interview synthesis.
- Integrated brand seed values (primaries, secondaries, typography).
- Added challenge notes for warning/critical separation and yellow contrast usage.