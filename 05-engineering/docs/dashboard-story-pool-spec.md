# Dashboard story pool — engineer spec (v1)

**Posture:** False-positive–first — prefer empty or thin dashboard over wrong shipped cards.

**Scope:** Post-fetch only (normalize → … → `buildStory`). Ingestion breadth/cadence out of scope.

**Rationale and chunk locks:** [Dashboard story pool walkthrough](dashboard-story-pool-walkthrough.md) (chunks **A–N**, commit map **M**).

**Ops (keys, smoke, staging):** [MODE2-SLICE-15-BETA-READINESS-CHECKLIST.md](../MODE2-SLICE-15-BETA-READINESS-CHECKLIST.md) (local) · [MODE2-SLICE-16-STAGING-HANDOFF.md](../MODE2-SLICE-16-STAGING-HANDOFF.md) (staging) — **§ Dashboard story pool (DC prototype)**.

**Scenarios / goldens:** [Dashboard story pool scenario map](dashboard-story-pool-scenario-map.md) (**L2a** — living; rows grow with failures).

---

## Vocabulary (minimal)

| Term | Meaning |
|------|---------|
| **Source item** | One normalized ingested article |
| **Candidate** | Item after ingress funnel **including dedupe**, before clustering (**B3**) |
| **Shipped story** | In API payload after **`verifyGrounding` → valid** and `buildStory` |
| **`grounding-passed`** | Funnel/analytics label = grounded valid (**J4a**) |

---

## Ingress funnel (pre-candidate)

Order in [`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs):

1. Normalize → 2. 24h → 3. Source selection → 4. Geo hold merge → 5. Geo filter → 6. Topic/keyword + embedding recall → 7. Beat-fit → 8. Dedupe → **candidates**

**Fail-closed highlights:**

| Gate | Rule |
|------|------|
| **Sources (C2)** | Zero traditional **and** zero social sources → **no items** (not “all outlets”) |
| **Geo (F)** | Non-empty geo list → filter + holds; assessor **Haiku** when wired (**F3b**) |
| **Lexical (D)** | Topics/keywords **OR** when both configured; **noop** if both empty |
| **Embedding (E)** | `hybrid_strict`: embed errors / empty profile → **E3b:** lexical-only when profile empty (after **M5**); union with lexical |
| **Beat-fit (G)** | Threshold **0.40**; strict-empty when no item passes |
| **Dedupe (H)** | Cross-feed; survivors only become candidates |

---

## Top story within meta-story (**locked: T1**)

After grounding, **`buildStory`** sorts each story’s **`sources[]`** for the API contract:

1. **`weight`** descending  
2. Tie: **`minutesAgo`** ascending (fresher first)  
3. Tie: stable `sourceId` order  

Prototype may still use `keySources()` for display; **server order is canonical** for v1. Optional `leadSourceId` can be added later if analytics need it; **`sources[0]`** is the lead under T1.

## Meta-story dashboard order (**locked: R1**)

Before persist, sort shipped **`stories[]`** server-side:

1. **Max `beatFitScore`** among the meta-story’s sources (same scores from **beat-fit-v1** at ingress)  
2. Tie: **min `minutesAgo`** (freshest source in cluster)  
3. Tie: **`metaStoryId`** (stable)  

Persisted snapshot order = display order (supports **P1** / **M3b**). Client pill filters apply **after** this order; client must **not** re-sort cards for v1.

---

## Post-candidate (aggregation + trust)

1. Cluster (**I** — Sonnet 4.6 prod SKU) → 2. Lineage IDs → 3. **`verifyGrounding` (J)** → 4. `buildStory` + **`deriveStoryTags` (K)**

### Grounding (**J1a–J3b**)

Any `groundingFailure` → **not shipped** (no salvage). Reasons: `no_valid_source_ids`, `partial_source_ids`, `ungrounded_claims`.

| Claims | Summary / subtitle |
|--------|-------------------|
| Empty `factual_claims` | Model text allowed if IDs valid (**J2a**) |
| Non-empty claims | **`factual_claims[0]` only** for summary and subtitle (**J3b**) |

### Tags (**K1a**)

`tags` = **settings ∩ source evidence** only. Tags **do not** widen pool, recall, or clustering.

---

## Models (prod SKUs — **N2**)

| Stage | Provider | Env | Primary |
|-------|----------|-----|---------|
| Onboarding extraction | Anthropic | `TEMPO_AI_CLASSIFIER_MODEL`, fallback | Opus 4.7 → Sonnet 4.6 |
| Embedding recall | **OpenAI** | `TEMPO_OPENAI_EMBEDDING_MODEL`, `TEMPO_EMBED_TOP_K`, `TEMPO_EMBED_MAX_ITEMS`, `TEMPO_RECALL_MODE` | `text-embedding-3-small`, **80**, **250**, **`hybrid_strict`** |
| Clustering | Anthropic | `TEMPO_AI_CLUSTER_MODEL` | `anthropic:claude-sonnet-4-6` |
| Geo assessor | Anthropic | injected `geoAssessFn` | `anthropic:claude-haiku-4-5-20251001` |
| Grounding / beat-fit / tags | — | — | **No LLM** |

**Keys:** `TEMPO_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`) — Anthropic stages. `TEMPO_OPENAI_API_KEY` — embeddings only.

**DC prototype:** Do **not** set `TEMPO_AI_MOCK_ONLY=true` on paths you hand-test. CI may keep mocks via env in tests.

---

## Observability

Refresh **`_meta`** (not in strict `stories` contract): `selection`, `recall`, `beatFit`, `funnel`, `watermark`; plus **`clusterModel`** / embedding model id after **M3** (**L1a**).

Console logs + `_meta` answer “why 0 stories?” — see [scenario map](dashboard-story-pool-scenario-map.md).

---

## Eval on change (**N3a**)

1. Stage **unit tests** pass (`npm run test:api`).
2. Onboarding prompt/model change → `npm run eval:onboarding-extraction`.
3. Clustering/embedding SKU change → re-check **model-sensitive** rows in scenario map; add goldens when repeat failures (**B1** — no full manifest gate in v1).

**Out of v1:** Post-grounding LLM meta-copy; **J5c** checked-in golden manifest (optional later).
