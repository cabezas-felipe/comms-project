# MODE2 — Slice 12: Ingestion Sources Foundation

**Branch:** `build/slice12-ingestion-sources`
**Date:** 2026-04-23
**Decision:** D-030

---

## Objective

Move ingestion from a direct static-file read toward a pipeline with an explicit normalization step and a swappable source boundary. Dashboard contract and frontend consumer behavior remain unchanged.

---

## What Changed

### New files


| File                                                 | Purpose                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/ingestion/source-normalizer.mjs`       | Normalization layer: coerces raw items to canonical shape, defaults optional fields, skips invalid items with error reporting |
| `apps/api/src/ingestion/feed-reader.mjs`             | Ingestion boundary: reads `source-items.json`; swap internals to activate live feed fetching                                  |
| `apps/api/src/ingestion/source-normalizer.test.mjs`  | 8 unit tests for normalization (happy path, defaults, required-field errors, mixed-batch skipping, TypeError guard)           |
| `apps/api/data/source-feeds.json`                    | Machine-readable manifest of 6 declared source feeds (4 RSS, 2 social); URLs are placeholders, no live fetching yet           |
| `05-engineering/MODE2-SLICE-12-INGESTION-SOURCES.md` | This file                                                                                                                     |


### Modified files


| File                                  | Change                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/server.mjs`             | Removed `readSourceItems()` / `SOURCE_ITEMS_FILE`; wired `readFeedItems` + `normalizeSourceItems` into dashboard handler; added `GET /api/ingestion/sources` route |
| `apps/api/src/server.routes.test.mjs` | Seeds `source-feeds.json` in isolated tmpDir; +1 test for `GET /api/ingestion/sources`                                                                             |
| `apps/api/package.json`               | Added `src/ingestion/source-normalizer.test.mjs` to test script                                                                                                    |
| `05-engineering/DECISIONS.md`         | Prepended D-030                                                                                                                                                    |


---

## Pipeline Before vs. After

**Before (Slice 8–11):**

```
GET /api/dashboard
  → readSourceItems() [direct fs.readFile → JSON.parse]
  → buildDashboardPayload(items, settings, limit)
```

**After (Slice 12):**

```
GET /api/dashboard
  → readFeedItems(DATA_DIR)        ← ingestion boundary (swappable)
  → normalizeSourceItems(rawItems) ← normalization step (new)
  → buildDashboardPayload(items, settings, limit)
```

The downstream `buildDashboardPayload` and AI summarization are unchanged. Only the input seam changed.

---

## Source Normalization Contract

`normalizeSourceItem(raw)` guarantees these fields on any valid output:


| Field          | Type                 | Source                              |
| -------------- | -------------------- | ----------------------------------- |
| `clusterId`    | `string`             | Required                            |
| `sourceId`     | `string`             | Required                            |
| `outlet`       | `string`             | Required                            |
| `kind`         | `string`             | Required                            |
| `weight`       | `number`             | Required                            |
| `url`          | `string`             | Required                            |
| `minutesAgo`   | `number`             | Required                            |
| `headline`     | `string`             | Required                            |
| `body`         | `string[]`           | Required; string input → `[string]` |
| `title`        | `string`             | Optional; defaults to `clusterId`   |
| `topic`        | `string`             | Optional; defaults to `""`          |
| `geographies`  | `string[]`           | Optional; defaults to `[]`          |
| `priority`     | `any`                | Optional; defaults to `"standard"`  |
| `takeaway`     | `string`             | Optional; defaults to `""`          |
| `summary`      | `string`             | Optional; defaults to `""`          |
| `whyItMatters` | `string`             | Optional; defaults to `""`          |
| `whatChanged`  | `string`             | Optional; defaults to `""`          |
| `byline`       | `string | undefined` | Optional; omitted if null/undefined |


Throws `Error("Missing required field: <name>")` for any absent required field.

---

## New Endpoint

### `GET /api/ingestion/sources`

Returns the declared feed source manifest from `data/source-feeds.json`.

**Response shape:**

```json
{
  "feeds": [
    {
      "id": "nyt-politics",
      "name": "The New York Times — Politics",
      "kind": "rss",
      "url": "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
      "weight": 95,
      "active": true
    }
  ]
}
```

**Failure:** HTTP 500 `{ message, detail }` if the file cannot be read.

---

## Source Assumptions

1. `source-items.json` remains the backing data — no live RSS fetching in this slice.
2. `source-feeds.json` URLs are placeholders and are not validated or fetched.
3. Items in `source-items.json` are expected to match the normalization contract. Any that don't are skipped with a `console.warn` log entry.
4. No auth guard on `GET /api/ingestion/sources` — consistent with all other routes at this stage.

---

## Failure Behavior


| Scenario                                  | Behavior                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `source-items.json` missing or unreadable | `GET /api/dashboard` returns HTTP 500 (unchanged from prior behavior)                   |
| Individual item missing required field    | Item skipped; `console.warn` logged; remaining items proceed                            |
| All items invalid                         | Dashboard returns empty `stories: []` (filter+cluster yields nothing)                   |
| `source-feeds.json` missing               | `GET /api/ingestion/sources` returns HTTP 500                                           |
| `rawItems` is not an array                | `normalizeSourceItems` throws `TypeError`; caught by dashboard error handler → HTTP 500 |


---

## Test Count


| Suite                        | Before | After                          |
| ---------------------------- | ------ | ------------------------------ |
| `model-router.test.mjs`      | 8      | 8                              |
| `server.settings.test.mjs`   | 6      | 6                              |
| `server.routes.test.mjs`     | 5      | 6 (+1 ingestion/sources route) |
| `settings-repo.test.mjs`     | 7      | 7                              |
| `source-normalizer.test.mjs` | 0      | 8 (new)                        |
| **Total**                    | **26** | **35**                         |


---

## Validation Gates

```
✓ node --check apps/api/src/server.mjs
✓ cd 05-engineering && npm run test:api   → 35/35 pass
✓ cd 05-engineering && npm run build      → exit 0
✓ cd 05-engineering && npm run test:prototype → 9/9 pass
✓ cd 04-prototype && npx eslint src/lib/api.ts vite.config.ts → exit 0
```

---

## Gaps / Next Steps

1. **Live RSS ingestion** — Replace `readFeedItems()` internals with an RSS parser (e.g., `rss-parser` or `fast-xml-parser`) and map RSS `<item>` fields through `normalizeSourceItem`. The normalization contract is already RSS-ready (handles string `body` input).
2. **Stories table persistence** — Wire normalized items into the Supabase `stories` table behind an `ingestion-repo.mjs` adapter. Schema is already in `db/schema.sql`. Target: Slice 13.
3. **Feed scheduling** — A cron-triggered or webhook-triggered ingestion job to pull feeds on a schedule. Supabase pg_cron (Pro tier) or an external scheduler can call `readFeedItems` + `normalizeSourceItems` + repo write.
4. **Auth guard on `/api/ingestion/sources`** — Should be gated once server-side auth is in place (deferred per D-016).
5. **Feed config mutation** — A `PUT /api/ingestion/sources` route to activate/deactivate feeds without editing JSON directly. Out of scope for this slice.

