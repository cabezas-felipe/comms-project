# Form intro

**Foundations:** [typography](../foundations/typography.md) · [color](../foundations/color.md) · [spacing](../foundations/spacing-and-radius.md)
**Related:** [Modal](../components/modal.md) · [Input](../components/input.md) · [Large sheet](large-sheet.md)

## Purpose

Page- and panel-level **task header** for onboarding, Account, and similar full-width forms: name the job, then one light supporting line. Not feed chrome, not modal title stacks (modals reuse the same support rules at a tighter scale — see [modal](../components/modal.md)).

## Anatomy

```
Headline     Building your scope.     ← display (Newsreader), task name
Support      Pulling your topics…     ← body (Inter), muted; one continuous string
[fields…]
```

## Onboarding form headline (exception)

In-product display scale tops out at `2xl` (**24px**) for Brief / feed heroes ([typography](../foundations/typography.md)). **Onboarding form intros** (Value → Email through Extracting / Review / Account scope) use a larger display size so the task name holds the panel — this is intentional, not an off-scale drift.

| Breakpoint | Size / line-height | Weight | Letter-spacing | Family |
| --- | --- | --- | --- | --- |
| Desktop (~440px form · Settings docked panel) | **36px** / **44px** | `600` | **`-0.015em`** (display metrics) | Newsreader |
| Mobile form column · Settings L1 large sheet | **32px** / **38px** | `600` | **`-0.015em`** | Newsreader |

**Same mobile scale** for onboarding form columns and Settings step-back sheets ([large-sheet](large-sheet.md) shared stack). Do **not** invent a smaller sheet headline (e.g. 28px) — that is drift.

Do **not** retarget these headlines to `2xl` (24px). If a single scale across marketing + product is needed later, add a named onboarding display step — do not silently shrink locked specimens.

## Support copy (canonical)

| Rule | Detail |
| --- | --- |
| **One paragraph** | Support is a **single continuous text node**. Periods may join two short beats (what this screen does + what happens next / how long / agency). |
| **No hard line breaks** | Do **not** insert `\n` to stack short sentences as separate paragraphs. Soft wrap only. |
| **Measure** | At onboarding form width (~440px desktop) and the mobile form column, target **≤2 lines**. Prefer shortening over a third line or a forced break. |
| **Weight** | Inter, regular, muted (`--ink-muted`). **15px** / **24px** on desktop form intros **and** mobile form column / Settings L1 sheets (shared stack). Do not invent off-scale sizes (e.g. 14/20 on sheets). |
| **Job** | Orient the user: what this screen does, and the next expectation (editability, save, wait time). Do not restate the headline. |
| **Stability slot** | When a loading screen and its destination share the same chrome (e.g. Extracting → Review), keep a shared support **min-height** (**48px**) on **desktop and mobile**, and a shared form-intro **min-height** (e.g. **104px**), so the shelves do not jump — even when support is one visual line. |

**One-line rule:** Support copy = one paragraph that may wrap. Never two stacked paragraphs for short intro help.

## Ownership voice (`your`)

| Use **your** | Examples |
| --- | --- |
| Named **owned destinations** (page / sheet titles) | `Your dashboard.` · `Your scope.` · `Check your inbox.` |
| Support sentences that mark possession | `…to your new email…` · `This removes your Tempo account…` · `Pulling your topics…` |

| Prefer **bare** verb + object | Examples |
| --- | --- |
| Task headlines (work to do) | `Update email.` · `Delete account.` · `Start monitoring.` |
| Index action rows | `Sign out` · `Delete account` |

Do **not** cascade `Update your email.` / `Delete your account` on Index and titles — ownership already lives in destinations + support; store-safe Delete wording stays short.

## Content shapes (examples)

| Screen | Support (continuous) |
| --- | --- |
| Email / send link (Account) | `We'll send a one-time link to your new email to verify it's you.` |
| Email / send link (onboarding) | `We'll send a one-time link to verify it's you. No password needed.` |
| Check inbox (onboarding) | `We sent a link to [email]. Open it to continue.` |
| Set your scope | `Tempo uses this to choose which stories to show you, and why they matter. You can edit it anytime.` |
| Extracting | `Pulling your topics, keywords, geographies, and sources.` |
| Review scope | `Confirm what Tempo will monitor. You can edit this anytime.` |
| Account · Tags / Context | **Omit support** — headline `Your scope.` + tabs + form are enough. Do not add `Changes apply when you save.` (Save teaches apply). **Readiness ladder** (same as Tags): clean → muted `Save →` (full opacity); dirty/editing → Primary `Save →`; in-flight → same muted chrome + `Saving…` ([button](../components/button.md)). Paper: Context Idle / Editing / Saving after Tags trio. |
| Check inbox (Account email · desktop) | `We sent a link to [email]. Open it to confirm the change. Keep this tab open.` |
| Check inbox (Account email · mobile) | `We sent a link to [email]. Open it to confirm the change.` |
| Delete account (Settings L1) | `This removes your Tempo account and your scope. You cannot undo this.` |
| Legal doc meta (Settings L1) | Not support prose — use freshness frame `Updated · {date}` under the title ([account-menu](account-menu.md) · [narrative-row](../components/narrative-row.md)) |

Facet inventories on Extracting may use the umbrella **sources** (matches the prior **Your sources** field); Press / Platforms appear as shelves below. Support names the pull only — no duration claim until latency is measured. Do not hard-break the list.

## Out of scope

- Value-panel / marketing body on the onboarding split (longer measure; may wrap freely).
- Counsel-approved legal body prose (layout uses placeholders in Settings L1).
- Feed metadata, section labels, and modal titles (headline role only).

## Usage rules

1. **Prefer one visual line on desktop** when the string fits the form measure; two soft-wrapped lines are fine; hard breaks are not.
2. **Match sibling screens** in a flow (Extracting ↔ Review ↔ Account) for size, color, and continuous support treatment.
3. **Modals** use the same continuous-support rule at modal body scale ([modal](../components/modal.md)).
4. **No em dashes** in product UI ([typography](../foundations/typography.md#punctuation-product-ui)).
