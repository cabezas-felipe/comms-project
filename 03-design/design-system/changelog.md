# Changelog

## 1.2.66 — 2026-10-03

**Button labels — lock 14 / 18 line-height**

- [button.md](components/button.md): CTA labels = Inter medium **14px / 18px** (was size-only). Paper onboarding already used 18; Comms + `Show examples` ghosts retargeted from 20 → 18. HTML handoff matched.

---

## 1.2.65 — 2026-10-03

**Onboarding — O2 ID renumber (Resend fail = o02b)**

- States board letters L→R: `o01b` · `o01c` · **`o02b · Resend fail`** · **`o02c · Link expired`** · **`o02d · Link expired · Cooldown`** (was o02d / o02b / o02c).
- Happy path ([70H](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70H-0)): unchanged — `o02` · `o02a` already logical; Resend fail stays on States only.
- PRD + [button](components/button.md) + [back-affordance](components/back-affordance.md) IDs synced.

---

## 1.2.64 — 2026-10-03

**Onboarding — o02a cooldown 60s · Resend fail specimen**

- Resend cooldown = **60s**, mute label only, starts on Check inbox land after O1a success — [button.md](components/button.md).
- New Paper state Resend fail (right of o01c): Check inbox shell · `We couldn't send the link.` · `Try again →` only. ID **o02b** as of 1.2.65 — [102R](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/102R-0).
- PRD: [onboarding--v1.md](../../../02-product/prds/onboarding--v1.md).

---

## 1.2.63 — 2026-10-03

**Comms — email message canvas (not product viewports)**

- Paper **07 - Comms** · `c01 · Magic link`: **Desktop · Message canvas 600×fit** + **Mobile · Check 390×fit** (same HTML, fluid). Subject / preheader = specimen labels above the white message — not product UI artboards (`1440×900` / `390×844`).
- Board slate `#C5D0DC` + 80 padding (aligned with 05/06). Headline ~32/40 desktop · ~28/34 mobile. Plain `{{ .ConfirmationURL }}` kept under CTA.
- Eng HTML `max-width: 600px` — [magic-link-onboarding.html](../../../06-engineering/docs/comms/magic-link-onboarding.html). See [viewports](foundations/viewports.md) email class.

---

## 1.2.62 — 2026-10-03

**Comms — magic-link email (onboarding)**

- New Paper page **07 - Comms** · board `c01 · Magic link` (slate `#C5D0DC` like 05/06). Product locks: subject `Your Tempo link`; CTA `Continue in Tempo` → `{{ .ConfirmationURL }}`; TTL copy **15 minutes**; omit Token / Email / Data in body. Frame sizes superseded by **1.2.63**.
- Eng: [D-073](../../../06-engineering/DECISIONS.md) · [magic-link-onboarding.html](../../../06-engineering/docs/comms/magic-link-onboarding.html) · [onboarding PRD](../../../02-product/prds/onboarding--v1.md).

---

## 1.2.61 — 2026-10-03

**Onboarding states — o01b / o01c order**

- Paper Onboarding · States: left-to-right **`o01b · Not invited`** ([ZYW](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZYW-0)) then **`o01c · Send fail`** ([FQ6](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FQ6-0)) — letters follow board order (pre-send deny before post-send fail).

---

## 1.2.60 — 2026-10-02

**Onboarding naming + invite-only deny specimen**

- Paper IDs (historical): `o02` · `o02a` · Link expired was then `o02b` / cooldown `o02c` — **superseded by 1.2.65** (`o02b` Resend fail · `o02c` Link expired · `o02d` Link expired · Cooldown).
- [button.md](components/button.md) · [account-menu.md](patterns/account-menu.md): Resend cooldown specimen ID **o02a** (retire O2b label).
- [back-affordance.md](components/back-affordance.md) · [ds-mapping.md](ds-mapping.md): Check email → Check inbox.
- Invite-only deny: stay on O1; support-slot error; muted `Send me a link →` until email edits — [o01b](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZYW-0).

---

## 1.2.59 — 2026-10-01

**Final-pass review — viewports, system surfaces, scope gates, badge hex lock**

- [viewports.md](foundations/viewports.md): desktop `1440×900` · mid **`1024×768`** · mobile `390` fit / keyboard `390×844`; Paper board hygiene (title + designs; gap 80 / 48); naming `o01` / `o01a` / `o01b`.
- [system-surfaces.md](patterns/system-surfaces.md): Splash (mobile-only OK) · Generic error (`Something went wrong.` + `Try again`).
- [scope-gates.md](patterns/scope-gates.md): hard `Add {missing} so Tempo can show stories.` · thin counsel with CTA-matched verb (`save` / `start`).
- [badge.md](components/badge.md): Stable / Falling hex aligned to cool-gray tokens / [color.md](foundations/color.md) (retire warm gravel hex drift).
- [source-reader.md](patterns/source-reader.md): mid artboard `1024×768`.
- [button.md](components/button.md): onboarding email — mute until typing starts, then Primary.
- [monitoring-workflow.md](patterns/monitoring-workflow.md): first-run loading · Populate error copy lock · Copy/Share fail stays one unit.
- Paper: mid frames resized; Incomplete modal recentered; Context gate lines added to match Tags.

---

## 1.2.58 — 2026-09-30

**Legal docs — Settings L1 template (Terms ≡ Privacy)**

