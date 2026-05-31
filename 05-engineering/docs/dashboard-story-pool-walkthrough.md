# Dashboard story pool — walkthrough and locked chunks

Living document for the **first-principles** walkthrough: post-fetch **ranking, filtering, clustering** only; **false-positive–first** v1. Chunks **A–L**, **N**, **M** follow the agreed plan. Update this file as each chunk is locked.

**Code anchors (implementation reference, not the spec):**

- [Orchestration](../apps/api/src/dashboard/refresh-pipeline.mjs)
- [Embedding recall](../apps/api/src/ingestion/embedding-recall.mjs)
- [Beat-fit](../apps/api/src/dashboard/beat-fit-scorer.mjs)
- [Geo filter](../apps/api/src/dashboard/geo-filter.mjs)
- [Cross-feed dedupe](../apps/api/src/ingestion/source-deduper.mjs)
- [Source matcher](../apps/api/src/ingestion/source-matcher.mjs)
- [Clustering / grounding](../apps/api/src/ai/cluster-engine.mjs)

---

## Locked constraints (session)

| Constraint | Choice |
|------------|--------|
| Scope | Post-fetch only — no ingestion breadth/cadence in this walkthrough |
| Posture | **Fewer false positives** — accept false negatives and empty/thin dashboard over wrong cards |
| Zero configured sources | **C2 fail-closed** — no items proceed down the funnel until the user selects at least one source (or an explicit future “use defaults” product path). Implemented in [`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs) (M6); both the legacy `selectSourcePool` and the manifest path enforce this gate. |
| Code | Prior pipeline is a **catalog of decisions**, re-validated chunk by chunk |

---

## Chunk status

| Chunk | Topic | Status |
|-------|--------|--------|
| **A** | Vocabulary; FP/FN by layer | **Locked** — see below |
| **B** | Candidate pool v0 boundary | **Locked** — see below |
| **C** | User dimensions: gate vs score vs label | **Locked** — see below |
| **D** | Lexical recall contract | **Locked** — see below |
| **E** | Semantic / embedding policy + SKU | **Locked** — see below |
| **F** | Geo contract | **Locked** — see below |
| **G** | Precision layer (beat-fit or successor) | **Locked** — see below |
| **H** | Dedupe policy | **Locked** — see below |
| **I** | Clustering contract + cluster SKU | **Locked** — see below |
| **J** | Grounding trust gates + ship-ready + golden hooks | **Locked** — see below |
| **K** | Tags vs pool (one-way) | **Locked** — see below |
| **L** | Observability, scenarios, golden suites | **Locked** — see below |
| **N** | Model matrix + eval gate | **Locked** — see below |
| **M** | Commit map (after design lock) | **Locked** — **M1b** real-first; see below |

---

## Chunk A — Vocabulary and FP/FN (LOCKED)

### Ordered stages (server funnel)

1. **Source item** — One normalized ingested article; atomic **evidence**.
2. **Candidate** — Source item that passed **all pre-clustering** gates (time, sources, geo, recall, precision, dedupe, etc.) and **may** enter clustering.
3. **Cluster** — The **clustering step**: invoking the clusterer over candidates.
4. **Cluster output** — **Parsed** clustering result: proposed `source_item_ids` groupings and draft model fields, before identity is final for downstream trust checks.
5. **Meta-story (pre-ship)** — Narrative unit **after** identity work (**`meta_story_id`** / lineage). **In the pipeline, not** in the client-facing payload — **Option A:** includes units that **fail grounding** and are never shipped (no separate required glossary term for “rejected”).
6. **Shipped story** — Passed mandatory trust gates (e.g. grounding), emitted in API/dashboard payload; tags = **settings ∩ source evidence** (**Chunk K — K1a**).

**(Chunk J — J4a — locked)** The conversion-metrics label at the grounding boundary is **`grounding-passed`**: membership in **`verifyGrounding` → `valid`**. **`ship-ready (grounding)`** is an acceptable **synonym** in prose and logs. This names a **checkpoint for analytics**, not an extra mandatory pipeline stage. **Beat-fit, geo, and dedupe** run **before** clustering in v1; there is **no** server trust gate between **`grounding-passed`** and **`buildStory`** → payload today. If a future **post-grounding** gate is added, **`shipped story`** may become a **narrower** set than **`grounding-passed`** without renaming **J4a**.

**Out of vocabulary:** Client-only trend / H1 behavior is **not** a server stage; derived from **shipped stories** or empty state.

### FP / FN by layer

- **Candidate:** FP = wrong item kept; FN = right item dropped.
- **Cluster output:** FP = bad merge/split in model proposal; FN = missed grouping opportunity.
- **Meta-story (pre-ship):** FP = wrong unit with id or wrong narrative before rejection; FN = correct unit never got id or wrongly rejected.
- **Shipped story:** FP = user sees wrong/misleading card (primary reputational risk); FN = user misses a useful card.

Under FP-first v1 we accept **more shipped-story FN than FP**.

### Spec blurb (paste-friendly)

> **Precision vocabulary (v1):** A **source item** is one normalized ingested article. A **candidate** is a source item that has passed all **pre-clustering** gates (including dedupe) and may enter clustering. **Cluster** names the **clustering step** (the clusterer invocation over candidates). **Cluster output** is the **parsed** clustering result: proposed `source_item_ids` groupings and draft model fields, before we treat the unit as stable for downstream trust checks. A **meta-story (pre-ship)** is a narrative unit **after** identity work (**`meta_story_id`** / lineage): it is **in our pipeline but not yet** in the client-facing payload — **including** units that **fail grounding** and are never shipped. **`grounding-passed`** (**`ship-ready (grounding)`** — synonym) means membership in **`verifyGrounding` → `valid`** and is the funnel label for **conversion** metrics at the grounding boundary (**Chunk J — J4a**). A **shipped story** is a unit that **passed** those gates and is emitted in the API payload for the dashboard (with tags from **settings ∩ source evidence** — **`deriveStoryTags`**, **Chunk K — K1a**). **False positive** primarily means a **wrong or misleading shipped story**; we use **candidate**, **cluster output**, and **merge** language when debugging upstream causes. **False negative** means a relevant item or narrative **not shipped**; under FP-first v1 we accept more false negatives than false positives. **Client-only** presentation (e.g. trend copy from activity scores) is **not** a server funnel stage; it is derived from **shipped stories** or empty state.

---

## Chunk B — Candidate pool v0 boundary (LOCKED — **B3**)

**Locked decision:** **B3** — The **candidate** set (pool v0 for ranking/filtering/clustering language) is the set of source items **after cross-feed dedupe** and **immediately before clustering**. This matches **Chunk A**’s definition of **candidate** and the clustering input in [refresh-pipeline.mjs](../apps/api/src/dashboard/refresh-pipeline.mjs).

### Ingress funnel (not yet candidates)

Stages **before** dedupe constitute the **ingress funnel** into candidates: normalize → 24h → source selection → geo hold merge → geo filter → topic/keyword + embedding recall → beat-fit → **dedupe**. Anything dropped along this path is **not** a candidate this run.

**Re-entry:** Items can re-enter the ingress funnel from the **geo hold** bucket on a later refresh; they become **candidates** only if they survive the full ingress funnel **including dedupe** on that run.

### After candidates

**Clustering onward** = **aggregation and trust** (cluster → lineage → grounding → `buildStory`), not “expanding the candidate pool.”

### Implementation order (reference)

From [refresh-pipeline.mjs](../apps/api/src/dashboard/refresh-pipeline.mjs) (post-fetch batch):

1. Normalize raw items  
2. 24h window  
3. Source selection (manifest matcher or legacy outlet pool)  
4. Merge prior **geo hold** bucket (re-evaluation)  
5. Geo filter (+ new holds)  
6. Topic/keyword recall + embedding recall union  
7. Beat-fit precision filter  
8. Cross-feed dedupe → **candidate set (B3)**  
9. Watermark check → optional skip of cluster/ground  
10. Cluster → lineage IDs → grounding → `buildStory`

### Options considered (archive)

| Option | First pool boundary |
|--------|---------------------|
| **B1** | After normalize |
| **B2** | After 24h + source selection |
| **B3** | After dedupe, before clustering — **chosen** |

---

## Chunk C — User dimensions: gate, score, recall, label (LOCKED)

**Goal:** For each user-settings dimension, classify **gate**, **score**, **recall profile**, **label-only**, or unused — see definitions in the archived walkthrough notes (same as prior draft).

**Definitions (vocabulary):**

- **Gate** — Binary (or tri-state with hold) filter on **source items** before the **candidate** set (Chunk **B3**). If you fail, you are **not** a candidate this run (unless a defined re-entry path applies, e.g. geo hold).
- **Score** — Numeric contribution to a **precision** threshold (e.g. beat-fit) on items already in the recall pool.
- **Recall profile** — Text composed from settings to steer **semantic recall**; does **not** by itself define a shipped story; must still pass gates + scores downstream.
- **Label-only** — Affects **shipped** `tags` only via **settings ∩ evidence** ([`deriveStoryTags`](../apps/api/src/dashboard/refresh-pipeline.mjs)); never admits an item.

### Locked table (FP-first v1)

| Dimension | Gate | Score | Recall profile | Label-only | Notes |
|-----------|------|-------|------------------|------------|--------|
| **Traditional + social sources** | **Yes** | — | — | — | **C2:** If the user has **zero** configured sources, **fail-closed** — no items enter relevance/clustering until sources are configured (or a future explicit “defaults” product flag exists). |
| **Geographies** | **Yes** when list non-empty ([`applyGeoFilter`](../apps/api/src/dashboard/geo-filter.mjs)); **no gate** when empty | **Yes** (beat-fit) | — | **Yes** (shipped tags) | Stricter geo behavior in **F**. |
| **Topics** | **Yes** at lexical recall (see **D**); **noop** if both topics and keywords empty | **Yes** ([`scoreBeatFit`](../apps/api/src/dashboard/beat-fit-scorer.mjs)) | Via profile text ([`buildProfileText`](../apps/api/src/ingestion/embedding-recall.mjs)) | **Yes** (shipped tags) | |
| **Keywords** | **Yes** at lexical recall (**D**); **noop** if both empty | **Yes** (beat-fit) | Via profile text | **Yes** (shipped tags) | |
| **Onboarding narrative** | **No** | — (not scored directly today) | **Yes** — profile text for embeddings | **No** | Must not be sole admission path; **E** + **G**. |

### Shorthand roles (`_meta` / PM specs)

| Dimension | Primary role(s) |
|-----------|-----------------|
| Sources | **Gate** (C2 when empty) |
| Geographies | **Gate** (if configured) + **Score** + **Label** |
| Topics | **Gate** (lexical) + **Score** + **Recall profile** + **Label** |
| Keywords | **Gate** (lexical) + **Score** + **Recall profile** + **Label** |
| Onboarding narrative | **Recall profile** only (v1) |

---

## Chunk D — Lexical recall contract (LOCKED)

**Locked decisions (product):**

- **Combinator:** When both topics and keywords are configured, lexical recall uses **OR** — pass if **topic branch** OR **keyword branch** matches.  
- **Empty settings:** If **no** topics **and** **no** keywords are configured, lexical recall is a **no-op** (all items entering the stage pass; funnel `topicKeywordRecallIsNoop`). Downstream gates (**C2** sources, geo, beat-fit, **E**) still apply.

**Scope:** [`applyTopicKeywordFilter`](../apps/api/src/dashboard/refresh-pipeline.mjs) and [`analyzeTopicKeywordStage`](../apps/api/src/dashboard/refresh-pipeline.mjs) — **topic and keyword only**. Geography and onboarding narrative are **out of scope** for this stage (geo = **F**, narrative = embedding profile = **E**).

### Pass rule (v1) — matches lock above

An item **passes lexical recall** if **any** of the following hold:

1. **Topic branch:** User configured at least one topic **and** `normalizeTopicLabel(item.topic)` is in the configured topic set (canonical comparison via [`normalizeTopicLabel` in `@tempo/contracts`](../packages/contracts/src/label-normalization.ts)).
2. **Keyword branch:** User configured at least one usable keyword **and** the item’s **headline + body** matches the keyword regex (see **Token rules**).

If the user configured **neither** topics nor keywords, lexical recall is a **no-op** — **all items** entering the stage **pass** (funnel flag `topicKeywordRecallIsNoop`). Downstream gates (geo, sources **C2**, beat-fit, embeddings policy **E**) still apply.

**Combinator:** **OR** between topic branch and keyword branch when both sides are configured. *(Revisit **AND** only with evidence + golden cases — higher precision, more false negatives.)*

### Token rules (keywords)

- **Case-insensitive** whole-word match using **word boundaries** (`\b`); substrings inside larger tokens do **not** match.
- **Multi-word** keywords (e.g. `border policy`) match as a **contiguous phrase** in the alternation, not as independent words across the text.
- Empty or whitespace-only keywords are **dropped** before building the regex; if no valid keywords remain, the keyword branch is **disabled** (same as “no keywords configured”).

**Text field:** `headline` plus body joined as in the implementation (array `body` joined with spaces, else string `body`).

### Out of scope for lexical recall

- **Geography** — handled only in the geo stage (**F**), not in `applyTopicKeywordFilter`.
- **Onboarding narrative** — not scanned against item text in this stage; may affect **embedding recall** only (**E**).

### Diagnostics

Operator-facing breakdown and `primaryDropCause` codes follow [`analyzeTopicKeywordStage`](../apps/api/src/dashboard/refresh-pipeline.mjs) (`no_topic_no_keyword`, `no_topic_match`, `no_keyword_match`, `no_input`, etc.).

### Spec blurb (paste-friendly)

> **Lexical recall (v1):** After geo and source gates, an item passes if it matches **any configured topic** (normalized label equality) **OR** **any configured keyword** (case-insensitive whole-word / contiguous phrase rules on headline+body). If **no** topics **and** **no** keywords are configured, this stage is a **no-op** (all items pass). Geography and onboarding narrative are **not** part of lexical recall. Combinator is **OR** between topic and keyword branches. Diagnostics use `analyzeTopicKeywordStage` / `topicKeywordRecallIsNoop` in funnel meta.

---

## Chunk E — Semantic / embedding recall (LOCKED)

**Code:** [`embedding-recall.mjs`](../apps/api/src/ingestion/embedding-recall.mjs), [`resolveRecallConfig`](../apps/api/src/ingestion/embedding-recall.mjs), profile/item text builders; `embedFn` injected from [`embeddings` router](../apps/api/src/ai/embeddings.mjs) in production.

**Role (recall only):** Embeddings **widen** recall vs lexical-only; they **do not** replace beat-fit, clustering, or grounding. Every retained item is still a **real ingested** row that passed upstream gates (time, **C2** sources, geo).

### Product decisions (locked)

| # | Topic | Decision |
|---|--------|----------|
| **1** | Default recall mode | **`hybrid_strict`** default in production; **`keyword`** remains an explicit env / ops toggle. |
| **2** | Lexical fallback on embed failure | **Keep (2a):** when lexical recall is non-empty and embeddings fail, output **lexical hits**; mark **degraded** (`degraded_reason`, `keywordFallbackAfterEmbeddingFailure` when applicable). |
| **3** | Empty profile text | **Pass lexical (3b):** if `buildProfileText` is empty, output = **lexical recall items** only (no semantic widen). Implemented in [`embedding-recall.mjs`](../apps/api/src/ingestion/embedding-recall.mjs); diagnostic `degraded_reason: "empty_profile_text_lexical_only"` (distinct from provider-failure flag — `keywordFallbackAfterEmbeddingFailure` is NOT set for E3b). |
| **4** | Caps / default model | **Defer to Chunk N (4a):** Chunk E references **env-driven** `TEMPO_EMBED_TOP_K`, `TEMPO_EMBED_MAX_ITEMS`, `TEMPO_OPENAI_EMBEDDING_MODEL` with **interim defaults** today (80 / 250 / `text-embedding-3-small`); canonical SKU, caps, and eval gates finalized in **N**. |

### Modes (env `TEMPO_RECALL_MODE`)

| Mode | Behavior |
|------|-----------|
| **`hybrid_strict`** (default when unset or unrecognized) | Run embeddings; **union** semantic top-K with lexical recall output — **never narrower** than lexical-only. |
| **`keyword`** | Skip embeddings entirely; output = lexical recall only. |

### Profile and item text (what gets embedded)

- **Profile text** ([`buildProfileText`](../apps/api/src/ingestion/embedding-recall.mjs)): ordered **topics → keywords → geographies → sources → onboarding narrative** (empty sections omitted). This is the **recall profile** from Chunk **C**.  
- **Item text** ([`buildItemText`](../apps/api/src/ingestion/embedding-recall.mjs)): **outlet, headline, body** only — **no** model-derived fields.

### Ranking within semantic branch

Cosine similarity profile vs each item embedding; sort **descending**; ties broken by **input order** then **`sourceId`**. Take top **`embedTopK`** (env `TEMPO_EMBED_TOP_K`, interim default **80** until **Chunk N**).

### Cost / latency caps (interim — Chunk N)

- **`TEMPO_EMBED_MAX_ITEMS`** — caps how many `candidateItems` are embedded (interim default **250**).  
- **`TEMPO_EMBED_TOP_K`** — semantic rows that can join the union beyond lexical (interim default **80**).

### Default embedding SKU (interim — Chunk N)

- **`TEMPO_OPENAI_EMBEDDING_MODEL`** — interim default **`text-embedding-3-small`** if unset (`resolveRecallConfig`).

### Union semantics (after semantic top-K)

Output list = **all lexical recall items first** (stable relative order), then semantic-only items in **score order**, **deduped by `sourceId`**.

### Degraded / failure behavior (`hybrid_strict`)

| Condition | Spec result |
|-----------|----------------|
| `candidateItems.length === 0` | Empty list, **`degraded: false`**. |
| **Empty profile text** | **3b:** **Lexical recall items only** (no semantic widen); `degraded_reason: "empty_profile_text_lexical_only"`. Implemented (M5). |
| `embedFn` not a function | **2a:** lexical fallback if lexical non-empty; else empty + `embedding_unavailable_fail_closed`. |
| Provider **throw** / **invalid** response | **2a:** lexical fallback if lexical non-empty; else fail-closed empty with reason. |
| Success | Union as above; **`degraded: false`**. |

When lexical fallback applies, diagnostics include **`keywordFallbackAfterEmbeddingFailure: true`** and **`degraded_reason`** where applicable.

### Golden / eval hooks (Chunk E scope)

- Cases: **union never drops** a lexical hit; semantic-only additions respect **dedupe**; **empty profile → lexical pass-through (3b)**; **degraded** paths set `degraded_reason` / fallback flag; fixtures for thin text (semantic saves vs beat-fit FP).  
- Full suite ownership: **Chunk L**; tests use **`embedFn` stubs**.

### Spec blurb (paste-friendly)

> **Embedding recall (v1):** Default mode **`hybrid_strict`**: embed profile text (topics → keywords → geos → sources → narrative) and each item’s outlet+headline+body; rank by cosine similarity; take top-K (env caps; interim defaults 80 / 250; **Chunk N** canonicalizes model and limits). **Union** with lexical recall — never narrower than lexical-only. If **embeddings fail** but lexical had hits, **fall back to lexical** and mark degraded. If **profile text is empty**, **pass lexical only** (no semantic widen). **`keyword`** mode skips embeddings. Caps, SKU, and eval gates: **Chunk N**.

### Implementation backlog (from Chunk E)

1. ~~**`embedding-recall.mjs`:** empty `buildProfileText` → return **`keywordRecallItems`** with diagnostics per **3b**, not empty array.~~ **Done — M5.**
2. ~~**`C2` zero sources:** align `selectSourcePool` / manifest path with Chunk **C**.~~ **Done — M6.**

### Phase 3 observability addendum

`_meta.recall` now carries profile-sparseness diagnostics on every return path (full-run, keyword bypass, fail-closed, empty-profile lexical-only):

| Field | Read as |
|-------|---------|
| `profileAxes` | `0` → empty-profile path; `1` → degenerate single-axis semantic widen (still runs, low confidence); `≥2` → normal |
| `profileAxisNames` | Ordered axis names that contributed (e.g. `["topics","keywords","geographies","sources"]`) |
| `profileTextLength` | Char count of the embedding input — quick sniff for unusually small / large profile vectors |

Pure observability — does **not** gate behavior. Surfaced for `_meta.recall` consumers and the `[pipeline.recall]` log line.

---

## Chunk F — Geo contract (LOCKED)

**Code:** [`geo-filter.mjs`](../apps/api/src/dashboard/geo-filter.mjs); invoked from [refresh-pipeline](../apps/api/src/dashboard/refresh-pipeline.mjs) after source selection + hold merge.

**Role (Chunk C):** Geographies are a **gate** when the user configures at least one geo; plus **score** and **label** downstream (beat-fit, shipped tags). **Assessor SKU** is finalized in **Chunk N**.

### Product decisions (locked)

| # | Topic | Decision |
|---|--------|----------|
| **F1** | No geographies configured | **F1a — No-op:** empty `settings.geographies` → all items **included**, no holds (geo gate off). |
| **F2** | Thresholds | **F2a — Keep** `IMPLICIT_THRESHOLD` **0.80**, `CONFLICT_THRESHOLD` **0.90** as v1 spec; revisit with real assessor + goldens (**L** / **N**). |
| **F3** | Production assessor | **F3b:** Production **must** inject a **non-mock** `geoAssessFn`; `mockAssessGeoConfidence` **tests only**. *Code may still default to mock until backlog closed.* |
| **F4** | Hold bucket | **F4a — Keep** persist + **re-merge** held items on the next refresh (dedupe against live pool, re-run geo). |

### Categories (`categorizeItem`)

| Category | Rule |
|----------|------|
| **explicit_match** | `item.geographies` overlaps configured set → **always include** (`geoConfidence: 1.0`). |
| **explicit_conflict** | Item has geographies but **none** match configured → `assessFn`; include if confidence ≥ **0.90**. |
| **implicit_geo** | Item has **no** `geographies` on the row → `assessFn`; include if confidence ≥ **0.80**. |

### Hold bucket (**F4a**)

Items below threshold go to **`held`**. When hold read/write is wired, held items are **persisted** and merged into the **next** refresh’s pool (deduped by `sourceId` against live items), then **re-evaluated** through geo and the rest of the funnel.

### Reference: mock behavior (tests / pre-F3b prod path)

`mockAssessGeoConfidence` returns **0.85** always → **implicit** passes, **conflict** fails threshold → conflict rows **held**. Replace with real **`geoAssessFn`** per **F3b** and **Chunk N**.

### Spec blurb (paste-friendly)

> **Geo gate (v1):** If the user configures **no** geographies, geo filter is a **no-op** (all pass). If configured: **explicit_match** to user geos always passes; **implicit** (no item geos) and **explicit_conflict** use **`geoAssessFn`** with thresholds **0.80** / **0.90** respectively; below threshold → **hold**. Held items are **re-merged** on the next refresh when persistence is enabled. Production **must** use a **non-mock** assessor (**F3b**); **Chunk N** names the implementation. Beat-fit and shipped tags still apply downstream (**C**, **G**, **K**).

### Implementation backlog (from Chunk F)

1. **Production `geoAssessFn`:** inject real assessor per **Chunk N**; remove mock as prod default (**F3b**).

*(See also Chunk E backlog: **E 3b** empty profile, **C2** zero sources.)*

---

## Chunk G — Precision layer / beat-fit (LOCKED)

**Code:** [`beat-fit-scorer.mjs`](../apps/api/src/dashboard/beat-fit-scorer.mjs); invoked from [refresh-pipeline](../apps/api/src/dashboard/refresh-pipeline.mjs) after embedding recall, **before** cross-feed dedupe.

**Role:** **Precision** (Chunk **C**): narrows the recall union with a **deterministic heuristic** (`beat-fit-v1`). **Not** an LLM ranker in v1 (**G3a**). Clustering and grounding remain downstream.

### Product decisions (locked)

| # | Topic | Decision |
|---|--------|----------|
| **G1** | Default threshold | **G1b — MVP recall-first default `0.20`** ([D-063](../DECISIONS.md)), env-tunable via `TEMPO_BEAT_FIT_THRESHOLD` (legacy alias `BEAT_FIT_THRESHOLD`). Set the env to `0.40` to roll back to the prior G1a precision-first posture. |
| **G2** | Strict empty | **G2a — Keep** no weak fill: if recall had items but none pass threshold, **zero** proceed; log `beat_fit_strict_empty`. |
| **G3** | Heuristic vs LLM ranker | **G3a — Heuristic `beat-fit-v1` is the v1 precision gate.** An LLM ranker is a **successor** only with explicit version, evals, and **Chunk N** model matrix — not v1 by default. |

**Rationale (G3a):** v1 prioritizes **testability, repeatable drops, and reason codes** over an extra **probabilistic** surface before goldens and **N** are in place; heuristics do **not** claim to always beat a future well-evaluated ranker on nuance.

### Scoring (summary)

Per item, `scoreBeatFit` combines **bounded** components (topic match, policy-actor cues, keyword token match, geo match, recency) minus **penalties** (off-beat region text without configured geo hit, commodity framing without actor, no positive signal floor). Final score **clamped** to `[0, 1]`; **`reasonCodes`** on each item for logs.

### Threshold & exclusion reasons

Items with **`score >= threshold`** included (default `0.20` under G1b / [D-063](../DECISIONS.md); env-tunable, set `TEMPO_BEAT_FIT_THRESHOLD=0.40` for the legacy precision-first gate); else excluded with histogram bucket: `excluded_offbeat_geo`, `excluded_commodity_framing`, `excluded_no_signal`, `excluded_low_score`.

### `beatFitEnabled`

Default **true** in production pipeline; **`false`** only for **narrow tests** that should not model full beat-fit signals ([`runRefreshPipeline`](../apps/api/src/dashboard/refresh-pipeline.mjs)).

### Spec blurb (paste-friendly)

> **Precision (v1):** After recall, **`beat-fit-v1`** scores each item on heuristic signals (topic, actor/keyword/geo/recency, penalties), threshold **`0.20`** (G1b / [D-063](../DECISIONS.md) MVP recall-first; set `TEMPO_BEAT_FIT_THRESHOLD=0.40` to roll back to the precision-first posture). **Strict empty:** if nothing clears the bar, **no** weak fill. **`beatFitEnabled`** may be false in tests only. **No LLM ranker** at this stage in v1 (**G3a**); successor needs version + evals + **N**. Exclusions expose `excludeReason` histograms for ops.

---

## Chunk H — Cross-feed dedupe (LOCKED)

**Code:** [`source-deduper.mjs`](../apps/api/src/ingestion/source-deduper.mjs); runs **after** beat-fit, **before** clustering / watermark ([refresh-pipeline](../apps/api/src/dashboard/refresh-pipeline.mjs)).

**Role:** Collapse the **same real article** across feeds so evidence counts, clustering, and lineage are not inflated. **False merge** is a serious FP risk.

### Product decisions (locked)

| # | Topic | Decision |
|---|--------|----------|
| **H1** | Merge strictness | **H1a — Strict / false-merge-averse:** URL path requires **canonical URL + exact normalized headline + |Δ minutesAgo| ≤ window**; no **URL-only** merge; **empty** normalized headline → never merge; no-URL path → **exact** normalized headline only. |
| **H2** | Time window | **H2a — `PUBLISH_WINDOW_MINUTES` = 60**. |
| **H3** | Cross-outlet | **H3a — Allow** merges across outlets/feeds when **H1a** rules pass (outlet not a gate). |
| **H4** | Provenance | **H4a — Internal only:** `_duplicates` and related internal annotations **stripped** from client payload (`buildStory` whitelist); no product UI commitment to expose duplicate feeds. |

### Spec blurb (paste-friendly)

> **Dedupe (v1):** Cross-feed collapse is **strict**: same **canonical URL** and **same normalized headline** and **≤ 60 minutes** apart on `minutesAgo`, **or** (no usable URL) **exact** normalized headline match only. **Never** merge on URL alone; **never** merge empty headlines. **Cross-outlet** merges **allowed** when rules pass. Duplicate provenance stays **server-internal** (**H4a**).

---

## Chunk I — Clustering (LOCKED)

**Code:** [`cluster-engine.mjs`](../apps/api/src/ai/cluster-engine.mjs) (`clusterItems`); wired as `clusterFn` from [server.mjs](../apps/api/src/server.mjs). Model string from **`getAiCapabilityMap().clustering`** (`TEMPO_AI_CLUSTER_MODEL` / default in [model-router.mjs](../apps/api/src/ai/model-router.mjs)).

**Input:** Deduped candidates + **settings**. **Output:** Zod-validated **`clusteringOutputSchema`**, engine version **`cluster-v1`**.

### Product decisions (locked)

| # | Topic | Decision |
|---|--------|----------|
| **I1** | On LLM cluster failure | **I1a — Fail closed (Slice 1):** retry clustering **once** (`TEMPO_AI_CLUSTER_TIMEOUT_MS`, default 25s); if both attempts fail → publish **zero** meta-stories. **Do not** ship `gracefulFallbackClustering` to users (ops/tests only). Surface `usedFallbackClustering`, `clusteringFailureReason`, `clusteringAttempts`, `clusteringLatencyMs` on `_meta`. |
| **I2** | Output caps | **I2a — Keep** at most **5** meta-stories, **1–5** `source_item_ids` each. |
| **I3** | Merge bias | **I3a — Posture:** bias **against** merging unless items clearly support **one** narrative; prompt + **Chunk L** goldens implement detail. |
| **I4** | Clustering model SKU | **I4a — Defer to Chunk N** (same pattern as **E4a**): interim behavior stays **env-driven**; **canonical** clustering model, failover, logging, and code SSOT are fixed when the **full dashboard model matrix** is written in **N** (and code updated in one pass). **Rationale (pre-launch):** solo build, no external users — no separate “pick clustering SKU now” carve-out. |

**Providers (reference):** `anthropic:` → Anthropic + **`TEMPO_AI_CLUSTER_TIMEOUT_MS`** (cluster-only, default 25s); `mock-*` / `TEMPO_AI_MOCK_ONLY` → **`mockCluster`**; unknown → mock-like path. **On throw/timeout after retry:** **I1a** fail closed (empty dashboard).

### Golden / eval hooks (Chunk I scope)

- Bad-merge / over-merge cases; fallback path when LLM throws; mock vs real provider parity for tests. **Chunk L** owns suite map; **N** ties model changes to evals.

### Spec blurb (paste-friendly)

> **Clustering (v1):** `cluster-v1` — LLM path (`clusterItems`) over deduped items + settings; **≤5** stories, **1–5** sources each (schema). On failure after one retry → **fail closed** (zero stories; no `gracefulFallbackClustering` on the publish path). **FP-first merge posture:** prefer **not** to merge unrelated items (**I3a**). **Clustering model / provider matrix:** **Chunk N** + code (**I4a**, same deferral idea as **E4a**).

---

## Chunk J — Grounding trust gates + ship-ready + golden hooks (**LOCKED**)

**Status:** **Locked** — **J1a**, **J2a**, **J3b**, **J4a**, **J5a**.

**Scope:** What happens **after** clustering output and **before** `buildStory` / publish: deterministic **`verifyGrounding`** in [`cluster-engine.mjs`](../apps/api/src/ai/cluster-engine.mjs) (no separate LLM grounding step in v1). **Clustering model / SKU** stays **Chunk N** (**I4a**); this chunk only names **trust outcomes** and **labels** so **L** can reference them.

**LLM meta-copy (editorial synthesis across sources):** **Not in Chunk J v1.** A future **post-grounding** LLM step for meta-headline / meta-summary belongs in **Chunk N** (which model, SKU, when it runs, eval gate on change) and **Chunk L** (golden / scenario coverage so copy regressions are must-not-ship).

**Current behavior (reference):**

- **Gate 1 — IDs:** If **no** `source_item_id` exists in the post-dedupe pool → `no_valid_source_ids` → **invalid**.
- **Gate 2 — claims:** Each index in `factual_claims` must have ≥1 evidence id in `claim_evidence_map` that exists in the pool; **empty `factual_claims`** → claim gate **skipped** (**J2a** — passes). Ungrounded → `ungrounded_claims` → **invalid**.
- **Gate 1b — partial IDs:** If some ids are hallucinated but ≥1 real id remains → `partial_source_ids` → **invalid** (trimmed ids on the object). **Pipeline:** refresh treats **all invalid** as **not shipped** (**J1a** strict; tests: `runRefreshPipeline: Phase 3 strict drop — partial_source_ids…`).

**Valid path:** When `factual_claims` is non-empty, **`summary`** and **`subtitle`** are set to the **first claim only** (**J3b**); when empty (**J2a**), model summary/subtitle stay (still subject to gates above). *Tradeoff:* additional grounded claims are not concatenated into `summary` (shorter card; claims remain in payload for evidence / future copy).

### Decision J1 — Invalid grounding outcomes vs publish (**locked: J1a**)

| Option | Behavior |
|--------|----------|
| **J1a** | **Strict:** any `groundingFailure` (`no_valid_source_ids`, `ungrounded_claims`, `partial_source_ids`) → story **does not** enter the ship path; counts in `groundingDropReasons` / rejection log. FP-first: **no** salvage for partial-ID stories in v1. |
| **J1b** | **Salvage partial:** (not chosen) trim hallucinated ids and ship if claim gate passes. |

**Locked:** **J1a**.

### Decision J2 — Empty `factual_claims` vs claim gate (**locked: J2a**)

| Option | Behavior |
|--------|----------|
| **J2a** | **Pass:** empty `factual_claims` skips claim-level gate; story can still ship if IDs are fully valid and no partial-ID failure. Summary/subtitle stay model text (higher prose risk; beat-fit / other layers still apply downstream). Matches current `verifyGrounding`. |
| **J2b** | **Fail closed:** (not chosen) require **≥1** factual claim for v1 ship — empty claims → reject or dedicated code. |

**Locked:** **J2a**.

### Decision J3 — Claim-derived `summary` / `subtitle` on valid path (**locked: J3b**)

| Option | Behavior |
|--------|----------|
| **J3a** | (not chosen) `summary` = all claims `join(" ")`, `subtitle` = first claim. |
| **J3b** | **Shorter card:** when `factual_claims` is non-empty, **`summary` and `subtitle` both use `factual_claims[0]` only** (no join of all claims). Model prose replaced for those fields; extra claims stay available on the object for evidence / later stages. |
| **J3c** | (not chosen) Richer **deterministic** recipes only (e.g. different separators, headline snippets) — still no extra LLM in `verifyGrounding`. |

**Locked:** **J3b** (implemented in `verifyGrounding`).

**Deferred — LLM editorial “meta” copy:** A **separate** LLM pass that reads **all** sources in the cluster to write a polished meta-headline / meta-summary is **out of J3** (that step is not the trust gate). Record it under **Chunk N** (model matrix, SKU, when to run, change gate) and **Chunk L** (scenarios + goldens so FP copy does not ship silently).

### Decision J4 — Funnel label for “passed trust enough to count” (**locked: J4a**)

Chunk **A** reserved a **conversion-metrics** label at the trust boundary. **J4a** locks it.

**Facts about v1 code (reference):** In [`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs), **beat-fit, geo, and dedupe** run **before** clustering. After **lineage**, only **`verifyGrounding`** then **`buildStory`** run; `buildStory` is a **pure** mapping to the response shape (no extra trust gate today).

