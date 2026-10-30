# Metastory open state

**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md)
**Related:** [Narrative row](../components/narrative-row.md) · [Dashboard filters](dashboard-filters.md) · [Button](../components/button.md) · [Source reader](source-reader.md)
**Product:** [Why this matters — field doctrine (archive)](../../../02-product/contracts/archive/why-this-matters--field-doctrine.md)

## Purpose

In-feed expand of one meta-story for interrupt-check: judgment, situation, prepared next step, provenance, and a platform-honest brief action. Single expand at a time. Does not leave the Dashboard.

## Container

| Rule | Detail |
| --- | --- |
| Pattern | **In-feed expand** — row opens in place; siblings stay visible collapsed |
| Single open | Opening another row closes the current one |
| Collapse | Whole-row tap again **and** trailing chevron (∧ when open) — the **only** collapse for the open body (including Sources) |
| Open fill | `--surface-raised` on the **open body only** (Why this matters through Sources) |
| Not filled | Meta, title, and dek stay `--surface-page` — same as collapsed. Do not wash the whole row on expand |
| Inset padding | `16px` all sides (`p-4`) on the raised open body |
| Hairline under dek | `1px` `--border`, **same length** as between-row hairlines (full feed measure / row content width). Raised open body starts **below** this rule. Do not inset the under-dek rule relative to collapsed separators |

## Hierarchy

Reading order (interrupt-check):

1. **Why this matters** — full width; dominant posture (only full-width content band)
2. **Hairline under Why** — `1px` `--rule` / `--border` inside the open body (full open-body content width)
3. **What happened \| What changed** — paired equal columns on desktop; Happened before Changed
4. **What comes next \| Actions** — paired equal columns on desktop (same widths as the H\|C row); Next before the action column
5. **Sources** — full-width provenance rail last

### Desktop layout

| Band | Layout |
| --- | --- |
| Why this matters | Full width |
| Why hairline | Full open-body content width |
| What happened · What changed | **Equal** two-up (`flex: 1 1 0`, `gap` 24px) |
| What comes next · Actions | **Equal** two-up (same column widths as H\|C) |
| Sources | Full width below Next\|Actions |

### Mobile layout

Stack vertically: Why → hairline → What happened → What changed → What comes next → platform CTA → Sources. No side-by-side pairs.

### Why identity

| Lever | Rule |
| --- | --- |
| Label | `--ink-secondary` (stronger than other section labels) |
| Body | **Same** as other section bodies: Inter, `text-sm` (14/22), `--ink-secondary`, regular weight |
| Hairline | Under Why only (inside open body) |
| **Do not** | Newsreader / display family for Why body; size step-up vs other bodies; status wash; per-section cards; left accent bars |

Other section labels use `--ink-muted`. All section **bodies** share the same Inter 14/22 secondary treatment — hierarchy comes from structure (full-width → pairs → foot), not a second type style.

**Breath (B):** Full-width Why this matters (do not narrow the measure if it forces wrap). **24px** (`gap-6`) between open-body bands.

## Section labels (UI)

Aligned with the product value beat; eng field names in parentheses where they differ:

| UI label | Role |
| --- | --- |
| **Why this matters** | Monitoring posture + comms readiness (`whyItMatters`) |
| **What happened** | Multi-source synthesis (`Summary`) |
| **What changed** | User-relative delta |
| **What comes next** | Context-grounded prep blurb for the brief action (non-directive; pp5) |
| **Sources** | Provenance — key list on desktop; full cluster on mobile |

## Open-body spacing

One rhythm for the bands inside the open stack — **same on desktop and mobile**:

| Between | Gap |
| --- | --- |
| Open body chrome | **16px** padding all sides (`p-4`) inside `--surface-raised` |
| Why → hairline → H\|C (or Happened on mobile) | **24px** section step (hairline sits in the Why block; then 24px to the next band) |
| Support / action bands | **24px** between H\|C row, Next\|Actions row, and Sources (mobile: between each stacked section). When Next\|Actions **stacks** to one column, the same **24px** applies between Next body and the brief CTA — do not keep the two-up Actions `padding-top` align offset |

Do not use a stronger hairline above Sources; equal section spacing is enough. Do not leave trailing edges unpadded (CTA / Sources must not kiss the raised edge).

## Actions (desktop) · CTAs (platform)

### Desktop — Actions column

| Rule | Detail |
| --- | --- |
| Pairing | Right column of the **What comes next \| Actions** row — equal width to What changed |
| MVP control | **Copy brief** only — Primary (F) |
| Alignment | **Two-up only:** top of the control aligns with the Next **body** (below the section label) — typically ~`22px` top padding on the Actions column so Copy sits on the body baseline, not the label. **Stacked (single column):** drop that offset (`padding-top: 0`); Next → CTA → Sources uses the same **24px** section step as mobile — do not carry the two-up align hack into a stack. **Stack only when the feed column is compressed** (desktop source reader **docked**). Mid-width **overlay** does not push the feed — keep full desktop two-up ([source reader](source-reader.md)) |
| Future CTAs | Additional controls stack in this column as **Secondary (G)** or Ghost — **one Primary per region** |
| Not | A second Primary beside Copy; directive “send/publish” actions (pp5 / dp2) |

### Platform split

One primary control per platform. Do **not** show both Share and Copy on the same surface.

