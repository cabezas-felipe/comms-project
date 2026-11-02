# Extraction — eval / gold SoT

> **Stage:** Extraction · **Gold schema:** `extraction-gold-v1` · **Status:** Locked (Session E) · **Last updated:** 02 Nov 2026  
> **Altitude:** Eval design + locked gold (24 cases). **Advisory** until build rewires the runner. Live harness still uses legacy `extract-v8` + [onboarding-extraction.gold.json](../../apps/api/src/ai/evals/onboarding-extraction.gold.json).

**Related**

- Product contract: [extraction.md](../../../02-product/contracts/extraction.md)
- Model PRD (chip acceptance / invoke — not gold): [model--extraction--v1.md](../../../02-product/prds/model--extraction--v1.md)
- Prompt SoT: [prompts/extraction.md](../prompts/extraction.md) (`extraction-v1`)
- Pipeline: [pipelines/extraction.md](../pipelines/extraction.md)
- Locked gold: [extraction.gold.json](extraction.gold.json)
- **Build handoff:** [extraction-build-handoff.md](extraction-build-handoff.md)
- Legacy gold: [onboarding-extraction.gold.json](../../apps/api/src/ai/evals/onboarding-extraction.gold.json)
- Pattern: `06-engineering/docs/evals/{stage}.md`

---

## BUILD MUST (do not skip)

When implementing the five-lane extractor, **in the same build program**:

1. **Promote** [extraction.gold.json](extraction.gold.json) → `06-engineering/apps/api/src/ai/evals/extraction.gold.json` (runtime SoT the runner loads).
2. **Point** the new eval command at that file + `extraction-v1` prompt/models (Opus 5.5 → Sonnet 5.5 per D-073).
3. **Retire or quarantine** `onboarding-extraction.gold.json` / `eval:onboarding-extraction` so agents cannot run the wrong world by default.
4. **Score** the 24 locked cases in [extraction.gold.json](extraction.gold.json). Do not import `ex-01`–`ex-23` into that suite. Promote the file (step 1); do not leave it only under `docs/`.
5. Keep evals **advisory** until scores are trusted; then decide gating separately.

Policy stays in this doc; **executable gold lives next to the harness after promotion.**

---

## 1. Architecture (MVP)

| Layer | What | MVP? |
|-------|------|------|
| **1 — Deterministic P/R** | After normalize, set precision/recall/F1 per array field; identity string fields exact (case rules TBD in runner) | **Yes** |
| **2 — LLM judge** | Extraction quality on blurbs with no expected JSON: did the extract follow the rules? Not operator acceptance | **No** — after exact-match on the locked gold set is trusted. Own prompt SoT (`extraction-judge-v1`), model policy, calibration |
| **3 — Chip acceptance** | PostHog `extraction_chip_acceptance`: kept, removed, and added per shelf at a successful onboarding commit. Definition in the [extraction PRD](../../../02-product/prds/model--extraction--v1.md). Records what the operator kept | Specified, not instrumented |
| **4 — Retrieval utility** | North star from product contract | **Later** harness |

**MVP quality bar:** clean layer-1 gold + advisory P/R + human spot-check of multi-lane fixtures against Review chips. Not “judge proves quality.”

---

## 2. Gold grain (`extraction-gold-v1`)

Two kinds (Session E lock **C** / seed **A+**):

| `kind` | Shape | Purpose |
|--------|-------|---------|
| `unit` | One `lane` + one blurb in `blurbs` + `expected` for that lane only | Focused P/R |
| `integration` | 1–5 filled `blurbs` + full lane-keyed `expected` | Matches production one-call |

```json
{
  "id": "unit-role-01",
  "kind": "unit",
  "lane": "identity",
  "bucket": "role",
  "blurbs": {
    "identity": "I run communications for the Colombian embassy in Washington."
  },
  "function_list": ["communications", "policy", "operations", "partnerships"],
  "expected": {
    "identity": {
      "role_submitted": "",
      "organization_submitted": "Colombian embassy in Washington",
      "function_label": "communications"
    }
  },
  "rubric_notes": "No formal title was stated, so role_submitted stays empty. Do not upgrade 'I run communications' into Head of Communications. Organization stays as written."
}
```

Lane keys: `identity` | `personalPriorities` | `organizationPriorities` | `stakeholders` | `sources` (align with prompt JSON).

---

## 3. Metrics (layer 1)

- Score each **present** lane separately. Compare model output **after** pipeline hygiene ([pipelines/extraction.md](../pipelines/extraction.md) §3.1): lower+trim / structural guards only — **not** legacy `extract-v8` additive recall, noise denylists, or synonym maps. Match keys: lowercase topics / keywords / mentions / handles; identity strings after trim.
- Arrays (`topics`, `keywords`, `geographies`, `traditionalSources`, `socialSources`, `mentions`): precision / recall / F1 on those match keys. Locked gold already stores **post-normalize** forms for topics/keywords/mentions (lowercase). Geographies and press keep display forms from the prompt SoT (`Bogotá`, `The New York Times`); score case-insensitively on the match key.
- Identity strings: exact match after trim. `role_submitted` is English title case when present (or `""` when omit). `organization_submitted` as written. `function_label` lowercase. Identity cases pass that case’s `function_list` into the prompt (same as production).
- Macro-average across fields in the fixture; report per-lane and overall.
- Still **advisory** — does not gate release until explicitly promoted.
- **Not scored here:** PostHog `extraction_chip_acceptance` / `extraction_invoke` (product analytics in the model PRD).

