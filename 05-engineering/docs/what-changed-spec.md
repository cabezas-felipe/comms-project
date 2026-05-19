# What changed — engineer spec (v1, implemented)

**Status:** **Implemented (v1).** Shipped across five commits on branch `feat/what-changed-delta-engine`:

| Commit | Phase | What landed |
|--------|-------|-------------|
| `3a9803f` | 0 — spec | This document. |
| `70b4734` | 1 — persistence | `_everSeenMetaStoryIds` on snapshot blob + pipeline pass-through. |
| `7230b5b` | 2 — gate | Deterministic `compareStructuralGate` + `resolveWhatChangedDeterministic`. |
| `3c90cef` | 3 — LLM | Haiku classify + Sonnet write + async `resolveWhatChanged` + env config. |
| `0f75206` | 4 — wiring | Engine integrated into `runRefreshPipeline`; freshness template retired; `log.whatChanged` → `_meta.whatChanged`. |

**Default off:** `TEMPO_AI_DELTA_ENABLED=false` keeps LLM stages dormant. Until an operator opts in, the pipeline emits only deterministic `first-seen` / `unchanged` copy.

**Implementation map:**

| Concern | Module |
|---------|--------|
| Static copy strings | [`WHAT_CHANGED_COPY`](../apps/api/src/dashboard/what-changed-engine.mjs) |
| Structural gate | [`compareStructuralGate`](../apps/api/src/dashboard/what-changed-engine.mjs) |
| LLM stages + async resolver | [`classifyDeltaMaterial`, `writeDeltaProse`, `resolveWhatChanged`](../apps/api/src/dashboard/what-changed-engine.mjs) |
| Env config | [`resolveDeltaConfig`, `isDeltaLlmEnabled`](../apps/api/src/dashboard/what-changed-engine.mjs) |
| Run-level diagnostics | [`aggregateWhatChangedDiagnostics`, `WHAT_CHANGED_DIAGNOSTICS_SCHEMA_VERSION`](../apps/api/src/dashboard/what-changed-engine.mjs) |
| Pipeline call site | [`runRefreshPipeline` → "Phase 4: compute whatChanged per story"](../apps/api/src/dashboard/refresh-pipeline.mjs) |
| Ever-seen merge / strip | [`mergeEverSeenMetaStoryIds`, `extractEverSeenFromSnapshot`, `liftSnapshotMeta`](../apps/api/src/db/dashboard-snapshot-repo.mjs) |
| Route plumbing + persistence | [`executeRefreshFlow`, `stripPersistedFields`](../apps/api/src/server.mjs) |
| Handoff doc | [`what-changed-handoff.md`](what-changed-handoff.md) |

**Posture:** False-positive–first. Prefer **unchanged** copy over inventing a delta. The dashboard is a trust surface; a wrong "Updated:" line is worse than a quiet "no material update".

**Scope:** Replaces the [`whatChanged` field](../packages/contracts/src/schemas.ts) value computed in [`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs). API field name, schema, and frontend contract are **unchanged** — only the *value generation* changes. The frontend ([`StoryCard.tsx`](../../04-prototype/src/components/StoryCard.tsx)) keeps reading `story.whatChanged` as a plain string.

**Out of scope (MVP):**

- New Postgres tables for narrative history (the persisted snapshot blob is enough — see [Persistence](#4-persistence)).
- Embedding-based material gates (deferred — see [Open questions](#11-open-questions)).
- "User viewed" vs "refresh ran" semantics. MVP copy intentionally says "your last refresh".
- Frontend changes. The wire shape is identical; only the string content shifts.

---

## 1. Purpose & posture

The current `whatChanged` value (`Latest update ${freshestMinutesAgo} min ago.`, set inline in [`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs)) is a freshness restatement, not a *change* signal. It tells the user **when** they last got a source, never **whether** the narrative moved. Operators flagged this on the Mercedes Osma sessions: the line creates expectation of "delta" semantics it cannot deliver.

This spec defines a **3-state hybrid system** that gives `whatChanged` honest semantics:

| State | Copy | Posture |
|-------|------|---------|
| **first-seen** | `First appearance in your feed.` | Deterministic, no LLM. |
| **unchanged** | `No material update since your last refresh.` | Deterministic gate finds nothing material, OR LLM classify says `material: false`, OR LLM failure (fail-closed). |
| **changed** | 1–2 sentence plain prose, grounded to structured evidence diff. **No `Update:` prefix.** | Gate signals material change → Haiku confirms → Sonnet writes. |

**Why three states, not two:** "first-seen" is a categorically different user experience from "unchanged" (you've never seen this story before vs. you've seen it and nothing moved). Conflating them either over-promises ("First appearance" on stories the user has seen before) or under-explains ("No material update" on stories that are brand new). The third state costs only a boolean on the ever-seen set and zero LLM tokens.

**Why a deterministic gate before any LLM:** Most refreshes will produce **no material change** on most stories — the same handful of outlets re-syndicating the same headline. A structural diff cheaply filters these out; LLMs only run on the small subset that *could* be a delta.

**Why two LLM stages (Haiku then Sonnet), not one:** Haiku's job is **gate the writer** (`material: true|false`). Sonnet's job is **write grounded prose**. Splitting them keeps the writer call rare and lets the classifier run on shorter, cheaper context. A single-stage "classify + write" call would either write under uncertainty (false positives) or skip writing when the classifier was borderline (false negatives).