| Platform | Control | Variant | Behavior |
| --- | --- | --- | --- |
| **Desktop** | **Copy brief** only | Primary (F) | In the Actions column; copies the share package to the clipboard |
| **Mobile** | **Share brief** only | Primary (F) | Directly under What comes next; system share sheet when available; silent copy fallback (toast) if share is unavailable |

Package (MVP): title · Why this matters · short What happened / Summary · lead article URL. **What comes next** stays in-product only (not in the outbound package).

### Copy brief — success (desktop)

| Rule | Detail |
| --- | --- |
| Trigger | Successful clipboard write of the share package |
| Label | **`Copied`** (not `Copied!` / `Copied to clipboard`) |
| Chrome | Stay **Primary (F)** — ink border + ink label. **Do not** mute to Secondary / form-incomplete / Resend-cooldown gray |
| Interaction | Non-interactive ~**1.5–2s** (`disabled` / `aria-disabled`; no hover; no second clipboard write), then revert to **Copy brief** |
| A11y | Visually hidden live region announces `Copied` |
| Not | Check glyph (retired explore); `--signal-positive` border/text; toast on success; looking like form-incomplete Secondary |
| Fail | Quiet toast on 06 — `Couldn't copy. Try again.` (chrome pill · destructive text · no icon; message-only; bottom-center; **Copy brief** stays Primary F); stay in open story ([monitoring workflow](monitoring-workflow.md)). Paper: [Home · Copy brief fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/OM6-0) |

### Share brief — success / fail (mobile)

| Rule | Detail |
| --- | --- |
| Sheet opens | System **activity view** (`UIActivityViewController` / iOS share sheet) — no Tempo confirm chrome (no **Shared** label, no success toast) |
| Tempo scrim | While the system sheet is up: `--ink-primary` **30%** over the open dashboard (same reader-family strength as [source reader](source-reader.md); lighter than [modal](../components/modal.md) **45%**) |
| Preview | `LPLinkMetadata`: metastory title + lead-source host (e.g. `miamiherald.com`); close via sheet **X** / drag |
| Not | Button label flip to **Shared**; quiet toast on sheet open or dismiss (completion is OS-owned and unreliable) |
| Fallback (share unavailable, copy ok) | Optional quiet toast `Couldn't share. Copied.` (same chrome as fail toast · ink-secondary · no icon; **Share brief** unchanged) — 06: [Home · Copy / Share fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/P0C-0) |
| Hard fail | Quiet toast `Couldn't share or copy. Try again.` (chrome pill · destructive · no icon; message-only; bottom-center; **Share brief** stays) — 06: [Home · Copy / Share fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/P0C-0) |
| Paper | [Home · Open · Copied / Share](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/LBO-0) — desktop **Copied** + mobile iOS activity view |


### Band order (CTA vs Sources)

| Platform | Order |
| --- | --- |
| **Desktop** | Next\|Actions row → **Sources** below |
| **Mobile** | What comes next → **Share brief** → **Sources** rail |

Do **not** put Sources left and Copy right on one foot row (retired).

## Sources

| Rule | Detail |
| --- | --- |
| Label | **Sources** (matches evidence noun on the row) |
| Cell | `Outlet` + relative time (e.g. `Miami Herald` `12m`) — Inter; outlet `--ink-secondary`, time `--ink-muted` |
| Interaction | Outlet opens the [source reader](source-reader.md) (press snippet = Tempo article summary when present, labeled; X = post text); outbound is `Open original` inside the reader — not a direct jump to the article URL |
| Share URL | Lead / primary source article (not Tempo) — see product share package |
| Not | Status pills, filter chips, Always-on weight, middot-only lists, ghost chips |

### Desktop

| Rule | Detail |
| --- | --- |
| Default | Up to **five key** sources in a **single-row** horizontal rail (product: key ranking) |
| Overflow | Trailing **`+n`** (e.g. `+3`) — rest of the **cluster**, not a truncation of the five |
| `+n` style | Tappable text: `--ink-primary` + medium — **not** muted like [tag `+n`](../components/narrative-row.md#tag-rules) |
| Expand | **One-way** — tap `+n` reveals remaining outlets in place; **no** “Show less”, **no** sources chevron |
| Collapse | Closing the metastory row (chevron / whole-row tap) resets Sources |
| Expanded layout | **Wrap** to additional lines (`flex-wrap`) — **not** horizontal scroll. Desktop width is enough; wrap keeps every outlet visible without a second gesture |
| Scroll cue | **None** on desktop (no peek/fade) — wrap or fit replaces scroll |

### Mobile

| Rule | Detail |
| --- | --- |
| Content | **Full cluster** always (no key-five cap, no `+n`) |
| Layout | Single-row **horizontal scroll** — `nowrap`, overflow clip |
| Scroll cue | When content overflows: **peek** (next cell clipped) **+ trailing fade** that **overlays** the clipped glyphs into `--surface-raised` (~48–56px; e.g. negative-margin mask on top of the rail — do **not** reserve empty width beside a hard clip). No chevron, no “swipe” copy. Hide the fade when everything fits |
| Not | Inline wrap; trailing `+n`; ghost-chip carousel; edge chevrons |

Same quiet text cells as desktop (`Outlet` + time), not bordered chips.

## Mobile (summary)

Stack: Why → hairline → What happened → What changed → What comes next → Share brief → Sources (full-list horizontal scroll with peek + fade when overflowing). Keep **24px** between bands. Artboard height: min 844, `fit-content` when content exceeds (non-keyboard).
