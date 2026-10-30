# Button

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md) · [motion](../foundations/motion-and-feedback.md)
**Principles:** [dp1 — Calm by default](../../principles.md) — everyday actions stay quiet so Rising can earn urgency.

> **v1.2.0:** Primary is an **ink outline** (not solid ink fill). Solid ink is retired as the everyday primary so CTAs do not compete with story-status ember or drown the value of a screen.

## Variants

### Primary (F)

| Property | Value |
| --- | --- |
| Background | `--surface-page` or white (`#FFFFFF` on white panels) |
| Border | `1.5px` solid `--ink-primary` |
| Text | `--ink-primary` |
| Role | The **one** forward / recommended action in a screen region |

### Secondary (G)

| Property | Value |
| --- | --- |
| Background | `--surface-page` or white |
| Border | `1px` solid `--border-strong` (`--rule` / `#DEDAD8`) |
| Text | `--ink-primary` |
| Role | Supporting or lower-commitment action beside a primary, or alone when the true next step is outside the UI (e.g. open email) |

### Ghost

| Property | Value |
| --- | --- |
| Background | transparent |
| Border | none |
| Text | `--ink-primary` |
| Role | Low-emphasis actions in tight layouts, toolbars, or inline chrome |

### Critical

| Property | Value |
| --- | --- |
| Background | `--destructive` |
| Text | `--surface-page` |
| Role | Destructive or irreversible confirmation only — not for urgency or “important” |

## Choosing Primary vs Secondary

| Ask | If yes → |
| --- | --- |
| Is this the **main job** of this screen/region? | **Primary (F)** |
| Would skipping it still let the user complete the job later / elsewhere? | **Secondary (G)** (or ghost) |
| Is there already a Primary in this region? | Second control **must not** be Primary |

**Examples**

| Control | Variant | Why |
| --- | --- | --- |
| Send magic link / Sign in | Primary (F) | Advances onboarding |
| Start monitoring → | Primary (F) | Confirms scope and enters the product |
| Share brief | Primary (F) | Metastory open **mobile** — system share (silent copy fallback) |
| Copy brief | Primary (F) | Metastory open **desktop** — clipboard; do not pair with Share on the same surface |
| Resend link (while waiting on inbox) | Secondary (G) | Recovery; real next step is opening email |
| Edit scope (beside Confirm) | Secondary (G) | Optional path next to F |
| Toolbar / inline text action | Ghost | Chrome, not a commit |
| Mobile back chevron / desktop `Back to {Destination}` | Ghost | Step or parent leave — see [back affordance](back-affordance.md); not muted |
| Send / Save clean or incomplete | Secondary shell + **`--ink-muted`** label (no opacity wash) | Not ready — match onboarding empty email; do not read as clickable |
| Send / Save with required content present / dirty | Primary (F) | Form is ready to commit |
| Saving… / Sending… (in flight) | Non-actionable mute (same chrome as clean) | Busy verb + non-interactive — **no** opacity wash |
| Deleting… (in flight) | **Critical** fill (same as confirm) | Busy verb + non-interactive — **do not** demote to Secondary mute |
| Resend link (cooldown) | Non-actionable mute (same chrome as clean) | **Keep** idle label; mute for **60 seconds**, then re-enable Secondary (G) — not `Resending…` |

## States

Rest, hover, active, disabled, focus-visible (`--ring`).

Hover/active may slightly increase border contrast or background tint toward `--surface-raised`; do not switch Primary to a solid `--ink-primary` fill on hover.

### Ephemeral confirm (Copy brief)

After a successful **Copy brief** ([metastory-open](../patterns/metastory-open.md)):

| | Rule |
| --- | --- |
| Label | **`Copied`** for ~1.5–2s, then revert |
| Chrome | Remains **Primary (F)** (ink on white) — success is readable, not muted |
| Interaction | Temporarily non-interactive (`disabled` / `aria-disabled`) so the operator cannot re-fire; **not** the same visual as form-incomplete Secondary or Resend cooldown mute |
| Not | Check + label; positive-green border; success toast (fail toast only) |

**Resend cooldown** (onboarding [o02a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0) / Account Check inbox) keeps the idle label `Resend link` muted for **60 seconds** so the operator can resend again after — that is a **rate gate**, not in-flight progress and not success. Matches Supabase per-user magic-link window.

### Critical in flight (Deleting…)

After the operator commits **Delete account** ([account-menu](../patterns/account-menu.md)):

| | Rule |
| --- | --- |
| Label | **`Deleting…`** until the session clears → O1 |
| Chrome | Remains **Critical** (`--destructive` fill + page/white label) — destruction is still underway, not a clean/incomplete form |
| Interaction | Non-interactive (`aria-disabled` preferred) so they cannot re-fire |
| Not | Demote to Secondary mute (that reads as Save/Send busy or incomplete); opacity wash on Critical |

Same chrome-persists idea as **Copied** (Primary stays); opposite of Save/Send in-flight (those demote to mute because the form returns).

### Readiness (forms and modals)