---

## 4. Locked suite

See [extraction.gold.json](extraction.gold.json). Wrapper: `schemaVersion: extraction-gold-v1`, `promptVersion: extraction-v1`, `examples` (24). The September draft examples were removed. All 24 replacement cases are locked.

| `kind` | Count | Id prefix |
|--------|------:|-----------|
| `unit` | 18 | `unit-*` |
| `integration` | 6 | `int-*` (includes `int-lane-separation-*`, formerly mis-prefixed `unit-lane-separation-*`) |

---

## 5. Legacy inventory (`onboarding-extraction.gold.json`) — history

These rows are the single-blob `extract-v8` set. They are not the work list. The suite to score is the 24 locked cases in [extraction.gold.json](extraction.gold.json). The Disposition column is the September plan, not a current build order. The table stays as an audit trail. Do not import these rows into the new suite.

| Legacy id | Bucket | Disposition | Notes |
|-----------|--------|-------------|-------|
| ex-01 | clean_explicit | **split** | → identity-ish + personalPriorities + sources |
| ex-02 | clean_explicit | **split** | energy / sanctions / sources |
| ex-03 | clean_explicit | **split** | DHS keyword vs @DHSgov — align with ex-14 |
| ex-04 | clean_explicit | **split** | WHO from @WHO — conflicts with ex-15/ex-20 |
| ex-05 | clean_explicit | **split** | customs / DIAN / trade |
| ex-06 | implicit_ambiguous | **split** | omits keyword `migration` though text says migration — **fix expectation** |
| ex-07 | implicit_ambiguous | **split** | |
| ex-08 | implicit_ambiguous | **split** | empty topics; diplomacy keyword |
| ex-09 | implicit_ambiguous | **split** | |
| ex-10 | implicit_ambiguous | **split** | public health keyword vs ex-15 |
| ex-11 | noisy_long | **split** | |
| ex-12 | noisy_long | **split** | |
| ex-13 | noisy_long | **split** | |
| ex-14 | noisy_long | **defer** | DHS from handle — contradicts ex-03 |
| ex-15 | noisy_long | **defer** | WHO keyword rules vs ex-04/ex-20 |
| ex-16 | edge_negative | **keep→unit** | empty extract / thin blurb |
| ex-17 | edge_negative | **split** | sources-only |
| ex-18 | edge_negative | **split** | dedupe NYT / @StateDept |
| ex-19 | edge_negative | **split** | Elections canonicalization |
| ex-20 | edge_negative | **defer** | WHO contradiction cluster |
| ex-21 | spanish_sources | **split** | ES → EN topics/keywords |
| ex-22 | spanish_sources | **split** | |
| ex-23 | spanish_sources | **split** | |

**Contradiction cluster (not imported):** ex-03/ex-14 (DHS); ex-04/ex-15/ex-20 (WHO); ex-06 (`migration` keyword); ex-10/ex-15 (`public health`). These were not carried into the 24 locked cases. Do not reopen them from this table.

---

## 6. Future: LLM judge

Not MVP. When built, it scores whether an extract followed the extraction rules on blurbs that have no expected JSON. It does not score whether the operator would keep the chip. That guardrail is PostHog `extraction_chip_acceptance`. It waits until exact-match on the locked gold set is trusted. Separate SoT (e.g. `docs/prompts/extraction-judge.md`, `extraction-judge-v1`), cheaper model, calibration set, scores linked by `run_id` — **not** a column on `extraction_runs` v1.

---

## Decision log (Session E)

| Date | Lock | Choice |
|------|------|--------|
| 28 Sep 2026 | Grain | Unit + integration gold |
| 28 Sep 2026 | Paths | Draft under `docs/evals/`; **promote to apps/api at build (MUST)** |
| 28 Sep 2026 | Seed | A+ core + full legacy inventory |
| 28 Sep 2026 | Metrics | Deterministic P/R MVP; judge later |
| 24 Oct 2026 | Chip acceptance vs judge | Chip acceptance is PostHog `extraction_chip_acceptance`. The definition stays in the extraction PRD. Gold does not measure it. A future judge scores rule-following on unlabeled blurbs and does not score operator acceptance. |
| 24 Oct 2026 | Seed | The locked suite is the 24 cases in extraction.gold.json. The `ex-01`–`ex-23` inventory is history, not build work. |
| 02 Nov 2026 | Scoring | Gold arrays are post-normalize match keys; score after hygiene. Identity case rules explicit. |
| 2 Nov 2026 | Carry-over scoring | Score after pipeline §3.1 hygiene-only — not legacy `extract-v8` sanitizer |
| 02 Nov 2026 | Ids | Rename `unit-lane-separation-*` → `int-lane-separation-*` so id prefix matches `kind: integration`. Expected JSON unchanged. |
