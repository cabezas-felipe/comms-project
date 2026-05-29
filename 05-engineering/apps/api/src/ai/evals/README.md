# AI Evals

Lightweight, local eval harnesses for AI pipeline components. Version-controlled gold dataset. No Supabase. No network dependencies beyond the AI providers.

| Harness | What it measures | Run | Gates release? |
|---|---|---|---|
| **Critical hard-fail suite (Phase 5b)** | 8 E2E presence-first scenarios; deterministic + advisory hybrid layers | `npm run eval:critical` | **Yes** — non-zero exit on any critical scenario failure |
| Onboarding extraction | Per-field precision / recall / F1 / exact-match across 20 gold examples | `npm run eval:onboarding-extraction` | No — advisory, drift only |
| Cluster shape smoke (M8) | Contract-shape guard: clustering output conforms to `metaStoryOutputSchema` on a 3-item fixture | `npm run eval:cluster-smoke` | Smoke gate (non-zero on contract violation) |
| **Dashboard refresh golden (Slice 2)** | Hermetic E2E regression guard: fail-closed clustering, no degraded titles, liveblog dedupe, recall floor, healthy 2+ stories | `npm run eval:dashboard-refresh-golden` | Smoke gate (non-zero on any scenario failure) |
| **Embed-floor calibration (Slice 5)** | Sweeps `TEMPO_EMBED_MIN_SIMILARITY` (0 / 0.35 / 0.40 / 0.45) and reports `similarityRejected` / `finalStories` / Reuters / liveblog metrics per floor | `npm run eval:dashboard-calibration` | Guardrail gate only (non-zero if fail-closed / degraded title / no Reuters / liveblog regression at any floor); floor metrics are advisory |
| **Dashboard quality gate (Slice 6)** | CI-grade gate: runs golden + calibration in one command, writes a calibration JSON artifact | `npm run eval:dashboard-quality-gate` | **Yes** — non-zero if golden fails OR calibration guardrails regress |

---

## Onboarding Extraction Evals

## What it measures

Five extracted fields evaluated set-by-set against 20 hand-labeled examples:

| Field | Description |
|---|---|
| `topics` | Broad subject areas |
| `keywords` | Specific terms, acronyms, proper names |
| `geographies` | Country or region names |
| `traditionalSources` | News outlets and publications |
| `socialSources` | Social-media handles |

Metrics per field: **exact-match rate**, **precision**, **recall**, **F1** (macro-averaged).
Overall: **exact-match rate** (% examples where all 5 fields match exactly).

## How to run

Requires a real Anthropic API key:

```sh
cd 05-engineering/apps/api
TEMPO_ANTHROPIC_API_KEY=sk-ant-... npm run eval:onboarding-extraction
```

Or if `TEMPO_ANTHROPIC_API_KEY` is already in your environment:

```sh
npm run eval:onboarding-extraction
```

Without an API key the runner still executes but marks every example as `extraction_error`.

## Model chain

Mirrors onboarding runtime behavior (Section 7):

1. **Primary**: `anthropic:claude-opus-4-7`
2. **Fallback**: `anthropic:claude-sonnet-4-6`

If both fail for an example, it is marked `extraction_error` and scored 0 on all fields.

## When to run

- After any system-prompt or model change
- After adding or editing gold examples
- Before cutting a release that touches extraction logic
- When onboarding extraction exact-match drifts materially (advisory only; release gate remains `npm run eval:critical`)

## Dataset

`onboarding-extraction.gold.json` — 20 examples across four buckets:

| Bucket | Count | Description |
|---|---|---|
| `clean_explicit` | 5 | Clear, specific narratives with explicit sources |
| `implicit_ambiguous` | 5 | Vague or context-dependent inputs, no explicit geography |
| `noisy_long` | 5 | Real-world messy prose with conversational noise |
| `edge_negative` | 5 | Minimal inputs, deduplication stress, empty-field cases |

## Adding examples

Append to `onboarding-extraction.gold.json`. Each entry must have:

```json
{
  "id": "ex-21",
  "bucket": "clean_explicit",
  "inputText": "...",
  "expected": {
    "topics": [],
    "keywords": [],
    "geographies": [],
    "traditionalSources": [],
    "socialSources": []
  }
}
```

Gold labels should reflect what a well-calibrated model *should* extract — not what the current model produces. When in doubt, ask: would a comms professional reading this input expect to see this field populated?

