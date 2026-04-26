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


| Tailwind class | Size  |
| -------------- | ----- |
| `text-xs`      | 12px  |
| `text-sm`      | 14px  |
| `text-base`    | 16px  |
| `text-lg`      | 18px  |
| `text-xl`      | 20px  |
| `text-2xl`     | 24px  |


### Metadata and scan-heavy lines

- Prefer `text-sm` (14px) minimum for feed metadata (time, source, channel).
- Reserve `text-xs` for badges, pills, and non-essential labels — not as the default for primary scanning text.

## Line height and weight

- Body default line-height: `1.5` (`leading-normal`)
- Heading line-height: `1.25` (`leading-tight`)
- Weights: `font-normal` (400), `font-medium` (500), `font-semibold` (600)

## Rules

1. Use `font-display` (Fraunces) for titles, nav, and editorial signposts — not for whole paragraphs.
2. Use `font-sans` (Inter) for dense monitoring lists, table chrome, metadata strings, and body copy.
3. Use `font-mono` (JetBrains Mono) for code, IDs, and optional timestamps.
4. Avoid more than **two weights** in one list row or card.

