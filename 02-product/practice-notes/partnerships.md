# Practice note: partnerships

> **Function:** `partnerships` · **Fidelity:** `partial` · **Status:** Locked (B4 F1–F3) · **Updated:** 5 Nov 2026 
> **Confidence:** 🟠 Provisional, TPI/USAID doctrine strong on internal partnership issues; “news touches a partner” is thin; no Tempo partnerships participant yet (C4) 
> **Used for:** **what comes next only** ([PR-07](../contracts/personalization.md) · [PR-14](../contracts/personalization.md)) 
> **Not SoT for:** why this matters; d05 chrome; research quotes

**Related**

- Research input: [practice-notes--research-brief.md](../practice-notes--research-brief.md) §4
- Personalization: [contract](../contracts/personalization.md) · [model PRD](../prds/model--personalization--v1.md) · [prompt](../../06-engineering/docs/prompts/personalization.md)
- Catalog: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) `practice_notes` · [principles pp5](../principles.md)
- Index: [practice-notes/README.md](./README.md)

---

## Posture

Support someone who manages relationships with partners and counterparts. Help them be ready for how a change could land with those partners. Treat partners as peers with their own interests. Decisions about outreach or commitments stay with the user.

---

## Prefer (3)

- Name which partners or stakeholders (from the user’s inputs only) this change could matter to, and why from *their* side.
- Suggest what could be prepared: context a partner may ask about, open questions to understand their view, or a note on what is still unknown.
- No-blame, joint-problem framing when the change involves a partner’s difficulty; note when a counterpart change or shift in priorities may mean the relationship needs re-grounding.

---

## Avoid (3)

- Telling the user to contact, notify, reassure, renegotiate, or commit to anything.
- Speculating about a partner’s motives or internal situation beyond the grounding; adversarial or zero-sum framing.
- Inventing partners or stakeholders not in the inputs; retelling what happened or what changed.

---

## Case families (2): situation → readiness (1:n)

Deliverability failures, HQ-vs-local gaps, and standalone power-imbalance cases are **parked for v2** (or light prefer texture only). They are not separate families in v1.

### 1. Change touches a partner’s interests / reputation

| Readiness options (non-directive) |
|-----------------------------------|
| Prepare how it may look from *their* side (inputs only) |
| List what they might ask |
| Separate knowns vs unknowns to share later |
| No-blame, joint-problem framing if the change involves a partner’s difficulty |
| Do not speculate on motives beyond grounding |

### 2. Counterpart change or shifting priorities

*Re-ground the relationship.*

| Readiness options (non-directive) |
|-----------------------------------|
| Have history and value of the partnership ready to revisit |
| Prepare questions to understand the new counterpart or new priorities |
| Note when re-grounding may be needed without prescribing outreach |
| If power/priority tension appears in inputs, flag it as something to understand jointly (no adversarial frame) |

---

## `source_refs`

Store on `practice_notes.source_refs` (not sent to the model):

| Id | URL |
|----|-----|
| `tpi-undesa-sdg-partnership-guidebook` | https://thepartneringinitiative.org/wp-content/uploads/2022/08/SDG-Partnership-Guidebook-1.0.pdf |
| `tpi-tool-7-health-check` | https://thepartneringinitiative.org/wp-content/uploads/2022/08/07-Partnership-health-check.pdf |
| `tpi-partnership-support-tools` | https://thepartneringinitiative.org/knowledge-centre/partnership-support-tools/ |
| `usaid-msi-private-sector` | https://beamexchange.org/documents/5743/2196_Multi-Stakeholder-Initiatives-With-The-Private-Sector.pdf |
| `un-bali-guiding-principles` | https://www.un.org/esa/sustdev/partnerships/bali_guiding_principles.htm |
| `aa1000ses-2015` | https://www.gresb.com/wp-content/uploads/2017/11/AA1000SES_2015.pdf |

---

## Model body (seed into `practice_notes.body`)

```text
Posture: Support someone who manages relationships with partners and counterparts. Help them be ready for how a change could land with those partners. Treat partners as peers with their own interests. Outreach and commitments stay with the user.

Prefer:
- Name which partners/stakeholders (from inputs only) this could matter to, and why from their side.
- Suggest prep: context they may ask about, open questions, or unknowns still open.
- No-blame, joint-problem framing when a partner’s difficulty is involved; note when counterpart or priority shifts may need re-grounding.

Avoid:
- Directives to contact, notify, reassure, renegotiate, or commit.
- Speculating on motives beyond grounding; adversarial or zero-sum framing.
- Inventing partners/stakeholders; retelling what happened or what changed.

Case families (pick the best fit; state one primary readiness hint):
1. Change touches a partner’s interests/reputation: prepare their-side view (inputs only); what they might ask; knowns vs unknowns; joint-problem framing if their difficulty is involved; no motive speculation beyond grounding.
2. Counterpart change or shifting priorities: history and value ready to revisit; questions to understand new counterpart/priorities; note re-grounding may be needed without prescribing outreach; flag power/priority tension in inputs as something to understand jointly.
```

---

## Decision log

| Date | Lock | Choice |
|------|------|--------|
| 5 Nov 2026 | F1 | Families 1 + 2′ (counterpart/priorities); park deliverability / HQ-local / power as v2 |
| 5 Nov 2026 | F2 | Readiness map A |
| 5 Nov 2026 | F3 | Artifact A, this file + compressed model body; 🟠 provisional |
| 5 Nov 2026 | Style | No em dashes (U+2014) in model body / seed; bump **version 2** |
