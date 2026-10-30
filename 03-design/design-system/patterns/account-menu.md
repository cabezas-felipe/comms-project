# Account menu

**Foundations:** [color](../foundations/color.md) · [spacing and radius](../foundations/spacing-and-radius.md) · [typography](../foundations/typography.md)
**Related:** [Layout shell](../components/layout-shell.md) · [Large sheet](large-sheet.md) · [Source reader](source-reader.md) · [Back affordance](../components/back-affordance.md) · [Modal](../components/modal.md) · [Form intro](form-intro.md)
**Principles:** [dp1 — Calm by default](../../principles.md) · [pp2 — User scope is the ceiling](../../../02-product/principles.md) · [pp3 — Stay within reach, stay out of the way](../../../02-product/principles.md)

> Working pattern (v1.2.49). Desktop **Settings** docked panel ≡ mobile **Settings** **large** sheet — one content contract, two shells (same family as [source reader](source-reader.md) / [large-sheet](large-sheet.md)). `Account` remains the destination name (Dashboard → Your scope).

## Purpose

Give the solo operator a calm way to edit email, sign out, delete the account, and reach legal docs — without a settings encyclopedia, a persistent admin column, or treating Terms / Privacy as peer “work” rows.

## When

| Viewport | Treatment |
| --- | --- |
| **Desktop** (`≥ lg`) on Your scope / Terms / related Account sheets | Trailing chrome control = **`Settings`** → opens docked Settings panel |
| **Mobile** on Your scope | Trailing nav control = **`Settings`** → Settings sheet (bottom sheet + scrim) |
| **Dashboard** | Top bar **`Account`** navigates to **Your scope** (product job). Identity lives under Settings on Account surfaces |

## Naming lock

| Term | Means |
| --- | --- |
| **Account** | Destination from Dashboard — Your scope (**Tags** \| **Context**) plus identity via Settings |
| **Settings** | Trigger for the identity / session / legal tray (panel or sheet) — **chrome label only**, not repeated inside the open surface |
| **Email** | Primary Index row label — opens the email L1 workspace; the address lives **inside** that L1 field, not on the Index |

## Content contract (panel ≡ sheet)

### Primary (equal weight)

Order top → bottom. Same on desktop and mobile.

| Row | Role | Notes |
| --- | --- | --- |
| **Email** | Destination · edit | **Noun** — topic / workspace entry. Address lives in the Email L1 field. Not `Update email` on the Index (that copy is the L1 title). |
| **Sign out** | Exit session | **Verb** — immediate; no confirm. Clears session → onboarding [O1 · Value + Email](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0). Dirty scope discarded silently (MVP). |
| **Delete account** | Compliance · destructive | **Verb phrase** — immediate destructive path; keep this wording for store discoverability. Last primary row; `--destructive` label (no hairline). Tap → in-sheet L1 confirm. |

**Label grammar (intentional mix):** destinations / topics = **nouns** (`Email`, `Tags`, `Context`); session or irreversible actions = **verbs** (`Sign out`, `Delete account`). Do not force all verbs (`Update email`) or all nouns (`Account deletion`) — the mix encodes row job. Button verb-first rules apply to CTAs inside L1s, not to Index destination rows.

### Secondary (legal footer)

One inline pair below the primary block, with extra top spacing (not a hairline). Quieter type (`--ink-muted`, ~14px). **Not** stacked list rows.

| Treatment | Detail |
| --- | --- |
| Copy | `Terms · Privacy` — middot peer meta (same register as feed `{relative} · {n} sources`) |
| Layout | Side-by-side; each word tappable to the **same** legal L1 template (title swap) |
| Why | Reads as legal chrome / footer links, not Settings work rows |

**Not:** stacked Terms + Privacy as equal-height Index rows; nesting under Email; burying Delete under Privacy.

**Do not put in the panel/sheet:** Tags / Context scope editing, Save, billing, 2FA, password, data-export suites (unless legal later requires export as a separate row).

## Desktop — trigger

| Rule | Detail |
| --- | --- |
| Placement | Top bar **right** only — Ghost text, Inter 13 / 16 medium, `--ink-primary` |
| Copy | **`Settings`** |
| Left chrome | `Your dashboard` ([back affordance](../components/back-affordance.md)) — destination title, not `Back to …` |
| Not | Email as trigger; peer links for Terms / Privacy / Sign out / Delete in the top bar; a second `Account` label in the Account chrome |