## Note

This is an **eval harness**, not model training. Results inform prompt and model selection decisions. They do not feed back into the model weights.

---

## Cluster Shape Smoke (M8)

Risk-reduction guard for the clustering path used by the dashboard refresh pipeline. **Not a quality benchmark** — verifies only that `clusterItems(...)` returns output conforming to the contract downstream stages depend on.

```sh
cd 05-engineering/apps/api
npm run eval:cluster-smoke
```

The smoke reads the clustering model via the same `getAiCapabilityMap().clustering` resolution the refresh pipeline uses:

- Default (`TEMPO_AI_CLUSTER_MODEL` unset, or `TEMPO_AI_MOCK_ONLY=true`) → exercises the mock path deterministically; no key required.
- Set `TEMPO_AI_CLUSTER_MODEL=anthropic:claude-sonnet-4-6` with `TEMPO_ANTHROPIC_API_KEY` → exercises the real Anthropic clustering call.

### Checks

1. `clusterItems(...)` returns a non-empty array.
2. Each meta-story validates against `metaStoryOutputSchema` (exported from `cluster-engine.mjs`).
3. Each meta-story carries a non-empty `meta_story_id`.
4. `source_item_ids` references only the fixture sourceIds (no hallucinated ids leak through).

### Exit codes

- `0` — all checks pass.
- `1` — schema violation, missing `meta_story_id`, hallucinated source ids, or a thrown error inside `clusterItems`. Diagnostics print the offending payload.

When to run: before DC validation sessions on real-model config, or after touching `cluster-engine.mjs` / clustering prompts.

---

## Dashboard Refresh Golden (Slice 2)

Regression harness pinning the specific failures from the bad dashboard E2E:
exactly one degraded **"General Updates"** meta-story, a **Spelling Bee
liveblog** stack that never collapsed, **no Reuters** content, and clustering
**fallback output shipped** to users. Runs end-to-end against `runRefreshPipeline`
with injected stubs (clustering + embeddings) — fully hermetic, no provider keys
or network. A separate `eval:cluster-smoke` can exercise real providers.

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-refresh-golden
```

### Fixture

`dashboard-refresh.gold.json` — one think-tank persona (topics economy /
elections / Trump / Iran / inflation / gas; sources Washington Post + Reuters;
geographies US + Iran) plus three deterministic raw-item sets:

- `onBeatItems` — on-beat WaPo + Reuters headlines (Trump/Iran, economy, elections).
- `liveblogVariants` — four `Live updates: Scripps National Spelling Bee …` variants (case / plural / whitespace / URL drift) to assert liveblog collapse.
- `weakSemanticItem` — an off-beat, semantic-only item below the recall floor.

### Scenarios

| ID | Intent | Must pass |
|---|---|---|
| `gold-01-fail-closed` | Clustering throws on both attempts | `stories.length === 0`, `usedFallbackClustering === true`, `clusteringFailureReason === "error"`, `clusteringAttempts === 2`, no degraded titles |
| `gold-02-healthy-path` | Stub returns 2 grounded clusters | `metaStoryCount >= 2`, `usedFallbackClustering === false`, Reuters present, no `/updates?$/i` or "General Updates" titles |
| `gold-03-liveblog-dedupe` | 4 Spelling Bee variants ingested | exactly 1 reaches clustering (newest `lb-4` survives), `dedupe.collapsedCount >= 3` |
| `gold-04-recall-floor` | Weak semantic-only item present | `recall.minSimilarityThreshold === 0.4`, `recall.similarityRejected >= 1`, item excluded from clustering |

### Exit codes

- `0` — all scenarios pass.
- `1` — any scenario failed (or a runner error); diagnostics print the failing reasons.

When to run: after touching `refresh-pipeline.mjs`, `source-deduper.mjs`,
`embedding-recall.mjs`, or the clustering fail-closed path.

---

## Embed-floor Calibration (Slice 5)

### Why this exists

`TEMPO_EMBED_MIN_SIMILARITY` (the recall **cosine floor** for SEMANTIC-ONLY
top-K union adds — keyword/topic hits always bypass it) ships at **0.40**.
Choosing a floor used to be guesswork. This harness sweeps candidate floors and
reports objective diagnostics per value so a default change is driven by
evidence, not vibes. It is **not** a beat-fit knob — see
[DECISIONS.md → D-063 addendum](../../../../../DECISIONS.md) ("embed floor ≠ beat-fit
threshold").

It changes **no runtime default** — `DEFAULT_EMBED_MIN_SIMILARITY` stays 0.40 in
`embedding-recall.mjs`. The sweep injects a floor per run via `recallConfig`.

### How to run

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-calibration            # table + advisory metrics
npm run eval:dashboard-calibration:verbose    # also prints per-floor guardrail detail
```

