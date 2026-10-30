# Product principles

**Update:** 06 Sep 26

> **Scope:** High-level product judgment — how we decide what to build, what to cut, and what to refuse when features or flows compete.
> **Altitude:** Decision rules, not strategy thesis and not UI guidance. Keep the list short (handful).
> **Usage:** Apply when scoping a PRD, prototype, or feature. If two musts conflict, the principle wins over the feature list. All principles carry `working` status until replicated with 2–3 additional participants — treat as strong bets, not laws.

---

## Conventions

| Field             | Guidance / Values                                              |
| ----------------- | -------------------------------------------------------------- |
| **ID**            | Stable slug                                                    |
| **Principle**     | Short, imperative name                                         |
| **Means**         | One or two sentences: what we optimize for in practice         |
| **Does not mean** | Optional: common misread or temptation to reject               |
| **Status**        | `working` · `validated` · `retired`                            |

**Status**

| Value       | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `working`   | Active guidance; still a bet                          |
| `validated` | Confirmed by research, prototype, or shipped outcomes |
| `retired`   | No longer guides decisions; keep for history          |

---

## Principles

| id  | principle                              | means                                                                                                                                                                                                         | does not mean                                                                                                              | status  |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| pp1 | Solo operator is the design unit       | Optimize for one person running the full communications loop alone — monitoring, analyzing, drafting, distributing — with no margin for a missed update. Team routing, shared handoffs, and multi-user surfaces are not in scope for this slice. | Team features are wrong; they come later if evidence licenses them.                                                        | working |
| pp2 | User scope is the ceiling              | Users define which topics, sources, and stories Tempo monitors. Tempo works exclusively within that configuration — it never expands scope autonomously, overrides mutes, or surfaces stories the user has not included. | The scope is fixed; users can change it at any moment.                                                                     | working |
| pp3 | Stay within reach, stay out of the way | News, insights, and monitoring are always accessible — within two clicks — so users can focus on strategic and tactical work without Tempo demanding attention. When urgency escalates, Tempo is immediately at hand. | Constant notifications or ambient urgency; quiet states are valuable. "Two clicks" is a design constraint, not the principle itself. | working |
| pp4 | Posture follows urgency, within scope  | For stories already on the user's watchlist, Tempo adjusts monitoring frequency and prominence as urgency rises or falls. Calm stories stay quiet; accelerating stories surface more.                          | Urgency expands the user's configured scope — pp2 sets the ceiling. Only frequency changes; posture is broader than refresh rate. | working |
| pp5 | Signal readiness, prepare material, never act | Tempo surfaces implications and readiness signals — not instructions. It can prepare draft material for human review. It never prescribes, sends, publishes, or acts on the user's behalf.                    | Assistance is forbidden; contextual language support and draft preparation are in scope with human approval.               | working |
| pp6 | Reactive loop, not proactive content   | Tempo addresses the monitor → respond → close loop. Proactive content creation — social posts, planned-event prep, web articles, publication scheduling — is explicitly out of scope.                         | Distributing a finalized response is out of scope; outbound push is part of the reactive loop end.                        | working |
| pp7 | Recall over precision                  | When signal confidence is uncertain or borderline, the system surfaces rather than suppresses. A missed item the user needed is worse than a surfaced item the user can dismiss.                               | Precision doesn't matter; noise is acceptable. The interface still labels confidence clearly — see design principle dp6.   | working |

---

## Changelog

| date      | change                                                                                                                          | source                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 08 Sep 26 | Added pp7 (recall over precision) from collaborative design principles session. Product layer of the recall/uncertainty debate; design expression lives in dp6. | — |
| 06 Sep 26 | Drafted pp1–pp6 from collaborative spar session. All principles `working` / low confidence pending replication with 2–3 additional participants. | [Personas](../01-research/personas.md), [Synthesis — personas and pains](../01-research/synthesis--personas-and-pains-discovery.md), [Session log](../01-research/ops/session-log.md) |
