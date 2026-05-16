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
| **Lexical (D)** | Whole-word match (`\b<token>\b`), case-insensitive; topics/keywords **OR** when both configured; **noop** if both empty. Breadth comes from the embedding union, not from substring matching. |
| **Embedding (E)** | `hybrid_strict`: union semantic top-K with lexical recall. **Empty profile** → **E3b** lexical-only pass-through (`degraded_reason: "empty_profile_text_lexical_only"`); **provider failure with lexical hits** → lexical fallback flagged `keywordFallbackAfterEmbeddingFailure: true`; **provider failure with no lexical hits** → strict-empty. |
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

`tags` = **settings ∩ evidence** only. Tags **do not** widen pool, recall, or clustering.

**Trust posture (Phase 1 + 2 — 2026-05-16):**

- Shipped stories **always carry the three-axis `tags` object** ([`storySchema.tags` is required](../packages/contracts/src/schemas.ts) — `{ topics: [], keywords: [], geographies: [] }` when no evidence on an axis).
- **UI labels (header pills, scan-row chips) read from `tags` only.** Root [`story.topic`](../packages/contracts/src/schemas.ts) and `story.geographies` are retained on the wire for lineage continuity ([`prior.topic`](../apps/api/src/dashboard/refresh-pipeline.mjs) in the keyed-merge code) but are **not authoritative** for any UI semantics. See [`dashboard-filters.ts`](../../04-prototype/src/lib/dashboard-filters.ts).
- **No fabricated defaults.** The legacy `?? "Diplomatic relations"` fallback in [`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs) is gone — when no source item carries a recognized canonical topic, `story.topic` is omitted entirely (the field is `optional` on the wire). Default settings are fully empty (no seed taxonomy / no seed sources).
- **Legacy snapshots normalize at load.** The snapshot loader ([`dashboard-snapshot-repo.mjs`](../apps/api/src/db/dashboard-snapshot-repo.mjs)) coerces missing or partial `tags` to the three-axis empty shape before validation. No destructive write-time migration; this is a read-time guard so the strict display schema can assume the field.

**Phase 3 — meta-story-level tag assignment + deterministic geo aliasing (shipped — 2026-05-16):**

- Production tag emission moved from source-only [`deriveStoryTags`](../apps/api/src/dashboard/refresh-pipeline.mjs) to **meta-story-level** [`assignMetaStoryTags`](../apps/api/src/dashboard/meta-story-tags.mjs), wired into [`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs). The new assigner reads the **evidence bundle text** ([`buildMetaStoryEvidenceText`](../apps/api/src/dashboard/meta-story-tags.mjs)) — meta-story title + subtitle + summary + source headlines/body — and combines it with the source structural fields (`source.topic`, `source.geographies`).
- **Settings vocabulary stays the only output vocabulary.** Every emitted axis is a subset of the matching `settings.*` list; emission uses the user's settings casing.
- **Deterministic geography alias map** ([`geography-aliases.ts`](../packages/contracts/src/geography-aliases.ts) — `resolveGeographyAlias`): tokens like `Beijing`, `Montevideo`, `Tokyo` map to canonical labels (`China`, `Latin America`, `Japan`) and are emitted **only** when the canonical label is present in `settings.geographies`. The alias surface form itself is never emitted.
- **Keywords remain deterministic only in Phase 3.** Whole-word phrase match against `settings.keywords` in the evidence bundle. Semantic synonym widening (e.g. `petroleum` evidence → `oil` tag when "oil" is in settings) is **explicitly Phase 4** — a regression test in [`refresh-pipeline.test.mjs`](../apps/api/src/dashboard/refresh-pipeline.test.mjs) (*"Phase 3 wiring: 'petroleum' in text + 'oil' in settings emits NO keyword tag"*) locks this boundary so a future change cannot accidentally light up semantic matching here.
- **K1a still holds.** The new assigner is a richer *evidence-to-tags* step; the one-way invariant (tags never widen pool/recall/clustering/dedupe) is unchanged. Source-only [`deriveStoryTags`](../apps/api/src/dashboard/refresh-pipeline.mjs) remains exported as a back-compat helper.

**Phase 4 — constrained semantic mapping for topics + keywords (shipped — 2026-05-16, default OFF):**

