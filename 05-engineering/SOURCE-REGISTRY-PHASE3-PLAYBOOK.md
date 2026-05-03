# Source Registry — Phase 3 (Option B) Operator Playbook

Phase 3 makes Supabase the source of truth for the ingestion feed manifest. `GET /api/ingestion/sources` now reads from `source_feed_mapping` + `source_entities` instead of `source-feeds.json` when Supabase is configured. (See [D-044 in DECISIONS.md](DECISIONS.md).)

## New source of truth

| Before Phase 3 | After Phase 3 |
|----------------|---------------|
| `apps/api/data/source-feeds.json` (checked-in JSON) | `source_feed_mapping` + `source_entities` tables in Supabase |
| Changes require a code commit + deploy | Changes take effect on the next API request |
| Fallback: still used when `SUPABASE_URL` is not set | Preserved for offline / test environments |

---

## Prerequisites

- Migrations 001–006 applied to your Supabase project (see [MODE2-SOURCE-REGISTRY-PHASE0.md](MODE2-SOURCE-REGISTRY-PHASE0.md)).
- Migration 007 applied (see [Apply migration 007](#apply-migration-007) below).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in the environment that runs the API.

---

## Apply migration 007

Migration 007 adds `ingestion_weight` and `active` columns to `source_feed_mapping`.

1. Open Supabase Dashboard → **SQL Editor** → New query.
2. Paste the contents of [`apps/api/src/db/migrations/007_source_feed_manifest_columns.sql`](apps/api/src/db/migrations/007_source_feed_manifest_columns.sql).
3. Run once. `ADD COLUMN IF NOT EXISTS` is idempotent — re-running is safe.

---

## Seed Supabase from existing JSON (one-time import)

Run the import script once per environment to populate `source_entities` and `source_feed_mapping` from the existing `source-feeds.json`:

```bash
# From repo root
cd 05-engineering
SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
  node apps/api/src/db/source-feeds-import.mjs
```

Expected output:

```
[import] Read 6 feeds from source-feeds.json
[import] inserted nyt-politics → The New York Times — Politics
[import] inserted reuters-world → Reuters — World News
...
[import] Done. inserted=6 updated=0 skipped=0
```

Re-running after initial import produces `updated=N` instead of `inserted=N` — idempotent and safe.

### What the script does

For each feed in `source-feeds.json`:

1. Upserts a row in `source_entities` (keyed on `kind` + `canonical_name`).
   - JSON `kind: "rss"` → entity `kind: "traditional"`
   - JSON `kind: "social"` → entity `kind: "social"`
2. Upserts a row in `source_feed_mapping` for that entity:
   - Sets `manifest_feed_id`, `ingestion_weight`, `active`.
   - Sets `rss_url` for RSS feeds; `social_profile_url` for social feeds.
   - Sets `status = 'mapped'` (unless existing row already has `status = 'verified'` — that is preserved).

---

## Managing feeds after Phase 3

Once migration 007 is applied and the import script has run, manage the ingestion manifest directly in Supabase.

### Activate or deactivate a feed

```sql
UPDATE source_feed_mapping
SET active = false
WHERE manifest_feed_id = 'migrationdesk';
```

Changes take effect immediately — no deploy required.

### Adjust ingestion weight

```sql
UPDATE source_feed_mapping
SET ingestion_weight = 75
WHERE manifest_feed_id = 'el-tiempo-politics';
```

### Add a new feed

Follow the [Phase 2 mapping workflow](SOURCE-REGISTRY-PHASE2-PLAYBOOK.md#mapping-workflow) to create an entity + alias + feed mapping row, then set `ingestion_weight` and `active` as needed:

```sql
-- After creating entity and alias...
INSERT INTO source_feed_mapping (
  source_entity_id,
  rss_url,
  manifest_feed_id,
  ingestion_weight,
  active,
  status
)
VALUES (
  '<entity-id>',
  'https://example.com/rss',
  'example-feed',
  70,
  true,
  'mapped'
);
```

Only rows with `status IN ('mapped', 'verified')` appear in `GET /api/ingestion/sources`.

### Verify the live manifest

```bash
curl http://localhost:8787/api/ingestion/sources | jq '.feeds[] | {id, name, weight, active}'
```

Or query the DB directly:

```sql
SELECT
  sfm.manifest_feed_id,
  se.canonical_name,
  sfm.ingestion_weight,
  sfm.active,
  sfm.status
FROM source_feed_mapping sfm
JOIN source_entities se ON se.id = sfm.source_entity_id
WHERE sfm.status IN ('mapped', 'verified')
ORDER BY sfm.ingestion_weight DESC, se.canonical_name ASC;
```

---

## Fallback behaviour

When `SUPABASE_URL` is **not set** in the environment (e.g., local dev without Supabase, CI), `GET /api/ingestion/sources` falls back to reading `source-feeds.json`. No configuration change needed — the route detects the env var at request time.

When `SUPABASE_URL` **is set** but the DB query fails, the route returns **500** with a clear error message. It does not silently fall back to JSON — a DB failure in a configured environment should surface immediately rather than hiding configuration drift.

---

## Troubleshooting

**`GET /api/ingestion/sources` returns 500 with "Failed to read source feeds from database"**

1. Confirm `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set correctly.
2. Confirm migration 007 has been applied: `SELECT column_name FROM information_schema.columns WHERE table_name = 'source_feed_mapping' AND column_name IN ('ingestion_weight', 'active');` — should return 2 rows.
3. Confirm migration 005 grants are in place (service_role can SELECT source_feed_mapping).

**`GET /api/ingestion/sources` returns `{ "feeds": [] }` but I have mapped entries**

- Check that at least one `source_feed_mapping` row has `status IN ('mapped', 'verified')`.
- Check that the row has a non-null `rss_url` or `social_profile_url`.
- Run the import script if the seed hasn't been run yet.

**`GET /api/ingestion/sources` still returns the old JSON response format (has `_note` key)**

Supabase is not enabled in this environment. `SUPABASE_URL` is unset — the JSON fallback is active.

---

## Rollback

To revert to JSON-only behaviour, unset `SUPABASE_URL` in the API environment. The route falls back to `source-feeds.json` automatically. No code change required.
