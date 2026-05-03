# Source Registry — Phase 2 (Option A) Operator Playbook

Phase 2 gives the operator a daily Slack digest of net-new sources and the SQL tools to map them. No admin UI is required (see [D-043 in DECISIONS.md](DECISIONS.md)).

## Prerequisites

- Migrations 001–006 applied to your Supabase project.
- Service role key and Slack webhook configured (see [Scheduling](#scheduling)).

---

## Daily loop

```
09:00 UTC   GitHub Actions runs source-delta-digest
            ↓
            Slack message arrives: "3 unmapped sources"
            ↓
Operator opens Supabase SQL Editor
            ↓
For each source: create entity → create alias → add feed mapping
            ↓
Tomorrow's digest silences those sources automatically
```

If the digest is empty ("no new sources in last 24h"), no action is needed.

---

## Run digest manually

```bash
# From repo root
cd 05-engineering
SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
  node apps/api/src/ops/source-delta-digest.mjs
```

Omit `SOURCE_DIGEST_SLACK_WEBHOOK_URL` to dry-run: the message prints to stdout without sending.

You can also query the view directly in the Supabase SQL Editor:

```sql
SELECT * FROM v_source_net_new_24h;
```

---

## Mapping workflow

For each source that appears in the digest, run the following SQL snippets in order in the Supabase SQL Editor.

Replace `<entity-id>` below with the UUID returned by the `INSERT … RETURNING id` step.

### 1. Create canonical entity

```sql
INSERT INTO source_entities (canonical_name, kind)
VALUES ('Reuters', 'traditional')        -- adjust name and kind
ON CONFLICT (kind, canonical_name) DO NOTHING
RETURNING id;
```

`kind` must be `'traditional'` or `'social'`.

### 2. Create alias(es)

One alias per spelling variant you want to silence in the digest. The `alias_normalized` column is computed by the DB function so you just pass the raw string twice.

```sql
INSERT INTO source_aliases (alias_raw, alias_normalized, source_entity_id)
VALUES (
  'Reuters',                                    -- exact string from digest
  normalize_source_alias('Reuters'),            -- normalized form
  '<entity-id>'                                 -- UUID from step 1
)
ON CONFLICT (alias_normalized) DO NOTHING;
```

Add a second row if users type multiple variants (e.g. `'reuters'`, `'REUTERS'`).

### 3. Add or update feed mapping

```sql
INSERT INTO source_feed_mapping (
  source_entity_id,
  rss_url,
  manifest_feed_id,   -- optional: matches id field in source-feeds.json
  status
)
VALUES (
  '<entity-id>',
  'https://feeds.reuters.com/reuters/topNews',  -- set to NULL if unknown
  'reuters',                                    -- or NULL
  'mapped'                                      -- 'mapped' | 'verified' | 'pending' | 'rejected'
)
ON CONFLICT (source_entity_id) DO UPDATE
  SET rss_url          = EXCLUDED.rss_url,
      manifest_feed_id = EXCLUDED.manifest_feed_id,
      status           = EXCLUDED.status;
```

Use `status = 'pending'` if you want to record the entity but haven't found a feed URL yet. The source will still appear in the daily digest until status is `'mapped'` or `'verified'`.

Use `status = 'rejected'` to mark a source as intentionally out-of-scope. The source will still appear in the digest — rejected means "we know about this and won't serve it", not "hide it from the digest". If you want it silenced permanently, use `'mapped'` with a placeholder URL or add a note in the `source_entities.notes` column.

### 4. Verify the source is silenced

Run the view query again. The source should no longer appear once the alias and feed mapping (status `'mapped'` or `'verified'`) are in place.

```sql
SELECT * FROM v_source_net_new_24h WHERE raw_string = 'Reuters';
-- Should return 0 rows after step 2 + 3 are applied
```

---

## Scheduling

The digest runs via GitHub Actions on a daily cron (see [`.github/workflows/source-digest.yml`](../.github/workflows/source-digest.yml)).

### Required GitHub secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Project API URL (from Supabase Dashboard → Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (same settings page) |
| `SOURCE_DIGEST_SLACK_WEBHOOK_URL` | Incoming Webhook URL from your Slack app |

Set these at **Settings → Secrets and variables → Actions** in your GitHub repository.

To trigger a one-off run without waiting for the cron: go to **Actions → Daily source digest → Run workflow**.

### Local cron alternative

If you prefer a local cron (e.g. on a server or macOS launchd), add an entry like:

```
0 9 * * * cd /path/to/comms-project/05-engineering && \
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  SOURCE_DIGEST_SLACK_WEBHOOK_URL=... \
  node apps/api/src/ops/source-delta-digest.mjs >> /var/log/source-digest.log 2>&1
```

---

## Troubleshooting

**Source still appears in digest after mapping**

1. Confirm the alias exists: `SELECT * FROM source_aliases WHERE alias_raw = 'Reuters';`
2. Confirm the feed mapping has `status = 'mapped'` or `'verified'`: `SELECT * FROM source_feed_mapping WHERE source_entity_id = '<entity-id>';`
3. Check the normalization: `SELECT normalize_source_alias('Reuters');` — the result must exactly match `alias_normalized`.
4. Check for casing variants: if users type `reuters` and `Reuters`, each needs its own alias row.

**Digest script fails with "permission denied"**

Apply migration 006 to your environment, and ensure migration 005 (service_role grants) has also been applied. See [MODE2-SOURCE-REGISTRY-PHASE0.md](MODE2-SOURCE-REGISTRY-PHASE0.md) for the full apply sequence.

**View not found (`relation "v_source_net_new_24h" does not exist`)**

Apply [`apps/api/src/db/migrations/006_source_net_new_view.sql`](apps/api/src/db/migrations/006_source_net_new_view.sql) in the Supabase SQL Editor.

**GitHub Actions: "secret not found" or empty run**

Confirm all three secrets are set at the repo level (not environment level). The workflow uses `secrets.SUPABASE_URL` etc. — check exact capitalisation.

**False-positive sources (bot/test traffic)**

If automated test users are generating events, consider filtering by `user_id` in the view. Phase 2 does not exclude specific users — add a `WHERE e.user_id NOT IN (...)` clause manually if needed.

---

## Apply migration 006

1. Open Supabase Dashboard → **SQL Editor** → New query.
2. Paste the contents of [`apps/api/src/db/migrations/006_source_net_new_view.sql`](apps/api/src/db/migrations/006_source_net_new_view.sql).
3. Run once. `CREATE OR REPLACE VIEW` is idempotent — re-running is safe.

---

## When to move to Option B (admin UI)

See [D-043 in DECISIONS.md](DECISIONS.md) for the full rationale. Trigger Option B when:

- Daily digest consistently shows > 50 unmapped sources, or
- A second non-technical operator needs to manage mappings.