- [account-menu.md](patterns/account-menu.md): Terms / Privacy → **in-sheet L1** (‹ · × · title in body · `Updated · {date}` · scrollable sections). One template; Privacy = title swap. Retires full-page leave for MVP.
- [modal.md](components/modal.md) · [form-intro.md](patterns/form-intro.md) · [ai-usage.md](ai-usage.md): mirrored.
- Paper: [Document · Legal](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/U3A-0) (retired full-page CH0).

---

## 1.2.57 — 2026-09-30

**Critical in-flight — `Deleting…` keeps destructive fill**

- [button.md](components/button.md): Save/Send busy stay Secondary mute; **Critical** confirm keeps Critical chrome through `Deleting…` (parallel to Copied). Do not demote Delete busy to form-incomplete mute.
- [account-menu.md](patterns/account-menu.md) · [ai-usage.md](ai-usage.md): mirrored. Paper [Deleting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/TVY-0) retargeted.

---

## 1.2.56 — 2026-09-30

**Delete support — `your scope`**

- [account-menu.md](patterns/account-menu.md) · [form-intro.md](patterns/form-intro.md): Delete support = `This removes your Tempo account and your scope. You cannot undo this.` (retire “monitoring scope” in this string).
- Paper Confirm + Deleting retargeted.

---

## 1.2.55 — 2026-09-30

**Delete account (MVP) — confirm without email gate**

- [account-menu.md](patterns/account-menu.md): Delete L1 = consequence copy + Critical `Delete account` (no field / no arrow) → busy `Deleting…` → silent O1. Immediate hard delete.
- Paper: [Confirm](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/S5A-0) · [Deleting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/TVY-0) (retired Alt C naming + email field).

---

## 1.2.54 — 2026-09-30

**Sign out (MVP) — immediate → O1, discard dirty**

- [account-menu.md](patterns/account-menu.md): Sign out = no confirm · clear session · land onboarding [O1](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0) · unsaved scope discarded silently. No dedicated specimen.

---

## 1.2.53 — 2026-09-30

**Resend = cooldown (same label), not `Resending…`**

- [button.md](components/button.md): after a successful resend, keep **`Resend link`** muted for X seconds then re-enable. Busy verbs stay `Saving…` / `Sending…` only — retire `Resending…`.
- [account-menu.md](patterns/account-menu.md): Email ladder Check inbox → **Resend cooldown** (mirror onboarding O2b). Paper [T7X](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/T7X-0) + O2d retargeted.
- [ai-usage.md](ai-usage.md) · [metastory-open.md](patterns/metastory-open.md): mirrored.

---

## 1.2.52 — 2026-09-30

**Large sheet — onboarding-aligned body air · equal Index rows · legal section**

- [large-sheet.md](patterns/large-sheet.md): body **padding-top 16** after 44 chrome (= onboarding Nav → content `gap`). Index primary rows equal (`48` / `paddingBlock 14`). Legal `Terms · Privacy` keeps middot line with **32** section gap.
- [account-menu.md](patterns/account-menu.md) · [source-reader.md](patterns/source-reader.md) · [ai-usage.md](ai-usage.md): mirrored.
- Paper Settings + reader large sheets on UX/UI retargeted.

---

## 1.2.51 — 2026-09-30

**Large sheet — fixed chrome band (body origin lock)**

- [large-sheet.md](patterns/large-sheet.md): every large sheet = **Handle + 44 chrome → body**. Left = ‹ or empty layout slot; right = ×. Overturns “no empty margin on dismiss-only.”
- [source-reader.md](patterns/source-reader.md): mobile reader outlet/meta move into **body**; chrome is empty · × only. Gutter **24**.
- [account-menu.md](patterns/account-menu.md) · [back-affordance.md](components/back-affordance.md) · [ai-usage.md](ai-usage.md): Index / L1 / reader share one chrome height.
- Paper: Settings Index · Email L1 · source reader retargeted to the band. Index first row `padding-top: 0` so list ink meets L1 form titles.

---

## 1.2.50 — 2026-09-30

**Large sheet ↔ onboarding — shared mobile form stack**

- [large-sheet.md](patterns/large-sheet.md): encode **one stack, two shells** — onboarding fullscreen vs Settings overlay share Nav **44** · gutter **24** · intro **32/38** · support **15/24** · gap **12**. Shell-only diffs: handle · × · scrim · height.
- [form-intro.md](patterns/form-intro.md) · [back-affordance.md](components/back-affordance.md): mobile/Settings L1 same type + chevron metrics; ban 28px sheet headlines and 28 hit backs.
- Paper Settings L1 sheets aligned to onboarding mobile metrics.

---

## 1.2.49 — 2026-09-30

**Large sheet chrome · ownership voice · Email L1 polish**

- New [large-sheet.md](patterns/large-sheet.md): shared phone large sheet (~720px, chrome, 30% scrim). Variant A = step-back (**‹** alone + × + form intro — Settings L1 / onboarding cousin). Variant B = dismiss-only (×, no chevron margin — source reader).
- [form-intro.md](patterns/form-intro.md): ownership voice — `your` on destinations + support; bare verb tasks (`Update email.`, `Delete account.`). Account Email support = `We'll send a one-time link to your new email to verify it's you.`
- Paper Email L1s: remove header row label beside ‹. Mirrored in [account-menu.md](patterns/account-menu.md) · [source-reader.md](patterns/source-reader.md) · [ai-usage.md](ai-usage.md) · [README](README.md).

---

## 1.2.48 — 2026-09-30

**Account · Update email — in-sheet magic-link ladder**

