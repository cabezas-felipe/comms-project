# Dashboard story pool — scenario map (L2a)

**Living doc** — trace operator symptoms → logs / `_meta` → tests → (optional) golden eval. Rows may be added incrementally (**B1**).

**Spec:** [Dashboard story pool spec](dashboard-story-pool-spec.md) · **Design:** [Walkthrough](dashboard-story-pool-walkthrough.md) (chunks **J5a**, **L2a**).

**Eval runners today:** [Onboarding extraction and cluster smoke](../apps/api/src/ai/evals/README.md). Pool stages still rely primarily on **unit tests** until repeat failures justify new gold files.

---

## Grounding (**J5a** G1–G5)

| ID | Scenario | User / ops symptom | Log / `_meta` | Test (today) | Golden runner |
|----|----------|-------------------|---------------|--------------|---------------|
| **G1** | All `source_item_ids` hallucinated | Story missing; count in drops | `groundingDropReasons.no_valid_source_ids` | `cluster-engine.test.mjs` — hallucinated IDs | — |
| **G2** | Partial invalid IDs | Story missing | `partial_source_ids` | `cluster-engine.test.mjs` | — |
| **G3** | Ungrounded claim | Story missing | `ungrounded_claims` | `cluster-engine.test.mjs` | — |
| **G4** | Empty claims, valid IDs | May ship; model summary if allowed | `grounding-passed` | `cluster-engine.test.mjs` | — |
| **G5** | Claims present → summary = claim[0] only | No extra prose in card | — | J3b tests in `cluster-engine.test.mjs` | — |

---

## Funnel / recall / selection (initial rows)

| ID | Scenario | User symptom | Log / `_meta` | Test | Model-sensitive (**N2**) |
|----|----------|--------------|---------------|------|--------------------------|
| **C2-0** | Zero configured sources | Empty dashboard immediately | `selection` / early funnel | `refresh-pipeline.test.mjs` (after **M6**) | — |
| **E-lex** | Empty profile, lexical only | Thin but non-empty possible | `recall.degraded_reason` → `empty_profile_text_lexical_only` (after **M5**) | `embedding-recall.test.mjs` | — |
| **E-fail** | Embed API error | Thin / empty | `embedding_api_error` fail-closed | `embedding-recall.test.mjs` | OpenAI embed SKU |
| **F-hold** | Geo implicit / conflict | Item deferred, not candidate | geo hold bucket | `geo-filter.test.mjs` | Haiku assessor (**M4**) |
| **G-empty** | Beat-fit strict empty | No candidates | `beatFit.strictEmpty` | pipeline / beat-fit tests | — |
| **I-fallback** | Cluster LLM throw | Heuristic clusters or empty cluster path | funnel / cluster logs | `cluster-engine.test.mjs` | Sonnet SKU (**M2**) |

*Add rows when DC or staging surfaces a repeatable miss.*

---

## When to add a golden eval

**B1:** Do **not** block ship on a full pool golden manifest. Add a checked-in gold + runner when:

- The same failure repeats in manual DC sessions, **or**
- A prompt/SKU change regresses a row marked **model-sensitive** above.

Onboarding pattern: [`onboarding-extraction.gold.json`](../apps/api/src/ai/evals/onboarding-extraction.gold.json).

---

## M7 real-mode verification run (2026-05-15)

This run re-checked the post-M6b gate after aligning docs, env, and model routing for real providers.

| Gate item | Result | Evidence |
|---|---|---|
| `GET /api/ingestion/sources` | **PASS** | HTTP 200 with declared feed catalog returned |
| `GET /api/ai/models` | **PASS** | HTTP 200; `mockOnly: false`; clustering routed to `anthropic:claude-sonnet-4-6` |
| Authenticated `POST /api/dashboard/refresh` | **PASS** | HTTP 200; `_meta` includes `funnel`, `clusterModel`, `embeddingModel` |
| Authenticated `GET /api/dashboard` | **PASS** | HTTP 200; `_meta` includes persisted `funnel`, `recall`, `beatFit`, `clusterModel`, `embeddingModel` |
| T1 runtime check (`story.sources[]`) | **PASS** | First story source order satisfied (weight desc, freshness asc tie-break) |
| R1 runtime check (`stories[]`) | **PARTIAL** | Live payload had one story only; multi-story rank path not exercised in runtime output |
| `npm run test:api` | **PASS** | `778` pass, `0` fail, `1` skipped (post-M8) |
| `npm run eval:onboarding-extraction` | **PASS** | Exact-match `70.0%` (`14/20`) meets target |
| `npm run eval:cluster-smoke` | **PASS** | Contract-shape smoke passes in both real-model and forced-mock checks |

### M8 gate status

- **M8 completed:** durable cluster-shape smoke harness is in place (`eval:cluster-smoke`) with side-effect-free core + guarded CLI runner.
- R1/R2/R3 runtime readiness checks remain green for story-pool paths.
