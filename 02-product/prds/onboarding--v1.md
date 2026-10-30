# Onboarding — email, scope, and review

Get a solo operator from first open to a confirmed monitoring scope on **desktop web** and **iOS native**, via magic link — without passwords.

Status: Draft  
Owner: Felipe  
Update: 16 Oct 26  
Intent: ship  

Onboarding Solution walk **complete** (happy path through **o05 · Review** + States **o01b** · **o01c** · **o02b** · **o02c** · **o03g** · **o04a** · **o05a–e**; **o02d** removed). Magic-link **email** + first land locked. **d01** / dashboard → sibling dashboard PRD (not this file). Paper: [07 - Comms · c01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/p-9-0/1002-0).

UX SoT: [Paper — Onboarding · Happy path](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70H-0)  
Strategy: [Tempo strategy](../strategy/tempo.md)  
Extraction model (sibling): [model--extraction--v1.md](./model--extraction--v1.md) · contract: [Extraction](../contracts/extraction.md)  
Account (sibling): [account--v1.md](./account--v1.md) — Tags / Context after confirmed scope  
Dashboard (sibling): [dashboard--v1.md](./dashboard--v1.md) — owns [d01 · First-run loading](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0) and settled dashboard UX

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Tempo is unused until the operator can enter, prove identity lightly, and set watch scope without a heavy account setup. Scattered tabs stay the default if first-run friction is high or scope feels untrustworthy.

**Why now:** Strategy assumes operators will configure and maintain monitoring scope ([Tempo strategy](../strategy/tempo.md)); onboarding is the adoption gate before the dashboard bet can be tested.

**Hypothesis:** A passwordless email → optional scope blurbs → required review path is enough to seed scoped monitoring without form-encyclopedia friction.

**Gaps:** Evidence for completion rates and copy trust is 🟠 low-N; treat UX locks in Paper/DS as the build target, not as validated conversion research.

---

## Goals

- Operator can complete identity (magic link) and reach the next step of onboarding or the dashboard (if already scoped) on desktop web and iOS native.
- Success signal (journey): reaches confirmed scope → dashboard **or** returning-user dashboard after magic link — `TBD` formal metric table.
- Guardrails: do not invent watch scope; user confirms before scope is live (pp2). Extraction model quality is out of this PRD.

---

## Solution

### Overview

One onboarding journey for **desktop web** and **iOS native**. Same product steps; platform deltas only where chrome or system UI differs (called out per screen).

**Stages (product):** Email (magic link) → Scope → Review. Extraction **invoke + loading/fail UI** live here; extraction **model I/O / evals** live in a sibling PRD.

**First land (locked):** Same gate on **app open / URL hit** and after the magic-link callback. Session persists after the link opens. **Existing** = invited + **confirmed scope**. Desktop web and iOS native.

| Who | Session | Confirmed scope | First land |
| --- | --- | --- | --- |
| New, signed out | No | No | [o01 · Value + Email](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0) |
| Existing, signed out | No | Yes | [o01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0) — same pre-auth path; O1 CTA does **not** skip Check inbox |
| Mid-onboarding (opened link, not yet confirmed scope) | Yes | No | Resume last step: [o03 · Scope](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7ZV-0) if no successful extract yet; [o05 · Review](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70R-0) if extract succeeded (chip draft may be empty — re-show last extract). Not O1, not dashboard |
| Existing, signed in | Yes | Yes | **Dashboard family** — [d01 · First-run loading](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0) while the feed is building; otherwise settled dashboard (later specimen) |

Check inbox without opening the link = still signed out → O1 on reopen. Steady-state existing operators always have confirmed scope; mid-onboarding (Scope or Review) is the only signed-in exception.

Gate: no session → O1 · session + no confirmed scope → Scope or Review · session + confirmed scope → dashboard. Branching is **not** on O1 CTA. Confirmed scope flips on **o05 Start monitoring →**.

### Scope

**In**

- Desktop web + iOS native onboarding UX for email → scope → review
- Magic-link send / check inbox / resend / callback seams needed for that UX
- Extracting / fail UI and Review chip confirm/edit (product surface)
- Thin analytics events named per screen

**Out**

- Extraction model, prompts, gold/evals (sibling PRD; contract: [extraction.md](../contracts/extraction.md))
- Dashboard first-run loading (**d01**), settled feed, and dashboard States — sibling dashboard PRD (handoff only: Start / Try again success → d01; first land when session + confirmed scope)
- Account Tags / Context / email settings — [account--v1.md](./account--v1.md)
- Full native engineering handbook beyond onboarding product behavior (App Store, push, etc.)
- Formal email-format validation on O1 (MVP)

### User flow

Screen-by-screen. Specimens link to Paper. Onboarding screens below are locked; dashboard surfaces are out of scope here.

#### O1 — Value + Email

Specimen: [o01 · Value + Email](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0)

**Job:** Present Tempo’s value and collect an email so we can send a one-time magic link. No password.

**Layout**

| Platform | Layout |
| --- | --- |
| Desktop web | Split: value panel (left) + email form (right) |
| iOS native | Value panel first; email form in a lower panel |

**Copy / chrome (product)**

- Form title: `Start monitoring.`
- Support: `We'll send a one-time link to verify it’s you. No password needed.`
- Field: `Email`
- CTA idle → ready: `Send me a link →`
- Secondary note: `Invite only, early access.` (still true for this PRD)

