# Semantic BeatFit (Option A) — runbook

Semantic intent uplift for the BeatFit precision stage. Lexical signals in the
deterministic scorer miss concept-level alignment (e.g. an "ISIS attack in
Nigeria" never lights up the configured `terrorism` keyword); the semantic
stage adds an embedding-cosine signal blended into the final BeatFit score:

```
finalBeatFit = deterministicBeatFit * 0.65 + semanticIntentScore * 0.35
```

The deterministic scorer, reason codes, rescue band, and threshold (`0.40`)
are unchanged. Semantic blending only rewrites the final score and adds
diagnostic reason codes.

## Profile construction (D-058, narrative-first)

`buildIntentProfileText(settings)` composes the intent paragraph that gets
embedded as the user-side cosine input. Segments are emitted in this fixed
order — **narrative first** — so the embedding model anchors on user intent
before the chip-list axes:

1. **Onboarding narrative** — `Beat narrative: <verbatim>` (only when non-empty)
2. **Topics** — `I monitor news about <topics, joined by ", ">.`
3. **Keywords** — `Specific topics I care about: <keywords, joined by ", ">.`
4. **Geographies** — `Geographic focus: <geos, joined by ", ">.`

Empty/missing axes drop their segment silently; the next non-empty segment
slides up but order is preserved.

**Diagnostic helpers (module exports — not yet on the runtime trace).**
`buildIntentProfileText` is paired with two exports for tests and future
diagnostics wiring:

- `PROFILE_AXIS_ORDER` — frozen array of the four axis names in emission
  order: `["narrative", "topics", "keywords", "geographies"]`.
- `profileAxisNames(settings)` — returns the subset of axis names that
  actually contributed a segment, in order. Useful as a building block for
  later observability work (e.g. surfacing `profileAxes` on
  `_meta.semanticBeatFit` or in a log line) so an operator could later
  inspect which axes composed a refresh's profile.

These exports are **not yet wired** into `_meta.semanticBeatFit` or the
pipeline log block. They exist for the unit tests in this PR and as a
deliberate seam for a follow-up diagnostics pass. Treat the runbook as
describing what the **module API** exposes, not what production traces
currently emit.

**Why narrative-first.** Text-embedding models tend to give more weight to
the leading tokens of the input, so leading with the user's narrative is
intended to increase semantic alignment for narrative-rich settings (the
WaPo Nigeria + China candidates in D-058's acceptance signal). The blend
formula is unchanged. **Quantitative impact** — cosine deltas vs. the
legacy axes-first ordering, dashboard pass/fail counts, end-to-end
precision/recall — should be validated against the frozen relevance-eval
suite ([`apps/api/src/dashboard/relevance-precision-fixtures.mjs`](../apps/api/src/dashboard/relevance-precision-fixtures.mjs)
with `npm run eval:relevance-precision`) before any tuning. This runbook
intentionally avoids hard numeric claims that aren't backed by a committed
reproducible artifact.

**Cache key invariance.** `profileCacheKey` hashes the cleaned settings
fields (sorted lower-case sets per axis + raw narrative string) — NOT the
assembled profile text. The narrative-first reorder therefore does not
invalidate cached profile embeddings for unchanged settings. A unit test
pins this invariant (`profile cache key is invariant under segment-order
changes for the same settings`).

**Scope (PR3 only).** The blend formula (`0.65 / 0.35`), the threshold
(`0.40`), and the rescue contract are intentionally unchanged. Point 6
rescue policy (D-059 + D-062: `rescue_semantic_geo`, uncapped) is a separate
PR — this runbook section describes profile shape only.

## Files

| Path | Purpose |
| --- | --- |
| `apps/api/src/dashboard/semantic-beat-fit.mjs` | New: profile + item embedding, cosine, profile cache, kill switch, diagnostics |
| `apps/api/src/dashboard/semantic-beat-fit.test.mjs` | New: unit tests for the module |
| `apps/api/src/dashboard/beat-fit-scorer.mjs` | Extended: `scoreBeatFit` accepts `semanticIntentScore` and blends; `applyBeatFitFilter` surfaces blend rollup |
| `apps/api/src/dashboard/beat-fit-scorer.test.mjs` | Extended: blend math + lift / kill / clamping coverage |
| `apps/api/src/dashboard/refresh-pipeline.mjs` | Wires the semantic stage after geo filter; surfaces `_meta.semanticBeatFit` |
| `apps/api/src/dashboard/refresh-pipeline.test.mjs` | New section: ISIS/Nigeria rescue, precision-first regression, embedding failure → deterministic-only, kill switch |
| `apps/api/src/ai/embeddings.mjs` | Extended: per-call `model` override so BeatFit can pin `text-embedding-3-large` while recall stays on `text-embedding-3-small` |
| `apps/api/src/server.mjs` | Wires `semanticBeatFitConfig` + `semanticBeatFitEmbedFn` on every pipeline run |
| `apps/api/package.json` | Adds `semantic-beat-fit.test.mjs` to the `test` script |

## Env / config flags

All flags default to safe values. Production rollout for this environment
ships with the stage **enabled by default**.

| Flag | Default | Effect |
| --- | --- | --- |
| `TEMPO_SEMANTIC_BEAT_FIT_KILL_SWITCH` | `false` | When true, forces the stage off regardless of any other flag. Instant rollback to deterministic-only. |
| `TEMPO_SEMANTIC_BEAT_FIT_ENABLED` | `true` | Global gate. False disables blending; degradation reason = `disabled_by_flag`. |
| `TEMPO_SEMANTIC_BEAT_FIT_MODEL` | `text-embedding-3-large` | Embedding model. Per-call override on `embedTexts` keeps recall on `text-embedding-3-small`. |
| `TEMPO_SEMANTIC_BEAT_FIT_TIMEOUT_MS` | `4000` | Per-batch timeout for the embedding call. Matches the initial SLO; tighten once observed latency is stable. |
| `TEMPO_SEMANTIC_BEAT_FIT_MAX_ITEMS` | `250` | Caps items embedded per refresh; bounds cost and tail latency. |
| `TEMPO_SEMANTIC_BEAT_FIT_MAX_TEXT_CHARS` | `2000` | Caps per-item canonical text length. |

`OPENAI_API_KEY` / `TEMPO_OPENAI_API_KEY` already required by recall — no
additional credential needed.

### Instant rollback

```sh
# fastest rollback — flip the kill switch in Vercel (or wherever env lives)
TEMPO_SEMANTIC_BEAT_FIT_KILL_SWITCH=true
```

On the next refresh the stage emits `degraded=true reason=kill_switch_active`
in logs, the scorer skips blending entirely, and the final score equals the
deterministic score (pre-feature behavior). No code deploy required.

## Failure semantics

The stage **never** breaks a refresh.

| Failure | Stage diagnostic reason | Result |
| --- | --- | --- |
| Kill switch on | `kill_switch_active` | All items pass through, deterministic-only |
| Global flag off | `disabled_by_flag` | All items pass through, deterministic-only |
| No `embedFn` injected | `embed_fn_unavailable` | All items pass through, deterministic-only |
| Empty profile (no topics/keywords/geo/narrative) | `empty_profile_text` | Pass-through, deterministic-only |
| Empty post-geo candidate set | (no degraded flag) | Pass-through, no work |
| Items present but all canonical texts empty | (no degraded flag) | Pass-through, `embedFn` not called |
| Provider returned empty profile vector | `empty_profile_vector` | Pass-through, deterministic-only |
| Embedding provider error | `embedding_error` | Pass-through, deterministic-only |
| Embedding timeout | `embedding_timeout` | Pass-through, deterministic-only |
| Embedding returned wrong shape | `embedding_invalid_response` | Pass-through, deterministic-only |

In every case, `_meta.semanticBeatFit.degraded` is `true` and the reason is
logged + persisted alongside the snapshot. The BeatFit log block's
`semanticBlendAppliedCount` will be `0`, and `semanticBlendMissingCount` will
equal the recall count.

## Verify locally

```sh
cd 05-engineering

# 1. Unit tests for the new module
npm --workspace=@tempo/api exec -- node --test \
  apps/api/src/dashboard/semantic-beat-fit.test.mjs

# 2. Updated BeatFit scorer tests (blend formula, lift, kill switch)
npm --workspace=@tempo/api exec -- node --test \
  apps/api/src/dashboard/beat-fit-scorer.test.mjs

# 3. Pipeline tests covering ISIS/Nigeria + precision-first + degradation
npm --workspace=@tempo/api exec -- node --test \
  apps/api/src/dashboard/refresh-pipeline.test.mjs

# 4. Full API suite
npm run test:api
```

To exercise the stage against a real provider locally:

```sh
export OPENAI_API_KEY=sk-...                              # required
export TEMPO_SEMANTIC_BEAT_FIT_ENABLED=true               # default
export TEMPO_SEMANTIC_BEAT_FIT_MODEL=text-embedding-3-large
export TEMPO_RECALL_MODE=hybrid_strict                    # so recall widens too
cd 05-engineering && npm run dev:api
# trigger a refresh via the existing dashboard route
```

## Sample log lines to inspect

```
[pipeline.semantic-beat-fit] version=semantic-beat-fit-v1 enabled=true model=text-embedding-3-large candidates=42 scored=42 skipped=0 cache_hit=false latency_ms=812 mean=0.604
```

— stage ran, embedded everything, profile-cache miss this refresh (cold).

```
[pipeline.semantic-beat-fit] version=semantic-beat-fit-v1 enabled=true model=text-embedding-3-large candidates=42 scored=42 skipped=0 cache_hit=true latency_ms=187 mean=0.604
```

— same refresh shape, profile cache hit (settings unchanged).

```
[pipeline.semantic-beat-fit] version=semantic-beat-fit-v1 enabled=true model=text-embedding-3-large candidates=42 scored=0 skipped=0 cache_hit=true latency_ms=4001 mean=n/a degraded=true reason=embedding_timeout
```

— provider slow. The refresh still completes; BeatFit silently uses
deterministic-only behavior. Tighten `TEMPO_SEMANTIC_BEAT_FIT_TIMEOUT_MS`
upward or upstream (Vercel function timeout) if this becomes frequent.

```
[pipeline.semantic-beat-fit] version=semantic-beat-fit-v1 enabled=false model=text-embedding-3-large candidates=42 scored=0 skipped=0 cache_hit=false latency_ms=0 mean=n/a degraded=true reason=kill_switch_active
```

— kill switch asserted. Sanity check it's intentional, then unflip when ready.

The BeatFit summary log line gains additional fields:

```
[pipeline.beat-fit] version=beat-fit-v1 threshold=0.4  recall=12  included=4  excluded=8  reasons=excluded_no_signal=5,excluded_low_score=3
```

— this line is unchanged; the new counters live on `_meta.beatFit`:

```
beatFit.semanticBlendEnabled                  true
beatFit.semanticBlendAppliedCount             12
beatFit.semanticBlendMissingCount             0
beatFit.semanticLiftOverThresholdCount        2     # items rescued by semantic
beatFit.semanticDropBelowThresholdCount       0     # items demoted by semantic
beatFit.excludedWithSemanticPresentCount      8     # excluded items that had a score
```

Per-item reason codes the trace may include when blending fires:

```
semantic_intent_score:0.823
semantic_intent_strong                    # score >= 0.7
semantic_intent_lift_over_threshold       # crossed threshold from below
```

## SLO + observability

- Initial latency target: **stage p95 ≤ 4 s** (matches default timeout).
- Tighten to **p95 ≤ 2 s** after 3–7 days of clean traffic.
- Distribution: read `_meta.semanticBeatFit.scoreBuckets` —
  `{ b00_20, b20_40, b40_60, b60_80, b80_100 }`. If every bucket but
  `b40_60` is empty, the stage is degenerate (likely empty profile or
  provider returning a constant vector).
- Profile-cache hit rate: `_meta.semanticBeatFit.profileCacheHit` is a single
  bool per run. Settings changes invalidate the cache (by design) — repeated
  refreshes with unchanged settings should hit consistently.