## Desktop — panel (docked)

| Rule | Detail |
| --- | --- |
| Shell | **Docked right panel** below app top bar — same geometry family as [source reader](source-reader.md) (~400px; left seam `1px` `--border` / `--border-strong`) |
| Surface | `--surface-chrome` (white) |
| Scope column | Pushes left; feed/scope gutter **24px** while open (closed stays **40px**) |
| Header | Index = **× only**. L1 = **‹** alone (no row label) + **×** — form intro names the job ([large-sheet](large-sheet.md)) |
| Primary rows | Inter ~15 / 22 medium, `--ink-primary`; equal vertical rhythm (~14px padding · ~48px min) — no hairlines |
| Secondary rows | Inline `Terms · Privacy` (`--ink-muted`, ~14px); **32** section gap above — not stacked Index rows |
| Delete | `--destructive` label — primary peer, not a fenced zone |
| Dismiss | × · Esc · choosing a row that navigates |
| Not | Popover; panel title echoing `Settings`; address as Index label; Terms/Privacy at primary weight; internal hairlines |

## Mobile — Settings sheet

| Rule | Detail |
| --- | --- |
| Trigger | **`Settings`** in the scope nav row |
| Shell | **Large** bottom sheet (~85–90% / ~720px — same height family as [source reader](source-reader.md)) over `--ink-primary` **30%** scrim; `--surface-chrome`; top corners ~12px; **Handle + 44 chrome → 16 body air → content** ([large-sheet](large-sheet.md)) |
| Header | **Always 44 chrome.** Index = empty left · ×. L1 = ‹ · ×. No row labels. |
| Rows | Primary Email · Sign out · Delete — **equal** `minHeight` 48 · `paddingBlock` 14. Legal: `Terms · Privacy` one line with **32** section gap above ([large-sheet](large-sheet.md)) |
| Size | **One shell height for Index and in-sheet L1s** (email / delete). Do not fit-content the Index then grow |

## Separators (hairlines)

| Use | Where |
| --- | --- |
| **Inside Settings panel/sheet** | **None** — primary vs secondary = type weight + spacing gap, not a rule |
| **Feed / metastory / Tags sections** | Soft between-block hairlines stay ([narrative-row](../components/narrative-row.md)) |

## Update email (in-sheet L1)

Magic-link ladder in the **same** Settings shell (docked panel / large sheet). Mobile L1 body = [shared mobile form stack](large-sheet.md) with onboarding Email → Check inbox — Account copy, not onboarding branding.

| Step | State | Treatment |
| --- | --- | --- |
| Entry | Index → Email | ‹ returns to Index; × dismisses Settings |
| Idle (current) | Field = current address | Title `Update email.` · support verifies identity · CTA muted until dirty — Paper mobile left under [Email · Current](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/RTK-0) |
| Editing (dirty / keyboard) | New valid address | Same chrome · CTA Primary · mobile keyboard **overlays** the sheet (does not raise / resize the large sheet) — keyboard specimen to the right of idle mobile |
| Sending | In flight | Busy mute `Sending…` ([button](../components/button.md)) |
| Check inbox | Link sent | Title `Check your inbox.` · ‹ returns to Update form (pending address kept) · × dismisses Settings (abandons pending) |
| Check inbox · desktop | Support | `We sent a link to [email]. Open it to confirm the change. Keep this tab open.` · CTA `Resend link` + spam hint (mirrored from onboarding desktop) |
| Check inbox · mobile | Support | `We sent a link to [email]. Open it to confirm the change.` · `Open inbox →` + `Resend link` + spam hint (mirrored from onboarding mobile) |
| Resend cooldown | Post-send gate | Same label `Resend link`, muted + non-interactive for **60 seconds**, then re-enable Secondary (G) — mirror onboarding [o02a · Resend cooldown](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0). Not a busy-verb `Resending…` |
| Confirmed | Magic link succeeded | Return to Update email L1 with **new** address in field · muted CTA (clean). Not an onboarding “next step” advance |

