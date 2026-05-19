# What-changed delta engine — handoff

PR handoff + operator runbook for the 3-state `whatChanged` engine. Full contract: [`what-changed-spec.md`](what-changed-spec.md). Decision rationale: [D-065](../DECISIONS.md).

## What shipped

- **3-state `story.whatChanged`** values produced inside `runRefreshPipeline`:
  - `first-seen` → `First appearance in your feed.`
  - `unchanged` → `No material update since your last refresh.`
  - `changed` → 1–2 sentences of writer-generated prose (LLM stages only).
- **Deterministic structural gate** (always runs) over sources / outlets / headlines / summary / subtitle. Reorder, freshness ticks, syndication duplicates, and tag-only changes are filtered out before any LLM call.
- **Optional Haiku classify + Sonnet write** for weak/strong gate signals, gated by `TEMPO_AI_DELTA_ENABLED`. Fail-closed everywhere — any timeout, length overflow, or hallucination-guard trip falls back to the static unchanged copy.
- **Ever-seen persistence** at `_everSeenMetaStoryIds` on the snapshot payload (stripped from client responses). Drives the first-seen branch without a new Postgres table.
- **Run-level diagnostics** on `log.whatChanged` → `_lastRunMeta.whatChanged` → `_meta.whatChanged` (schemaVersion `whatchanged-v1`). One log line per refresh: `[pipeline.whatChanged] …`.
- **Legacy freshness template removed** from `buildStory` — `git grep "Latest update.*min ago"` returns zero hits in `refresh-pipeline.mjs`. The pipeline always sets `whatChanged` via the engine before returning.

## Env flags

| Flag | Default | Purpose |
|------|---------|---------|
| `TEMPO_AI_DELTA_ENABLED` | `false` | Global gate. Truthy = `"true"` / `"1"` case-insensitive. Off → deterministic gate only, no LLM. |
| `TEMPO_AI_DELTA_CLASSIFY_MODEL` | `anthropic:claude-haiku-4-5-20251001` | Haiku classify SKU. |
| `TEMPO_AI_DELTA_WRITE_MODEL` | `anthropic:claude-sonnet-4-6` | Sonnet write SKU. |
| `TEMPO_AI_DELTA_TIMEOUT_MS` | `2500` | Per-call timeout shared by classify and write. |
| `TEMPO_AI_MOCK_ONLY` | (unset) | When `"true"`, **vetoes the LLM path** regardless of `DELTA_ENABLED`. |
| `TEMPO_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`) | (unset) | Required when delta LLM is enabled. |

## Verify locally

```bash
# Run the API suite — every what-changed test must pass.
cd 05-engineering/apps/api && npm test
#   What-changed test files:
#     src/dashboard/what-changed-engine.test.mjs       (gate + LLM unit tests)
#     src/dashboard/refresh-pipeline.test.mjs          (Phase 4 integration block)
#     src/server.routes.test.mjs                       (watermark + refresh-persist E2E)
#     src/db/dashboard-snapshot-repo.test.mjs          (ever-seen + lastRunMeta lift)

# Regression guards — both must return zero hits.
git grep "Latest update.*min ago" -- 05-engineering/apps/api/src/dashboard/refresh-pipeline.mjs
git grep "Specification only" -- 05-engineering/docs/what-changed-spec.md
```

A fresh refresh against any fixture should ship stories whose `whatChanged` is one of the two static strings — never the legacy freshness template.

## Enable LLM in staging

1. **Confirm Anthropic key in env.** `TEMPO_ANTHROPIC_API_KEY=…` (or `ANTHROPIC_API_KEY=…`) is set for the API process.
2. **Disable mock-only.** Make sure `TEMPO_AI_MOCK_ONLY` is unset or not `"true"`. Mock-only **vetoes the LLM path**.
3. **Flip the flag.** `TEMPO_AI_DELTA_ENABLED=true` (or `=1`). Restart the API.
4. **Trigger a refresh** on a user with at least one prior snapshot. Without a prior snapshot every story resolves to `first-seen` and the LLM stages stay skipped — that's expected, not a misconfiguration.
5. **Read counters.** `GET /api/dashboard` → `_meta.whatChanged`. Watch:
   - `classifyCalled` > 0 on subsequent refreshes that surface weak/strong gate signals.
   - `writeOk` increments when Haiku confirms material.
   - `llmFailed.{classify,write,hallucination}` should stay low — high values mean tighten the timeout or revisit prompts.
