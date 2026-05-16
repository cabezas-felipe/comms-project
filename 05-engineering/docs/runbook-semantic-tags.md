# Runbook: semantic tag rollout

Operator-facing companion to the spec ([dashboard-story-pool-spec.md](dashboard-story-pool-spec.md)) and walkthrough ([dashboard-story-pool-walkthrough.md](dashboard-story-pool-walkthrough.md)). This document is what you read in an incident or before flipping a flag.

Scope: Phase 4 / 5 / 7 semantic tagging (topics + keywords) only. Geographies remain deterministic-only across all rollout states — there is no semantic-geo path to manage.

---

## Flag precedence (read top to bottom)

The runtime evaluates flags in this order. Earlier rows override later rows.

1. **`TEMPO_TAG_SEMANTIC_KILL_SWITCH`** — when `true`, forces every per-axis flag to `disabled` regardless of all other configuration. This is the hardware-style cut-off. Operators flip this to immediately disable semantic uplift without a deploy. `_meta.tags.killSwitchActive` reflects the value.
2. **`TEMPO_TAG_SEMANTIC_MAPPING_ENABLED`** — global gate. When `false` (default), every per-axis flag is forced off regardless of its own value.
3. **`TEMPO_TAG_SEMANTIC_TOPICS_ENABLED`** — per-axis gate for topics. AND-folded with the global flag.
4. **`TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED`** — per-axis gate for keywords. AND-folded with the global flag.

Thresholds and runtime knobs (do not change global on/off):

- `TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD` — `[0,1]`, default `0.75`.
- `TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD` — `[0,1]`, default `0.75`.
- `TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS` — per-scorer-call timeout, default `1500`.
- `TEMPO_TAG_SEMANTIC_MAX_EVIDENCE_CHARS` — evidence text cap before embedding, default `4000`.

Debug endpoint gate (separate, independent of the rollout flags):

- `TEMPO_DEBUG_TAGS_ENABLED` — when `true` AND `NODE_ENV !== "production"`, enables `GET /api/_debug/dashboard-tags`. Both gates required.

---

## Staged rollout procedure

### Stage 0 — staging wiring smoke (no uplift)

Goal: prove the production scorer is wired and reachable; no behavior change.

1. Set `TEMPO_TAG_SEMANTIC_MAPPING_ENABLED=true` in staging.
2. Leave both per-axis flags OFF.
3. Trigger a refresh (any user).
4. Read `_meta.tags.{topics,keywords}.runtimeState` via [`/api/_debug/dashboard-tags`](../apps/api/src/server.mjs) (or the persisted snapshot). Expected: `"disabled"` on both axes — global flag is on, but per-axis flags being off keep the axes disabled at the mapper level.
5. Confirm `_meta.tags.schemaVersion === "phase7-2026-05-16"` (or the current pinned version).

### Stage 1 — staging calibration

Goal: pick thresholds before any axis ships uplift.

1. Capture 2-3 real meta-stories' evidence text and curate "should accept" / "should reject" pairs into [`semantic-tag-calibration-fixtures.json`](../apps/api/scripts/semantic-tag-calibration-fixtures.json) extending the bundled set.
2. Run: `node scripts/semantic-tag-calibration.mjs --provider=embeddings`. Read precision / recall / F1 per axis.
3. Adopt the recommended thresholds for `TEMPO_TAG_SEMANTIC_TOPICS_THRESHOLD` / `TEMPO_TAG_SEMANTIC_KEYWORDS_THRESHOLD`.

### Stage 2 — staging: topics on

Goal: validate topic uplift against real traffic.

1. Set `TEMPO_TAG_SEMANTIC_TOPICS_ENABLED=true`.
2. Refresh as a real user. Inspect `_meta.tags.topics`:
   - `runtimeState=enabled_scorer_ready` → healthy.
   - `acceptedCount > 0` and `belowThresholdCount` proportional → semantic widening is firing.
   - `fallbackReasonCounts.{timeout,error} === 0` → no provider degradation.
   - `scorerLatencyMaxMs` well under `TEMPO_TAG_SEMANTIC_SCORER_TIMEOUT_MS`.
3. Eyeball UI: chip labels still settings vocabulary, no noise.

### Stage 3 — staging: keywords on

Same procedure as Stage 2 for `TEMPO_TAG_SEMANTIC_KEYWORDS_ENABLED=true`. Keywords are more precision-sensitive (a bad chip on the scan row is visible); err toward a higher threshold here.

### Stage 4 — telemetry-driven retune

After 1 week of stable Stage 3:

1. Capture `_meta.tags` snapshots from production runs into a JSON file (array of run-meta objects).
2. Run: `node scripts/semantic-tag-calibration.mjs --telemetry=<file.json>`. Read the per-axis advisory.
3. If advised to RAISE or LOWER, edit the threshold env var and redeploy. Do NOT change both axes in one deploy — keep changes single-axis so you can attribute drift.

### Stage 5 — production promotion

Repeat Stages 0–3 in production. Roll back to the prior stage at any time by setting the relevant flag to `false` (no deploy needed).

---

## Diagnostic surfaces

### `_meta.tags` (persisted on every refresh)

Phase 7 schema (`schemaVersion: "phase7-2026-05-16"`):

```jsonc
{
  "schemaVersion": "phase7-2026-05-16",
  "killSwitchActive": false,
  "topics": {
    "axis": "topics",
    "enabled": true,
    "scorerProvided": true,
    "threshold": 0.75,
    "candidateCount": 80,
    "acceptedCount": 20,
    "rejectedCount": 60,
    "belowThresholdCount": 35,
    "runtimeState": "enabled_scorer_ready",
    "scorerLatencyMs": 1200,
    "scorerCallCount": 80,
    "scorerLatencyMaxMs": 240,
    "fallbackReasonCounts": { "timeout": 0, "error": 0 }
  },
  "keywords": { "...": "same shape as topics" },
  "geographies": { "axis": "geographies", "semanticApplied": false }
}
```

`geographies.semanticApplied: false` is the tripwire stamp — Phase 4/5/7 lock semantic uplift to topics + keywords only. If this ever flips to `true` without a corresponding Chunk K relock, treat it as a regression.

### `[pipeline.tags]` log line (every refresh)

```
[pipeline.tags] schema=phase7-2026-05-16 kill_switch=off
  semantic_topics=enabled_scorer_ready accepted=20 rejected=60 below_threshold=35
    latency_ms=1200 latency_max_ms=240 calls=80 timeouts=0 errors=0
  semantic_keywords=…
  semantic_geographies=off(locked)
```

### `GET /api/_debug/dashboard-tags` (staging/dev only)

Gated on `TEMPO_DEBUG_TAGS_ENABLED=true` AND `NODE_ENV !== "production"`. Authenticated — only returns the calling identity's last persisted `_meta.tags`. Returns `404` when either gate fails; no story content / source bodies are ever surfaced.

---

## Rollback procedure

The rollback path depends on what's broken:

| Symptom | Action |
|---|---|
| Bad chips on cards (precision regression) | Set the affected per-axis flag (`TEMPO_TAG_SEMANTIC_TOPICS_ENABLED` or `_KEYWORDS_ENABLED`) to `false`. Restart not required if env hot-reload is wired; otherwise restart the API. |
| Provider outage / latency spike | First check `_meta.tags.{axis}.runtimeState` — should already be `scorer_timeout_fallback` / `scorer_error_fallback` (auto fail-closed). Deterministic baseline is already shipping. If sustained, set `TEMPO_TAG_SEMANTIC_KILL_SWITCH=true` to fully disable semantic uplift across all axes until the provider recovers. |
| Schema-version mismatch in a downstream consumer | The consumer should be tolerant of unknown keys; we bump `schemaVersion` whenever the shape changes. If a consumer is brittle, temporarily set kill switch ON while patching the consumer. |
| Suspected runaway behavior (admission, recall) | This should not happen — K1a one-way invariant is test-locked. If observed, set kill switch ON immediately and capture `_meta.tags` + `_meta.funnel` for the affected runs. File an incident under "K1a invariant breach". |

Kill switch wins over every other flag. Setting it on is a one-step incident response.

---

## Calibration cadence

- **Initial:** before flipping any per-axis flag on (Stage 1).
- **After provider model bump:** the embedding provider may roll an updated model under the same `TEMPO_OPENAI_EMBEDDING_MODEL` name; thresholds calibrated against the previous version may drift. Re-run Stage 1 + Stage 4 after a model change.
- **Quarterly:** even without provider changes, evidence drift (user adds new settings keywords / new beats emerge) may shift acceptance ratios. Quarterly Stage 4 retune is reasonable.

---

## Geographies remain deterministic — explicit

No phase from 4 through 7 introduces a semantic-geo path. The deterministic alias map ([`geography-aliases.ts`](../packages/contracts/src/geography-aliases.ts)) is the only widening mechanism for geo. Tests pin `geographies.semanticApplied: false` on every run. If you find yourself wanting to extend semantic mapping to geo, that's a new Chunk K decision (K1c?), not a runtime flag flip — see DECISIONS.md for the lock rationale.
