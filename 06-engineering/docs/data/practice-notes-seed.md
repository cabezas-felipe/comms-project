# Practice notes — seed / build handoff

> **Status:** Design Locked (B4 E1-B) · **Updated:** 5 Nov 2026  
> **Runtime:** Not wired until personalization build.

## Sources of truth

| Layer | Path |
|-------|------|
| Human + agent playbook | [`02-product/practice-notes/`](../../../02-product/practice-notes/README.md) |
| Seed fixture (projection) | [`practice-notes.seed.json`](./practice-notes.seed.json) |
| Schema | [`tempo.dbml`](./tempo.dbml) `functions` + `practice_notes` |

**Authoring rule:** Edit the markdown **Model body** / `source_refs` first → sync the JSON fixture → **bump `version`** when `body` changes (PR-09 hash uses id+version).

## Migrate / seed order (build)

1. Ensure `functions` has exactly these lowercase names: `communications`, `policy`, `operations`, `partnerships` (insert if missing; do not hardcode UUIDs in the extraction prompt — load names at call time).
2. For each object in `practice-notes.seed.json` → `notes[]`:
   - Resolve `function_name` → `functions.function_id`
   - **Upsert** on unique `(function_id, version)` — safe re-run (locked 5 Nov 2026 Q1). On conflict update `body` + `source_refs` (keep existing `practice_note_id` / `created_at` unless product later requires otherwise)
   - New insert: generate `practice_note_id` (uuid); `source_refs` = `json.dumps(source_refs)` (text column); `created_at = now()`
3. Do **not** insert from the research brief.
4. **Body change (Q3):** do **not** overwrite in place as a silent edit — bump `version` and insert a **new row** (keeps history; PR-09 / `input_hash` moves). Update the seed fixture’s `version` to match.
5. **Import script (Q2):** implement at personalization **build** (pattern: source-feeds import); not required as a pre-build stub.

**House style:** Seed `body` has no em dashes (U+2014). Current fixture **version 2** (5 Nov 2026).

## Runtime load (personalization)

```text
SELECT practice_note_id, version, body
FROM practice_notes
WHERE function_id = $user_function_id
ORDER BY version DESC
LIMIT 1
```

- Missing row / empty body / null `function_id` → **PR-14 why-only**
- Send to model: id, version, body (user message wire)
- **Never** send `source_refs` to the model; never log body in prod default

## Idempotent import sketch (build)

Small import module (pattern: `source-feeds-import.mjs`) that reads this JSON and **upserts** on `(function_id, version)`. Not implemented until personalization build (Q2).

## Related

- Contract: [personalization.md](../../../02-product/contracts/personalization.md) PR-07 · PR-14  
- Prompt: [personalization.md](../prompts/personalization.md)  
- Pipeline: [personalization.md](../pipelines/personalization.md)  
- Evals: [personalization.md](../evals/personalization.md)  
