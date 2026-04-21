# Typography

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Font roles


| Role                    | Token                 | Stack                                                                    |
| ----------------------- | --------------------- | ------------------------------------------------------------------------ |
| Headings / signposting  | `font.family.heading` | `"Helvetica Neue", "Helvetica", "Arial", sans-serif`                     |
| **Dense UI / metadata** | `font.family.ui`      | Same as `heading` — **sans** for feeds, tables, timestamps, outlet names |
| Body / longform         | `font.family.body`    | `"Calluna", "Georgia", "Times New Roman", serif`                         |
| Mono (utility)          | `font.family.mono`    | `ui-monospace, SFMono-Regular, Menlo, monospace`                         |


`font.family.ui` exists so prototypes do not force Calluna into every table cell. It is **not** a third visual voice: it matches headings/signposting.

## Where each family is used


| Surface                                     | Family token | Typical sizes |
| ------------------------------------------- | ------------ | ------------- |
| Page title, section headers, nav            | `heading`    | `lg`–`xxl`    |
| Feed rows: headline / outlet / **metadata** | `ui`         | `sm`–`md`     |
| Feed row: optional excerpt or quote         | `body`       | `sm`–`md`     |
| Drafting panel, long statements, notes      | `body`       | `md`–`lg`     |
| Code, IDs, timestamps (optional)            | `mono`       | `xs`–`sm`     |


## Type scale


| Token           | Size |
| --------------- | ---- |
| `type.size.xs`  | 12px |
| `type.size.sm`  | 14px |
| `type.size.md`  | 16px |
| `type.size.lg`  | 18px |
| `type.size.xl`  | 20px |
| `type.size.xxl` | 24px |


### Metadata and scan-heavy lines

- Prefer `**type.size.sm` (14px) minimum** for feed metadata (time, source, channel) when paired with `font.family.ui`.
- Reserve `**type.size.xs`** for badges, pills, and non-essential labels — not as the default for primary scanning text.

## Line height and weight

- Body default line-height: `1.5` (`type.leading.normal`)
- Heading line-height: `1.25` (`type.leading.tight`)
- Weights: `400`, `500`, `600`

## Rules

1. Use `**heading**` for titles, nav, and explicit signposts — not for whole paragraphs.
2. Use `**ui**` for dense monitoring lists, table chrome, and **short** metadata strings.
3. Use `**body`** (Calluna) for paragraphs, drafting surfaces, and any copy meant to be read continuously.
4. Avoid more than **two weights** in one list row or card.

## Calluna in prototypes

- If the build target cannot load Calluna, keep `**body`** rules but accept fallback for v0 only; track “font parity” as a prototype limitation, not a product decision.