6. **Rollback** is a single env flip: `TEMPO_AI_DELTA_ENABLED=false`, then restart. Next refresh emits only first-seen / unchanged. No code change, no migration.

## `_meta.whatChanged` counters at a glance

| Counter | What it means |
|---------|---------------|
| `schemaVersion` | `whatchanged-v1` — bump signals a contract change. |
| `firstSeen` / `unchanged` / `changed` | Per-story **state** counts (what the user saw). |
| `gateStrong` / `gateWeak` / `gateNone` | Per-story **structural gate** counts. First-seen stories are also counted in `gateNone` (state vs gate overlap is intentional — see spec §9). |
| `classifySkipped` | gate=none, engine disabled, or mock-only. |
| `classifyCalled` / `classifyMaterialTrue` / `classifyMaterialFalse` | Haiku invocations + verdicts. |
| `writeCalled` / `writeOk` | Sonnet invocations + successful prose. |
| `llmFailed.classify` / `.write` / `.hallucination` | Failure modes. `hallucination` = guard caught an outlet not in the diff. |
| `latencyMs.classify` / `.write` | Cumulative per-refresh latency (sums per-story). |
| `watermarkShortCircuited` | `true` when the pipeline skipped via watermark match — prior snapshot's `whatChanged` strings were re-served verbatim. |
| `everSeenCount` / `priorStoryCount` | Pass-through pipeline priors (sanity check that the route fed the engine). |

## Known MVP limits

- **Re-entry resolves to `unchanged`.** A story that was on a prior dashboard, dropped off for a refresh, and reappears is treated as `unchanged` (gate has no prior story to diff against). Acceptable false-negative; rebuilding from a deeper history is a fast-follow.
- **Pre-lock vs post-lock asymmetry.** Engine runs against pre-lock current stories but compares against the lock-applied prior snapshot. Worst case: a locked title masking drift fires a weak `title_change` / `subtitle_change`, which Haiku can reject. One extra classify call in the worst case.
- **Serial LLM loop.** Per-story, in order. Worst-case enabled latency = `N × (Haiku + Sonnet)` for `N` shipped stories. Typical dashboard size keeps this small; revisit if a refresh becomes latency-bound.
- **Hallucination guard is heuristic.** Small known-outlet vocabulary catches the writer naming outlets not in the diff. Outlets outside the vocabulary slip through; spec §6 calls this "start simple". Telemetry-driven additions are the planned follow-up.
- **`/api/ai/models` readiness** does NOT yet report delta capabilities — see "Operator notes" in spec §6.

## Suggested PR

**Title:** `feat(api): 3-state what-changed delta engine (default off, gate + optional Haiku/Sonnet)`

**Summary (paste into PR body):**

- Replaces `story.whatChanged`'s freshness template with a 3-state delta engine (`first-seen` / `unchanged` / `changed`): always-on deterministic gate plus optional Haiku classify + Sonnet write behind `TEMPO_AI_DELTA_ENABLED`. Default off — production refreshes still ship only deterministic copy until per-environment opt-in. Fail-closed to `unchanged` on any LLM error, timeout, length overflow, or hallucination-guard trip.
- Adds `_everSeenMetaStoryIds` to the snapshot blob to drive first-seen (no Postgres migration), plus run-level diagnostics on `log.whatChanged` / `_meta.whatChanged` (schemaVersion `whatchanged-v1`).
- Spec, ops notes, env example, DECISIONS [D-065](../DECISIONS.md), and full §10 test-scenario coverage included. Rollback is a single env flip (`TEMPO_AI_DELTA_ENABLED=false`).