- New module [`meta-story-semantic-mapper.mjs`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs) exports `mapSemanticAxis`, `mapSemanticTopicsAndKeywords`, and `resolveSemanticTagConfig`. The mapper accepts an **injected scorer** `(evidenceText, candidateLabel) → number | Promise<number>` so production can wire embedding similarity / a constrained classifier while tests inject deterministic fixtures.
- **Closed-vocabulary by construction.** The mapper scores candidates only against `settings.topics` / `settings.keywords` — it can never propose an out-of-settings label. Threshold-gated: accept iff `score >= threshold`; below-threshold candidates are dropped and counted in diagnostics.
- **Phase 3 deterministic baseline always runs first.** Semantic uplift ADDs settings-constrained labels; it never removes a deterministic match. Already-deterministic labels are skipped (no rescoring, no double-count).
- **Geographies stay deterministic-only** — Phase 4 explicitly does NOT introduce a semantic geography path. The runtime aggregate carries an explicit `geographies.semanticApplied: false` stamp ([`_lastRunMeta.tags`](../apps/api/src/db/dashboard-snapshot-repo.mjs) → `_meta.tags`) so operators can see the lock hasn't drifted.
- **Env flags + thresholds** (default OFF):
  - `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED` — global gate.
  - `TEMPO_TAG_SEMANTIC_TOPICS_ENABLED` / `TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED` — per-axis gates (AND with the global flag).
  - `TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD` / `TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD` — `[0,1]` cut-off, default `0.75`.
- **Diagnostics aggregated per run.** [`runRefreshPipeline`](../apps/api/src/dashboard/refresh-pipeline.mjs) collects per-axis aggregates (`candidateCount`, `acceptedCount`, `rejectedCount`, `belowThresholdCount`, `enabled`, `threshold`) and surfaces them via `log.tags` → `_lastRunMeta.tags` → `_meta.tags`. The pipeline also emits a `[pipeline.tags]` log line per refresh.
- **K1a one-way invariant unchanged.** Semantic uplift runs **after** clustering / grounding inside the per-story tag overlay — it cannot change funnel counts or admission. A regression case in [`refresh-pipeline.test.mjs`](../apps/api/src/dashboard/refresh-pipeline.test.mjs) (*"Phase 4 wiring: semantic uplift does NOT change funnel / admission counts"*) locks this.

**Phase 5 — production scorer wired + fail-closed + calibration harness (shipped — 2026-05-16, default OFF):**

- **Production scorer (embedding cosine similarity).** [`createEmbeddingSemanticScorer`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs) wraps the existing [`embedTexts`](../apps/api/src/ai/embeddings.mjs) (same provider used by recall) in: per-call timeout (`SemanticScorerTimeoutError`), evidence text truncation (`maxEvidenceChars`), and an internal vector cache for evidence + label so repeated probes within a run don't re-embed. Cosine `[-1,1]` is rescaled to `[0,1]` so thresholds keep their existing scale.
- **Server wiring — [`server.mjs`](../apps/api/src/server.mjs).** When `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED` AND any per-axis flag are truthy AND no test scorer is injected, the route handler attaches a production `semanticTagScorer` automatically. Tests continue to inject deterministic scorers; both paths share the mapper.
- **Fail-closed semantics.** Scorer timeout / error never breaks refresh. The mapper categorizes each failure (`fallbackReasonCounts: {timeout, error}`) and derives a per-axis `runtimeState` ∈ `{disabled, enabled_no_scorer, enabled_scorer_ready, scorer_error_fallback, scorer_timeout_fallback}`. Worst-observed state across the run is what surfaces in `_meta.tags`. **Deterministic baseline always ships** — pipeline regression *"funnel counts identical for scorer-OFF vs scorer-FAIL"* locks this.
- **New env vars** (defaults conservative; document at-call-time semantics):
  - `TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS` — per-scorer-call timeout (default `1500`).
  - `TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS` — evidence text cap before embedding (default `4000`).
