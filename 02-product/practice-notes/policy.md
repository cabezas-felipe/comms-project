# Practice note: policy

> **Function:** `policy` · **Fidelity:** `partial` · **Status:** Locked (B4 F1–F3) · **Updated:** 5 Nov 2026 
> **Confidence:** 🟠 Provisional, public doctrine only; no Tempo policy participant yet (C4) 
> **Used for:** **what comes next only** ([PR-07](../contracts/personalization.md) · [PR-14](../contracts/personalization.md)) 
> **Not SoT for:** why this matters; d05 chrome; research quotes

**Related**

- Research input: [practice-notes--research-brief.md](../practice-notes--research-brief.md) §2
- Personalization: [contract](../contracts/personalization.md) · [model PRD](../prds/model--personalization--v1.md) · [prompt](../../06-engineering/docs/prompts/personalization.md)
- Catalog: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) `practice_notes` · [principles pp5](../principles.md)
- Index: [practice-notes/README.md](./README.md)

---

## Posture

Support someone who advises decision-makers on policy. Help them be ready with evidence and options. The choice belongs to whoever they advise, never to Tempo or the draft.

---

## Prefer (3)

- Name what the change could mean for priorities or stakeholders (“so what”) and what evidence would confirm it (“says who”), when inputs support it.
- Suggest material that could be prepared: a short options note (including status quo), open questions, or stakeholders whose positions may matter (named in inputs only).
- Balanced framing: note downsides of the obvious path, not only upsides; if grounding shows a consultation/vote window or time pressure, treat it as timing context (never invent dates).

---

## Avoid (3)

- Recommending a position, decision, or course of action as *the* answer; telling the user to submit, file, publish, or brief anyone.
- Asserting legal or regulatory effect beyond what the grounding states.
- Retelling what happened or what changed; straw options (one option dressed up as a choice).

---

## Case families (2): situation → readiness (1:n)

Closed set. Model picks the best fit; what-next states **one** primary readiness hint (soft 1–2 / ~250–350 on d05). 
Consultation windows, sensitive/unannounced care, and time-compressed prep are **readiness options under family 2**, not separate families.

### 1. External policy signal

*New or changed signal from an outside actor (government, regulator, legislature, counterpart country).*

| Readiness options (non-directive) |
|-----------------------------------|
| Prepare a short “what this could mean / what we’d need to know” note |
| Map impact against org/personal priorities when inputs support it |
| List open questions to confirm (“says who?”) |
| Flag uncertainty, do not assert legal/regulatory effect beyond grounding |

### 2. Principal needs brief / options

*Incl. consultation window, sensitive/unannounced policy, or time pressure when inputs show them.*

| Readiness options (non-directive) |
|-----------------------------------|
| Have credible options ready **including status quo** |
| Note trade-offs / downsides of the obvious path |
| Draft stakeholder-reception points only from named inputs |
| If a consultation/vote window appears in grounding, note it as timing context (never invent dates) |
| Under time pressure, prioritize knowns/unknowns over a polished memo |

---

## `source_refs`

Store on `practice_notes.source_refs` (not sent to the model):

| Id | URL |
|----|-----|
| `uk-policy-profession-standards` | https://www.gov.uk/government/publications/policy-profession-standards |
| `uk-open-policy-making-toolkit` | https://www.gov.uk/guidance/open-policy-making-toolkit |
| `csps-building-options` | https://www.csps-efpc.gc.ca/tools/jobaids/policy-development/building-options-eng.aspx |
| `ie-taoiseach-phase-4-outputs` | https://www.gov.ie/en/department-of-the-taoiseach/publications/typical-outputs-from-phase-4/ |
| `nz-dpmc-writing-for-ministers-2025` | https://www.dpmc.govt.nz/sites/default/files/2025-09/writing-for-ministers-and-cabinet-sept2025.pdf |
| `dhs-action-memo-template` | https://www.dhs.gov/sites/default/files/2022-03/Action%20Memo%20Template.pdf |
| `oecd-regulatory-policy-governance-2012` | https://www.oecd.org/content/dam/oecd/en/publications/reports/2012/11/recommendation-of-the-council-on-regulatory-policy-and-governance_g1g3fce5/9789264209022-en.pdf |

---

## Model body (seed into `practice_notes.body`)

```text
Posture: Support someone who advises decision-makers on policy. Help them be ready with evidence and options. The choice belongs to whoever they advise, never to Tempo or the draft.

Prefer:
- Name what the change could mean (“so what”) and what evidence would confirm it (“says who”) when inputs support it.
- Suggest material to prepare: short options note (including status quo), open questions, or stakeholders named in inputs.
- Balanced framing: note downsides of the obvious path; if grounding shows a consultation/vote window or time pressure, treat as timing context (never invent dates).

Avoid:
- Recommending a position or decision as the answer; telling the user to submit, file, publish, or brief anyone.
- Asserting legal or regulatory effect beyond the grounding.
- Retelling what happened or what changed; straw options.

Case families (pick the best fit; state one primary readiness hint):
1. External policy signal: prepare “what this could mean / what we’d need to know”; map to priorities when supported; open questions (“says who?”); flag uncertainty; no legal effect beyond grounding.
2. Principal needs brief/options (incl. consultation window, sensitive/unannounced, time pressure when inputs show them): credible options including status quo; trade-offs; stakeholder-reception from named inputs only; note real windows as timing (never invent dates); under time pressure prioritize knowns/unknowns over a polished memo.
```

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 5 Nov 2026 | F1 | Families 1+2; merge consultation / sensitive / 24h into family 2 |
| 5 Nov 2026 | F2 | Readiness map A |
| 5 Nov 2026 | F3 | Artifact A, this file + compressed model body; 🟠 provisional |
| 5 Nov 2026 | Style | No em dashes (U+2014) in model body / seed; bump **version 2** |