- [account-menu.md](patterns/account-menu.md): Settings Email L1 = onboarding spirit (Idle muted → Dirty Primary → Sending → Check inbox → Resending → Confirmed with new address). ‹ → Update form from Check inbox; × dismisses Settings. Desktop Check inbox keeps `Keep this tab open`; omit invite-only. Mirror onboarding desktop/mobile CTAs.
- [form-intro.md](patterns/form-intro.md): Account Check inbox support split desktop / mobile.
- Paper Account Email specimens retargeted ([RTK-0](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/RTK-0) … Confirmed).

---

## 1.2.47 — 2026-09-30

**Account Settings — Index grammar; legal inline**

- [account-menu.md](patterns/account-menu.md): Index label grammar locked — **nouns** for destinations (`Email`), **verbs** for session/destructive actions (`Sign out`, `Delete account`). Legal = inline **`Terms · Privacy`** (middot peer meta), not stacked rows.
- Paper [RHU-0](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/RHU-0) retargeted. Mirrored in [ai-usage.md](ai-usage.md) · [README](README.md).

---

## 1.2.46 — 2026-09-30

**Account Settings Index — Email label; legal secondary**

- [account-menu.md](patterns/account-menu.md): Index primary = **Email** · **Sign out** · **Delete account** (equal rhythm). Address lives in the Email L1 field, not on the Index. **Terms** · **Privacy** = secondary footer (`--ink-muted`, extra top gap) — not primary peers, not nested under Email. Delete stays discoverable (not under Privacy).
- Paper [RHU-0](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/RHU-0) retargeted. Mirrored in [ai-usage.md](ai-usage.md) · [ds-mapping.md](ds-mapping.md) · [README](README.md).

---

## 1.2.45 — 2026-09-30

**Account Settings — no Delete fence; large mobile sheet**

- [account-menu.md](patterns/account-menu.md): remove hairline above Delete — `--destructive` label is enough. Mobile Settings = **one large sheet** (~720px / source-reader family) for Index and in-sheet L1s — no fit-content Index that grows on drill-in. Email / Delete confirm = in-sheet L1 (not modal).
- Paper [RHU-0](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/RHU-0) retargeted. Mirrored in [ai-usage.md](ai-usage.md) · [ds-mapping.md](ds-mapping.md).

---

## 1.2.44 — 2026-09-30

**Account Settings — docked panel (retire popover)**

- [account-menu.md](patterns/account-menu.md): desktop **Settings** opens a ~400px docked chrome panel (source-reader family), not a popover. Mobile = sheet + **30%** scrim. Header = **× only** (no title echoing `Settings`). Rows = email · Terms · Privacy · Sign out · Delete — **no between-row hairlines**; quiet rule above Delete only.
- Paper: [Account · Settings open](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/RHU-0) replaces the old menu-open specimen. Mirrored in [ai-usage.md](ai-usage.md) · [layout-shell.md](components/layout-shell.md) · [README](README.md) · [ds-mapping.md](ds-mapping.md).

---

## 1.2.43 — 2026-09-30

**Button — non-actionable CTAs: no opacity wash**

- [button.md](components/button.md): clean **and** in-flight share one chrome — Secondary shell + `--ink-muted` at **full opacity** (CGU). Busy state = label only (`Saving…` / `Sending…` / `Resending…`) + non-interactive. **Retires** control `opacity: 0.55` wash (faded into page; poor readability).
- Paper **05 · UX/UI** + **06 · UI states**: all opacity-washed / “Disabled CTA” forward controls retargeted to non-actionable chrome (gated `Build my scope →` / `Start monitoring →`, Incomplete modal, Saving / Sending / Resending). Skeleton tag chips (0.45 opacity) left alone — not CTAs. Mirrored in [ai-usage.md](ai-usage.md) · [form-intro.md](patterns/form-intro.md) · [ds-mapping.md](ds-mapping.md).

---

## 1.2.42 — 2026-09-30

**Button — busy mute required; labels lock to `text-sm` (14px)**

- [button.md](components/button.md): in-flight (`Saving…` / `Sending…` / `Resending…`) = **busy mute** — Secondary shell + `--ink-muted` label + control **`opacity: 0.55`** (required, not optional). Clean/incomplete stays full-opacity muted Secondary (70L). Button labels = Inter `font-medium` **`text-sm` (14px)** only — no `text-base`, no off-scale 15px.
- [typography.md](foundations/typography.md): button labels moved from `base` (16px) role to **`sm` (14px)** to match Paper O1 / Copy brief / prototype `text-sm`.
- Paper: Account CTA labels 15→14; onboarding `Sending…` shells get busy opacity. Mirrored in [ai-usage.md](ai-usage.md) · [ds-mapping.md](ds-mapping.md).

**Your scope · Context journey (Paper)**

- Account artboard pairings 4–6: **Context Idle** (muted `Save →`, no keyboard) → **Editing** (Primary `Save →`, dirty value + focus, keyboard on mobile) → **Saving** (busy `Saving…`, no keyboard). Menu open moves after. Same readiness ladder as Tags. [form-intro.md](patterns/form-intro.md) notes the Context ladder.

---

## 1.2.41 — 2026-09-30

**Button readiness — clean = muted Secondary (70L)**

- [button.md](components/button.md): clean / incomplete forward CTAs = Secondary shell + **`--ink-muted`** label (match onboarding empty email). No opacity wash; no ink label until ready. Ready / dirty → Primary (F). In-flight → muted.
- Paper Account: Idle / Context / modal-backdrop Saves and incomplete `Send me a link →` retargeted. Mirrored in [ai-usage.md](ai-usage.md) · [modal.md](components/modal.md).