- **Operator observability.** `[pipeline.tags]` log line now carries `runtime_state / accepted / rejected / below_threshold / latency_ms / timeouts / errors` per axis. `_meta.tags` carries the same shape + `geographies.semanticApplied: false`.
- **Calibration harness — [`semantic-tag-calibration.mjs`](../apps/api/scripts/semantic-tag-calibration.mjs).** Operator tool (NOT exercised in CI). Runs the mapper against a curated fixture set ([`semantic-tag-calibration-fixtures.json`](../apps/api/scripts/semantic-tag-calibration-fixtures.json)) across candidate thresholds, prints a confusion-style summary, and recommends the highest threshold whose recall is within 5pp of the best observed. Supports `--provider=mock|embeddings`.
- **K1a one-way invariant unchanged.** Semantic overlay still runs strictly post-clustering. Regression *"funnel counts identical for scorer-OFF vs scorer-FAIL"* compares ON-with-failure vs OFF baseline and asserts identical funnel stages + `metaStoryCount`.
- **Geographies remain deterministic-only.** No Phase 5 scope drift; the `geographies.semanticApplied: false` stamp is asserted in pipeline tests for both successful-scorer and aggressive-scorer paths.

**Recommended rollout sequence (operator runbook):**

1. **Staging — scorer wiring smoke.** Set `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED=true` but leave both per-axis flags OFF. Pipeline still produces deterministic tags; `_meta.tags.{topics,keywords}.runtimeState=disabled` confirms wiring without any uplift.
2. **Staging — calibration.** Run [`semantic-tag-calibration.mjs --provider=embeddings`](../apps/api/scripts/semantic-tag-calibration.mjs) against the curated fixtures (extend the fixture set with real product evidence). Use the recommended-threshold output as the starting point for `TEMPO_TAG_SEMANTIC_*_THRESHOLD`.
3. **Staging — topics axis on.** `TEMPO_TAG_SEMANTIC_TOPICS_ENABLED=true`. Monitor `_meta.tags.topics.{acceptedCount, belowThresholdCount, fallbackReasonCounts, runtimeState}`. Watch for `scorer_timeout_fallback` — if observed, bump timeout or open a provider ticket.
4. **Staging — keywords axis on.** Same monitor, with extra attention to precision (a bad chip on the scan row is more visible than a missed one).
5. **Production — staged.** Flip the global flag in prod; leave per-axis flags off; verify wiring. Then enable topics, then keywords, one at a time. Roll back by toggling the per-axis flag to false — no code deploy needed.

**Phase 6 — UI polish + trust-first empty states (shipped — 2026-05-16):**

- Front-of-house slice; no server behavior, semantic logic, or env-flag changes.
- **Every label-bearing UI surface is tags-only.** [`StoryDetail.tsx`](../../04-prototype/src/components/StoryDetail.tsx) chip row sources from `story.tags.topics[0]` + `story.tags.geographies` (no root-field reads); [`Tags.tsx`](../../04-prototype/src/components/Tags.tsx) accepts open settings strings so Phase 3 geo aliases render; [`derive.ts`](../../04-prototype/src/lib/derive.ts) analyst copy reads `story.tags.topics` (no `story.topic` equality).
- **Empty-tag caption** on the pill row ("No tag groups yet") surfaces when stories exist but every tag axis is empty — quiet trust-first signal, suppressed when any section has values.
- **A11y polish.** `role="group"` + `aria-label` on the pill row; `role="status"` on the caption; `type="button"` and `focus-visible:outline` on Pill.
- **No diagnostics leak.** Regression tests in [`Dashboard.test.tsx`](../../04-prototype/src/pages/Dashboard.test.tsx) + [`StoryDetail.test.tsx`](../../04-prototype/src/components/StoryDetail.test.tsx) assert operator-only strings (`runtimeState`, `scorerLatencyMs`, `semanticApplied`, …) never appear in the rendered output.

**Phase 7 — rollout hardening + operational guardrails (shipped — 2026-05-16):**

