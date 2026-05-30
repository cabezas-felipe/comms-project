# Translation activation — runbook (Phase 4 Pre-slice S0)

Production activation of translation-first evidence normalization (ES→EN),
ahead of Spanish publisher activation. This pre-slice wires the **runtime** only
— it adds **no feeds**. Spanish feeds remain inactive in `source-feeds.json`
until a later slice, so with the current pool every refresh is still a no-op
(no `lang != en*` items to translate).

## What this wires

- `src/ai/openai-translator.mjs` — production `translateFn`: a small/cheap
  OpenAI chat-completions call (`TEMPO_TRANSLATION_MODEL`, default
  `gpt-4o-mini`) over `TEMPO_OPENAI_API_KEY` plumbing.
- `server.mjs` (`_refreshPipeline.run`) — injects that fn into the refresh
  pipeline via `resolveProductionTranslateFn()`. An explicitly injected
  `translateFn` (tests/evals) always wins.
- The translation stage itself (`ingestion/evidence-translator.mjs`) is
  unchanged — bounded concurrency, per-item timeout, **fail-open**.

## Locked decisions

| Decision | Value |
| --- | --- |
| Rollout | preview-first, then production |
| Provider / model | OpenAI small/cheap (`gpt-4o-mini` default) |
| Preview flag | `TEMPO_TRANSLATION_ENABLED=true` |
| Production flag | stays OFF until burn-in passes |
| Failure posture | fail-open (untranslated passthrough; never blocks a refresh) |
| Burn-in gate | practical: evals green + stable preview logs |
| Rollback | env-only: `TEMPO_TRANSLATION_ENABLED=false` |

## No-op safety

The stage stays a pass-through (zero behavior change) whenever **any** of:

- `TEMPO_TRANSLATION_ENABLED` is unset/false (the stage's own gate), or
- `resolveProductionTranslateFn()` returns `null` — i.e. `TEMPO_AI_MOCK_ONLY=true`
  or no `TEMPO_OPENAI_API_KEY`, or
- there are no non-English (`lang != en*`) items in the pool.

So shipping this fn dark (flag off) is safe; flipping the flag with no Spanish
feeds is also safe.

## Operator steps

### 1. Preview enablement

In the **preview** environment only:

```
TEMPO_TRANSLATION_ENABLED=true
TEMPO_OPENAI_API_KEY=<key>          # already set if Whisper/embeddings live
# TEMPO_TRANSLATION_MODEL=gpt-4o-mini   # optional override
```

Leave production `TEMPO_TRANSLATION_ENABLED` **OFF**. Redeploy preview, trigger
a refresh.

### 2. Burn-in checklist (run post-deploy in preview)

Read the `[pipeline.translation]` log line on a refresh:

- **Flag is live** — confirm `enabled=true`:
  ```
  # in preview logs
  grep "\[pipeline.translation\]" <preview-logs> | grep "enabled=true"
  ```
- **Non-zero translated activity on Spanish items** — once Spanish feeds exist
  (or via a preview fixture), confirm `needed>0` and `translated>0`:
  ```
  grep "\[pipeline.translation\]" <preview-logs> | tail -1
  # expect e.g. needed=3 translated=3 failed=0 timeouts=0
  ```
  With no Spanish feeds yet this reads `needed=0 translated=0` — expected;
  the runtime is wired but idle.
- **No sustained timeout/error spike** — `failed`/`timeouts` should stay near
  zero and `fallback_rate` low across repeated refreshes; a one-off fail-open
  is fine, a sustained pattern is not:
  ```
  grep "\[pipeline.translation\]" <preview-logs> | grep -E "timeouts=[1-9]|fallback_rate=(0\.[5-9]|1)"
  # ^ any sustained hits here block promotion
  ```

Local eval gates (must stay green — run from `05-engineering/apps/api`):

```
npm run eval:dashboard-spanish-recall
npm run eval:dashboard-quality-gate
```

### 3. Promote-to-prod criteria

Promote (set production `TEMPO_TRANSLATION_ENABLED=true`) only when ALL hold:

1. Both evals above pass.
2. Preview `[pipeline.translation]` shows `enabled=true` with translated
   activity on Spanish items (when present) and no sustained timeout/error
   spike across several refreshes.
3. Cost/latency (`p50_ms` / `p95_ms` on the log line) within expectation for
   the chosen model.

### 4. Rollback (env-only)

Instant, no redeploy of logic — flip the flag in the affected environment:

```
TEMPO_TRANSLATION_ENABLED=false
```

The stage reverts to a no-op pass-through on the next refresh (English-only
posture). No code change, no data migration.
