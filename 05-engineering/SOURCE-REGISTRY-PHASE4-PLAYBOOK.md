# Source Registry — Phase 4 Operator Playbook

Phase 4 hardens the daily net-new source digest that was introduced in Phase 2. No new product UI, no scheduler migration, no new migrations. See [D-045 in DECISIONS.md](DECISIONS.md).

---

## What changed in Phase 4

| Area | Before | After |
|------|--------|-------|
| Row ordering in digest | DB return order (non-deterministic) | Highest `times_seen` first; tie-break: earliest `first_seen_at` |
| Input mutation | `formatDigest` sorted in place | Sorts a copy — input array never mutated |
| GitHub Actions logs | Script output only | Pre-run echo: UTC timestamp + webhook/dry-run status |
| Test coverage | Section presence + count | + ordering, tie-break, no-mutation |

---

## Operational loop (unchanged from Phase 2)

```
09:00 UTC   GitHub Actions runs source-delta-digest
            ↓
            Logs: "[source-digest] Run started at 2026-05-03T09:00:01Z"
            Logs: "[source-digest] Slack webhook configured: yes"  (or: no — dry-run mode)
            ↓
  (rows found)                              (no rows)
            ↓                                     ↓
  Slack message arrives                     "[source-digest] No unmapped sources
  "N unmapped sources"                       in the last 24 hours — nothing to report."
  Rows sorted: most-seen first              Clean exit, no Slack message.
            ↓
Operator opens Supabase SQL Editor
            ↓
For each source: create entity → create alias → add feed mapping
            ↓
Tomorrow's digest silences those sources automatically
```

---

## Healthy run log output

### When rows are found and webhook is set

```
[source-digest] Run started at 2026-05-03T09:00:01Z
[source-digest] Slack webhook configured: yes
[source-digest] Posted 3 unmapped sources to Slack.
```

The Slack message will look like:

```
*Daily source digest — 2026-05-03* (3 unmapped)

*Traditional (2)*
• Reuters — seen 12× (last: 2026-05-02T23:45Z)
• El Tiempo — seen 4× (last: 2026-05-02T20:10Z)

*Social (1)*
• @latamwatcher — seen 7× (last: 2026-05-02T22:00Z)
```

Rows within each section are ordered: highest `times_seen` first. Same-count rows appear in earliest-first-seen order.

### When no rows are found

```
[source-digest] Run started at 2026-05-03T09:00:01Z
[source-digest] Slack webhook configured: yes
[source-digest] No unmapped sources in the last 24 hours — nothing to report.
```

No Slack message is sent. This is the healthy steady state once sources are fully mapped.

### Dry-run (webhook not set)

```
[source-digest] Run started at 2026-05-03T09:00:01Z
[source-digest] Slack webhook configured: no — dry-run mode
[source-digest] Dry run (SOURCE_DIGEST_SLACK_WEBHOOK_URL not set):

*Daily source digest — 2026-05-03* (1 unmapped)

*Traditional (1)*
• Reuters — seen 3× (last: 2026-05-02T22:00Z)
```

---

## Manual run command

```bash
# Dry run (prints to stdout, does not post to Slack)
cd 05-engineering
SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
  node apps/api/src/ops/source-delta-digest.mjs

# Live run (posts to Slack)
cd 05-engineering
SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
  SOURCE_DIGEST_SLACK_WEBHOOK_URL=<webhook-url> \
  node apps/api/src/ops/source-delta-digest.mjs
```

You can also trigger a one-off run from GitHub Actions without waiting for the 09:00 UTC cron:
**Actions → Daily source digest → Run workflow → Run workflow**

---

## Failure and retry guidance

### Script exits non-zero: "Missing required env var"

`SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is not set. In GitHub Actions this means the repository secret is missing or named incorrectly. Check: **Settings → Secrets and variables → Actions**.

### Script exits non-zero: "Query failed: …"

The Supabase query against `v_source_net_new_24h` failed. Likely causes:
- Migration 006 has not been applied to this environment.
- The service role key does not have SELECT on the view — apply migration 005.
- The Supabase project is paused (free-tier projects pause after inactivity).

Verify with: `SELECT * FROM v_source_net_new_24h LIMIT 1;` in the Supabase SQL Editor.

### Script exits non-zero: "Slack webhook failed: 4xx/5xx"

The Slack Incoming Webhook URL is invalid, revoked, or the channel was deleted. Regenerate the webhook in the Slack app settings and update the `SOURCE_DIGEST_SLACK_WEBHOOK_URL` secret.

### Retry

The GitHub Actions workflow has no automatic retry. To retry a failed run:
**Actions → Daily source digest → [failed run] → Re-run all jobs**

Or trigger a fresh manual run via `workflow_dispatch`.

---

## Mapping workflow

Same as Phase 2 — see [SOURCE-REGISTRY-PHASE2-PLAYBOOK.md](SOURCE-REGISTRY-PHASE2-PLAYBOOK.md#mapping-workflow) for the full SQL workflow (create entity → create alias → add feed mapping → verify silenced).

---

## View contract

`v_source_net_new_24h` returns:

| Column | Type | Description |
|--------|------|-------------|
| `raw_string` | text | Exact string the user typed |
| `kind` | text | `'traditional'` or `'social'` |
| `first_seen_at` | timestamptz | Earliest event in the 24h window |
| `last_seen_at` | timestamptz | Most recent event in the 24h window |
| `times_seen` | int | Count of events in the 24h window |
| `sample_user_ids` | text[] | Up to 3 distinct user IDs who mentioned this source |

The view has **no ORDER BY** — sorting is the consumer's responsibility. `formatDigest` sorts deterministically (highest `times_seen` first, then earliest `first_seen_at`).

A source is excluded from the view once it has:
1. A `source_aliases` row whose `alias_normalized` matches `normalize_source_alias(raw_string)`, AND
2. That alias links to a `source_entities` row, AND
3. That entity has a `source_feed_mapping` row with `status IN ('mapped', 'verified')`.

---

## Required GitHub secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Project API URL (Supabase Dashboard → Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (same settings page) |
| `SOURCE_DIGEST_SLACK_WEBHOOK_URL` | Incoming Webhook URL from your Slack app (optional — omit for dry-run) |

---

## When to move to Phase 5 (admin UI)

See [D-043 in DECISIONS.md](DECISIONS.md) for the full rationale. Trigger an admin UI build when:
- Daily digest consistently shows > 50 unmapped sources, or
- A second non-technical operator needs to manage mappings without SQL access.
