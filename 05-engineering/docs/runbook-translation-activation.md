# Translation activation — runbook (Sprint B1)

Production + preview activation of translation-first evidence normalization
(ES→EN). Non-English source evidence (starting with Spanish) is translated to
English **post-geo, pre-recall** so it is fairly considered in recall,
clustering, grounding, and downstream story interpretation.

**Posture (Sprint B1, locked):** translation is **ENABLED in BOTH preview and
production now**, under controlled monitoring. This is intentional —
multilingual handling is core product behavior, not optional. The Spanish feeds
(La Silla Vacía, Semana, Infobae — 6 feeds, `active=true`, `lang=es`) are live
in `source-feeds.json`, so refreshes now carry real `lang=es` items to
translate. **Rollback is instant and env-only** (see [Rollback](#4-rollback-env-only)).

## What is wired

- `src/ai/openai-translator.mjs` — production `translateFn`: a small/cheap
  OpenAI chat-completions call (`TEMPO_TRANSLATION_MODEL`, default
  `gpt-4o-mini`) over `TEMPO_OPENAI_API_KEY` plumbing.
- `server.mjs` (`_refreshPipeline.run`) — injects that fn into the refresh
  pipeline via `resolveProductionTranslateFn()`. An explicitly injected
  `translateFn` (tests/evals) always wins.
- The translation stage itself (`ingestion/evidence-translator.mjs`) is
  bounded — bounded concurrency, per-item timeout, **fail-open**.

## Locked decisions

| Decision | Value |
| --- | --- |
| Rollout | preview **and** production enabled now (controlled monitoring) |
| Provider / model | OpenAI small/cheap (`gpt-4o-mini` default) |
| Enable flag (both envs) | `TEMPO_TRANSLATION_ENABLED=true` |
| Failure posture | fail-open (untranslated passthrough; never blocks a refresh) |
| Guardrails | monitor `[pipeline.translation]` + refresh diagnostics per checklist below |
| Rollback | instant, env-only: `TEMPO_TRANSLATION_ENABLED=false` |

## No-op safety

Even with the flag on, the stage stays a pass-through (zero behavior change)
whenever **any** of:

- `TEMPO_TRANSLATION_ENABLED` is unset/false (the stage's own gate), or
- `resolveProductionTranslateFn()` returns `null` — i.e. `TEMPO_AI_MOCK_ONLY=true`
  or no `TEMPO_OPENAI_API_KEY`, or
- there are no non-English (`lang != en*`) items in the pool.

So a missing key or mock-only box behaves like translation-off rather than
failing a refresh.

## Operator steps

### 1. Activation (preview + production)

In **both** the preview and production environments:

```
TEMPO_TRANSLATION_ENABLED=true
TEMPO_OPENAI_API_KEY=<key>          # already set if Whisper/embeddings live
# TEMPO_TRANSLATION_MODEL=gpt-4o-mini    # optional override (default)
# TEMPO_TRANSLATION_CONCURRENCY=4        # optional; default 4, clamped 1–8
# TEMPO_TRANSLATION_TIMEOUT_MS=8000      # optional; per-item fail-open timeout
```

Redeploy (or restart) each environment and trigger a refresh.

### 2. Runtime verification checklist (run post-deploy in each env)

Read the `[pipeline.translation]` log line on a refresh. With Spanish feeds
active you should see real activity:

- **Flag is live** — confirm `enabled=true`:
  ```
  grep "\[pipeline.translation\]" <logs> | grep "enabled=true"
  ```
- **Meaningful translated activity on Spanish items** — when `lang=es` items
  are present, confirm `needed>0` and `translated>0`:
  ```
  grep "\[pipeline.translation\]" <logs> | tail -1
  # expect e.g. enabled=true needed=3 translated=3 failed=0 timeouts=0
  ```
  `needed=0 translated=0` only when a given refresh carried no non-English
  items (e.g. nothing new from the Spanish feeds that cycle).
- **Track failures/timeouts** — `failed`/`timeouts` should stay near zero and
  `fallback_rate` low across repeated refreshes; a one-off fail-open is fine, a
  sustained pattern is the signal to investigate (or roll back):
  ```
  grep "\[pipeline.translation\]" <logs> | grep -E "timeouts=[1-9]|failed=[1-9]|fallback_rate=(0\.[5-9]|1)"
  # ^ sustained hits here warrant investigation / rollback
  ```
- **Cost/latency** — `p50_ms` / `p95_ms` on the same line should sit within
  expectation for the chosen model.

Also confirm the broader refresh stayed healthy (translation must not degrade
the rest of the pipeline). On the same refresh, check:

- `usedFallbackClustering` (`_meta.usedFallbackClustering`) — should be `false`;
  `true` means clustering failed and 0 stories shipped (independent of
  translation, but verify the refresh that introduced translation didn't
  coincide with a clustering failure).
- `pipelineMs` (`_meta.timings.pipelineMs`) — the outer refresh envelope;
  confirm it stayed within SLO after adding the translation stage.
- `geoLane2DeferredCount` (`_meta.geoLane2DeferredCount` / the `[pipeline.geo]`
  `lane2_deferred=` field) — translation runs after geo; a spike here means the
  geo stage is shedding load and fewer items reach translation/recall.
- translation diagnostics on `_meta.translation` — per-run coverage plus
  per-story translated-source coverage (a story is full-confidence at ≥60%
  translated-source coverage; below that it is flagged degraded — never
  hard-blocked).

Local eval gates (must stay green — run from `05-engineering/apps/api`):

```
npm run eval:dashboard-spanish-recall
npm run eval:dashboard-quality-gate
```

### 3. Healthy steady state

Translation is considered healthy in an environment when ALL hold:

1. Both evals above pass.
2. `[pipeline.translation]` shows `enabled=true` with translated activity on
   Spanish items (when present) and no sustained timeout/error spike across
   several refreshes.
3. `usedFallbackClustering=false`, `pipelineMs` within SLO, and
   `geoLane2DeferredCount` not spiking.
4. Cost/latency (`p50_ms` / `p95_ms`) within expectation for the model.

### 4. Rollback (env-only)

Env-only rollback (no code change): flip the flag in the affected environment,
then redeploy/restart that environment so the new setting is applied:

```
TEMPO_TRANSLATION_ENABLED=false
```

The stage reverts to a no-op pass-through (English-only posture) on the next
refresh after redeploy/restart. No code change, no data migration. Roll back the moment translation
failures/timeouts sustain, costs exceed expectation, or the broader refresh
regresses — then investigate with the flag off.
