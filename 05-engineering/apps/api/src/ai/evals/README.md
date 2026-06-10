# AI Evals

Lightweight, local eval harnesses for AI pipeline components. Version-controlled gold dataset. No Supabase. No network dependencies beyond the AI providers.

| Harness | What it measures | Run | Gates release? |
|---|---|---|---|
| **Critical hard-fail suite (Phase 5b)** | 8 E2E presence-first scenarios; deterministic + advisory hybrid layers | `npm run eval:critical` | **Yes** — non-zero exit on any critical scenario failure |
| Onboarding extraction | Per-field precision / recall / F1 / exact-match across 23 gold examples | `npm run eval:onboarding-extraction` | No — advisory, drift only |
| Cluster shape smoke (M8) | Contract-shape guard: clustering output conforms to `metaStoryOutputSchema` on a 3-item fixture | `npm run eval:cluster-smoke` | Smoke gate (non-zero on contract violation) |
| **Dashboard refresh golden (Slice 2)** | Hermetic E2E regression guard: fail-closed clustering, no degraded titles, liveblog dedupe, recall floor, healthy 2+ stories | `npm run eval:dashboard-refresh-golden` | Smoke gate (non-zero on any scenario failure) |
| **Dashboard dual-beat (recall-widening)** | Hermetic regression: one profile (Colombia elections + Kenya Ebola) surfaces BOTH beats as distinct meta-stories in one refresh; geo lexical gate admits geo-only items | `npm run eval:dashboard-dual-beat` | Smoke gate (non-zero on any assertion failure) |
| **Dashboard intra-beat split (cluster-split healer)** | Hermetic regression: same-country UNRELATED events (Colombia election + mine attack) merged by clustering get split into separate meta-stories, while a same-event pair stays merged; asserts `log.clusterSplit` diagnostics | `npm run eval:dashboard-intra-beat-split` | Smoke gate (non-zero on any assertion failure) |
| **Dashboard Spanish recall (Slice 14)** | Hermetic regression: Spanish RSS-shaped items + English settings reach the clustering pool via translation-first normalized English evidence (and do NOT without it); plus a degraded partial-translation-failure path where the refresh still completes and affected stories are marked low-confidence in `_meta.translation` | `npm run eval:dashboard-spanish-recall` | Smoke gate (non-zero on any scenario failure) |
| **Dashboard elections-Colombia (Q6B)** | Hermetic acceptance test for the relevance strategy: a 14-item Colombia-presidential-election mix (Spanish + English) surfaces the election beat over wrong-geo / wrong-beat noise — all 14 reach candidacy, explicit wrong-geo controls hard-fail, the dashboard ships ≤5 meta-stories, the overflow cap drops the generic geo-noise story, and ≥1 election meta-story is multi-source | `npm run eval:dashboard-elections-colombia` | Smoke gate (non-zero on any assertion failure); **wired into `eval:dashboard-quality-gate`** |
| **Dashboard live-cluster advisory (Q6D)** | **Live, provider-backed** clustering call over the election fixture subset to detect prompt/model drift in cluster output (B1 `tags.geographies` + `associated_entities` present, sane merge count). SKIPS (exit 0) when no provider key/config | `npm run eval:dashboard-live-cluster-advisory` | **Advisory / non-blocking** — NOT in the quality gate, NOT a PR check; exits 1 only so a scheduled job can alert owners |
| **Embed-floor calibration (Slice 5)** | Sweeps `TEMPO_EMBED_MIN_SIMILARITY` (0 / 0.35 / 0.40 / 0.45) and reports `similarityRejected` / `finalStories` / Reuters / liveblog metrics per floor | `npm run eval:dashboard-calibration` | Guardrail gate only (non-zero if fail-closed / degraded title / no Reuters / liveblog regression at any floor); floor metrics are advisory |
| **Pre-cluster weight calibration (Decision 10D)** | Sweeps candidate pre-cluster WEIGHT PRESETS (baseline = production `RELEVANCE_WEIGHTS`, plus beat-dominant / geo-heavy / freshness-heavy / flat) against a fixed synthetic fixture and reports decision-quality metrics (election survival at cap, geo-noise suppression, configured-vs-cross-country ordering, tie stability). Re-implements the composite with injectable weights — **no production weight change**. Writes a JSON artifact. | `npm run eval:dashboard-precluster-calibration` | Guardrail gate only (non-zero ONLY if the baseline preset diverges from the production scorer or violates a hard invariant; a degenerate variant failing is advisory, never a gate failure); **wired into `eval:dashboard-quality-gate`** |
| **Dashboard quality gate (Slice 6)** | CI-grade gate: runs golden + spanish-recall + elections-colombia + embed-floor calibration + pre-cluster weight calibration in one command, writes calibration JSON artifacts | `npm run eval:dashboard-quality-gate` | **Yes** — non-zero if golden fails OR spanish-recall fails OR elections-colombia fails OR embed-floor calibration guardrails regress OR the pre-cluster weight baseline regresses |
| **Dashboard embassy beat (Sprint C3)** | Hermetic golden: synthetic mixed EN/ES, multi-geo (Colombia/LatAm + Kenya/Africa style) embassy beat still produces usable output after the Sprint C cluster-reliability changes (C1 input cap + C2 JSON safe-trim repair). Minimum-presence only: `stories.length >= 1` AND `usedFallbackClustering === false`. Diagnostics retained but not gated. | `npm run eval:dashboard-embassy-beat` | Standalone smoke (non-zero on unmet criteria); **not** wired into `eval:dashboard-quality-gate` |
| **Cache-benefit advisory (Sprint D1)** | Hermetic, deterministic check of the ingestion-cache benefit window logic (`dashboard/cache-benefit-window.mjs`): cache_hit p50 >= 20% faster than live_scoped p50, cache-hit rate >= 60%, >= 5 samples/mode in a 5-run window. Synthetic run windows; **measurement + guardrails only, no runtime behavior**. | `npm run eval:cache-benefit-advisory` | **Advisory** — standalone, non-zero only if the window logic regresses; **not** wired into any blocking gate |
| **D2 narrative stability (Sprint D2)** | Hermetic failure-injection over the real pipeline: fail-closed-per-story for what-changed + why-it-matters (one retry per failing stage, then drop the story; never fail the global refresh). Asserts per-story drop, single-retry recovery, per-stage retry/drop tallies, and the >=50% retention guardrail. | `npm run eval:d2-narrative-stability` | **Advisory** — standalone, non-zero only if the D2 stability logic regresses; **not** wired into any blocking gate |
| **D3 quality advisory (Sprint D3)** | Composite orchestrator: runs the quality stack end-to-end (quality-gate + embassy-beat + cache-benefit + d2-narrative-stability), prints per-check status + duration + a final rollup, and writes a lightweight JSON artifact. Continue-all, then non-zero exit if any check failed. Changes no included eval's logic. | `npm run eval:d3-quality-advisory` | **Advisory, LOCAL-ONLY** — non-zero if any included check fails; **not** wired into CI / any blocking gate |