**Data (Supabase):** [Database library · `users`](https://dbdiagram.io/d/6ab4852e58694256127b2a37) ([tempo.dbml](../../06-engineering/docs/data/tempo.dbml)). Ops **seeds invited emails** as rows in `users` (`email` stored lowercase). Allowlist = email present in `users`. The Email **field is not** prefilled — only the table is pre-seeded. No scope/settings writes on this screen.

**CTA check (send time):** Look up normalized email in `users`.

| Result | Meaning | UX |
| --- | --- | --- |
| Row exists | Invited | Continue magic-link path (Sending → Check inbox). New vs returning does **not** change this pre-auth path. |
| No row | Not invited | [o01b · Not invited](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZYW-0) — stay on O1 family; do **not** enter Sending |

**Invite-only deny (locked):** Specimen [o01b · Not invited](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZYW-0) (desktop + iOS). O1 family **state**, not a separate route.

**Trigger:** Enabled **Send me a link →** (or Return/Go when that submits) with normalized email **not** in `users` — desktop or mobile (including from the [7FD](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7FD-0) keyboard layout). Never enter Sending. 7FD itself is keyboard chrome, not the deny trigger.

| Element | Spec |
| --- | --- |
| Support (error) | `Tempo is invite only. This email isn’t on the list.` (destructive; replaces happy-path support) |
| Field | Filled email kept unchanged; normal chrome (no destructive border) |
| CTA while denied address unchanged | Muted / disabled `Send me a link →` (clean incomplete) |
| Recovery | As soon as the operator **starts editing** the email string, clear the error, restore happy-path support, and enable Primary CTA when the field still has ≥1 non-whitespace character |
| Under-CTA note | Hide `Invite only, early access.` in the deny state |
| In-flight | Allowlist check stays on O1 (optional CTA pending); never route through Sending |

**Metrics (PostHog)**

| Event | When | Properties |
| --- | --- | --- |
| O1 visit | Screen viewed | platform (`web` \| `ios`); **not** account status (unknown while signed out before email) |
| O1 CTA click (invited) | Enabled CTA → allowlist pass | `account_status`: `new` \| `returning`; platform |
| O1 CTA denied | Enabled CTA → not in `users` → o01b | `reason: not_invited`; platform |

**Do not track** o01b **visits** — the denied event is enough. Invited success funnel = O1→O2.

`account_status` at invited CTA only (analytics — **no pre-auth UX branch**): `returning` = `users` row **and** confirmed scope already exists; `new` = invited (`users` row) without confirmed scope. Scope signal uses lane/membership data, not `users` alone. Lookup failure for status → omit or `unknown`; do not block an invited send for analytics failure.

**CTA readiness (happy path)**

| Email field | CTA |
| --- | --- |
| Empty or whitespace-only | Disabled (clean incomplete — muted, non-interactive) |
| ≥1 non-whitespace character | Enabled (Primary) |

**Invalid email (MVP):** No format gate. If the address is invited (or would be treated as sendable), proceed into the magic-link path even when the string is not a well-formed email. Not-invited still hits o01b. Delivery failure on garbage strings is acceptable MVP risk.

**Navigation (CTA, enabled)**

| Allowlist result | Destination |
| --- | --- |
| Invited (new or returning) | [o01a · Sending](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FHG-0), then Check inbox |
| Not invited | Stay on O1 → [o01b · Not invited](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZYW-0) |

**Not** from this CTA: [d01 · First-run loading](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0). d01 is dashboard **loading** (signed-in + confirmed scope), not an O1 destination. First land — Overview.

**iOS native only**

1. Chevron on the value panel moves the operator to the email panel.
2. Focusing the email field presents the system keyboard ([7FD](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7FD-0)). Tap outside / blur dismisses. **Return/Go** may dismiss (single-line; optional submit if CTA ready). Contrast: Scope blurbs use Return as newline — see o03a.

**Desktop web only**

- No value-panel chevron (side-by-side).
- No in-UI back (browser history) — per [back affordance](../../03-design/design-system/components/back-affordance.md).

#### O1a — Sending (O1 state)

Specimen: [o01a · Sending](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FHG-0)

**Job:** In-flight feedback while Tempo requests the magic link for an **invited** email. Not a separate route — same O1 shell, busy CTA.

**Data (Supabase):** none (product tables). Auth call only: send one-time link (OTP) for the submitted email. Allowlist already passed on O1.

**Metrics (PostHog)** — magic-link send diagnostics (no O1a / o01c **visit** events):

| Event | When | Properties |
| --- | --- | --- |
| Magic link send succeeded | OTP accepted → Check inbox (or o02a on resend / expired resend) | platform; `trigger`: `initial` \| `retry` \| `resend` \| `expired_resend`; `account_status` if known |
| Magic link send failed | OTP/provider fail → o01c (or o02b on resend / from o02c); unexpected → s02 | platform; `trigger`: `initial` \| `retry` \| `resend` \| `expired_resend`; `failure_kind`: `otp` \| `general` |

Default names if unresolved: `onboarding_magic_link_send_succeeded` / `onboarding_magic_link_send_failed`. `retry` = Try again from o01c; `resend` = Resend / Try again from O2 / o02b; `expired_resend` = Resend from o02c.

**UX (locked)**

| Element | Spec |
| --- | --- |
| Shell | Same as O1 (value + email form); desktop split / iOS email panel |
| Title / support | Unchanged happy-path copy |
| Email field | Keeps submitted value; **not editable** while Sending |
| CTA | Busy mute `Sending…` (non-interactive) — [button readiness](../../03-design/design-system/components/button.md) |
| Under-CTA note | `Invite only, early access.` remains |
| iOS keyboard | Dismissed / not shown in this state |

**Navigation**

| Outcome | Destination |
| --- | --- |
| Send succeeds | [o02 · Check inbox](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70J-0) |
| OTP / send-provider failure | [o01c · Send fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FQ6-0) (O1 family state) |
| General / unexpected failure | [s02 · Generic error](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZTV-0) |

##### O1c — Send fail (O1 state)

Specimen: [o01c · Send fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FQ6-0)

**Job:** Recover when an invited magic-link **send** fails (OTP/provider). O1 family state — not a separate route. No o01c visit metric (use send-failed with `trigger`).

| Element | Spec |
| --- | --- |
| Support (error) | `We couldn't send the link.` (destructive; replaces happy-path support) |
| Field | Email kept; **editable**. Start editing → clear error, restore happy-path support, Primary when ≥1 non-whitespace (same spirit as o01b) |
| CTA | Primary `Try again →` |
| Under-CTA note | Hide `Invite only, early access.` (match o01b) |

**Try again →** enter [o01a · Sending](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FHG-0) with the **current** field value; **re-check** allowlist; send event `trigger: retry`.

| Outcome | Destination |
| --- | --- |
| Not in `users` | [o01b · Not invited](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZYW-0) |
| Send fails (OTP/provider) | Stay on / return to o01c |
| Send succeeds | [o02 · Check inbox](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70J-0) |
| Unexpected failure | [s02](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZTV-0) |

##### s02 — Generic error (from Sending)

Specimen: [s02 · Generic error](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZTV-0)

| Element | Spec |
| --- | --- |
| Title | `Something went wrong.` |
| CTA | `Try again` |
| Try again (default) | Return to O1 ready state with the email preserved and Primary enabled if non-empty |

**Out of this screen:** Link expired ([o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0)) — that is post–Check inbox / open-link, not a Sending failure.

#### O2 — Check inbox

Specimen: [o02 · Check inbox](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70J-0)

**Job:** Confirm a magic link was sent and tell the operator what to do next (open email). Hold them here until they open the link (or resend / go back).

**Data (Supabase):** none (product tables). Display email from O1 submit state. Auth: initial send already succeeded (entered from O1a); **Resend link** triggers another magic-link send for the same address.

**Metrics (PostHog)**

| Event / insight | When | Properties / definition |
| --- | --- | --- |
| O2 visit | Check inbox viewed | platform; `account_status` **carried from O1 CTA** (not re-derived from a cold visit) |
| Conversion O1 → O2 | Funnel | **Denominator = invited O1 CTA clicks** (allowlist pass). **Numerator = O2 views** after that path. Product behavior — not raw O1 visits (visits = demand signal elsewhere). |
| Magic link send succeeded / failed | On **O1a** (and on Resend from O2) | Already specified under O1a; reaching O2 implies initial send succeeded. Resend uses the same success/fail events with `trigger: resend` (default if unresolved). |

Do **not** double-count initial send success as a separate O2 event.

**Copy / chrome**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Check your inbox.` | Same |
| Support | `We sent a link to [email]. Open it to continue. Keep this tab open.` | `We sent a link to [email]. Open it to continue.` (**omit** Keep this tab open) |
| Primary forward | — (open email outside Tempo) | `Open inbox →` |
| Resend | `Resend link` (Secondary) | Same, below Open inbox |
| Hint | `Check spam if it's not there.` | Same |

**UX**

1. **Resend link** — requests another magic link for the same email. Success → [o02a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0). Fail → [o02b](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/102R-0). Success/fail diagnostics as under O1a (`trigger: resend`).
2. **Desktop only:** support includes `Keep this tab open.`
3. **iOS native only — back chevron:** returns to O1 email panel with the address preserved — layout of [7FD · Mobile · Keyboard](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7FD-0) **without** the keyboard (field not focused / keyboard dismissed). Ready Primary if email still has ≥1 non-whitespace character.
4. **iOS native only — Open inbox →:** opens the device default mail / inbox app (system handoff). Remains on O2 and o02a; **omit** on o02b.
5. **Desktop:** no in-UI back (browser) — [back affordance](../../03-design/design-system/components/back-affordance.md).
6. **Post-auth (after link opens):** same first-land gate as Overview — no confirmed scope → Scope; confirmed scope → dashboard family. Expired or used-once link → [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0).

#### O2a — Resend cooldown (O2 state)

Specimen: [o02a · Resend cooldown](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0)

**Job:** After a successful magic-link send (initial O1a or Resend), gate **Resend link** so the operator cannot re-fire faster than Supabase allows.

**Data (Supabase):** none (product tables). Auth already accepted the send that started the timer.

**Metrics (PostHog):** none new — o02a is an O2 state, not a visit. Send success already recorded on O1a / Resend.

**Cooldown:** **60 seconds** (matches Supabase default per-user OTP / magic-link window). Flat — no progressive ladder (MVP).

**When it starts:** On landing Check inbox after **O1a success**, Resend is already muted for 60s from that initial send. After each successful Resend, restart 60s.

**UX (locked)**

| Element | Spec |
| --- | --- |
| Shell | Same as O2 (Check inbox) |
| Title / support | Unchanged happy-path copy (desktop keeps `Keep this tab open.`) |
| Resend link | Label stays `Resend link`; muted + non-interactive for 60s — **not** `Resending…` ([button](../../03-design/design-system/components/button.md)) |
| Countdown in label | **No** — mute only |
| Spam hint | Remains (desktop beside / iOS below) |
| iOS Open inbox → | Remains Primary (forward path unchanged) |
| After 60s | Resend re-enables as Secondary (G) |

**Navigation:** Stay on Check inbox. Resend success → restart o02a. Resend fail → [o02b](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/102R-0). iOS back / desktop browser — same as O2.

#### O2b — Resend fail (O2 state)

Specimen: [o02b · Resend fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/102R-0) (Onboarding · States, right of [o01c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FQ6-0))

**Job:** Recover when **Resend link** fails from Check inbox — stay in the O2 family; do not bounce to O1 / o01c.

**Data (Supabase):** none (product tables). Auth resend/OTP call failed.

**Metrics (PostHog) — B-lite**

| Event | When | Properties |
| --- | --- | --- |
| Magic link send succeeded | Try again → OTP accepted → leave for o02a | platform; `trigger: resend` |
| Magic link send failed | Try again → OTP/provider fail (stay o02b); unexpected → s02 | platform; `trigger: resend`; `failure_kind`: `otp` \| `general` |

**Do not track** o02b visits or conversion into this fail surface. First Resend fail from o02 / o02a already emits send-failed under [O1a](#o1a--sending-o1-state) / O2 (`trigger: resend`); Try again reuses the same action events so retry recovery is visible without a fail-screen funnel.

**Entry**

| From | When |
| --- | --- |
| [o02](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70J-0) | Resend link → send fails |
| [o02a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0) | Resend link (after cooldown) → send fails |
| [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0) | Resend link from expired → send fails |

Lands with Primary `Try again →` enabled.

**UX (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Check your inbox.` | Same |
| Support | `We couldn't send the link.` (destructive; replaces happy support including `Keep this tab open.`) | Same |
| Primary CTA | `Try again →` | Same |
| Open inbox / Resend / spam hint | **Omit** | **Omit** |
| Back | Browser | Chevron → [o01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0) email panel — [7FD](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7FD-0) sans keyboard; email preserved (same as O2) |

**Deliberate omission:** no Open inbox on fail — single recovery job is retry send. Prior link may still work in the real inbox; that CTA returns on happy Check inbox after success.

**Try again →** stay on o02b; CTA **busy mute** (no optimistic jump to o02a; no Sending chrome).

| Outcome | Destination |
| --- | --- |
| Send succeeds | [o02a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0) (60s muted Resend) |
| OTP / send-provider failure | Stay on o02b (`Try again →` re-enabled) |
| Unexpected failure | [s02 · Generic error](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZTV-0) |

#### O2c — Link expired (O2 family)

Specimen: [o02c · Link expired](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0)

**Job:** Recover when the operator opens a magic link that is **past TTL** (15m) or **already used**. Resend a fresh link; do not invent a session.

**Data (Supabase):** none (product tables). Auth callback / verify failed; display email from link/callback context when known.

**Metrics (PostHog) — B-lite**

| Event | When | Properties |
| --- | --- | --- |
| Resend link click | Primary CTA on o02c | platform; `trigger: expired_resend` |
| Magic link send succeeded | Resend → OTP accepted → leave for o02a | platform; `trigger: expired_resend` |
| Magic link send failed | Resend → OTP/provider fail → o02b; unexpected → s02 | platform; `trigger: expired_resend`; `failure_kind`: `otp` \| `general` |

**Do not track** o02c visits or conversion into this fail surface.

**Entry:** Magic-link open fails because expired (**otp_expiry** / 15m) **or** one-time link already consumed → same o02c. Email unknown → [o01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70L-0).

**UX (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Shell | O1 value + form panel; **no** email field | Email panel only |
| Title | `This link expired.` | Same |
| Support | `Resend a link to [email].` (email from context; **not** editable) | Same |
| Primary CTA | `Resend link` (no `→`) | Same |
| Open inbox / invite note / spam hint | **Omit** | **Omit** |
| Back | Browser | **No** chevron (Paper Nav empty) |

**Resend link →** stay on o02c; CTA **busy mute** (no optimistic Check inbox; no Sending chrome).

| Outcome | Destination |
| --- | --- |
| Send succeeds | [o02a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/FUX-0) — Check inbox + 60s muted Resend (tells them to open the **new** link) |
| OTP / send-provider failure | [o02b](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/102R-0) (send-fail copy; not expired title) |
| Unexpected failure | [s02](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZTV-0) |
| Operator opens the **new** link | First-land gate (often [o03](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7ZV-0) if new ∩ no confirmed scope) |

**o02d removed:** no product entry once success returns to Check inbox (o02a) and fail uses o02b. Paper frame deleted.

##### Magic-link email (locked)

**Channel:** Supabase Auth **Magic Link** template ([email templates](https://supabase.com/docs/guides/auth/auth-email-templates)). Hosted: Dashboard → Authentication → Email Templates → Magic Link. Local: `auth.email.template.magic_link` + HTML path.

**TTL (build):** **15 minutes** (`900` seconds) — set **Email OTP expiration** (also governs magic links). Not Supabase’s 1h default. Eng: [DECISIONS.md](../../06-engineering/DECISIONS.md) · HTML handoff: [magic-link-onboarding.html](../../06-engineering/docs/comms/magic-link-onboarding.html).

**Paper:** [07 - Comms · c01 · Magic link](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/p-9-0/1002-0) — Desktop · Message canvas **600×fit** · Mobile · Check **390×fit** (same HTML; not product UI viewports). Subject / preheader = specimen labels above the message.

**Supabase body variables**

| Variable | Lock |
| --- | --- |
| `{{ .ConfirmationURL }}` | CTA href + plain-URL fallback |
| `{{ .Token }}` | Omit |
| `{{ .TokenHash }}` | Omit |
| `{{ .SiteURL }}` | Omit from body |
| `{{ .RedirectTo }}` | Do not surface (set in `signInWithOtp` / allowlist only) |
| `{{ .Email }}` | Omit (revisit for Account change-email template) |
| `{{ .Data }}` | Omit |

**Copy (locked)**

| Element | Copy |
| --- | --- |
| Subject | `Your Tempo link` |
| Preheader | `One-time link. Expires in 15 minutes.` |
| Brand | `Tempo` |
| Headline | `Continue in Tempo.` |
| Support | `Open the link to verify it's you. No password needed.` |
| CTA | `Continue in Tempo` (no trailing `→`) |
| Link meta | `This link works once and expires in 15 minutes.` |
| Plain URL | Same as CTA → `{{ .ConfirmationURL }}` |
| Unsolicited | `If you didn't ask for this, you can ignore this email.` |

**Must not:** password setup; invent scope; imply Tempo acts on the user’s behalf; marketing / invite-only chrome (invite-only stays on O1 UI).

**Out of email v1:** Account change-email template (separate; may show `{{ .Email }}` / `{{ .NewEmail }}`).

#### O3 — Scope · Empty

Specimen: [o03 · Scope · Empty](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7ZV-0)

**Job:** First post-auth Scope screen for **new** operators (no confirmed scope). Orient them to set watch scope via five blurbs; do not advance until later filled/ready states.

**Who can visit:** Only **new** users (session exists; no confirmed scope). Returning / scoped users never land here — post-auth → dashboard / first-run.

**Data (Supabase) — Scope family**

Empty idle (this screen): no product writes. Session already established via magic link.

Blurb map (all optional v1; [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) / [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)):

| Field label | Table · column |
| --- | --- |
| Your role and organization | `user_role_organization.blurb` |
| Your priorities | `user_priorities.blurb` |
| Your organization’s priorities | `user_organization_priorities.blurb` |
| Your stakeholders | `user_stakeholders.blurb` |
| Your sources | `user_sources.blurb` |

| Concern | Spec |
| --- | --- |
| While drafting | **Client-held draft** in the form: each field keeps the operator’s typed text as they move between fields / o03* focus states (and on resume mid-onboarding). No product DB write on focus, blur, or field change. |
| DB commit | **Once**, on forward leave: (1) all five filled → **Build my scope →** writes all blurbs then invokes extraction; or (2) not all filled → Incomplete modal ([G0Y](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0)) → **Build anyway** writes whatever exists (skipped → NULL) then invokes extraction. |
| Extraction | Structured extracts / memberships — [model--extraction--v1.md](./model--extraction--v1.md) / [Extraction contract](../contracts/extraction.md); not Scope chrome. |
| Examples | **On focus only:** Example block under the focused field. **No** `Show examples` control. Tempo **never prefills** Example sentences into fields. Paper filled copy on o03a–f is **illustration** of user-typed drafts — in product those strings are whatever the operator entered and they **stay** when another field is focused. |

**Metrics (PostHog)**

| Event / insight | When | Properties / definition |
| --- | --- | --- |
| O3 visit | Scope · Empty viewed | platform; only fires for **new** (no confirmed scope) |
| Conversion O2 → O3 | Funnel | **Denominator = new users who viewed O2** ([o02](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70J-0)). **Numerator = O3 views.** Excludes returners who leave Check inbox for dashboard. |

Default names if unresolved: `onboarding_o03_viewed`; conversion as insight (not a third event).

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Set your scope.` | Same |
| Support | `Tempo uses this to choose which stories to show you, and why they matter. You can edit it anytime.` ([form-intro](../../03-design/design-system/patterns/form-intro.md)) | Same |
| Fields (empty labels) | `Your role and organization` · `Your priorities` · `Your organization’s priorities` · `Your stakeholders` · `Your sources` | Same |
| CTA | `Build my scope →` — clean incomplete mute (non-interactive) | Same |
| Show examples / Example… | **Omit** on empty — Example block only after field focus (o03a–e). No `Show examples` control | Same |
| Back / leave | No in-UI leave (browser only) | Empty 44px Nav row (no chevron) — [back affordance](../../03-design/design-system/components/back-affordance.md) title-lock |

**UX (locked)**

1. **Idle empty only** this walk — field focus, fill, examples, and CTA ready states are later o03a–f (and Incomplete modal) screens. Product empty = labels only; Paper filled states later are illustration.
2. **CTA** stays muted on empty; never enables with zero field content ([button](../../03-design/design-system/components/button.md)).
3. **Layout:** desktop = value panel + form; iOS = form column (same onboarding family as O1/O2).

**Navigation:** Stay on Scope until a later state enables forward commit. No in-UI back from empty.

**Out of this screen:** [o02c · Link expired](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0) (identity path); [o03a · Role](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/80O-0) and later field states; Extracting / Review.

#### O3a — Scope · Role

Specimen: [o03a · Scope · Role](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/80O-0) — desktop + [Mobile · Focused empty](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/92Y-0) + [Mobile · Keyboard](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/98A-0)

**Job:** First Scope field focus — Role and organization — with Example guidance while the operator drafts blurb 1. Same Scope form as o03; this is a field state, not a new route.

**Who can visit:** Same as o03 — **new** users only (session; no confirmed scope).

**Data (Supabase):** Field → `user_role_organization.blurb`. Draft / commit / extraction — **Scope family** under o03.

**Metrics (PostHog):** none new. Family visit / O2→O3 conversion stay on **o03**. Field-focus funnels out of this walk.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title / support | Same as o03 | Same |
| Focused field | `Your role and organization` — strong focus border; label remains | Same |
| Example (on focus) | Label `Example` · body `Head of Communications, Embassy of Colombia in the United States.` — show on **all** o03a specimens (desktop + both mobile) | Same |
| Show examples control | **Omit** — Example block is the only examples UI | Same |
| Other fields | Idle empty labels (priorities / org priorities / stakeholders / sources). Keyboard companion may show typed Role as **illustration** — family rule under o03 | Same |
| CTA | `Build my scope →` | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) |

**UX (locked)**

1. **Focus Role** → Example block appears under the field; strong border on the focused blurb.
2. **CTA readiness:** Primary / interactive iff **any** of the five draft fields has ≥1 non-whitespace character; otherwise clean incomplete mute ([button](../../03-design/design-system/components/button.md)). Focused-empty with zero draft content → muted ([92Y](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/92Y-0)). Role has draft text → Primary even when the keyboard hides the CTA ([98A](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/98A-0)).
3. **iOS keyboard:** Focusing a Scope blurb presents the system keyboard (Paper keyboard companion).
4. **Keyboard dismiss:** Tap outside / blur dismisses on Scope fields **and** on O1 email ([7FD](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/7FD-0)). **Return** on Scope blurbs = **newline** (multi-line); does **not** dismiss. **Return/Go** on O1 email (single-line) may dismiss (and may submit if CTA ready).
5. **Draft persistence:** Moving to another field keeps Role (and other) draft text in client state until Build / Build anyway commit (family rule under o03).
6. **Layout:** desktop = value panel + form; iOS = form column (same family as o03).

**Navigation:** Stay on Scope. Forward commit — family rule under o03; Incomplete modal chrome still walked later. No in-UI back.

**Out of this screen:** [o03b · Priorities](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/82E-0) · other o03* · [Incomplete modal](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) · Extracting · Review · [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0).

#### O3b — Scope · Priorities

Specimen: [o03b · Scope · Priorities](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/82E-0) — desktop + mobile focused + mobile keyboard companions in the same frame.

**Job:** Priorities field focus — Example guidance while drafting blurb 2. Same Scope form as o03; field state, not a new route.

**Who can visit:** Same as o03 — **new** users only.

**Data (Supabase):** Field → `user_priorities.blurb`. Draft / commit / extraction — **Scope family** under o03.

**Metrics (PostHog):** none new. Family visit / O2→O3 conversion stay on **o03**.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title / support | Same as o03 | Same |
| Focused field | `Your priorities` — strong focus border; label remains | Same |
| Example (on focus) | Label `Example` · body `Migration, visas, and border policy. Asylum claims and remittance politics across Colombia and the US.` — on all o03b specimens | Same |
| Show examples control | **Omit** — Example block on focus is the only examples UI | Same |
| Other fields | Role may show filled draft (Paper illustration); remaining idle empty — operators may focus Priorities with Role still empty | Same |
| CTA | `Build my scope →` — Primary when any field has ≥1 non-whitespace (specimen: Role filled → Primary) | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) |

**UX (locked)**

1. **Focus Priorities** → Example under the field; strong border on the focused blurb.
2. **CTA readiness:** Same family rule as o03a — any field ≥1 non-whitespace → Primary; else mute ([button](../../03-design/design-system/components/button.md)). Keyboard may hide CTA; readiness still applies.
3. **iOS keyboard:** Tap Priorities → system keyboard.
4. **Keyboard dismiss / Return:** Family rules from o03a — tap outside / blur dismisses; **Return** = newline (not dismiss).
5. **Draft persistence / commit:** Family rules under o03.
6. **Layout:** Same Scope family as o03 / o03a.

**Navigation:** Stay on Scope. No in-UI back.

**Out of this screen:** [o03c · Org](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/844-0) · later o03* · [Incomplete modal](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) · Extracting · Review · [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0).

#### O3c — Scope · Org

Specimen: [o03c · Scope · Org](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/844-0) — desktop + mobile focused + mobile keyboard companions in the same frame.

**Job:** Organization’s priorities field focus — Example guidance while drafting blurb 3. Same Scope form as o03; field state, not a new route.

**Who can visit:** Same as o03 — **new** users only.

**Data (Supabase):** Field → `user_organization_priorities.blurb`. Draft / commit / extraction — **Scope family** under o03.

**Metrics (PostHog):** none new. Family visit / O2→O3 conversion stay on **o03**.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title / support | Same as o03 | Same |
| Focused field | `Your organization’s priorities` — strong focus border; label remains | Same |
| Example (on focus) | Label `Example` · body `Keep the Colombia–US relationship credible in US coverage. Hold a consistent embassy line when migration or security stories accelerate.` — on all o03c specimens | Same |
| Show examples control | **Omit** — Example block on focus is the only examples UI | Same |
| Other fields | Role + Priorities may show filled draft (Paper illustration); Stakeholders / Sources idle empty — fields independently focusable | Same |
| CTA | `Build my scope →` — Primary when any field has ≥1 non-whitespace (specimen: upstream filled → Primary) | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) |

**UX (locked)**

1. **Focus Org priorities** → Example under the field; strong border on the focused blurb.
2. **CTA readiness:** Family rule — any field ≥1 non-whitespace → Primary; else mute ([button](../../03-design/design-system/components/button.md)). Keyboard may hide CTA; readiness still applies.
3. **iOS keyboard:** Tap Org priorities → system keyboard.
4. **Keyboard dismiss / Return:** Family rules — tap outside / blur dismisses; **Return** = newline (not dismiss).
5. **Draft persistence / commit:** Family rules under o03.
6. **Layout:** Same Scope family as o03 / o03a / o03b.

**Navigation:** Stay on Scope. No in-UI back.

**Out of this screen:** [o03d · Stakeholders](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/85U-0) · later o03* · [Incomplete modal](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) · Extracting · Review · [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0).

#### O3d — Scope · Stakeholders

Specimen: [o03d · Scope · Stakeholders](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/85U-0) — desktop + mobile focused + mobile keyboard companions in the same frame.

**Job:** Stakeholders field focus — Example guidance while drafting blurb 4. Same Scope form as o03; field state, not a new route.

**Who can visit:** Same as o03 — **new** users only.

**Data (Supabase):** Field → `user_stakeholders.blurb`. Draft / commit / extraction — **Scope family** under o03.

**Metrics (PostHog):** none new. Family visit / O2→O3 conversion stay on **o03**.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title / support | Same as o03 | Same |
| Focused field | `Your stakeholders` — strong focus border; label remains | Same |
| Example (on focus) | Label `Example` · body `Ambassador and front office; foreign ministry press desk; diaspora media; Hill staff who cover Colombia.` — on all o03d specimens | Same |
| Show examples control | **Omit** — Example block on focus is the only examples UI | Same |
| Other fields | Role / Priorities / Org may show filled draft (Paper illustration); Sources idle empty — fields independently focusable | Same |
| CTA | `Build my scope →` — Primary when any field has ≥1 non-whitespace (specimen: upstream filled → Primary) | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) |

**UX (locked)**

1. **Focus Stakeholders** → Example under the field; strong border on the focused blurb.
2. **CTA readiness:** Family rule — any field ≥1 non-whitespace → Primary; else mute ([button](../../03-design/design-system/components/button.md)). Keyboard may hide CTA; readiness still applies.
3. **iOS keyboard:** Tap Stakeholders → system keyboard.
4. **Keyboard dismiss / Return:** Family rules — tap outside / blur dismisses; **Return** = newline (not dismiss).
5. **Draft persistence / commit:** Family rules under o03.
6. **Layout:** Same Scope family as o03 / o03a–c.

**Navigation:** Stay on Scope. No in-UI back.

**Out of this screen:** [o03e · Sources](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/87K-0) · Ready / Incomplete · Extracting · Review · [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0).

#### O3e — Scope · Sources

Specimen: [o03e · Scope · Sources](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/87K-0) — desktop + mobile focused + mobile keyboard companions in the same frame.

**Job:** Sources field focus — Example guidance while drafting blurb 5. Same Scope form as o03; field state, not a new route. Last of the five field-focus states.

**Who can visit:** Same as o03 — **new** users only.

**Data (Supabase):** Field → `user_sources.blurb`. Draft / commit / extraction — **Scope family** under o03.

**Metrics (PostHog):** none new. Family visit / O2→O3 conversion stay on **o03**.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title / support | Same as o03 | Same |
| Focused field | `Your sources` — strong focus border; label remains | Same |
| Example (on focus) | Label `Example` · body `El Tiempo; NYT and WaPo LatAm desks; @StateDept on X.` — on all o03e specimens | Same |
| Show examples control | **Omit** — Example block on focus is the only examples UI | Same |
| Other fields | Role / Priorities / Org / Stakeholders may show filled draft (Paper illustration) — fields independently focusable | Same |
| CTA | `Build my scope →` — Primary when any field has ≥1 non-whitespace (specimen: upstream filled → Primary) | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) |

**UX (locked)**

1. **Focus Sources** → Example under the field; strong border on the focused blurb.
2. **CTA readiness:** Family rule — any field ≥1 non-whitespace → Primary; else mute ([button](../../03-design/design-system/components/button.md)). Keyboard may hide CTA; readiness still applies.
3. **iOS keyboard:** Tap Sources → system keyboard.
4. **Keyboard dismiss / Return:** Family rules — tap outside / blur dismisses; **Return** = newline (not dismiss).
5. **Draft persistence / commit:** Family rules under o03 (all five filled → Build; incomplete → [G0Y](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) Build anyway).
6. **Layout:** Same Scope family as o03 / o03a–d.

**Navigation:** Stay on Scope. No in-UI back.

**Out of this screen:** [o03f · Ready](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/88F-0) · [Incomplete modal](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) · Extracting · Review · [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0).

#### O3f — Scope · Ready

Specimen: [o03f · Scope · Ready](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/88F-0) — desktop + mobile; all five fields filled, none focused.

**Job:** Happy-path commit state — operator has drafted all five blurbs; **Build my scope →** writes them and starts extraction.

**Who can visit:** Same as o03 — session; no confirmed scope; **all five** drafts have ≥1 non-whitespace character.

**Data (Supabase):** Idle Ready = still client draft (no write). On **Build my scope →**: family **commit** — write all five blurbs, then invoke extraction ([model--extraction--v1.md](./model--extraction--v1.md) / [Extraction contract](../contracts/extraction.md)).

**Metrics (PostHog):** none new. Family visit / O2→O3 conversion stay on **o03**.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title / support | Same as o03 | Same |
| Fields | All five filled, idle (no focus border, **no** Example block). Filled copy = **illustration** (family rule under o03) — not prefills | Same |
| Show examples control | **Omit** | Same |
| CTA | Primary `Build my scope →` | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) |

**UX (locked)**

1. **No field focused** → no Example blocks.
2. **Fields stay editable** — tap a field → matching o03a–e focus state (draft preserved).
3. **CTA** → write blurbs → invoke extraction → [o04 · Extracting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70P-0).
4. **Not this screen:** Incomplete / [o03g](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) (not all filled); extraction fail — [o04a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0).
5. **Layout:** Same Scope family as o03.

**Navigation:** Forward only via Build. No in-UI back.

**Out of this screen:** [o04 · Extracting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70P-0) · field re-focus o03a–e · [o03g](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) if they empty a field then tap Build · [o02c](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/FRX-0).

#### O3g — Incomplete · Modal (O3 state)

Specimen: [o03g · Incomplete · Modal](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0)

**Job:** Soft gate when the operator taps **Build my scope →** with a **partial** draft — warn that empty fields mean less signal; let them keep editing or build anyway.

**Who can visit:** Session; no confirmed scope; **≥1** field has ≥1 non-whitespace **and** **≥1** field is empty/whitespace-only. Not reachable from all-empty (CTA muted) or all-filled ([o03f](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/88F-0) — Build goes straight to extract).

**Data (Supabase):** Modal idle = none. On **Build anyway** only: Scope family **commit** — write filled blurbs; empty fields → NULL; then invoke extraction. Extraction run I/O / tables — [model--extraction--v1.md](./model--extraction--v1.md) (not this screen).

**Metrics (PostHog):** none — no modal visit, no Keep editing / Build anyway / dismiss events (MVP).

**Copy / chrome (locked)** — [modal](../../03-design/design-system/components/modal.md)

| Element | Spec |
| --- | --- |
| Scrim | `--ink-primary` **45%** over live Scope shell (draft visible behind) |
| Title | `Some fields are empty.` |
| Body | `Tempo uses what you write to choose which stories to show you, and why they matter. Empty fields mean less to go on, but you can still build your scope.` |
| Close | × top-right of panel (`Close`) |
| Keep editing | **Primary** (ink outline) |
| Build anyway | **Secondary** (muted outline) — escape hatch, not the nudged path |

**UX (locked)**

1. **Entry:** Partial Scope + `Build my scope →` → open o03g overlay (do not commit yet).
2. **Dismiss (same outcome):** × · Keep editing · **Esc** → close modal; stay on the **same** underlying o03* state (drafts preserved). **No** scrim-click dismiss.
3. **Build anyway:** dismiss modal immediately (no busy chrome on the modal) → commit blurbs → invoke extraction.
4. **Invoke accepted** → [o04 · Extracting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70P-0). **Invoke fails** (job never accepted) → [o04a · Extract fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0). Run failure after o04 is o04 → o04a (o04 lock).
5. Desktop + iOS: same modal grammar; centered panel.

**Navigation**

| Control | Destination |
| --- | --- |
| × / Keep editing / Esc | Underlying o03* (modal closed) |
| Build anyway → invoke OK | o04 |
| Build anyway → invoke fail | o04a |
| Scrim click | No-op |

#### O4 — Extracting

Specimen: [o04 · Extracting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70P-0) — desktop + mobile.

**Job:** Transient loading while extraction runs after Scope commit. Buy perceived continuity (skeleton + motion); do **not** invent wait beyond the job + anti-flicker floor. Parallel metastory / feed warm may start here but must **not** gate exit.

**Who can visit:** Session; blurbs just committed via Build / Build anyway; extraction in flight. No confirmed scope yet.

**Data (Supabase):** none (product writes on this screen). Blurbs already persisted. Structured extracts / run records — [model--extraction--v1.md](./model--extraction--v1.md) / [extraction pipeline](../../06-engineering/docs/pipelines/extraction.md).

**Metrics (PostHog):** no visit event on this screen. A finished invoke is `extraction_invoke` in [model--extraction--v1.md](./model--extraction--v1.md).

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Building your scope.` | Same |
| Support | `Pulling your topics, keywords, geographies, and sources.` — no duration claim ([form-intro](../../03-design/design-system/patterns/form-intro.md)) | Same |
| Shelves | Skeleton bones under **Topics** · **Keywords** · **Geographies** · **Press** · **Platforms** | Same |
| CTA | **Omit** / hidden (Paper `Start monitoring →` is `display: none`) | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) |

**UX (locked)**

1. **Enter immediately** on Build (show delay ≈ 0 — operator already expects a wait).
2. **Duration:** `visible_for = max(extraction_wall_time, min_hold ≈ 1.0–1.5s)`. No soft polish pad. Eng fail/timeout → o04a.
3. **Bones:** opacity **pulse**, cycle **~1.5–2.0s** ease-in-out; **no** lateral shimmer ([motion](../../03-design/design-system/foundations/motion-and-feedback.md)). `prefers-reduced-motion` → static bones (or one dim fill), no loop.
4. **Paired continuity:** form-intro / support min-heights reserved for Extracting → Review (same DS form-intro rules).
5. **Metastories / feed:** may warm **in parallel**; Start monitoring / warm restart rules live on **o05**.
6. **Layout:** desktop = value panel + form; iOS = form column.

**Navigation**

| Outcome | Destination |
| --- | --- |
| Extraction succeeds (after min hold) | [o05 · Review](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70R-0) |
| Extraction fails / times out | [o04a · Extract fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0) |

No in-UI back while extracting.

**Out of this screen:** [o05](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70R-0) · o04a · Incomplete modal · o02c.

#### O4a — Extract fail (O4 state)

Specimen: [o04a · Extract fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0)

**Job:** Recover when extraction **does not start** or **fails / times out** after Scope commit. Reassure that blurbs are saved; one path — retry extract.

**Who can visit:** Session; blurbs already committed; no confirmed scope. Not for empty-but-valid extracts (those → Review thin states, e.g. o05a).

**Data (Supabase):** none on this screen. Blurbs already persisted. **Try again →** re-invokes extraction only: `trigger_kind = retry`, **same** `trigger_id` as the failed `build` ([model--extraction--v1.md](./model--extraction--v1.md) · [extraction pipeline](../../06-engineering/docs/pipelines/extraction.md)). No blurb re-commit.

**Metrics (PostHog):** no o04a visit, and no Try again click event. The failure that opened this screen is `extraction_invoke` in [model--extraction--v1.md](./model--extraction--v1.md).

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Building your scope.` | Same |
| Support (error) | `We couldn't build your scope. Your answers are saved.` (destructive) | Same |
| Shelves / chips | **Omit** — no Topics–Platforms shelves, no chips, no Add/× | Same |
| CTA | Primary `Try again →` | Same |
| Edit answers | **Omit** | **Omit** |
| Back / leave | Browser only | **No** chevron (title-lock) |

**Entry**

| From | When |
| --- | --- |
| [o03f](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/88F-0) Build my scope → | Invoke fails (job never accepted) — skip o04 |
| [o03g](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/G0Y-0) Build anyway | Invoke fails — skip o04 |
| [o04](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70P-0) | Invoke OK then extract hard-fails, invalid payload, or **times out** |

**Fail / timeout ceiling:** referenced on o04 (`eng fail/timeout → o04a`); **seconds not locked here** — set in extraction model / pipeline. **min_hold ~1.0–1.5s** on o04 is success anti-flicker only, not the fail timer.

**UX (locked)**

1. Same onboarding shell as o04 (value + form / iOS form) — title + error + CTA only.
2. **Try again →** stay on o04a; CTA **busy mute** (no optimistic jump to o04).
3. No in-UI path back to Scope edit (no chips / no Edit answers). Mid-onboarding resume to Scope remains first-land if they leave the app.

**Navigation**

| Outcome | Destination |
| --- | --- |
| Try again → invoke OK | [o04 · Extracting](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70P-0) |
| Try again → invoke fail | Stay on o04a (`Try again →` re-enabled) |
| Extract run fails / times out after retry | o04 → o04a again |

#### O5 — Review

Specimen: [o05 · Review](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70R-0) — desktop + mobile; Add editing: [ANN](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/ANN-0).

**Job:** Required confirm/edit of extracted scope chips before monitoring goes live. Operators can remove or add chips; **Start monitoring →** ensures or restarts metastory/feed warm, then (on trigger accept) commits memberships, marks scope confirmed, and hands off to dashboard loading.

**Who can visit:** Session; extraction succeeded; no confirmed scope yet.

**Data (Supabase)** — chip shelves only (blurbs already committed on Build). Catalog + join semantics per [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) / [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37). Granular extract I/O → [model--extraction--v1.md](./model--extraction--v1.md).

| Shelf | Catalog | Membership |
| --- | --- | --- |
| Topics | `topics` | `user_topics` |
| Keywords | `keywords` | `user_keywords` |
| Geographies | `geographies` | `user_geographies` |
| Press | `press_sources` | `user_press_sources` |
| Platforms | `social_accounts` | `user_social_accounts` |

| Event (when warm **trigger is accepted** on Start / Try again) | Membership write |
| --- | --- |
| Chip from extraction kept | `origin = extracted`, `created_at`, active (`deleted_at` NULL) |
| Operator **Add** | `origin = user_added`, `created_at`, active |
| Operator **x** | No membership row. The chip was only in the session draft |

**While on Review:** chip add/remove = **session draft** only — no membership DB write and **no** confirmed scope until warm **trigger accept** (then commit + live + d01). Trigger fail → [o05e](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/I29-0); scope stays unconfirmed.

**MVP re-extract (Account):** do **not** auto-drop T/K/G/Press/Platforms memberships (`superseded` unused in those product flows). Keep prior chips; operator edits in Account. Keep `end_reason = superseded` in the schema for stakeholder mentions / later.

**Not on this UI:** Role / org / stakeholders blurbs (no chip shelves; stakeholders remain extract-only per contract).

**Metrics (PostHog)**

| Event / insight | When | Properties / definition |
| --- | --- | --- |
| O5 visit | Review family land: **o05** + **o05a–d** (not [o05e](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/I29-0)) | platform; `review_state`: `empty` \| `missing_sources` \| `missing_facets` \| `thin` \| `ready` |
| Conversion O3 → O5 | Funnel | **Denominator = O3 views** (new). **Numerator = O5 views** (includes unclean extract lands). Extraction hard-fails never reach O5. |
| Conversion O5 → d01 | Funnel | **Denominator = O5 views** (o05+a–d). **Numerator = d01 views** after Start / Try again success. Do **not** use o05e as a funnel step. |

Default names if unresolved: `onboarding_o05_viewed`. One visit event — **no** per-specimen `o05a_viewed` / … Slice unclean vs clean via `review_state`. Chip acceptance (`extraction_chip_acceptance`) is specified in [model--extraction--v1.md](./model--extraction--v1.md). It is not an O5 visit event and not an o05e event.

| `review_state` | Land condition |
| --- | --- |
| `empty` | o05a — all shelves empty |
| `missing_sources` | o05b — T∪K∪G has ≥1; Press∪Platforms empty |
| `missing_facets` | o05c — Press∪Platforms has ≥1; T∪K∪G empty |
| `thin` | o05d — gate met; ≥1 shelf still empty |
| `ready` | Happy o05 — gate met; specimen “full” land (all shelves have ≥1, or product treats as ready) |

**Start monitoring readiness (O5 family)** — [scope-gates](../../03-design/design-system/patterns/scope-gates.md)

CTA **Primary** only when session draft has **≥1** chip in **Topics ∪ Keywords ∪ Geographies** **and** **≥1** chip in **Press ∪ Platforms**. Otherwise clean incomplete mute. Applies to happy o05 and all thin/empty Review states (incl. if the operator strips chips down).

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Review your scope.` | Same |
| Support | `Confirm what Tempo will monitor. You can edit this anytime.` when all five shelves have ≥1 chip (`ready`); thin counsel on [o05d](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/HIV-0) | Same |
| Shelves | Topics · Keywords · Geographies · Press · Platforms — chips + **Add** | Same |
| CTA | `Start monitoring →` — Primary when gate met; else muted | Same |
| Back / leave | No in-UI leave (browser) | Empty 44px Nav (title-lock) — **except** empty land ([o05a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/GQ2-0)) |

**UX (locked)**

1. **x** on a chip → remove from the session draft. At confirm, that chip is not inserted.
2. **Add** → strong focus border; type into pill ([ANN](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/ANN-0)). **Commit:** non-empty **blur** or **Return/Enter**. **Cancel:** **Escape** or empty blur. No special CTA commit rule (blur usually runs before Start monitoring); if CTA fires without blur, **discard** uncommitted draft.
3. **Dirty** = any add/remove (committed Add) since landing on O5.
4. **iOS:** tap Add → keyboard; tap outside / blur dismisses keyboard. Return = **commit chip** (single-line — not Scope newline).
5. **Start monitoring →** (only when gate met) — warm then commit:

| Path | Metastory / feed warm | Destination |
| --- | --- | --- |
| Clean (not dirty) + ensure OK | **Ensure** warm: keep if in flight; **start/retry** if never started or failed | Commit + confirmed scope → [d01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0) |
| Dirty + restart OK | **Restart** warm | Commit + confirmed scope → [d01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0) |
| Ensure or restart **trigger fails** | — | [o05e](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/I29-0) — no commit / not confirmed |

6. **Layout:** desktop = value panel + form; iOS = form column. Paired continuity with o04 (form-intro min-heights).

**Navigation:** Forward via Start monitoring only (when ready). No in-UI back on happy Review.

**Out of this screen:** [d01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0) · [I29](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/I29-0) · o04a · Incomplete modal · o02c · o05a–e.

#### O5a — Empty shelves (O5 state)

Specimen: [o05a · Empty shelves](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/GQ2-0)

**Job:** Extraction **succeeded** but returned **zero chips** on all five shelves. Let the operator manually seed scope (Add) or go back to blurbs; do not treat as extract-fail ([o04a](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0)).

**Who can visit:** Session; extract completed successfully; **all** of Topics · Keywords · Geographies · Press · Platforms are empty in the session draft. Partial empties → o05b–d, not this screen.

**Data (Supabase):** none until Start monitoring. Chip Add/× = session draft (family rules under o05). Extract I/O → [model--extraction--v1.md](./model--extraction--v1.md).

**Metrics (PostHog):** O5 visit with `review_state: empty` (family rule under o05). No separate o05a event.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Review your scope.` | Same |
| Support (all empty) | `Nothing was pulled in yet. Add items below or go back so Tempo can show stories.` | Same |
| Shelves | Five labels + **Add** only (no chips) | Same |
| CTA | `Start monitoring →` muted (gate unmet) | Same |
| Back | Browser only | Chevron → **Scope with saved blurbs** (often [o03f](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/88F-0); whatever draft they committed) |

**Support while still gated (after some Adds)** — swap when the **missing requirement class** changes; not on every chip ([scope-gates](../../03-design/design-system/patterns/scope-gates.md)):

| Draft state | Support |
| --- | --- |
| All five empty | Empty copy above |
| ≥1 chip, missing T/K/G | `Add Topics, Keywords, or Geographies so Tempo can show stories.` |
| Has T/K/G, missing Press/Platforms | `Add Press or Platforms so Tempo can show stories.` |
| Gate met | Happy o05 support (`Confirm what Tempo will monitor…`) — specimen may leave empty-shelf chrome; product state is ready Review |

**UX (locked)**

1. **Add / × / commit** — same as o05 ([ANN](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/ANN-0)).
2. **Start monitoring →** enables only when family gate met; then same warm / d01 / I29 rules as o05.
3. **iOS back:** leave Review; **discard** session chip draft; Scope shows saved blurbs. Return to Review only via Build / Build again (re-extract).
4. Desktop: no in-UI back (browser). Leaving Review the same way discards chip draft.

**Navigation**

| Control | Destination |
| --- | --- |
| Start monitoring → (gate met) | d01 / I29 per o05 |
| iOS back | Scope + saved blurbs |
| Add chips until gate met | Stay on Review (no longer “empty shelves” product state) |

#### O5b — Missing sources (O5 state)

Specimen: [o05b · Missing sources](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/HBW-0)

**Job:** Extraction succeeded with facets (T/K/G) but **no sources** (Press∪Platforms empty). Hard-gate Start until the operator adds Press or Platforms.

**Who can visit:** Session; extract OK; session draft has **≥1** chip in **Topics ∪ Keywords ∪ Geographies** **and** **zero** chips in **Press ∪ Platforms**. Not “one of Press/Platforms empty while the other is filled” (that can still meet the gate → thin/ready).

**Data (Supabase):** none until Start monitoring. Chip draft / Start writes — family under o05. Extract I/O → [model--extraction--v1.md](./model--extraction--v1.md).

**Metrics (PostHog):** O5 visit with `review_state: missing_sources`. No separate o05b event.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Review your scope.` | Same |
| Support (land) | `Sources weren't pulled in. Add Press or Platforms so Tempo can show stories.` | Same |
| Shelves | T/K/G may show chips; Press + Platforms = **Add** only (specimen) | Same |
| CTA | `Start monitoring →` muted until sources side has ≥1 | Same |
| Back | Browser only | **No** chevron (title-lock) — unlike o05a |

**Support while editing** — family swap on missing-class change (same table as o05a). Land missing-sources copy above ≡ gate line for empty Press∪Platforms when T/K/G present.

**UX (locked)**

1. **Add / × / commit** — same as o05.
2. **Start monitoring →** when family gate met — same warm / d01 / I29 as o05.
3. No in-UI back to Scope on this state.

**Navigation:** Stay on Review until Start (ready) or leave via browser. Adding a Press or Platforms chip clears this state (→ thin/ready support + Primary when gate met).

#### O5c — Sources without facets (O5 state)

Specimen: [o05c · Sources without facets](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/HT3-0)

**Job:** Extraction succeeded with sources (Press∪Platforms) but **no facets** (T∪K∪G empty). Hard-gate Start until the operator adds Topics, Keywords, or Geographies.

**Who can visit:** Session; extract OK; session draft has **≥1** chip in **Press ∪ Platforms** **and** **zero** chips in **Topics ∪ Keywords ∪ Geographies**. Not “one of T/K/G empty while another is filled” (that can still meet the facets side → thin/ready).

**Data (Supabase):** none until Start monitoring. Chip draft / Start writes — family under o05. Extract I/O → [model--extraction--v1.md](./model--extraction--v1.md).

**Metrics (PostHog):** O5 visit with `review_state: missing_facets`. No separate o05c event.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Review your scope.` | Same |
| Support (land) | `Topics, Keywords, and Geographies weren't pulled in. Add them so Tempo can show stories.` | Same |
| Shelves | Press / Platforms may show chips; T/K/G = **Add** only (specimen) | Same |
| CTA | `Start monitoring →` muted until facets side has ≥1 | Same |
| Back | Browser only | **No** chevron (title-lock) — same as o05b |

**Support while editing** — family swap on missing-class change (same table as o05a). Land missing-facets copy above ≡ gate line for empty T∪K∪G when Press∪Platforms present.

**UX (locked)**

1. **Add / × / commit** — same as o05.
2. **Start monitoring →** when family gate met — same warm / d01 / I29 as o05.
3. No in-UI back to Scope on this state.

**Navigation:** Stay on Review until Start (ready) or leave via browser. Adding a Topics, Keywords, or Geographies chip clears this state (→ thin/ready support + Primary when gate met).

#### O5d — Thin but ready (O5 state)

Specimen: [o05d · Thin but ready](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/HIV-0)

**Job:** Extraction (or operator edits) left a **Start-ready** scope that is still **incomplete across shelves**. Soft counsel — allow Start; nudge to add more.

**Who can visit:** Session; extract OK (or post-edit); Start gate **met** — **≥1** in **T∪K∪G** **and** **≥1** in **Press∪Platforms** — **and** **≥1** of the five shelves is still empty. All five shelves non-empty → happy o05 (`ready`), not this screen. Not gated states o05a–c.

**Data (Supabase):** none until Start monitoring. Chip draft / Start writes — family under o05. Extract I/O → [model--extraction--v1.md](./model--extraction--v1.md).

**Metrics (PostHog):** O5 visit with `review_state: thin`. No separate o05d event.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Review your scope.` | Same |
| Support (land) | `A thinner scope means fewer stories. Add more below, or start with what you have.` ([scope-gates](../../03-design/design-system/patterns/scope-gates.md) soft counsel) | Same |
| Shelves | Mix of chips + empty **Add**-only rows (specimen) | Same |
| CTA | Primary `Start monitoring →` (gate met) | Same |
| Back | Browser only | **No** chevron (title-lock) |

**Support while editing** — family swap on missing-class change. If the operator empties a whole gate side → hard-gate copy + muted Start (o05b/c territory). If they fill every shelf → happy o05 support (`Confirm what Tempo will monitor. You can edit this anytime.`).

**UX (locked)**

1. **Add / × / commit** — same as o05.
2. **Start monitoring →** — same warm / d01 / I29 as o05 (Primary from land).
3. No in-UI back to Scope on this state.

**Navigation:** Forward via Start monitoring, or stay editing. Leave via browser.

#### O5e — Start fail (O5 state)

Specimen: [o05e · Start fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/I29-0)

**Job:** Recover when **Start monitoring** (or **Try again**) cannot **trigger** metastory/feed warm. Keep the operator on Review with chips editable; do not confirm scope until trigger succeeds.

**Who can visit:** Session; gate was met; warm **ensure** (clean) or **restart** (dirty) **trigger failed**. Expected mainly after dirty restart; rare on clean ensure-start. Not a funnel step.

**Data (Supabase):** none on land (scope still unconfirmed; chip draft only). On **Try again** → trigger OK: same membership + confirmed-scope write as successful Start (family under o05).

**Metrics (PostHog):** **none** for o05e visits / fail conversion. Activation funnel = O5 (o05+a–d) → **d01**. Extract↔edit delta → model PRD / evals.

**Copy / chrome (locked)**

| Element | Desktop web | iOS native |
| --- | --- | --- |
| Title | `Review your scope.` | Same |
| Support (error) | `We couldn't start monitoring.` (destructive; replaces happy/thin/gate support) | Same |
| Shelves | Chips + **Add** (session draft preserved) | Same |
| CTA | Primary `Try again →` (when gate still met); muted if operator empties a gate side | Same |
| Back | Browser only | **No** chevron (title-lock) |

**UX (locked)**

1. Metastories may already be warming from o04; **clean** Start = ensure; **dirty** Start = restart. o05e = that trigger failed.
2. **Add / ×** — same as o05; gate rules still apply.
3. **Try again →** stay on o05e; CTA **busy mute**; re-trigger warm (restart if still dirty / ensure if clean).
4. Trigger OK → commit + confirmed scope → [d01](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0). Trigger fail → stay o05e.

**Navigation**

| Outcome | Destination |
| --- | --- |
| Try again → trigger OK | d01 |
| Try again → trigger fail | Stay o05e |
| Empties a gate side | Muted Try again / Start until gate met again |

#### Handoff (out of this PRD)

[d01 · First-run loading](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0) and the rest of the dashboard family — specify in the dashboard PRD. Onboarding only defines the entry conditions (warm trigger accept → commit + confirmed scope → d01; first land when session + confirmed scope).

---

## Execution spec (agent-ready)

`Execution spec: deferred` until eng build needs agent-ready I/O. **Solution screen locks above are binding** for O1–O2 + o02a/o02b/o02c + magic-link email + **o03 empty** + **o03a–f** + **o03g** + **o04 Extracting** + **o04a** + **o05 Review** + **o05a–e**.

---

## Decisions & open questions

### Decision log

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| One PRD for desktop web + iOS native | Same journey; deltas per screen, not a second PRD | 02 Oct 26 | Native ship train needs a separate release doc |
| O1 CTA does not branch new vs returning | Both invited need magic link; branch after session exists | 02 Oct 26 | Evidence that returning users should skip Check inbox |
| Allowlist = seeded `users.email` rows | Ops pre-creates invited identities; field not prefilled | 02 Oct 26 | Separate invites table or open signup |
| `account_status` on CTA event only | Visit cannot know account; click can look up users + scope | 02 Oct 26 | Privacy policy forbids existence lookup |
| No email-format validation (MVP) | Magic link path; low abuse concern for invite-only MVP | 02 Oct 26 | Abuse, support load, or open signup |
| Invite-only copy remains | Early access positioning | 02 Oct 26 | Open signup |
| Invite-only deny = O1 family (`o01b`) | Sending implies a link was sent; muted CTA until email edit starts | 02 Oct 26 | Open signup removes the case |
| No o01b/o01c visit events; keep outcome events | CTA denied + send failed/succeeded diagnose identity funnel | 11 Oct 26 | Visit-level debugging |
| O1 CTA denied restored (`not_invited`) | Explains O1→O2 drop without o01b visits | 11 Oct 26 | Privacy forbids deny logging |
| o01c Try again = Sending + allowlist re-check | Ops list may change; editable email + recovery like o01b | 11 Oct 26 | Lock field on fail |
| Onboarding stage name = Scope (not Blurbs / Profile) | Matches UI `Set your scope.` and Paper `o03 · Scope · …` | 02 Oct 26 | Evidence that operators need a different stage label |
| O1a = O1 state (not a route) | In-flight send feedback only | 03 Oct 26 | Need shareable/deep-linkable Sending URL |
| Send fail → o01c; general fail → s02 | OTP/provider vs unexpected; both designed | 03 Oct 26 | Collapse to one error surface |
| Magic-link send success/fail events | Diagnostic for OTP path | 03 Oct 26 | Noise / privacy trim |
| Paper order: o01b · o01c · o02b · o02c (o02d removed) | Match L→R States board + journey letters | 03 Oct 26 | Board reshuffle |
| O1→O2 conversion = invited CTA → O2 view | Product behavior; raw visits = demand elsewhere | 03 Oct 26 | Open signup / change funnel question |
| O2 iOS back = O1 email panel, no keyboard | 7FD layout sans keyboard; email preserved | 03 Oct 26 | Different back target |
| Resend cooldown = own screen lock | Keep O2 thin; o02a separate | 03 Oct 26 | Merge into O2 if cheap |
| Resend cooldown = 60s, starts on O2 land | Match Supabase per-user magic-link window; mute label only | 03 Oct 26 | Provider limit change |
| Resend fail = o02b on Check inbox | Do not reuse o01c O1 shell; Try again only (no Open inbox) | 03 Oct 26 | Evidence operators need inbox escape on fail |
| o02b metrics = B-lite (action outcomes only) | No fail-screen visits; send success/fail on Try again with `trigger: resend` for retry recovery | 11 Oct 26 | Privacy / noise trim drops retry outcomes |
| o02b Try again = busy on o02b → o02a on success | No optimistic cooldown; OTP fail stays o02b; unexpected → s02; entry from o02 or o02a | 11 Oct 26 | Optimistic jump to o02a on click |
| o02c → o02a on send success; fail → o02b | Check inbox tells them to open the new link; fail copy ≠ expired title | 11 Oct 26 | Stay on expired shell after send |
| Remove o02d (Link expired · Cooldown) | No product entry once success uses o02a and fail uses o02b | 11 Oct 26 | Need a distinct expired-cooldown job |
| o02c metrics = B-lite (Resend click + outcomes) | No fail-screen visits; `trigger: expired_resend` | 11 Oct 26 | Click-only / visit telemetry |
| Magic-link email copy + vars locked | ConfirmationURL CTA; omit Token/Email/Data; subject `Your Tempo link` | 03 Oct 26 | Change-email template or auth architecture change |
| Magic-link TTL = 15 minutes | Security best practice (~10–15m); override Supabase 1h default | 03 Oct 26 | Support load from expired links |
| o03 empty before o02c walk | Scope momentum; link-expired remains open on identity path | 03 Oct 26 | Auth support load forces o02c first |
| O2→O3 conversion = new∩O2 view → O3 view | Returners never hit Scope; don’t dilute denom | 03 Oct 26 | Open signup / different post-auth branch |
| Examples omitted on o03 empty | Examples only after field select (later o03*) | 03 Oct 26 | Evidence empty needs examples teaser |
| o03 empty = no in-UI leave | Post-auth Scope commit path; mobile title-lock empty Nav | 03 Oct 26 | Need escape to dashboard mid-scope |
| Scope blurbs = client draft until Build / Build anyway | Persist across fields in UX; one DB commit on forward leave | 04 Oct 26 | Autosave / crash recovery need |
| o03a Example on focus; omit Show examples | Example block is the examples UI | 04 Oct 26 | Evidence empty needs teaser again |
| CTA ready iff any field has ≥1 non-whitespace | Same spirit as O1 email readiness | 04 Oct 26 | Require all five before enable |
| Keyboard: tap-outside dismiss; Return = newline on Scope; Return may dismiss on O1 email | Multi-line blurbs vs single-line email | 04 Oct 26 | Different keyboard chrome |
| Thin model--extraction--v1.md stub | Ship ownership without dual SoT | 04 Oct 26 | Contract split / model v2 |
| Scope family blurb map under o03 | One place for five field → table mappings + draft/commit | 05 Oct 26 | Schema rename / sixth lane |
| o03b Show examples left as in Paper | PM deferred omit/fix this pass | 05 Oct 26 | Align Show examples with o03a omit |
| o03c Org = thin field state on family map | Same pattern as o03b; Show examples left as in Paper | 05 Oct 26 | Show examples family decision |
| o03d Stakeholders → `user_stakeholders.blurb` | Corrects field→table mapping; Show examples left as in Paper | 05 Oct 26 | Show examples family decision |
| o03e Sources → `user_sources.blurb` | Last field state; Show examples left as in Paper | 05 Oct 26 | Show examples family decision |
| First land = session × confirmed scope | Signed-out new/existing → O1; mid-onboarding resume Scope; signed-in existing → dashboard (d01 = loading) | 06 Oct 26 | Session not persisted until Review |
| Omit `Show examples` on all onboarding Paper frames | Off-canvas leftover; Example-on-focus is the examples UI | 06 Oct 26 | Need a teaser on empty |
| o03f Ready = commit all five then extract → o04 | Happy-path Build; sad paths later | 06 Oct 26 | Autosave / in-flight CTA mute |
| o03g = soft incomplete gate; Keep editing Primary | Nudge completeness; Build anyway Secondary escape; commit only on Build anyway | 11 Oct 26 | Hard-block until all five filled |
| o03g dismiss = × / Keep editing / Esc; no scrim | Match modal DS; unlabeled scrim dismiss | 11 Oct 26 | Allow scrim = Keep editing |
| o03g Build anyway → o04 / o04a (no modal busy) | o04 is the in-flight surface; invoke fail skips o04 | 11 Oct 26 | Busy mute on Build anyway |
| o03g metrics = none (MVP) | No modal visit / CTA events | 11 Oct 26 | Incomplete-path rate needed |
| Paper Scope filled copy = illustration, not prefills | Applies to all o03* specimens; operators start empty | 06 Oct 26 | Need seeded demo accounts with real blurbs |
| o04 duration = max(extraction, min_hold ~1.0–1.5s) | Anti-flicker only; no soft polish pad; metastories warm in parallel | 07 Oct 26 | Measured p50/p95 forces copy or timeout UX |
| o04 bones = opacity pulse ~1.5–2s | Matches skeleton best practice; DS ≤120ms treated as transition step | 07 Oct 26 | DS motion doc retarget |
| o04 success → o05; fail → o04a | Matches extraction pipeline SoT | 07 Oct 26 | Empty-but-valid extract path (O5a) |
| o04a = title + error + Try again only | No shelves/chips; no Edit answers; blurbs saved | 11 Oct 26 | Add Edit answers escape |
| o04a Try again = busy → o04 on invoke OK | Same discipline as o02b; invoke fail stays o04a | 11 Oct 26 | Optimistic o04 on click |
| o04a metrics = none; timeout seconds deferred | Fail ceiling owned by extraction model/pipeline; min_hold ≠ fail timer | 11 Oct 26 | Lock UX ceiling seconds here |
| Empty-but-valid extract ≠ o04a | Thin Review (o05a…) not extract-fail | 11 Oct 26 | Treat empty as hard fail |
| o05a = all five shelves empty only | Partial empties are o05b–d; empty ≠ extract-fail | 12 Oct 26 | Route any-empty to o05a |
| O5 visit = o05 + o05a–d with `review_state`; exclude o05e | Funnel = reached Review (editable); unclean extract is a property not a drop | 12 Oct 26 | Separate visit events per specimen |
| o05b = T/K/G present + Press∪Platforms empty | Whole sources side empty; not one-of Press/Platforms | 12 Oct 26 | Disable Start if only Platforms empty |
| o05b no iOS back | Only o05a has chevron to Scope | 12 Oct 26 | Back on all gated Review states |
| o05c = Press∪Platforms present + T∪K∪G empty | Whole facets side empty; mirror of o05b | 16 Oct 26 | Disable Start if only Keywords empty |
| o05d = gate met + ≥1 shelf empty | Soft counsel; Start Primary; not both-sides holes required | 16 Oct 26 | Require empty shelf on both gate sides |
| o05d → happy support when all shelves filled | `Confirm what Tempo will monitor…` | 16 Oct 26 | Keep thin counsel after full fill |
| Start gate = (T∪K∪G) ∧ (Press∪Platforms) on all Review | Match scope-gates; mute until both sides have ≥1 chip | 12 Oct 26 | Allow Start with sources-only or tags-only |
| o05a support swaps to hard-gate copy when partial | Empty copy only while all empty; change on missing-class change | 12 Oct 26 | Keep empty copy forever / rewrite every chip |
| o05a iOS back → Scope + blurbs; discard chip draft | Recovery to edit blurbs; must Build again to re-extract | 12 Oct 26 | Back to o03f only / keep chip draft |
| o05 chips = session draft until Start monitoring | Memberships + confirmed scope write on CTA | 10 Oct 26 | Autosave chip edits |
| Add chip = blur/Return commit; Escape/empty blur cancel | Single-line chips; no special CTA commit | 10 Oct 26 | Comma-separator add |
| Dirty Start → restart warm; clean → ensure warm; trigger fail → o05e | Avoid dead-end d01; parallel warm from o04; clean ensure-fail also → o05e | 10 Oct 26 | Warm always blocking |
| Scope commit only after warm trigger accept | o05e keeps Review unconfirmed; Try again then commit → d01 | 16 Oct 26 | Commit before warm |
| No o05e visit metrics; O5→d01 funnel | Fail surface not a step; activation = Review → d01 | 16 Oct 26 | Track o05e visits |
| Extract↔edit chip delta = model eval | Not onboarding PostHog; sibling model PRD | 16 Oct 26 | Funnel property on O5 |
| Chip acceptance lives on the extraction PRD | PostHog guardrail, not an O5 visit event and not an eval. First-Review **x** inserts no row | 22 Oct 26 | Onboarding starts owning acceptance |
| d01 / dashboard out of onboarding PRD | Dashboard family SoT; onboarding keeps thin handoff only | 16 Oct 26 | Merge dashboard into onboarding doc |
| Onboarding Solution walk closed at o05e | Happy path + States locked; no further onboarding screens this PRD | 16 Oct 26 | New onboarding State discovered |
| MVP: no auto-drop T/K/G/Press/Platforms on re-extract | `superseded` unused in those flows; keep column; x = `user_removed` | 10 Oct 26 | Account Rebuild needs prune UX |
| O3→O5 conversion + O5 visit | Onboarding UX metrics; model evals elsewhere | 10 Oct 26 | Also track Start monitoring click |

### Blocking open questions

| Question | Default if unresolved |
| --- | --- |
| Exact PostHog event names for O1 visit / CTA / CTA denied / O2 visit | `onboarding_o1_viewed` / `onboarding_o1_cta_clicked` / `onboarding_o1_cta_denied` / `onboarding_o2_viewed` |
| s02 Try again exact return | O1 ready, email preserved |
| Resend cooldown duration (o02a) | **60s** (locked) |
| Exact PostHog name for O3 visit | `onboarding_o03_viewed` |