Hermetic: reuses the golden fixture + four deterministic "semantic-only" probe
items pinned at cosine bands 0.33 / 0.38 / 0.43 / 0.48 (no keyword/topic match,
so they enter recall ONLY via the floor). No live RSS / Anthropic / embedding
provider.

### What it reports (per floor: 0, 0.35, 0.40, 0.45)

`finalStories`, `usedFallbackClustering`, `clusteringFailureReason`,
`recall.keywordRecallCount`, `recall.finalRelevant`, `recall.similarityRejected`,
`recall.minSimilarityThreshold`, Reuters-sourced count, and liveblog
collapsed-duplicate count.

### Guardrails (hard fail → exit 1, any floor)

- clustering fell closed (`usedFallbackClustering === true`)
- degraded generic title (`* Updates` / "General Updates")
- no Reuters presence in the story pool
- liveblog dedupe regression (the 4-variant stack failed to collapse, `< 3`)

Floor-by-floor metrics are **advisory** and never fail the run.

### Interpreting `similarityRejected` vs story quality

`similarityRejected` counts semantic-only candidates the floor held back. As the
floor rises it goes **up** and `finalStories` / `finalRelevant` go **down** —
the floor is trimming weaker semantic neighbors. That is the lever, not a verdict:
a higher `similarityRejected` is only "good" if the rejected items were genuinely
off-beat. Pair the table with manual quality review (`?debug=1` → `diag-recall`)
on the real dashboard before moving the default. **Default stays 0.40 unless a
committed run shows systematic loss of on-beat stories at 0.40** (i.e. relevant
items rejected) — then propose a lower floor; or systematic noise admitted at
0.40 — then propose a higher floor.

### When to run

Before proposing any change to `DEFAULT_EMBED_MIN_SIMILARITY`, and after touching
`embedding-recall.mjs` recall/union logic.

### JSON artifact

Pass `--json-out <path>` to also write a machine-readable artifact (the human
table is unchanged), so CI and reviewers can diff runs over time:

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-calibration:json    # writes tmp/dashboard-calibration.json
# or, custom path:
node src/ai/evals/run-dashboard-calibration.mjs --json-out .artifacts/calibration.json
```

Shape (`harness` / `version` identify the format; `version` bumps only on a
breaking change):

```jsonc
{
  "harness": "dashboard-embed-floor-calibration",
  "version": 1,
  "timestamp": "2026-05-29T03:54:10.571Z",
  "productionDefaultFloor": 0.4,
  "floors": [0, 0.35, 0.4, 0.45],
  "overall": { "pass": true, "hardFail": false },
  "rows": [
    {
      "floor": 0.4,
      "finalStories": 7,
      "usedFallbackClustering": false,
      "clusteringFailureReason": null,
      "keywordRecallCount": 8,
      "finalRelevant": 10,
      "similarityRejected": 2,
      "minSimilarityThreshold": 0.4,
      "reutersCount": 2,
      "liveblogCollapsed": 3,
      "guardrail": { "pass": true, "reasons": [] }
    }
    // … one row per floor
  ]
}
```

Generated artifacts live under gitignored `tmp/` and `.artifacts/` — re-create
them anytime; do not commit.

---

## Dashboard Quality Gate (Slice 6)

The single CI-grade entry point. Runs both dashboard harnesses in order and
fails the build if either regresses — use this in CI and before opening a PR
that touches the dashboard pipeline.

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-quality-gate
```

Order + behavior:

1. **dashboard-refresh-golden** — the E2E regression scenarios (Slice 2).
2. **dashboard-calibration** — the embed-floor guardrail sweep (Slice 5); also
   writes a JSON artifact (default `.artifacts/dashboard-calibration.json`,
   override with `--json-out <path>`).

Hermetic (no provider keys / network — both cores run in-process with stubs).
Streams a `✓`/`✗` line per scenario/floor, then a SUMMARY (golden pass/fail,
calibration pass/fail, artifact path).