| Option | Canonical label (suggested) | **When** the unit “counts” for that metric |
|--------|-----------------------------|---------------------------------------------|
| **J4a** | **`grounding-passed`** (synonym in prose: **`ship-ready (grounding)`**) | Membership in **`verifyGrounding` → `valid`**, i.e. right before `buildStory`. Failed grounding stays **meta-story (pre-ship)** with `groundingFailure` / `reason_code` for logs and **L** — **not** `grounding-passed`. |
| **J4b** | (not chosen) **`ship-ready`** = in final `stories` only — redundant with **shipped story** in v1. |
| **J4c** | (not chosen) **`ship-ready`** at same boundary as **J4a** without the word **grounding-passed**. |

**Pipeline note (v1):** No additional server trust gate between **`grounding-passed`** and **`buildStory`**. If a future **post-grounding** gate is added, **`grounding-passed`** stays at this boundary; **`shipped story`** may become **narrower** without renaming **J4a**.

**Scope note:** **`grounding-passed`** is a **named checkpoint for analytics and docs** (and optional `_meta`), **not** a new mandatory funnel stage in the product sense.

**Locked:** **J4a**.

### Decision J5 — Golden / eval hooks for grounding (**locked: J5a**)

**Goal:** What **Chunk J** commits to vs **Chunk L** / **Chunk N** — grounding regressions stay **FP-first must-not-ship**.

