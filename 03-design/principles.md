# Design principles

**Update:** 08 Sep 26

> **Scope:** High-level experience and interface judgment — how screens, flows, and interaction patterns should feel and behave for a solo comms operator running the monitor → draft → close loop.
> **Altitude:** Experience constraints, not product scope and not a full visual system. Keep the list short (handful).
> **Usage:** Apply when designing or reviewing UX/UI (including agent-built prototypes). Prefer these over default SaaS patterns when they conflict. All principles carry `working` status until replicated with 2–3 additional participants — treat as strong bets, not laws.

---

## Conventions

| Field             | Guidance / Values                                      |
| ----------------- | ------------------------------------------------------ |
| **ID**            | Stable slug                                            |
| **Principle**     | Short, imperative name                                 |
| **Means**         | One or two sentences: how it shows up in the interface |
| **Does not mean** | Optional: common misread or temptation to reject       |
| **Status**        | `working` · `validated` · `retired`                    |

**Status**

| Value       | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `working`   | Active guidance; still a bet                          |
| `validated` | Confirmed by research, prototype, or shipped outcomes |
| `retired`   | No longer guides decisions; keep for history          |

---

## Principles

| id  | principle                                    | means                                                                                                                                                                                                                                   | does not mean                                                                                                                        | status  |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| dp1 | Calm by default, urgent when earned          | The interface stays visually and tonally steady during long monitoring and drafting sessions. Urgency — through color, weight, mode labels, and prominence — is earned by the story, not ambient. The user always knows what the system is showing and why. | Urgency indicators are removed; quiet states are disengaged. Calm and fast-public modes don't require distinct visual treatment.      | working |
| dp2 | Inform and prepare; never direct             | The interface surfaces signals, context, urgency, and draft material for human judgment. It may surface implications and readiness cues. It never prescribes a next action, sends, or publishes on the user's behalf.                    | Contextual language support and draft preparation are forbidden — they are in scope with human approval.                             | working |
| dp3 | Always within reach                          | Monitoring, context, drafting, and source material are never more than two interactions away. The layout embodies the workflow — the user doesn't navigate to their tools, they're already there.                                        | Every feature lives on the home screen; depth and detail are hidden.                                                                 | working |
| dp4 | Scan before read                             | Type scale, contrast, and hierarchy are tuned for rapid assessment of what changed, what matters, and how urgent it is — before the user reads a word. Depth is always available; it is never required to get the signal.               | Dense analysis has no place; long-form content is forbidden.                                                                         | working |
| dp5 | Trust through navigability, not assertion    | The interface never asks the user to take its word for anything. Every claim, signal, and summary points to its evidence. Confidence is earned by showing the work, not stating the conclusion.                                          | Every surface must expose raw source data; summaries and synthesis are forbidden.                                                    | working |
| dp6 | Surface confidence; never hide uncertainty   | When the system's confidence in a signal is low or partial, it shows it — labeled clearly — rather than suppressing it or presenting it as certain. The user decides what to trust; the interface makes that judgment possible.          | Every item needs a confidence score or disclaimer; high-confidence signals require no annotation.                                    | working |

---

## Changelog

| date      | change                                                                                                                                                                       | source |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 08 Sep 26 | Drafted dp1–dp6 from collaborative session. Replaced v0 bullet-list draft. dp4/dp6 from v0 (status unambiguous, accessible baseline) moved to foundations as system requirements, not principles. | — |