### Exit codes

- `0` — golden passed AND calibration guardrails held at every floor.
- `1` — either harness failed (or a runner error); failing reasons print inline.

### Ship / no-ship policy for a floor change

`DEFAULT_EMBED_MIN_SIMILARITY` stays **0.40** by default. To change it, all of:

1. **Guardrails pass at the candidate floor** — `npm run eval:dashboard-quality-gate`
   green (no fail-closed clustering, no degraded titles, Reuters present, liveblog
   collapses) at the proposed value.
2. **Manual `?debug=1` quality review** — on the think-tank persona, confirm the
   items the candidate floor *rejects* (vs admits at 0.40) are genuinely off-beat
   (or that on-beat items are being lost at 0.40). Synthetic probe metrics alone
   are not evidence.
3. **Committed evidence in the PR notes** — attach the calibration JSON artifact
   (or its table) for both 0.40 and the candidate floor, plus a one-line rationale
   tying `similarityRejected` movement to the manual review.

Absent all three, keep 0.40.

---

## Critical Hard-Fail Suite (Phase 5b)

**The release gate** for the recall / refresh / extraction stack. Eight E2E scenarios run end-to-end against the actual refresh pipeline (`runRefreshPipeline`) with injected stubs — fully hermetic, no provider keys needed.

```sh
cd 05-engineering/apps/api
npm run eval:critical
```

Exits **non-zero** if any single scenario fails. Drift / judge findings are advisory only and never gate.

### Scenarios

| ID | Intent | Must pass |
|---|---|---|
| `critical-01-china-defense-trade` | US–China + defense + trade | Relevant story surfaces |
| `critical-02-monitoring-migration-border` | Migration / border narrative | Migration item surfaces, off-topic doesn't leak |
| `critical-03-source-scoped-relevance` | Narrow selected sources | On-source surfaces, off-source filtered |
| `critical-04-empty-profile-lexical-path` | Sparse profile, lexical hits exist | Lexical-only items surface, no false strict-empty |
| `critical-05-embedding-failure-with-lexical-hits` | Embedding fails, lexical hits present | Lexical fallback fires with diagnostics |
| `critical-06-embedding-failure-without-lexical-hits` | Embedding fails, no lexical hits | Strict-empty is allowed AND explicitly diagnosed |
| `critical-07-settings-save-refresh-propagation` | Settings change → refresh reflects new beat | Different settings → different stories (API contract behind the prototype trigger) |
| `critical-08-grounding-trust-guard` | Ungrounded meta-story candidate | Story is dropped; `groundingDropReasons` populated |

### Hybrid evaluator

Per the Phase 5b policy, the suite combines **two advisory layers** on top of the hard-fail core:

1. **Deterministic pre-checks** (`buildDeterministicChecks`) — always run, no API key needed. Surfaces `_meta.recall` shape contracts, funnel ↔ recall coherence, source-id presence.
2. **Semantic judge** (`runSemanticJudge`) — **OPT-IN**, advisory only.
   ```sh
   TEMPO_CRITICAL_SUITE_JUDGE=1 npm run eval:critical
   ```
   Requires `TEMPO_ANTHROPIC_API_KEY`. Runs a Sonnet judge over the first two scenarios (China + migration), scores each on relevance / coverage / noise / source_reasonableness (0–3), and emits advisory findings. **Never gates release.**

### Warning policy (locked Phase 5b)

- Hard-fail = critical scenario failure ONLY.
- Drift signals (recall-shape, funnel ↔ recall divergence, judge scores < 2) are **warnings** — printed in the report, exit code unchanged.
- When a critical scenario fails AND advisory findings are present, the report emits a **causal correlation note** so operators can quickly see whether the drift correlates with the failure.

### When to run

- **Before opening a PR.** This is the release gate.
- After touching `refresh-pipeline.mjs`, `embedding-recall.mjs`, `onboarding-extractor.mjs`, `cluster-engine.mjs`, or the prototype's `refresh-context.tsx` / `Settings.tsx`.
- Whenever onboarding-extraction eval shows large drift — run the critical suite to confirm it's drift-only (advisory) vs. a real regression (critical scenario fails).

### Exit codes

- `0` — all 8 scenarios passed. Release gate PASS.
- `1` — at least one scenario failed (or a runner error). Release gate FAIL; PR blocked.