---

## 1.2.40 — 2026-09-30

**Your scope tabs — Tags | Context**

- Account scope tabs: **Tags** (pill inventory) · **Context** (role / priorities / stakeholders / sources blurbs). Replaces Tags \| Background — Background had weak scent for operational blurbs.
- Paper Account artboard retargeted. Mirrored in [account-menu.md](patterns/account-menu.md) · [form-intro.md](patterns/form-intro.md) · [ai-usage.md](ai-usage.md) · [ds-mapping.md](ds-mapping.md).

---

## 1.2.39 — 2026-09-29

**Button readiness — clean = Secondary (G), not faded**

- [button.md](components/button.md): clean / incomplete forward CTAs use **Secondary (G)** (rule border + ink label). Do not opacity-fade or mute the label into the page. Muted/disabled reserved for in-flight (`Saving…` / `Resending…`). Ready → Primary (F). Destructive confirm → **Critical** fill.
- Paper Account artboard: Idle / Background / modal-backdrop Saves retargeted; incomplete `Send me a link →` ink on Secondary; Delete confirm Critical; Terms mobile chrome `Settings`. Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.38 — 2026-09-29

**Your scope tabs — Tags | Background**

- Account scope tabs renamed: **Tags** (Topics · Keywords · Geographies · Press · Platforms pills) · **Background** (role / priorities / stakeholders / sources blurbs). Replaces Monitoring \| Context.
- Paper Account artboard updated. Mirrored in [account-menu.md](patterns/account-menu.md) · [form-intro.md](patterns/form-intro.md) · [ai-usage.md](ai-usage.md) · [ds-mapping.md](ds-mapping.md).

---

## 1.2.37 — 2026-09-29

**Account chrome copy — Settings · Your dashboard · no support**

- [account-menu.md](patterns/account-menu.md): trigger = **`Settings`** (not email). Dashboard `Account` still → Your scope. Menu/sheet first row remains the email address.
- [back-affordance.md](components/back-affordance.md): desktop in-app link = destination title (`Your dashboard`, `Your scope`) — not `Back to …`.
- [form-intro.md](patterns/form-intro.md): Account Tags / Background **omit** support copy (was Monitoring / Context).
- Paper Account artboard updated. Mirrored in [layout-shell.md](components/layout-shell.md) · [ai-usage.md](ai-usage.md) · [ds-mapping.md](ds-mapping.md).

---

## 1.2.36 — 2026-09-29

**Account identity — menu (locked); rail retired**

- New [patterns/account-menu.md](patterns/account-menu.md): desktop trailing **email** → chrome popover; mobile Account sheet. Same rows (email · Terms · Privacy · Sign out · Delete account). Scope stays one column.
- Retired Account rail pattern (persistent right admin column). Reverted Paper Account desktops; specimen [Account · Menu open](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/ANI-0).
- [layout-shell.md](components/layout-shell.md) · [ai-usage.md](ai-usage.md) · [README.md](README.md) · [ds-mapping.md](ds-mapping.md) synced. Keep `Back to your dashboard` from 1.2.35.

---

## 1.2.35 — 2026-09-29

**Account desktop — rail + back destination (locked)**

- ~~Account rail~~ **Superseded by 1.2.36** (Account menu). Back string `Back to your dashboard` retained.
- [back-affordance.md](components/back-affordance.md): destination = page title sentence case — `Back to your dashboard` (not `Back to Dashboard`).

---

## 1.2.34 — 2026-09-29

**Stale / refresh fail — Update now (locked)**

- [narrative-row.md](components/narrative-row.md): delayed and refresh-fail (with feed) share one footer — `Next update delayed` → `Updated {clock}` → `Update now` (ink medium, third line). No toast; not Populate error while stories exist. Paper: [Home · Stale freshness](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/P79-0). Explore alts retired. Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.33 — 2026-09-29

**Dashboard refresh — soft footer cue (locked)**

- [narrative-row.md](components/narrative-row.md): scheduled soft refresh keeps prior feed; footer `Updating…` (`--ink-secondary`) / `Updated {clock}` (muted); no hairline. Open story pinned until voluntary close/navigate. Silent settle; fail with feed → Stale. Paper: [Home · Refresh](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/PPD-0). Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.32 — 2026-09-29

**Stale freshness — stepped glance (locked)**

- [narrative-row.md](components/narrative-row.md): delayed pipeline = `Next update delayed` / `Updated {clock}`; first line `--ink-secondary`, clock `--ink-muted`; footer only, no CTA, no `--signal-warning` ink. Alert · Warning reserved for sustained do-not-trust + recovery. Paper: [Home · Stale freshness](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/P79-0). Mirrored in [ai-usage.md](ai-usage.md) · [monitoring-workflow.md](patterns/monitoring-workflow.md).

---

## 1.2.31 — 2026-09-28

**Scrim strengths locked — reader 30% / modal 45%**

- Same approach everywhere: translucent `--ink-primary` over the **live** shell (never solid gray).
- **30%** — source reader mid/mobile + Share brief Tempo scrim ([source-reader](patterns/source-reader.md) · [metastory-open](patterns/metastory-open.md)).
- **45%** — decision modals ([modal](components/modal.md)); Paper Incomplete · Modal updated. Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.30 — 2026-09-28

**Share brief — iOS activity view (locked)**

- [patterns/metastory-open.md](patterns/metastory-open.md): mobile Share brief opens system activity view only — no Tempo **Shared** / success toast. Preview = title + lead host. Paper: Home · Open · Copied / Share (mobile under desktop Copied). Explore alts retired.