---

## Onboarding Extraction Evals

## What it measures

Five extracted fields evaluated set-by-set against 23 hand-labeled examples:

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

`onboarding-extraction.gold.json` — 23 examples across five buckets:

| Bucket | Count | Description |
|---|---|---|
| `clean_explicit` | 5 | Clear, specific narratives with explicit sources |
| `implicit_ambiguous` | 5 | Vague or context-dependent inputs, no explicit geography |
| `noisy_long` | 5 | Real-world messy prose with conversational noise |
| `edge_negative` | 5 | Minimal inputs, deduplication stress, empty-field cases |
| `spanish_sources` | 3 | Spanish-language narratives referencing Colombian outlets (La Silla Vacía, Semana, Infobae) |

**Field-scoped gate (`run-onboarding-extraction-eval.mjs`).** Every bucket gates strict on all five fields. Slice 13 temporarily made `spanish_sources` topics/keywords advisory (the extractor emitted Spanish terms from Spanish prose). Slice 14 normalizes topics/keywords to English at extraction time (`extract-v7`), so `spanish_sources` is now all-fields-strict like every other bucket. Gold expected values stay in **English** — geographies and source/outlet names keep their proper names.

**Q5 (`extract-v8`) — conservative extraction + deterministic canonicalization.** Extraction stays **conservative and minimal**: the prompt forbids inferred secondary topics/keywords and qualifier expansions, and the sanitizer enforces this deterministically so topic/keyword quality does not hinge on model variance:

- **Deterministic recall hints** (`deriveTopicHints` / `KEYWORD_PATTERNS`) map a clearly-stated subject to its canonical label — `election`/`elections` → `Elections`, `energy` → `Energy policy`, `customs` → `Customs policy`, `sanctions` → `Sanctions enforcement`, `humanitarian` → `Humanitarian aid`, plus Spanish surface forms (`migración`/`migratorio` → `migration` + `Migration policy`, `elecciones` → `Elections`, `seguridad` → `Security`).
- **Deterministic noise suppression** drops over-generated labels the model emits from generic nouns/qualifiers — topics like `Compliance`, `Labor disputes`, `Tariffs`, `Shipping risk`, `Organized crime` (a keyword, not a topic), and qualifier-expansion keywords like `security cooperation`, `customs delays`, `vaccine updates`, `shipping`, `shelter`. Two contextual rules: a secondary `Sanctions enforcement` is dropped when a primary domain topic (`Energy policy`/`Migration policy`) is present, and `Public health` is dropped when the more specific `Public health policy` is present.
- These are **noise denylists, not an allowlist gate** — a genuinely distinct subject still flows through open-vocabulary.

