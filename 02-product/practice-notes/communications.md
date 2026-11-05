# Practice note: communications

> **Function:** `communications` · **Fidelity:** `full` · **Status:** Locked (B4 F1′–F3) · **Updated:** 5 Nov 2026 
> **Confidence:** 🟠 Low (N=1 Tempo participant; public doctrine strong) 
> **Used for:** **what comes next only** ([PR-07](../contracts/personalization.md) · [PR-14](../contracts/personalization.md)) 
> **Not SoT for:** why this matters; d05 chrome; research quotes

**Related**

- Research input: [practice-notes--research-brief.md](../practice-notes--research-brief.md) §1
- Personalization: [contract](../contracts/personalization.md) · [model PRD](../prds/model--personalization--v1.md) · [prompt](../../06-engineering/docs/prompts/personalization.md)
- Catalog: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) `practice_notes` · [principles pp5](../principles.md)

---

## Posture

Help a communications lead get *ready*, not decide what to say or when. Frame steps as material to prepare or checks to run. The user, or whoever holds clearance, decides whether anything goes out.

---

## Prefer (3)

- Readiness framing: what to have prepared (holding line, updated Q&A, internal note) given what changed.
- Accuracy and credibility over speed; flag unverified points as unverified.
- Name which audience or market a change most affects when inputs support it; if framing shifted but facts did not, prefer checking whether the current line still holds.

---

## Avoid (3)

- Directives to send, publish, post, issue, respond, or decide; never state when to release.
- Writing a finished statement as if final; retelling what happened or what changed.
- Defaulting to a public rebuttal of mis/disinformation; inventing stakeholders, deadlines, or clearance chains not in the inputs.

---

## Case families (4): situation → readiness (1:n)

Closed set for this note. Model picks the best fit from grounding; what-next states **one** primary readiness hint (soft 1–2 sentences / ~250–350 chars on d05).

### 1. Framing / narrative drift

*Incl. escalation of scope or severity when the story widens but the job is still “does our line hold?”*

| Readiness options (non-directive) |
|-----------------------------------|
| Check whether the current line still fits |
| Prepare an alternate framing for review |
| Note which audience or market the new frame hits |
| Flag if scope/severity widened enough that prior assumptions break |

### 2. Inbound or public-statement path

*Incl. clearance readiness when a statement or media response may need sign-off.*

| Readiness options (non-directive) |
|-----------------------------------|
| Have known vs unknown facts ready |
| Prepare a holding line for whoever handles media |
| Identify likely clearance or sign-off owner when inputs support it |
| Draft Q&A points for review (not a finished statement) |

### 3. Correction of own line

| Readiness options (non-directive) |
|-----------------------------------|
| Gather what was said vs what is now known |
| Prepare correction options for the right owner to choose |
| List who may need internal awareness if inputs name them (no “notify X now”) |

### 4. Mis/disinformation

| Readiness options (non-directive) |
|-----------------------------------|
| Assess impact before choosing a response posture |
| Prepare options **including not engaging** |
| Separate verified vs unverified claims |
| Avoid defaulting to a public rebuttal |

---

## `source_refs`

Store on `practice_notes.source_refs` (not sent to the model):

| Id | URL |
|----|-----|
| `cdc-cerc-manual` | https://www.cdc.gov/cerc/php/cerc-manual/ |
| `cdc-cerc-crisis-plans-2014` | https://www.cdc.gov/cerc/media/pdfs/CERC_Crisis_Communication_Plans.pdf |
| `gcs-primer` | https://www.communications.gov.uk/publication/emergency-planning-framework-primer/ |
| `gcs-resist-3` | https://www.communications.gov.uk/publications/resist-3-building-resilience-to-information-threats/ |
| `gcs-crisis-operating-model` | https://www.communications.gov.uk/publication/crisis-communications-operating-model-prepare-respond-recover/ |
| `prsa-code-of-ethics` | https://www.prsa.org/professional-development/prsa-resources/ethics |
| `state-10fam-320` | http://fam.state.gov/fam/10FAM/10FAM0320.html |

---

## Model body (seed into `practice_notes.body`)

Compressed constraint pack for the personalization user message. Prefer/avoid/families as bullets; do not paste the full 1:n tables.

```text
Posture: Help a communications lead get ready, not decide what to say or when. Frame steps as material to prepare or checks to run. Clearance holders decide whether anything goes out.

Prefer:
- Readiness framing: what to prepare (holding line, Q&A, internal note) given what changed.
- Accuracy and credibility over speed; flag unverified points as unverified.
- Name audience/market when inputs support it; if framing shifted but facts did not, check whether the current line still holds.

Avoid:
- Directives to send, publish, post, issue, respond, or decide; never state when to release.
- Writing a finished statement as if final; retelling what happened or what changed.
- Default public rebuttal of mis/disinformation; inventing stakeholders, deadlines, or clearance chains not in inputs.

Case families (pick the best fit; state one primary readiness hint):
1. Framing/narrative drift (incl. scope escalation): check whether the line still fits; prepare alternate framing for review; note audience hit; flag broken assumptions if scope widened.
2. Inbound or public-statement path (incl. clearance): known/unknown facts ready; holding line for media owner; likely sign-off owner when supported; Q&A points for review (not a finished statement).
3. Correction of own line: gather said vs now known; prepare correction options for the right owner; internal awareness list only if inputs name people (no notify-now).
4. Mis/disinformation: assess impact first; prepare options including not engaging; separate verified vs unverified; do not default to public rebuttal.
```

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 5 Nov 2026 | F1′ | Four families (merge from six): framing(+escalation), inbound/statement(+clearance), correction, mis/disinfo |
| 5 Nov 2026 | F2 | Readiness options A (2–4 per family) |
| 5 Nov 2026 | F3 | Artifact A, this file + compressed model body; `source_refs` on DB |
| 5 Nov 2026 | Style | No em dashes (U+2014) in model body / seed; bump **version 2** |