| State | Variant | Notes |
| --- | --- | --- |
| **Clean / incomplete** (unchanged scope, empty required field, invalid) | **Secondary shell + muted label** | `1px` `--border-strong` / rule border + **`--ink-muted`** label on white/page fill. Same treatment as onboarding empty email ([Paper O1 · Value + Email](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0)). Findable, clearly not actionable. **Do not** use opacity wash on the control (that fades into `--surface-page`). **Do not** use ink label here — ink reads as clickable. |
| **Ready** (required content present and valid; dirty scope) | **Primary (F)** | Earned ink `1.5px` outline + **`--ink-primary`** label. |
| **In flight** (`Saving…`, `Sending…`) | **Same chrome as clean** | Secondary shell + **`--ink-muted`** label at **full opacity** (CGU / 70L). Non-interactive (`aria-disabled` preferred). State is carried by the **busy verb** — not by fading the control. Then revert to clean incomplete or ready Primary. **Do not** leave Primary chrome while the label says busy. **Do not** stack opacity wash on muted ink. |
| **Critical in flight** (`Deleting…`) | **Critical** (unchanged fill) | See [Critical in flight](#critical-in-flight-deleting) above. Specimen: [Delete account · Deleting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/TVY-0). |
| **Resend cooldown** | **Same chrome as clean** | After a successful send/resend: keep label **`Resend link`**, muted + non-interactive for **60s**, then restore Secondary (G) ink so they can resend again. Specimens: [o02a · Resend cooldown](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0) · Account [Email · Resend cooldown](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/T7X-0). Resend fail: [o02b](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/102R-0) (`Try again →`). **Do not** use `Resending…`. |

Same ladder for Account `Save →` and identity / onboarding (`Send me a link →` → `Sending…`). Destructive confirm uses **Critical** (filled `--destructive`) when ready — and **keeps** Critical through `Deleting…`.

**Onboarding · Value + Email:** empty / whitespace-only email → **clean incomplete** (mute, non-interactive). As soon as the operator **starts typing** (any non-whitespace character), the control becomes **Primary (F)** so the forward path is available; invalid format may still fail on submit with inline error — do not keep the button muted once input has begun. Specimen: [O1 · Value + Email](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0) (empty = Disabled CTA).

### Non-actionable CTA (clean + Save/Send in-flight + Resend cooldown)

One shared visual for forward CTAs that must not read as clickable — **except** Critical `Deleting…` (keeps Critical fill):

| Property | Value |
| --- | --- |
| Shell | `1px` `--border-strong` / rule · white or page fill · **`opacity: 1`** |
| Label | Inter `font-medium` `text-sm` (14px) · **`--ink-muted`** |
| Clean label | `Save →` / `Send me a link →` |
| Busy label | `Saving…` / `Sending…` |
| Cooldown label | `Resend link` (unchanged; mute only) |
| Interaction | Activate blocked; prefer `aria-disabled` + polite live status while busy / cooling down |
| Specimens | Clean: [Tags · Idle](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/CGU-0) · Busy: same chrome; label only differs ([Tags · Saving](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/R17-0)) · Cooldown: [o02a · Resend cooldown](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0) |

## Shared token usage

| Property | Value |
| --- | --- |
| Radius | `rounded-md` (or `--radius-sm` in Paper specimens) |
| Padding | `py-2 px-4` (full) · `py-1 px-3` (compact, ≥ practical click target) |
| Font | `font-sans` (Inter), `font-medium`, **`text-sm` (14px)** / **`18px` line-height** — default for all button labels (Primary, Secondary, Ghost, Critical, busy). Do not use off-scale sizes (e.g. 15px) or looser label leading (e.g. 20px). |
| Width | Prefer **content width** (`width: fit-content`); avoid full-bleed slabs that dominate a panel. Same default on desktop and narrow phone columns — meet touch targets with padding/height (`≥` practical tap size), not stretch. Full-bleed width only by **explicit exception** (e.g. sticky single-commit footer), never as the mobile default. |
| Transition | `--transition-base`; respect `prefers-reduced-motion` |

## Usage rules

1. **Verb-first labels.** Prefer `Send me a link`, `Start monitoring`, `Edit scope`. Trailing `→` is optional for forward navigation. Do not use em dashes in button labels (see [typography](../foundations/typography.md#punctuation-product-ui)).
2. **One Primary (F) per action group / region.** If two actions need Primary weight, one of them is wrong.
3. **Never use `--status-rising` for a button fill or border.** Rising is a story-status semantic, not an action color. See [color](../foundations/color.md).
4. **Never use solid `--ink-primary` fill as the everyday primary.** That treatment is retired: it overpowers calm monitoring UI and competes with ember urgency. Critical remains the only filled emphasis button in normal product chrome (destructive only).
5. **Distinguish buttons from inputs.** Inputs use `--surface-raised` fill ([input](input.md)). Primary/Secondary buttons stay white/page-filled with borders — do not reuse `--surface-raised` as the default button fill (it collapses field vs control).
6. **Critical is for destructive confirmation only** — not for urgency or “important” recommendations.
7. **One width rule across breakpoints.** Do not invent a separate “mobile = full-bleed Primary” system. Content width is the default on phone and desktop; stretch only when an exception is documented for that surface.
8. **Primary is earned by readiness.** Empty, incomplete, or unchanged → Secondary shell + muted label at full opacity (70L / CGU); ready → Primary. Do not leave a Primary on an empty form ([modal](modal.md)). Save/Send in-flight uses the **same non-actionable chrome**; only the label changes (`Saving…`). **Critical in-flight** keeps Critical fill (`Deleting…`) — do not demote. Never opacity-fade muted CTAs.
9. **One label size + leading.** Button labels are `text-sm` (**14px** / **18px** line-height) everywhere — onboarding, Account, dashboard, modals, Comms CTAs. Match [Paper O1 · Value + Email](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0); do not drift to 15px, `text-base`, or 14/20.

## Retired / do not use

| Treatment | Status |
| --- | --- |
| Solid `--ink-primary` fill as default Primary | **Retired** (v1.2.0) — was too strong for Tempo’s calm-by-default posture |
| `--surface-raised` fill as default Primary | **Rejected** — same surface as inputs; weak affordance |
| Rising / ember fill for CTAs | **Forbidden** — status ≠ action |
| Control `opacity` wash on muted / busy CTAs | **Retired** (v1.2.43) — fades into page; use muted label + busy verb instead |
