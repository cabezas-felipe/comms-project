# Foundation pushback review (v0)

Working log: **what we chose**, **why**, **what to challenge**, and **keep / change** decisions. Update this file when you lock a choice, and mirror changes in [tokens/design-tokens.json](tokens/design-tokens.json) and [tokens/tokens.css](tokens/tokens.css) when tokens change.

**Demo screen spec:** not in scope for this pass (per your direction).

---

## Step 0 — [Brand seed](brand-seed.md)

| What we have | Your primaries/secondaries + Calluna / Helvetica Neue mapped to semantic roles. |
| Why | Keeps personal palette while forcing meaning (accent vs warning vs critical) instead of random hex in UI. |
| Pushback | (1) Orange vs red-brown can blur at small size. (2) Yellow is weak for text-on-white. (3) Metadata contrast if `textMuted` drifts too light. |
| Options | **A)** Keep mapping as-is; enforce separation with layout (icons, labels, thickness). **B)** Nudge `critical` or `warning` hue for more separation (tokens only). **C)** Introduce a `criticalBorder` or stronger `critical` text token for alerts only. |
| **Decision** | **B applied (2026-04-18):** `color.critical.base` is `#922B2E` in tokens (was brand `#87524F`) for clearer separation from `#D15400` warning. **C backlog:** document future structural tokens in [brand-seed.md](brand-seed.md) after prototype stress-test. |

---

## Step 1 — [Color](foundations/color.md)

| What we have | Semantic groups + brand hex per role + usage rules (icons with warning/critical, yellow as fill, accent for “new”). |
| Why | Monitoring UI needs calm surfaces and **unambiguous** urgency; rules reduce misuse (e.g. success for “new”). |
| Pushback | Same as Step 0 at implementation time: thin indicators and low-light screens. |
| Options | **A)** Keep doc rules; validate in [color-preview.html](color-preview.html). **B)** Add explicit “minimum indicator size” rule (e.g. ≥ 3px rail or icon + 2 words). **C)** Add a second neutral tier for “selected / active row” so accent is not overloaded. |
| **Decision** | **B + C applied (2026-04-18, recommended):** [color.md](foundations/color.md) now has **minimums** (rails, badges, icon+label). Tokens add `color.surface.selected` (`#EDF2F7`) and `color.border.selected` (`#B3C0D4`). `accent` is explicitly **not** for whole-row selection fill. |

---

## Step 2 — [Typography](foundations/typography.md)

| What we have | Helvetica Neue stack for headings/signposts; Calluna stack for body; rem-based scale; weight/line-height rules. |
| Why | Matches your habit; separates **scan UI** (sans) from **long reading / drafting** (serif). |
| Pushback | (1) Dense monitoring lists in serif can feel heavy vs sans body. (2) Calluna must be **loaded or licensed** in host; otherwise Georgia shifts the look. (3) 12px meta can be hard on long sessions. |
| Options | **A)** Keep strict split (current). **B)** Allow **sans for dense tables / metadata only**, Calluna for body paragraphs and editor pane (document as exception). **C)** Bump default meta from `xs` to `sm` for accessibility comfort. |
| **Decision** | **B + C applied (2026-04-18, recommended):** New token `font.family.ui` (same stack as heading) for feeds/tables/metadata; [typography.md](foundations/typography.md) sets **14px minimum** for primary scan metadata; `xs` reserved for badges/non-essential. |

---

## Step 3 — [Spacing](foundations/spacing.md)

| What we have | 4–40px scale, radii, rhythm rules (16px baseline internals). |
| Why | Predictable rhythm reduces visual reorientation when switching monitoring ↔ drafting (aligned with research on interruption cost). |
| Pushback | v0 scale is generic; may feel tight for touch or loose for ultra-dense feeds. |
| Options | **A)** Keep. **B)** Add `space.0` (2px) for hairline tight layouts. **C)** Define **two density presets** (“compact feed” vs “comfortable”) as token aliases later. |
| **Decision** | **A + B applied (2026-04-18):** `space.0` = 2px in tokens. **Guidance (no second preset):** list vs card density paragraph + default **radius** mapping (`lg` cards/panels, `md` buttons/inputs) in [spacing.md](foundations/spacing.md). |

---

## Step 4 — [Motion and feedback](foundations/motion-and-feedback.md)

| What we have | Short durations + standard easing; reduced-motion note; feedback model tied to semantic colors. |
| Why | Limits animation as a new source of interruption; ties motion to meaning. |
| Pushback | Doc does not yet link to token file (minor); no explicit “loading” pattern. |
| Options | **A)** Keep durations. **B)** Add `motion.reduced: prefers-reduced-motion` guidance for prototypes. **C)** Add a one-line rule for **skeleton / loading**: prefer opacity pulse ≤ `fast`, no lateral motion on feed. |
| **Decision** | **B + C applied (2026-04-18):** [motion-and-feedback.md](foundations/motion-and-feedback.md) — `prefers-reduced-motion` prototype rules; loading/skeleton rules (opacity ≤ fast, no lateral feed shimmer). `**tokens.css`:** `@media (prefers-reduced-motion: reduce)` zeroes `--motion-`*. `**design-tokens.json`:** `motion.reducedMotion.note` documents CSS behavior. |

---

## Summary checklist (when you lock decisions)

- Step 0 — Brand seed mapping
- Step 1 — Color foundations
- Step 2 — Typography foundations
- Step 3 — Spacing foundations
- Step 4 — Motion / feedback foundations
- Tokens + CSS updated when decisions required (through **0.2.1**)
- [changelog.md](changelog.md) updated through **0.2.1**