- **End-to-end cancellation.** [`createEmbeddingSemanticScorer`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs) creates a per-call `AbortController` and passes its `signal` into `embedFn(texts, { signal })`. When the timeout fires, the controller aborts — [`embedTexts`](../apps/api/src/ai/embeddings.mjs) and [`embedTextsWithOpenAI`](../apps/api/src/ai/providers/openai-embeddings.mjs) both forward the signal to `fetch(...)`, so the in-flight HTTP request is actually cancelled. Implementations that ignore the signal still degrade fail-closed; cancellation is an additive cost / latency optimization on top of the existing timeout contract.
- **Kill switch — `TEMPO_TAG_SEMANTIC_KILL_SWITCH`.** When truthy, every per-axis flag is forced to `disabled` regardless of any other configuration. Distinct from `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED` so a misconfigured deploy can't accidentally turn semantic uplift back on. Surfaced as `_meta.tags.killSwitchActive`.
- **Diagnostics schema version.** [`TAGS_DIAGNOSTICS_SCHEMA_VERSION`](../apps/api/src/dashboard/meta-story-semantic-mapper.mjs) is stamped on `_meta.tags.schemaVersion` so downstream consumers (dashboards, log scrapers) can detect contract changes without inspecting every field.
- **Latency observability.** `_meta.tags.{topics,keywords}.scorerCallCount` + `scorerLatencyMaxMs` join the existing cumulative `scorerLatencyMs` so operators can derive average latency AND read tail-latency outliers from a single payload.
- **Telemetry-driven threshold tuning.** [`semantic-tag-calibration.mjs --telemetry=<file>`](../apps/api/scripts/semantic-tag-calibration.mjs) reads `_meta.tags` snapshots and prints a per-axis "HOLD / LOWER / RAISE" recommendation based on observed acceptance / below-threshold / timeout ratios. Strictly advisory — never auto-edits env config.
- **Internal-only debug endpoint.** `GET /api/_debug/dashboard-tags` ([`server.mjs`](../apps/api/src/server.mjs)) returns the calling identity's last persisted `_meta.tags`. Gated on BOTH `TEMPO_DEBUG_TAGS_ENABLED=true` AND `NODE_ENV !== "production"`; authenticated; returns 404 when either gate fails. Story content / source bodies never appear in the response.
- **Operator runbook — [`runbook-semantic-tags.md`](runbook-semantic-tags.md).** Codifies flag precedence, staged rollout, rollback procedure, calibration cadence, and the "geographies remain deterministic" lock.
- **K1a one-way invariant unchanged.** Regression *"K1a invariant under abort cancellation"* compares funnel counts under an aborting scorer to the scorer-OFF baseline and asserts they match.

**Phase 8 (deferred — not in this slice):**

- **Semantic geography aliasing** — still deliberately out of scope. The deterministic alias map in [`geography-aliases.ts`](../packages/contracts/src/geography-aliases.ts) remains the only geo widening path.
- **Per-axis adaptive thresholds at runtime.** Phase 7 advises via the calibration harness; runtime adaptation (the system automatically nudges its own thresholds based on its own diagnostics) is a larger commitment we have not validated.
- **Cross-run scorer cache.** Phase 5/7 cache is per-pipeline-call. Persisting label embeddings across runs (settings keywords rarely change) would save provider calls; defer until cost matters.

---

## Models (prod SKUs — **N2**)

| Stage | Provider | Env | Primary |
|-------|----------|-----|---------|
| Onboarding extraction | Anthropic | `TEMPO_AI_CLASSIFIER_MODEL`, fallback | Opus 4.7 → Sonnet 4.6 |
| Embedding recall | **OpenAI** | `TEMPO_OPENAI_EMBEDDING_MODEL`, `TEMPO_EMBED_TOP_K`, `TEMPO_EMBED_MAX_ITEMS`, `TEMPO_RECALL_MODE` | `text-embedding-3-small`, **80**, **250**, **`hybrid_strict`** |
| Clustering | Anthropic | `TEMPO_AI_CLUSTER_MODEL` | `anthropic:claude-sonnet-4-6` |
| Geo assessor | Anthropic | injected `geoAssessFn`; optional `TEMPO_AI_GEO_ASSESS_MODEL` override | `anthropic:claude-haiku-4-5-20251001` |
| Grounding / beat-fit / tags | — | — | **No LLM** |

**Keys:** `TEMPO_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`) — Anthropic stages. `TEMPO_OPENAI_API_KEY` (or `OPENAI_API_KEY`) — embeddings only.

**DC prototype:** Do **not** set `TEMPO_AI_MOCK_ONLY=true` on paths you hand-test. CI may keep mocks via env in tests.

---

## Observability

Refresh **`_meta`** (not in strict `stories` contract): `selection`, `recall`, `beatFit`, `funnel`, `watermark`; plus **`clusterModel`** / embedding model id (**L1a**).

**`_meta.recall` fields** ([`embedding-recall.mjs`](../apps/api/src/ingestion/embedding-recall.mjs)):