**Normative checklist (v1 grounding — FP-first “must not ship”)**  
These are **expected drops** or **safe transforms**; **Chunk L** maps each to **named scenarios**, **log fields**, and **test IDs** over time.

| # | Scenario | Expected |
|---|----------|----------|
| G1 | All `source_item_ids` hallucinated (none in pool) | **`no_valid_source_ids`** → not in payload; counted in `groundingDropReasons` / rejection log. |
| G2 | At least one claim with no valid evidence id in pool | **`ungrounded_claims`** → not in payload. |
| G3 | Mix of real + hallucinated ids (`partial_source_ids`) | **Strict drop** (**J1a**) — not in payload; poison prose on dropped unit must not reach client (see existing pipeline tests). |
| G4 | Valid ids + non-empty claims | **`summary` / `subtitle` from first claim only** (**J3b**); model-only prose must not bypass via those fields when claims exist. |
| G5 | Valid ids + **empty** `factual_claims` (**J2a**) | May **`grounding-passed`** with **model** summary/subtitle — document as **higher prose risk**; beat-fit / other layers already ran upstream. |

**Handoff**

- **Chunk L** — Owns **full golden suite map**, operator scenarios (“why 0 stories?”), and which `_meta` / funnel keys explain each drop.  
- **Chunk N** — Owns **which models** re-run evals when clustering / embedding SKUs change; does **not** duplicate the per-scenario list here.