---

## 1.2.29 — 2026-09-28

**Copy brief — ephemeral confirm**

- [patterns/metastory-open.md](patterns/metastory-open.md) · [button.md](components/button.md): desktop success = label **`Copied`**, stay **Primary (F)**, non-interactive ~1.5–2s, then revert. Do not mute like Resending / form-incomplete Secondary. Fail = quiet toast on 06. Paper: Home · Open · Copied. Explore alts retired. Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.28 — 2026-09-28

**Source reader scrim — ink ~30%**

- [patterns/source-reader.md](patterns/source-reader.md): mid overlay + mobile sheet scrim = `--ink-primary` **~30%** (no blur). Lighter than [modal](components/modal.md) 40–50% so judgment stays readable. Desktop docked unchanged (no scrim). Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.27 — 2026-09-28

**Source reader — mid-width overlay shell**

- [patterns/source-reader.md](patterns/source-reader.md): third shell = **right overlay + scrim** below `lg` (~1024); ~400px panel under top bar; feed inert; open body stays **full desktop** two-up (no stack — overlay does not push). Desktop docked · mid overlay · mobile sheet. Specimens on Paper **06 - UI states**. Mirrored in [ai-usage.md](ai-usage.md) · [metastory-open.md](patterns/metastory-open.md) · [README](README.md).

---

## 1.2.26 — 2026-09-28

**Source reader — desktop panel · mobile large sheet**

- New [patterns/source-reader.md](patterns/source-reader.md): progressive snippet before outbound; content contract; **`Open original` ↗**; chrome surface; desktop docked panel; mobile large bottom sheet. Sources cells open the reader ([metastory-open](patterns/metastory-open.md)). Mirrored in [ai-usage.md](ai-usage.md) · [layout-shell.md](components/layout-shell.md) · [README](README.md).

---

## 1.2.25 — 2026-09-28

**Next\|Actions — stacked CTA spacing**

- [patterns/metastory-open.md](patterns/metastory-open.md) · [ai-usage.md](ai-usage.md): Actions `padding-top` (~`22px`) to align Copy with Next **body** applies in **two-up only**. When Next\|Actions **stacks**, drop the offset so Next → CTA → Sources uses the same **24px** section step as mobile.

---

## 1.2.24 — 2026-09-28

**Source reader surface**

- [layout-shell.md](components/layout-shell.md) · [color.md](foundations/color.md) · [ai-usage.md](ai-usage.md): **nav/sidebar = raised · source reader = chrome** — article/post snippet panel uses `--surface-chrome` so it does not stack warm raised against an open metastory body. Drafting/notes panels stay raised.

---

## 1.2.23 — 2026-09-28

**Sources — mobile scroll cue; desktop wrap**

- [patterns/metastory-open.md](patterns/metastory-open.md): mobile Sources overflow uses **peek + trailing fade** into raised (no chevron). Desktop expanded Sources **wrap** to multiple lines — no horizontal scroll / fade. Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.22 — 2026-09-28

**Relative time — no `ago`**

- [typography.md](foundations/typography.md): product relative age is `12m` / `2h` / `3d` (floor to largest unit) — **no** `ago` in chrome. Row meta `12m · 8 sources`. Mirrored in [narrative-row.md](components/narrative-row.md) and [ai-usage.md](ai-usage.md). Aligns with Sources cells.

---

## 1.2.21 — 2026-09-28

**Metastory open — hierarchy, Actions, Sources**

- [patterns/metastory-open.md](patterns/metastory-open.md): locked B v3 layout — Why full-width (Inter 14 + hairline) → equal H\|C → equal Next\|Actions → Sources. Desktop Sources = up to 5 key + tappable `+n` (one-way cluster expand). Mobile Sources = full cluster horizontal scroll (no `+n`). Tag `+n` vs Sources `+n` called out in [narrative-row.md](components/narrative-row.md). [ai-usage.md](ai-usage.md) bullet rewritten. Retires 3-up support band, Sources\|CTA foot row, middot/`+n` truncate, and mobile ghost-chip `+n` carousel.

---

## 1.2.20 — 2026-09-28

**Metastory hairlines — matched length**

- [patterns/metastory-open.md](patterns/metastory-open.md) · [narrative-row.md](components/narrative-row.md): under-dek open hairline matches between-row separators (full feed measure). Do not inset relative to collapsed rows.

---

## 1.2.19 — 2026-09-28

**Metastory open — raised body only**

- [patterns/metastory-open.md](patterns/metastory-open.md): open fill is `--surface-raised` on the **open body only**; meta / title / dek stay `--surface-page`. Inset padding **16px** all sides (`p-4`). Mirrored in [narrative-row.md](components/narrative-row.md) and [ai-usage.md](ai-usage.md).

---

## 1.2.18 — 2026-09-28

**Dashboard filters — open Mode cue**

- [patterns/dashboard-filters.md](patterns/dashboard-filters.md): while **Filtered · editing**, Mode splits three levels — **open** (`--ink-primary` + semibold), **contributing closed** (`--ink-secondary` + medium), **empty** (muted). Idle unchanged: every contributing category stays primary/semibold. Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.17 — 2026-09-25

**Back affordance — onboarding mobile title-lock**

- [components/back-affordance.md](components/back-affordance.md): mobile onboarding keeps a **44px** Nav row on every form step. Chevron fills it when back exists (e.g. Check inbox); otherwise the row stays empty (layout-only) so titles do not jump. Clarifies empty slot ≠ disabled back.