**Omit** onboarding-only `Invite only, early access.` Keep desktop `Keep this tab open` — user may close the Tempo tab while confirming.

Paper: [Email · Current](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/RTK-0) (idle mobile + keyboard mobile) → Sending → Check inbox → [Resend cooldown](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/T7X-0) → Confirmed.

## Sign out (MVP)

| Rule | Detail |
| --- | --- |
| Trigger | Index row **Sign out** |
| Confirm | **None** — Delete owns confirmation weight |
| Behavior | Clear session → navigate to onboarding [O1 · Value + Email](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0) |
| Dirty scope | **Discard silently** — no Save / abandon prompt |
| Specimens | **None** — destination is existing O1; no signed-out interstitial or toast |
| Not | Confirm modal; “You’ve been signed out” beat; dedicated logged-out artboard |

## Delete account (lean)

| Step | Treatment |
| --- | --- |
| Entry | Last **primary** Index row: `Delete account` |
| Confirm | **In-sheet L1** (same docked panel / large sheet): `Delete account.` · continuous support · **no email / type-to-confirm field** · Critical `Delete account` ready on entry · ‹ alone + × |
| Support | `This removes your Tempo account and your scope. You cannot undo this.` |
| Deleting | **Critical** fill + `Deleting…` (non-interactive) — chrome persists like Copied; **not** Secondary mute |
| Success | Clear session → onboarding [O1](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0) — silent; no farewell artboard |
| Not | Email / type-DELETE gate; why-are-you-leaving wizard; password-only gate; soft deactivate; grace window; export-first; magic-link-to-confirm-delete; burying Delete under Privacy / Terms; chrome row label beside ‹ |

Paper: [Confirm](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/S5A-0) → [Deleting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/TVY-0).

## Legal documents (Terms · Privacy)

One **in-sheet L1** template for both — same Settings panel / large sheet as Email and Delete. Privacy = title swap only (`Privacy policy.`).

| Rule | Detail |
| --- | --- |
| Entry | Index footer `Terms` or `Privacy` |
| Chrome | **‹ alone + ×** — ‹ → Index; × dismisses Settings. No chrome row label |
| Body | Form-intro title · freshness meta · scrollable sections |
| Title | `Terms of service.` or `Privacy policy.` (Newsreader display; period OK) |
| Meta | `Updated · {date}` — same **Updated** frame as dashboard freshness ([narrative-row](../components/narrative-row.md)); calendar date, not clock. Inter muted ~13/16 |
| Sections | Numbered headings (ink medium 14/20) + muted body (14/20). Placeholder OK until counsel copy |
| Not | Full-page leave; modal; separate Privacy artboard; accept CTA; `Last updated`; chrome title beside ‹ |

Paper: [Document · Legal](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/U3A-0).

## Anti-patterns (retired)

| Avoid | Why |
| --- | --- |
| Address as Index row label | Reads as identity display, not a workspace entry; breaks equal-label rhythm with Sign out / Delete |
| Terms / Privacy as primary peers | Inflates the “work” list with read-only docs; industry pattern is legal as secondary / footer |
| Nesting legal under Email | Wrong parent — legal is product policy, not an email sub-setting |
| Burying Delete under Privacy | App Store / Play discoverability risk |
| Stacked Terms + Privacy as Index rows | Still reads as Settings line items — use inline `Terms · Privacy` footer instead |
| Forcing all Index rows to verbs or all to nouns | Destinations ≠ actions; mix encodes job |
| Hairline fences inside Settings chrome | Source-reader family uses type + spacing |

## Usage rules

1. **Scope stays the hero.** Identity is progressive disclosure under Settings.
2. **One list across platforms.** Desktop panel ≡ mobile sheet.
3. **Primary = work / session.** Email (noun) · Sign out · Delete (verbs). **Secondary = legal chrome.** `Terms · Privacy` inline.
4. **In-sheet L1** for Update email, Delete confirm, and **legal docs** — same shell height; ‹ → Index; × dismisses Settings. **Sign out** = immediate → O1 (no L1, no confirm).
5. **No em dashes** in product UI ([typography](../foundations/typography.md#punctuation-product-ui)). Middot `·` is fine for peer meta.