> **ex-19 gold note (Q5 canonicalization).** English text centered on elections canonicalizes to topic `Elections`, so `ex-19` expects `topics: ["Elections"]` (previously `[]`). This is the **single** intentional Q5 gold change; all other rows are unchanged.

> **ex-22 gold note (Spanish prose → topic/keyword classification).** For `ex-22` the salient terms are classified as *topics* (`["Elections", "Security"]`), not keywords. The gold encodes the stable English output so the bucket gates strictly; this is a known Spanish-prose edge case, not a relaxation to Spanish terms.

> **Known unmatchable rows (gold internal inconsistencies, ~5 examples).** A few gold rows expect mutually-incompatible behavior for identical deterministic input and cannot all pass at once: `ex-04` expects keyword `WHO` from `@WHO` while `ex-15`/`ex-20` expect NO `WHO` from the same `@WHO` context; `ex-03` expects `DHS` from `@DHSgov` while `ex-14` expects none; `ex-06` omits `migration` even though the text says "migration headlines" (which `KEYWORD_PATTERNS` always captures); `ex-10` omits the `public health` keyword that `ex-15` requires. These are accepted residual misses — fixing one breaks another — and they sit below the overall ≥70% gate.

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
| `gold-04-recall-floor` | Weak semantic-only item present | `recall.minSimilarityThreshold === 0.35`, `recall.similarityRejected >= 1`, item excluded from clustering |

### Exit codes

- `0` — all scenarios pass.
- `1` — any scenario failed (or a runner error); diagnostics print the failing reasons.

When to run: after touching `refresh-pipeline.mjs`, `source-deduper.mjs`,
`embedding-recall.mjs`, or the clustering fail-closed path.

---

## Dashboard Dual-Beat (recall-widening)

### Why this exists

The recall-widening work (geo as a shared lexical matcher + the recall geo
gate + the 0.35 embed floor) exists so a monitor watching **more than one beat**
isn't collapsed to a single dominant topic. This harness pins that contract: a
single onboarding profile covering **Colombia elections** *and* **Kenya Ebola**
must surface **both** beats as **distinct** meta-stories in one refresh — not
merged, not dropped.

It is a regression guard, not a tuning knob — it asserts pipeline *outcomes*, and
changes no runtime behavior.

### How it works (hermetic)

In-code fixtures (`dashboard-dual-beat-core.mjs`), no live RSS / Anthropic /
embeddings:

- **Persona** — `geographies: ["Colombia", "Kenya"]`, elections + Ebola keywords,
  Reuters / Washington Post sources.
- **Items** — two per beat: a *keyword* item (matches an elections/Ebola keyword)
  and a *geo-only* item (mentions the country in text but **no** keyword, so it is
  admitted **only** via the Slice 2 geo lexical gate). Plus one off-beat decoy.
- **Recall** runs in `keyword` (lexical-only) mode so the geo gate is the surface
  under test; beat-fit precision is disabled (mirrors the golden/calibration
  cores) so the run is threshold-independent.
- A beat-aware cluster stub partitions survivors by country token and emits one
  grounded meta-story per non-empty beat — if recall ever drops a beat, that
  partition is empty and only one story ships, failing the test.

### What it asserts

- `payload.stories.length >= 2`; one story owns the Colombia items, one owns the
  Kenya items, with **distinct `metaStoryId`** and **disjoint source sets** (not
  merged).
- The off-beat decoy never reaches a story.
- Recall diagnostics: `recall.topicKeywordBreakdown` present, `hasGeographies`
  true, `passCount === 4`, `neither >= 1` (decoy), and `geoLexicalOnly >= 2`
  (the two geo-only admissions — the recall-widening signal).
- `usedFallbackClustering !== true`.