| Option | What Chunk J locks |
|--------|-------------------|
| **J5a** | **Adopt the G1–G5 checklist** as the **normative J grounding contract** for v1. **Existing** [`cluster-engine.test.mjs`](../apps/api/src/ai/cluster-engine.test.mjs) + [`refresh-pipeline.test.mjs`](../apps/api/src/dashboard/refresh-pipeline.test.mjs) cases are the **current** mechanical proof; **L** formalizes naming, coverage gaps, and observability without changing the contract unless a later chunk revises it. |
| **J5b** | (not chosen) **Pointer-only** — no numbered checklist in Chunk J. |
| **J5c** | (not chosen) **Hard gate** — checked-in golden manifest in the same PR as locking J5. |

**Promotion note (optional later):** If **institutional** drift becomes the risk, **L** or **M** may introduce a **single golden manifest** (**J5c**-style) without re-opening **J1–J4** — it **implements** this same G1–G5 contract under CI.

**Locked:** **J5a**.

---

## Chunk K — Tags vs pool (**one-way**) (**LOCKED — K1a**)

**Status:** **Locked** — **K1a**.

**Scope:** How **`tags`** on a **shipped story** are produced vs the **source items in that story** and **user settings**. Aligns Chunk **C** “**label-only**” dimensions (topics, keywords, geographies): tags **explain** a card; they **do not** widen the post-fetch pool, recall, clustering, or dedupe in v1.

**Out of scope here:** Ingestion taxonomies, client-only presentation that does not mirror this contract, and **clustering model tags** as an authority source for the **payload** (see **K1**).

### Current behavior (reference)

[`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs) sets:

```599:599:05-engineering/apps/api/src/dashboard/refresh-pipeline.mjs
    tags: deriveStoryTags(sourceItems, settings),
```

[`deriveStoryTags`](../apps/api/src/dashboard/refresh-pipeline.mjs) implements **settings ∩ evidence** per axis (canonical comments in-file):

- **topics** — `settings.topics` ∩ normalized `sourceItem.topic` across story sources (topic synonym normalization).
- **geographies** — `settings.geographies` ∩ union of `sourceItem.geographies` (case-insensitive; out-of-settings geo strings dropped).
- **keywords** — each `settings.keywords` entry must appear as a **whole word** in concatenated headline/body of story sources (consistent with lexical keyword matching semantics elsewhere).

**Model / cluster `metaStory.tags`:** **Not consulted** for shipped `tags` (see test *“deriveStoryTags: does not consult model tags at all”* in [`refresh-pipeline.test.mjs`](../apps/api/src/dashboard/refresh-pipeline.test.mjs)). [`constrainTagsToSettings`](../apps/api/src/dashboard/refresh-pipeline.mjs) remains exported for utilities/tests; **`buildStory` does not use it** for production tag emission.

**Empty axes:** When nothing matches, the axis is **`[]`** — **no fabricated placeholders**.

### Decision K1 — Shipped tag authority + direction (**locked: K1a**)

| Option | Shipped `tags` | Upstream pool |
|--------|----------------|---------------|
| **K1a** | **Only** [`deriveStoryTags(sourceItems, settings)`](../apps/api/src/dashboard/refresh-pipeline.mjs) — **settings ∩ evidence** per axis; empty when no match; model/cluster tags **ignored** for payload tags. | **One-way:** tags **never** admit items into candidates, recall, clustering, or dedupe (**Chunk C** label-only posture). |
| **K1b** | (not chosen) Merge or prefer **model/cluster tags** for display. | — |

**Locked:** **K1a**.

### Spec blurb (paste-friendly)

> **Tags vs pool (v1, one-way — K1a):** Shipped story **`tags`** come **only** from **`deriveStoryTags`** — per axis **`settings ∩ source evidence`** for the **resolved `sourceItems` in that story** (topics via normalized `source.topic`, geographies via intersection with settings list, keywords via whole-word hits in headline/body). **Model/cluster tags are not authoritative** for payload tags. **Empty axis = empty array** — no fabricated labels. Tags are **label-only**: they **do not** feed candidates, recall, clustering, or dedupe (**Chunk C**).

### Phase 1 + 2 amendment — trust cleanup (2026-05-16)

**Status:** Shipped on `feat/meta-story-tags-phase1`; **Chunk K is still locked to K1a** — the semantics below tighten the existing contract, they do not redefine it.

**What changed (Phase 1 — fabrication removal):**

- **No root-topic fallback for UI.** [`dashboard-filters.ts`](../../04-prototype/src/lib/dashboard-filters.ts) (`topicsOf` / `keywordsOf` / `geographiesOf`) now reads **only** from `story.tags`. Missing tags = empty arrays on every axis. The header-pill / scan-row code paths no longer fall back to root `story.topic` or `story.geographies` for label discovery — that fallback was a quiet way for fabricated chips to leak into the UI on legacy or thin-evidence stories.
- **No fabricated default in [`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs).** The legacy `?? "Diplomatic relations"` is gone; `validTopic` is now `rawTopics.find((t) => VALID_TOPICS.has(t))` (no default). When no source item carries a canonical topic, the field is **omitted** from the payload (`storySchema.topic` is optional). UI labels are tags-only, so the omission has no display impact — but it stops silently inventing a topic for stories whose sources didn't actually support one.
- **Empty defaults.** [`DEFAULT_SETTINGS`](../apps/api/src/db/settings-repo.mjs), [`apps/api/data/settings.json`](../apps/api/data/settings.json), and the prototype's [`defaultSettingsPayload`](../../04-prototype/src/lib/settings-api.ts) are now fully empty (`topics`, `keywords`, `geographies`, `traditionalSources`, `socialSources` all `[]`). An unconfigured installation surfaces nothing rather than a seed taxonomy that looks like user-chosen evidence.

**What changed (Phase 2 — contract + boundary alignment):**

- **`storySchema.tags` is required.** [`schemas.ts`](../packages/contracts/src/schemas.ts) dropped `.optional()` on `tags`; the display contract now guarantees `{ topics: string[], keywords: string[], geographies: string[] }` on every emitted story (empty arrays are valid). Loaders that surface legacy snapshots **must** normalize before parse — see next bullet.
- **Snapshot loader normalizes tags at read.** [`dashboard-snapshot-repo.mjs`](../apps/api/src/db/dashboard-snapshot-repo.mjs) (`normalizeStoriesForLoad`) coerces missing / non-object / partial `tags` to the three-axis empty shape before [`liftSnapshotMeta`](../apps/api/src/db/dashboard-snapshot-repo.mjs) returns. This is a **read-time boundary** guard — no destructive write-time migration, no schema drift on disk; older snapshots load safely and stay readable.
- **Root `story.topic` / `story.geographies` are explicitly non-authoritative for UI.** They remain on the wire because lineage matching ([keyed-merge `prior.topic`](../apps/api/src/dashboard/refresh-pipeline.mjs)) still keys narrative continuity by canonical topic when the API has one. UI code reads only `tags`.

