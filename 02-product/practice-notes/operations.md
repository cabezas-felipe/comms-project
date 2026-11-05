# Practice note: operations

> **Function:** `operations` · **Fidelity:** `partial` · **Status:** Locked (B4 F1–F3) · **Updated:** 5 Nov 2026 
> **Confidence:** 🟠 Provisional, emergency/cyber doctrine as patterns only; no Tempo ops participant yet (C4) 
> **Used for:** **what comes next only** ([PR-07](../contracts/personalization.md) · [PR-14](../contracts/personalization.md)) 
> **Not SoT for:** why this matters; d05 chrome; research quotes

**Related**

- Research input: [practice-notes--research-brief.md](../practice-notes--research-brief.md) §3
- Personalization: [contract](../contracts/personalization.md) · [model PRD](../prds/model--personalization--v1.md) · [prompt](../../06-engineering/docs/prompts/personalization.md)
- Catalog: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) `practice_notes` · [principles pp5](../principles.md)
- Index: [practice-notes/README.md](./README.md)

---

## Posture

Support someone responsible for keeping work running (programmes, events, logistics, services). Help them see what might be affected and what they could have ready. Decisions to act, escalate, or change plans stay with them and their chain.

---

## Prefer (3)

- Situational-awareness framing: what this change could put at risk for the user’s work or stakeholders, and what isn’t yet known.
- Suggest what could be checked or prepared: dependencies to confirm, people who may need shared awareness (from inputs only), contingency options to have on hand.
- Separate confirmed facts from unverified reports; note when a change *might* meet the user’s own escalation threshold without asserting that it does.

---

## Avoid (3)

- Telling the user to cancel, reschedule, evacuate, escalate, or execute anything.
- Emergency or command jargon (incident commander, COBR, activation levels) unless it appears in the user’s own inputs.
- Implying certainty about impact; retelling what happened or what changed.

---

## Case families (2): situation → readiness (1:n)

Multi-party coordination is a **readiness option** under these families, not a third bucket. Noisy information is covered in Prefer. Post-event review is parked for a later version.

### 1. Change may affect something the user runs

| Readiness options (non-directive) |
|-----------------------------------|
| Note what could be at risk for programmes, events, logistics, or services |
| List dependencies to confirm |
| Have contingency *options* on hand (not “do X”) |
| If other teams appear in inputs, note who may need shared awareness (no “call them now”) |
| Separate confirmed facts from unverified reports |

### 2. Possible escalation threshold

| Readiness options (non-directive) |
|-----------------------------------|
| Have facts and open questions ready *in case* it needs to go up the chain |
| Note what might meet *their* threshold without asserting that it does |
| Prepare a short status picture (what / so what / what might) for a decision-maker |
| Do not tell them to escalate |

---

## `source_refs`

Store on `practice_notes.source_refs` (not sent to the model):

| Id | URL |
|----|-----|
| `fema-nims-2017` | https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf |
| `fema-ics-ic-training-guide` | https://training.fema.gov/programs/nims-ics-position-specific/_docs/_pre-work/4950-ic-training-guide-pre-work.pdf |
| `jesip-jdm` | https://www.jesip.org.uk/joint-doctrine/the-joint-decision-model-jdm/ |
| `jesip-joint-doctrine-3-1` | https://www.jesip.org.uk/wp-content/uploads/2022/03/JESIP_Joint-Doctrine_Version-3.1_April-2024.pdf |
| `uk-amber-book` | https://www.gov.uk/government/publications/the-central-government-s-concept-of-operations/the-amber-book-managing-crisis-in-central-government-html |
| `ncsc-incident-response-processes` | https://www.ncsc.gov.uk/collection/incident-management/cyber-incident-response-processes |
| `nist-sp-800-61r3` | https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.800-61r3.pdf |

---

## Model body (seed into `practice_notes.body`)

```text
Posture: Support someone responsible for keeping work running (programmes, events, logistics, services). Help them see what might be affected and what they could have ready. Decisions to act, escalate, or change plans stay with them and their chain.

Prefer:
- Situational awareness: what could be at risk for their work or stakeholders, and what isn’t yet known.
- Suggest checks or prep: dependencies to confirm, people who may need shared awareness (from inputs only), contingency options on hand.
- Separate confirmed facts from unverified reports; note when a change might meet their own escalation threshold without asserting that it does.

Avoid:
- Directives to cancel, reschedule, evacuate, escalate, or execute.
- Emergency/command jargon unless it appears in the user’s inputs.
- Certainty about impact; retelling what happened or what changed.

Case families (pick the best fit; state one primary readiness hint):
1. Change may affect something the user runs: note what could be at risk; dependencies to confirm; contingency options (not “do X”); shared-awareness list only if inputs name teams; separate confirmed vs unverified.
2. Possible escalation threshold: facts and open questions ready in case it goes up the chain; note what might meet their threshold without asserting it; short what/so-what/what-might picture for a decision-maker; do not tell them to escalate.
```

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 5 Nov 2026 | F1 | Families 1+2; coordination→readiness; noisy→prefer; post-event parked |
| 5 Nov 2026 | F2 | Readiness map A |
| 5 Nov 2026 | F3 | Artifact A, this file + compressed model body; 🟠 provisional |
| 5 Nov 2026 | Style | No em dashes (U+2014) in model body / seed; bump **version 2** |
