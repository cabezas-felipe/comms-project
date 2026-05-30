# Feed URL Matrix — Phase 2 (AP / Bloomberg)

Intake artifact for Phase 2 publisher activation. URLs are gathered and
**validated here first**, then promoted into the Supabase feed manifest during
**Slice 9** (manifest `active` flag + import). Nothing in this file activates a
feed on its own.

Status values:

- `proposed` — URL captured, not yet checked.
- `validated` — URL fetched successfully, parses as RSS/Atom, language confirmed.
- `activated` — added to the manifest with `active=true` and ingesting (set during/after Slice 9).

> Expansion-safe reminder: `TEMPO_RSS_ALLOWLIST` must stay **unset** in deployed
> environments so the manifest-derived default admits these publishers
> automatically once activated. See
> [phase2-preflight.md](phase2-preflight.md) and
> [../DECISIONS.md](../DECISIONS.md).

| publisher | feed_id (planned) | URL | language | status | notes |
| --- | --- | --- | --- | --- | --- |
| Associated Press | `ap-top` | _TODO — supply AP feed URL_ | en | proposed | TODO: confirm canonical AP RSS endpoint + ToS for ingestion. |
| Associated Press | `ap-world` | _TODO — supply AP feed URL_ | en | proposed | TODO: world/international desk; confirm availability. |
| Bloomberg | `bloomberg-markets` | _TODO — supply Bloomberg feed URL_ | en | proposed | TODO: confirm Bloomberg RSS availability (many endpoints are gated). |
| Bloomberg | `bloomberg-politics` | _TODO — supply Bloomberg feed URL_ | en | proposed | TODO: confirm endpoint + access. |

## How to validate a row before Slice 9

1. Fetch the URL and confirm it returns parseable RSS/Atom (no auth wall / paywall block).
2. Confirm `language` matches the feed content.
3. Pick a stable `feed_id` (kebab-case, publisher-prefixed) that does not collide with existing manifest feed ids.
4. Move `status` `proposed → validated`.
5. Only after validation does the URL become eligible for the Slice 9 manifest import.
