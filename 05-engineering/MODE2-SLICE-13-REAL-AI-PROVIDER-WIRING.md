# Mode 2 — Slice 13: Real AI provider wiring

## 1) Slice objective

Wire a production-ready Anthropic execution path through the existing model-router abstraction. Keep mock and fallback paths fully intact. Add runtime config validation and a mock-only escape hatch for dev/CI.

## 2) Scope and exclusions

In scope:

- `apps/api/src/ai/providers/anthropic.mjs` (new)
- `apps/api/src/ai/model-router.mjs` (updated)
- `apps/api/src/ai/model-router.test.mjs` (extended)
- `apps/api/package.json` (`@anthropic-ai/sdk` dependency)
- `apps/api/.env.example` (new env vars documented)
- `apps/api/src/server.mjs` (startup validation + `mockOnly` field)
- `05-engineering/DECISIONS.md` (D-031 prepended)
- `05-engineering/MODE2-SLICE-13-REAL-AI-PROVIDER-WIRING.md` (this file)

Out of scope:

- Frontend changes
- Auth model
- Ingestion refactor
- Classification or safety capability execution (still mock-only)
- Persistent metrics storage

## 3) Design-system discovery

Not applicable — backend-only slice.

## 4) Design-system mapping

Not applicable (no UI changes).

## 5) Implementation summary

### New: `apps/api/src/ai/providers/anthropic.mjs`

Thin wrapper around `@anthropic-ai/sdk`:

```
summarizeWithAnthropic({ apiKey, model, prompt, timeoutMs })
  → { summary: string, inputTokens: number, outputTokens: number }
```

- Creates a per-call `Anthropic` client with SDK-level `timeout` set to `timeoutMs`.
- Calls `messages.create` with `max_tokens: 256`, `temperature: 0.2`, system prompt identical to the OpenAI-compatible path.
- Returns `summary` (trimmed text) and actual usage token counts from the response.
- Throws `"Anthropic API returned empty summary"` if the response is empty — caught by the existing fallback handler in the router.

### Updated: `apps/api/src/ai/model-router.mjs`

**Key changes:**


