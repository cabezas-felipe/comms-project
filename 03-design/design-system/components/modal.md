# Modal

**Tokens:** [design-tokens.json](../tokens/design-tokens.json)
**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md) · [motion and feedback](../foundations/motion-and-feedback.md)
**Related:** [Button](button.md) · [Input](input.md)
**Principles:** [dp1 — Calm by default](../../principles.md)

> Working pattern (v1.2.5). First encoded from Account → Update email. Prefer this for interruptive, single-job dialogs (identity, confirm). Account **Terms / Privacy** use Settings in-sheet L1 ([account-menu](../patterns/account-menu.md)) — not modals and not a separate full-page leave for MVP.

## Purpose

A short, focused task on top of the current product shell without navigating away. The page behind must clearly recede; the dialog must not read as another region of the same page.

## Anatomy

| Region | Treatment |
| --- | --- |
| Scrim | Translucent ink over the **live** product shell (`--ink-primary` **45%**, no blur) — form/dashboard stays visible but clearly recessed. Heavier than [source reader](../patterns/source-reader.md) / Share **30%** so the decision fork is the task. **Do not** use a solid gray fill that obliterates the shell. |
| Panel | `--surface-chrome` (white `#FFFFFF`) on `--surface-page` shells; `1.5px` solid `--ink-primary` border; radius ≈ `4px` (`rounded-lg` / cards-panels-modals). Optional soft elevation shadow — restraint over drama. |
| Close (×) | Top-right of the **panel** (not on the title row). `--ink-muted`, medium weight. Accessible name: `Close`. **Not** step-back — see [back affordance](back-affordance.md). |
| Title | `font-display` (Newsreader), sentence case, period OK (`Update email.`). |
| Body | `font-sans`, `--ink-muted`, tight to the title (≈ `8px` gap) so title + body read as one idea. |
| Fields / CTAs | Follow [input](input.md) and [button](button.md). Do not style inputs like Primary buttons. |

## Layout rules

1. **× is chrome, not a title sibling.** Pin × to the panel corner. Stack title → body in their own column with a small gap so they connect.
2. **One job per modal.** If the task needs long reading or multi-step wizard chrome, use a full page instead — **except** Account legal docs, which use the Settings **in-sheet L1** template ([account-menu](../patterns/account-menu.md)).
3. **Center the panel** in the viewport (or artboard). Do not leave it optically stuck to one content column.
4. **Keyboard: static by default; lift only on collision.** Keep the panel at its rest (centered) position when the software keyboard opens, as long as the focused field and forward CTA stay fully visible above the keyboard (≈16–24px clearance). If they would be covered, translate the panel up by the overlap + that clearance — do not dock the panel flush to the keyboard or restyle it as a bottom sheet. Soft keyboards are system chrome; the modal stays a centered dialog. Full-page forms (e.g. onboarding email) may leave lower CTAs under the keyboard; that pattern does **not** apply to modals.

## Dismiss

| Allowed | Not by default |
| --- | --- |
| × | Redundant **Cancel** text when × is present |
| Esc | Overlay / scrim click (especially for identity or irreversible flows) |

- Prefer **one visible dismiss** (×) plus Esc for calm density.
- If Cancel is required (e.g. destructive confirm with two explicit text actions), Cancel is Secondary/Ghost and sits beside the Primary — do not also rely on × alone for the only safe exit without labeling.

## Content

- Title names the task; body follows [form intro](../patterns/form-intro.md): **one continuous** short support string when possible (e.g. Account `We'll send a one-time link to your new email to verify it's you.` or onboarding `We'll send a one-time link to verify it's you. No password needed.`). Soft wrap only — no hard `\n` between short beats. Verb is **send** (matches CTA `Send me a link` and confirmation `We sent a link`); **email** is the noun (field / inbox), not the verb; **your** marks ownership in support / destination titles (same register as `Your scope.` / `Check your inbox.`) — not required on every task headline (`Update email.` stays bare).
- No em dashes in product UI ([typography](../foundations/typography.md#punctuation-product-ui)).

## Usage rules

1. **Scrim is mandatory** for modals over product shell (Dashboard / Account). A thin border alone is not enough separation on `--surface-page`.
2. **Inputs stay `--surface-raised`.** Never use Primary (white + ink outline) as the default field chrome — that collapses field vs CTA ([input](input.md)).
3. **Primary CTA only when the form is ready** (required fields have valid content). Empty / incomplete → Secondary shell + muted label (70L) — not ink Secondary, not opacity-faded. In-flight → same muted chrome + busy verb ([button](button.md)).
4. **Do not use Rising / ember** for modal chrome, scrim, or CTAs.
5. **Modals are not for legal documents** — Terms / Privacy use Settings **in-sheet L1** ([account-menu](../patterns/account-menu.md)).

## States to design (minimum)

| State | Notes |
| --- | --- |
| Rest / ready | Valid input → Primary forward CTA |
| Incomplete | Empty required field → Secondary or disabled CTA |
| Keyboard (mobile) | Same rest position as Incomplete/ready when the panel clears the keyboard; collision-only translate per layout rule 4. Comps: Empty + Keyboard side by side should share panel `top` when no overlap. |
| Follow-up (e.g. check inbox) | Same panel grammar; Secondary for resend; real next step is outside the UI |

Error / send-failed may live on the States page until encoded here.
