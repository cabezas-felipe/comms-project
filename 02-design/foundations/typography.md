# Typography

Source of truth: [design-tokens.json](../tokens/design-tokens.json) and [tokens/tokens.css](../tokens/tokens.css).

## Font roles


| Role                        | Token / Tailwind class | Stack                                         |
| --------------------------- | ---------------------- | --------------------------------------------- |
| Display / editorial headers | `font.family.display` / `font-display` | `"Fraunces", Georgia, serif`  |
| **UI / sans** (default)     | `font.family.sans` / `font-sans`       | `"Inter", system-ui, sans-serif` |
| Mono (utility)              | `font.family.mono` / `font-mono`       | `"JetBrains Mono", ui-monospace, monospace` |


`font-display` (Fraunces) is the editorial voice for page titles, section headers, and display text. `font-sans` (Inter) is the default for all UI chrome, feeds, tables, metadata, and body copy.

## Where each family is used


| Surface                                     | Family         | Typical sizes |
| ------------------------------------------- | -------------- | ------------- |
| Page title, section headers, nav            | `font-display` | `lg`–`xxl`    |
| Feed rows: headline / outlet / **metadata** | `font-sans`    | `sm`–`md`     |
| Feed row: excerpt or quote                  | `font-sans`    | `sm`–`md`     |
| Drafting panel, long statements, notes      | `font-sans`    | `md`–`lg`     |
| Code, IDs, timestamps (optional)            | `font-mono`    | `xs`–`sm`     |


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

1. Use `font-display` (Fraunces) for titles, nav, and editorial signposts — not for whole paragraphs.
2. Use `font-sans` (Inter) for dense monitoring lists, table chrome, metadata strings, and body copy.
3. Use `font-mono` (JetBrains Mono) for code, IDs, and optional timestamps.
4. Avoid more than **two weights** in one list row or card.