---

## 1.2.16 — 2026-09-25

**Form intro — onboarding display + mobile stability**

- [patterns/form-intro.md](patterns/form-intro.md): documents onboarding form headline exception — Newsreader **36/44** desktop, **32/38** mobile, weight `600`, tracking **`-0.015em`** (not `2xl` 24px). Stability slot (`min-height` 48px support / 104px intro) required on **mobile** as well as desktop for paired Extracting → Review chrome.

---

## 1.2.15 — 2026-09-25

**Form intro — Extracting support**

- [patterns/form-intro.md](patterns/form-intro.md): Extracting support drops the unverified duration beat (`Usually under a minute.`). Canonical: `Pulling your topics, keywords, geographies, and sources.` Shelves + motion carry the wait until latency is measured.

---

## 1.2.14 — 2026-09-17

**Back affordance**

- New [components/back-affordance.md](components/back-affordance.md): **Mobile** = left chevron, stroke `--ink-primary`, 24×24 glyph in ≥44×44 hit (not muted). **Desktop in-app** = Ghost text `Back to {Destination}`. **Desktop onboarding** (Value / Email / Check inbox family) = no in-UI back (browser). Distinct from modal × and narrative expand chevrons (both stay muted).
- Mirrored in [modal.md](components/modal.md), [ai-usage.md](ai-usage.md), README.

---

## 1.2.13 — 2026-09-16

**Form intro — continuous support**

- New [patterns/form-intro.md](patterns/form-intro.md): page/panel task header = display headline + **one continuous** muted support string. Soft wrap only (≤2 lines at form measure); **no hard `\n`** for short intro help. Extracting support uses umbrella **sources** (matches **Your sources**); Press / Platforms appear as shelves. Examples for email, Extracting, Review, Account Monitoring, send-link / check inbox.
- Mirrored in [modal.md](components/modal.md), [ai-usage.md](ai-usage.md), README.

---

## 1.2.12 — 2026-09-14

**Metastory open — platform CTAs + mobile Sources carousel**

- [metastory-open.md](patterns/metastory-open.md): desktop **Copy brief** only; mobile **Share brief** only (silent copy fallback). Mobile foot order: CTA under What comes next → Sources. Mobile Sources = horizontal ghost-chip carousel (≥3 outlets, peek + `+n`). Same **24px** section gaps desktop/mobile.
- Mirrored in [button.md](components/button.md), [ai-usage.md](ai-usage.md), [narrative-row.md](components/narrative-row.md), [monitoring-workflow.md](patterns/monitoring-workflow.md), README.

---

## 1.2.11 — 2026-09-14

**Mobile tag cap + feed freshness placement**

- [narrative-row.md](components/narrative-row.md): mobile tag cap **1** then `+n` (desktop stays 3). Feed freshness (`Next update` / `Updated`) is always after the last narrative row — never viewport-sticky.
- Mirrored in [ai-usage.md](ai-usage.md).

---

## 1.2.10 — 2026-09-14

**Metastory open state + narrative-row chevrons**

- New [patterns/metastory-open.md](patterns/metastory-open.md): in-feed expand; Why this matters principal (no wash; label `--ink-secondary`); support band What happened · What changed · What comes next; foot Sources + **Share brief** / **Copy brief**; open-body band gaps **24px**; Sources middot list ≤3 + `+n`.
- [narrative-row.md](components/narrative-row.md): trailing chevron on **every** row (∨ collapsed / ∧ open); whole-row tap; single expand. Retires “no chevron” / text Close.
- Mirrored in [ai-usage.md](ai-usage.md), [monitoring-workflow.md](patterns/monitoring-workflow.md), README.

---

## 1.2.9 — 2026-09-13

**Dashboard filters pattern**

- New [patterns/dashboard-filters.md](patterns/dashboard-filters.md): Mode / Select / Always-on as free-floating text (not pills). States All · Filtered idle · Filtered editing. Always-on = `--ink-primary`; Select-selected = `--ink-secondary`; dismiss without Done. Scope-edit pills stay on onboarding/Account only. Mirrored in [ai-usage.md](ai-usage.md) and README.
- [badge.md](components/badge.md): categorical pills scoped to membership editing; rule #6 locks pills vs free-text tag languages.

---

## 1.2.8 — 2026-09-13

**Narrative row — mobile tag cap**

- [narrative-row.md](components/narrative-row.md): tag overflow cap is **3** on desktop, **2** on mobile (then `+n`), for breathability beside evidence meta.

---

## 1.2.7 — 2026-09-13

**Narrative rows — pills-only + hairlines + time notation**

- [narrative-row.md](components/narrative-row.md): home feed is **pills-only** (no left status rail). Soft `--border` hairlines between rows. Headlines stay `--ink-primary`; Falling may use `font-medium`. Tag / evidence / whole-row tap rules locked to dashboard.
- [typography.md](foundations/typography.md): absolute clocks use `12:51p` / `9:05a` (lowercase, no space); relative stays `12m ago`. Mirrored in [ai-usage.md](ai-usage.md).
- [monitoring-workflow.md](patterns/monitoring-workflow.md), [motion-and-feedback.md](foundations/motion-and-feedback.md), [badge.md](components/badge.md), [color.md](foundations/color.md): rails removed from feed status mapping; rails remain for alerts / optional dense cards.

---

## 1.2.6 — 2026-09-13

**Surface chrome (white top bars)**

