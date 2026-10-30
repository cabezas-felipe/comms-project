# Typography

Source of truth: [tokens/design-tokens.json](../tokens/design-tokens.json).

## Families

| Role | Family | Used for |
| --- | --- | --- |
| `display` | Newsreader | Narrative headlines, story titles, section headers, Brief title |
| `body` | Inter | All UI chrome, feed metadata, timestamps, labels, body copy, button labels |
| `mono` | JetBrains Mono | Code, IDs, optional timestamps in developer contexts |

**Newsreader** is an optical-size variable serif designed for editorial news contexts. Its x-height and stroke contrast are tuned for on-screen reading at display sizes and remain legible at smaller heading sizes — matching Tempo's "scan before read" requirement. Use `font-optical-sizing: auto` wherever Newsreader renders.

**Inter** is the default for all UI chrome. Its uniform spacing and high legibility at small sizes make it ideal for the dense monitoring feed, metadata rows, and action labels. It is never the display font.

**JetBrains Mono** is reserved for code, raw IDs, and optional timestamp treatments in technical contexts. Do not use it as a general UI font.

## Type scale

| Token | Size | Role |
| --- | --- | --- |
| `xs` | 12px | Caption — badge labels, pill text, footer metadata |
| `sm` | 14px | Label — feed row metadata (outlet, time, channel), secondary UI labels, **button labels** |
| `base` | 16px | Body — description copy, notes, drafting panel text |
| `lg` | 18px | Heading — section titles, panel headers |
| `xl` | 20px | Display-secondary — Morning Brief header, sub-section titles |
| `2xl` | 24px | Display-hero — page-level editorial headline |

Reserve `text-xs` for badges, pills, and non-essential labels — never as the default for primary scanning content. Prefer `text-sm` minimum for feed metadata that users scan to triage.

**Onboarding form intros** use a larger display size than `2xl` — see [form-intro — onboarding form headline](../patterns/form-intro.md#onboarding-form-headline-exception). Do not retarget those screens to 24px.

## How the scale was decided

Tempo's monitoring feed concentrates information density in the `sm`–`lg` band. The Brief header earns `xl` as the single biggest fixed landmark per session. Story headlines in the feed use `lg` as the dominant scanning target. Metadata (outlet, time, status label) stays at `sm` — enough to read without competing with the headline. Badges and pills use `xs` only because they are accompanied by color + shape context.

## Display metrics (Newsreader)

Apply consistently across all `display` uses:

| Property | Value |
| --- | --- |
| `font-optical-sizing` | `auto` |
| `font-weight` | `600` for section headers · `700` for narrative headlines |
| `line-height` | `1.25` (`leading-tight`) |
| `letter-spacing` | `-0.015em` |
| `font-style` | **upright only** — do not use italic for display headings in the UI |

Italic is not used in Tempo's UI. Newsreader's upright weight carries the editorial authority without the formality of oblique text.

## Label casing

| Role | Casing | Typical size | Where |
| --- | --- | --- | --- |
| **Form field labels** | Sentence case | `sm` (14px) | Inputs, onboarding facets — see [input](../components/input.md) |
| **Section metadata** | Uppercase + tracking | `xs` (12px) | Feed / card chrome (“WHAT CHANGED”, “KEY SOURCES”) — see [card](../components/card.md), [color](color.md) |

Do not borrow section-metadata uppercase for form labels, and do not change casing when a field moves between empty, focus, and filled.

## Punctuation (product UI)

Applies to **user-facing product copy** (screens, buttons, labels, empty states, errors, in-product emails). Does not constrain internal docs or this design-system prose.

| Mark | Product UI |
| --- | --- |
| Em dash (`—`) | **Do not use.** Prefer a period, comma, colon, or a new sentence. |
| En dash (`–`) | Allowed for ranges and paired names (e.g. `Colombia–US`). |
| Hyphen (`-`) | Allowed in compound words and ordinary English. |
| Trailing `→` | Optional on forward CTAs (see [button](../components/button.md)). |

## Time notation (product UI)

Keep relative and absolute clock formats in the same compact register — do not mix `12m` with `12:51 PM`.

| Kind | Format | Examples |
| --- | --- | --- |
| Relative | Digit + unit letter — **no** `ago` | `12m`, `2h`, `3d` |
| Absolute clock | `h:mm` + lowercase `a` or `p`, **no space** before the letter | `12:51p`, `9:05a` |

Rules:

1. Use **a** / **p** (not `AM` / `PM`, not `am` / `pm` as a separate token with a space).
2. Relative units stay single-letter (`m`, `h`, `d`) — not `min` / `mins` in the feed. **Floor** to the largest unit (`60–119m` → `1h`; do not default to `1h 20m`).
3. Do **not** append `ago` in product chrome (row meta, Sources cells, filters). Reserve “ago” only for full prose sentences if ever needed.
4. Freshness lines follow the same absolute rule (`Updated 12:51p`). Remaining time uses **in** (`Next update in ~36m`) — different job from relative age.
5. Evidence counts use the noun **sources** (`8 sources`). Row meta: `{relative} · {n} sources` (e.g. `12m · 8 sources`).

## Usage rules

1. **Use `display` (Newsreader) for narrative headlines, the Brief title, section headers, and page-level editorial signposts — not for whole paragraphs.**
2. **Use `body` (Inter) for all feed metadata, table chrome, button labels, captions, and body copy.**
3. **Use `mono` (JetBrains Mono) for code, raw IDs, and optional timestamps only.**
4. **Avoid more than two weights in one list row or card.** Prefer `font-medium` (500) + `font-semibold` (600); use `font-bold` (700) only for the single dominant headline per screen region.
5. **`text-xs` is reserved for badges and pills.** Feed metadata should never drop below `text-sm`.
6. **Do not introduce off-scale font sizes.** Before adding a new size, check whether an existing role covers the need.
7. **Form field labels are sentence case; section metadata may use uppercase tracking.** See [Label casing](#label-casing) above.
