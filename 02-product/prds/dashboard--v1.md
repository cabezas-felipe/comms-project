# Dashboard — monitoring feed and open metastory

Give a solo operator a scoped feed of metastories and an open view (what happened, what changed, why this matters, what comes next, sources) on desktop web and iOS native.

Status: Draft  
Owner: Felipe  
Update: 28 Oct 26  
Intent: ship  
Execution spec: waived by PM until Solution walk locks against Paper

**Stub.** Behavior locks and UX walk come next. Do not invent screens or copy here. Formula weights stay out until a later lock.

**Owns (product)**

- Feed list and open metastory UX (Paper d01+ / d08 family)
- **Join** → **feed membership**: which shared metastories appear in *this* user’s feed (**source ∧ ≥1 of their chips**)
- Product meaning of rising / stable / falling, source order in the rail, and feed order (formulas documented later; linked from here)
- Cutover: last-good feed until the shared **60‑min clock** (unchanged sign-in); warm UX hooks when scope widens ([ingestion IR-09/IR-10](../contracts/ingestion.md)); flags; empty states
- Chip **chrome** on the open metastory (which of the user’s chips apply) — not story-chip tagging

**Does not own**

- Shared fetch, drains, keep-list, compliance, clock/warm jobs → [ingestion.md](../contracts/ingestion.md) (locked)
- Story-chip apply → [story-tagging.md](../contracts/story-tagging.md) (locked) · [model--story-tagging--v1.md](./model--story-tagging--v1.md) (invoked via ingestion IR-08)
- Article-summary **generation** → [summarization.md](../contracts/summarization.md) (locked); source-reader **display** of that snippet is owned here
- Shared metastory id + copy (incl. clustering); story↔metastory membership → [metastory.md](../contracts/metastory.md) (locked) · [model--metastory--v1.md](./model--metastory--v1.md)
- Why this matters / what comes next generation → [personalization.md](../contracts/personalization.md) (locked) · [model--personalization--v1.md](./model--personalization--v1.md)
- Scope blurbs → user chips → [extraction.md](../contracts/extraction.md) (locked) · [model--extraction--v1.md](./model--extraction--v1.md)

**Related**

- Strategy: [Tempo strategy](../strategy/tempo.md)
- Principles: [principles.md](../principles.md) (esp. pp2, pp5, pp7)
- Pattern: [metastory-open](../../03-design/design-system/patterns/metastory-open.md) · [narrative-row](../../03-design/design-system/components/narrative-row.md) · [source-reader](../../03-design/design-system/patterns/source-reader.md)
- Onboarding (sibling): [onboarding--v1.md](./onboarding--v1.md)
- Account (sibling): [account--v1.md](./account--v1.md)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Monitoring narrative shifts while drafting forces constant self-interruption; the operator needs one scoped place that shows what moved and why it matters for their beat — without Tempo prescribing send/publish.

**Why now:** Extraction → scope is landing; the monitoring bet needs a product surface SoT separate from onboarding/account.

**Gaps:** Monitoring stage contracts are locked ([ingestion](../contracts/ingestion.md) · [summarization](../contracts/summarization.md) · [story-tagging](../contracts/story-tagging.md) · [metastory](../contracts/metastory.md) · [personalization](../contracts/personalization.md)); Paper walk for dashboard not yet mirrored here. `PM input required` for formal success metrics.

---

## Goals

- Operator with confirmed scope sees a feed of metastories that match their sources and chips.
- Open metastory exposes shared copy plus per-user why / what next without violating pp5.
- Guardrails: user scope is the ceiling (pp2); never prescribe send/publish (pp5); prefer recall over precision in admission (pp7) without inventing chips.

---

## Solution

### Overview

Stub. Feed = **feed membership** (user ↔ metastory) after **join** (source ∧ ≥1 chip) over shared metastories — UI lists only members with personalization present (`personalized_at`; never blank why/next). Open view = Paper metastory-open (d08 family): shared title / subtitle / what happened / what changed + per-user why / what comes next. Source rail opens the [source reader](../../03-design/design-system/patterns/source-reader.md): press snippet = **article summary** when present (labeled as Tempo’s summary — not the article); X = post text; **Open original** at end of path. No summary → title + meta + Open original only.

### Scope

**In:** Feed UX, open metastory UX, join → feed membership, product meaning of rank pills and orders, cutover UX (last-good until clock; warm hooks).  
**Out:** Vendor matrices; LLM prompts; frozen formula math (link out when written); extraction Review; story-chip tagging; article-summary generation.

### Source order inside a metastory (proposal — not locked)

Stub proposal for the later frozen score. Same evidence → same order. High-impact / low-tier can beat low-impact / high-tier. No ingredient is a veto.

For how much this reporting matters, prefer signals Tempo already owns or already pulls:

- original vs follow-on  
- vendor `includeSourceRanking` (already `in` on NewsAPI.ai)  
- freshness  
- corroboration = distinct outlets already on the metastory  

Each item’s own article/post **URL** is for Open original / source reader — not a rank signal. NewsAPI `includeArticleLinks` stays `out` (outbound URLs in the body, not inbound citation count).

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Stub PRD created; Execution waived | Align artifact map before Solution walk | 27 Oct 26 | Contracts drafted + Paper walk |
| Feed/join rules live here | UX ownership; not a model PRD | 27 Oct 26 | Contract split if PRD fattens |
| Formulas’ *meaning* here; math later in eng docs | Frozen scores are product behavior, not live models | 27 Oct 26 | First formula lock |
| Source-order ingredients proposed (original, vendor rank, freshness, corroboration); `includeArticleLinks` not used | Prefer owned/pulled signals; flag is outbound links, not inbound count | 27 Oct 26 | Formula lock / eval fails |
| A2 coherence | Join = source ∧ ≥1 chip; feed membership term; clock/warm/last-good aligned to ingestion; contracts locked pointers | 27 Oct 26 | Contract rename |
| Source-reader snippet = article summary | NewsAPI has no excerpt; operators need in-app scan; disclosure + Open original ([D-076](../../06-engineering/DECISIONS.md)) | 28 Oct 26 | Paper d08 copy / counsel |
| A2′ (story-tagging in set) | Gaps list includes story-tagging; article-summary gen vs source-reader display ownership; join/source-order wording unchanged | 28 Oct 26 | Contract rename |

**Next (not blocking on contracts):** Solution walk vs Paper (d08 disclosure copy); formula locks later.
