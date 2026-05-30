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
| Associated Press | `ap-world-latin-america` | https://rss.app/feeds/yTaNDQhAPFcl6x1b.xml | en | activated | AP Latin America hub (`apnews.com/hub/latin-america`). `rss.app` proxy feed — see proxy note below. |
| Associated Press | `ap-us` | https://rss.app/feeds/kcXOXm8fKxJJcyxX.xml | en | activated | AP U.S. News hub (`apnews.com/us-news`). `rss.app` proxy feed — see proxy note below. |
| Bloomberg | `bloomberg-markets` | _TODO — supply Bloomberg feed URL_ | en | proposed | TODO: confirm Bloomberg RSS availability (many endpoints are gated). |
| Bloomberg | `bloomberg-politics` | _TODO — supply Bloomberg feed URL_ | en | proposed | TODO: confirm endpoint + access. |

> **AP pilot proxy note (Slice 9):** The two AP rows use `rss.app` proxy
> endpoints (mirroring the existing Reuters pilot feeds), not canonical AP
> enterprise RSS. This is a deliberate prototype constraint to activate the AP
> pilot now. Migration to canonical AP feeds is a drop-in URL swap on these same
> `feed_id`s once an approved endpoint + ToS is confirmed — no id/name change
> required.

## How to validate a row before Slice 9

1. Fetch the URL and confirm it returns parseable RSS/Atom (no auth wall / paywall block).
2. Confirm `language` matches the feed content.
3. Pick a stable `feed_id` (kebab-case, publisher-prefixed) that does not collide with existing manifest feed ids.
4. Move `status` `proposed → validated`.
5. Only after validation does the URL become eligible for the Slice 9 manifest import.
