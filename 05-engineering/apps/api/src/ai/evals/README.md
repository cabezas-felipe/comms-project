# AI Evals

Lightweight, local eval harnesses for AI pipeline components. Version-controlled gold dataset. No Supabase. No network dependencies beyond the AI providers.

| Harness | What it measures | Run |
|---|---|---|
| Onboarding extraction | Per-field precision / recall / F1 / exact-match across 20 gold examples | `npm run eval:onboarding-extraction` |
| Cluster shape smoke (M8) | Contract-shape guard: clustering output conforms to `metaStoryOutputSchema` on a 3-item fixture | `npm run eval:cluster-smoke` |

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
- When overall exact-match drops below the 0.70 warning threshold

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
