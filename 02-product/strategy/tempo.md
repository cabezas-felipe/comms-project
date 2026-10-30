# Tempo — strategy

> **Altitude:** Product | **Stage:** MVP (v1) | **Doc:** 1.0 | **Status:** Draft | **Owner:** Felipe | **Last updated:** 02 Oct 26

Lean spine for reconstruction. Decision rules: [Product principles](../principles.md). Capability inventory: [Features bank](../features-bank.md). Evidence snapshot: [Research context](../../01-research/ops/research-context.md) (🟠 low-N). UX reference: Paper Tempo · [05 - UX/UI](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0). MVP-era product docs are historical only ([prds/archive](../prds/archive/), [contracts/archive](../contracts/archive/)).

---

## Mission / purpose

Give the solo bilateral/comms operator one trusted, provenance-backed view of how **in-scope** narratives are clustering and moving — and package that sense so they can ship it into workflows they already use — without Tempo acting on their behalf.

## Who it’s for

**Primary (design unit):** p1 — solo bilateral/comms operator running monitoring, analysis, and response under time pressure ([Personas](../../01-research/personas.md)).

**Secondary (learn, do not design for):** p2 — small embassy press/political cell (`hypothesized`). Watch for mechanism divergence (morning throughput vs interruption-while-drafting); do not build team/handoff surfaces in this slice.

## Problem

**Primary:** Holding an accurate picture of in-scope bilateral narratives under time pressure without drowning in scattered tabs and sources.

**Secondary (p1-shaped, not yet replicated):** Re-checking mid-draft when the story may have moved — interruptive monitoring tax.

**Adoption gate:** Synthesized monitoring is unused unless provenance and change signals are trustworthy enough that the operator stops rebuilding the picture manually.

Evidence is directional (N=2 participants, 🟠); monitoring ranks #1 as a *load* label for both, but *mechanism* still diverges — see [Research context](../../01-research/ops/research-context.md).

## Strategic choices

1. **Sequence:** Monitor + interpret now → **share/copy wedge** next → in-product **drafting** later (exploratory). Full distribution CRM (contact lists, send pipelines) only if the thin share wedge proves sticky.
2. **How we win:** Embed into work operators already do (e.g. WhatsApp / capital briefs via copy/share) on top of **trusted, scoped meta-story intelligence** (clustering, ranking, what-changed, posture, provenance) powered by solid models and data — not “a nicer news reader,” not drafting-first.
3. **Scope ceiling:** User-defined topics, geos, and sources are the hard ceiling (pp2). Tempo never auto-expands watch scope.
4. **Agency:** Signal readiness and prepare material; never prescribe, send, publish, or act (pp5).
5. **Design unit:** Optimize for p1; p2 is research-only until evidence licenses otherwise.

**Not doing (this slice):** team collaboration surfaces, proactive content calendars, autonomous discovery beyond config, acting as institutional system-of-record beyond the operator’s configured watch.

## Key assumptions

| Assumption | Conviction | Risk if wrong |
| --- | --- | --- |
| Solo bilateral/comms operators (p1) are a real, reachable segment — not a one-off shape | M | Strategy optimizes for a ghost; real demand sits in team or non-embassy roles |
| “Monitoring first” remains the #1 job even when mechanism differs (interrupt vs morning throughput) | M | We build the wrong primary surface (e.g. capital-briefing-first) |
| Operators will treat Tempo as default monitor if provenance + what-changed + posture are trustworthy enough | L | Share wedge never fires; product stays a curiosity tab |
| Copy/share brief embeds into existing WhatsApp / capital-brief habits without requiring full contact-list CRM first | M | Wedge fails if too thin — or we over-build CRM too early |
| Operators will configure and maintain monitoring scope rather than expect autonomous discovery | M | Onboarding churn; “it missed what I care about” kills trust |
| Drafting can wait; share-of-sense is enough “act” for early validation | M | p1’s real win is finish-the-statement; we validate the wrong loop |

## What winning looks like

| Layer | Signal |
| --- | --- |
| **North star** | p1 uses Tempo to **make sense and ship sense** (share/copy) into existing workflows — without tab-scatter as their primary monitor |
| **Early signal** | In a short pilot: opens Tempo for monitoring **and** uses copy/share on a live narrative without rebuilding the brief from scratch in WhatsApp / email |
| **Guardrail** | Never optimize share rate by hiding provenance or softening uncertainty; a miss on an in-scope story the operator needed is worse than a dismissible extra (pp7) |

## Decision log

| Date | Change | Why |
| --- | --- | --- |
| 02 Oct 26 | Initial strategy spine locked (reconstruction Align / Lean) | Same product bet, clearer carry/cut before slice PRDs |
| 02 Oct 26 | Who = design for p1, learn p2 | pp1 + Paper solo journeys; p2 hypothesized, mechanism diverges |
| 02 Oct 26 | Mission = trusted scoped landscape + readiness to respond; never act | Matches Paper feed/story/share; pp5 |
| 02 Oct 26 | Problem = landscape/load primary; interruption secondary; trust = adoption gate | Shared load across N=2; interruption not yet replicated |
| 02 Oct 26 | Sequence = monitor → share wedge → draft exploratory | Fastest validation path; share maps to interview choreography; draft is heavier UX/eng |
| 02 Oct 26 | Win = workflow embed on trusted scoped intelligence | Harvey-shaped embed; models/data as substrate |
| 02 Oct 26 | Scope ceiling + signal/never-act locked | Carry pp2 / pp5 into strategy so agents don’t broaden |
| 02 Oct 26 | Assumptions A1–A6 + winning B/B/B locked | Honest low-N; evaluative trust still open |
| 02 Oct 26 | MVP-era PRDs / field doctrine / eval gold treated as archive or eng evals — not active SoT | Reconstruction clarity |
| 02 Oct 26 | Header: Stage = MVP (v1), Doc = 1.0; filename stays `tempo.md` | Stable SoT path; stage/revision in metadata, not filename |