### Run

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-dual-beat
```

Exit `0` when all assertions pass; `1` on any failure. Standalone (not part of
`eval:dashboard-quality-gate`).

When to run: after touching the geo lexical matcher (`geo-lexical-match.mjs`),
the recall lexical gate (`applyTopicKeywordFilter` / `analyzeTopicKeywordStage`
in `refresh-pipeline.mjs`), or anything affecting multi-beat recall.

---

## Dashboard Elections — Colombia (Q6B)

### Why this exists

The **primary acceptance test for the relevance strategy**. A single hermetic
refresh over a realistic Colombia-presidential-election news mix proves the whole
pipeline does the right thing end-to-end: it surfaces the **election beat** over
**wrong-geography** and **wrong-beat** noise, respects the fixed 5-story cap, and
keeps the election stories when the cap fires.

### How it works (hermetic)

In-code RSS-shaped fixtures (`dashboard-elections-colombia-core.mjs`) — no live
RSS / Anthropic / embedding provider. 14 fixtures: **8** Colombia
presidential-election positives (Spanish + English, multiple outlets) and **6**
negatives — a Senegal election and an Argentina film story (explicit wrong-geo),
three right-geo/wrong-beat Colombia items (tremor / traffic / coffee), and one
no-geo markets decoy. Recall runs in `keyword` (lexical) mode and beat-fit is
disabled; a deterministic injected `clusterFn` emits grounded election
meta-stories (with `tags` + `associated_entities`) plus one geo-only noise story,
forcing the overflow cap to fire.

### What it gates (maps to the locked decisions)

- **Q2 (recall / translation-first):** all 14 fixtures reach the candidate stage;
  Spanish election coverage is admitted via the configured-geo lexical gate and
  ships.
- **Geo precision (hard-fail):** the two explicit wrong-geography controls are
  dropped before clustering (`geoHardFailDroppedCount === 2`), no LLM.
- **Q3 / Q3A (cap + relevance survival):** the dashboard ships **≤5**
  meta-stories; when the clustered set overflows, the overflow cap drops the
  generic same-geography noise story and the election stories survive.
- **Q3B (corroboration / bundling):** at least one shipped election meta-story is
  multi-source.
- **Q1 / B1 (grounded tags + entities):** the injected clusters carry
  `associated_entities` + tags that feed the relevance score deciding survival.
- All wrong-region / wrong-beat controls are absent from shipped stories.

### Run

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-elections-colombia
```

Exit `0` when all assertions pass; `1` on any failure. Also runs in-process as
step **(3/4)** of `eval:dashboard-quality-gate` (fails the gate on regression).

When to run: after touching geo admission (`geo-filter.mjs` / `relevance-policy.mjs`),
the recall gate, the overflow/survival ranking, or the split healer.

---

## Dashboard Live-Cluster Advisory (Q6D)

### Why this exists

Every other dashboard eval is **hermetic** (injected `clusterFn`, no provider).
This one is the **opposite on purpose**: it makes a single **real,
provider-backed** clustering call to detect **prompt / model drift** in the live
cluster output — most importantly that the B1 grounded entity tags
(`tags.geographies` + `associated_entities` from `cluster-v4`) keep showing up.
It is **advisory and non-blocking**: it is NOT wired into
`eval:dashboard-quality-gate`, NOT a PR check, and never gates a merge. A
scheduled job runs it so owners get alerted when live output drifts.

### How it works

Clusters the 8 Colombia-election positives from the elections-colombia fixtures
(`dashboard-elections-colombia-core.mjs`) through the real `clusterItems` path
using `TEMPO_AI_CLUSTER_MODEL`, then asserts SOFT (advisory) expectations:

- story count in a sane range (1–5, the locked cap);
- merging happened (≥1 meta-story with ≥2 sources — not atomized chaos);
- `tags.geographies` present on ≥50% of stories;
- `associated_entities` present on ≥50% of stories (the B1 drift signal).

### Skip behavior (no keys ⇒ green)

When the cluster model routes to a mock provider, `TEMPO_AI_MOCK_ONLY=true`, or
the required provider key is missing, the runner prints a clear `SKIPPED` reason
and **exits 0**. A missing local key is never a failure.