| Change                                                      | Rationale                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CAPABILITY_DEFAULTS` → `getCapabilityDefaults()` (lazy fn) | Tests can set `TEMPO_AI_SUMMARY_MODEL` after import; no re-import hacks needed |
| `providerFor(model)` exported                               | Unit-testable provider routing                                                 |
| `anthropic:` prefix → `"anthropic"` provider                | Real Anthropic execution path                                                  |
| `TEMPO_AI_MOCK_ONLY=true` read at call time                 | Single env toggle forces all providers to mock                                 |
| `resolveModelName(model)`                                   | Strips `anthropic:` / `openai:` prefix before passing to provider              |
| `ANTHROPIC_COSTS` lookup table                              | Real per-MTok pricing replaces stub estimate for Anthropic path                |
| `assertAiConfig(capabilityMap?)` exported                   | Validates API keys for configured real providers; testable via optional arg    |
| Actual token counts from Anthropic response                 | `inputTokens` / `outputTokens` used for cost calculation when available        |


**Provider routing table:**


| `TEMPO_AI_SUMMARY_MODEL` value        | Provider selected                                         | Key required                                     |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `mock-openai-mini` (default)          | `mock-openai`                                             | None                                             |
| `mock-anthropic-haiku`                | `mock-anthropic`                                          | None                                             |
| `anthropic:claude-haiku-4-5-20251001` | `anthropic`                                               | `TEMPO_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` |
| `anthropic:claude-sonnet-4-6`         | `anthropic`                                               | same                                             |
| `openai:gpt-4o-mini`                  | `openai-compatible`                                       | `TEMPO_OPENAI_API_KEY`                           |
| Any unknown value                     | `mock-openai`                                             | None                                             |
| Any value + `TEMPO_AI_MOCK_ONLY=true` | `mock-openai` (or `mock-anthropic` if `mock-anthropic-`*) | None                                             |


**Fallback behavior unchanged:** any provider error (including missing key) → heuristic summary + `fallbackUsed: true` + counter increments. No silent data loss.

**Cost tracking:**

- Anthropic path: real token counts → `ANTHROPIC_COSTS` table → exact USD figure.
- OpenAI / mock paths: existing heuristic estimate (unchanged).

### Updated: `apps/api/src/server.mjs`

- Imports `assertAiConfig` from model-router.
- At app init (module level): `try { assertAiConfig() } catch (err) { console.warn(...) }`. Non-crashing — server starts regardless; the warning surfaces misconfiguration before the first request.
- `GET /api/ai/models` now includes `mockOnly: bool` so operators can confirm the escape hatch is active.

### Updated: `apps/api/src/ai/model-router.test.mjs`

12 new tests (38 total, up from 26):

**Provider routing (unit):**

- `providerFor("mock-openai-mini")` → `"mock-openai"` (regression)
- `providerFor("mock-anthropic-haiku")` → `"mock-anthropic"` (regression)
- `providerFor("anthropic:claude-haiku-4-5-20251001")` → `"anthropic"`
- `providerFor("openai:gpt-4o-mini")` → `"openai-compatible"`
- Unknown model → `"mock-openai"` (default)

**MOCK_ONLY flag:**

- `TEMPO_AI_MOCK_ONLY=true` + `anthropic:` → `"mock-openai"`
- `TEMPO_AI_MOCK_ONLY=true` + `openai:` → `"mock-openai"`

**Config validation:**

- `assertAiConfig` passes for mock-only maps
- `assertAiConfig` throws for `anthropic:` model with no key (pattern: `TEMPO_ANTHROPIC_API_KEY`)
- `assertAiConfig` throws for `openai:` model with no `TEMPO_OPENAI_API_KEY`

**Fallback path (closes Slice 10 gap):**

- `summarizeCluster` with `anthropic:` model + no key → `fallbackUsed: true`, heuristic summary includes cluster title
- Same scenario → `providerErrors` and `summarizationFallbacks` counters increment

## 6) State coverage


| State                        | Handling                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Mock-only (default)          | `mock-openai-mini` / `mock-anthropic-haiku` — deterministic, no keys needed      |
| Real Anthropic — success     | `summarizeWithAnthropic` → real summary + actual token cost                      |
| Real Anthropic — missing key | Throws → fallback handler → heuristic summary, `fallbackUsed: true`              |
| Real Anthropic — API error   | Throws → fallback handler → same as above                                        |
| Real Anthropic — timeout     | `withTimeout` rejects → fallback, `timedOut: true`                               |
| `TEMPO_AI_MOCK_ONLY=true`    | All real providers bypassed; mock equivalent used                                |
| Startup misconfiguration     | `console.warn` at app init; server still starts; first request triggers fallback |


## 7) Accessibility and responsive results

Not applicable (backend-only).

## 8) Operational setup

### Running in mock-only mode (local dev / CI)

No env vars needed — default model config uses mocks:

```
# .env (or unset — defaults are mock)
TEMPO_AI_SUMMARY_MODEL=mock-openai-mini
```

Or use the escape hatch regardless of model config:

```
TEMPO_AI_MOCK_ONLY=true
```

### Enabling real Anthropic provider

```
TEMPO_AI_SUMMARY_MODEL=anthropic:claude-haiku-4-5-20251001
TEMPO_ANTHROPIC_API_KEY=sk-ant-...
```

Start server — if misconfigured, the startup log will show:

```
[ai.config] Misconfiguration detected: [ai.config] summarization=anthropic:... requires TEMPO_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY
```

Requests will still be served via heuristic fallback until the key is present.

### Safe rollout sequence

1. Deploy with `TEMPO_AI_MOCK_ONLY=true` — verify dashboard is stable.
2. Set `TEMPO_ANTHROPIC_API_KEY` in the target environment.
3. Set `TEMPO_AI_SUMMARY_MODEL=anthropic:claude-haiku-4-5-20251001`.
4. Remove `TEMPO_AI_MOCK_ONLY` or set to `false`.
5. Watch `GET /api/ai/metrics` for `providerErrors` / `summarizationFallbacks` — if either climbs, re-enable `TEMPO_AI_MOCK_ONLY=true` to recover instantly.

### Cost reference


| Model                       | Input       | Output      |
| --------------------------- | ----------- | ----------- |
| `claude-haiku-4-5-20251001` | $0.80/MTok  | $4.00/MTok  |
| `claude-sonnet-4-6`         | $3.00/MTok  | $15.00/MTok |
| `claude-opus-4-7`           | $15.00/MTok | $75.00/MTok |


A 2-sentence summary typically uses ~200 input tokens and ~60 output tokens. At Haiku pricing: ~$0.000400/story. Ballpark for 10 stories per dashboard load: ~$0.004.

## 9) Quality gate status


| Command                                                       | Result                         |
| ------------------------------------------------------------- | ------------------------------ |
| `cd 05-engineering && npm run test:api`                       | 38 tests, all pass (↑ from 26) |
| `cd 05-engineering && npm run build`                          | exits 0                        |
| `cd 05-engineering && npm run test:prototype`                 | 9 tests, all pass              |
| `cd 04-prototype && npx eslint src/lib/api.ts vite.config.ts` | exits 0                        |
| `node --check apps/api/src/server.mjs`                        | exits 0                        |
| `node --check apps/api/src/ai/model-router.mjs`               | exits 0                        |


## 10) Risks and follow-up

- **Classification and safety capabilities** still route to mocks. Real provider wiring for those is deferred — they share the same router pattern and can be enabled by setting `TEMPO_AI_CLASSIFIER_MODEL` / `TEMPO_AI_SAFETY_MODEL`.
- **Metrics are in-memory** (counter resets on restart). Persistent telemetry is a follow-up slice.
- **No request tracing IDs.** Correlating a specific dashboard call to its AI summary cost requires log scraping. A `requestId` field in `aiSummaryMeta` would close this.
- `**TEMPO_AI_TIMEOUT_MS` applies as both the router-level `withTimeout` deadline and the SDK-level timeout.** If the SDK connection setup is slow, both fire at the same ms mark — effectively a single clock. This is intentional simplicity; a separate `connectTimeoutMs` can be added if needed.

