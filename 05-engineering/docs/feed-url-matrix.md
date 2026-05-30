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
| Associated Press | `ap-politics` | https://rss.app/feeds/Q0eTIJF29inHFABU.xml | en | activated | AP Politics. `rss.app` proxy feed — see proxy note below. |
| Associated Press | `ap-politics-white-house` | https://rss.app/feeds/XNymhkWTHdSXFabC.xml | en | activated | AP Politics — White House. `rss.app` proxy feed — see proxy note below. |
| Associated Press | `ap-politics-congress` | https://rss.app/feeds/6hROpUYxMB8H10ZM.xml | en | activated | AP Politics — Congress. `rss.app` proxy feed — see proxy note below. |
| Associated Press | `ap-us-immigration` | https://rss.app/feeds/rBxffpzA3aoenCVN.xml | en | activated | AP U.S. — Immigration. `rss.app` proxy feed — see proxy note below. |
| Associated Press | `ap-business-tariffs` | https://rss.app/feeds/qYDIDwmHpIDvosjo.xml | en | activated | AP Business — Tariffs and global trade. `rss.app` proxy feed — see proxy note below. |
| Bloomberg | `bloomberg-politics-us` | https://rss.app/feeds/UazFLROXqfvuIKqG.xml | en | activated | Bloomberg US Politics. `rss.app` proxy feed — see Bloomberg proxy note below. |
| Bloomberg | `bloomberg-markets` | _TODO — supply Bloomberg feed URL_ | en | proposed | TODO: confirm Bloomberg RSS availability (many endpoints are gated). |
| Bloomberg | `bloomberg-politics` | _TODO — supply Bloomberg feed URL_ | en | proposed | TODO: confirm endpoint + access. |

> **AP proxy note (Slice 9 pilot → Slice 10 full set):** All AP rows use
> `rss.app` proxy endpoints (mirroring the existing Reuters pilot feeds), not
> canonical AP enterprise RSS. Slice 9 activated the first 2 (`ap-world-latin-america`,
> `ap-us`); Slice 10 adds the remaining 5 for **7 AP feeds total**. This is a
> deliberate prototype constraint to activate AP now. Migration to canonical AP
> feeds is a drop-in URL swap on these same `feed_id`s once an approved endpoint
> + ToS is confirmed — no id/name change required.

> **Bloomberg proxy note (Slice 11):** `bloomberg-politics-us` uses an `rss.app`
> proxy endpoint, same prototype posture as the AP feeds — canonical Bloomberg
> RSS is largely gated. Migration to an approved Bloomberg endpoint is a drop-in
> URL swap on the same `feed_id` once availability + ToS are confirmed. The
> remaining `bloomberg-markets` / `bloomberg-politics` rows stay `proposed`.

## How to validate a row before Slice 9

1. Fetch the URL and confirm it returns parseable RSS/Atom (no auth wall / paywall block).
2. Confirm `language` matches the feed content.
3. Pick a stable `feed_id` (kebab-case, publisher-prefixed) that does not collide with existing manifest feed ids.
4. Move `status` `proposed → validated`.
5. Only after validation does the URL become eligible for the Slice 9 manifest import.