### Run

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-live-cluster-advisory
```

Exit codes: `0` = SKIPPED (no live provider) **or** ran and advisory checks held;
`1` = ran and an advisory check failed (or the live call errored) — a scheduled
job treats this as "alert owners", not "block merge".

### Scheduling

A nightly non-blocking workflow runs it:
[`.github/workflows/dashboard-live-cluster-advisory.yml`](../../../../../../.github/workflows/dashboard-live-cluster-advisory.yml)
(05:25 UTC + manual dispatch). It runs only on `schedule` / `workflow_dispatch`
(never on `pull_request`), so it cannot block a merge; provide the
`TEMPO_ANTHROPIC_API_KEY` repo secret to enable live runs (absent ⇒ SKIP green).

---

## Embed-floor Calibration (Slice 5)

### Why this exists

`TEMPO_EMBED_MIN_SIMILARITY` (the recall **cosine floor** for SEMANTIC-ONLY
top-K union adds — keyword/topic hits always bypass it) ships at **0.35**.
Choosing a floor used to be guesswork. This harness sweeps candidate floors and
reports objective diagnostics per value so a default change is driven by
evidence, not vibes. It is **not** a beat-fit knob — see
[DECISIONS.md → D-063 addendum](../../../../../DECISIONS.md) ("embed floor ≠ beat-fit
threshold").

Running the sweep changes **no runtime default** — `DEFAULT_EMBED_MIN_SIMILARITY`
(0.35) in `embedding-recall.mjs` is unaffected. The sweep injects a floor per run
via `recallConfig`.

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
on the real dashboard before moving the default. **Default is 0.35; change it
only when a committed run shows systematic loss of on-beat stories at 0.35** (i.e.
relevant items rejected) — then propose a lower floor; or systematic noise
admitted at 0.35 — then propose a higher floor.

### When to run

Before proposing any change to `DEFAULT_EMBED_MIN_SIMILARITY`, and after touching
`embedding-recall.mjs` recall/union logic.

For the operator-facing tuning band (exploratory **0.35 → 0.40**), the
lexical-pass / semantic-widening / beat-fit relationship, the "floor ≠ beat-fit"
warning, and the full validation checklist (which diagnostics to read and what
"good" vs "too strict / too loose" looks like), see
[README → Recall tuning band + validation (Sprint B3)](../../../../../README.md#recall-tuning-band--validation-sprint-b3).

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
  "productionDefaultFloor": 0.35,
  "floors": [0, 0.35, 0.4, 0.45],
  "overall": { "pass": true, "hardFail": false },
  "rows": [
    {
      "floor": 0.35,
      "finalStories": 7,
      "usedFallbackClustering": false,
      "clusteringFailureReason": null,
      "keywordRecallCount": 8,
      "finalRelevant": 10,
      "similarityRejected": 1,
      "minSimilarityThreshold": 0.35,
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

The single CI-grade entry point. Runs the dashboard harnesses in order and
fails the build if any regresses — use this in CI and before opening a PR
that touches the dashboard pipeline.

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-quality-gate
```

Order + behavior:

1. **dashboard-refresh-golden** — the E2E regression scenarios (Slice 2).
2. **dashboard-spanish-recall** — the translation-first recall scenarios (Slice 14).
3. **dashboard-elections-colombia** — the Q6B relevance-strategy acceptance test.
4. **dashboard-calibration** — the embed-floor guardrail sweep (Slice 5); also
   writes a JSON artifact (default `.artifacts/dashboard-calibration.json`,
   override with `--json-out <path>`).
5. **dashboard-precluster-calibration** — the pre-cluster WEIGHT guardrail sweep
   (Decision 10D); gates only on the baseline preset (= production
   `RELEVANCE_WEIGHTS`) staying faithful to the production scorer and holding
   every hard invariant. Writes `.artifacts/dashboard-precluster-calibration.json`.

Hermetic (no provider keys / network — every core runs in-process with stubs or
fixed fixtures). Streams a `✓`/`✗` line per scenario/floor/preset, then a SUMMARY
(per-harness pass/fail + artifact paths).

### Exit codes

- `0` — golden passed AND spanish-recall passed AND elections-colombia passed AND
  embed-floor calibration guardrails held at every floor AND the pre-cluster
  weight baseline is faithful + holds every hard invariant.
- `1` — any harness failed (or a runner error); failing reasons print inline.

### Ship / no-ship policy for a floor change

`DEFAULT_EMBED_MIN_SIMILARITY` is **0.35** by default. To change it, all of:

1. **Guardrails pass at the candidate floor** — `npm run eval:dashboard-quality-gate`
   green (no fail-closed clustering, no degraded titles, Reuters present, liveblog
   collapses) at the proposed value.
2. **Manual `?debug=1` quality review** — on the think-tank persona, confirm the
   items the candidate floor *rejects* (vs admits at 0.35) are genuinely off-beat
   (or that on-beat items are being lost at 0.35). Synthetic probe metrics alone
   are not evidence.
3. **Committed evidence in the PR notes** — attach the calibration JSON artifact
   (or its table) for both 0.35 and the candidate floor, plus a one-line rationale
   tying `similarityRejected` movement to the manual review.

Absent all three, keep 0.35.

---

## Pre-cluster Weight Calibration (Decision 10D)

Evidence harness for tuning the **pre-cluster** relevance weights
(`RELEVANCE_WEIGHTS`, applied by `computePreClusterRelevanceScore`). It sweeps
candidate weight PRESETS against a fixed synthetic fixture and reports
decision-quality metrics per preset — so a future weight change is backed by data
rather than intuition. It changes **no runtime default**: the harness
re-implements the production composite with an injectable weights object and
reuses the production fit primitives, so only the weighting differs.

```sh
cd 05-engineering/apps/api
npm run eval:dashboard-precluster-calibration             # table + artifact
npm run eval:dashboard-precluster-calibration:json        # writes tmp/dashboard-precluster-calibration.json
node src/ai/evals/run-dashboard-precluster-calibration.mjs --json-out .artifacts/precluster.json
```

**Presets:** `baseline` (production weights + Decision-5C election-geo shaping),
`beat_dominant`, `geo_heavy`, `freshness_heavy`, `flat`.

