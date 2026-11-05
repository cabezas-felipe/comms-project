# Practice notes (function playbooks)

Per-function **what comes next** guidance for personalization. Human + agent SoT. Model invoke uses a compressed `practice_notes.body` seeded from each file’s **Model body** section.

| Function | Artifact | Fidelity | Status |
|----------|----------|----------|--------|
| Communications | [communications.md](./communications.md) | `full` | Locked B4 F-pass (5 Nov 2026) |
| Policy | [policy.md](./policy.md) | `partial` | Locked B4 F-pass · 🟠 provisional (5 Nov 2026) |
| Operations | [operations.md](./operations.md) | `partial` | Locked B4 F-pass · 🟠 provisional (5 Nov 2026) |
| Partnerships | [partnerships.md](./partnerships.md) | `partial` | Locked B4 F-pass · 🟠 provisional (5 Nov 2026) |

## Authoring → seed → runtime

1. Edit this folder’s markdown (**Model body** + `source_refs`).
2. Sync [`practice-notes.seed.json`](../../06-engineering/docs/data/practice-notes.seed.json) (projection, not a second authoring surface).
3. **Bump `version`** and add a new seed row when `body` changes: do not silently overwrite the same version (cache key / PR-09).
4. At build: follow [practice-notes-seed.md](../../06-engineering/docs/data/practice-notes-seed.md) (upsert on `(function_id, version)`; import script at build).

**Related:** [research brief](../practice-notes--research-brief.md) (input, not SoT) · [personalization contract](../contracts/personalization.md) (PR-07, PR-14) · [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) `practice_notes` · [personalization prompt](../../06-engineering/docs/prompts/personalization.md)

**Cross-cutting locks (C-pass):** note uncapped; posture + 3 prefer + 3 avoid + case families (partial 0–3, full up to 4); `source_refs` on DB row not sent to model; provisional for non-comms until interviews; pp5 code eval.

**House style (model-facing):** No em dashes (Unicode U+2014 `—`) in **Model body**, seed `body`, gold `expected`, or personalization system prompt. Prefer commas, colons, or periods.

**Version SoT:** `practice_notes.version` / seed `notes[].version` — currently **2** for all four functions ([practice-notes.seed.json](../../06-engineering/docs/data/practice-notes.seed.json)). Markdown files do not carry a separate version field; bump the seed when Model body changes.
