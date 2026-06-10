# Decisions log

Engineering and Tempo build-out decisions (intake, slices, tooling). Reverse chronological: newest first.

### 2026-06-09 - D-070 - Dashboard relevance phase 2: thin on-beat overflow + diagnostics contract

#### Context

- Phase 1 (D-069) aligned the dashboard on a **relevance-first** order: pre-cluster ranking ([`pre-cluster-relevance.mjs`](apps/api/src/dashboard/pre-cluster-relevance.mjs) via [`applyClusterInputCap`](apps/api/src/dashboard/refresh-pipeline.mjs)) and the post-cluster survival/display rank (`computeRelevanceScore` / `compareSurvivalRank`) both put the user's beat ahead of generic same-geography noise. But the survival cap still ranked **all** survivors purely by score: when the post-healer set overflowed `MAX_META_STORIES`, a generic Colombia weather/volcano row could still **backfill** a top slot behind one or two on-beat election stories. The cap removed *excess*, not *off-beat noise* — so under overflow the dashboard could ship geo-noise where the user expected only their beat.
- Phase 2 exists to close that backfill gap on top of the Phase 1 ranking, without disturbing the locked cap value, the deterministic ordering, or the latency posture.

#### Decision

- **Overflow guard (Decision 8C).** In the post-healer, pre-publish overflow stage ([`applyMetaStoryOverflowCap`](apps/api/src/dashboard/refresh-pipeline.mjs)), when the survivor set exceeds the cap **and at least one on-beat story exists**, geo-only / off-beat stories are removed from the **eligible** survivor set *before* final cap selection. "**Thin on-beat only**" is an allowed outcome — if only two of six overflow candidates are on-beat, just those two ship.
- **No on-beat fallback.** When **no** on-beat story exists (e.g. an all-geo overflow set), every story stays eligible and the prior pure-survival cap behavior is preserved. The guard **never forces an empty result** and is gated strictly on overflow (`> cap`) — the at-or-below-cap path is byte-identical to Phase 1.
- **On-beat definition.** A story is on-beat iff it corroborates the configured **topic or keyword** beat ([`isStoryOnBeat`](apps/api/src/dashboard/relevance-policy.mjs)), where grounded `associated_entities` may corroborate a topic/keyword concept. **Geography is deliberately excluded** — `scoreEntityFit` is *not* used for this classification because it folds geo into its evidence and would mis-rescue a geo-only row. With no topics and no keywords configured, the beat is undefined and every story counts as on-beat (the guard cannot suppress against an empty beat).
- **Diagnostics additions.** `_meta.overflowCap` carries additive guard indicators — `thinOnBeatGuardApplied` (true only when ≥1 geo-noise row was suppressed) and `thinOnBeatFilteredCount` — alongside the existing `overflowCapApplied` / `overflowInputCount` / `overflowOutputCount` / `overflowDroppedCount` / `overflowDroppedMetaStoryIds`. Suppressed rows still flow into the rejection log (`reason_code: "overflow_cap"`). `_meta.clusterCap` remains the Phase 1-enriched surface (`clusterDropped` explained drops + `clusterInputCapEffective`).
- **Contract typing.** [`dashboardClusterCapMetaSchema`](packages/contracts/src/schemas.ts) and its exported `DashboardClusterCapMeta` type cover the enriched cluster-cap drop diagnostics with `clusterDropped` / `clusterInputCapEffective` as **additive optionals**, so snapshots that predate them still validate (backward-compatible).

#### Why

- **Narrative trust:** under overflow the dashboard must not seat weather/volcano backfill over an election story the user actually follows; suppressing off-beat noise from survival is the direct fix.
- **Determinism + latency preserved:** the guard is a pure filter over already-computed signals — no new LLM/I/O call, the `MAX_META_STORIES` value and `compareSurvivalRank` tie-breaks are unchanged, and eligible survivors keep their R1 display order.
- **Backward compatibility:** every diagnostic/contract addition is additive-optional, so older payload readers and pre-existing snapshots keep validating.

#### Consequences

- A **sub-cap story count is acceptable** when only a few on-beat stories exist under overflow — that is the intended "thin on-beat only" outcome, not a regression.
- During manual validation, operators should inspect the debug rows — `cluster_cap` and `overflow_cap` — surfaced in the dashboard debug panel ([`DashboardRunDiagnostics.tsx`](../04-prototype/src/components/DashboardRunDiagnostics.tsx)) to see what was dropped and whether the thin on-beat guard fired.
- **Behavior is pinned by tests/evals:** the overflow-guard + `isStoryOnBeat` unit cases and the updated Q3A pipeline case in [`refresh-pipeline.test.mjs`](apps/api/src/dashboard/refresh-pipeline.test.mjs) (the geo-noise-only overflow now ships the lone election story), plus the cluster-cap-pressure scenario in the hermetic [`dashboard-elections-colombia.test.mjs`](apps/api/src/ai/evals/dashboard-elections-colombia.test.mjs) / [`dashboard-elections-colombia-core.mjs`](apps/api/src/ai/evals/dashboard-elections-colombia-core.mjs). The elections-colombia eval remains a required step of `eval:dashboard-quality-gate` (D-069), so this posture gates merges.

#### References