**Metrics per preset:** election survival at the cap, geo-noise suppression
(leakage above the configured-geo and cross-country elections), configured-geo vs
cross-country ordering (Decision 5C), deterministic tie stability, and whether the
preset's ranking matches the production scorer.

**Guardrail semantics:** exits non-zero **only** when the `baseline` preset
diverges from the production scorer (`baselineFaithful === false`) or violates a
hard invariant — i.e. a real regression in the shipped weights. A degenerate
variant (e.g. `geo_heavy`, `freshness_heavy`) failing an invariant is the expected
signal: it is reported as `recommended: false` but never fails the run. Wired into
`eval:dashboard-quality-gate` as step 5; the artifact
(`.artifacts/dashboard-precluster-calibration.json`) is uploaded by CI.

---

## Dashboard Embassy Beat (Sprint C3)

Golden smoke that the Sprint C cluster-reliability changes — C1 deterministic
cluster input cap and C2 clustering JSON safe-trim repair — still yield usable
story output under a realistic embassy beat. Fully synthetic and deterministic:
in-code fixture (`dashboard-embassy-beat-core.mjs`), keyword recall, a
deterministic ES→EN translation stub, and a grounded cluster stub — no network,
no Anthropic, no env.

```sh
cd 05-engineering/apps/api && npm run eval:dashboard-embassy-beat
```

### Fixture

Five synthetic items: mixed EN/ES, multi-geo — Colombia (Reuters / Semana /
El Tiempo, explicit `Colombia`/`US` geographies) plus Kenya/Africa-style context
(Daily Nation / The Standard, implicit geo with Nairobi / African Union in the
text, since the geography enum is US/Colombia only).

### What it asserts (minimum presence only)

- `stories.length >= 1`
- `usedFallbackClustering === false` (clustering did not fail closed)

Rich diagnostics (cluster cap, repair flags, translation counts, funnel, story
titles/geographies) are printed for debugging but **not** gated — no outlet
representation or coverage thresholds yet.

### Exit codes

- `0` — both criteria met.
- `1` — either criterion unmet (or a runner error); unmet reasons + diagnostics print inline.

Standalone only — **not** wired into `eval:dashboard-quality-gate`.

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

---

## Cache-Benefit Advisory (Sprint D1)

### Why this exists

D1 proves the ingestion cache is actually buying us latency, with runtime
observability plus a standalone advisory eval. This harness is **measurement +
guardrails only** — it changes **no runtime policy** (no TTL, cadence, warmer
scheduling, or cache read/write behavior). It validates the pure window logic in
[`dashboard/cache-benefit-window.mjs`](../../dashboard/cache-benefit-window.mjs),
the same module the server uses to emit the live advisory.

### Locked criteria (the verdict)

A measured window **passes** only when all three hold:

1. **Success threshold** — cache-hit refresh p50 is **>= 20% faster** than
   live-scoped p50: `improvement% = (live_p50 - cache_p50) / live_p50 >= 0.20`.
2. **Extra guardrail** — cache-hit rate in the measured window is **>= 60%**.
3. **Sample floor** — at least **5 runs per mode** in the comparison window.

**Comparison window:** median of the **last 5 runs per mode** (`cache_hit` vs
`live_scoped`). Full-manifest `live` fetches are non-comparable and excluded.
The **hit-rate window** is the most recent `2 × 5 = 10` comparable runs, so it
reflects the real arrival mix rather than the balanced per-mode medians.

### How to run

```sh
cd 05-engineering/apps/api
npm run eval:cache-benefit-advisory
```

Fully synthetic + deterministic — no network, no LLM, no env, no Supabase. Each
scenario feeds a fixed chronological run window through `computeCacheBenefit` and
asserts the verdict (`ok` + reason codes) matches the locked expectation.

### Scenarios

| ID | Intent | Expected verdict |
|---|---|---|
| `headline-healthy-pass` | Representative healthy window: cache ~2× faster, cache-heavy traffic | **PASS** (proof the criteria are met on realistic data) |
| `improvement-below-threshold` | Cache only ~9% faster | FAIL — `improvement_below_threshold` |
| `hit-rate-below-threshold` | Cache fast but recent traffic live-heavy (50%) | FAIL — `hit_rate_below_threshold` |
| `insufficient-sample` | Only 3 runs per mode | FAIL — `insufficient_sample` |

Reason codes: `insufficient_sample`, `improvement_below_threshold`,
`improvement_unmeasurable` (live p50 = 0), `hit_rate_below_threshold`.

### Exit codes

- `0` — every scenario produced its expected verdict (the window logic is intact).
- `1` — a scenario diverged from expectation (the measurement logic regressed);
  the failing scenario + mismatch print inline.

