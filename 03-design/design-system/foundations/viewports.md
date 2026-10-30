# Viewports (comps)

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Related:** [source reader](../patterns/source-reader.md) · [dashboard filters](../patterns/dashboard-filters.md) · [layout shell](../components/layout-shell.md)

> Working pattern (v1.2.59). Canonical Paper artboard sizes for UX/UI and UI states. Product breakpoints follow the same widths; height is document-driven except where noted.

## Artboard sizes

| Class | Width × height | Use |
| --- | --- | --- |
| **Desktop** | `1440 × 900` | Happy path + states for ≥ `lg` |
| **Mid** | `1024 × 768` | Unpaired responsive shells (source reader overlay, Account Settings Index). Not a third product — same jobs as desktop/mobile with mid chrome |
| **Mobile · full UI** | `390` × **fit-content** | Full phone UI; extend height when content exceeds one viewport |
| **Mobile · keyboard** | `390 × 844` | Keyboard companion frames only — fixed height so keyboard + field share one viewport |
| **Email · message canvas** | `600` × **fit-content** | Transactional email SoT (Paper **07 - Comms**). Not a product UI artboard |
| **Email · mobile check** | `390` × **fit-content** | Same email HTML at narrow measure — fluid preview, not phone chrome |

## Rules

1. All desktop comps in a review board share **one** size (`1440 × 900`).
2. All mid comps share **`1024 × 768`**.
3. All mobile full-UI comps share width **`390`**; height may grow (`fit-content` / min ~844).
4. All mobile + keyboard comps share **`390 × 844`**.
5. Desktop + mobile pairs live in one step container; mid stays **solo**. Keyboard is an optional third sibling inside the same step.
6. **Email comps** use **message canvas + mobile check** only — do not place emails inside product Desktop / Mobile UI frames. Subject and preheader are specimen labels above the white message (Supabase subject field + hidden preheader div), not part of the visible body chrome.

## Paper review-board hygiene

| Rule | Detail |
| --- | --- |
| Frame contents | **Title + designs only** — no stage banners, specimen inventories, or spacer chrome |
| Board padding | `80` |
| Gap between step containers | `80` |
| Gap inside a pair (title → desktop → mobile) | `48` |
| Naming | Letter suffixes for states: `o01`, `o01a`, `o01b` (not `o01-err`) |

## Specimens

- Mid source reader: [Mid · Source reader](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/KNA-0)
- Mid Account Index: [Mid · Index](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZUN-0)