| Field | Meaning |
|-------|---------|
| `mode` | `hybrid_strict` (default) or `keyword` (env `TEMPO_RECALL_MODE`) |
| `keywordRecallCount` | Lexical-only hits (whole-word recall, pre-union) |
| `embeddedCount` / `similarityKept` | Candidates embedded / semantic top-K kept |
| `unionCount` / `finalRelevant` | Post-union size = input to beat-fit |
| `degraded` / `degraded_reason` | Fail-closed enum: `embedding_unavailable_fail_closed`, `embedding_timeout_fail_closed`, `embedding_error_fail_closed`, `embedding_invalid_response_fail_closed`, `empty_profile_text_lexical_only` |
| `keywordFallbackAfterEmbeddingFailure` | `true` when provider failed but lexical had hits — operators see the cliff without losing the run |
| `profileAxes` / `profileAxisNames` / `profileTextLength` | Sparseness diagnostics — operator should read `0` as empty-profile path, `1` as degenerate semantic widen (still runs, low confidence), `≥2` as normal |
| `topicKeywordBreakdown` | Per-stage breakdown: `topicOnly`, `keywordOnly`, `both`, `neither`, `primaryDropCause` |

**Funnel naming note:** `_meta.funnel.afterTopicKeyword` is the **post-recall-stage count** (lexical-or-union, mode-dependent) — the legacy field/label name is retained for log-scraper compatibility. The split between lexical-only and post-union lives in `_meta.recall`. See [refresh-pipeline.mjs `FUNNEL_STAGES`](../apps/api/src/dashboard/refresh-pipeline.mjs).

Console logs + `_meta` answer “why 0 stories?” — see [scenario map](dashboard-story-pool-scenario-map.md).

---

## Onboarding extraction (open-vocabulary, hygiene-only)

**Canonical source:** comment block at the top of [`onboarding-extractor.mjs`](../apps/api/src/ai/onboarding-extractor.mjs). Do not duplicate the contract elsewhere; link to that file.

**Summary:**

- **No fixed allowlist gates.** `ALLOWED_TOPICS` / `ALLOWED_KEYWORDS` were removed in Phase 1. The extractor surfaces whatever the model emits, subject only to hygiene.
- **Hygiene-only post-processing:** trim → drop empty / whitespace-only / over-length / punctuation-only items → canonicalize via the `@tempo/contracts` normalizers → dedupe case-insensitive → stable sort → cap each axis at `MAX_LIST_SIZE = 24`.
- **Item bounds:** `MAX_ITEM_LENGTH = 64` chars; Unicode-safe junk filter (`\p{L}` / `\p{N}`) so non-Latin tokens survive.
- **Social handles:** pragmatic MVP shape — `@` + at least one letter/number + only letters/numbers/`_`/`.`/`-` after. Platform-neutral; downstream stages can revalidate.
- **Additive helpers** (`KEYWORD_PATTERNS`, `deriveTopicHints`, ICE/DIAN handle enrichment, WHO-handle anti-promotion) widen output when text matches; they never gate model output.

---

## Settings save to dashboard refresh

A successful debounced settings save in the prototype now **triggers a dashboard refresh immediately** (not waiting for the hourly heartbeat). See [`refresh-context.tsx`](../../04-prototype/src/lib/refresh-context.tsx) `triggerDashboardRefresh` and [`Settings.tsx`](../../04-prototype/src/pages/Settings.tsx) save success branch.

**Backend interaction:**

- The trigger calls `POST /api/dashboard/refresh` — same endpoint as the heartbeat. The backend runs the full pipeline; watermark short-circuit, recall diagnostics, and grounding all apply unchanged.
- Stale-revision and failed saves do **not** trigger the refresh.
- A subsequent `GET /api/dashboard` reads the freshly persisted snapshot (no re-execution).
- The bootstrap endpoint (`POST /api/dashboard/bootstrap`) is unaffected — it still decides between `served_fresh_snapshot` / `ran_refresh` / `no_snapshot` for Landing → Dashboard and Onboarding → Dashboard entries.

---

## Eval on change (**N3a**)

1. Stage **unit tests** pass (`npm run test:api`).
2. Onboarding prompt/model change → `npm run eval:onboarding-extraction`.
3. Clustering/embedding SKU change → re-check **model-sensitive** rows in scenario map; add goldens when repeat failures (**B1** — no full manifest gate in v1).

**Out of v1:** Post-grounding LLM meta-copy; **J5c** checked-in golden manifest (optional later).