**Advisory by intent (hybrid):** advisory now, path to blocking later. This
runner is standalone and is **not** wired into `eval:dashboard-quality-gate` or
any other blocking gate. Per the locked promotion rule, recommend advisory →
blocking only after **1 consecutive week of stable pass in preview**.

### Runtime surface (where the live numbers come from)

On every refresh settle, the server (`emitRefreshObservability` in `server.mjs`)
classifies the run (`cache_hit` / `live_scoped`), records its `pipelineMs` into a
bounded in-memory window, and emits:

```
[cache.benefit.window] {"userId":"…","runMode":"cache_hit","ok":true,"improvementPct":0.57,"hitRate":0.6,"cacheP50":182,"liveP50":425,"samples":{…},"reasonCodes":[]}
```

The same verdict is attached additively to the refresh response under
`_meta.cacheBenefit` (both the full-run and watermark-skip branches). It is
observability only — it never gates the response or alters cache behavior. The
in-memory window is per-process and non-authoritative (it resets on restart);
the eval is the deterministic, reproducible surface for the criteria.

### When to run

- After touching `dashboard/cache-benefit-window.mjs` or the
  `emitRefreshObservability` wiring in `server.mjs`.
- Before proposing the advisory → blocking promotion.

---

## D2 Narrative Stability (Sprint D2)

### Why this exists

D2 hardens the two post-clustering narrative stages — **what-changed** and
**why-it-matters** — against transient generation failures with a
**fail-closed-per-story** policy. Before D2 both stages were fail-open (a failed
writer shipped degraded/fallback copy). After D2:

1. **Fail-closed per story** — a stage that cannot produce content for a story
   drops only that story; the global refresh still succeeds (the other stories
   ship).
2. **One retry per failing stage** — a failing stage is retried exactly once;
   if it still fails, the story is dropped.
3. **Silent drop** — no user-facing notice or new UX messaging for a dropped
   story (additive operator diagnostics only).

The runtime policy lives in
[`dashboard/narrative-stability.mjs`](../../dashboard/narrative-stability.mjs)
(failure predicates + the single-retry helper) and the per-story drop +
`log.narrativeStability` rollup in `refresh-pipeline.mjs`. **No timeout values
were changed.**

The failure trigger is deliberately NARROW — only transient *execution* failures
drop a story:
- what-changed: a failed **write** call (`llmFailed.write`). Classify failures
  and hallucination-guard hits still degrade gracefully to "unchanged" copy.
- why-it-matters: transport fallbacks (`write_failed` / `rewrite_failed` /
  `resolver_threw`). Config fallbacks (`disabled` / `mock_only` /
  `force_writer_fail`) and content-validation fallbacks
  (`rewrite_validation_failed`) are NOT drops.

So healthy, default-off, and validation paths behave exactly as before.

### How to run

```sh
cd 05-engineering/apps/api
npm run eval:d2-narrative-stability
```

Hermetic: runs the **real** `runRefreshPipeline` with controlled per-story
failures injected via the `resolveWhatChangedFn` / `resolveWhyItMattersFn` test
seams (so the eval exercises the actual retry/drop orchestration, not a copy of
it). No network, no LLM, no env.

### Scenarios

| ID | Intent | Expected |
|---|---|---|
| `what-changed-persistent-drop` | what-changed write fails persistently for 1/4 | 1 dropped after retry, 3 survive (75%) — guardrail PASS |
| `why-persistent-drop-boundary` | why fails persistently for 2/4 | 2 dropped, 2 survive (50%) — guardrail boundary PASS |
| `both-stages-mixed-drop` | what-changed drops 1, why drops 1 (different stories) | 2 survive (50%) — guardrail PASS |
| `single-retry-recovery` | transient failures recover on the single retry | 0 drops, all 4 survive, retries counted |
| `retention-guardrail-breach-detected` | 3/4 fail | only 1 survives (25%) — guardrail correctly **FLAGS** the breach, global refresh still succeeds |