**Why this is still K1a, not a new decision:** Source authority (`deriveStoryTags(sourceItems, settings)`), one-way direction (tags don't widen pool/recall/clustering), and `settings ∩ evidence` semantics are unchanged. Phase 1/2 closes leaks where the *absence* of evidence was being papered over with a fabricated topic or a root-field fallback — bringing the on-the-wire and on-the-screen shapes in line with what K1a always said about evidence-only labels.

### Phase 3 amendment — deterministic meta-story tagging + geo aliasing (2026-05-16)

**Status:** Shipped on `feat/meta-story-tags-phase1`; **Chunk K is still locked to K1a** — Phase 3 enriches *evidence-to-tags*, not the one-way posture.

**What changed:**

- **Tag emission moved to meta-story scope.** [`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs) now calls [`assignMetaStoryTags({ metaStory, sourceItems, settings })`](../apps/api/src/dashboard/meta-story-tags.mjs) instead of [`deriveStoryTags(sourceItems, settings)`](../apps/api/src/dashboard/refresh-pipeline.mjs). The legacy helper stays exported as a back-compat utility — production tag emission goes through the new module.
- **Evidence bundle = meta-story text + source text + URL.** [`buildMetaStoryEvidenceText`](../apps/api/src/dashboard/meta-story-tags.mjs) concatenates the meta-story `title`/`subtitle`/`summary` with each source's `headline` + `body` + `url`. Missing fields silently skip; non-string entries are filtered. Source structural fields (`source.topic`, `source.geographies`) are consulted separately as canonical evidence — not folded into the text bundle. (URL added in D-064 — 2026-05-17 — so path tokens like `…/beijing/…` count as alias evidence; beat-fit `joinText` also includes `url` for the same reason.)
- **Topics:** union of (a) phrase match of each `settings.topics` value against the bundle and (b) `source.topic` normalized via [`normalizeTopicLabel`](../packages/contracts/src/label-normalization.ts) → settings vocabulary. This means a meta-story whose source `topic` is `"General"` (out of settings) but whose summary mentions `"Diplomatic relations"` still surfaces a topic tag — covered by the regression *"Phase 3 wiring: topic tag derived from meta-story summary even when source.topic is weak"*.
- **Keywords (deterministic only):** whole-word phrase match against `settings.keywords` in the bundle. **Semantic widening is explicitly Phase 4.**
- **Geographies:** union of (a) direct phrase match of `settings.geographies` in the bundle, (b) `source.geographies` arrays intersected with settings, and (c) **deterministic alias hits** via [`resolveGeographyAlias`](../packages/contracts/src/geography-aliases.ts). The alias map ([`GEOGRAPHY_ALIASES`](../packages/contracts/src/geography-aliases.ts)) covers `Beijing → China`, `Montevideo → Latin America`, `Tokyo → Japan`, etc.; emission is **gated on `settings.geographies`** — the canonical target must be opted in, and the alias surface form is never emitted.
- **Settings vocabulary is the only output vocabulary.** Every axis is a subset of the matching `settings.*` list; emission uses the user's spelling.
- **Tests added:** [`meta-story-tags.test.mjs`](../apps/api/src/dashboard/meta-story-tags.test.mjs) (18 cases — bundle building, topic/keyword/geo matching, alias gating, dedupe + ordering, no-mutation, deferred Phase 4 boundary); plus [`refresh-pipeline.test.mjs`](../apps/api/src/dashboard/refresh-pipeline.test.mjs) wiring regressions covering the four acceptance assertions (meta-story topic surfacing, Beijing → China, alias drop when ungated, `petroleum` not widening to `oil`).
- **Alias map lives in contracts:** [`geography-aliases.ts`](../packages/contracts/src/geography-aliases.ts) — colocated with [`label-normalization.ts`](../packages/contracts/src/label-normalization.ts) so the alias vocabulary is shared with eval/scoring code if/when those want it.

**Why this is still K1a:** Settings-as-vocabulary, settings ∩ evidence semantics, and one-way direction (tags never feed candidates, recall, clustering, or dedupe) are all preserved. Phase 3 deepens evidence ("evidence bundle" instead of "structural source fields only") and adds a deterministic alias layer; both stay strictly inside the existing contract.

### Phase 4 amendment — constrained semantic mapping for topics + keywords (2026-05-16; default OFF)

**Status:** Shipped on `feat/meta-story-tags-phase1`; **Chunk K is still locked to K1a**. Semantic uplift sits inside the existing "settings ∩ evidence" surface — it tightens *how* a candidate label is matched against evidence, never *what* vocabulary is emitted. Default is OFF; production rollout is a separate Phase 5 step.

**What changed:**

- **New module — [`meta-story-semantic-mapper.mjs`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs):** `mapSemanticAxis({axis, evidenceText, allowedLabels, deterministicLabels, threshold, enabled, scorer})` scores each candidate against a closed vocabulary (`settings.topics` or `settings.keywords`) using an **injected scorer** function. Accepts iff `score >= threshold`; rejects everything below and counts it as `belowThresholdCount`. `mapSemanticTopicsAndKeywords` is a thin wrapper that runs both axes with per-axis thresholds. `resolveSemanticTagConfig(env, overrides)` reads the env flag/threshold variables (with override seam for tests).
- **Closed-vocabulary by construction.** The mapper only ever inspects labels you pass in; it cannot widen `allowedLabels`. A test (*"out-of-settings label can NEVER appear in `accepted`"*) and a parallel pipeline regression lock this: even an aggressive scorer that loves `"petroleum"` can never emit `"petroleum"` — only `"oil"` (and only if it's in `settings.keywords` and clears the threshold).
- **Assigner integration — [`meta-story-tags.mjs`](../apps/api/src/dashboard/meta-story-tags.mjs):** new async sibling `assignMetaStoryTagsDetailed({metaStory, sourceItems, settings, semantic})` returns `{tags, diagnostics}`. Deterministic baseline runs first; semantic uplift is merged in (dedupe, locale-sort) and produces a per-axis diagnostic record (`{axis, enabled, scorerProvided, threshold, candidateCount, acceptedCount, rejectedCount, belowThresholdCount}`). The sync `assignMetaStoryTags` keeps its Phase 3 behavior — direct callers don't get Phase 4 uplift unless they explicitly opt in.
- **Pipeline plumbing — [`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs):** `runRefreshPipeline` accepts optional `semanticTagConfig` and `semanticTagScorer`. After `buildStory` produces the deterministic baseline, the pipeline overlays semantic uplift per story (topics + keywords only), aggregates per-axis diagnostics, and emits `log.tags = { topics, keywords, geographies: { semanticApplied: false } }`. A `[pipeline.tags]` console line surfaces `enabled / accepted / rejected / belowThresholdCount` per axis on every run. The overlay sits **after** clustering/grounding so it cannot change funnel counts — a regression test (*"Phase 4 wiring: semantic uplift does NOT change funnel / admission counts"*) compares ON vs OFF runs over the same fixture and asserts identical funnel stages.
- **Persistence + read path — [`server.mjs`](../apps/api/src/server.mjs) + [`dashboard-snapshot-repo.mjs`](../apps/api/src/db/dashboard-snapshot-repo.mjs):** `log.tags` rolls up into `finalPayload._lastRunMeta.tags`; the snapshot loader lifts `_lastRunMeta.tags` into `_meta.tags` on read. Optional everywhere for back-compat with pre-Phase-4 snapshots.
- **Geographies axis is locked deterministic-only.** Phase 4 does NOT extend semantic mapping to geographies. The diagnostic aggregate carries an explicit `geographies.semanticApplied: false` stamp on every run; an aggressive scorer that loves `"Beijing"` still cannot emit a `China` tag unless China is in `settings.geographies` **and** the Phase 3 deterministic alias map fires. Pipeline test *"geography axis is unchanged when semantic is ON"* locks this.

**Env flags + thresholds (defaults OFF):**

| Env var | Effect | Default |
|--------|--------|---------|
| `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED` | global gate; **all** semantic uplift is gated on this | `false` |
| `TEMPO_TAG_SEMANTIC_TOPICS_ENABLED` | per-axis gate; AND-folded with global | `false` |
| `TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED` | per-axis gate; AND-folded with global | `false` |
| `TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD` | `[0,1]` cut-off for topic acceptance | `0.75` |
| `TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD` | `[0,1]` cut-off for keyword acceptance | `0.75` |

**Diagnostics consumers (operator-facing only):**

- Console log per refresh: `[pipeline.tags] semantic_topics=on accepted=N rejected=M below_threshold=K  semantic_keywords=… semantic_geographies=off(locked)`.
- `_meta.tags` on the dashboard response: `{topics: {…}, keywords: {…}, geographies: {semanticApplied: false}}`. The UI does NOT render semantic internals as user-facing labels — chips read tag strings (still settings vocabulary) directly.

**Why this is still K1a:** Settings-as-vocabulary, settings ∩ evidence semantics, and one-way direction (semantic uplift only affects shipped `tags`, never pool/recall/clustering/dedupe) are all preserved. The change is a richer *evidence-to-tags* step; admission inputs are untouched, and the closed-vocabulary mapper cannot fabricate.

### Phase 5 amendment — production scorer wiring + fail-closed + calibration harness (2026-05-16; default OFF)

**Status:** Shipped on `feat/meta-story-tags-phase1`; **Chunk K is still locked to K1a**. Phase 5 wires a real scorer behind the Phase 4 surface, adds fail-closed semantics with operator-readable runtime state, and ships a calibration tool. The scope (closed vocabulary, topics + keywords only, geographies deterministic) is unchanged.

**What changed:**

- **Production scorer — [`createEmbeddingSemanticScorer`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs):** wraps an `embedFn(texts) → number[][]` (the production wiring uses [`embedTexts`](../apps/api/src/ai/embeddings.mjs), same provider as recall) in: (a) per-call wall-clock timeout via `Promise.race` (throws `SemanticScorerTimeoutError`), (b) evidence text truncation to `maxEvidenceChars`, (c) internal evidence + label vector caches so repeated probes within the same run don't re-embed, (d) cosine similarity rescaled from `[-1, 1]` to `[0, 1]` so thresholds keep their range. The factory **throws on construction** when `embedFn` is missing — production wiring must explicitly opt in.
- **Server-side opt-in — [`server.mjs`](../apps/api/src/server.mjs) `_refreshPipeline.run`:** when (a) `resolveSemanticTagConfig()` reports any axis enabled AND (b) `opts.semanticTagScorer` is not injected by a test, the route handler builds a production scorer from `_embeddings.embed` + the runtime config. Tests continue to inject deterministic scorers; both paths share the mapper.
- **Fail-closed pipeline behavior:** scorer timeout or generic error never breaks refresh. The mapper:
  - records `fallbackReasonCounts: {timeout, error}` per axis;
  - derives `runtimeState ∈ {disabled, enabled_no_scorer, enabled_scorer_ready, scorer_error_fallback, scorer_timeout_fallback}` (worst-observed across stories);
  - accumulates `scorerLatencyMs` (including the latency of failing calls — slow failures stay visible).
  Deterministic baseline always ships. Pipeline regression *"funnel counts identical for scorer-OFF vs scorer-FAIL"* asserts the K1a invariant under fallback.
- **New env vars (defaults conservative):** `TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS` (default `1500`) and `TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS` (default `4000`). Both parsed via [`resolveSemanticScorerRuntimeConfig`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs).
- **Operator observability:**
  - `[pipeline.tags]` log line per refresh: `semantic_topics=<runtimeState> accepted=N rejected=M below_threshold=K latency_ms=L timeouts=T errors=E  semantic_keywords=… semantic_geographies=off(locked)`.
  - `_meta.tags.{topics,keywords}` carries `{runtimeState, scorerLatencyMs, fallbackReasonCounts}` on top of the Phase 4 counts.
  - `_meta.tags.geographies.semanticApplied` is `false` on every run (tripwire for scope drift).
- **Calibration harness — [`semantic-tag-calibration.mjs`](../apps/api/scripts/semantic-tag-calibration.mjs):** operator tool (not exercised in CI). Reads a curated fixture file ([`semantic-tag-calibration-fixtures.json`](../apps/api/scripts/semantic-tag-calibration-fixtures.json)) of `{axis, evidence, expectedAccept, expectedReject}` triples; runs the mapper across candidate thresholds (default `0.55 / 0.65 / 0.75 / 0.85`); prints precision / recall / F1 + a confusion summary per axis; recommends the highest threshold whose recall is within 5pp of the best observed (conservative bias toward precision). Supports `--provider=mock|embeddings`, `--fixtures=<path>`, `--thresholds=0.6,0.7,…`.

**Runtime-state matrix (operator cheat sheet):**

| State | Meaning | Action |
|-------|---------|--------|
| `disabled` | Per-axis or global flag is OFF | Default — no action |
| `enabled_no_scorer` | Flag ON but no scorer wired (server bug or unintended config) | Investigate `_embeddings.embed` availability + `_refreshPipeline.run` wiring |
| `enabled_scorer_ready` | Flag ON, scorer succeeded for every probe | Healthy — monitor `acceptedCount / belowThresholdCount` ratios |
| `scorer_error_fallback` | At least one probe threw a non-timeout error | Check provider logs / SDK version; deterministic baseline still shipping |
| `scorer_timeout_fallback` | At least one probe exceeded `TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS` | Bump timeout OR open provider capacity ticket; deterministic baseline still shipping |

**Why this is still K1a:**

- Closed-vocabulary preserved: mapper only inspects `allowedLabels`; production scorer is just the score function, not a label generator.
- One-way preserved: semantic overlay still runs strictly post-clustering / post-grounding; admission inputs are untouched. Regression test pins ON-with-failure ≡ OFF on funnel counts.
- Geographies preserved: no semantic geo path; `_meta.tags.geographies.semanticApplied` is the on-the-wire tripwire.

### Phase 6 amendment — UI polish + trust-first empty states (2026-05-16)

**Status:** Shipped on `feat/meta-story-tags-phase1`; **Chunk K is still locked to K1a**. Phase 6 is a *front-of-house* slice — no server behavior changes, no semantic logic changes, no env flags. It closes the loop on Phase 1's "tags-only labels" decision by making sure every UI surface that renders a topic / geo label sources it from `story.tags`, surfaces a clear caption when stories arrive without tags, and never leaks operator-only diagnostics into the rendered output.

**What changed:**

- **Story detail chip row reads from `story.tags` only.** [`StoryDetail.tsx`](../../04-prototype/src/components/StoryDetail.tsx) used to render `<TopicTag topic={story.topic} />` and `<GeoStrip geographies={story.geographies} />` — the last UI surface still consuming the root fields. Now the topic chip comes from `story.tags.topics[0]` (settings spelling), the geo strip comes from `story.tags.geographies`, and the divider `|` is suppressed unless **both** axes are non-empty. The whole chip row is hidden entirely when both axes are empty — no orphan divider, no empty box.
- **`Tags.tsx` accepts open settings vocabulary.** [`TopicTag`](../../04-prototype/src/components/Tags.tsx) and [`GeoStrip`](../../04-prototype/src/components/Tags.tsx) used to require the legacy `Topic` / `Geography` enum types. They now accept arbitrary strings — necessary so Phase 3 geography aliases (`China`, `Latin America`, …) render correctly. `GeoTag` still emits the `US` / `CO` monogram for the original canonical pair; any other settings label is uppercased verbatim. Empty / whitespace-only entries render `null` so callers don't have to filter.
- **`derive.ts` analyst copy is tag-driven.** The `recommendedAction` copy in [`derive.ts`](../../04-prototype/src/lib/derive.ts) used `story.topic === "Diplomatic relations"` equality checks against the legacy root field. Switched to `story.tags?.topics?.includes(...)` so the analyst copy survives Phase 2's `topic`-is-optional contract and stays aligned with the UI's tags-only posture.
- **Trust-first empty-pill caption — [`Dashboard.tsx`](../../04-prototype/src/pages/Dashboard.tsx).** When stories exist but `aggregateTagSections` returns empty for every axis, a quiet caption ("No tag groups yet") surfaces next to the lone "All" pill so the missing pills don't read as a glitch. Suppressed entirely when any section has values, and never shown on the empty-dashboard / loading / error states (those have their own copy via [`EmptyState`](../../04-prototype/src/components/EmptyState.tsx) / [`LoadingState`](../../04-prototype/src/components/LoadingState.tsx) / [`ErrorState`](../../04-prototype/src/components/ErrorState.tsx)).
- **Pill row a11y.** `role="group"` + `aria-label="Filter stories by tag"` on the row. Empty caption carries `role="status"` so assistive tech announces the trust-first signal. Pills already had `aria-pressed`; added `type="button"` (defensive against future form-nesting) and `focus-visible:outline` for clearer keyboard focus.
- **Semantic diagnostics stay operator-only.** Audit confirms no UI surface reads `_meta.tags` (the operator-facing aggregate that carries `runtimeState`, `scorerLatencyMs`, `fallbackReasonCounts`, `semanticApplied`). Regression tests in [`Dashboard.test.tsx`](../../04-prototype/src/pages/Dashboard.test.tsx) and [`StoryDetail.test.tsx`](../../04-prototype/src/components/StoryDetail.test.tsx) assert those strings never appear in the rendered output.

**Tests added/updated:**

- 3 new cases in [`StoryCard.test.tsx`](../../04-prototype/src/components/StoryCard.test.tsx) under "Phase 6: scan-row is tags-only" — pin that the scan row reads exclusively from `story.tags`, never from root `story.topic` / `story.geographies`, even when the root fields are populated (defensive against Phase 1 fallback re-introduction).
- 7 new cases in a new [`StoryDetail.test.tsx`](../../04-prototype/src/components/StoryDetail.test.tsx) — topic chip sources from tags; geo strip sources from tags; alias-driven geos (`China`) render with the new open-string typing; chip row + divider hidden when both axes empty; divider suppressed when only one axis has tags; divider only renders when both are present; no semantic diagnostic strings appear in the rendered detail.
- 5 new cases in [`Dashboard.test.tsx`](../../04-prototype/src/pages/Dashboard.test.tsx) — empty-tag caption visibility on/off, pill-row a11y semantics, no diagnostics leak, no orphan section separators.

**Why this is still K1a:** Same closed-vocabulary contract, same one-way invariant, same settings-only output. Phase 6 changes how the UI *renders* tags — not what tags get emitted, gated, or scored. The Phase 1 "tags-only labels" decision is now consistently implemented across every label-bearing surface (header pills, scan row, story detail, analyst copy).

### Phase 7 amendment — rollout hardening + operational guardrails (2026-05-16)

**Status:** Shipped on `feat/meta-story-tags-phase1`; **Chunk K is still locked to K1a**. Phase 7 hardens the rollout posture introduced by Phases 4 / 5 without changing semantic logic. The companion operator-facing doc is [`runbook-semantic-tags.md`](runbook-semantic-tags.md) — read that before flipping a flag in production.

**What changed:**

- **End-to-end cancellation.** [`createEmbeddingSemanticScorer`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs) builds a per-call `AbortController` and threads its `signal` into `embedFn(texts, { signal })`. [`embedTexts`](../apps/api/src/ai/embeddings.mjs) and [`embedTextsWithOpenAI`](../apps/api/src/ai/providers/openai-embeddings.mjs) accept and forward the signal — on timeout the in-flight `fetch(...)` is cancelled, not just the surrounding Promise race. Existing callers (e.g. recall) that omit the second argument keep their original timeout-only semantics. The mapper tracks `timeoutFired` so an embedFn-side abort rejection still surfaces as `SemanticScorerTimeoutError` (correct fallback attribution).
- **Kill switch — `TEMPO_TAG_SEMANTIC_KILL_SWITCH`.** Resolved by [`resolveSemanticTagConfig`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs); when truthy, all per-axis flags are forced to `disabled` regardless of any other configuration. The pipeline surfaces `_meta.tags.killSwitchActive` so an operator can read kill-switch state directly from a snapshot.
- **Diagnostics schema version — `TAGS_DIAGNOSTICS_SCHEMA_VERSION` = `phase7-2026-05-16`.** Stamped on `_meta.tags.schemaVersion`. Bumped whenever the per-axis diag shape changes. Downstream consumers can detect contract drift without inspecting individual fields.
- **Latency observability.** `_meta.tags.{topics,keywords}.scorerCallCount` (so consumers derive average latency as `scorerLatencyMs / scorerCallCount`) and `scorerLatencyMaxMs` (worst single-call latency, surfaces tail outliers). The `[pipeline.tags]` log line carries both.
- **Telemetry-driven threshold tuning — [`semantic-tag-calibration.mjs --telemetry=<file>`](../apps/api/scripts/semantic-tag-calibration.mjs).** Reads observed `_meta.tags` snapshots (single object or array) and prints a per-axis advisory: HOLD / LOWER / RAISE / hold-and-investigate-latency. The heuristic is conservative — `< 50` candidates → HOLD (not enough signal); `> 5%` scorer timeouts → HOLD threshold + bump timeout; `> 35%` below-threshold + `< 15%` acceptance → LOWER; `> 85%` acceptance → RAISE; otherwise HOLD healthy band. Strictly advisory.
- **Internal-only debug endpoint — `GET /api/_debug/dashboard-tags`.** Gated on `TEMPO_DEBUG_TAGS_ENABLED=true` AND `NODE_ENV !== "production"`; authenticated. Returns the calling identity's last persisted `_meta.tags` only — never story content, source bodies, or selection meta. Server test asserts the gating + the no-leak invariant explicitly.
- **Runbook lock.** [`runbook-semantic-tags.md`](runbook-semantic-tags.md) codifies flag precedence (kill-switch > global > per-axis), staged rollout (Stage 0–5), rollback procedure (which flag for which symptom), calibration cadence, and the "geographies stay deterministic" tripwire.

**Why this is still K1a:** Phase 7 only hardens the operational envelope — cancellation, kill switch, schema version, and the debug endpoint do not touch the closed-vocabulary contract, the one-way invariant, or the tag-emission shape.  Test inventory lives next to the code; the canary is the regression *"K1a invariant under abort cancellation"*.

### Phase 8 (deferred — not in this slice)

> Forward-look. Not yet locked.

- **Semantic geography aliasing** — still deliberately out of scope. The deterministic alias map in [`geography-aliases.ts`](../packages/contracts/src/geography-aliases.ts) remains the only geo widening path.
- **Per-axis adaptive thresholds at runtime.** Phase 7 advises via the calibration harness; runtime adaptation (the system nudging its own thresholds based on its own diagnostics) is a larger commitment we have not validated.
- **Cross-run scorer cache.** Phase 5/7 cache is per-pipeline-call. Persisting label embeddings across runs (settings keywords rarely change) would save provider calls; defer until cost matters.

---

## Chunk L — Observability, scenarios, golden suites, model id in meta (**LOCKED**)

**Status:** **Locked** — **L1a**, **L2a**.

**Scope:** What operators and engineers can rely on to answer **“why did the dashboard look like this?”** — **server logs**, **`_meta` on dashboard JSON** (outside the strict `stories` contract), **product telemetry**, and the **golden / scenario map** promised from **J5a** and **Chunk N**. Does **not** redefine pipeline behavior (chunks **A–K**); **L** names surfaces and ownership.

### Contract reminder

[`dashboardPayloadSchema`](../packages/contracts/src/schemas.ts) validates **`contractVersion` + `stories` only**. **`_meta`**, **`_selectionMeta`**, **`_watermark`**, **`_lastCheckedAt`** are **response / persistence adjuncts** — clients should treat unknown `_meta` keys as **optional** (see [`server.mjs`](../apps/api/src/server.mjs) `attachInternalsToMeta`, refresh success branch).

### Current observability surfaces (reference)

**Structured console logs (pipeline)** — examples: `[pipeline.topic-keyword]`, `[pipeline.recall]`, `[pipeline.beat-fit]`, `[pipeline.grounding]`, `[pipeline.funnel]` (via [`formatFunnel`](../apps/api/src/dashboard/refresh-pipeline.mjs) / [`summarizeFunnel`](../apps/api/src/dashboard/refresh-pipeline.mjs)), `[pipeline.strict-empty]` when `stories=0`.

**`_meta` after successful refresh** ([`executeRefreshFlow`](../apps/api/src/server.mjs) `ran` branch) includes among others: `refreshedAt`, `lastCheckedAt`, `hasSnapshot`, **`selection`** (from pipeline `log.selection`), **`watermark`**, **`candidateCount`**, **`selectedFeedCount`**, **`beatFit`**, **`recall`** (embedding diagnostics + lexical `topicKeywordBreakdown`), **`funnel`** (per-stage counts + `primaryDropStage`, `executionMode`). Watermark short-circuit branches still attach **`recall` / `funnel` / `beatFit` / `selection`** when present so stable-empty snapshots stay debuggable.

**Product analytics:** e.g. `dashboard_refreshed` carries counts, **`clusterModel`**, grounding drops, watermark fields ([`server.mjs`](../apps/api/src/server.mjs) `trackServerEvent` call) — useful for aggregate health; **not** the same as per-response `_meta`.

**Ownership already promised**

- **J5a** — **Chunk L** maps **G1–G5** grounding scenarios to **named cases**, **log keys**, and **test IDs**.  
- **Chunk N** — model matrix + **eval gate on SKU change**; **L** references **N** for which model strings must appear where.

### Decision L1 — Model id on dashboard `_meta` (**locked: L1a**)

| Option | Behavior |
|--------|----------|
| **L1a** | **Spec + backlog:** extend refresh **`_meta`** to include at least **`clusterModel`** (and optionally embedding model id from recall config) on every successful refresh so **DC demo debugging** and **incident replay** do not depend on log scrapes or analytics alone. |
| **L1b** | (not chosen) **Status quo:** model id **telemetry-only** (`dashboard_refreshed`, console). |

**Locked:** **L1a** — *implementation backlog* (not yet required in code to close Chunk L spec).

### Decision L2 — Golden suite map + operator scenarios (**locked: L2a**)

| Option | Chunk L commits |
|--------|-----------------|
| **L2a** | Maintain a **living suite map** (table or linked doc under **L**) that traces: **funnel `primaryDropStage`**, **recall `degraded_reason` / lexical breakdown**, **beat-fit strict-empty**, **grounding `groundingDropReasons`**, **source selection** modes — each to **user-visible symptoms**, **log line patterns**, and **tests**. Incorporates **J5a G1–G5** rows. **Chunk N** links in when a row is model-SKU-sensitive. |
| **L2b** | (not chosen) Grounding-only map without full-funnel operator table. |

**Locked:** **L2a** — *suite map rows may be filled incrementally*; locking commits **ownership and scope**, not every row on day one.

### Spec blurb (paste-friendly)

> **Observability (v1):** Operators use **pipeline console logs** plus refresh **`_meta.selection`**, **`_meta.recall`**, **`_meta.beatFit`**, **`_meta.funnel`**, and **`_meta.watermark`** to diagnose empty or thin dashboards without re-running the batch. The strict dashboard **body** remains **`contractVersion` + `stories`**. Refresh **`_meta`** will include at least **`clusterModel`** on successful refresh (**L1a** — implementation backlog). **Chunk L** owns the **living golden/scenario map** (**L2a**) tied to **J5a**; **Chunk N** owns **model SKUs + eval-on-change**.

---

## Chunk N — Model matrix + eval gate on change (**LOCKED**)

**Status:** **Locked** — **N1a**, **N2** (SKU package), **N3a**.

**Scope:** Consolidate **deferred SKU decisions** from **E4a**, **I4a**, **F** (geo assessor), **L1a** (`clusterModel` on `_meta`), and **J** (future post-grounding copy LLM). **Does not** change pipeline behavior locked in **A–L**; names **which model touches which stage**, **recommended production SKUs** for the DC prototype, and **what must run before changing a SKU**.

**Out of v1 matrix (document only):** Post-grounding **editorial meta-copy** LLM (**Chunk J** deferral) — no SKU until product adds that stage.

### N vs **M** vs build (sequencing)

| Phase | What happens |
|-------|----------------|
| **Chunk N** | **Done** — matrix (**N1a**), prod SKUs + alternates (**N2**), eval-on-change (**N3a**). Design lock, not deployment. |
| **Chunk M (next)** | **Ordered implementation commits** after design lock — including **wiring real providers for prototype/staging** (env template, API keys, `TEMPO_AI_CLUSTER_MODEL`, embedding model, **no `TEMPO_AI_MOCK_ONLY`** on paths you test by hand), **L1a** `_meta.clusterModel`, **E**/**C**/**F** backlogs, etc. |
| **Build / test with real models** | Starts **after N + M are locked**, per your intent: first **M** slices should make **local + staging refresh** use the **N2a** SKUs, not mock clustering/embed defaults. |

**Mocks today:** Code **defaults** still point at **`mock-*`** (e.g. `TEMPO_AI_CLUSTER_MODEL` → `mock-anthropic-haiku`) so CI/dev can run without keys. **N2** names what **prototype and DC-facing testing** should use; **M** is where we **change defaults/env docs** so you actually run real providers on refresh. Optional: keep mocks **only** behind an explicit test flag for keyless CI — not the default path you use while building the product.

**Providers (no mixing):** **Anthropic** — onboarding extraction, **clustering**, **geo assessor**. **OpenAI** — **embedding recall only** (`TEMPO_OPENAI_EMBEDDING_MODEL`). Embedding is **not** an Anthropic model; earlier “Anthropic” mentions in **N** apply only to clustering/geo/onboarding paths.

### Reference matrix — AI touchpoints today (code / env)

| Stage | When it runs | Config today (env → interim default) | Consumer | Eval / tests today |
|-------|----------------|--------------------------------------|----------|-------------------|
| **Onboarding extraction** | Settings / narrative ingest (not per refresh story list) | `TEMPO_AI_CLASSIFIER_MODEL` → `anthropic:claude-opus-4-7`; `TEMPO_AI_CLASSIFIER_FALLBACK_MODEL` → `anthropic:claude-sonnet-4-6` ([`resolveExtractionChain`](../apps/api/src/ai/model-router.mjs)) | Onboarding routes | [`eval:onboarding-extraction`](../apps/api/src/ai/evals/README.md) + gold JSON |
| **Embedding recall** | Pre-clustering recall union (**E**) | `TEMPO_OPENAI_EMBEDDING_MODEL` → `text-embedding-3-small`; `TEMPO_EMBED_TOP_K` → **80**; `TEMPO_EMBED_MAX_ITEMS` → **250**; mode `TEMPO_RECALL_MODE` → **`hybrid_strict`** ([`resolveRecallConfig`](../apps/api/src/ingestion/embedding-recall.mjs)) | Refresh pipeline | [`embedding-recall.test.mjs`](../apps/api/src/ingestion/embedding-recall.test.mjs) |
| **Geo confidence** | Pre-clustering geo gate (**F**) | Injectable **`geoAssessFn`**; production **must** be non-mock (**F3b** — backlog); tests use mock | [`geo-filter.mjs`](../apps/api/src/dashboard/geo-filter.mjs) | [`geo-filter.test.mjs`](../apps/api/src/dashboard/geo-filter.test.mjs) |
| **Clustering** | Candidates → meta-stories (**I**) | `TEMPO_AI_CLUSTER_MODEL` → **`mock-anthropic-haiku`** in dev default ([`getAiCapabilityMap`](../apps/api/src/ai/model-router.mjs)); real path e.g. `anthropic:claude-haiku-4-5-20251001` in provider tests | [`clusterItems`](../apps/api/src/ai/cluster-engine.mjs) | [`cluster-engine.test.mjs`](../apps/api/src/ai/cluster-engine.test.mjs), pipeline tests |
| **Grounding** | Post-cluster trust (**J**) | **No LLM** — deterministic `verifyGrounding` | [`cluster-engine.mjs`](../apps/api/src/ai/cluster-engine.mjs) | **J5a** / **L2a** scenarios |
| **Shipped tags** | `buildStory` (**K**) | **No LLM** — `deriveStoryTags` | [`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs) | `deriveStoryTags` / pipeline tests |
| **Precision** | Beat-fit (**G**) | **Heuristic `beat-fit-v1`** — no LLM | [`beat-fit-scorer.mjs`](../apps/api/src/dashboard/beat-fit-scorer.mjs) | beat-fit + pipeline tests |
| **Observability** | Refresh response (**L**) | **`clusterModel`** on `_meta` (**L1a** — backlog); recall embed model in `log.recall` diagnostics today | [`server.mjs`](../apps/api/src/server.mjs) | — |
| **Post-grounding copy** (future) | After **`grounding-passed`**, before or inside `buildStory` | **Not implemented** | — | **L** goldens when added |

**Dev / CI note:** `TEMPO_AI_MOCK_ONLY=true` forces mock providers per [`providerFor`](../apps/api/src/ai/model-router.mjs). **Prototype posture (N2a):** hand testing and staging use **real** SKUs below; mocks are not the target experience after **M** wires env.

### Recommended v1 production SKUs (**locked: N2**)

Canonical targets for **staging / DC prototype** (env vars still override). **Supersedes** interim clustering SKU notes in **E4a** / **I4a** (Haiku examples in code comments/tests remain valid provider strings). **Chunk M** implements these on the paths you actually run.

| Stage | Provider | Env var(s) | **Primary (v1 prod)** | **Alternate** |
|-------|----------|------------|------------------------|---------------|
| **Onboarding extraction** | **Anthropic** | `TEMPO_AI_CLASSIFIER_MODEL`, `TEMPO_AI_CLASSIFIER_FALLBACK_MODEL` | `anthropic:claude-opus-4-7` → `anthropic:claude-sonnet-4-6` | Sonnet-only chain (if evals justify) |
| **Embedding recall** | **OpenAI** | `TEMPO_OPENAI_EMBEDDING_MODEL`, `TEMPO_EMBED_TOP_K`, `TEMPO_EMBED_MAX_ITEMS`, `TEMPO_RECALL_MODE` | **`text-embedding-3-small`**; top-K **80**; max items **250**; **`hybrid_strict`** | `text-embedding-3-large` |
| **Clustering** | **Anthropic** | `TEMPO_AI_CLUSTER_MODEL` | **`anthropic:claude-sonnet-4-6`** | `anthropic:claude-haiku-4-5-20251001` |
| **Geo assessor** | **Anthropic** | inject **`geoAssessFn`** (implement in **M**; **F3b**) | **`anthropic:claude-haiku-4-5-20251001`** (structured confidence prompt) | **Tiered:** Haiku for **implicit_geo**, Sonnet for **explicit_conflict** |
| **Grounding / tags / beat-fit** | — | — | **No LLM** (chunks **J**, **K**, **G**) | — |

**Keys (implementation):** `TEMPO_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` — onboarding, clustering, geo. `TEMPO_OPENAI_API_KEY` — **embeddings only** (see [`assertAiConfig`](../apps/api/src/ai/model-router.mjs)).

**L1a:** `_meta.clusterModel` on refresh should report **`anthropic:claude-sonnet-4-6`** once implemented.

### Decision N1 — Where the canonical matrix lives (**locked: N1a**)

| Option | Behavior |
|--------|----------|
| **N1a** | This **Chunk N table** (updated as SKUs change) is the **spec SSOT** for “which stage / which env / recommended prod SKU.” Code keeps **env overrides**; **Chunk M** backlog items align defaults and **L1a** `_meta` fields to the table. |
| **N1b** | (not chosen) Matrix implicit in env vars + code only. |

**Locked:** **N1a**.

### Decision N2 — Recommended production SKUs + alternates (**locked**)

| Option | Behavior |
|--------|----------|
| **N2 (package)** | Lock **primary + alternate** SKUs in the table above (clustering **Sonnet 4.6**, embeddings **`text-embedding-3-small`**, onboarding **Opus → Sonnet**, geo **Haiku 4.5**). **Prototype/staging** uses **real** providers per this table after **Chunk M**. |
| **N2b** | (not chosen) Leave prod SKU names to ops only. |

**Locked:** **N2** (see **Recommended v1 production SKUs** table).

### Decision N3 — Eval gate when a SKU changes (**locked: N3a**)

| Option | Gate before merging a SKU / prompt change |
|--------|-------------------------------------------|
| **N3a** | **Minimum:** (1) **Existing automated tests** for that stage pass (`cluster-engine`, `embedding-recall`, `refresh-pipeline`, etc.). (2) **Onboarding extraction** changes → run **`npm run eval:onboarding-extraction`**. (3) **Clustering / embedding** changes → re-check **L2a** rows that are model-sensitive when those rows exist; add goldens incrementally in **L** — not blocking **N** lock. (4) **No new eval harness required** to close Chunk **N**. |
| **N3b** | (not chosen) **Strict:** checked-in gold + eval per LLM stage before prod SKU change. |
| **N3c** | (not chosen) Informal “run tests” only. |

**Locked:** **N3a**.

### Spec blurb (paste-friendly)

> **Model matrix (v1):** **OpenAI** `text-embedding-3-small` semantic recall (**E**, `hybrid_strict`; alt **large**). **Anthropic** clustering **`anthropic:claude-sonnet-4-6`** (**I**; alt Haiku 4.5); geo assessor **`anthropic:claude-haiku-4-5-20251001`** (**F**; alt tiered Haiku/Sonnet); onboarding **`anthropic:claude-opus-4-7` → `anthropic:claude-sonnet-4-6`**. **Heuristic beat-fit** (**G**), **deterministic grounding** (**J**), **evidence-only tags** (**K**). **Eval-on-change:** **N3a** — stage tests + onboarding eval + **L2a** over time. **`_meta.clusterModel`** (**L1a**) = clustering SKU after **M**. Real providers wired in **M**, not mock defaults on paths you test.

---

## Chunk M — Ordered commits after design lock (**LOCKED**)

**Status:** **Locked** — **M1b** (real-first sequencing). Execute commits **M1 → M8** in table order below.

**Scope:** Turn locked chunks **A–N** into a **build sequence** — not new product decisions. Each commit should be **reviewable**, keep **`npm run test:api`** green (**N3a**), and move prototype/staging to **real providers** per **N2**.

**Spec ↔ code gap table (historical — all rows closed by M1–M8):**

| Spec (locked) | Status | Commit |
|---------------|--------|--------|
| **E3b** — empty profile → **pass lexical** | ✅ Closed | **M5** |
| **C2** — zero configured sources → **fail-closed** | ✅ Closed | **M6** |
| **F3b** — non-mock `geoAssessFn` | ✅ Closed | **M4** |
| **N2** — Sonnet clustering SKU | ✅ Closed | **M2** |
| **L1a** — `clusterModel` on `_meta` | ✅ Closed | **M3** |

**Already aligned (no M commit required for spec):** **J1a–J3b**, **K1a**, **G/H/I** behavior covered by existing tests unless prompts change.

### Decision M1 — Commit sequencing strategy (**LOCKED: M1b**)

| Option | Order philosophy |
|--------|------------------|
| **M1a** | **Spec-first:** fix **C2**, **E3b**, **geo** before turning on real LLMs — safest FP posture, slower to see real clustering. |
| **M1b** ✓ | **Real-first:** wire **env + real SKUs + `_meta`** (**M1–M3**) early so DC testing uses **Sonnet** / **small** embed; then **geo** (**M4**) and spec alignment (**M5–M6**). Matches **N2** “build with real models.” |
| **M1c** | **Single slice:** one large PR with all items below — faster, harder review. |

### Locked commit map (**M1b** order)

| # | Commit (suggested title) | Delivers | Locks / chunks |
|---|--------------------------|----------|----------------|
| **M1** | `docs: DC prototype env in Slice 15/16 (N2 real providers)` | Patch [MODE2-SLICE-15](../MODE2-SLICE-15-BETA-READINESS-CHECKLIST.md) + [MODE2-SLICE-16](../MODE2-SLICE-16-STAGING-HANDOFF.md): pool SKUs, keys, smoke (`GET /api/ai/models`, refresh + `_meta`); **`TEMPO_AI_MOCK_ONLY` unset** for DC hand-testing | **N2**, **N1a**, **C1** |
| **M2** | `api: use N2 clustering SKU on refresh path` | Pass **`clusterModel`** from `getAiCapabilityMap().clustering` (already wired); document that staging **must** set env; optional: change dev default away from mock **only** when keys present (or leave mock default + env override) | **N2**, **I** |
| **M3** | `api: expose cluster + embedding model ids on refresh _meta` | **`_meta.clusterModel`**, **`_meta.embeddingModel`** (or under `_meta.recall`) on successful refresh + watermark-skip branch | **L1a**, **N2** |
| **M3b** | `api: persist last-run diagnostics on dashboard snapshot (P1)` | On successful **`writeSnapshot`**, persist into snapshot **`_meta`**: **`funnel`**, **`recall`**, **`beatFit`**, **`clusterModel`**, embedding model id — same shape as POST refresh response so **GET /api/dashboard** can explain the last run without re-executing the pipeline. *Code in **M**; build/review per team workflow — not pre-coded in design pass.* | **L**, audit / “what happened” |
| **M4** | `api: Haiku geoAssessFn for production path` | Implement **`assessGeoConfidence`** (Haiku structured `{ confidence }`); inject in [`server.mjs`](../apps/api/src/server.mjs) instead of mock; tests with stubbed LLM | **F3b**, **N2** geo row |
| **M5** | `api: embedding recall empty profile → pass lexical (E3b)` | When `buildProfileText` empty, return **`keywordRecallItems`** + diagnostic `empty_profile_text_lexical_only`; **update tests** that expect fail-closed | **E3b** |
| **M6** | `api: fail-closed zero configured sources (C2)` | **`selectSourcePool`**: if traditional + social both empty → **[]**; manifest path aligned; tests | **C2** |
| **M6b** | `api: T1 + R1 story ordering in buildStory / payload` | **T1:** sort each story’s **`sources[]`** — weight ↓, `minutesAgo` ↑. **R1:** sort **`stories[]`** — max `beatFitScore` → min `minutesAgo` → `metaStoryId`. Tests; align prototype with server order (no client re-sort for v1). | **T1**, **R1** |
| **M7** | `docs: extend L2a scenario map (initial rows)` | Expand [dashboard-story-pool-scenario-map.md](dashboard-story-pool-scenario-map.md): funnel drops, new failure modes from DC — **living doc**, not blocking ship | **L2a**, **J5a**, **B1** |
| **M8** | *(optional)* `api: cluster-engine eval smoke` | Minimal script or test fixture for **Sonnet** clustering JSON shape — only if needed before DC sessions; **N3a** does not require for **N** lock | **N3a**, **I** |

**Execution snapshot (2026-05-15):** **M1–M8 complete**. Onboarding extraction eval recovered to threshold (`14/20`, `70.0%`), and M8 shipped as a durable cluster-shape smoke harness (`eval:cluster-smoke`).

**After M1–M6 (minimum):** Run refresh against **real feeds** with Anthropic + OpenAI keys; confirm **`_meta`** shows Sonnet + embedding model; verify geo holds/pass; re-run **`npm run test:api`** and **`eval:onboarding-extraction`** if extraction prompts touched. During **M** build verification: ingestion/manifest smoke (feed health, source match) per Slice 16 — not a separate design chunk.

### Product ordering (**locked: T1, R1** — implement **M6b**)

| ID | Rule | Where |
|----|------|--------|
| **T1** | Per meta-story: **`sources[]`** = **weight ↓**, **`minutesAgo` ↑** | `buildStory` |
| **R1** | Dashboard: **`stories[]`** = max **`beatFitScore`** → min **`minutesAgo`** → **`metaStoryId`** | Before snapshot write |

Details: [dashboard-story-pool-spec.md](dashboard-story-pool-spec.md).

**Out of M (later product):** Post-grounding **LLM meta-copy** (**J** deferral, **N** matrix); **J5c**-style golden manifest; beat-fit **LLM** successor (**G3a**).

### Post-walkthrough artifacts (**locked: A1, B1, C1**)

| Decision | Choice | Artifact |
|----------|--------|----------|
| **A1** | One-page engineer **pool spec** (gates, SKUs, eval posture) | [dashboard-story-pool-spec.md](dashboard-story-pool-spec.md) — links to walkthrough for rationale |
| **B1** | **Minimal goldens:** unit tests + living **L2a** map; add gold files on repeat failures — **not** blocking **M1–M6** | [dashboard-story-pool-scenario-map.md](dashboard-story-pool-scenario-map.md) (seed rows); onboarding eval unchanged |
| **C1** | Keys / “models operational” in **existing** Slice **15** (local) + **16** (staging) | **M1** patches those docs; no separate secrets file in repo |

**A1 / B1 seed docs** exist before code commits; **M7** extends the scenario map as DC surfaces new cases.

### Spec blurb (paste-friendly)

> **Build sequence (M):** Slice 15/16 env → model ids → **P1 persist diagnostics (M3b)** → geo → **E3b** / **C2** → **T1/R1 ordering (M6b)** → **L2a** map. **N3a** per commit.

---

## Post-walkthrough

Design walkthrough chunks **A–N** and commit map **M** (**M1b**) are locked. **Artifacts:** [pool spec](dashboard-story-pool-spec.md), [scenario map](dashboard-story-pool-scenario-map.md) (**A1**, **B1**). Execute **M1 → M8** in order when building; maintain **L2a** / **N3a** as the system evolves.

---

## LLM, golden sets, model matrix (plan agreement — summary)

- Model **whether/when/which SKU** per stage is explicit; doc + central code config + `_meta`/logs for model id/version.  
- **Golden / eval suites** for high-variance stages (I, **J** — **J5a** → **L** **L2a** suite map, **K** locked, optionally E); FP-first bias toward **must-not-ship** cases; grow from repeat failures.  
- **Chunk N** consolidates the model matrix (**locked** — **N1a**, **N2**, **N3a**); **Chunk L** owns suite map and scenarios.

(See project plan in Cursor: `dashboard_pool_walkthrough` plan file if present.)

---

## Phase 3 addendum — Spanish-readiness (Slices 13–15)

Phase 3 adds non-English source support **without** changing the funnel chunks above. The pipeline gains one new stage and an output guardrail; everything else (recall, beat-fit, clustering, grounding) is unchanged.

- **Translation stage — post-geo, pre-recall.** [`evidence-translator.mjs`](../apps/api/src/ingestion/evidence-translator.mjs) runs after the geo filter and **before** lexical + embedding recall, so English settings can match Spanish items. It translates only non-English items (keyed on `item.lang`, e.g. `es`) on a bounded evidence budget (headline + first 2 snippets, ~700 chars). Execution is bounded (concurrency + per-item timeout) and **fail-open**: a translation error/timeout leaves the item untranslated and never blocks the refresh.
- **Dual-text retention.** Originals (`headline`/`body`) are untouched for **display**; the English normalization lands on `normalizedHeadline`/`normalizedBody`. Recall + writers read normalized-when-present via `readHeadline`/`readBodyText` (English-native items fall back to originals — a no-op).
- **`_meta.translation` diagnostics.** Per-run coverage + per-story translated-source coverage. A story is full-confidence at **≥ 60%** translated-source coverage; below that it is flagged degraded/low-confidence (the translated subset still ships — no hard block).
- **English-output guardrail (Slice 15).** Clustering (`CLUSTERING_PROMPT_VERSION = cluster-v3`) and the whatChanged writer emit English `title`/`subtitle`/`summary`/`whatChanged` even when sources are Spanish, grounding on the normalized EN evidence. The whatChanged **structural gate stays on the raw headline** so delta detection is language-stable across refreshes. Meta-story copy is English; Spanish appears only in source headlines/bodies.
- **Code default OFF; enabled in preview + production (Sprint B1).** Production translation is gated by `TEMPO_TRANSLATION_ENABLED` (code default OFF). **Phase 4 S0** wired the production `translateFn` (OpenAI-backed); **Slices 16–18** activated the 6 Spanish feeds (La Silla Vacía, Semana, Infobae) — now `active=true`, `lang=es` in the manifest. **Sprint B1** flips `TEMPO_TRANSLATION_ENABLED=true` in both preview and production under controlled monitoring, enabling ES→EN evidence normalization pre-recall; rollback is the same flag set to `false`. See [`runbook-translation-activation.md`](runbook-translation-activation.md).

Rationale: [D-067](../DECISIONS.md) (translation-first normalization), [D-068](../DECISIONS.md) (English meta-story output + translated-evidence writer inputs).
