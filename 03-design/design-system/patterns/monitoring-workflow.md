# Monitoring workflow — Monitor → Draft → Close

**Foundations:** [color](../foundations/color.md) · [motion](../foundations/motion-and-feedback.md) · [layout shell](../components/layout-shell.md)
**Research basis:** [Synthesis — personas and pains](../../../01-research/synthesis--personas-and-pains-discovery.md) · [Research context](../../../01-research/ops/research-context.md)

## Pattern goals

1. **Reduce interruption cost** while preserving situational awareness — the core validated pain from wave-1 research (monitoring narrative shifts while drafting).
2. **Make mode state obvious** without jarring transitions (calm check-in vs fast-public continuous monitoring).
3. **Surface what changed since last check** with minimum noise — the user sees the delta, not a full re-read.

## The loop

```
Monitor             Draft               Close
────────            ──────────────      ──────────────────
Brief loads    →    User opens story → User finalizes draft
Status triage  ←    Narrative shifts    Confirms send window
                    interrupt check     Archives or defers
```

This loop runs continuously during an active session. The layout shell keeps all three stages reachable at all times — the user doesn't navigate away from the feed to draft.

## Core UI pattern

| Element | Treatment | Rationale |
| --- | --- | --- |
| Persistent mode indicator | Top bar, always visible | User never loses track of current monitoring state |
| Narrative feed | [Narrative rows](../components/narrative-row.md) — pills-only, chevron expand, soft hairlines between rows | Status is scannable before the headline is read |
| Story open | [Metastory open](metastory-open.md) — in-feed expand; Why → H\|C → Next\|Actions → Sources (platform CTA split; desktop key+`+n` / mobile full-list scroll) | Interrupt-check without leaving the brief |
| Source drill-down | [Source reader](source-reader.md) — desktop docked · mid overlay · mobile large sheet; snippet then `Open original` | Progressive provenance without leaving the metastory |
| Home filters | [Dashboard filters](dashboard-filters.md) — Mode / Select / Always-on free text | Lens without chip noise; idle vs editing |
| What-changed delta | Status pill update (Rising / Stable / Falling) | No re-read required; change is visible at a glance |
| Drafting panel | Always in the shell, not behind a route | Reduces interruption cost of switching between monitoring and drafting |
| Priority strip | Rising rows only, prominently at top of brief | Only what requires action surfaces urgently |

## Status-to-action mapping

| Status | Operator intent | UI behavior |
| --- | --- | --- |
| Rising | Needs attention before next task | Row at top of brief; stronger visual weight; implication strip available |
| Stable | Monitor but no immediate action | Present in brief; medium weight; no urgency cue |
| Falling | Deprioritize | Present but de-emphasized; falling headline color |

## Color and component mapping

- **Rising / Stable / Falling:** [story-status pill](../components/badge.md) + `--ink-primary` headline (Falling may use `font-medium`). No left rail on feed rows.
- **Delayed refresh / refresh fail (with feed):** feed freshness footer — `Next update delayed` → `Updated {clock}` → `Update now` ([narrative-row](../components/narrative-row.md)). Same UI for routine delay and failed soft refresh. Not Rising; not warning ink; not Populate error while stories exist.
- **First-run loading:** title `Building your dashboard.` (Newsreader) over Mode chrome; optional muted status `Pulling stories from your sources.` — no fake feed rows. Specimen: [Home · First-run loading](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/MSF-0)
- **Populate error** (empty-shell build / first-run fail): inline destructive support — `We couldn't build your dashboard. Your scope is saved.` + Primary `Try again →`. Keeps top bar + title + Mode chrome so the operator knows where they are; reassures scope is retained. **Not** [system generic error](system-surfaces.md). Specimen: [Home · Populate error](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/N1N-0)
- **Operational warnings** (sustained stale / do-not-trust, API issues): [Alert](../components/alert.md) with `--signal-warning` — kept strictly separate from story-status semantics
- **Urgency cues** ("what changed" deltas): status pill + text label — never `--signal-warning` or `--destructive`
- **Copy / Share fail unit:** desktop copy fail + mobile share fail + mobile copied fallback stay **one** specimen container ([Home · Copy / Share fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/P0C-0)) — see [metastory open](metastory-open.md)

## What this pattern is not

- It does not prescribe a next action. The interface informs and prepares; the operator decides. See [principles.md](../../principles.md) dp2.
- It does not push or send on the user's behalf.
- It does not surface all stories equally — the hierarchy is intentional and earned by story status.