Each scenario asserts the published survivor set, the per-stage retry/drop
tallies on `log.narrativeStability`, and the `>= 50%` retention guardrail
verdict (locked decision #5).

### Exit codes

- `0` — every scenario matched the locked fail-closed-per-story behavior.
- `1` — a scenario diverged (the D2 stability logic regressed); the failing
  scenario + mismatch print inline.

### Rollout posture — advisory, with a path to blocking

This eval is **advisory** (locked decision #7): standalone, **not** wired into
`eval:dashboard-quality-gate` or any other blocking gate. The runtime
fail-closed behavior itself is active; the *eval* is what stays advisory for now.

**To promote this eval to blocking later**, all of:

1. **Stable green in preview** — the eval passes for **1 consecutive week** of
   preview runs with no flakiness.
2. **Runtime retention telemetry** — `log.narrativeStability.retentionRate` from
   real refreshes is durably aggregated (not just the per-process value) and
   sits comfortably above the 50% floor in production traffic, confirming drops
   are rare and the guardrail is not chronically near breach.
3. **Wire into the gate** — add `eval:d2-narrative-stability` to
   `run-dashboard-quality-gate.mjs` (or CI) as a hard-fail step, and document the
   block threshold (e.g. fail the build if any scenario regresses, or if a
   real-traffic window dips below the retention floor).

Absent (1) and (2), keep it advisory.

### When to run

- After touching `dashboard/narrative-stability.mjs`, the what-changed/why
  stages in `refresh-pipeline.mjs`, or either engine
  (`what-changed-engine.mjs` / `why-this-matters-engine.mjs`).
- Before proposing the advisory → blocking promotion.

---

## D3 Quality Advisory (Sprint D3)

### Why this exists

A single **local-only** command that runs the quality stack end-to-end and gives
one scannable rollup — so a developer can sanity-check the whole guardrail set
before opening a PR without remembering four separate commands. It is a
**balanced composite advisory**: it orchestrates existing runners (changing none
of their logic), captures per-check status + duration, and exits non-zero if any
check failed — but only **after running all of them** (continue-all).

### How to run

```sh
cd 05-engineering/apps/api
npm run eval:d3-quality-advisory
# optional custom artifact path:
node src/ai/evals/run-d3-quality-advisory.mjs --json-out .artifacts/d3.json
```

### Included checks (in order)

| # | id | Command | What it covers |
|---|---|---|---|
| 1 | `dashboard-quality-gate` | `node src/ai/evals/run-dashboard-quality-gate.mjs` | Golden + spanish-recall + calibration guardrails |
| 2 | `dashboard-embassy-beat` | `node src/ai/evals/run-dashboard-embassy-beat.mjs` | C3 mixed EN/ES multi-geo presence smoke |
| 3 | `cache-benefit-advisory` | `node src/ai/evals/run-cache-benefit-advisory.mjs` | D1 ingestion-cache benefit window logic |
| 4 | `d2-narrative-stability` | `node src/ai/evals/run-d2-narrative-stability.mjs` | D2 fail-closed-per-story narrative stability |

Each check runs as its own child process; a failing check prints its exit code
and a short tail of its output, and the run **continues** to the next check.

### Output (sample)

```
✓ dashboard-quality-gate   PASS  (128ms)  [node src/ai/evals/run-dashboard-quality-gate.mjs]
✓ dashboard-embassy-beat   PASS  (77ms)   [node src/ai/evals/run-dashboard-embassy-beat.mjs]
✓ cache-benefit-advisory   PASS  (31ms)   [node src/ai/evals/run-cache-benefit-advisory.mjs]
✓ d2-narrative-stability   PASS  (74ms)   [node src/ai/evals/run-d2-narrative-stability.mjs]
────────────────────────────────────────────────────────────────────────
ROLLUP: 4/4 checks passed — OVERALL PASS
artifact: …/.artifacts/d3-quality-advisory.json
```

### JSON artifact

Written to `.artifacts/d3-quality-advisory.json` by default (override with
`--json-out <path>`). Both `.artifacts/` and `tmp/` are gitignored — re-create
anytime; do not commit. The artifact is **lightweight** (status + duration per
check + overall status; **no raw logs**):

```jsonc
{
  "schemaVersion": "d3-quality-advisory-v1",
  "startedAt": "2026-05-31T…Z",
  "finishedAt": "2026-05-31T…Z",
  "overallOk": true,
  "checks": [
    { "id": "dashboard-quality-gate", "command": "node src/ai/evals/run-dashboard-quality-gate.mjs", "ok": true, "durationMs": 128 },
    { "id": "dashboard-embassy-beat", "command": "node src/ai/evals/run-dashboard-embassy-beat.mjs", "ok": true, "durationMs": 77 },
    { "id": "cache-benefit-advisory", "command": "node src/ai/evals/run-cache-benefit-advisory.mjs", "ok": true, "durationMs": 31 },
    { "id": "d2-narrative-stability", "command": "node src/ai/evals/run-d2-narrative-stability.mjs", "ok": true, "durationMs": 74 }
  ]
}
```

### Exit codes

- `0` — all four checks passed.
- `1` — at least one check failed (reported **after** all checks ran).

### Rollout posture — local-only

This command is **LOCAL-ONLY** (locked decision #4). It is intentionally **not**
wired into CI or any blocking quality gate in this slice — it composes the other
advisories without changing their (already advisory) posture. CI wiring is a
deliberate future step, not part of D3.

### When to run

- Before opening a PR that touches the dashboard pipeline, the narrative stages,
  or the ingestion cache — as a one-command local sanity sweep.