- [`apps/api/src/dashboard/refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) — `applyMetaStoryOverflowCap` thin on-beat guard + `_meta.overflowCap` diagnostics.
- [`apps/api/src/dashboard/relevance-policy.mjs`](apps/api/src/dashboard/relevance-policy.mjs) — `isStoryOnBeat` (topic/keyword-only on-beat classifier).
- [`apps/api/src/dashboard/refresh-pipeline.test.mjs`](apps/api/src/dashboard/refresh-pipeline.test.mjs) — guard unit + Q3A pipeline coverage.
- [`packages/contracts/src/schemas.ts`](packages/contracts/src/schemas.ts) — `dashboardClusterCapMetaSchema` + `DashboardClusterCapMeta`.
- [`04-prototype/src/components/DashboardRunDiagnostics.tsx`](../04-prototype/src/components/DashboardRunDiagnostics.tsx) — `cluster_cap` / `overflow_cap` debug rows.
- [`apps/api/src/ai/evals/dashboard-elections-colombia.test.mjs`](apps/api/src/ai/evals/dashboard-elections-colombia.test.mjs) + [`dashboard-elections-colombia-core.mjs`](apps/api/src/ai/evals/dashboard-elections-colombia-core.mjs) — cap-pressure assertions.

### 2026-06-08 - D-069 - Dashboard relevance strategy: locked Q1–Q6 implementation posture

#### Context

- The dashboard relevance work (Prompts 1–6) tuned recall, geo precision, cluster output, survival ranking, onboarding extraction, and acceptance testing for the Colombia-elections beat. The individual mechanisms landed across `relevance-policy.mjs`, `geo-filter.mjs`, `cluster-split-healer.mjs`, `refresh-pipeline.mjs`, `onboarding-extractor.mjs`, the cluster prompt (`cluster-v4`), and the eval suite. This entry records the LOCKED posture so the pieces are read as one strategy, not six unrelated slices.

#### Decision

- **Fixed cap of 5 (Q3).** The dashboard ships **AT MOST 5** meta-stories (`MAX_META_STORIES = 5`, unchanged). Overflow is decided by a deterministic **relevance-first survival rank** (`compareSurvivalRank`): `relevanceScore` DESC → `sourceCount` (corroboration) → beat-fit → freshness → `metaStoryId`. The same relevance order now also drives R1 **display** order (Prompt 2.1), so "what shows first" and "what survives the cap" agree.
- **B1 entity fit via grounded cluster tags (Q1).** The clustering schema/prompt emit `associated_entities` (`cluster-v4`, optional for back-compat). `computeRelevanceScore` weighs topic / keyword / **grounded-entity** / geo fit + corroboration + beat-fit + a small freshness term — entity fit comes from the cluster's own grounded output, **no static curated entity rosters**.
- **Soft lexical widen + tiered geo (Q2 + geo precision).** Recall widens via a bilingual lexicon (`relevance-policy.mjs`): English morphological forms widen the recall regex; EN↔ES pairs score fit but never enter the recall regex (the translation-first boundary stays intact). Geo is **tiered**: soft admission no longer gates relevance, but a deterministic `scoreGeoFit` **hard-fail** drops unambiguous explicit wrong-geography items before clustering (no LLM call).
- **Election-cycle bundling, unrelated-event split preserved (Q3B).** The split-healer bundles same-election-cycle pieces (shared election-cycle lexicon tokens) instead of atomizing them, while same-country UNRELATED events (election + mine attack) still split. Ambiguity/defer behavior is unchanged.
- **Conservative onboarding extraction (Q5).** Extraction stays single-pass and conservative (`extract-v8`): one bounded canonicalization (`election`/`elections` → topic `Elections`) plus deterministic recall hints and noise suppression; no second LLM pass.
- **Quality gate now includes elections-colombia (Q6B).** The Colombia-elections hermetic acceptance test is a required step of `eval:dashboard-quality-gate` (golden + spanish-recall + **elections-colombia** + calibration). It gates merges.
- **Live cluster monitor is ADVISORY / non-blocking (Q6D).** `eval:dashboard-live-cluster-advisory` makes the only live, provider-backed clustering call to detect prompt/model drift (B1 tags + entities present, sane merge). It is **not** in the quality gate and **not** a PR check; it SKIPs (exit 0) without a provider key, and exits 1 only so a scheduled nightly workflow can alert owners. It never blocks a merge.

#### Why

- Relevance-first ranking + a fixed cap keeps the dashboard focused on the user's beat (elections over generic same-geography noise) without unbounded growth.
- Grounding entity fit in the cluster's own output (not a curated roster) keeps the signal evidence-based and language-agnostic.
- Tiering geo (soft admission + deterministic hard-fail) preserves recall while cheaply removing confident wrong-geography items, with no added LLM cost.
- Splitting the acceptance test (hermetic, in the gate) from the drift monitor (live, advisory) keeps merges deterministic and key-free while still catching real prompt/model drift out-of-band.

#### Consequences

- **Blocking after this work:** `eval:dashboard-quality-gate` (golden + spanish-recall + elections-colombia + calibration) and the hermetic `npm test` suite — both run on PRs via `api-quality-gate.yml`, no provider keys.
- **Non-blocking:** `eval:dashboard-live-cluster-advisory` (live, advisory) and its nightly workflow; the standalone dual-beat / intra-beat / embassy-beat smokes; and the D3 quality advisory.
- The advisory's only live dependency is `TEMPO_ANTHROPIC_API_KEY` + a live `TEMPO_AI_CLUSTER_MODEL`; absent either, it self-skips green.

### 2026-05-30 - D-068 - English meta-story output + translated-evidence writer inputs (Slice 15)

#### Context

- Slice 14 (D-067) normalizes non-English source evidence to English (`normalizedHeadline`/`normalizedBody`) so recall admits Spanish items. But the clustering/writer stages still read raw `headline`/`body` and had no instruction to emit English.
- Locked product decision: dashboard meta-story fields (`title`, `subtitle`, `summary`, `whatChanged`, `whyItMatters`) stay **English**; Spanish appears only in the source `headline`/`body` shown on the card.

#### Decision

- **Clustering English-output guardrail.** Bumped `CLUSTERING_PROMPT_VERSION` `cluster-v2` → `cluster-v3`. `buildClusteringPrompt` now feeds the model normalized English evidence (`readHeadline`/`readBody`, falling back to originals for English items) and carries an explicit rule: when an article's headline/body is non-English, the meta-story `title`/`subtitle`/`summary`/`factual_claims` MUST still be English.
- **whatChanged evidence bundle.** The Haiku/Sonnet evidence bundle (`buildDeltaPayload`: headlines, headline-change strings, per-source excerpts) now reads normalized English via `readHeadline`/`readBodyText`. The deterministic **structural gate is unchanged** — it keeps comparing the raw `headline` so delta detection stays language-stable across refreshes (normalized text can re-translate run-to-run; raw text does not). The pipeline passes the writer a normalized-enriched clone of the story (`withNormalizedEvidence`); the response/persisted `story.sources` keep original-language text (no leak, no contract change).
- **whyItMatters.** The writer grounds on the (already-English) `summary` + `whatChanged` + structural `evidenceRefs` — it has no raw-source-text path — so it inherits English transitively from the two changes above. No why-engine logic change (why-it-matters logic is out of Slice 15 scope); a writer-input test pins that the grounding bundle is English for a Spanish-sourced story.

#### Why

- One narrative dashboard language for a bilingual operator: Spanish sources, English synthesis.
- Grounding writers on translated English evidence (not raw Spanish) keeps `summary`/`whatChanged` faithful to what recall actually matched.
- Keeping the structural gate on raw text avoids spurious "changed" flags from translation non-determinism.

#### Consequences

- Normalized fields never reach the client/snapshot — they ride only on the in-pipeline writer clone.
- Production translation is still default-OFF and Spanish feeds inactive until Phase 4; this slice is the English-output readiness layer.

### 2026-05-30 - D-067 - Translation-first evidence normalization (ES→EN) for recall

#### Context

- Phase 3 adds Spanish publishers (La Silla Vacía, Semana, Infobae). Recall — the lexical keyword/topic gate plus embedding similarity — consumes source item *text*. A Spanish RSS item never matches an English user keyword ("migración" ≠ "migration"), so it is dropped before the precision stages (beat-fit, clustering, grounding) can see it.
- A bilingual keyword dictionary as the primary mechanism doesn't scale across beats/languages and duplicates the recall machinery.

#### Decision

- **Translation-first**: normalize non-English evidence to English BEFORE recall, then run the existing (English) recall machinery unchanged. New stage [`evidence-translator.mjs`](apps/api/src/ingestion/evidence-translator.mjs), wired into [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) after the geo filter and before semantic scoring + recall.
- **Bounded evidence budget**: translate `headline + first 2 body snippets`, capped at ~700 chars.
- **Dual-text retention**: originals (`headline`/`body`) are never mutated; English lands on `normalizedHeadline`/`normalizedBody`. Text-consuming recall surfaces (`buildItemText`, `applyTopicKeywordFilter`, `analyzeTopicKeywordStage`, `joinGeoText`) read normalized-when-present and fall back to originals, so English items are untouched.
- **Bounded + fail-open**: bounded concurrency + per-call timeout + cache keyed by stable source id + text hash. A translation error/timeout leaves the item untranslated (recall still decides admission) and is recorded in diagnostics — translation NEVER blocks a refresh.
- **Coverage / confidence**: per-story translated-source coverage; `≥60%` → full confidence, `<60%` → degraded/low-confidence markers in `_meta.translation.stories` (the translated subset still ships — no hard block, no blank-by-default).
- **Observability**: `_meta.translation` surfaces coverage, translated/failed/timeout counts, cache hits, degraded fallback rate, and latency p50/p95.
- **Default OFF** in production (`TEMPO_TRANSLATION_ENABLED`); Spanish feeds remain inactive until Phase 4. Tests inject a deterministic `translateFn` + enabled config.
- **Onboarding extraction** now normalizes `topics`/`keywords` to English even for non-English input (prompt bumped `extract-v6` → `extract-v7`), so the onboarding `spanish_sources` eval bucket is re-tightened to all-fields-strict (topics/keywords no longer advisory).

#### Why

- Reuses one recall path for every language instead of forking a bilingual keyword path.
- Dual-text keeps Spanish source headlines/bodies intact for display while giving recall an English signal; meta-story copy stays English (Slice 15 owns cluster/writer guardrails).
- Fail-open + bounded execution protect refresh latency/availability; coverage markers keep trust honest when translation is partial.

#### Consequences

- New hermetic eval `eval:dashboard-spanish-recall` proves Spanish items reach clustering via normalized EN (and would not without it), plus the degraded partial-failure path.
- No feed-manifest/activation change in this slice; Spanish feeds ship in Phase 4. Slice 15 adds the clustering English-output + translated-evidence writer guardrails.

### 2026-05-29 - D-066 - Source-expansion latency posture: parallel why, manifest-derived allowlist, warm/cadence ops

#### Context

Source expansion landed across Phase 1 slices 1–7: scoped fetch on cache miss (matched `feedIds`), an ingestion cache warmer on an hourly schedule, a shared bounded-concurrency [`pMap`](apps/api/src/util/p-map.mjs), bounded-parallel why-it-matters generation, and `_meta.timings` latency instrumentation. Two operational hazards surfaced. (1) The per-story why writer was serial and dominated refresh wall-clock as story counts grew. (2) A narrowed env allowlist (e.g. `TEMPO_RSS_ALLOWLIST=washington post,reuters`) silently blocks newly-activated publishers — the "Reuters-class block" — because the env list overrides the manifest-derived default.

#### Decision

1. **Bounded parallel why.** The why writer runs in a bounded parallel pool over `pMap`, sized by `TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY` (default `4`, clamped `1..6`; invalid → default). It wins back latency without an uncontrolled provider fan-out, and **response story order stays deterministic (R1)** — per-story results are written back into the canonical story order, independent of completion order. See [why-this-matters spec §12.2](docs/why-this-matters-spec.md).
2. **Manifest-derived allowlist for expansion.** For multi-publisher expansion, leave `TEMPO_RSS_ALLOWLIST` **unset** so the allowlist derives from the active manifest feeds; newly-activated publishers then ingest automatically. Set the env only to *intentionally* constrain fetch scope, as temporary/explicit narrowing.
3. **Warm/cadence operational posture.** The cadence tick ([`.github/workflows/cadence-tick.yml`](../.github/workflows/cadence-tick.yml)) and the ingestion warmer ([`.github/workflows/ingestion-warm.yml`](../.github/workflows/ingestion-warm.yml)) are complementary scheduled jobs — the tick drives due-user refreshes, the warmer keeps the recent-items cache primed so cache-miss latency stays low. Their log tags `[cadence-tick]` and `[ingestion-warm]` are the first debugging surface.

#### Operator do / don't

- **Do** leave `TEMPO_RSS_ALLOWLIST` unset during a source-expansion rollout (manifest-derived default).
- **Don't** carry a legacy narrow allowlist env into an expansion rollout — a stale value silently blocks new feeds (Reuters-class block).
- **Do** keep `TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY` within `1..6`; raising it trades provider fan-out for latency.
- **Do** read per-stage refresh latency off `_meta.timings` (persisted via `_lastRunMeta.timings`): `ingestionMs`, `preClusterMs`, `recallMs`, `clusterMs`, `whatChangedMs`, `whyMs`, `pipelineMs`.

#### Why

- The serial why loop was the dominant enabled-path latency cost on multi-story refreshes; a bounded pool removes it while the R1 re-sort keeps ordering deterministic and the clamp keeps provider load predictable.
- Env allowlists were originally a narrowing override, but during expansion they invert into a silent block list. Defaulting to the manifest-derived set makes "activate a feed in the manifest" the single lever, with the env reserved for deliberate constraint.

See [README § Refresh latency & expansion-safe ingestion](README.md#refresh-latency--expansion-safe-ingestion-phase-1-slices-58) and [`apps/api/.env.example`](apps/api/.env.example) for operator-facing guidance.

### 2026-05-18 - D-065 - What-changed delta engine (3-state hybrid)

#### Context

`story.whatChanged` shipped as `` `Latest update ${freshestMinutesAgo} min ago.` `` — a freshness restatement, not a change signal. It told the user **when** the freshest source landed but never **whether** the narrative had moved. The Mercedes Osma sessions ([interview synthesis](../01-research/interview-synthesis--zero-to-one--mercedes-osma.md)) flagged this as the top monitoring-first pain: comms leads constantly self-interrupt drafting to check if the story changed before they can finalize a response. A line labeled `whatChanged` that only reports freshness creates expectation of delta semantics it cannot deliver — a trust leak on the dashboard's most monitoring-shaped affordance.

#### Decision

Replace the freshness template with a **3-state hybrid delta engine** (first-seen / unchanged / changed) wired into `runRefreshPipeline` after the R1 sort + tag overlay, before the funnel summary:

- **Deterministic structural gate first.** Cheap rules over `sources[].id`, `sources[].outlet` (normalized), `sources[].headline`, `summary`, `subtitle`, and (defensively) `title`. Emits `none` / `weak` / `strong` with a `reasons[]` trail. Filters out reorder, freshness ticks, syndication duplicates, and tag-only changes upfront.
- **Optional Haiku classify** (`TEMPO_AI_DELTA_CLASSIFY_MODEL`, default `anthropic:claude-haiku-4-5-20251001`) on weak/strong gate signals — confirms material intent or rejects.
- **Optional Sonnet write** (`TEMPO_AI_DELTA_WRITE_MODEL`, default `anthropic:claude-sonnet-4-6`) on Haiku-confirmed material, producing 1–2 sentences grounded to the structured evidence diff. Hallucination guard rejects outlets not in either prior or current `sources[].outlet` (using a known-outlet vocabulary; see spec §6).
- **Ever-seen persistence.** `_everSeenMetaStoryIds: string[]` on the snapshot payload (sibling of `_watermark` / `_selectionMeta` / `_lastCheckedAt` / `_lastRunMeta`), merged on each successful write, stripped from client responses. Drives the first-seen branch without a separate Postgres table — JSONB on the existing row is enough for MVP.
- **Default off.** `TEMPO_AI_DELTA_ENABLED=false` keeps the LLM stages dormant. Without an explicit opt-in (per-environment env flip), refreshes ship only deterministic first-seen / unchanged copy. `TEMPO_AI_MOCK_ONLY=true` vetoes the LLM path regardless of `DELTA_ENABLED`.
- **Fail-closed everywhere.** Any timeout, parse error, length overflow, or hallucination trip routes to the static unchanged copy. We never synthesize a "something probably happened" sentence.
- **Run-level diagnostics.** `log.whatChanged` (schemaVersion `whatchanged-v1`) carries state counters, gate-signal breakdown, classify / write call counts, `llmFailed.*`, latency, and a `watermarkShortCircuited` flag. Persisted via `_lastRunMeta.whatChanged` and surfaced on `_meta.whatChanged` for `GET /api/dashboard`.

Shipped across five commits on `feat/what-changed-delta-engine`: `3a9803f` (spec), `70b4734` (persistence), `7230b5b` (gate), `3c90cef` (LLM stages), `0f75206` (pipeline wiring + observability). See [what-changed-spec.md](docs/what-changed-spec.md) for the full contract, scenario table, and implementation map; [what-changed-handoff.md](docs/what-changed-handoff.md) for staging rollout + counter glossary.

#### Why

- **Trust surface, false-positive-first.** A wrong "Updated:" line is worse than a quiet "no material update". The deterministic gate filters out the bulk of false-positive cases (re-syndication, reorder) for free; LLMs only see signals worth confirming.
- **Two-stage LLM over single-stage.** Haiku gates the writer cheaply on shorter context; Sonnet only sees clusters the classifier already confirmed are material. Splitting keeps writer calls rare and stops single-stage "classify + write" from writing under uncertainty.
- **Default-off lets us ship the foundation without burning cost.** Phase 4 retires the misleading freshness template right away (CI / unopted prod now ships honest first-seen / unchanged copy); LLM uplift is one env flip and a staging soak away.

#### Tradeoffs

- **Pre-lock vs post-lock asymmetry.** The engine runs against pre-lock current stories (locks are applied later in `server.mjs`) but compares against the persisted prior snapshot, which was lock-applied at write time. Worst case: when a title lock masks underlying drift, the gate may emit a weak `title_change` / `subtitle_change` signal. Both are weak-only and Haiku can reject — the cost is one extra classify call. Spec §7 / alignment #8 picks pre-lock for symmetry with what the user will see post-lock. Storing a pre-lock snapshot side-by-side is a fast-follow if telemetry shows real noise.

- **`firstSeen` + `gateNone` double-count by design.** First-seen stories short-circuit before the structural gate runs and carry `gate.signal === "none"` with reason `first_seen`. They increment both `firstSeen` (state) and `gateNone` (structural). Operators read state counters to answer "what did the user see?" and gate counters to answer "did the structural diff find anything?" — first-seen stories have different answers in those two buckets, so both numbers are honest. Documented in spec §9 and on `aggregateWhatChangedDiagnostics`'s JSDoc.

- **Watermark short-circuit re-serves prior `whatChanged` verbatim.** When the candidate set hasn't moved (watermark match), the route serves the prior snapshot's stories untouched — including the `whatChanged` strings. By design (spec §10 row 6 / alignment #6): nothing material has changed, so the prior delta classification is still the truthful answer. Recomputing on a watermark skip would burn LLM cost for an identical result.

- **Serial per-story LLM loop.** R1-sorted dashboards are small (~≤10 stories), so worst-case enabled latency is `N × (Haiku + Sonnet)`. We avoided parallelism to keep ordering deterministic and diagnostics simple. Revisit if Haiku/Sonnet latency dominates a refresh.

- **Hallucination guard is heuristic, not NER.** A small known-outlet vocabulary (`KNOWN_OUTLET_TOKENS`) catches the Sonnet writer reaching for outlets not in the diff. Misses for outlets outside that list are accepted as a fast-follow item — spec §6 calls this "start simple".

#### Rollback

- **One-flag rollback.** `TEMPO_AI_DELTA_ENABLED=false` in the environment immediately reverts every shipped story to the deterministic first-seen / unchanged branch. No code change, no migration, no schema change.

- **Full revert.** The entire engine + wiring sits on `feat/what-changed-delta-engine` as five sequential commits; reverting the branch restores the prior `whatChanged` field shape. The freshness template (`Latest update ${freshestMinutesAgo} min ago.`) was removed in Phase 4 and is **not** re-introduced on a flag flip. If a hard rollback to the legacy copy is ever needed, revert commit `0f75206` (Phase 4 wiring) along with the placeholder import — `storySchema.whatChanged: z.string().min(1)` is unchanged, so the contract surface stays valid.

- **Ever-seen persistence remains.** `_everSeenMetaStoryIds` continues to populate even with the LLM off — it's deterministic state other monitoring features may build on. Safe to leave in place across rollbacks.

---

### 2026-05-17 - D-064a - D-064 follow-ups: backfill, single-source synonyms, synonym-aware alias resolve

#### Context

Three review follow-ups to D-064, all minor and bounded:

1. `stripKeywordsMatchingGeographies` ran only on new onboarding and on Settings PUT. Users who onboarded before D-064 still carried country names in both `settings.keywords` and `settings.geographies` until they manually re-saved.
2. `beat-fit-scorer.mjs` still had a private `GEO_SYNONYMS` constant that duplicated `GEOGRAPHY_SYNONYMS` introduced by D-064 in `contracts-runtime/geography-aliases.mjs`.
3. `GEOGRAPHY_ALIASES` maps city tokens to long-form canonicals (e.g. `washington` → `"United States"`). Users typically configure the short form `"US"`. `resolveGeographyAlias` only matched on `setting === canonical` (case-insensitive), so `washington` + geo `US` never resolved — beat-fit `geoTextMatches` step 3 and `assignGeographies` in `meta-story-tags.mjs` missed US evidence in URLs/text that only mentioned city aliases.

#### Decision

1. **Backfill on read.** New `backfillKeywordDedupe(payload, userId)` helper in `server.mjs` runs `stripKeywordsMatchingGeographies` on every settings read and persists exactly once when the keyword list changes (element-wise equality check — not length-only — so e.g. `["China","Russia"]` with geo `["China"]` still persists). Applied at `GET /api/settings` and at the dashboard refresh read. Subsequent reads on already-cleaned data are no-op write-skips. Persistence failures are non-fatal — the client still receives the cleaned payload.
2. **Single source of truth.** `beat-fit-scorer.mjs` now imports `GEOGRAPHY_SYNONYMS` from `contracts-runtime/index.mjs`; the private duplicate is deleted.
3. **Synonym-aware `resolveGeographyAlias`.** Extended (in both `apps/api/src/contracts-runtime/geography-aliases.mjs` and `packages/contracts/src/geography-aliases.ts`) so the gate accepts a configured setting when `GEOGRAPHY_SYNONYMS[setting]` contains the alias canonical (case-insensitive). `GEOGRAPHY_SYNONYMS` is now exported from `@tempo/contracts` as well; the contracts package was rebuilt. Synonym-key lookup is case-insensitive so a lowercase `"us"` setting still resolves.

#### Why

- Backfill: users can't be told "re-onboard to clean up your keywords." Idempotent on-read backfill is invisible to the user — one extra write per pre-D-064 account, then steady-state.
- Single source: drift between two synonym tables would silently flow into wrong scoring or wrong dedupe.
- Synonym-aware resolve: covers the common short-form-vs-long-form mismatch (`US` vs `United States`) without forcing operators to know the alias map's canonical spellings.

#### Tradeoffs

- Backfill writes from a read path is unusual; mitigated by the keyword-list equality guard (no writes after the first cleanup) and non-fatal error handling.
- Synonym-aware match widens `stripKeywordsMatchingGeographies` too — a keyword `Washington` with geo `US` is now stripped (the helper calls `resolveGeographyAlias` internally). This is the intended behavior: `Washington` is geo evidence, not a thematic keyword.

#### Rollback

Each follow-up is independently reversible. Remove the `backfillKeywordDedupe` calls to disable the read-side cleanup; revert the `beat-fit-scorer.mjs` import to restore the local table; drop the synonym branch in `resolveGeographyAlias` (both runtime and contracts package) to restore the strict exact-canonical match.

---

### 2026-05-17 - D-064 - Geo/keyword dedupe + URL evidence + alias-aware beat-fit geo match

#### Context

After onboarding, country names (China, Russia, Ukraine, US) were appearing in both `settings.keywords` and `settings.geographies`. Dashboard header pills are built from story `tags`, not settings — but the duplication still polluted the Settings UI and produced "country-as-keyword" pills downstream.

Separately, priority WaPo stories where the body avoids the country name but the URL path encodes it (e.g. `…/beijing/…` for a Xi/Trump piece) reached the dashboard via semantic beat-fit but carried no `China` geography tag. Two root causes:

- The meta-story tag evidence bundle skipped `source.url`, so the `GEOGRAPHY_ALIASES` gate never saw `beijing`.
- Beat-fit `joinText()` skipped `url`, and `geoTextMatches()` only consulted a small private `GEO_SYNONYMS` map (`US` / `Colombia` only) — `GEOGRAPHY_ALIASES` was not wired in here even though `meta-story-tags.mjs` already used it.

#### Decision

One focused PR with four slices:

- **A — Geo/keyword dedupe.** New `stripKeywordsMatchingGeographies(keywords, geographies)` helper in `contracts-runtime/geography-aliases.mjs`. A keyword is stripped when it matches a configured geo (case-insensitive, trimmed) via (a) exact match, (b) `GEOGRAPHY_SYNONYMS` (e.g. `United States` ↔ `US`, `U.S.`, `USA`), or (c) `GEOGRAPHY_ALIASES` resolution (e.g. `Bogotá` + `Colombia`, `Moscow` + `Russia`). Applied at three layers: `sanitizeExtraction` in `onboarding-extractor.mjs`, the post-extraction merge in `server.mjs` PUT path, and the initial settings validation in the PUT path — so manual Settings edits cannot reintroduce duplicates. Onboarding system prompt gained a hygiene line ("Country and region names belong in geographies, not in keywords."), and `EXTRACT_PROMPT_VERSION` bumped to `extract-v5`.

- **B1 — URL in tag evidence.** `buildMetaStoryEvidenceText` now appends each source's `url` (when present) to the join text. The downstream `assignGeographies` alias gate already used `phraseAppearsInText` with `\b` boundaries, which match URL path tokens like `/beijing/`.

- **B2 — URL in beat-fit joinText.** `joinText(item)` in `beat-fit-scorer.mjs` appends `item.url` when present. Items with no URL are unchanged. Side-effect noted: the existing three-WaPo regression fixture had a default URL of `https://example.com/wapo-china`, which now matches the configured `China` keyword — the test was retargeted by overriding URL on the modified fixture.

- **B3 — Alias-aware beat-fit geo matching.** `geoTextMatches(text, geo, settingsGeographies)` extended to consult `GEOGRAPHY_ALIASES`: for each alias key whose canonical resolves (via `resolveGeographyAlias`) to the configured `geo`, a whole-word hit in the text counts. Same rules as the `meta-story-tags` alias gate, so beat-fit and tag assignment treat alias evidence identically.

#### Why

- Settings hygiene: pills derived from story `tags` were correct, but country-as-keyword duplication in `settings.keywords` was a visible inconsistency and a foot-gun for any future surface that read keywords directly.
- Recall: WaPo and similar outlets routinely encode the lead geo in the URL slug; ignoring it dropped genuinely on-beat stories from the beat-fit geo signal, which then cascaded into the `evaluateSemanticGeoRescue` `geo_gate` block.
- Drift control: aligning beat-fit's geo-in-text rule with the tag-assignment rule removes a class of "alias works for tags but not for scoring" surprises.

#### Tradeoffs

- **URL false positives.** Path tokens that coincidentally match a configured keyword now count. Concrete example caught by tests: a fixture URL `https://example.com/wapo-china` matches keyword "China" because of the sourceId. Mitigation: keep keyword/alias regexes word-bounded (already true) so substrings inside larger slugs ("chinatown" inside `/chinatown-news/`) don't match — but path-segment matches still fire. Acceptable under the MVP recall-first posture (D-063); revisit if URL-driven false positives become noisy in user-visible data.
- **No threshold / weight changes.** `TEMPO_BEAT_FIT_THRESHOLD` remains pinned at 0.20 (default) or per-env override; D-063 rescue paths and the semantic blend are untouched. This decision is purely about *what counts as evidence*, not how evidence is weighted.

#### Rollback

Each slice is independent and can be reverted alone if needed:
- Remove `stripKeywordsMatchingGeographies` calls at the three sites (helper itself is dead-code-safe).
- Drop the `url` push in `buildMetaStoryEvidenceText` to restore the old tag evidence bundle.
- Drop the trailing `url` in `joinText` to restore the old beat-fit join.
- Restore the original two-step `geoTextMatches` body (canonical + synonyms only).

---

### 2026-05-17 - D-063 - Lower beat-fit threshold from 0.40 to 0.20 (MVP recall-first)

#### Context

Manual dashboard tests against priority Washington Post stories showed several genuinely on-beat items scoring just under the 0.40 "balanced" precision gate set by the original beat-fit scorer:

- Ukraine ~0.38 (occasionally rescued via the borderline-multisignal / semantic-geo paths, but flaky)
- China ~0.22 (when China was a configured geography)
- Rwanda ~0.20 (when Rwanda was a configured geography, observed Run 1)

The result: users saw an empty (or near-empty) dashboard for beats where relevant stories objectively existed in the candidate pool. The two existing rescue paths (`rescue_borderline_multisignal` D-054, `rescue_semantic_geo` D-059 / D-062) helped at the margin but did not consistently close the gap, especially for items below the 0.35 multisignal band.

#### Decision

Lower the default beat-fit threshold from **0.40 → 0.20**, with an env override for instant rollback:

- `TEMPO_BEAT_FIT_THRESHOLD` (repo-convention primary) → `BEAT_FIT_THRESHOLD` (legacy alias) → constant default `0.20`.
- New `readBeatFitThreshold()` runtime accessor; `applyBeatFitFilter`, `evaluateRescue`, `evaluateSemanticGeoRescue`, and `scoreBeatFit` semantic lift annotation all resolve the threshold through the reader, not the static constant.
- `readRescueLowerBound()` is now threshold-aware: when the active threshold is at or below the historical `DEFAULT_RESCUE_LOWER_BOUND` (0.35), the fallback clamps to `max(0.05, threshold − 0.05)` (→ 0.15 at threshold 0.20) so the borderline band `[lowerBound, threshold)` stays non-empty.
- Scope is still defined by configured `geographies` + `traditionalSources` / `socialSources` — the threshold change only adjusts the precision gate inside that scope (so e.g. Rwanda stories only surface when Rwanda is configured).

#### Why

The MVP product posture is **recall-first for learning**: surface borderline-relevant items so the operator can react and so we can observe what users do with them, then re-tighten once we have real usage signal. Precision-first is the right end state, but 0.40 was tuned against a single pairwise regression (`US strikes Iranian tankers` vs `Asia farmers food supply`), not against the breadth of priority stories users actually care about.

#### Tradeoffs

- **Precision drops.** Borderline items (geo-only matches, weak topic alignment) now reach clustering. Under the legacy posture an off-topic mig-noise item with only a geo match (~0.30) was excluded; at 0.20 it can leak. The critical eval suite and the strict-empty pipeline tests pin `TEMPO_BEAT_FIT_THRESHOLD=0.40` at the file level so they keep validating the precision contract they were written for.
- **Rescue paths become near-redundant** under the default threshold (most items they would rescue now pass the gate outright). They remain in place for env-tuned higher thresholds and for the legacy posture.
- **`relevance-precision` eval baseline shift (geo_mismatch_no_rescue).** Case 11 was written to prove `rescue_semantic_geo` does **not** fire when configured geos (US, Colombia) do not match a Sahel/ISIS story—even with strong semantic (≥ 0.60). At **0.40**, deterministic signals were zero (no topic/keyword/geo), so blended score ≈ 0.238 stayed below the gate and rescue was blocked at `geo_gate`. At **0.20**, that same blend clears via the **normal pass path** (not rescue): semantic weight alone lifts the item in, so geo-mismatch protection at the rescue layer is bypassed. `currentBaseline` updated (`in_dashboard: true`); `targetExpected` left unchanged so the eval gap documents this known recall-first leak.

#### Rollback

Set `TEMPO_BEAT_FIT_THRESHOLD=0.40` in the environment to restore the legacy precision-first behavior. No code change, no deploy required.

#### Addendum (Slice 4) — Embed recall floor (0.40) vs beat-fit threshold (0.20)

These two numbers look similar and get conflated; they are **different stages on different scales**. Do not copy one into the other.

- **`TEMPO_EMBED_MIN_SIMILARITY` (default 0.35 — recall-widening; lowered from 0.40, see note below)** — a raw **cosine** floor in the *recall* stage. It gates only **semantic-only** top-K additions to the `hybrid_strict` union; keyword/topic hits always bypass it. It widens or narrows what reaches the precision stage; it is not a relevance score.
- **`TEMPO_BEAT_FIT_THRESHOLD` (default 0.20)** — a blended **precision** score in the *beat-fit* stage, applied *after* recall (D-063). It decides what survives to clustering.

Calibration for manual E2E: sweep the embed floor in the band **0.35–0.45** (set `0` to disable it entirely) while watching `?debug=1` → `diag-recall` (`semantic_rejected`, `floor=`). Roll back beat-fit to precision-first with `TEMPO_BEAT_FIT_THRESHOLD=0.40`. The production embed-floor default is **0.35** — only change `DEFAULT_EMBED_MIN_SIMILARITY` in code if a committed golden run proves systematic loss at 0.35.

> **Recall-widening update (2026-05-29):** `DEFAULT_EMBED_MIN_SIMILARITY` lowered **0.40 → 0.35** to admit slightly more on-beat semantic neighbors (low end of the calibration band; clear noise still held back). Code default, env override semantics unchanged. Tests/evals/docs realigned to 0.35; the calibration sweep band and probe set are unchanged.

---

### 2026-05-16 - D-053 - Vercel API runtime stability Option A: remove workspace-package runtime dependency

#### Context

- `tempo-api` production (`tempo-gray-psi.vercel.app`) returned `500` with `ERR_MODULE_NOT_FOUND` immediately after a successful build.
- The failing path imports `@tempo/contracts` from API runtime code, while `@tempo/contracts` resolves to `dist/index.js`. In Vercel builds, workspace package `dist` artifacts can be absent or drift from runtime assumptions.
- A tactical guard (`postinstall` building workspace packages) can unblock short-term deploys, but this still leaves runtime coupled to build-order details.

#### Decision

Adopt **Option A** for the durable fix: API runtime code must not depend on workspace package build artifacts. Keep `@tempo/contracts` package use for tests/tooling only where appropriate.

Implementation direction:

- Move API runtime imports from `@tempo/contracts` to a local source-of-truth module under `apps/api/src/contracts-runtime/` (or equivalent) that exports only what runtime needs.
- Ensure runtime uses source files checked into the API project, not generated `dist` from another workspace package.
- Keep contract compatibility by reusing existing schemas/types semantics; no payload shape changes in this slice.

#### Why

- Removes the highest-risk failure mode for production (`ERR_MODULE_NOT_FOUND` from missing package build output).
- Makes deployment deterministic: runtime correctness no longer depends on workspace build orchestration.
- Reduces rollback risk during test windows with actual users.

#### Tradeoffs

- Introduces duplicate logic pressure if shared contract behavior diverges; requires parity checks/tests.
- Slightly larger API code surface because runtime-safe contract helpers are local.
- Follow-up cleanup needed to keep package and API runtime contract paths aligned.

#### Low-risk rollout sequence

1. **Branch-only hardening:** implement Option A behind no feature flags and no external behavior changes.
2. **Parity tests:** add/extend tests asserting runtime schemas/normalizers match current contract behavior.
3. **Preview deploy verification:** validate `/health`, `/api/settings`, `/api/dashboard` on preview before production.
4. **Production deploy gate:** promote only after smoke checks pass and runtime logs show no module-resolution errors for 30-60 minutes.
5. **Post-cutover cleanup:** the tactical `postinstall` workaround mentioned in Context was never applied — Option A made it unnecessary, so no rollback is needed.

#### Consequences

- API deployments become less sensitive to Vercel workspace build quirks.
- Future contract-sharing changes must treat runtime safety as a first-class requirement.

---

### 2026-05-16 - D-052 - Trust cleanup Phase 7: rollout hardening + operational guardrails (cancellation, kill switch, telemetry, debug endpoint)

#### Context

Phase 5 ([D-050](#2026-05-16---d-050---trust-cleanup-phase-5-production-scorer-wiring--fail-closed-semantics--calibration-harness-default-off)) wired the production scorer behind the Phase 4 surface, but its tradeoffs spelled out the gap Phase 7 needed to close: (a) the timeout race did NOT cancel the underlying HTTP request, so provider quotas / cost-per-failed-call accumulated even on fail-closed runs; (b) the only way to flip semantic uplift off in an incident was to flip three separate env vars; (c) operators inspecting `_meta.tags` could only grep logs; (d) threshold tuning had a calibration harness but no path to feed production telemetry into it. Phase 6 was strictly front-of-house and didn't touch these.

#### Decision

Land **Phase 7 rollout hardening** with five additions: end-to-end cancellation, a kill switch, diagnostics schema version, latency observability, telemetry-driven threshold advisory, an internal debug endpoint, and a written operator runbook. Chunk K stays locked to K1a; semantic geographies still out of scope.

**End-to-end cancellation:**

- [`createEmbeddingSemanticScorer`](apps/api/src/dashboard/meta-story-semantic-mapper.mjs) creates a per-call `AbortController`; passes `controller.signal` into `embedFn(texts, { signal })`. On timeout, `controller.abort()` fires.
- [`embedTexts`](apps/api/src/ai/embeddings.mjs) and [`embedTextsWithOpenAI`](apps/api/src/ai/providers/openai-embeddings.mjs) accept an optional `signal` (additive — recall callers unaffected) and forward it to `fetch(...)`.
- The mapper tracks `timeoutFired` so an embedFn-side abort rejection still surfaces as `SemanticScorerTimeoutError`, preserving fallback-reason attribution.

**Kill switch:**

- `TEMPO_TAG_SEMANTIC_KILL_SWITCH=true` forces every per-axis flag to `disabled` regardless of any other config. Distinct from `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED` so a misconfigured deploy can't accidentally re-enable semantic uplift.
- Surfaced as `_meta.tags.killSwitchActive` + `[pipeline.tags]` log token.

**Diagnostics schema version + latency observability:**

- `TAGS_DIAGNOSTICS_SCHEMA_VERSION = "phase7-2026-05-16"` stamped on `_meta.tags.schemaVersion`. Bumped whenever the per-axis diag shape changes.
- `scorerCallCount` + `scorerLatencyMaxMs` added per axis. Consumers derive average latency as `scorerLatencyMs / scorerCallCount`; the max field surfaces tail outliers a cumulative latency would average away.

**Telemetry-driven threshold tuning:**

- [`semantic-tag-calibration.mjs --telemetry=<file>`](apps/api/scripts/semantic-tag-calibration.mjs) reads `_meta.tags` snapshots and prints per-axis HOLD / LOWER / RAISE advisories. Conservative heuristic (small sample → HOLD; timeouts → HOLD threshold; too-tight → LOWER; too-loose → RAISE). Strictly advisory.

**Internal debug endpoint:**

- `GET /api/_debug/dashboard-tags` ([`server.mjs`](apps/api/src/server.mjs)). Gated on BOTH `TEMPO_DEBUG_TAGS_ENABLED=true` AND `NODE_ENV !== "production"`. Authenticated (same `requireIdentity` as `/api/dashboard`). Returns calling identity's last persisted `_meta.tags` only — no story content, no source bodies.

**Operator runbook:**

- New [`runbook-semantic-tags.md`](docs/runbook-semantic-tags.md) codifies flag precedence (kill-switch > global > per-axis), Stage 0–5 rollout, rollback procedure by symptom, calibration cadence, and the explicit "geographies remain deterministic" lock.

#### Why

- **Cancellation is a real cost lever.** Failed scorer calls that keep running on the provider side accumulate budget for no value. Plumbing the signal is small + safe; future Phase 8 work doesn't have to revisit it.
- **One kill switch is better than three flags during an incident.** Operators in a stress situation flip a single var. Defense in depth: kill switch wins even if `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED` is also true (which it would be in a healthy production state).
- **Schema version + latency-max are cheap forward compat.** Two small fields; downstream consumers (Grafana, log scrapers, future Phase 8 work) get a clean upgrade story.
- **Telemetry-driven tuning closes the operator loop.** Phase 5 calibration was fixture-only; Phase 7 lets the same harness ingest real run snapshots so threshold decisions are evidence-based, not guessed.
- **Debug endpoint matches the existing ops posture.** Same gating idiom as DC validation mode; same authenticated identity; same persisted-snapshot read path. No new surface area to secure.
- **Runbook codifies institutional knowledge.** The procedure spread across spec + walkthrough + DECISIONS is now in one operator-readable place.

#### Tradeoffs

- **AbortController does not refund provider cost for the partial second of work before abort.** It does cap cost at the cancellation point, but the cost up to that point is still billed. Not addressed in this slice — Phase 8 (cross-run cache) is the next lever if cost matters.
- **Telemetry advisory heuristic is conservative.** It will under-recommend changes when telemetry is thin; we accept that precision over recall for an advisory tool.
- **Debug endpoint adds a route to the surface.** Mitigated by two-gate isolation (env opt-in + non-prod) + identity auth + content-narrowing (returns only `_meta.tags`, never stories). Server test asserts content-narrowing explicitly.
- **Schema version bumps could be missed.** We accept the manual discipline trade — the constant is `export`ed, referenced once in the pipeline, surfaces on every snapshot, and is small enough to grep.

#### Consequences

- Phase 8 deferred: semantic geographies still out of scope; per-axis runtime-adaptive thresholds out of scope; cross-run scorer cache out of scope.
- Anyone touching the scorer factory or the embed adapter needs to keep the `{ signal }` plumbing intact. The Phase 7 mapper tests are the canary.
- Operators rolling semantic uplift in production follow [`runbook-semantic-tags.md`](docs/runbook-semantic-tags.md); deviations should land as runbook PRs.

---

### 2026-05-16 - D-051 - Trust cleanup Phase 6: UI polish + trust-first empty states (front-of-house only)

#### Context

Phase 1 ([D-047](#2026-05-16---d-047---trust-cleanup-phase-1--2-tags-only-labels-no-fabricated-topic-required-tags-on-the-wire)) locked the "tags-only labels" decision and removed the dashboard-pills / scan-row fallbacks to root `story.topic` / `story.geographies`. But three UI surfaces still consumed the root fields: (a) the story-detail chip row, (b) the [`Tags.tsx`](../04-prototype/src/components/Tags.tsx) component signatures (legacy enum types), and (c) the `recommendedAction` analyst copy in [`derive.ts`](../04-prototype/src/lib/derive.ts) (equality checks on `story.topic`). The empty-tag state — stories exist but no tags surface — also rendered as a lone "All" pill with no narrative cue, which read as a glitch rather than a trust posture.

Phases 4 + 5 ([D-049](#2026-05-16---d-049---trust-cleanup-phase-4-constrained-semantic-mapping-for-topics--keywords-default-off) / [D-050](#2026-05-16---d-050---trust-cleanup-phase-5-production-scorer-wiring--fail-closed-semantics--calibration-harness-default-off)) added rich operator-only diagnostics (`_meta.tags.{topics,keywords}.{runtimeState, scorerLatencyMs, fallbackReasonCounts}`); Phase 6 also pins as test invariants that none of those leak into user-facing UI.

#### Decision

Land Phase 6 trust cleanup as a **front-of-house-only slice** — no server behavior, semantic logic, or env-flag changes. Chunk K stays locked to K1a.

**Changes:**

- [`StoryDetail.tsx`](../04-prototype/src/components/StoryDetail.tsx) — chip row sources from `story.tags.topics[0]` + `story.tags.geographies`. Divider `|` only renders when both axes are present; whole chip row hidden when both empty.
- [`Tags.tsx`](../04-prototype/src/components/Tags.tsx) — `TopicTag` / `GeoTag` / `GeoStrip` accept `string` / `string[]` instead of legacy `Topic` / `Geography` enums so Phase 3 alias canonicals (`China`, `Latin America`) render. `GeoTag` keeps the `US` / `CO` monogram for the original canonical pair and uppercases any other settings label.
- [`derive.ts`](../04-prototype/src/lib/derive.ts) — `recommendedAction` reads `story.tags?.topics` (with `Set.prototype.has`) instead of `story.topic === …`. Survives Phase 2's optional-`topic` contract and aligns with the tags-only posture.
- [`Dashboard.tsx`](../04-prototype/src/pages/Dashboard.tsx) — `showNoTagsCaption` flag + `pill-row-empty-caption` slot ("No tag groups yet") surfaces alongside the lone "All" pill when every section is empty. Pill row carries `role="group"` + `aria-label="Filter stories by tag"`; caption carries `role="status"`; Pill button uses `type="button"` + `focus-visible:outline`.
- **Test coverage:** 5 new Dashboard cases, 3 new StoryCard cases, 7 new StoryDetail cases (file is new). All four diagnostic-leak strings (`runtimeState`, `scorerLatencyMs`, `belowThresholdCount`, `semanticApplied`, `fallbackReasonCounts`) are asserted as never appearing in rendered output.

#### Why

- **Single locked decision, finally implemented everywhere.** Phase 1's "tags-only" decision was correct; Phase 6 just closes the remaining inconsistencies.
- **Trust posture surfaces at the empty edge.** "No tag groups yet" is the smallest possible cue that the dashboard is being honest about missing evidence. It doesn't lecture or warn — operators just see what's there.
- **A11y is cheap when it's part of the polish slice.** `role="group"` / `aria-label` / `role="status"` are 4 attributes that materially improve assistive-tech usability and cost nothing.
- **Operator-only diagnostics get their own audit lock.** Phase 6 is the natural place to assert "this UI is for users" — even though Phase 4 / 5 always intended diagnostics to be operator-only, a regression test pinning the absence of those strings catches a future leak class.

#### Tradeoffs

- **Open-string typing on `Tags.tsx`** loses some compile-time validation against the legacy `Topic` / `Geography` enum. That's fine for v1 — the production source (`story.tags`) is settings vocabulary (open string), so the runtime contract is already open; tightening the component type would have forced a translation layer for every Phase 3 geo alias.
- **"No tag groups yet" is opinionated copy.** Different product directions might prefer "All stories" / "Showing all" / silence. Picked the explicit version because the missing pills look like a glitch otherwise; copy is easy to tune.
- **No in-app debug surface for `_meta.tags`.** Operators still grep logs + persisted snapshots. Phase 7 territory.

#### Consequences

- Phase 7 (deferred): `AbortController` plumbing, adaptive threshold tuning, optional dev/staging-only debug panel surfacing `_meta.tags`. Semantic geographies stay out of scope.
- Anyone touching the chip row / scan row / analyst copy needs to keep reading from `story.tags`. The 15 new Phase 6 tests are the canary.

---

### 2026-05-16 - D-050 - Trust cleanup Phase 5: production scorer wiring + fail-closed semantics + calibration harness (default OFF)

#### Context

Phase 4 ([D-049](#2026-05-16---d-049---trust-cleanup-phase-4-constrained-semantic-mapping-for-topics--keywords-default-off)) shipped the closed-vocabulary semantic mapping surface, the env flags, and the per-axis diagnostics — but no production scorer. The brief explicitly called out that flipping the env flags ON in Phase 4 would produce no uplift because `_refreshPipeline.run` never built a scorer. Phase 5 closes that gap with operational guardrails so the rollout is safe to stage.

#### Decision

Wire a production embedding-similarity scorer behind the Phase 4 surface, add fail-closed semantics with operator-readable runtime state, and ship a threshold calibration tool. **Chunk K is still locked to K1a** — Phase 5 doesn't change scope (closed vocabulary, topics + keywords only, geographies deterministic).

**Mapper extensions — [`meta-story-semantic-mapper.mjs`](apps/api/src/dashboard/meta-story-semantic-mapper.mjs):**

- `SemanticScorerTimeoutError` (exported sentinel) so timeout vs generic error are distinguishable.
- `createEmbeddingSemanticScorer({embedFn, timeoutMs, maxEvidenceChars})` — wraps the recall-stage `embedFn` in cosine similarity (rescaled `[-1,1]` → `[0,1]`), per-call wall-clock timeout, evidence-text truncation, and a per-instance evidence + label vector cache.
- `resolveSemanticScorerRuntimeConfig(env, overrides)` — `TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS` (default `1500`), `TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS` (default `4000`).
- `RUNTIME_STATE` enum + per-axis `runtimeState` ∈ `{disabled, enabled_no_scorer, enabled_scorer_ready, scorer_error_fallback, scorer_timeout_fallback}`. Aggregate uses worst-observed precedence (timeout > error > ready > no_scorer > disabled).
- `scorerLatencyMs` + `fallbackReasonCounts: {timeout, error}` per axis; aggregated across stories.

**Server wiring — [`server.mjs`](apps/api/src/server.mjs):**

- When `resolveSemanticTagConfig()` reports any axis enabled AND no test scorer is injected, `_refreshPipeline.run` builds a production scorer from `_embeddings.embed` + `resolveSemanticScorerRuntimeConfig()`. Tests inject their own scorer; both paths share the mapper.

**Pipeline observability — [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs):**

- `[pipeline.tags]` log line carries `runtime_state / accepted / rejected / below_threshold / latency_ms / timeouts / errors` per axis.
- `log.tags` → `_lastRunMeta.tags` → `_meta.tags` carries the same fields + `geographies.semanticApplied: false` (tripwire for scope drift).

**Calibration harness — [`semantic-tag-calibration.mjs`](apps/api/scripts/semantic-tag-calibration.mjs) + [fixtures](apps/api/scripts/semantic-tag-calibration-fixtures.json):**

- Operator tool, NOT in CI. Reads curated fixtures (`{axis, evidence, expectedAccept, expectedReject}`); runs the mapper at candidate thresholds; prints precision / recall / F1 + confusion summary; recommends the highest threshold within 5pp of best recall (conservative bias toward precision). Supports `--provider=mock|embeddings`.

**Test coverage:**

- 19 new mapper tests: runtime-state derivation (disabled / no_scorer / ready / error / timeout), timeout-wins-over-error precedence, latency aggregation, aggregator runtime-state precedence, scorer factory cosine math, truncation, memoization, timeout, malformed-response handling, runtime-config env parsing.
- 6 new pipeline-level Phase 5 regressions: scorer-ready accept + latency recorded, timeout fallback (deterministic ships), error fallback, enabled-no-scorer state, K1a invariant under scorer failure (funnel stages identical to OFF), geographies locked under aggressive scorer.

#### Why

- **Wiring without a guardrail is worse than no wiring.** Phase 5 ships both the production scorer AND the fail-closed contract that protects the dashboard from a flaky / slow provider. The deterministic baseline ALWAYS ships; the worst the scorer can do is no uplift.
- **The state enum is the operator's primary diagnostic.** A single string in `_meta.tags.{topics,keywords}.runtimeState` answers "is rollout healthy?" without reasoning about flag combinations.
- **Calibration belongs to operators, not the model.** The harness reduces threshold tuning to running one script + reading a table. We picked a conservative "recall within 5pp" recommendation so the first stable threshold biases toward precision.
- **Default OFF preserved.** The brief explicitly said "Safe rollout first: default OFF remains, rollout staged". We didn't flip any flag.

#### Tradeoffs

- **No AbortController on the scorer.** Timeout races the Promise but the embedding HTTP request keeps running until it completes. Provider cost-per-failed-call is the operational risk; fix in Phase 6 if it matters.
- **Per-instance cache, not cross-run.** The factory's evidence/label cache lives inside the scorer closure for the duration of one `runRefreshPipeline` call. Cross-run cache would save provider calls for stable labels (`settings.keywords` rarely change) but adds eviction/memory-pressure semantics we don't need yet.
- **`semantic-tag-calibration-fixtures.json` is small and curated.** It's a starting set; ops should extend it as new precision/recall failure modes surface. The harness asserts the closed-vocabulary lock on every case, so even a sloppy fixture file can't accidentally widen the contract.
- **`enabled_no_scorer` exists for defensive reasons.** If `_embeddings.embed` is ever overridden to undefined in a future server refactor, the mapper now surfaces this explicitly instead of silently skipping semantic uplift.

#### Consequences

- Phase 6 (deferred): `AbortController` plumbing, adaptive threshold tuning, optional cross-run cache. Semantic geographies stay out of scope.
- The recommended staged rollout is in [the spec](docs/dashboard-story-pool-spec.md#tags-k1a) and [the walkthrough](docs/dashboard-story-pool-walkthrough.md#phase-5-amendment--production-scorer-wiring--fail-closed--calibration-harness-2026-05-16-default-off). TL;DR: enable global flag in staging with both axes OFF first (verify wiring via `runtimeState=disabled`); calibrate; enable topics; enable keywords; promote to prod the same way.
- The pipeline regression *"funnel counts identical for scorer-OFF vs scorer-FAIL"* is the canary that K1a hasn't drifted under fallback — it MUST stay green for any future Phase 6+ work.

---

### 2026-05-16 - D-049 - Trust cleanup Phase 4: constrained semantic mapping for topics + keywords (default OFF)

#### Context

Phase 3 ([D-048](#2026-05-16---d-048---trust-cleanup-phase-3-deterministic-meta-story-tag-assignment--geography-alias-map)) closed the structural gap: meta-story-level tags now consume the full evidence bundle and a deterministic geography alias map. But Phase 3 keyword/topic matching is whole-word only, so evidence like `petroleum` does not light up a `settings.keywords` entry of `oil`, and a meta-story summary that says `talks resumed` does not surface `Diplomatic relations` unless the canonical phrase itself appears verbatim. This forces users to over-author their vocabulary or accept missed labels on stories whose evidence is *semantically* clear. The Phase 3 boundary regression test (*"'petroleum' in text + 'oil' in settings emits NO keyword tag"*) explicitly named this as Phase 4 work.

#### Decision

Land **Phase 4** trust cleanup: constrained semantic mapping for `topics` + `keywords` only, default OFF, behind per-axis env flags. **Chunk K is still locked to K1a** — the closed-vocabulary contract makes this a richer *evidence-to-tags* step, not a relock.

**New module — [`meta-story-semantic-mapper.mjs`](apps/api/src/dashboard/meta-story-semantic-mapper.mjs):**

- `mapSemanticAxis({axis, evidenceText, allowedLabels, deterministicLabels, threshold, enabled, scorer})` — scores each candidate from `allowedLabels` (a closed vocabulary, always `settings.topics` or `settings.keywords`) via an **injected scorer** `(evidenceText, candidateLabel) → number | Promise<number>`. Accepts iff `score >= threshold`. Returns `{accepted, diagnostics}`.
- `mapSemanticTopicsAndKeywords({...})` — convenience wrapper running both axes with per-axis thresholds.
- `resolveSemanticTagConfig(env, overrides)` — reads the env flags (with override seam for tests).

**Assigner integration — [`meta-story-tags.mjs`](apps/api/src/dashboard/meta-story-tags.mjs):**

- New async `assignMetaStoryTagsDetailed({metaStory, sourceItems, settings, semantic})` returns `{tags, diagnostics}`. Deterministic baseline runs first; semantic uplift merges in (dedupe, locale-sort).
- Sync `assignMetaStoryTags` keeps its Phase 3 behavior — direct callers don't get Phase 4 uplift unless they explicitly opt in.

**Pipeline + persistence:**

- [`runRefreshPipeline`](apps/api/src/dashboard/refresh-pipeline.mjs) accepts optional `semanticTagConfig` + `semanticTagScorer`. After `buildStory`, the pipeline overlays semantic uplift per story (topics + keywords only), aggregates per-axis diagnostics, and emits `log.tags`.
- [`server.mjs`](apps/api/src/server.mjs) lifts `log.tags` into `_lastRunMeta.tags`; [`dashboard-snapshot-repo.mjs`](apps/api/src/db/dashboard-snapshot-repo.mjs) lifts `_lastRunMeta.tags` into `_meta.tags` on read.

**Closed-vocabulary lock + Phase 4 scope lock:**

- Output stays a subset of `settings.{topics,keywords,geographies}` — by *construction* the mapper inspects only labels passed in.
- Geographies are **explicitly NOT** semantically widened. The runtime diagnostic carries a `geographies.semanticApplied: false` stamp on every run as a tripwire.

**Env flags (defaults OFF):**

- `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED` (global)
- `TEMPO_TAG_SEMANTIC_TOPICS_ENABLED` / `TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED` (per-axis, AND-folded with global)
- `TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD` / `TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD` (`[0,1]`, default `0.75`)

**One-way invariant lock:** The semantic overlay runs **after** clustering + grounding. A regression test (*"Phase 4 wiring: semantic uplift does NOT change funnel / admission counts"*) compares ON vs OFF runs over the same fixture and asserts identical `funnel.stages` + `metaStoryCount`.

#### Why

- **Trust + recall tradeoff handled by a single dial.** Operators can choose to trade some precision for recall on topics/keywords by flipping a flag and tuning a threshold — without code changes, without touching the deterministic baseline.
- **Closed-vocabulary is the safety net.** Even an over-eager scorer can never emit a label the user didn't opt into. The mapper inspects `allowedLabels` only; the evidence token cannot leak through.
- **Geographies are still the riskiest axis to widen.** A semantic alias that maps `"Pacific Northwest"` → `"China"` would be a real and silent precision failure. The deterministic-only lock + explicit `semanticApplied: false` stamp catches drift.
- **Default OFF is the rollout strategy.** Phase 4 ships the surface and the diagnostics; flipping the flag is a separate Phase 5 step that depends on a production scorer + calibrated thresholds.

#### Tradeoffs

- **No production scorer wired yet.** The brief asked for the module, integration, flags, diagnostics, and tests — not for a production scorer wired into `server.mjs`. We chose to keep the scorer injectable so tests can be deterministic; production wiring is a Phase 5 follow-up.
- **Per-story async overhead.** When the flag is OFF (default), `assignMetaStoryTagsDetailed` still runs once per story to emit skipped-state diagnostics. Cost is dominated by the Promise + diagnostics object construction — negligible compared to per-story clustering + grounding cost, and the path is the same whether ON or OFF (so tests of ON/OFF parity are honest).
- **Default threshold (`0.75`) is a conservative guess.** Actual calibration belongs to Phase 5 against the scenario-map goldens; the spec / walkthrough say so.
- **`_lastRunMeta.tags` adds a field to persisted snapshots.** Snapshots written pre-Phase-4 don't have it; loaders skip the field cleanly (covered by existing back-compat normalization tests).

#### Consequences

- Phase 5: production scorer wiring + per-axis threshold calibration + staged flag flip. The diagnostics dashboard (operator-facing) is the canary signal — operators read `_meta.tags` to monitor "is uplift firing, how often is it borderline?" before promoting.
- Existing Phase 3 boundary tests are kept (default-OFF path) AND extended with semantic-ON cases (Phase 4 uplift path). Both versions live side-by-side so any future scope change has to consciously delete or amend each.
- No changes to recall, clustering, dedupe, grounding, or admission. The one-way K1a invariant continues to hold even with Phase 4 ON.

---

### 2026-05-16 - D-048 - Trust cleanup Phase 3: deterministic meta-story tag assignment + geography alias map

#### Context

Phase 1/2 ([D-047](#2026-05-16---d-047---trust-cleanup-phase-1--2-tags-only-labels-no-fabricated-topic-required-tags-on-the-wire)) closed the leak paths that let fabricated labels reach the UI, made `story.tags` required on the wire, and tightened the snapshot loader. The remaining gap is *evidence*: production tag derivation still went through source-only [`deriveStoryTags(sourceItems, settings)`](apps/api/src/dashboard/refresh-pipeline.mjs), which meant a narrative whose **meta-story summary** clearly mentioned a canonical topic but whose **source `topic` fields** were thin/empty produced no topic tag — even though the evidence was right there. Geographies had the analogous gap: text like `"Officials in Beijing issued a statement"` produced no `China` tag because Beijing wasn't in `source.geographies`, and the matcher only did exact string-set intersection.

#### Decision

Implement **Phase 3 trust cleanup**: deterministic meta-story-level tag assignment + deterministic geography aliasing. Chunk K is still locked to **K1a**; the new mechanism enriches evidence-to-tags, not the one-way posture.

**New API surface — [`meta-story-tags.mjs`](apps/api/src/dashboard/meta-story-tags.mjs):**

- `buildMetaStoryEvidenceText(metaStory, sourceItems)` → text bundle (`title` + `subtitle` + `summary` + each source's `headline` + `body`), defensively tolerant of missing fields and non-object entries.
- `assignMetaStoryTags({ metaStory, sourceItems, settings })` → strict three-axis tags object, deduped + locale-sorted. Combines (a) phrase match against the evidence bundle, (b) source structural fields (`source.topic` with synonym normalization, `source.geographies` intersected with settings), and (c) the geography alias map.

**Geography alias map — [`geography-aliases.ts`](packages/contracts/src/geography-aliases.ts):**

- `GEOGRAPHY_ALIASES` maps lowercase evidence tokens to canonical labels (`Beijing → China`, `Montevideo → Latin America`, `Tokyo → Japan`, etc.).
- `resolveGeographyAlias(token, settingsGeographies)` returns the **settings-cased** canonical when both the alias hit and the settings gate fire; returns `null` otherwise. Alias surface forms are **never** emitted into the payload.

**Wiring — [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs):**

- [`buildStory`](apps/api/src/dashboard/refresh-pipeline.mjs) calls `assignMetaStoryTags({ metaStory, sourceItems, settings })` instead of `deriveStoryTags(sourceItems, settings)`. The legacy helper stays exported as a back-compat utility.

**Phase 4 boundary held — keywords stay deterministic:**

- Whole-word phrase match against `settings.keywords` only. Semantic widening (`petroleum` evidence → `oil` tag when `oil` is in settings) is **explicitly Phase 4**. A regression test (*"Phase 3 wiring: 'petroleum' in text + 'oil' in settings emits NO keyword tag"*) locks this boundary; an analogous module-level test makes the deferral obvious to a future reader.

#### Why

- **Trust matches what the narrative actually says.** "Beijing" is China-evidence; with the alias map the UI surfaces the canonical `China` tag (when the user has opted into China), without inventing it for users who haven't. "Diplomatic relations" mentioned in the meta-story summary surfaces as a topic tag even when the source structural `topic` is weak.
- **Deterministic posture stays.** No model lookup, no embedding probe, no synonym lexicon for keywords — every match is a regex hit against a string the operator can read in the source data. Auditable and reproducible across runs.
- **Single source of truth for the alias map.** Putting it in `@tempo/contracts` colocates it with the existing label-normalization vocabulary and lets eval/scoring code consume the same map if/when that comes up.
- **Phase 4 left clean.** Locking the `petroleum`/`oil` boundary in regression now means the semantic mapper can land later without anyone having to guess what Phase 3 *meant*.

#### Tradeoffs

- The evidence bundle grew: phrase matching now scans the meta-story narrative text, not just source headlines/body. Per-story cost is still O(text length × |settings|) per axis — well within budget for the per-story tag step, and the assigner sits **after** clustering so the cost is paid once per shipped story, not per candidate.
- The alias map is curated by hand (low tens of entries in v1). When the product surfaces a missed alias that's causing real label drops, we add it; we do not over-author the map preemptively because every entry is a chance to leak the wrong canonical.
- Source-only [`deriveStoryTags`](apps/api/src/dashboard/refresh-pipeline.mjs) still exists. We could drop it, but keeping it preserves the existing test surface and gives us a clean rollback target if Phase 3 ever needs to be reverted.
- [`storySchema.tags`](packages/contracts/src/schemas.ts) being required (Phase 2) caught a stale Phase 2 issue: the prototype's [`STORIES`](../04-prototype/src/data/stories.ts) demo fixture was missing `tags` on its five entries, which surfaced as 26 failures in [`api.test.ts`](../04-prototype/src/lib/api.test.ts). Fixed in-flight (added an explicit `tags` object to each demo story); no other consumers needed to change.

#### Consequences

- Phase 4 (deferred): a semantic keyword mapper — constrained synonym lexicon or embedding-backed proximity check, still settings-gated. The Phase 3 regression test will need to be amended or replaced when that lands. Chunk K stays at K1a; semantic widening must not bleed into recall/clustering.
- The alias map is small in v1 and will grow on a per-evidence basis. New entries follow the authoring convention in [`geography-aliases.ts`](packages/contracts/src/geography-aliases.ts) (lowercase keys, Title Case canonicals).
- Existing pipeline tests that asserted source-only tag derivation continue to pass — the new assigner consults source structural fields as well as the evidence bundle, so backward-compatible behavior is preserved on fixtures whose source `topic`/`geographies` already encoded the canonical evidence.

---

### 2026-05-16 - D-047 - Trust cleanup Phase 1 + 2: tags-only labels, no fabricated topic, required `tags` on the wire

#### Context

The dashboard was surfacing fabricated topic/geography labels in three places: (1) [`dashboard-filters.ts`](../04-prototype/src/lib/dashboard-filters.ts) fell back to root `story.topic` / `story.geographies` when `story.tags` was missing, so legacy stories produced phantom pills; (2) [`buildStory`](apps/api/src/dashboard/refresh-pipeline.mjs) defaulted `topic` to `"Diplomatic relations"` whenever no source carried a canonical topic; (3) `DEFAULT_SETTINGS` seeded a canonical taxonomy + sources list so an unconfigured installation looked like the user had already chosen a beat. Chunk K — locked to **K1a** — already said tags come from `deriveStoryTags(sourceItems, settings)` only, but these leak paths let evidence-free labels reach the UI anyway.

#### Decision

Land trust cleanup in two phases on `feat/meta-story-tags-phase1`, no Chunk K relock:

**Phase 1 — fabrication removal:**

- `dashboard-filters.ts` `topicsOf` / `keywordsOf` / `geographiesOf` read **only** from `story.tags`; missing tags = empty arrays on every axis.
- `buildStory` drops `?? "Diplomatic relations"`; emits `topic` **only** when a source item carries a canonical value, otherwise omits the field (`storySchema.topic` becomes `optional`).
- `DEFAULT_SETTINGS` / [`settings.json`](apps/api/data/settings.json) / `defaultSettingsPayload` in the prototype are fully empty (taxonomy + sources).

**Phase 2 — contract + boundary alignment:**

- `storySchema.tags` becomes **required** (`{ topics: string[], keywords: string[], geographies: string[] }` — empty arrays valid).
- [`dashboard-snapshot-repo.mjs`](apps/api/src/db/dashboard-snapshot-repo.mjs) `normalizeStoriesForLoad` coerces legacy / missing / partial `tags` to the three-axis empty shape at the **read boundary** so the strict display schema can assume the field without a write-time migration.
- Spec ([`dashboard-story-pool-spec.md`](docs/dashboard-story-pool-spec.md) — Chunk K) and walkthrough ([`dashboard-story-pool-walkthrough.md`](docs/dashboard-story-pool-walkthrough.md) — Chunk K) carry a Phase 1+2 amendment and a forward-look note for Phase 3.

#### Why

- **Trust posture.** Tags-on-the-screen now match tags-on-the-wire: if the system has no evidence on an axis, the UI shows nothing rather than a confident-looking placeholder. Phantom "Diplomatic relations" chips were eroding trust on thin-evidence stories.
- **K1a was always tags-only.** This isn't a new decision — it closes leaks where the *absence* of evidence was being papered over.
- **Read-boundary normalization, not migration.** Older snapshots stay readable; on-disk shape doesn't drift; new writes always carry the three-axis shape because the API only emits the new shape now.

#### Tradeoffs

- Stories whose sources carry no canonical topic now omit `story.topic` on the wire. Lineage matching in [`refresh-pipeline.mjs`](apps/api/src/dashboard/refresh-pipeline.mjs) already handled `prior.topic ?? ""` defensively, so this is a no-op for narrative continuity.
- `topic` is optional on the contract, which is one more shape callers must handle — but the UI doesn't render it (tags drive labels), and the schema is strict on `tags` to compensate.
- Empty defaults mean a fresh install shows no pills until the user configures settings. That is the intended behavior — fewer fabricated chips trumps a "demo-friendly" but misleading first impression.

#### Consequences

- Phase 3 (deferred) will tackle the **geography alias map** (`Beijing → China`) and **meta-story-level tag assignment** (consult `metaStory.tags` subject to `constrainTagsToSettings`). Chunk K stays at K1a until that lands; existing test *"deriveStoryTags: does not consult model tags at all"* will need to be amended when Phase 3 ships.
- Loaders that read snapshots from any backend already go through `dashboard-snapshot-repo.mjs` — no other callers need a back-compat tweak.

---

### 2026-05-03 - D-046 - Phase 5: read-only Markdown catalog export from Supabase

#### Context

PMs need to review source mappings (canonical names, statuses, feed URLs, ingestion weights) without logging into Supabase. The source registry lives in `source_feed_mapping` joined with `source_entities`. There is no existing human-readable artifact that reflects DB state without a DB connection.

#### Decision

Added a generator script that produces a deterministic, read-only Markdown catalog:

- **Generator:** [`apps/api/src/ops/source-registry-catalog-generate.mjs`](apps/api/src/ops/source-registry-catalog-generate.mjs) — queries `source_feed_mapping` + `source_entities` (filtered to `active=true` at query time), sorts and groups rows, writes `SOURCE-REGISTRY-CATALOG.generated.md`.
- **Output:** [`SOURCE-REGISTRY-CATALOG.generated.md`](SOURCE-REGISTRY-CATALOG.generated.md) — DO NOT EDIT; Supabase remains the canonical source. No reverse sync from Markdown → DB. The catalog reflects active mappings only; inactive rows are intentionally excluded so PMs see the live ingestion scope.
- **npm scripts:** `source-catalog:generate` on `@tempo/api`; passthrough at workspace root.
- **Tests:** [`apps/api/src/ops/source-registry-catalog-generate.test.mjs`](apps/api/src/ops/source-registry-catalog-generate.test.mjs) covers ordering, grouping, empty-value dashes, header metadata, and no-mutation guard.

#### Why

- PMs can open `SOURCE-REGISTRY-CATALOG.generated.md` in Cursor and see a snapshot of all source mappings without a Supabase login.
- Keeping the generated file in the repo makes it reviewable in PRs and diffable over time.
- No schema changes or UI work required — pure read path on existing tables.

#### Tradeoffs

- The catalog is a point-in-time snapshot; it goes stale until regenerated. Acceptable for the current review cadence (regenerate before each PM review session).
- Storing a generated file in git creates noise in diffs. Mitigated by the `DO NOT EDIT` header and clear regeneration instructions.

#### Consequences

- Run `cd 05-engineering && npm run source-catalog:generate` to refresh the catalog.
- The generated file is committed as a read-only artifact; edits to it will be overwritten on the next generation run.

---

### 2026-05-03 - D-045 - Phase 4: daily net-new source digest hardening

#### Context

Phase 2 (D-043) shipped the `v_source_net_new_24h` view + `source-delta-digest.mjs` + the GitHub Actions cron. Phase 3 (D-044) promoted Supabase to source of truth for the feed manifest. Phase 4 hardens the digest loop without adding new product UI or migrating the scheduler.

Three gaps were identified after Phase 3:
1. **Non-deterministic output** — `v_source_net_new_24h` has no ORDER BY (intentional at the view level), but the digest script passed rows to `formatDigest` in DB-returned order, making output non-reproducible across runs with the same data.
2. **Thin test coverage** — tests verified section presence but not row ordering or input-mutation safety.
3. **Operator debuggability** — GitHub Actions logs showed no metadata about whether the Slack webhook was configured before the script ran.

#### Decision

Hardened the digest loop in three areas:

1. **Deterministic sort in `formatDigest`** ([`apps/api/src/ops/source-delta-digest.mjs`](apps/api/src/ops/source-delta-digest.mjs)) — sorts a copy of the input rows (highest `times_seen` first, then earliest `first_seen_at` as a tie-breaker) before grouping. Input array is never mutated. Sort lives in the formatter, not `run()`, so it is covered by unit tests without needing a DB connection.

2. **Extended test suite** ([`apps/api/src/ops/source-delta-digest.test.mjs`](apps/api/src/ops/source-delta-digest.test.mjs)) — three new tests: ordering by `times_seen`, tie-break by `first_seen_at`, and no-mutation guard.

3. **Workflow observability** ([`.github/workflows/source-digest.yml`](../.github/workflows/source-digest.yml)) — added a pre-run echo that logs UTC timestamp and whether the Slack webhook is configured (or dry-run mode active).

No new migrations, no product UI, no scheduler migration.

#### Why

- Sort belongs in the formatter because `v_source_net_new_24h` explicitly documents "no ORDER BY at view level; consumers sort." Enforcing it in the formatter keeps the sort testable as a pure function.
- Dry-run mode ambiguity (`SOURCE_DIGEST_SLACK_WEBHOOK_URL` not set) was invisible in logs until the script reached that branch. Echoing it upfront removes guesswork when debugging scheduled runs.
- Input-mutation guard prevents a class of subtle bug where calling `formatDigest` twice with the same rows could produce different output if a future caller sorts in place.

#### Tradeoffs

- The sort is O(n log n) on the formatter input. At expected volumes (< 50 rows/day) this is negligible.
- Adding a `ORDER BY` to the Supabase query in `run()` would also work, but then the sort guarantee would live outside the testable unit. Formatter-level sort is the more defensive choice.

#### Consequences

- `formatDigest` now always returns rows in deterministic order regardless of DB return order.
- GitHub Actions run logs now include a clear "dry-run mode" or "webhook configured" line before the script output.
- See [`SOURCE-REGISTRY-PHASE4-PLAYBOOK.md`](SOURCE-REGISTRY-PHASE4-PLAYBOOK.md) for updated operator instructions.

---

### 2026-05-02 - D-044 - Phase 3 Option B: Supabase as source of truth for ingestion feed manifest

#### Context

Phases 0–2 built out source discovery (tracking user-mentioned sources via `source_registry_events`) and the operator mapping workflow (`source_entities`, `source_feed_mapping`). The ingestion manifest — which feeds the API actually serves via `GET /api/ingestion/sources` — was still read from `apps/api/data/source-feeds.json`. This created a split: operators could map sources in Supabase but had to edit JSON and redeploy to change what gets ingested.

Two paths were considered:

- **Option A (JSON-first):** keep `source-feeds.json` as the source of truth; use Supabase as a secondary mirror.
- **Option B (DB-first):** promote Supabase (`source_feed_mapping` + `source_entities`) to the source of truth; keep JSON as a seed and offline fallback.

#### Decision

Chose **Option B**. Built:

1. **Migration 007** ([`apps/api/src/db/migrations/007_source_feed_manifest_columns.sql`](apps/api/src/db/migrations/007_source_feed_manifest_columns.sql)) — adds `ingestion_weight` (integer, 0–100, default 50) and `active` (boolean, default true) to `source_feed_mapping`. Safe to re-run.

2. **DB manifest reader** ([`apps/api/src/ingestion/feed-manifest-repo.mjs`](apps/api/src/ingestion/feed-manifest-repo.mjs)) — `listIngestionFeeds({ supabase })` queries `source_feed_mapping` joined with `source_entities`, filters to `mapped`/`verified` rows with a URL, and returns items shaped identically to the existing JSON response items (`id`, `name`, `kind`, `url`, `weight`, `active`). Ordered by weight desc, name asc.

3. **Route update** ([`apps/api/src/server.mjs`](apps/api/src/server.mjs)) — `GET /api/ingestion/sources` reads from DB (via `_feedManifest.list`) when Supabase is enabled; falls back to `source-feeds.json` when Supabase is not configured. DB failure returns 500 with a clear error message — no silent fallback to JSON.

4. **Import script** ([`apps/api/src/db/source-feeds-import.mjs`](apps/api/src/db/source-feeds-import.mjs)) — one-time seed that reads `source-feeds.json` and upserts into `source_entities` + `source_feed_mapping`. Idempotent; preserves `status = 'verified'` on existing rows.

#### Why Option B over Option A

- The operator already edits `source_feed_mapping` for the daily digest workflow; merging manifest management into the same table eliminates two parallel write paths (JSON and DB).
- DB rows can be updated live without a code deploy; JSON changes require a commit and redeploy.
- The existing `mapped`/`verified` status gate provides natural control over which feeds are active.
- JSON fallback is preserved for offline or test environments that do not have Supabase configured.

#### Tradeoffs

- Operators must apply migration 007 and run the import script before the DB path is live.
- `listIngestionFeeds` makes a direct DB query per request (no in-process cache). Operators see changes immediately after updating a row — no restart needed.
- DB failure is a hard 500 rather than a silent JSON fallback. Intentional: hiding a broken DB connection could mask configuration drift in production.

#### Consequences

- Migration 007 must be applied to all environments (Supabase SQL Editor or CLI).
- Run `source-feeds-import.mjs` once per environment to seed the JSON entries into Supabase.
- `_feedManifest` hook exported from `server.mjs` for test injection (same pattern as `_sourceRegistrySync`).
- See [`SOURCE-REGISTRY-PHASE3-PLAYBOOK.md`](SOURCE-REGISTRY-PHASE3-PLAYBOOK.md) for operator instructions.

---

### 2026-05-02 - D-043 - Phase 2 Option A: SQL-first daily net-new source digest

#### Context

Phase 1 (D-039, D-041) delivers append-only `source_registry_events` rows when a user adds a source. The operator now needs a workflow to act on this data: identify unmapped sources and add them to [`apps/api/data/source-feeds.json`](apps/api/data/source-feeds.json) (or a canonical entity + feed mapping row). Two paths were considered:

- **Option A (SQL-first):** a PostgreSQL view + scheduled script send a daily Slack digest. The operator maps sources via SQL directly in the Supabase editor.
- **Option B (Admin API):** REST endpoints + admin UI for the mapping workflow.

#### Decision

Chose **Option A** for Phase 2. Built:

1. **Migration 006** ([`apps/api/src/db/migrations/006_source_net_new_view.sql`](apps/api/src/db/migrations/006_source_net_new_view.sql)) — `v_source_net_new_24h` view. Rolling 24-hour window of net-new, unmapped sources from `source_registry_events`. Excludes sources whose normalized form already has a `source_aliases` row linked to a `source_feed_mapping` row with `status IN ('mapped', 'verified')`. Returns `raw_string`, `kind`, `first_seen_at`, `last_seen_at`, `times_seen`, and `sample_user_ids` (bounded to 3).

2. **Digest script** ([`apps/api/src/ops/source-delta-digest.mjs`](apps/api/src/ops/source-delta-digest.mjs)) — daily sender. Queries `v_source_net_new_24h` via the service role, formats a Slack-compatible text block, posts to `SOURCE_DIGEST_SLACK_WEBHOOK_URL` if set, dry-runs to stdout otherwise. Exits cleanly with a log message when there are no new sources. `formatDigest` is exported as a pure function for unit testing.

3. **GitHub Actions workflow** ([`.github/workflows/source-digest.yml`](../.github/workflows/source-digest.yml)) — daily cron at 09:00 UTC with `workflow_dispatch` for manual runs. Loads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SOURCE_DIGEST_SLACK_WEBHOOK_URL` from repository secrets.

4. **Operator playbook** ([`SOURCE-REGISTRY-PHASE2-PLAYBOOK.md`](SOURCE-REGISTRY-PHASE2-PLAYBOOK.md)) — daily loop, SQL snippets for entity/alias/feed-mapping creation, manual run instructions, and a troubleshooting checklist.

#### Why Option A over Option B

- Option A ships immediately: no new endpoints, no new UI surface, no additional auth logic.
- The operator is technical and comfortable with SQL; a UI adds latency to the feedback loop without adding capability at this stage.
- The view + script is independently schedulable, dry-runnable, and trivially auditable.
- Source volume is expected to be low (< 50/day) while N=1 operator. SQL tooling is faster than building and validating admin CRUD.
- Shipping Option A first gives real data on digest volume and mapping frequency before committing to the Option B investment.

#### Tradeoffs

- Mapping is manual SQL — slower per-source but requires zero UI investment.
- No mapping history / audit log beyond what the DB tables already provide.
- Exclusion relies on the alias table: an entity without a matching alias will keep appearing in the digest until the operator adds one (documented in the playbook troubleshooting section).

#### Trigger for Option B migration

- Daily digest consistently shows > 50 unmapped sources, **or**
- A second non-technical operator needs to manage mappings (SQL access is a bottleneck).

#### Consequences

- `v_source_net_new_24h` must be applied to all environments via migration 006.
- No application code changes — the digest runs out-of-band from the API server.
- Three new GitHub secrets required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SOURCE_DIGEST_SLACK_WEBHOOK_URL`.
- Unit tests added for `formatDigest` in [`apps/api/src/ops/source-delta-digest.test.mjs`](apps/api/src/ops/source-delta-digest.test.mjs).

### 2026-05-02 - D-042 - Phase 1.1 hardening: intra-payload dedupe in `computeDeltaRows`

`computeDeltaRows` now builds `Set`s from `nextPayload.{traditional,social}Sources` before filtering against the previous sets. A repeated string within a single request (e.g. `["NYT","NYT"]`) now emits exactly one row rather than one per occurrence. The previous-vs-next delta semantics and exact-match behaviour are otherwise unchanged.

### 2026-05-02 - D-041 - Phase 1.1: delta-only source registry events (no duplicates across saves)

#### Context

Phase 1 (D-039) appended one `source_registry_events` row per source string on every `PUT /api/settings` call, regardless of whether the source was already present in the user's previous settings. Repeated saves — or saves that only removed sources — produced duplicate rows and inflated daily-delta counts.

#### Decision

- **`computeDeltaRows({ userId, previousPayload, nextPayload })`** added to [`apps/api/src/db/source-registry-sync.mjs`](apps/api/src/db/source-registry-sync.mjs) as an exported pure function. Uses `Set`-based diffing (exact match, no normalization yet): only strings in `nextPayload.{traditional,social}Sources` that are absent from the corresponding previous set produce new rows.
- **`recordSourceRegistryEventsFromSettings`** signature changed from `{ userId, payload }` to `{ userId, previousPayload, nextPayload }`. Delegates to `computeDeltaRows`; all other behaviour (Supabase gate, error swallowing) unchanged.
- **`PUT /api/settings` handler** now reads previous settings for the user before calling `writeSettings`: uses `hasSettings()` (non-destructive) then `readSettings()`; both wrapped in a local try/catch so any read failure silently falls back to `previousPayload: null` (first-save semantics — log all current sources once).
- First-save semantics: `previousPayload` null → previous sets are empty → all sources in the new payload are logged.

#### Why

- Duplicate events break daily-delta digest queries that count new sources introduced per day.
- Removal-only saves (user shortens their list) should not produce any events; no source was newly requested.
- Reading previous before writing is safe because `hasSettings` is non-destructive and the read is wrapped defensively.

#### Consequences

- Daily-delta queries on `source_registry_events` now reflect actual additions, not repeated saves.
- No schema changes required.
- `_sourceRegistrySync.record` hook call site in `server.mjs` updated; tests updated accordingly.

### 2026-05-02 - D-040 - Migration 005: `service_role` DML grants on source registry tables

#### Context

- Phase 1 sync (`PUT /api/settings` → `source_registry_events` batch insert) failed on the live Supabase project with: `"permission denied for table source_registry_events"` — even though the server uses `SUPABASE_SERVICE_ROLE_KEY`.
- Root cause: the Supabase `service_role` PostgreSQL role bypasses RLS row-checks but still requires explicit table-level `GRANT` on tables created after the project's initial provisioning. Phase 0 tables were created with RLS enabled and no default grants for `service_role`.
- A manual `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE source_registry_events TO service_role` on the live DB unblocked the sync.

#### Decision

- Added [`apps/api/src/db/migrations/005_source_registry_service_role_grants.sql`](apps/api/src/db/migrations/005_source_registry_service_role_grants.sql).
- Grants `SELECT, INSERT, UPDATE, DELETE` on all four Phase 0 source registry tables (`source_entities`, `source_aliases`, `source_registry_events`, `source_feed_mapping`) to `service_role`.
- `GRANT` is additive and idempotent — re-running this migration is safe.

#### Why

- A manual hotfix is not reproducible: new environments (staging, fresh Supabase project) would hit the same permission error silently on first sync.
- Codifying grants in a migration ensures they are applied in order with the rest of the schema setup.

#### Consequences

- Operators must apply this migration to any environment where Phase 0 tables exist (`supabase db push` or SQL editor).
- No application code changes — this is a privilege-only fix.
- Future source registry tables should include explicit `service_role` grants in their creation migration rather than relying on defaults.

### 2026-05-02 - D-039 - Phase 1: `source_registry_events` sync on `PUT /api/settings`

After a successful `writeSettings` call in `PUT /api/settings`, the server appends one row to `source_registry_events` per listed traditional or social source string, using a batch `.insert()` via the Supabase client from [`apps/api/src/db/source-registry-sync.mjs`](apps/api/src/db/source-registry-sync.mjs). The sync is gated on `isSupabaseEnabled()` (requires `SUPABASE_URL` plus a key, matching the client’s ability to insert). File-backed environments and tests without `SUPABASE_URL` no-op with no error. Failures are logged via `console.error` and never re-thrown, so a registry insert error cannot fail a settings save that already persisted. [`server.mjs`](apps/api/src/server.mjs) exports `_sourceRegistrySync` for tests to intercept `record`. `resolved_entity_id` stays null; deduplication remains a digest-time concern.

### 2026-05-02 - D-038 - Source registry schema (Phase 0)

#### Context

- Users configure `traditionalSources` and `socialSources` in settings JSON; strings can be removed from settings, but the product direction calls for a **persistent append-only record** of what was ever requested, plus canonicalization (aliases) and operator mapping to RSS/social URLs aligned with [`apps/api/data/source-feeds.json`](apps/api/data/source-feeds.json).

#### Decision

- Added migration [`apps/api/src/db/migrations/004_source_registry.sql`](apps/api/src/db/migrations/004_source_registry.sql):
  - **`source_entities`:** canonical outlet/account (`canonical_name`, `kind`, `notes`, timestamps); unique on `(kind, canonical_name)`.
  - **`source_aliases`:** `alias_raw` + `alias_normalized` (globally unique) → `source_entity_id`.
  - **`source_registry_events`:** append-only rows per observation (`user_id`, `raw_string`, `kind`, `seen_at`, optional `resolved_entity_id`).
  - **`source_feed_mapping`:** one row per entity (`status` pending/mapped/verified/rejected, `rss_url`, `social_profile_url`, `manifest_feed_id`, verification fields).
  - **`normalize_source_alias(text)`:** immutable SQL helper — trim, collapse whitespace, lowercase (used for `alias_normalized`; does not strip domain punctuation so `NYT` and `nytimes.com` stay distinct until aliased manually).
- **RLS:** enabled on all four tables with **no** policies for `anon`/`authenticated` (same approach as [`apps/api/src/db/schema.sql`](apps/api/src/db/schema.sql)); server uses service role until client-side access is required.

#### Why

- Supabase remains system of truth; avoids dual-write with Markdown.
- Events table supports daily delta and audit without mutating user settings.

#### Consequences

- Operators apply DDL per [`MODE2-SOURCE-REGISTRY-PHASE0.md`](MODE2-SOURCE-REGISTRY-PHASE0.md) before Phase 1 inserts succeed.
- Phase 1 (D-039) writes to `source_registry_events`; canonical/alias/mapping rows remain manual or admin-driven until later slices.

### 2026-05-01 - D-037 - Archive removal and logout hardening (branch `work/logout`)

#### Context

- Archive section (`/archive`, `/archive/signal-radar`, `/archive/evidence-desk`, `/archive/analyst-briefing`) had served as a showcase of discarded prototype directions. It was no longer useful as a live route surface and added dead weight to the app.
- Legacy redirect routes (`/d/signal-radar`, `/d/evidence-desk`, `/d/analyst-briefing`, `/directions`) pointed only at archive pages and were no longer referenced anywhere.
- `ProtectedRoute` had a DEV-only bypass (`if (import.meta.env.DEV) return children`) that let all routes through in development regardless of proto session state, diverging dev and prod behavior.
- Logout did not navigate after clearing session, leaving the user on a protected page that would only redirect on the next render cycle. `supabase.auth.signOut()` was also unguarded against network errors.
- `AppHeader` suppressed the proto-session check in DEV (`!import.meta.env.DEV && !getProtoSession()`), consistent with the old bypass but no longer correct once the bypass was removed.

#### Decision

- **Archive removed:** Deleted `src/pages/archive/` (5 files) and `src/components/ArchiveBanner.tsx`. Removed all archive imports, routes, and legacy redirect routes from `src/App.tsx`. Legacy URLs (`/archive`, `/archive/*`, `/d/*`, `/directions`) now fall through to `NotFound` — consistent with all other unknown paths.
- **`AppHeader.tsx`:** Removed unused `NAV` constant (contained `/archive` entry, was not rendered). Removed dead `isDevPreview` variable. Unified proto-session guard: `if (!getProtoSession()) return null` applies in all environments.
- **`ProtectedRoute.tsx`:** Removed the `if (import.meta.env.DEV) return <>{children}</>` bypass. Proto-session check now runs in DEV and prod identically. Without a valid session, protected routes redirect to `/` with `replace` in all environments.
- **`auth.tsx`:** Wrapped `supabase.auth.signOut()` in try/catch. Proto session is cleared first; server-side sign-out failure (e.g. offline) does not block local logout.
- **`AppHeader.tsx` logout:** Added `handleLogout` that calls `logout()` then `navigate("/", { replace: true })`. Replace ensures the current history entry becomes `/`, so Back from landing cannot return to a protected page (ProtectedRoute would redirect anyway since proto session is gone).
- **Tests:** Added `src/components/ProtectedRoute.test.tsx` — 2 tests covering redirect-when-no-session and render-when-session-exists.

#### Why

- Removing archive eliminates dead surface area and dead redirects with no user value.
- Unifying the DEV/prod ProtectedRoute behavior means integration tests and dev iteration reflect what production enforces.
- Replace-style navigation after logout is the simplest reliable approach for preventing Back-button re-entry into protected pages without exotic history manipulation.
- Tolerating a failed `signOut` (offline) while still clearing local state matches the product requirement: from the app's perspective, the user is always logged out after clicking Log out.

#### Consequences

- `npm test` → 95 tests, 0 failures (8 test files; 2 new ProtectedRoute tests added).
- `npm run build` → exits 0.
- `/archive`, `/archive/*`, `/d/*`, `/directions` now return NotFound.
- DEV environment now requires going through the landing flow (proto session) to access protected routes.
- Historical references to archive routes in D-011 and D-024 remain accurate as records of what was decided at those times; this entry records the subsequent removal.

### 2026-04-24 - D-036 - Slice 18 hardening: enforce 401 on protected API routes

#### Context

Follow-on to D-035 on the same branch. Slice 18's initial implementation called `resolveUserId` on the three protected routes but silently fell back to global settings when the resolver returned null. The policy change requires an explicit 401 gate — no silent fallback — on `GET /api/settings`, `PUT /api/settings`, and `GET /api/dashboard`.

#### Decision

- **`server.mjs`:** Introduced `export const _auth = { resolver: resolveUserId }` — a mutable hook on a plain object so tests can inject a deterministic resolver without a live Supabase instance. Introduced `requireAuth(req, res)` that calls `_auth.resolver`, sends `401 { message }` on null, and returns the user ID on success. Applied to all three protected routes. On `PUT /api/settings`, the auth check now precedes payload validation (previously it was after). `GET /api/dashboard` now passes `userId` to `readSettings` instead of reading the global key.
- **`server.routes.test.mjs`:** Added `_auth` to the import. Set `_auth.resolver = async () => TEST_USER_ID` at module level so all existing tests authenticate deterministically without Supabase. Added three new 401 tests (one per protected route) using `try/finally` to safely override and restore the resolver. Test count: 51 → 54.
- **`04-prototype/.env.example`:** Fixed misleading single-port example for the Supabase redirect URL allowlist. Clarified that the callback URL is built from `window.location.origin` at runtime and that operators must register every origin they use (Supabase does not support port wildcards for localhost).

#### Why

- The silent-fallback pattern let any unauthenticated caller read and overwrite any user's settings (or the global key), which violates the per-user isolation goal of slice 18.
- The `_auth` object hook (mutable property on an exported const) is the idiomatic ESM approach for test injection without a mocking library — exported `let` bindings cannot be reassigned from outside the module.
- Moving the auth check before payload validation on PUT ensures the API never leaks whether a payload is valid to an unauthenticated caller.

#### Consequences

- `npm run test:api` → 54 tests, 0 failures.
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- Unauthenticated callers to the three protected routes now always receive 401; no partial data is returned.

### 2026-04-24 - D-035 - Slice 18: real Supabase Auth (magic link) + per-user settings

#### Context

Slice 18 (branch `build/slice17-auth-flow-import`). In-scope: frontend auth wiring (`04-prototype`), API auth middleware (`05-engineering/apps/api`), settings persistence keyed by user ID, and required env var / redirect-URL documentation. Out of scope: UI redesign, mobile changes, onboarding settings save, broad refactor.

#### Decision

- **Frontend auth (`src/lib/auth.tsx`):** Replaced the simulated `localStorage.getItem === "1"` pattern with real Supabase Auth. `AuthProvider` initializes from `supabase.auth.getSession()`, subscribes to `onAuthStateChange`, and exposes `user`, `session`, and `loading` in context. `signIn(email, type)` calls `signInWithOtp` with an `emailRedirectTo` that embeds the `type` query param so the callback can distinguish new vs. returning users.
- **New `AuthCallback` page:** Handles the Supabase magic-link redirect at `/auth/callback`. Routes to `/onboarding` for `type=signup` and `/dashboard` for `type=login`. The Supabase JS SDK processes the URL fragment automatically; `onAuthStateChange` fires in the provider and flips `isAuthenticated`.
- **Settings scoping (frontend):** `fetchSettingsPayload` and `saveSettingsPayload` now call `supabase.auth.getSession()` before each request. They scope the localStorage cache key to `tempo.settings.v1.{user_id}` and include `Authorization: Bearer {access_token}` in API calls. Degrades gracefully when Supabase is unconfigured.
- **API auth middleware (`server.mjs`):** Added `resolveUserId(req)` which extracts the Bearer token, calls `supabase.auth.getUser(token)` with the service-role client (JWT verification), and returns the user UUID. Returns `null` when no token or Supabase is unconfigured. `GET /api/settings` and `PUT /api/settings` pass the resolved ID to the repo layer.
- **Settings repo (`settings-repo.mjs`):** `readSettings(userId)` and `writeSettings(payload, userId)` now accept an optional `userId`. Supabase adapter uses key `user:{uuid}`; file adapter uses `settings_user_{userId}.json`. Unauthenticated calls (no userId) continue to use the global key — all existing tests pass unchanged.
- **Schema:** No DDL change. Per-user settings use a key-prefix convention (`user:{uuid}`) within the existing `settings` table. A migration file (`002_user_settings.sql`) documents the convention and provides RLS policy snippets for a future slice.
- **`ProtectedRoute`:** Added `loading` guard to prevent flash-redirect to `/` while session is being restored on initial load.

#### Why

- The simulated auth (`localStorage === "1"`) had no user identity, making per-user settings impossible. Real Supabase Auth provides a stable `user.id` that can key both the client-side localStorage cache and the server-side DB row.
- Key-prefix approach (`user:{uuid}`) avoids a schema migration on the `settings` table while preserving backward compatibility with file-adapter deployments and all existing tests.
- `supabase.auth.getUser(token)` with the service-role client is the recommended Supabase pattern for server-side JWT verification — it validates the token against the Auth server, not just locally.

#### Consequences

- `npm run test:api` → 51 tests, 0 failures (unchanged).
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- Operator must add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to `04-prototype/.env` and `SUPABASE_SERVICE_ROLE_KEY` to the API `.env` for real auth to function. Without these vars both layers degrade gracefully (settings fall back to global key; auth UX shows a toast error on submit).
- Operator must whitelist `/auth/callback` in Supabase Auth → URL Configuration → Redirect URLs.
- Slice 18 is closed.

### 2026-04-23 - D-034 - Slice 16: staging handoff runbook (no code changes)

#### Context

Slice 16 (branch `build/slice16-next`). In-scope: `MODE2-SLICE-16-STAGING-HANDOFF.md` (new), `DECISIONS.md` (this entry). Objective: produce a staging-handoff artifact targeted at deploying to a remote host and granting the first external user access — distinct from Slice 15's local/internal beta checklist.

#### Decision

- Added `05-engineering/MODE2-SLICE-16-STAGING-HANDOFF.md` documenting:
  - **Env var matrix** for both API and frontend layers, with staging-specific values (absolute `TEMPO_DATA_DIR` path, `TEMPO_AI_MOCK_ONLY=true` as the safe staging default, `VITE_*` vars baked at build time, EU PostHog host option).
  - **Exact startup commands** for a remote host: `npm install` → `npm run build` → `node apps/api/src/server.mjs` in the background → static frontend served via `npx serve` or reverse proxy. Includes reverse-proxy guidance (nginx / Caddy) for same-domain `/api/*` forwarding.
  - **Smoke-test checklist** executed from outside the staging host (external `curl` and clean browser session), covering infrastructure reachability, auth redirect flow, persistence across API restart, and PostHog event confirmation.
  - **Failure and rollback steps** for the three most likely staging failure modes: API won't start (env misconfiguration paths named), data lost after restart (file path vs Supabase seat), blank frontend (reverse proxy or CORS). Full rollback is git checkout + rebuild + data restore.
  - **Go/no-go checklist** with 7 technical gates (T1–T7) and 5 operational gates (O1–O5), each with explicit GO criteria and a binary pass/fail status column. A single NO-GO item blocks handoff.
- No code changes made. All four validation gates pass unchanged.

#### Why

- Slice 15 addressed internal operator readiness (single developer, local machine, no external users). Slice 16 is necessary because staging introduces three qualitatively different constraints: (1) the operator is not physically present when the external user first accesses the system, (2) the frontend is a static build (not Vite dev server) requiring explicit build-time env var baking, and (3) a formal go/no-go gate is needed before any external party touches the system.
- The reverse proxy startup path and `VITE_*` build-time variable note are staging-specific concerns not covered in Slice 15 and not derivable from reading the local dev setup.
- The go/no-go table gives the operator a single, auditable decision artifact — important when handing off to a non-technical external user who cannot diagnose failures independently.

#### Consequences

- `npm run test:api` → 51 tests, 0 failures (unchanged).
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- No behavioral changes to the API, prototype, or shared packages.
- Slice 16 is closed. The staging handoff runbook is the canonical artifact for first external-user deployment.

### 2026-04-23 - D-033 - Slice 15: beta readiness checklist (no code changes)

#### Context

Slice 15 (branch `build/slice14-observability-posthog`). In-scope: `MODE2-SLICE-15-BETA-READINESS-CHECKLIST.md` (new), `DECISIONS.md` (this entry). Objective: produce a production-readiness artifact for beta handoff — env var reference, startup steps, smoke-test checklist, rollback procedure, and launch day checklist — without any UI, auth, or feature changes.

#### Decision

- Added `05-engineering/MODE2-SLICE-15-BETA-READINESS-CHECKLIST.md` documenting:
  - **Required env vars** for both API and frontend layers, grouped by service (Supabase, AI model routing, PostHog), with Required/Optional/Conditional classification and safe defaults noted.
  - **Local startup steps** covering the common `npm run dev` path plus optional splits for API-only and web-only.
  - **Smoke-test checklist** covering all nine API routes (`/health`, `/api/settings` GET/PUT, `/api/dashboard`, `/api/dashboard?limit`, `/api/ai/models`, `/api/ai/metrics`, `/api/ingestion/sources`), all frontend flows (auth redirect, onboarding, dashboard render, settings persistence, logout), and a persistence verification step.
  - **Rollback checklist** covering process stop, settings file restoration, Supabase row restoration, and PostHog disable.
  - **Launch day checklist** split into pre-launch validation, launch sequence, and 30-minute post-launch monitoring steps.
  - **Known risks at beta** table documenting the four accepted risks: localStorage auth, static ingestion data, unbounded AI cost, and Supabase anon-key RLS gap — each with a severity level and mitigation note.
- No code changes made. All four validation gates passed unchanged before and after this slice.

#### Why

- Slices 11–14 completed the core technical foundation (Supabase persistence, Anthropic wiring, ingestion normalization, PostHog observability). The system can now be handed to a beta operator, but there was no single document describing how to stand it up, verify it, or recover from a failure.
- A runbook-style checklist reduces the risk of misconfiguration during handoff without requiring any further feature work.
- Documenting known risks explicitly (auth model, static ingestion, AI cost, RLS) ensures the beta operator understands the constraints without discovering them in production.

#### Consequences

- `npm run test:api` → 51 tests, 0 failures (unchanged).
- `npm run test:packages` → 18 tests, 0 failures (unchanged).
- `npm run test:prototype` → 9 tests, 0 failures (unchanged).
- `npm run build` → exits 0 (unchanged).
- No behavioral changes to the API, prototype, or shared packages.
- Slice 15 is closed. The beta readiness checklist is the canonical handoff artifact for this build phase.

### 2026-04-23 - D-032 - Slice 14: observability + PostHog analytics wiring

#### Context

Slice 14 (branch `build/slice14-observability-posthog`). In-scope: `packages/analytics/src/` (event schema additions + new PostHog sink module), `apps/api/src/telemetry.mjs` (new), `apps/api/src/server.mjs` (telemetry wiring), `apps/api/src/telemetry.test.mjs` (new), `apps/api/.env.example` (new vars), `apps/api/package.json` (test script), `04-prototype/src/lib/analytics.ts` (PostHog init helper). Objective: wire a production-ready PostHog integration at both the API and frontend layers while keeping fail-safe behavior when env vars are absent.

#### Decision

- Added three server-side event schemas to `packages/analytics/src/events.ts`:
  - `api_dashboard_requested` (tier: primary) — payload: `storyCount`, `normErrorCount`, `limitApplied`, `fallbackCount`, `totalCostUsd`, `aiModel`.
  - `api_error` (tier: guardrail) — payload: `route`, `statusCode`, `message`.
  - `settings_updated` (tier: secondary) — payload: `topicCount`, `geoCount`, `sourceCount`.
  - Each has a matching Zod schema, a typed builder function, and is included in the `analyticsEventSchema` discriminated union.
- Added `packages/analytics/src/posthog-sink.ts`: exports `createPostHogSink({ apiKey, host?, distinctId? })`. Uses platform `fetch` (Node 18+ and browsers) to POST to PostHog's `/capture/` endpoint. No new npm dependency. All fetch failures are swallowed — the sink never throws. Updated `tsconfig.build.json` to include the new file; added `"types": ["node"]` to the base `tsconfig.json` so `fetch` is typed for IDE and vitest.
- Added `apps/api/src/telemetry.mjs`: exports `trackServerEvent(name, properties)`. Reads `POSTHOG_API_KEY` and `POSTHOG_HOST` lazily (at call time, not import time) so test isolation is clean without module re-import tricks. No-op when key is absent. Uses `distinct_id: "tempo-api-server"` (server-side events are not user-attributable at this stage).
- Updated `apps/api/src/server.mjs`: imports `trackServerEvent` and calls it on three paths — `api_dashboard_requested` on successful dashboard response (with story count, cost, fallback count, AI model), `settings_updated` on successful settings write, and `api_error` on 500 failures in both routes.
- Added `apps/api/src/telemetry.test.mjs`: 4 tests covering the no-key no-op path, correct fetch payload when key is set, custom `POSTHOG_HOST` override, and swallowed fetch errors.
- Added `packages/analytics/src/posthog-sink.test.ts`: 7 tests covering sink creation, correct fetch call shape, default host/distinctId fallbacks, error swallowing, and server-side event schema compatibility.
- Added PostHog section to `apps/api/.env.example`: documents `POSTHOG_API_KEY` and `POSTHOG_HOST` with comments about EU cloud and no-key behavior.
- Updated `04-prototype/src/lib/analytics.ts`: added `initPostHog()` — reads `VITE_POSTHOG_API_KEY` and `VITE_POSTHOG_HOST` from the Vite env, generates a session-scoped `distinctId` stored in `sessionStorage` (falls back to `"tempo-anonymous"` when storage is unavailable), and calls `setAnalyticsSink(createPostHogSink(...))`. Must be called from `main.tsx` at app startup; no-op if key is absent.

#### Why

- Fetch-based PostHog capture avoids a new runtime dependency (`posthog-node` / `posthog-js`). The PostHog HTTP capture endpoint is stable and has no SDK requirement for basic event ingestion.
- Lazy env reads in `telemetry.mjs` match the pattern established in D-031 (model-router lazy reads) and keep tests isolated without module lifecycle hacks.
- Adding server-side event schemas to `packages/analytics` (rather than keeping them inline in `.mjs`) gives TypeScript consumers a single canonical reference for all events in the system, even though the API doesn't validate them at runtime.
- Session-scoped `distinctId` in `sessionStorage` avoids persistent user fingerprinting while still allowing funnel analysis within a session — appropriate for a private enterprise tool with a single operator.
- `api_dashboard_requested` captures AI cost and fallback telemetry that was previously only logged to stdout, making it queryable in PostHog dashboards without changing the existing `console.log` paths.

#### Consequences

- `npm run test:api` now runs 51 tests (up from 38; 4 new telemetry tests). All pass.
- `npm run test:packages` now runs 18 analytics tests (up from 11; 7 new posthog-sink tests). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint` exits 0. `node --check server.mjs` exits 0.
- When `POSTHOG_API_KEY` is absent (default dev/test mode), zero PostHog traffic is generated. No runtime crashes, no network calls.
- Frontend PostHog activation requires adding `VITE_POSTHOG_API_KEY` to `04-prototype/.env.local` and calling `initPostHog()` from `main.tsx` (one line, not in scope for this slice).

### 2026-04-23 - D-031 - Slice 13: real Anthropic provider wiring, lazy env, mock-only flag

#### Context

Slice 13 (branch `build/slice13-real-ai-provider-wiring`). In-scope: `apps/api/src/ai/providers/anthropic.mjs` (new), `apps/api/src/ai/model-router.mjs` (updated), `apps/api/src/ai/model-router.test.mjs` (extended), `apps/api/package.json` (new dependency), `apps/api/.env.example` (new vars), `apps/api/src/server.mjs` (startup validation + model endpoint). Objective: wire a production-ready Anthropic execution path through the existing model-router abstraction while keeping mock and fallback paths fully intact.

#### Decision

- Added `src/ai/providers/anthropic.mjs`: wraps `@anthropic-ai/sdk`. Accepts `{ apiKey, model, prompt, timeoutMs }`, creates a scoped `Anthropic` client with SDK-level timeout, calls `messages.create` (max_tokens=256, temperature=0.2), and returns `{ summary, inputTokens, outputTokens }` from actual API usage. Empty-response guard throws rather than silently returning garbage.
- Updated `src/ai/model-router.mjs`:
  - Converted `CAPABILITY_DEFAULTS` from a module-level constant to `getCapabilityDefaults()` (lazy env read), so tests can set `TEMPO_AI_SUMMARY_MODEL` after import without module re-import hacks.
  - `providerFor(model)` now exported. Reads `TEMPO_AI_MOCK_ONLY` at call time; if `"true"`, forces all providers to their mock equivalent regardless of model prefix.
  - Added `resolveModelName(model)` to strip the `anthropic:` or `openai:` prefix before handing the bare model ID to the provider.
  - Added `ANTHROPIC_COSTS` table with per-MTok input/output pricing for Haiku 4.5, Sonnet 4.6, Opus 4.7. When real token counts are available (Anthropic path), the cost calculation uses actuals; all other paths keep the existing heuristic estimate.
  - Added `assertAiConfig(capabilityMap?)` (exported): iterates configured models, throws a human-readable error if a real provider is configured without its API key. Accepts an optional `capabilityMap` argument for testability.
  - `summarizeCluster` routes through the Anthropic provider when `provider === "anthropic"`. Prefers `TEMPO_ANTHROPIC_API_KEY`; falls back to `ANTHROPIC_API_KEY` (SDK default env). Missing key throws immediately (caught by existing fallback handler — no silent failure).
  - All other existing paths (openai-compatible, mock-openai, mock-anthropic) and the heuristic fallback are unchanged.
- Updated `src/server.mjs`: imports `assertAiConfig`; calls it at app init and logs a `console.warn` if misconfigured (non-crashing — fallback keeps the server functional). `GET /api/ai/models` now includes `mockOnly: bool`.
- Added `@anthropic-ai/sdk ^0.91.0` to `apps/api` dependencies.
- Extended `model-router.test.mjs`: 12 new tests covering provider routing (`providerFor` unit tests), `TEMPO_AI_MOCK_ONLY` enforcement, `assertAiConfig` validation (pass/throw cases for both providers), and the full fallback path via lazy env reads (closes the Slice 10 known coverage gap for `providerErrors`/`summarizationFallbacks` counter increments).

#### Why

- The existing `openai-compatible` path required `TEMPO_OPENAI_API_KEY` and showed the correct pattern for real provider wiring; Anthropic follows the same shape.
- Lazy env reads (`getCapabilityDefaults()` at call time) eliminate the need for separate test processes or module re-import tricks to test different model configs — a direct improvement in test ergonomics without changing the public API contract.
- `TEMPO_AI_MOCK_ONLY=true` gives operators a single env toggle to run in mock mode for dev/CI without changing model config. Cheaper than per-model overrides.
- Actual token counts from the Anthropic response replace token estimation on the Anthropic path, making cost telemetry accurate rather than approximate for real API calls.
- `assertAiConfig()` at startup surfaces misconfiguration (real model, missing key) at the first API call via a logged warning rather than silently falling back, matching the fail-fast philosophy established in D-029.

#### Consequences

- `npm run test:api` now runs 38 tests (20 model-router + 6 settings-schema + 5 route-level + 7 settings-repo). All pass. Up from 26.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint` exits 0. Both `node --check` commands exit 0.
- No real Anthropic API calls are made in tests or default dev mode (default model is `mock-openai-mini`). Real provider activation requires explicit `TEMPO_AI_SUMMARY_MODEL=anthropic:<model>` + API key.
- Cost estimates for mock/openai paths remain heuristic (unchanged); Anthropic path uses actual token counts from API response.

### 2026-04-23 - D-030 - Slice 12: ingestion sources foundation — normalization layer + feed declaration

#### Context

Slice 12 (branch `build/slice12-ingestion-sources`). In-scope: `apps/api/src/ingestion/` (new), `apps/api/data/source-feeds.json` (new), `apps/api/src/server.mjs` (wiring), `apps/api/src/server.routes.test.mjs` (new test + seed), `apps/api/package.json` (test script), `MODE2-SLICE-12-INGESTION-SOURCES.md` (new). Objective: move ingestion from a direct static-file read to an explicit normalized pipeline while keeping the dashboard contract and all existing behavior stable.

#### Decision

- Added `src/ingestion/source-normalizer.mjs`: exports `normalizeSourceItem(raw)` and `normalizeSourceItems(rawItems)`.
  - `normalizeSourceItem` coerces known fields to canonical types, defaults optional fields, and throws on any missing required field (`clusterId`, `sourceId`, `outlet`, `kind`, `weight`, `url`, `minutesAgo`, `headline`, `body`).
  - `normalizeSourceItems` processes an array, skips invalid items (reports `{ index, error }` in an `errors[]` array) rather than aborting — one bad feed item must not kill the pipeline.
- Added `src/ingestion/feed-reader.mjs`: exports `readFeedItems(dataDir)` — thin abstraction over `source-items.json`. Swap this function to activate RSS, DB, or HTTP-based ingestion without touching normalization or downstream logic.
- Added `src/ingestion/source-normalizer.test.mjs`: 8 unit tests covering the happy path, optional-field defaults, string-body coercion, two missing-required-field cases, valid-batch pass-through, mixed-batch skipping with error reporting, and non-array TypeError.
- Modified `src/server.mjs`: removed `readSourceItems()` and `SOURCE_ITEMS_FILE`; imported `readFeedItems` and `normalizeSourceItems`; dashboard handler now passes through the normalization step and logs any skipped items. Added `GET /api/ingestion/sources` route (reads `source-feeds.json`; 500 on error).
- Added `data/source-feeds.json`: declares 6 source feeds (4 RSS + 2 social) with `id`, `name`, `kind`, `url`, `weight`, `active` fields. URLs are placeholders — no live fetching in this slice.
- Updated `src/server.routes.test.mjs`: seeds `source-feeds.json` in the isolated tmpDir; added test asserting `GET /api/ingestion/sources` returns 200 with a typed `feeds[]` array.
- Updated `package.json` test script: added `src/ingestion/source-normalizer.test.mjs`.

#### Why

- The direct `readSourceItems()` → `buildDashboardPayload()` path had no normalization seam: raw JSON was consumed as-is with no field coercion or validation. A single malformed item (wrong type, missing field) would either silently produce wrong output or throw inside the dashboard handler with no actionable error.
- Introducing a named normalization boundary makes the ingestion contract explicit: anything upstream of `normalizeSourceItems` can change shape; anything downstream (clustering, ranking, AI summarization) sees a consistent object.
- `readFeedItems` makes the data source swappable in one place. The next ingestion slice can replace the file read with RSS fetching, a Supabase query, or a webhook payload without modifying any of the ranking or AI layers.
- `source-feeds.json` documents declared sources as a machine-readable manifest. This is the intended config surface for a future feed-management UI and for the operator to understand which outlets are in scope.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 35 tests (8 model-router + 6 settings-schema + 6 route-level + 7 settings-repo + 8 normalizer). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- Dashboard contract (`dashboardPayloadSchema`) and all existing route behaviors are unchanged. Frontend consumers see no difference.
- `GET /api/ingestion/sources` is a new read-only endpoint; no auth guard in this slice (consistent with other API routes at this stage).
- Gap: `readFeedItems` still reads from `source-items.json` — no live RSS fetching yet. Next ingestion slice should replace `feed-reader.mjs` internals and add an RSS parsing/normalization path.
- Gap: `stories` and `summaries` Supabase tables remain unpopulated. Slice 13 can wire normalized items into the `stories` table behind the ingestion-repo boundary.

### 2026-04-23 - D-029 - Slice 11 durability fix: fail fast on partial Supabase config

#### Context

Post-build audit of Slice 11 (branch `build/slice11-supabase-foundation`). The original `readSettings()` / `writeSettings()` routing used `isSupabaseEnabled()`, which returns `false` when `SUPABASE_URL` is set but key vars are absent. This means a partially configured deployment (URL present, key missing) silently falls through to file storage — masking misconfiguration instead of surfacing it.

In-scope: `apps/api/src/db/settings-repo.mjs`, `apps/api/src/db/settings-repo.test.mjs`.

#### Decision

- Replace `isSupabaseEnabled()` routing in `readSettings()` and `writeSettings()` with an explicit `process.env.SUPABASE_URL` check followed by an `assertSupabaseEnv()` call.
- Behavior: if `SUPABASE_URL` is set → call `assertSupabaseEnv()` (throws on missing key) then use Supabase path. If `SUPABASE_URL` is unset → use file adapter. Silent fallback is no longer possible when `SUPABASE_URL` is present.
- Import: swap `isSupabaseEnabled` import for `assertSupabaseEnv` in `settings-repo.mjs`; `isSupabaseEnabled` is still exported from `client.mjs` for external callers.
- Add two tests to `settings-repo.test.mjs`: (1) `SUPABASE_URL` set + no key → `readSettings()` rejects with missing key message; (2) `SUPABASE_URL` unset → file adapter returns valid settings object. Existing 5 tests unchanged.

#### Why

- Silent fallback hides operator misconfiguration: a deployment with `SUPABASE_URL` set but no key would appear to work (using file storage) while never writing to Supabase. The error only surfaces later, at a data-loss point, not at startup.
- `assertSupabaseEnv()` already existed in `client.mjs` with the correct error message; applying it at the routing call site costs nothing and gives a human-readable failure on first use.

#### Consequences

- `readSettings()` / `writeSettings()` now throw immediately if `SUPABASE_URL` is set without a key — operators see a clear error at the first API call rather than silent file fallback.
- Deployments without `SUPABASE_URL` are unaffected; file adapter path is unchanged.
- `npm run test:api` now runs 26 tests (8 model-router + 6 settings-schema + 5 route-level + 7 settings-repo). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). Validation gates unchanged.

### 2026-04-23 - D-028 - Slice 11: Supabase production data foundation (Free-tier-first, Pro-ready)

#### Context

Slice 11 (branch `build/slice11-supabase-foundation`). In-scope: `apps/api/src/db/` (new), `apps/api/.env.example` (new), `apps/api/src/server.mjs` (settings wiring), `apps/api/package.json` (dependency + test script), `MODE2-SLICE-11-SUPABASE-FOUNDATION.md` (new). Objective: introduce a Supabase-backed persistence layer for settings while preserving existing file-based behavior in tests and local dev.

#### Decision

- Added `src/db/client.mjs`: Supabase client factory with `isSupabaseEnabled()`, `assertSupabaseEnv()`, and `getSupabaseClient()`. Client is only initialized when `SUPABASE_URL` + (`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY`) are present; otherwise no Supabase code runs.
- Added `src/db/settings-repo.mjs`: adapter that routes `readSettings()`/`writeSettings()` to either the file-based or Supabase implementation based on env. Exports `DEFAULT_SETTINGS` so server.mjs can reference `contractVersion` without a local duplicate.
- Added `src/db/schema.sql`: initial schema for `settings`, `stories` (placeholder), and `summaries` (placeholder). RLS enabled on all tables; server-side access via `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. Anon-key policies deferred to the auth slice.
- Added `src/db/settings-repo.test.mjs`: 5 tests covering file-adapter read/write, `isSupabaseEnabled` returns false without env, `assertSupabaseEnv` error messages for each missing-var case.
- Modified `src/server.mjs`: removed local `ensureSettingsFile`, `readSettings`, `writeSettings`, and `DEFAULT_SETTINGS`; imported equivalents from `./db/settings-repo.mjs`. `SETTINGS_FILE` constant removed; file path is now encapsulated in the repo.
- Added `@supabase/supabase-js ^2.0.0` to `apps/api` dependencies.
- Added `.env.example` documenting all env vars with inline notes on Free vs. Pro usage.

#### Why

- Adapter pattern keeps existing file-based path intact — tests and local dev need zero credentials.
- `SUPABASE_SERVICE_ROLE_KEY` is preferred over `SUPABASE_ANON_KEY` for server-side to bypass RLS (correct pattern for a trusted backend). Both are supported so operators can start with the anon key if they have not yet rotated credentials.
- `assertSupabaseEnv()` gives a human-readable startup error rather than a cryptic `createClient` failure when an operator partially configures the env.
- Schema separates `settings` (in use), `stories`, and `summaries` (placeholders) so future ingestion slices have a documented landing zone without schema churn.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 24 tests (8 model-router + 6 settings-schema + 5 route-level + 5 settings-repo). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- Supabase is inactive unless both `SUPABASE_URL` and a key var are set — no behavioral change for existing deployments.
- Auth is unchanged (localStorage-backed). Migration path to Supabase Auth is documented in `MODE2-SLICE-11-SUPABASE-FOUNDATION.md`; implementation is deferred to a future slice.
- Pro triggers: pg_cron for scheduled ingestion, DB size past 500 MB, realtime for live monitoring feeds — all documented in the slice artifact.

### 2026-04-23 - D-027 - Slice 10 audit pass: AI router hardening verified, snapshot isolation test added

#### Context

Audit pass of Slice 10 (branch `audit/claude-rebuild-slice10`). In-scope files reviewed: `apps/api/src/ai/prompts.mjs`, `apps/api/src/ai/providers/openai-compatible.mjs`, `apps/api/src/ai/model-router.mjs`, `apps/api/src/ai/model-router.test.mjs`, `apps/api/src/server.mjs`. Objective: harden the AI model-routing layer with prompt versioning, provider-ready path, and runtime telemetry counters.

#### Decision

- No functional code changes required. All Slice 10 functional requirements were already present and correct.
- Added one test to `[apps/api/src/ai/model-router.test.mjs](apps/api/src/ai/model-router.test.mjs)`:
  1. `getAiMetrics returns an isolated snapshot, not a live reference` — mutates the returned copy and verifies that a subsequent `getAiMetrics()` call is unaffected. This pins `return { ...aiMetrics }` as an explicit regression guard on the accessor contract.

#### Why

- `getAiMetrics()` returns `{ ...aiMetrics }` to prevent callers from directly mutating the internal counter state. The existing tests did not verify this isolation guarantee; without the test, a regression from `return { ...aiMetrics }` to `return aiMetrics` would be invisible to CI.
- All other Slice 10 requirements were verified in place: `SUMMARY_PROMPT_VERSION` propagated in both success and fallback `meta`, all four counter increments wired in the correct branches (`summarizationRequests` on every call; `providerErrors` + `summarizationFallbacks` on every error; `summarizationTimeouts` conditionally on timeout-message match), `GET /api/ai/metrics` endpoint returns `{ metrics: getAiMetrics() }`, and the `openai-compatible` provider path is activated when the model prefix is `openai:` and `TEMPO_OPENAI_API_KEY` is set.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 19 tests (8 model-router + 6 settings-schema + 5 route-level). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0. `node --check model-router.mjs` exits 0.
- Known gap: `summarizationFallbacks`, `providerErrors`, and `summarizationTimeouts` counter increments are not covered by tests. `CAPABILITY_DEFAULTS` is frozen at module load time; triggering the catch block requires either a mock injection seam or a separate test file run in a fresh process with `TEMPO_AI_SUMMARY_MODEL=openai:test` (no API key). Flagged as follow-up for the next hardening slice.
- Slice 10 is closed; AI router hardening (prompt versioning, provider-ready path, telemetry counters) is ready for any future slice that wires production provider credentials.

### 2026-04-23 - D-026 - Slice 9 audit pass: AI architecture verified, guardrail + fallback test coverage added

#### Context

Audit pass of Slice 9 (branch `audit/claude-rebuild-slice9`). In-scope files reviewed: `apps/api/src/ai/providers/mock-openai.mjs`, `apps/api/src/ai/providers/mock-anthropic.mjs`, `apps/api/src/ai/guardrails.mjs`, `apps/api/src/ai/model-router.mjs`, `apps/api/src/ai/model-router.test.mjs`, `apps/api/src/server.mjs`. Objective: introduce an MVP AI model architecture with capability routing and guardrailed summarization integrated into dashboard payload generation.

#### Decision

- No functional code changes required. All Slice 9 functional requirements were already present and correct.
- Added four tests to `[apps/api/src/ai/model-router.test.mjs](apps/api/src/ai/model-router.test.mjs)`:
  1. `summarizeCluster meta contains all expected fields on success path` — verifies every `meta` field is present and typed (capability, model, provider, elapsedMs, timedOut, fallbackUsed, promptTokens, outputTokens, costUsd, promptVersion) and that `timedOut` and `fallbackUsed` are false on the happy path.
  2. `withTimeout resolves when promise completes before deadline` — direct unit test of the `withTimeout` guardrail with a fast promise and long deadline.
  3. `withTimeout rejects with timeout message when deadline is exceeded` — direct unit test: a never-resolving promise + 10ms deadline → rejects with the exact error message `"AI summarization timed out"`. This pins the timeout mechanism and error message as an explicit assertion.
  4. `heuristicSummary returns non-empty string that includes cluster title` — verifies the fallback text generator returns a non-empty string and includes the cluster title, confirming the heuristic path is exercisable without provider dependency.

#### Why

- The timeout/fallback execution path is the critical reliability guarantee of Slice 9. The prior test suite only covered the happy path; any regression in `withTimeout` or `heuristicSummary` would have been invisible to CI.
- Testing `withTimeout` and `heuristicSummary` as direct unit tests (imported into `model-router.test.mjs`) avoids needing a mocking framework — both functions are pure enough to test in isolation with `node:test` alone.
- The complete meta-field assertion pins the cost-observability contract; if any field is dropped from `summarizeCluster`'s return shape, the test fails immediately.

#### Consequences

- `cd 05-engineering && npm run test:api` now runs 18 tests (7 model-router + 6 settings-schema + 5 route-level). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- The `withTimeout` deadline-exceeded test is the authoritative regression guard for the timeout guardrail; changing the timeout message or the error shape will fail it.
- Slice 9 is closed; AI architecture MVP (mock providers + capability routing + guardrailed summarization + cost metadata) is ready for Slice 10 (AI router hardening).

### 2026-04-23 - D-025 - Slice 8 audit pass: ingestion + ranking endpoint verified, dashboard route test added

#### Context

Audit pass of Slice 8 (branch `audit/claude-rebuild-slice8`). In-scope files reviewed: `apps/api/data/source-items.json`, `apps/api/src/server.mjs`, `04-prototype/src/lib/api.ts`, `04-prototype/vite.config.ts`. Objective: implement a local ingestion and ranking path for Dashboard payload generation, replacing static dashboard JSON reads.

#### Decision

- No functional code changes required. All Slice 8 functional requirements were already present and correct.
- Added one route-level test for `GET /api/dashboard` to `[apps/api/src/server.routes.test.mjs](apps/api/src/server.routes.test.mjs)`, per the D-017 pattern ("Any future route addition should include a corresponding entry in `server.routes.test.mjs`").
- Test seeds a minimal `source-items.json` fixture to the isolated `tmpDir` before server import; verifies HTTP 200, `contractVersion`, stories array length, `dashboardPayloadSchema` conformance, and `aiSummaryMeta` stripping (D-016).

#### Why

- D-017 established that route additions require route-level HTTP tests. The dashboard endpoint was added in Slice 8 but lacked HTTP-level verification. The functional implementation was correct; only the test gap needed closing.
- Without the test, a regression in dataset loading, filtering, clustering, or response-stripping logic would be invisible to the API test suite.

#### Consequences

- `cd 05-engineering/apps/api && npm test` now runs 14 tests (3 model-router + 6 settings-schema + 5 route-level). All pass.
- `npm run build` exits 0. `npm run test:prototype` exits 0 (9 tests). `npx eslint src/lib/api.ts vite.config.ts` exits 0. `node --check server.mjs` exits 0.
- Slice 8 is closed; ingestion v0 + ranking endpoint is ready for Slice 9 (AI architecture summary).

### 2026-04-23 - D-024 - Slice 7 audit pass: auth baseline + guarded routes verified, no code changes required

#### Context

Audit pass of Slice 7 (branch `audit/claude-rebuild-slice7`). In-scope files reviewed: `04-prototype/src/lib/auth.tsx`, `04-prototype/src/components/ProtectedRoute.tsx`, `04-prototype/src/App.tsx`, `04-prototype/src/pages/Onboarding.tsx`, `04-prototype/src/components/AppHeader.tsx`. Objective: implement a minimal auth baseline that protects private routes while preserving the existing onboarding and app UI flow.

#### Decision

- No code changes required. All Slice 7 functional requirements were already present and correct.
- `AuthProvider` uses localStorage-backed session (`tempo.auth.session.v1`) with stable `useMemo` value to avoid unnecessary re-renders.
- `ProtectedRoute` redirects unauthenticated users to `/onboarding` with `state={{ from: location.pathname }}` preserved for future post-login redirect use.
- All private routes (`/dashboard`, `/settings`, `/archive`, `/archive/signal-radar`, `/archive/evidence-desk`, `/archive/analyst-briefing`) are wrapped in `ProtectedRoute`.
- `Onboarding` calls `login()` on valid submit and navigates to `/dashboard`; redirects authenticated users immediately with `<Navigate>`.
- `AppHeader` hides for `/`, `/onboarding`, and any unauthenticated state; shows logout button for authenticated sessions.
- All 9 prototype tests pass. `npm run build` exits 0. ESLint exits with warnings only (1 pre-existing `react-refresh/only-export-components` in `auth.tsx` — acceptable, documented in slice artifact).

#### Why

- The audit obligation is to verify correctness against the slice objective. Confirming a passing gate with no regressions is a valid and complete audit outcome.

#### Consequences

- `npm run build` exits 0.
- `cd 05-engineering && npm run test:prototype` exits 0 (9 tests: 6 api adapter + 2 settings-api + 1 example).
- `npx eslint src/App.tsx src/pages/Onboarding.tsx src/components/AppHeader.tsx src/components/ProtectedRoute.tsx src/lib/auth.tsx` exits with warnings only.
- Slice 7 is closed; auth baseline is ready for Slice 8 (ingestion pipeline v0 + ranking endpoint).

### 2026-04-23 - D-023 - Slice 6 audit pass: HTTP + local DB settings flow verified, no code changes required

#### Context

Audit pass of Slice 6 (branch `audit/claude-rebuild-slice6`). In-scope files reviewed: `apps/api/src/server.mjs`, `apps/api/data/settings.json`, `apps/api/package.json`, `05-engineering/package.json`, `04-prototype/vite.config.ts`, `04-prototype/src/lib/settings-api.ts`, `04-prototype/src/lib/settings-api.test.ts`. Objective: replace Settings adapter internals from browser-only localStorage to HTTP-first GET/PUT with localStorage fallback, backed by a local JSON file via the `@tempo/api` Express service.

#### Decision

- No code changes required. All Slice 6 functional requirements were already present and correct.
- All 13 `@tempo/api` tests pass (3 model-router, 4 route tests via supertest, 6 schema unit tests).
- All 9 prototype tests pass (2 settings-api + 6 api adapter + 1 example).
- ESLint on all four in-scope prototype files exits 0.
- `npm run build` exits 0.

#### Why

- `server.mjs` correctly exports `app`, guards `listen` behind direct-run check, and overrides `DATA_DIR` via `TEMPO_DATA_DIR` for test isolation.
- `settings-api.ts` implements HTTP-first with localStorage write-through on success and graceful fallback (mock latency + localStorage or default seed) on any fetch error.
- `vite.config.ts` proxies `/api/settings` and `/api/dashboard` to `http://localhost:8787`.
- `server.routes.test.mjs` exercises the full HTTP route surface (health, invalid→400, valid→200+schema, GET-after-PUT) using supertest with an isolated temp data dir.

#### Consequences

- `npm run build` exits 0.
- `cd 05-engineering/apps/api && npm test` exits 0 (13 tests).
- `cd 05-engineering && npm run test:prototype` exits 0 (9 tests).
- `npx eslint src/lib/settings-api.ts src/lib/settings-api.test.ts src/pages/Settings.tsx vite.config.ts` exits 0.
- Slice 6 is closed; the Settings HTTP/local-DB boundary is ready for Slice 7 (auth baseline + guarded routes).

### 2026-04-23 - D-022 - Slice 5 audit pass: settings persistence verified, one comment correction

#### Context

Audit pass of Slice 5 (branch `audit/claude-rebuild-slice5`). The three in-scope files — `src/lib/settings-api.ts`, `src/lib/settings-api.test.ts`, and `src/pages/Settings.tsx` — were reviewed against the Slice 5 objective (typed, persistent Settings read/write path). All functional requirements were already present: `settingsPayloadSchema` contract validation on both read and write paths, localStorage persistence with graceful fallback to defaults on empty or corrupt state, Settings page `useEffect` load-on-mount with cancellation guard, and `loading`/`saving` UI states. One minor documentation error was found: the JSDoc on `fetchSettingsPayload` referenced "Slice 4 adapter" instead of "Slice 5 adapter".

#### Decision

- Fix JSDoc comment in `settings-api.ts`: "Slice 4 adapter" → "Slice 5 adapter".
- No functional code changes required.

#### Why

- The incorrect slice reference in the comment would mislead future readers about when this module was introduced.
- All validation gates (build, test, lint) passed before and after the fix without any functional change.

#### Consequences

- `npm run build` exits 0.
- `npm run test:prototype` exits 0 (9 tests pass: 6 api adapter + 2 settings-api + 1 example).
- ESLint on the three in-scope files exits 0.
- Slice 5 is closed; the settings persistence boundary is ready for Slice 6 (HTTP/local DB swap).

### 2026-04-23 - D-021 - Slice 4 audit pass: lint baseline verified, no code changes required

#### Context

Audit pass of Slice 4 (branch `audit/claude-rebuild-slice4`). The four in-scope files — `src/components/ui/command.tsx`, `src/components/ui/textarea.tsx`, `src/pages/archive/EvidenceDesk.tsx`, and `tailwind.config.ts` — were reviewed against the Slice 4 objective (clear error-level ESLint failures). All fixes described in the original implementation summary were already present: `CommandDialogProps` and `TextareaProps` use type aliases (not empty interfaces), `Select` is a generic over `T extends string` eliminating `any` casts, and `tailwind.config.ts` uses an ESM `import` instead of `require()`.

#### Decision

- No code changes. Implementation matched the objective exactly.
- Run all required validation commands to confirm gate state before closing the slice.

#### Why

- The audit obligation is to verify correctness, not to add changes. Confirming a passing gate is a valid and complete audit outcome.

#### Consequences

- Targeted ESLint on the four slice files exits 0.
- `npm run lint` exits 0 with 8 warnings (Fast Refresh export warnings in unrelated scaffold files, pre-existing and out of scope).
- `npm run build` and `npm run test:prototype` both exit 0 (9 tests pass).
- Slice 4 is closed; lint can be relied on as a reliable error gate for future slices.

### 2026-04-23 - D-020 - Slice 3 rebuild pass: backoff duration assertions + zero-retry boundary test

#### Context

Audit pass of Slice 3 (branch `audit/claude-rebuild-slice3`). The `api.ts` implementation was already correct — HTTP fetch to `/api/dashboard`, `dashboardPayloadSchema` contract validation, AbortError-first guard in the catch block (corrected in D-019), and linear backoff with local fallback were all in place. Two narrow test gaps remained: (1) the retry test asserted `sleep` was called twice but did not assert the actual backoff duration arguments (200ms, 400ms), leaving the schedule itself unverified by the test suite; (2) there was no test for the `retries: 0` boundary — the path where the adapter falls back immediately on the first failure with no sleep call.

#### Decision

- Add `expect(sleep).toHaveBeenNthCalledWith(1, 200)` and `expect(sleep).toHaveBeenNthCalledWith(2, 400)` to the existing "retries and then falls back" test, making the linear backoff schedule an explicit assertion.
- Add a new `retries: 0` test: fetcher called once, sleep not called, payload returns with correct `contractVersion` and `stories.length`. This pins the loop's boundary termination behavior.
- No changes to `api.ts` — implementation was already correct.

#### Why

- Unasserted sleep arguments mean the test only verifies retry count, not the backoff amounts. A regression that doubled all delays (400ms, 800ms) would pass the prior test without detection.
- The zero-retry path is the worst-case first-failure scenario (one attempt, immediate fallback, no delay); verifying it confirms the loop boundary condition at `retries: 0`.

#### Consequences

- `test:prototype` now runs 9 tests (6 api adapter + 2 settings-api + 1 example). All pass.
- Backoff schedule (200ms, 400ms linear) is an explicit assertion; any change to `RETRY_BACKOFF_MS` or the multiplier formula will fail the test.
- ESLint on `api.ts`, `api.test.ts`, `Dashboard.tsx` exits 0.

### 2026-04-23 - D-019 - Slice 2 rebuild pass: AbortError ordering + cast removal + test coverage

#### Context

Audit pass of Slice 2 (branch `audit/claude-rebuild-s1-s10`) found three narrow gaps. (1) The `AbortError` guard in `fetchDashboardPayload` was placed after `await sleep()` and after the final-attempt fallback `return`, making it dead code on the last attempt and causing unnecessary backoff on earlier abort attempts. (2) Three `as` type casts in `dtoToStory` (for `Geography[]`, `Topic`, `SourceKind`) suppressed TypeScript checking at the DTO→UI boundary even though the contract types and local types are structurally identical. (3) `api.test.ts` had no coverage for non-2xx HTTP responses, contract validation failure, or AbortError propagation — the three most important failure modes of the adapter.

#### Decision

- Move `AbortError` guard to the first check in the `catch` block, before the sleep and before the final-attempt fallback. This ensures aborts propagate immediately with no retry delay on any attempt.
- Remove the three `as` casts in `dtoToStory` in `Dashboard.tsx`. `GeographyDto`, `TopicDto`, and `SourceKindDto` from `@tempo/contracts` are structurally identical string-literal unions to their counterparts in `stories.ts`; TypeScript verifies the boundary without a cast.
- Add three adapter tests to `api.test.ts`: (a) non-2xx HTTP → retries then falls back, (b) contract parse failure → retries then falls back, (c) AbortError → rethrows immediately, fetcher called once, sleep never called.
- Remove the stale "Slice 3 adapter" JSDoc comment that incorrectly attributed HTTP fetch behavior to Slice 3 only.

#### Why

- The inverted `AbortError` check was a silent correctness bug: any abort that hit the retry limit would be swallowed and return stale fallback data instead of surfacing the abort signal to the caller.
- Unchecked `as` casts hide future type drift; if either `stories.ts` or `@tempo/contracts` ever diverges, the compiler would not flag `dtoToStory` as broken.
- The three missing test scenarios cover the adapter's most important non-happy-path behaviors; without them a regression in any of those paths would be invisible to CI.

#### Consequences

- `test:prototype` now runs 8 tests (was 5): 5 adapter tests + 2 settings-api tests + 1 example.
- `build`, `test:prototype`, and `lint:prototype:slice` all pass (exit 0).
- AbortError now propagates to the caller on every attempt, not just non-final ones; callers may handle it if needed (current Dashboard `useEffect` cleanup does not explicitly catch AbortError, which is acceptable since the component unmounts the effect on cancel).

### 2026-04-22 - D-018 - Slice 1 rebuild pass 2: url constraint + StoryPriorityDto + test coverage gaps

#### Context

Second audit pass of Slice 1 (branch `audit/claude-rebuild-s1-s10`, after D-015). Found four narrow gaps not caught in the first pass: `sourceSchema.url` accepted empty string; `StoryPriorityDto` type was the only enum without a DTO alias; `buildSourceOpenError` had no dedicated describe block; contracts rejection tests covered only `storySchema`, leaving `dashboardPayloadSchema` and `settingsPayloadSchema` untested for invalid input.

#### Decision

- Add `.min(1)` to `sourceSchema.url` — empty string is not a valid source URL.
- Add `StoryPriorityDto = z.infer<typeof storyPrioritySchema>` and re-export from `index.ts` — consistent with all other enum type aliases.
- Add `describe("buildSourceOpenError")` with happy-path and empty-message rejection tests — brings all four event builders to parity.
- Add rejection tests for `dashboardPayloadSchema` (wrong version) and `settingsPayloadSchema` (missing required field), and an explicit `sourceSchema` describe block (empty url rejection).
- Refactor test fixtures to shared `minimalSource` / `minimalStory` constants to eliminate repetition.

#### Why

- An empty `url` on a source would silently pass contract validation and produce a broken link in the UI. The `.min(1)` guard catches it at the API boundary.
- Missing DTO type alias is an API inconsistency; any consumer needing to type a priority variable would reach for the raw enum string instead of the canonical alias.
- Uncovered event builder paths reduce confidence that builders enforce their own invariants; adding the describe block closes the gap.

#### Consequences

- `test:packages` now runs 8 contracts tests + 11 analytics tests (was 4 + 9).
- `build:packages`, `build`, and `lint:prototype:slice` all still pass (exit 0).
- `StoryPriorityDto` is now a public export of `@tempo/contracts`; consumers can import the type directly.

### 2026-04-22 - D-017 - Follow-up: route-level test coverage for PUT /api/settings

#### Context

D-016 added `settingsPayloadSchema.safeParse()` to `PUT /api/settings` and accompanying schema-only unit tests. A follow-up review (Codex) identified that those tests validate the Zod schema directly but do not exercise actual HTTP route behavior — a handler bug, wrong status code, or missing `express.json()` middleware would go undetected.

#### Decision

- Refactor `[apps/api/src/server.mjs](apps/api/src/server.mjs)` for testability:
  - `DATA_DIR` is now overridable via `TEMPO_DATA_DIR` env var so tests can target an isolated temp directory.
  - `app` is exported; `app.listen()` is guarded behind a direct-run check (`process.argv[1] === __filename`) so importing the module in tests does not start a real server.
- Add `supertest` as a dev dependency to `[apps/api/package.json](apps/api/package.json)`.
- Add `[apps/api/src/server.routes.test.mjs](apps/api/src/server.routes.test.mjs)` with four route-level tests:
  1. `GET /health` sanity check.
  2. `PUT /api/settings` with invalid payload → HTTP 400 + `{message, errors}` shape.
  3. `PUT /api/settings` with valid payload → HTTP 200, response validates against `settingsPayloadSchema`.
  4. `GET /api/settings` after valid PUT → persisted data returned.
- Each test run writes to a fresh `mkdtemp` directory and deletes it in an `after()` hook; no shared state with the production `data/` directory.

#### Why

- Schema-only tests prove the Zod schema works, not that the route wires it correctly.
- Route-level tests catch handler bugs, wrong status codes, and middleware gaps that schema tests miss.
- `TEMPO_DATA_DIR` override is the minimal seam needed; no interface changes, no mocking.

#### Consequences

- `test:api` now runs 13 tests (3 model-router + 6 settings-schema + 4 route-level).
- `server.mjs` runtime behavior for `npm run dev` / `npm start` is unchanged.
- Any future route addition should include a corresponding entry in `server.routes.test.mjs`.

### 2026-04-22 - D-016 - Codex reviewer fix pass: settings validation, contract drift, unsafe cast

#### Context

Codex review of branch `audit/claude-rebuild-s1-s10` found four issues: unvalidated settings writes (HIGH), `aiSummaryMeta` returned in API payload but absent from dashboard contract (MEDIUM), unsafe `as Story[]` cast in Dashboard (MEDIUM), and localStorage auth with no documented risk (LOW).

#### Decision

- **Settings validation (HIGH):** Add `settingsPayloadSchema.safeParse(req.body)` guard to `PUT /api/settings` in `[apps/api/src/server.mjs](apps/api/src/server.mjs)`. Return HTTP 400 with Zod error detail on invalid payload; only call `writeSettings` on validated data. Add `@tempo/contracts` as a workspace dependency to `@tempo/api` so the server can use the canonical schema without duplicating it.
- **Contract drift (MEDIUM):** Choose Option B — strip `aiSummaryMeta` from stories before sending the dashboard HTTP response. The field is internal AI telemetry used for cost logging; it does not belong in the public contract. API response now conforms exactly to `dashboardPayloadSchema`. No schema change required.
- **Unsafe cast (MEDIUM):** Replace `payload.stories as Story[]` with an explicit `dtoToStory(dto: StoryDto): Story` mapper in `[04-prototype/src/pages/Dashboard.tsx](../04-prototype/src/pages/Dashboard.tsx)`. The mapper does a full property-by-property construction, making the DTO→UI type boundary explicit and type-safe.
- **Auth risk (LOW, documented here):** The current auth baseline (D-011) uses `sessionStorage` on the client with no server-side session validation. Any user can access guarded routes by writing a valid session key. This is acceptable for the current prototype stage but must be replaced before any production or shared-access deployment. Next auth slice should introduce server-side session tokens or an identity provider.

#### Why

- Unvalidated writes allow arbitrary JSON to overwrite the settings file, breaking all downstream filtering without any error signal.
- Returning undocumented fields in the API payload creates silent client-side schema divergence that is hard to diagnose.
- The `as Story[]` cast masked a real type boundary; the explicit mapper surfaces it.
- Auth risk documentation prevents the "good enough for now" pattern from going unnoticed at handoff.

#### Consequences

- `PUT /api/settings` now returns 400 on invalid payload; callers must send a conformant `SettingsPayload`.
- `GET /api/dashboard` response stories no longer include `aiSummaryMeta`; cost telemetry is server-side only.
- `dtoToStory` is the single mapping point between the contracts DTO and the prototype UI type; update it if either type changes.
- `test:api` now runs 9 tests (3 model-router + 6 settings-validation).
- Auth risk is documented; current localStorage/sessionStorage pattern is baseline-only and must not be carried to production.

### 2026-04-22 - D-015 - Slice 1 audit rebuild: emit signature + test coverage + lint script

#### Context

- Slice 1 review (branch `audit/claude-rebuild-s1-s10`) identified three issues: `emitAnalyticsEvent` double-validated events already built by typed builders (unnecessary overhead, looser types); `buildStoryExpanded` / `buildSourceOpened` / `setAnalyticsSink` had no test coverage; `lint:prototype:slice` npm script was broken (ESLint ran in wrong CWD, always exited 2).

#### Decision

- Change `emitAnalyticsEvent` signature from `(raw: unknown)` to `(event: AnalyticsEvent)` and remove the internal `analyticsEventSchema.parse()` re-parse. Callers needing to validate untrusted input must call `analyticsEventSchema.parse()` explicitly before emit.
- Expand `packages/analytics/src/events.test.ts` from 3 → 9 tests: add coverage for `buildStoryExpanded`, `buildSourceOpened`, invalid-input rejections, and `setAnalyticsSink` custom-sink routing + null-restore.
- Add one negative rejection test to `packages/contracts/src/schemas.test.ts` (missing required fields).
- Fix `lint:prototype:slice` script: replace broken `npm --prefix exec` form with `sh -c 'cd ../04-prototype && npx eslint …'`.

#### Why

- Double-validation was silent overhead on every user action; removing it makes the type boundary explicit (builders own validation, emit owns dispatch).
- Uncovered code paths reduce confidence in the analytics tier model; every event builder and the sink switch now have a test.
- A broken lint gate is as bad as no lint gate — the script now actually verifies the slice files.

#### Consequences

- `emitAnalyticsEvent` is now a typed dispatch function, not a parse-and-dispatch function. Any caller using it with a raw `unknown` payload must add an explicit `analyticsEventSchema.parse()` step.
- `test:packages` now runs 9 analytics tests + 4 contracts tests (was 3 + 3).
- `lint:prototype:slice` exits 0 cleanly.

### 2026-04-22 - D-014 - AI router hardening: prompt versioning + telemetry

#### Context

- AI summarization architecture existed with mock providers and fallback, but lacked explicit prompt version controls and aggregated failure telemetry.

#### Decision

- Add prompt builder/version module `[apps/api/src/ai/prompts.mjs](apps/api/src/ai/prompts.mjs)` with `summary-v1`.
- Add OpenAI-compatible provider path `[apps/api/src/ai/providers/openai-compatible.mjs](apps/api/src/ai/providers/openai-compatible.mjs)` enabled when `TEMPO_OPENAI_API_KEY` is present and summarization model is `openai:<model>`.
- Extend router `[apps/api/src/ai/model-router.mjs](apps/api/src/ai/model-router.mjs)` with in-memory metrics:
  - `summarizationRequests`
  - `summarizationFallbacks`
  - `summarizationTimeouts`
  - `providerErrors`
- Expose telemetry endpoint `GET /api/ai/metrics`.

#### Why

- Preserves pluggability while adding operator visibility and safer rollout controls.
- Enables versioned prompt iteration without implicit behavior drift.

#### Consequences

- API now reports capability map and runtime AI metrics separately.
- Next step can add persistent telemetry sink and production provider credentials flow.

### 2026-04-22 - D-013 - AI capability map + guardrailed summarization

#### Context

- Ingestion/ranking endpoint existed but summary generation remained static text.
- MVP required early AI model architecture with capability mapping and reliability/cost guardrails.

#### Decision

- Add capability-to-model router in `[apps/api/src/ai/model-router.mjs](apps/api/src/ai/model-router.mjs)`:
  - summarization -> `mock-openai-mini`
  - classification -> `mock-anthropic-haiku`
  - safety -> `mock-openai-mini`
- Add mock provider implementations and guardrails:
  - timeout wrapper
  - heuristic fallback summary
  - per-request cost estimate metadata
- Enrich `GET /api/dashboard` to run AI summarization per ranked cluster and expose model map via `GET /api/ai/models`.

#### Why

- Establishes pluggable model architecture now, before vendor/API lock-in.
- Adds baseline reliability and cost observability for AI features in MVP flow.

#### Consequences

- Dashboard summaries are now generated by the AI router layer (with fallback).
- Next roadmap step can focus on production provider wiring and additional AI capabilities.

### 2026-04-22 - D-012 - Ingestion v0 + ranking endpoint for dashboard

#### Context

- Roadmap required a first ingestion/ranking slice after auth baseline.
- Dashboard adapter already supported HTTP with retry/backoff but used static payload files.

#### Decision

- Add source-item ingestion input at `[apps/api/data/source-items.json](apps/api/data/source-items.json)`.
- Add `GET /api/dashboard` in `[apps/api/src/server.mjs](apps/api/src/server.mjs)`:
  - filters source items by settings scope
  - clusters by `clusterId`
  - computes ranked stories (weight+freshness heuristic)
  - returns contract-shaped dashboard payload
- Update frontend adapter endpoint to `/api/dashboard` and add Vite proxy route.

#### Why

- Creates an end-to-end v0 ingestion path with ranking behavior and contract output.
- Keeps implementation local and reversible while progressing roadmap sequence.

#### Consequences

- Dashboard payload now comes from ingestion+ranking logic rather than static dashboard JSON.
- Next roadmap slice remains AI summarization guardrailed path.

### 2026-04-22 - D-011 - Auth baseline with guarded routes

#### Context

- Roadmap next slice after settings HTTP/local DB was auth baseline + guarded routes.
- App previously allowed direct access to dashboard/settings/archive routes without session checks.

#### Decision

- Add client auth baseline in `[04-prototype/src/lib/auth.tsx](../04-prototype/src/lib/auth.tsx)` using local session storage.
- Add route guard component `[04-prototype/src/components/ProtectedRoute.tsx](../04-prototype/src/components/ProtectedRoute.tsx)`.
- Wrap private routes (`/dashboard`, `/settings`, `/archive/*`) in `ProtectedRoute`.
- Update onboarding to establish session on submit and redirect authenticated users to `/dashboard`.
- Add header logout action and hide app chrome when unauthenticated.

#### Why

- Establishes the minimal auth contract needed before deeper backend/user identity work.
- Protects private surfaces while keeping the implementation bounded and reversible.

#### Consequences

- Unauthenticated users are redirected to onboarding for private routes.
- Auth state remains local/session-like for now; next steps can replace internals with server-backed auth.

### 2026-04-22 - D-010 - Settings adapter switched to HTTP local DB

#### Context

- Settings were persisted only in browser `localStorage`, which limited continuity and API realism.
- The roadmap required moving toward production-style boundaries without full backend rollout.

#### Decision

- Add local API service `[05-engineering/apps/api](apps/api)` with `GET/PUT /api/settings` backed by a local JSON DB file.
- Update `[04-prototype/src/lib/settings-api.ts](../04-prototype/src/lib/settings-api.ts)` to use HTTP as the primary read/write path.
- Keep `localStorage` as resilience fallback (offline or API failure) to preserve current UX.
- Update dev orchestration so `cd 05-engineering && npm run dev` runs both API and web.

#### Why

- Introduces production-like transport and persistence boundaries now, while keeping slice scope small.
- Preserves user-facing behavior and adds safer fallback semantics.

#### Consequences

- Settings now persist through a local HTTP API + DB file by default.
- Original roadmap is now back on track; next planned slice is **Auth baseline + guarded routes**.

### 2026-04-22 - D-009 - Settings persistence via typed storage adapter

#### Context

- Dashboard already moved behind typed read adapters.
- Settings still used in-memory defaults per render without persistence boundary.

#### Decision

- Add `fetchSettingsPayload()` and `saveSettingsPayload()` in `[04-prototype/src/lib/settings-api.ts](../04-prototype/src/lib/settings-api.ts)`.
- Validate payloads with `settingsPayloadSchema` and `CONTRACT_VERSION`.
- Persist settings to `localStorage` under `tempo.settings.v1` with safe fallback to defaults.
- Wire `[04-prototype/src/pages/Settings.tsx](../04-prototype/src/pages/Settings.tsx)` to load on mount and save through the adapter.

#### Why

- Establishes a swap-ready API boundary while preserving existing Settings UX.
- Gives users durable settings behavior now, without backend dependency.

#### Consequences

- Settings survive page reloads.
- Next slice can replace localStorage internals with HTTP/local DB while reusing page-level logic.

### 2026-04-22 - D-008 - Lint baseline cleanup (error-level)

#### Context

- Full prototype lint failed with 5 error-level issues carried from generated scaffold files.
- These failures created noise and reduced confidence in slice-level lint gates.

#### Decision

- Fix only error-level lint violations in:
  - `[src/components/ui/command.tsx](../04-prototype/src/components/ui/command.tsx)`
  - `[src/components/ui/textarea.tsx](../04-prototype/src/components/ui/textarea.tsx)`
  - `[src/pages/archive/EvidenceDesk.tsx](../04-prototype/src/pages/archive/EvidenceDesk.tsx)`
  - `[tailwind.config.ts](../04-prototype/tailwind.config.ts)`
- Leave existing `react-refresh/only-export-components` warnings unchanged for a future optional cleanup.

#### Why

- Restores a clean error baseline without broad UI refactors.
- Keeps this quality slice small and reversible while unblocking future strict lint checks.

#### Consequences

- `npm run lint` now exits successfully (warnings only).
- Future slices can treat lint failures as new regressions rather than inherited debt.

### 2026-04-22 - D-007 - Slice 3 HTTP adapter with retry/backoff

#### Context

- Slice 2 introduced a typed dashboard adapter but still sourced data directly from in-memory constants.
- Next step required a real HTTP-style read path and retry policy without introducing backend infrastructure yet.

#### Decision

- Update `[04-prototype/src/lib/api.ts](../04-prototype/src/lib/api.ts)` to fetch from `[04-prototype/public/api/dashboard.json](../04-prototype/public/api/dashboard.json)`.
- Validate the fetched payload against `dashboardPayloadSchema`.
- Add bounded retry/backoff (2 retries, linear 200ms step) and fallback to local in-memory payload when retries are exhausted.
- Add adapter tests for HTTP success and retry/fallback behavior.

#### Why

- Keeps the slice narrow while moving the dashboard to a production-like network boundary.
- Improves resilience and observability before introducing a full backend service.

#### Consequences

- Dashboard can now run against static API-like payloads and later swap to a real endpoint with minimal UI changes.
- Temporary static payload currently includes two stories; fallback path still retains full local dataset.

### 2026-04-22 - D-006 - Slice 2 dashboard read path via typed API adapter

#### Context

- Slice 1 established shared contracts and analytics package boundaries.
- Dashboard still read directly from `STORIES` without a typed data-access boundary.

#### Decision

- Add `fetchDashboardPayload()` in `[04-prototype/src/lib/api.ts](../04-prototype/src/lib/api.ts)` as the dashboard read adapter.
- Validate payloads at runtime using `@tempo/contracts` (`dashboardPayloadSchema` + `CONTRACT_VERSION`).
- Keep dashboard UI and interaction behavior unchanged; show subtle loading and fallback copy during refresh.
- Emit guardrail analytics on fetch failure via `trackSourceOpenError`.

#### Why

- Creates a stable seam for a future real API without coupling UI components to transport details.
- Keeps this slice bounded to one flow (Dashboard read path) while improving correctness and observability.

#### Consequences

- Dashboard state now hydrates from the adapter, not only module-local constants.
- Next slice can swap adapter internals from in-memory mock to HTTP without redesigning the screen.

### 2026-04-22 - D-005 - Engineering decisions log location

#### Context

- Root `DECISIONS.md` previously held only engineering entries, while research decisions live under `[01-research/ops](../01-research/ops)`.

#### Decision

- Canonical engineering log is this file: `[DECISIONS.md](DECISIONS.md)`.
- Remove root-level `DECISIONS.md` to avoid duplicate navigation points.

#### Why

- Matches the split between research Markdown and engineering execution.

#### Consequences

- Log new engineering decisions here; prepend new blocks at the top.
- Any historical references to root `DECISIONS.md` are superseded by this location.

### 2026-04-22 - D-004 - Engineering npm workspace under `05-engineering/`

#### Context

- Slice 1 added `package.json`, `apps/web`, and `packages/`* at the repository root, which mixed engineering tooling with the top-level repo layout.

#### Decision

- Move the Node workspace (`package.json`, `package-lock.json`, `apps/`, `packages/`) into this folder (`[package.json](package.json)`).
- Keep `[04-prototype](../04-prototype)` as the UI package; link `@tempo/`* with `file:../05-engineering/packages/...`.
- Run install/dev/build scripts from here (see `[README.md](README.md)`).

#### Why

- Matches the information hierarchy: all engineering-specific tooling and shared packages live next to other engineering artifacts.
- Prototype folder stays a clean Lovable reference without owning the monorepo root.

#### Consequences

- No `package.json` at repo root; onboarding starts at `[README.md](../README.md)` → `cd 05-engineering && npm install`.
- Historical docs that said “repo root” for npm mean `05-engineering/` from D-004 onward.

### 2026-04-22 - D-003 - Mode 2 slice 1: monorepo + contracts + analytics

#### Context

- Mode 1 kickoff approved; first vertical slice is platform skeleton, typed contracts, and analytics event schema without backend/auth/DB.

#### Decision

- ~~Add root `package.json` npm workspaces linking `04-prototype`, `apps/web`, `packages/contracts`, and `packages/analytics`.~~ **Update (D-004):** workspace lives under `[package.json](package.json)` (no `04-prototype` workspace member; prototype installs separately).
- Use `@tempo/contracts` (Zod + versioned dashboard/settings payloads) and `@tempo/analytics` (primary/secondary/guardrail events + validated emit).
- Keep the Lovable UI in `[04-prototype](../04-prototype)`; `[apps/web](apps/web)` is a typed placeholder until migration.
- Link `@tempo/`* from the prototype with `file:../05-engineering/packages/...` (avoids `workspace:`* on older npm).

#### Why

- Establishes shared contracts and analytics before API and ingestion work.
- Preserves the dashboard UX while wiring real event validation and a replaceable sink.

#### Consequences

- ~~From repo root: `npm run build:packages` before `npm run dev` (root script runs both).~~ **Update (D-004):** run those scripts from `[05-engineering/README.md](README.md)`.
- Full-repo `npm run lint` in the prototype still reports pre-existing UI issues; slice hygiene uses targeted lint on changed files until a follow-up cleanup slice.

### 2026-04-22 - D-002 - Separate Prototype and Engineering Artifacts

#### Context

- `[04-prototype](../04-prototype)` contains the Lovable-built reference implementation and related prototype assets.
- Mode 1 kickoff output is an engineering execution artifact used to run rebuild slices and quality gates.

#### Decision

- Keep prototype assets in `[04-prototype](../04-prototype)` only.
- Store engineering execution artifacts here, starting with `[MODE1-KICKOFF.md](MODE1-KICKOFF.md)`.

#### Why

- Preserves a clean boundary between reference prototype work and implementation execution work.
- Reduces accidental coupling or edits to prototype-origin files during engineering phases.
- Makes execution history easier to navigate as more artifacts are added.

#### Consequences

- Future mode outputs, slice briefs, gate checklists, and engineering runbooks go under `05-engineering`.
- `[04-prototype](../04-prototype)` remains the frozen reference baseline unless explicitly updated as prototype work.

### 2026-04-22 - D-001 - Use Skill A as Orchestrator

#### Context

- The current implementation target is the Lovable prototype in `[04-prototype](../04-prototype)`.
- Execution model is locked: `engineer-intake-rebuild` in Mode 1 first, then Mode 2 only after explicit approval.

#### Decision

- Adopt `engineer-intake-rebuild` as the project orchestrator for all execution phases.
- Keep this run in Mode 1 and produce a bounded first-slice recommendation before any build work.

#### Why

- The prototype is UI-heavy and production architecture is not yet present (backend/auth/persistence/CI gates).
- Mode 1 reduces architecture and delivery risk before coding.
- The specialist skill routing is already defined and can be applied per slice.

#### Consequences

- No broad rewrites or multi-slice implementation starts until the first Mode 2 slice is approved.
- Every major tradeoff or scope shift is recorded here before execution.