**Trust contract:**

1. Prose in the `changed` state must describe **only** changes attested by the structured evidence diff (added/removed sources, headline shifts on overlapping sources, summary/subtitle change). The writer prompt never sees a "free rewrite" framing.
2. Any LLM error / timeout falls back to **unchanged copy** — we do not synthesize a "something probably happened" sentence.
3. The deterministic gate is conservative: when in doubt about whether a signal is material, prefer `weak` (which routes to Haiku) over `strong`. We never skip Haiku to save a call at the cost of false-positive prose.

---

## 2. Vocabulary

| Term | Meaning |
|------|---------|
| **`metaStoryId`** | The stable cluster identifier set by [`reuseOrAssignIds`](../apps/api/src/dashboard/refresh-pipeline.mjs) (Phase 4 lineage). Persists across refreshes when a cluster matches a prior story; otherwise fresh. |
| **first-seen** | `metaStoryId` has never been emitted to this user's dashboard before (see [ever-seen](#ever-seen-set)). |
| **ever-seen set** | The union of every `metaStoryId` this user has ever shipped on a dashboard refresh. Stored on the persisted snapshot blob. |
| **prior snapshot** | The persisted dashboard payload from the **immediately previous successful pipeline run** for this user, read via [`_snapshotRepo.read`](../apps/api/src/db/dashboard-snapshot-repo.mjs). Already loaded for lineage continuity ([`readPriorSnapshotFn`](../apps/api/src/dashboard/refresh-pipeline.mjs)); reused here without a second I/O. |
| **prior story** | The entry in `priorSnapshot.stories` with the same `metaStoryId` as a current story. May be absent when the meta-story was off the dashboard last refresh (a "re-entry"). |
| **material change** | A delta in the *substance* of coverage: a new outlet, a removed source, a different headline on an overlapping source, a meaningfully different summary or subtitle. **Not material:** re-ordering, freshness tick, duplicate syndication. |
| **gate** | The deterministic structural comparison ([Deterministic gate rules](#5-deterministic-gate-rules)). Outputs `none` / `weak` / `strong`. |
| **classify** | The Haiku call that converts a gate signal into `material: true|false`. |
| **write** | The Sonnet call that produces 1–2 sentences of `changed` prose. |
| **watermark short-circuit** | The existing pipeline branch ([`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs) ~L1276) that skips clustering and returns `payload: null`. The route then re-serves the prior snapshot's stories verbatim, **including their `whatChanged` strings** ([Mock / CI behavior](#8-mock--ci-behavior)). |

---

## 3. State machine

### Flow

```mermaid
flowchart TD
  S[Shipped story<br/>buildStory output] --> Q1{metaStoryId in<br/>ever-seen set?}
  Q1 -- no --> FS[first-seen<br/>'First appearance in your feed.']
  Q1 -- yes --> Q2{prior story exists?<br/>i.e. metaStoryId in prior snapshot stories}
  Q2 -- no --> RE[re-entry: treat as unchanged-vs-prior<br/>fall through to gate]
  Q2 -- yes --> RE
  RE --> G[Deterministic gate<br/>compares prior vs current evidence]
  G -- none --> UNC[unchanged<br/>'No material update since your last refresh.']
  G -- weak --> H{Haiku classify<br/>material: true | false}
  G -- strong --> H
  H -- false --> UNC
  H -- true --> W[Sonnet write<br/>1–2 sentences, grounded to diff]
  W -- success --> CH[changed<br/>generated prose]
  W -- timeout/error --> UNC
  H -- timeout/error --> UNC
```

### Inputs → state → output table

| Condition | State | Output copy source |
|-----------|-------|--------------------|
| `metaStoryId` ∉ ever-seen | first-seen | Static string |
| `metaStoryId` ∈ ever-seen, no prior story, gate=`none` | unchanged | Static string |
| Prior story exists, gate=`none` | unchanged | Static string |
| Prior story exists, gate=`weak`, classify=`false` | unchanged | Static string |
| Prior story exists, gate=`weak`, classify=`true`, write OK | changed | Sonnet output |
| Prior story exists, gate=`strong`, classify=`true`, write OK | changed | Sonnet output |
| Prior story exists, gate=`strong`, classify=`false` | unchanged | Static string |
| Any LLM stage timeouts/errors | unchanged | Static string (fail-closed) |
| Delta engine disabled (`TEMPO_AI_DELTA_ENABLED=false`) or mock-only | unchanged or first-seen (gate-only path) | Static strings — no LLM |
| Watermark short-circuit | (none — prior `whatChanged` re-served) | Prior snapshot value |

**Re-entry vs first-seen:** A meta-story that was on yesterday's dashboard, dropped off today, and reappears tomorrow is **not** first-seen. The ever-seen set is authoritative for that decision. The "no prior story" branch (re-entry) falls through to the gate against the most recent prior snapshot that *did* carry it — but for MVP simplicity we compare only against the **immediately prior snapshot**, so re-entry after absence will frequently produce gate=`none` (no prior story to diff against) → `unchanged`. This is an acceptable false negative: re-entry without diff is quieter than fabricating a "back after absence" sentence.

---

## 4. Persistence

### Ever-seen set

**Shape:** `_everSeenMetaStoryIds: string[]` on the persisted snapshot payload (sibling of `_lastCheckedAt`, `_lastRunMeta`, `_selectionMeta`, `_watermark` — all `_`-prefixed and stripped by [`stripPersistedFields`](../apps/api/src/server.mjs) before responding to clients).

**Read:** Lifted at snapshot load time in [`liftSnapshotMeta`](../apps/api/src/db/dashboard-snapshot-repo.mjs). Surfaced into the in-memory pipeline context only — **never** included in the response body or `_meta.*` (it would leak history scope and inflate payload size).

**Merge rules on each successful write:**

1. Start with the prior snapshot's `_everSeenMetaStoryIds` (default `[]` when absent).
2. Union with `payload.stories.map(s => s.metaStoryId).filter(Boolean)` from the current run.
3. Deduplicate, preserve insertion order (oldest-first), persist as the new value.

**Failure modes:**

- Snapshot missing on first refresh → ever-seen starts empty → every shipped story is first-seen on that run. Correct.
- Snapshot read error → treat ever-seen as empty for this run (do not block refresh on history I/O). Stories that *would* have been "unchanged" will be labeled "first-seen" once. Acceptable; rare; logged as `everSeenLoadFailed`.
- Snapshot write error → ever-seen does not advance; same set of first-seen stories will repeat next refresh. Acceptable; same blast radius as any snapshot-write failure today.

**Stripping:** [`stripPersistedFields`](../apps/api/src/server.mjs) gains `_everSeenMetaStoryIds` to its destructured rest pattern alongside `_selectionMeta`, `_watermark`, etc., so no client surface ever sees the history list.

**Why not a separate table:** A new Postgres table would buy us cross-snapshot history, point-in-time queries, and easy pruning. We don't need any of that for MVP — the only question we ask is "is this `metaStoryId` in the set?", which a JSONB string array on the existing row answers in O(n) on a list that grows by ≤ N stories per refresh. Reconsider if (a) the array crosses ~5k entries per user, or (b) we want to expire entries on a TTL.

### Prior snapshot comparison inputs

For each current story, gather from the **prior snapshot's story with the same `metaStoryId`** (when present):

| Field | Source | Use |
|-------|--------|-----|
| `sources[].id` | `priorStory.sources` | Set diff vs current `sources[].id` → added/removed sources |
| `sources[].outlet` | `priorStory.sources` | Outlet identity ("new outlet" gate signal) |
| `sources[].headline` | `priorStory.sources` | Headline diff on overlapping `sourceId`s |
| `subtitle` | `priorStory.subtitle` | Compare to current `subtitle` |
| `summary` | `priorStory.summary` | Compare to current `summary` |
| `title` | `priorStory.title` | Compared but **not material on its own** — title is locked ([`getLockedTitles`](../apps/api/src/db/dashboard-snapshot-repo.mjs)) so equality is expected; useful only as a tie-break / debug signal |

Comparison happens **after** the current story has been built but **before** title locks are applied (see [Pipeline integration points](#7-pipeline-integration-points)). Both sides go through the same `buildStory` shape, so we are comparing apples to apples.

---

## 5. Deterministic gate rules

The gate is a pure function: `(priorStory | null, currentStory) → { signal: "none" | "weak" | "strong", reasons: string[] }`. Reads only structural fields on the response shape — no LLM, no I/O.

### Material (counts as a change signal)

| Signal | Strength | Rule |
|--------|----------|------|
| New `sourceId` (added since prior) | `strong` | Any `currentStory.sources[].id` not in `priorStory.sources[].id` set. Adds the *evidence* dimension, not just freshness. |
| New outlet (added since prior, normalized via `normalizeSourceIdentity`) | `strong` | Distinct outlet appearing — even stronger than just a new source from a known outlet. |
| Removed `sourceId` (present in prior, absent now) | `weak` | Coverage shrinking. Real signal but rarely worth a sentence on its own. |
| Headline change on overlapping `sourceId` | `strong` | Same source, different headline → the outlet itself revised. High-signal because it's not duplication noise. |
| Summary change beyond trivial normalize | `weak` | After whitespace collapse + lowercase, current `summary` ≠ prior `summary`. Often co-fires with other signals — we accept it alone as `weak` so Haiku can decide. |
| Subtitle change beyond trivial normalize | `weak` | Same as summary. |

### Not material (does **not** trip the gate)

- **Reorder only.** `sources[]` set is identical but order differs (e.g. T1 sort breaking a tie differently). Same evidence; no signal.
- **Freshness tick.** Same `sourceId` set, same headlines, only `minutesAgo` decreased. Time passing is not a delta.
- **Duplicate syndication.** A new `sourceId` whose outlet is already represented AND whose headline normalizes to an existing one. Treated as syndication noise. (Implementation note: cross-feed dedupe already collapses many of these upstream; this is a belt-and-suspenders rule.)
- **`outletCount` change driven only by syndication.** Computed downstream of the rules above — if the only delta is `outletCount` and nothing else, treat as `weak` to be safe (covered by the "removed sourceId" pathway when shrinkage; the growth case is already a "new outlet" → `strong`).
- **`tags` axis change.** Tags are derivative of evidence; if any axis content moved, the underlying evidence almost certainly tripped one of the rules above. Tag-only deltas (e.g. Phase 4 semantic uplift flipping at a threshold) are *not* user-facing news.
- **Title change.** Should not happen — title is locked. If it does (lock missed), treat as `weak` and log; not strong because the displayed title is often editorial.

### Signal aggregation

The gate returns the **maximum strength** observed across all rules, plus a list of `reasons[]` for observability. `strong` overrides any `weak`. `none` only when every rule says "not material".

### Why these rules

| Decision | Reasoning |
|----------|-----------|
| New source = `strong`, removed source = `weak` | Users care more that coverage **grew** (new evidence) than that it shrank (an outlet stopped covering). Removal is signal but usually small. |
| Summary/subtitle = `weak` not `strong` | These fields come from `factual_claims[0]` ([`buildStory`](../apps/api/src/dashboard/refresh-pipeline.mjs) J3b) — they shift on cluster recompositions even when underlying coverage is stable. Routing through Haiku filters those false positives. |
| Reorder = `none` | Reordering is a function of server-side ranking (T1, R1), not user-visible narrative. Promoting it would create constant churn. |
| Tag changes = `none` | K1a one-way invariant: tags never widen pool/recall. They also shouldn't widen `whatChanged`. |

---

## 6. LLM stages (for later phases)

These are deferred to a follow-up implementation phase. This section specifies the **contracts** so the engine module is implementable without further design.

### Haiku classify

| Aspect | Spec |
|--------|------|
| Model env | `TEMPO_AI_DELTA_CLASSIFY_MODEL` (default `anthropic:claude-haiku-4-5-20251001`). Routes through [`providerFor`](../apps/api/src/ai/model-router.mjs) — same pattern as the geo assessor and cluster engine. |
| When invoked | Gate signal is `weak` OR `strong`, AND `TEMPO_AI_DELTA_ENABLED=true`, AND `TEMPO_AI_MOCK_ONLY` is unset/false. See [recommendation 3](#alignment-recommendations) for the always-Haiku posture. |
| Input | Compact JSON: `{ metaStoryId, gateSignal, gateReasons, prior: { headlines[], summary, subtitle, sources: [{outlet, headline}] }, current: { same shape }, diff: { addedSourceIds, removedSourceIds, headlineChanges[] } }`. Bodies are NOT sent — headlines + summary + subtitle only. |
| Output | Strict JSON object: `{ material: boolean, confidence: number, reasonCode: string }`. Anything else → treat as error → fail-closed unchanged. |
| Timeout | `TEMPO_AI_DELTA_TIMEOUT_MS` (default `2500`). Per-call. On timeout: increment `llmFailed.classify`, route to unchanged. |
| Skipped when | `gateSignal === "none"`; or `TEMPO_AI_DELTA_ENABLED=false`; or `TEMPO_AI_MOCK_ONLY=true`. |

### Sonnet write

| Aspect | Spec |
|--------|------|
| Model env | `TEMPO_AI_DELTA_WRITE_MODEL` (default `anthropic:claude-sonnet-4-6`). |
| When invoked | Haiku returned `material: true` AND `TEMPO_AI_DELTA_ENABLED=true`. |
| Input | Same compact JSON as Haiku, plus an explicit `instruction: "Describe the material delta in 1–2 sentences. Do NOT prefix with 'Update:'. Cite only changes attested in `diff`. If the diff is thin, prefer a single short sentence."`. Headlines + 400-char excerpt per added source (no full body, no embeddings). |
| Output | Plain string, max 2 sentences (post-validation: split on sentence terminators; if > 2 sentences, truncate to first 2 OR fail-closed if truncation loses the noun phrase — implementation-time choice, log either way). |
| Length cap | 300 characters hard cap on the final string. Hard-overflowing outputs → fail-closed unchanged. |
| Timeout | `TEMPO_AI_DELTA_TIMEOUT_MS` (shared with classify; per-call). On timeout: increment `llmFailed.write`, fall back to unchanged. |
| Grounding constraint | Prompt must instruct: "Do not introduce facts not present in `diff` or `current`. Do not speculate about motive, audience, or future actions. Past tense, active voice." Implementation may include 1–2 few-shot examples. |
| Hallucination guard | A lightweight post-check: every named entity (outlet name, person, place) in the output must appear in either `diff` text fields or `current.sources[].outlet`. Failures → fail-closed unchanged + `llmFailed.hallucination`. |

### Proposed env vars (consolidated)

| Var | Default | Purpose |
|-----|---------|---------|
| `TEMPO_AI_DELTA_ENABLED` | `false` (Phase 4 keeps the default off; operators opt in per-deployment when ready) | Global gate. Truthy values: `"true"` or `"1"` (case-insensitive). Off → engine returns `first-seen` / `unchanged` from deterministic gate only; LLM stages never run. |
| `TEMPO_AI_DELTA_CLASSIFY_MODEL` | `anthropic:claude-haiku-4-5-20251001` | Haiku model id. |
| `TEMPO_AI_DELTA_WRITE_MODEL` | `anthropic:claude-sonnet-4-6` | Sonnet model id. |
| `TEMPO_AI_DELTA_TIMEOUT_MS` | `2500` | Per-call timeout for either stage. |

`TEMPO_AI_MOCK_ONLY=true` continues to force every LLM-routing layer to the mock providers (existing pattern in [`providerFor`](../apps/api/src/ai/model-router.mjs)).

### Operator notes

- **Default is off at the engine layer, on for prototype dev.** `TEMPO_AI_DELTA_ENABLED` is unset (or `false`) in every committed `.env` file, so `resolveDeltaConfig()` defaults the engine off. The prototype API's `bootstrapApiEnv()` in [`server.mjs`](../apps/api/src/server.mjs) flips it to `"true"` when unset and `NODE_ENV !== "test"`, so local `npm run dev` runs with delta on by default. Production refreshes inherit whatever explicit value the deployment environment sets — committed `.env` files still ship `false`.

- **`TEMPO_AI_MOCK_ONLY=true` vetoes the LLM path.** CI runs and any developer who flips mock-only mode for cost control will never emit `changed` prose, even with `DELTA_ENABLED=true`. The engine fail-closes to `unchanged` copy and increments `classifySkipped` in `_meta.whatChanged`.

- **Cost and latency posture.** The pipeline runs the engine **serially** per shipped story (typical dashboard ≤ 10 stories). Worst-case latency per refresh when fully enabled is `N × (Haiku + Sonnet)`, where `N` ≤ shipped story count; `gate=none` stories skip both calls. The per-call timeout defaults to 2.5 s, shared by classify and write — bump `TEMPO_AI_DELTA_TIMEOUT_MS` if tail latency dominates.

- **When to enable.** Validate first in staging with a real Anthropic key, `TEMPO_AI_MOCK_ONLY` unset, and `TEMPO_AI_DELTA_ENABLED=true`. Watch `_meta.whatChanged` for a few refreshes; high `llmFailed.classify` / `llmFailed.write` / `llmFailed.hallucination` means the timeout or grounding is tighter than the writer can handle. Roll back with `TEMPO_AI_DELTA_ENABLED=false`.

- **Rollback is one flag.** Setting `TEMPO_AI_DELTA_ENABLED=false` immediately reverts every shipped story to the deterministic first-seen / unchanged branch. No code change required.

- **`/api/ai/models` readiness — deferred.** [`getProviderReadiness()`](../apps/api/src/ai/model-router.mjs) reports clustering / geoAssess / embedding via a single boolean (`readyForRealRun` = every capability ready). Adding informational-only delta capabilities (Haiku + Sonnet) would require bucketing capabilities so `readyForRealRun` doesn't flip to false when delta is intentionally off — past the small-diff ceiling for this phase. Operators read delta health from `_meta.whatChanged` instead: `classifyCalled` / `writeCalled` / `llmFailed.*` already expose model availability. Revisit if a separate "AI surface health" panel ever needs a single endpoint.

---

## 7. Pipeline integration points

### Where the engine runs

**Recommended location:** inside [`runRefreshPipeline`](../apps/api/src/dashboard/refresh-pipeline.mjs), **after** the `storiesWithSortKeys.map(...) → buildStory` loop and the R1 sort, and **after** the Phase 4 semantic tag uplift, but **before** the function returns. Concretely: a new step "11. Compute `whatChanged` per story" inserted between the current tags-overlay loop and the `funnel = summarizeFunnel(...)` summarization.

**Why here and not in `buildStory`:**

1. `buildStory` is a synchronous shaping function. The delta engine is async (LLM calls). Hoisting async into `buildStory` would force every caller to await; today's call site already runs serially.
2. The engine needs the prior snapshot — which the pipeline already loaded via `readPriorSnapshotFn` for lineage ID assignment. Reusing that read is free; doing it in `buildStory` would require either re-reading or threading the prior list through three layers.
3. We want the engine to see the **final R1-sorted, Phase 4–tagged** story (so the prior-vs-current diff is symmetric with what the user actually sees on the dashboard). Running before R1 sort would compare differently-ordered evidence sets.

**Why not in `server.mjs` after title locks:**

- Title locks override `story.title` and `story.subtitle` for *display*. The underlying meta-story may have evolved. We want the diff to reflect the underlying evidence, not the lock-frozen surface. Running before locks keeps the diff honest. (Both sides comparing locked-vs-locked is also defensible, since prior snapshot is also lock-applied; but running pre-lock keeps the engine framework-clean and lets it ignore the locks layer entirely.)
- Pipeline location centralizes diagnostics in `log` alongside `funnel`, `recall`, `beatFit`, `tags` — operator UX is consistent.

### Integration order summary

```
1. Normalize → 24h → source selection → geo → recall → beat-fit → dedupe
2. Watermark check  → (if match) short-circuit return (prior whatChanged re-served)
3. Cluster → reuseOrAssignIds (reads prior snapshot)  ← prior snapshot already in scope
4. verifyGrounding
5. storiesWithSortKeys = groundedStories.map(buildStory) → R1 sort
6. Phase 4 semantic tag overlay
7. NEW: for each story, computeWhatChanged({ story, priorStory, everSeenSet, config })
   – mutates story.whatChanged in place (same overlay pattern as the tags loop)
8. summarizeFunnel + log
9. Return { payload, log }
```

### Snapshot-write integration ([`server.mjs`](../apps/api/src/server.mjs))

The route handler is responsible for:

1. Reading prior `_everSeenMetaStoryIds` from the prior snapshot (already loaded in `priorSnapshot` ~L891).
2. Passing it to the pipeline as a new option (e.g. `everSeenMetaStoryIds: priorSnapshot?._everSeenMetaStoryIds ?? []`).
3. Computing the merged set after the pipeline returns: `nextEverSeen = [...new Set([...prior, ...payload.stories.map(s => s.metaStoryId).filter(Boolean)])]`.
4. Writing it onto `finalPayload._everSeenMetaStoryIds` alongside the existing `_lastCheckedAt` / `_lastRunMeta` / `_watermark`.

[`stripPersistedFields`](../apps/api/src/server.mjs) gains the new key in its destructure so client responses do not carry the array.

### Watermark short-circuit interaction

When the watermark matches ([`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs) ~L1276), the pipeline returns `payload: null` and the route re-serves the prior snapshot. **The prior `whatChanged` strings are served verbatim.** This is by design: nothing material has changed (that's what the watermark assertion *means*), so the prior delta classification — including any "changed" prose — is still the truthful answer.

The implication: on a watermark skip, the user can see the same "X added a new source" sentence twice in a row. That is correct: it *did* happen, and we have no new information to revise it with. Recomputing on a watermark skip would re-classify against the same evidence and produce the same answer at higher cost.

---

## 8. Mock / CI behavior

The engine must be safe to run in CI and in `TEMPO_AI_MOCK_ONLY=true` environments. Specifically:

| Mode | Gate | Classify | Write | Output |
|------|------|----------|-------|--------|
| `TEMPO_AI_DELTA_ENABLED=false` | runs | skipped | skipped | first-seen / unchanged only |
| `TEMPO_AI_MOCK_ONLY=true` (any value of DELTA_ENABLED) | runs | skipped | skipped | first-seen / unchanged only |
| Default prod (DELTA_ENABLED=true, MOCK_ONLY unset) | runs | runs on `weak`/`strong` | runs on `material:true` | full 3-state |
| Test injection (per-test scorer / classify / write stubs) | runs | runs (stub) | runs (stub) | deterministic per stub |

**No `changed` prose without real LLM SKUs.** A mock-mode CI run will never emit free-text deltas. Deterministic templates only. This mirrors the Phase 4 tags posture (semantic scorer skipped when mock-only / disabled, deterministic baseline always ships).

**Testability hooks (proposed for engine module):**

- `classifyFn` injectable — defaults to the Anthropic Haiku call; tests stub.
- `writeFn` injectable — defaults to the Anthropic Sonnet call; tests stub.
- `clockFn` not needed (no time-based logic in MVP; freshness is intentionally not a signal).

---

## 9. Observability

Add a `log.whatChanged` aggregate per pipeline run. Surface it via the existing `_lastRunMeta` → `_meta.whatChanged` pathway in [`liftSnapshotMeta`](../apps/api/src/db/dashboard-snapshot-repo.mjs) so `GET /api/dashboard` answers "how often did the engine fire and what did it decide?" without a re-run.

### Counters (per refresh)

| Counter | Meaning |
|---------|---------|
| `firstSeen` | Stories whose `metaStoryId` was not in the ever-seen set. |
| `unchanged` | Stories that received the unchanged copy (gate=none OR classify=false OR fail-closed fallback). |
| `changed` | Stories that received writer prose. |
| `gateStrong` | Stories where gate returned `strong`. |
| `gateWeak` | Stories where gate returned `weak`. |
| `gateNone` | Stories where gate returned `none`. |
| `classifySkipped` | gate=none OR engine disabled OR mock-only. |
| `classifyCalled` | Haiku invocations. |
| `classifyMaterialTrue` | Haiku said `material: true`. |
| `classifyMaterialFalse` | Haiku said `material: false`. |
| `writeCalled` | Sonnet invocations. |
| `writeOk` | Sonnet returned valid prose. |
| `llmFailed.classify` | Haiku timeout/error. |
| `llmFailed.write` | Sonnet timeout/error. |
| `llmFailed.hallucination` | Sonnet output failed entity grounding post-check. |
| `everSeenLoadFailed` | Snapshot read for ever-seen set failed (rare). |
| `watermarkShortCircuited` | Boolean — true on this run the engine was bypassed in favor of the prior snapshot. |
| `latencyMs.classify` | Cumulative classify-call latency this refresh. |
| `latencyMs.write` | Cumulative write-call latency this refresh. |

**State vs gate counters overlap.** First-seen stories short-circuit before the structural gate runs and carry `gate.signal === "none"` with reason `first_seen`, so they increment **both** `firstSeen` (state) and `gateNone` (gate signal). Operators read state counters to answer "what did the user see?" and gate counters to answer "did the structural diff find anything?" — first-seen stories belong in both buckets, by design.

### Log line

One `[pipeline.whatChanged]` log line per refresh, mirroring the `[pipeline.tags]` format — single-line key=value pairs an operator can read at a glance.

### Schema version

`_meta.whatChanged.schemaVersion: "whatchanged-v1"` so downstream consumers can detect contract changes. Bumped any time the counter shape grows or shrinks.

---

## 10. Test scenarios

Minimum coverage for the engine module (unit tests) and pipeline integration (integration tests). All assertions are on the produced `story.whatChanged` value AND the `log.whatChanged` counters.

| # | Scenario | Setup | Expected `whatChanged` | Expected counters | Coverage |
|---|----------|-------|------------------------|-------------------|----------|
| 1 | **First-seen** | `metaStoryId="msX"` not in ever-seen set; prior snapshot may or may not exist | `First appearance in your feed.` | `firstSeen=1`, `gate*=0`, `classify*=0`, `write*=0` | pipeline: `refresh-pipeline.test.mjs` *"Phase 4 — first refresh (empty ever-seen)…"* |
| 2 | **Unchanged, same sources** | `msX` ∈ ever-seen; prior story exists; current `sources[].id` set = prior's; headlines identical; summary/subtitle identical | `No material update since your last refresh.` | `unchanged=1`, `gateNone=1`, `classifySkipped=1` | engine: `what-changed-engine.test.mjs` *"resolver: ever-seen + prior + gate none → unchanged copy (spec §10 row 2)"* · pipeline: `refresh-pipeline.test.mjs` *"Phase 4 — second refresh (same metaStoryId, no structural change)…"* |
| 3 | **New source only (strong gate → classify true → write OK)** | `msX` ∈ ever-seen; one new `sourceId` from a new outlet; classify stub returns `{material:true}`; write stub returns valid prose | Sonnet prose, 1–2 sentences, no `Update:` prefix, ≤ 300 chars | `changed=1`, `gateStrong=1`, `classifyCalled=1`, `classifyMaterialTrue=1`, `writeCalled=1`, `writeOk=1` | engine: `what-changed-engine.test.mjs` *"spec §10 row 3 — strong gate + classify:true + write OK…"* · pipeline: *"Phase 4 — strong gate + deltaConfig enabled + classify/write stubs…"* |
| 4 | **Re-entry after absence** | `msX` ∈ ever-seen; but absent from prior snapshot (off-dashboard last refresh); current story exists | `No material update since your last refresh.` | `unchanged=1`, `gateNone=1` | engine: `what-changed-engine.test.mjs` *"resolver: ever-seen but priorStory absent → unchanged copy (re-entry)…"* · *"resolveWhatChanged: re-entry (ever-seen + no priorStory) → unchanged + classifySkipped"* |
| 5 | **LLM failure (Sonnet times out)** | Strong gate → Haiku returns `material:true` → Sonnet stub throws timeout | `No material update since your last refresh.` | `gateStrong=1`, `classifyMaterialTrue=1`, `writeCalled=1`, `llmFailed.write=1`, `unchanged=1` | engine: `what-changed-engine.test.mjs` *"spec §10 row 5 — classify:true but write throws…"* |
| 6 | **Watermark short-circuit** | Prior snapshot has stories with their own `whatChanged` strings; current watermark matches prior; pipeline returns `payload: null` | Each story's `whatChanged` from prior snapshot, re-served unchanged | Engine never invoked; `_meta.whatChanged.watermarkShortCircuited=true` (set by the short-circuit return branch) | pipeline: `refresh-pipeline.test.mjs` *"Phase 4 — watermark short-circuit: log.whatChanged.watermarkShortCircuited=true…"* · route: `server.routes.test.mjs` *"POST /api/dashboard/refresh: watermark unchanged → re-serves prior whatChanged strings verbatim (spec §10 row 6)"* |
| 7 | **Mock mode (TEMPO_AI_MOCK_ONLY=true)** | Strong gate fires; mock-only env | `No material update since your last refresh.` (gate fires but classify is skipped → fail-closed unchanged) | `gateStrong=1`, `classifySkipped=1`, `unchanged=1` | engine: `what-changed-engine.test.mjs` *"spec §10 row 7 — TEMPO_AI_MOCK_ONLY=true + strong gate…"* |
| 8 | **Strong gate + Haiku rejects** | New source added; classify stub returns `{material:false, reasonCode:"syndication_duplicate"}` | `No material update since your last refresh.` | `gateStrong=1`, `classifyCalled=1`, `classifyMaterialFalse=1`, `writeCalled=0`, `unchanged=1` | engine: `what-changed-engine.test.mjs` *"spec §10 row 8 — strong gate + classify:false…"* |
| 9 | **Headline change on overlapping source** | Same `sourceId` set; one `source.headline` differs from prior | Sonnet prose (if classify=true) OR unchanged (if classify=false). Asserts gate=`strong`, classify is called. | `gateStrong=1`, `classifyCalled=1` | engine: `what-changed-engine.test.mjs` *"spec §10 row 9 — headline_change on overlapping id…"* |
| 10 | **Engine disabled (TEMPO_AI_DELTA_ENABLED=false)** | Strong gate fires; engine globally disabled | `No material update since your last refresh.` | `gateStrong=1`, `classifySkipped=1`, `unchanged=1` | engine: `what-changed-engine.test.mjs` *"spec §10 row 10 — TEMPO_AI_DELTA_ENABLED=false…"* · pipeline: *"Phase 4 — deltaConfig disabled + strong gate…"* |
| 11 | **Reorder-only change** | Same `sources[].id` set; same headlines; only T1 ordering differs (e.g. weight tie broken differently) | `No material update since your last refresh.` | `gateNone=1`, `classifySkipped=1`, `unchanged=1` | engine: `what-changed-engine.test.mjs` *"resolver: ever-seen + prior + reorder only → unchanged copy + gate none (spec §10 row 11)"* · *"resolveWhatChanged: gate:'none' (reorder only) → unchanged + classifySkipped, no LLM call"* |
| 12 | **Hallucination guard trips** | Strong gate; classify=true; Sonnet writes a sentence naming an outlet not in the diff | `No material update since your last refresh.` | `writeCalled=1`, `llmFailed.hallucination=1`, `unchanged=1` | engine: `what-changed-engine.test.mjs` *"spec §10 row 12 — classify:true + write returns hallucinated outlet…"* |

Tests 1–8 are the locked minimum. 9–12 are recommended to add at engine implementation time; locking them now in the spec keeps the contract honest about edge cases.

---

## 11. Open questions

Each has a **recommended default** so implementation is unblocked. Revisit at engine code-review time.

### 1. New source, same narrative angle — material or unchanged?

**Recommendation: material (`strong` gate).** Users care that coverage grew. Even when the new outlet says the same thing, "Reuters now covering this" is a real fact in a comms workflow. Haiku can downgrade syndication-style additions via `reasonCode: "syndication_duplicate"` if we discover noise in practice; the gate stays liberal.

### 2. LLM failure fallback — unchanged copy vs generic safe sentence?

**Recommendation: unchanged copy (`No material update since your last refresh.`).** A generic "something may have changed" sentence is the worst kind of trust leak — the user can't tell if the engine knew something or hallucinated something. The unchanged copy is honest about the engine's epistemic state.

### 3. Haiku on weak vs always-Haiku posture

**Recommendation: always-Haiku (run Haiku on both `weak` and `strong`).** Cost is small (Haiku tokens are cheap; one call per shipped story per refresh is bounded by R1-sorted dashboard size, ~10–30). The savings from skipping Haiku on `strong` (~hundreds of milliseconds per refresh aggregate) don't outweigh the false-positive risk of going straight to Sonnet on a misjudged gate signal. We can revisit if production telemetry shows Haiku is the dominant latency contributor.

### 4. Ever-seen array growth

**Recommendation: unbounded for MVP.** A single user accumulating > 5k distinct `metaStoryId`s would take many months of daily refreshes given typical dashboard sizes. Add prune-on-write (LRU at 10k entries) as a fast-follow once we have telemetry on actual growth rates.

### 5. Evidence passed to Sonnet — full body vs headline + excerpt

**Recommendation: headline + 400-char excerpt per added source.** Full bodies inflate latency and the writer doesn't need them — the gate already identified *what* changed; Sonnet's job is to paraphrase, not investigate. 400 chars is enough for a lede paragraph on most outlets; trim policy: take from start, no mid-word break.

### Other open items (lower priority)

- **Persona-aware copy.** Mercedes-style ("monitoring narrative shifts") might want richer prose than other personas. Out of scope until we have N>1 personas validated. Recommended default: single copy regimen for all users.
- **Suppression on first-seen + low-evidence stories.** A first-seen story with one source feels weak. Could we route to "Light first appearance — single source so far"? Recommended default: no — single copy line keeps the contract simple; the source count is visible in the chip row.
- **Multi-language.** Mercedes operates bilingually. Both static copy strings are English. Recommended default: English-only MVP; defer i18n until product decides per-user language.
- **Re-entry diff against last-known-prior, not immediately-prior.** Could yield richer prose on re-entry but doubles persistence surface (we'd need to remember the last carrying snapshot per `metaStoryId`). Recommended default: immediately-prior only, accept re-entry as `unchanged`.

---

## Alignment recommendations

Consolidated for quick scan. Each is a **default** the engine implementation should follow unless overruled.

| # | Question | Recommendation |
|---|----------|---------------|
| 1 | New source counted as material? | **Yes (strong)**. Haiku may downgrade. |
| 2 | LLM failure fallback? | **Unchanged copy**, never a generic safe sentence. |
| 3 | Skip Haiku on strong gate? | **No — always run Haiku** when the engine is enabled. |
| 4 | Ever-seen array growth bound? | **Unbounded** in MVP; prune is fast-follow. |
| 5 | Evidence depth to Sonnet? | **Headline + 400-char excerpt**, never full bodies. |
| 6 | Watermark recompute? | **Never** — re-serve prior `whatChanged` verbatim on watermark match. |
| 7 | Engine off (mock / disabled)? | **First-seen + unchanged only** — no LLM, no `changed` prose. |
| 8 | Pre-lock vs post-lock comparison? | **Pre-lock** (engine runs inside pipeline, before [`server.mjs`](../apps/api/src/server.mjs) lock application). |

---

## Cross-references

- [Dashboard story pool spec](dashboard-story-pool-spec.md) — the post-candidate stage map this engine integrates into.
- [`refresh-pipeline.mjs`](../apps/api/src/dashboard/refresh-pipeline.mjs) — host for the engine call site (step 11 in the integration order above).
- [`server.mjs`](../apps/api/src/server.mjs) — owner of the ever-seen merge + persistence handoff.
- [`dashboard-snapshot-repo.mjs`](../apps/api/src/db/dashboard-snapshot-repo.mjs) — gains `_everSeenMetaStoryIds` lift/strip handling.
- [`schemas.ts`](../packages/contracts/src/schemas.ts) — `storySchema.whatChanged` stays a non-empty string. No schema change in this work.
- [`StoryCard.tsx`](../../04-prototype/src/components/StoryCard.tsx) — consumes `story.whatChanged` unchanged; no frontend work in this phase.
- [`model-router.mjs`](../apps/api/src/ai/model-router.mjs) — proposed new env vars follow the existing `TEMPO_AI_*_MODEL` naming pattern.