- New semantic token `--surface-chrome` (`#FFFFFF` / `0 0% 100%`) for product top bars and modal panels.
- [layout-shell.md](components/layout-shell.md): top bar uses `--surface-chrome`, not `--surface-raised`. Raised stays for inputs, sidebars, and recessed panels.
- [color.md](foundations/color.md): three-surface rule (page · chrome · raised). [modal.md](components/modal.md) panel fill aliases `--surface-chrome`.
- Mirrored in [tokens](tokens/design-tokens.json) / [tokens.css](tokens/tokens.css), [ai-usage.md](ai-usage.md), [ds-mapping.md](ds-mapping.md). Paper: Account + Dashboard Directions already used white; B/D raised bars were a temporary misread of layout-shell.

---

## 1.2.5 — 2026-09-13

**Modal + software keyboard**

- [components/modal.md](components/modal.md): keep the panel viewport-centered when the keyboard opens; translate up only if the focused field or forward CTA would be covered (overlap + 16–24px). Do not dock to the keyboard or treat the modal as a sheet. Mirrored in [ai-usage.md](ai-usage.md). Paper: Account Update email Empty + Keyboard share the same panel position.

---

## 1.2.4 — 2026-09-12

**Modal pattern + form readiness**

- New [components/modal.md](components/modal.md): scrim mandatory over product shell; white panel + `1.5px` ink edge; × top-right of panel (not title-row sibling); title↔body tight (~8px); prefer × + Esc over redundant Cancel; full page for long legal copy.
- [components/input.md](components/input.md): comfortable padding (`py-4` / ~18px inline); never style inputs as Primary (F); rest border quiet, ink border for focus; fill stays `--surface-raised`.
- [components/button.md](components/button.md): readiness rule — empty/incomplete required fields → Secondary or disabled; ready → Primary. Applies to Account Save and identity `Send me a link →`.
- Mirrored in [ai-usage.md](ai-usage.md). First Paper application: Account Update email (empty + filled).
- Identity helper terminology: promise uses **send** a one-time link; **email** is the noun (field / inbox); **your** for ownership. Example: `We'll send a one-time link to your new email.`

---

## 1.2.3 — 2026-09-12

**Paired-state layout continuity (skeleton → populated)**

- Encoded in [foundations/motion-and-feedback.md](foundations/motion-and-feedback.md): when a loading/skeleton screen and its destination share the same chrome, lock hero and first content band vertically (top-align the stack; reserve helper height). Lower bands may reflow.
- Mirrored in [ai-usage.md](ai-usage.md). Applied first on Paper onboarding Extracting → Scope.

---

## 1.2.2 — 2026-09-11

**Product UI punctuation — no em dashes**

- Encoded in [foundations/typography.md](foundations/typography.md): product UI must not use em dashes (`—`); en dash OK for ranges; trailing `→` still optional on forward CTAs.
- Mirrored in [ai-usage.md](ai-usage.md). Updated [button.md](components/button.md) examples to `Start monitoring →` (replacing em-dash CTA specimen).

---

## 1.2.1 — 2026-09-11

**Button width — one rule across breakpoints**

- Encoded in [components/button.md](components/button.md): content width (`fit-content`) remains the default on desktop **and** narrow phone columns; meet touch targets with padding/height, not stretch. Full-bleed only by explicit exception (e.g. sticky single-commit footer). Prevents drift into a dual desktop/mobile CTA width system.
- Mirrored in [ai-usage.md](ai-usage.md) prompt constraints.

---

## 1.2.0 — 2026-09-10

**Button primary/secondary — calm outline system (F / G)**

- **Primary (F):** white/page fill + `1.5px` `--ink-primary` border + ink label. Replaces solid `--ink-primary` fill as the everyday primary so CTAs stay calm and do not compete with Rising/ember story urgency ([dp1](../principles.md)).
- **Secondary (G):** white/page fill + `1px` `--border-strong` border + ink label. Supporting / lower-commitment actions; no longer defaults to `--surface-raised` fill (that surface is reserved for [inputs](components/input.md)).
- **Selection criteria** and examples encoded in [components/button.md](components/button.md). Ghost and Critical unchanged in role.
- **Retired:** solid ink fill as default primary; Rising fill for CTAs remains forbidden.
- **Paper:** F/G specimens on onboarding redesign (`CTA system · F + G`). Prototype shadcn button styles not yet retargeted — follow DS docs over prototype until a dedicated eng pass.

**Form field label casing**

- **Form field labels** (`Email`, `Your priorities`): sentence case, `text-sm`, stable across rest / focus / filled — encoded in [components/input.md](components/input.md) and [foundations/typography.md](foundations/typography.md).
- **Section metadata** (feed / card chrome): uppercase + tracking remains; do not reuse that pattern on inputs.

---

## 1.1.0 — 2026-09-09

**Gravel & Fire color system · readability pass**

- **Color system:** Replaced **Sienna Signal** (warm parchment) with **Gravel & Fire** — cool near-white base (`#F8F8F8`), copper Rising accent (`#B85C28`), cool blue-gray Stable/Falling neutrals. Rationale: warm parchment read as "too earthy/brown"; Gravel & Fire is cooler and more minimal while preserving urgency hierarchy. See [foundations/color.md](foundations/color.md).
- **Palette prefix:** `ss-*` → `gf-*` in `design-tokens.json`. All semantic token names (`--status-rising`, `--ink-primary`, etc.) unchanged.
- **Falling status token:** `#C0B8A8` (warm pale, ~1.9:1 contrast) → `#909098` (cool blue-gray, ~3.1:1 contrast). Old value failed readability on the new cool background. Three-tier hierarchy now: Rising 4.9:1 → Stable 4.9:1 → Falling 3.1:1.
- **New token:** `--border-strong` / `--rule` (`#DEDAD8`) — sidebar border and strong-edge hairlines, distinct from main content dividers (`#E8E6E4`).
- **Section metadata labels:** codified as `--ink-muted` (`#888890`) — structural labels like "SITUATION", "WHAT CHANGED", "KEY SOURCES" are not semantic state indicators. Old design used Falling color at 9px causing near-invisible labels.
- **Surfaces:** all warm-toned backgrounds cooled. `--surface-page` `#F7F5F0` → `#F8F8F8`. `--surface-raised` (`#F0EDE8`) retains a warm tint as a deliberate counterpoint to the cool main canvas.
- **Ink:** shifted from warm browns (`#1E1C18`, `#5A5048`, `#9A9080`) to near-neutral cool-grays (`#141416`, `#505054`, `#888890`).
- **Token mapping table:** updated in [ds-mapping.md](ds-mapping.md) with new HSL/hex values and before→after for v1.0.0 → v1.1.0.
- **Prototype update:** `05-prototype/src/index.css` updated with Gravel & Fire token values. Shadcn-style variable names preserved. Dark mode not yet tuned to Gravel & Fire (retained from v0.3.0).

---

## 1.0.0 — 2026-09-09

**Sienna Signal system + Newsreader · Full design system refresh**

- **Color system:** Replaced Fraunces/ember editorial system (v0.3.0) with **Sienna Signal** — warm parchment base, single Rising sienna accent (`#B84818`), tonal Stable/Falling neutrals. See [foundations/color.md](foundations/color.md).
- **Token architecture:** Introduced **2-layer architecture** — palette (`--ss-*`) + Option-C semantic aliases (`--surface-page`, `--ink-primary`, `--status-rising`, `--status-stable`, `--status-falling`, etc). See [tokens/design-tokens.json](tokens/design-tokens.json) and [tokens/tokens.css](tokens/tokens.css).
- **Typography:** Replaced **Fraunces** with **Newsreader** as the display font. Newsreader's editorial optical sizing and on-screen legibility better serve Tempo's scan-before-read requirement. Inter retained for all UI/body. See [foundations/typography.md](foundations/typography.md).
- **Directory structure:** Moved all design system artifacts from `03-design/` flat layout to `03-design/design-system/` subfolder. `03-design/principles.md` remains at top level (experience principles, not DS artifacts). Matches PassPlate project structure.
- **New component:** Added [components/narrative-row.md](components/narrative-row.md) — the primary scanning unit for Rising / Stable / Falling story rows in the Brief feed.
- **Updated components:** All component docs reformatted to passplate-style (Tokens + Foundations header, Variants table, Usage rules). Token references updated to Option-C names.
- **ds-mapping.md:** Fully rewritten in passplate format with: v1.0.0 foundational decisions table, Option-C → shadcn bridge table, before→after table, documented exceptions, retired/never-adopted section.
- **Archived:** `ds-mapping.md` v0.3.0 → [archive/token-mapping--v0.3-flat-hex-to-shadcn.md](../archive/token-mapping--v0.3-flat-hex-to-shadcn.md). `color-preview.html` removed (superseded by color.md; recover from git history if needed).
- **Prototype update:** `05-prototype/src/index.css` updated with Sienna Signal token values. Shadcn-style variable names preserved for shadcn component compatibility. Newsreader font loaded via Google Fonts (replaces Fraunces). New status tokens (`--status-stable`, `--status-falling`, etc.) added. Dark mode not yet tuned to Sienna Signal.

---

## 0.3.0 — 2026-04-26

- DS alignment slice (`feat/lovable-ds`): `03-design` now documents the active runtime DS from `05-prototype/src/index.css + tailwind.config.ts`.
- `tokens/design-tokens.json` — replaced: old flat-hex / `comms-v0-design-system` token set replaced with HSL-triplet / shadcn-pattern tokens; added `color-dark` section.
- `tokens/tokens.css` — replaced: old `--color-*`/`--font-*` vars replaced with actual `:root {}` and `.dark {}` blocks from prototype.
- `foundations/typography.md` — Fraunces (display), Inter (sans), JetBrains Mono (mono) documented.
- `foundations/color.md` — updated semantic group table and usage rules for `--ember`, `--primary`, `--signal-*`.
- `ds-mapping.md` — old→new token mapping, retired vars, source of truth, ember-vs-accent split. (Archived at [archive/token-mapping--v0.3-flat-hex-to-shadcn.md](../archive/token-mapping--v0.3-flat-hex-to-shadcn.md).)

## 0.2.1 — 2026-04-18

- Final color decisions confirmed: accent `#4F6887`, warning `#D15400`, critical `#922B2E`, success `#68874F`, highlight `#CEBA71`.
- Rewrote `color-preview.html` as single canonical swatch artifact. (Later removed from archive; recover from git history if needed.)

## 0.2.0 — 2026-04-18

- Removed `color.secondary.*` — use `accent.soft`, borders, and `text.muted` for non-status emphasis.

## 0.1.7 — 2026-04-18

- Component sync pass: `components/*.md` aligned with current tokens.
- `CLAUDE.md` — new "Design system (prototypes)" section.

## 0.1.0 — 2026-04-18

- Created v0 design system structure under `03-design/`.
- Added foundations, machine-readable tokens, starter component specs, monitoring-first domain pattern.
