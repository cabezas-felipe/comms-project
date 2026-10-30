# api-x — Tempo consumption contract

> **Status:** v0 locked (vendor consumption)  
> **Vendor:** [X API](https://docs.x.com/x-api/overview) (v2)  
> **Owner:** Tempo engineering  
> **Last updated:** 28 Oct 2026 (batch compliance field table locked; IR-14 edit re-read)
> **Vendor docs hub:** [https://docs.x.com/x-api/overview](https://docs.x.com/x-api/overview)

Tempo’s map of **which X API endpoints and fields we call**, and **what we use them for**. This is a consumption contract, not a mirror of the vendor docs.

| Status | Meaning |
| --- | --- |
| `in` | We plan to call this in the prototype / v0 path |
| `out` | Explicitly will not call |
| `later` | Possible later; not in current scope |
| `candidate` | Under discussion; not locked |

**How to read an `in` endpoint:** endpoint → data point → brief Tempo use.  
**How to read an `out` / `later` endpoint:** reason only — no field tables.

**Landing zone:** map consumed fields into Tempo’s ingest normalization boundary ([`source-normalizer`](../MODE2-SLICE-12-INGESTION-SOURCES.md#source-normalization-contract)), not provisional Supabase column names.

**Ingest architecture (locked direction):** shared post pool, **tag and personalize in Tempo**. X does not attach per-user tags. Per handle, `social_accounts.fetch_mode` chooses the lane (`word_search` default, or `post_download`). `word_search` uses [Search posts recent](#search-posts-recent) for the union of terms, limited to handles in that mode. `post_download` uses [Get users posts](#get-users-posts) for that handle’s new posts. See [tempo.dbml](data/tempo.dbml).

**How we lock this file:** endpoint include/exclude first → for each `in` endpoint, field proposals (one-line layperson descriptions) → review → lock that endpoint → repeat.

---

## Vendor references

**Section status:** locked (20 Sep 2026)

These pages backstop meaning and request shape. They are **not** endpoints and are **not** field-locked here. Implement only fields marked `in` on locked endpoints; do not invent fields from full dictionaries. Revisit a dictionary field only when a locked `in` property’s shape is ambiguous in practice.

### Primary (use while proposing fields; cite when locking)

| Doc | Role |
| --- | --- |
| [Fields](https://docs.x.com/x-api/fundamentals/fields) | How we request tweet / user / media / … attributes. |
| [Expansions](https://docs.x.com/x-api/fundamentals/expansions) | How nested objects arrive in `includes`. |
| [Data dictionary reference](https://docs.x.com/x-api/fundamentals/data-dictionary/reference) | Authoritative field meanings when ambiguous — same role as NewsAPI [data models](https://newsapi.ai/documentation?tab=data_models). |
| [Pagination](https://docs.x.com/x-api/fundamentals/pagination) | `next_token` / page size for poll loops. |
| [Metrics](https://docs.x.com/x-api/fundamentals/metrics) | Which metric families exist (public vs organic vs non-public / promoted). |
| [Usage & billing (post-cap)](https://docs.x.com/x-api/fundamentals/post-cap) | Cost model (pay-per-post); ops constraint for poll design. |
| [Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits) | Caps the poll cadence; belongs in ops, not only endpoint tables. |

### Ops notes only (thin links — do not walk page-by-page)

| Doc | Role |
| --- | --- |
| [Overview](https://docs.x.com/x-api/overview) | One-time product surface map. |
| [Data dictionary overview](https://docs.x.com/x-api/fundamentals/data-dictionary) | Object graph (Post ↔ User ↔ Media); orient once, then use the reference. |
| [Response codes and errors](https://docs.x.com/x-api/fundamentals/response-codes-and-errors) | Retry / auth / 429 behavior — one ops subsection when we write it. |
| [Consistency](https://docs.x.com/x-api/fundamentals/consistency) | Polling caveat (search vs timelines can lag) — one sentence in ingest ops. |

### Explicitly out of the contract’s reference set (for now)

| Doc | Why out |
| --- | --- |
| [Post annotations](https://docs.x.com/x-api/fundamentals/post-annotations) | Entity/context tags are a product choice (Tempo-owned themes vs vendor labels). Revisit only if we mark annotation fields `in` on an endpoint. |
| [Conversation ID](https://docs.x.com/x-api/fundamentals/conversation-id) | Thread reconstruction. Defer until we lock reply/quote handling. |
| [Versioning](https://docs.x.com/x-api/fundamentals/versioning) | Lock “X API v2” in one line elsewhere; the full page does not change field decisions. |
| [Edit posts](https://docs.x.com/x-api/fundamentals/edit-posts) | Edit history is edge-case for a ~60‑min poll unless we later decide to track edits. |

### Decision log

| Date | Change | Why |
| --- | --- | --- |
| 20 Sep 2026 | Locked vendor reference set | Same practice as NewsAPI: small working set for fields/ops; dictionaries as reference-only; annotations / conversation / versioning / edits deferred until an endpoint forces them. |

---

## Endpoints

**Section status:** locked for v0 include/exclude (20 Sep 2026). Field tables locked for all `in` endpoints: [Search posts recent](#search-posts-recent), [Get users posts](#get-users-posts), [Get users by usernames](#get-users-by-usernames), [Batch compliance jobs](#batch-compliance-jobs).

**v0 retrieval model:** poll (**60 min** MVP shared clock) — **not** filtered stream / webhooks. Post detail for Tempo comes from fields + expansions on the poll responses. **Exception:** [Get posts by ids](https://docs.x.com/x-api/posts/get-posts-by-ids) for the one-time edit re-read while a post is still inside the edit window. Removals: batch **Compliance** jobs on the shared clock.

### `in` (v0)

| Family | Endpoint | Tempo job |
| --- | --- | --- |
| Posts / search | [Search posts recent](https://docs.x.com/x-api/posts/search-recent-posts) | Open-search lane — shared keyword / topic / geo queries → posts into the pool |
| Posts / timelines | [Get users posts](https://docs.x.com/x-api/users/get-posts) | `post_download` handles only — new posts from that handle into the pool |
| Users / lookup | [Get users by usernames](https://docs.x.com/x-api/users/get-users-by-usernames) | Sole resolve path — `@handle`(s) → user id(s) before timelines (1–100 per call; chunk if larger) |
| Posts / lookup | [Get posts by ids](https://docs.x.com/x-api/posts/get-posts-by-ids) | **Edit re-read only** (not general hydrate). Tempo job cadence + eligibility: [ingestion IR-14](../../../02-product/contracts/ingestion.md) — ~10–15 min over `published_at` still inside ~30‑min window; replace `text`. |
| Compliance | [Batch compliance](https://docs.x.com/x-api/compliance/batch-compliance/introduction) (`POST/GET/DELETE /2/compliance/jobs`) | Shared-clock: upload stored post ids + watched/author user ids; apply results ([field table](#batch-compliance-jobs)). `delete` → pool drop; `rehydrate` → [IR-14](../../../02-product/contracts/ingestion.md) / Get posts by ids (not this table’s apply); `scrub_geo` → no-op (we don’t store post geo). Confirm pricing; if per-ID billed, daily. |

### `later`

| Family | Endpoint | Why later |
| --- | --- | --- |
| Posts / timelines | [Get users mentions](https://docs.x.com/x-api/users/get-mentions) | Different job (posts *about* an account); high volume / post-cap; open search can cover when needed |
| Users / search | [Search users](https://docs.x.com/x-api/users/search-users) | Settings/autocomplete discovery, not the poll loop |
| Trends | [Get trends by woeid](https://docs.x.com/x-api/trends/get-trends-by-woeid) | Ambient trends ≠ configured beat; Tempo owns ranking from ingested content |

### `out`

| Family | Endpoint | Why out |
| --- | --- | --- |
| Posts / search | [Search posts all](https://docs.x.com/x-api/posts/search-all-posts) | Full-archive / Enterprise; no historical backfill in this contract |
| Posts / counts | [Get posts counts all](https://docs.x.com/x-api/posts/get-count-of-all-posts) | Analytics counts, not content ingest |
| Posts / counts | [Get posts counts recent](https://docs.x.com/x-api/posts/get-count-of-recent-posts) | Same |
| Posts / filtered stream | [Stream filtered posts](https://docs.x.com/x-api/stream/stream-filtered-posts) | v0 is poll, not stream |
| Posts / filtered stream | [Get filtered-stream rules](https://docs.x.com/x-api/stream/get-stream-rules) | Stream family |
| Posts / filtered stream | [Get rule counts](https://docs.x.com/x-api/stream/get-stream-rule-counts) | Stream family |
| Posts / filtered stream | [Update stream rules](https://docs.x.com/x-api/stream/update-stream-rules) | Stream family |
| Posts / timelines | [Get users timeline](https://docs.x.com/x-api/users/get-timeline) | Authenticated home feed, not a monitored handle |
| Posts / lookup | [Get post by id](https://docs.x.com/x-api/posts/get-post-by-id) | Same |
| Posts / bookmarks | Bookmarks family (get / create / delete / folders) | Not ingest; user-state write/read |
| Posts / manage | [Create post](https://docs.x.com/x-api/posts/create-post) / [Delete post](https://docs.x.com/x-api/posts/delete-post) | Write path; Tempo does not publish |
| Posts / reposts | Reposts family (get / repost / unrepost / of me) | Engagement graph / write; quote/repost *content* arrives via poll + expansions when needed |
| Posts / quotes | [Get posts quoted posts](https://docs.x.com/x-api/posts/get-quoted-posts) | Same |
| Posts / hide replies | [Hide reply](https://docs.x.com/x-api/posts/hide-reply) | Moderation write |
| Articles | Create draft / publish article | Write path; not social ingest |
| Users / lookup | [Get users by id](https://docs.x.com/x-api/users/get-user-by-id) / [Get users by ids](https://docs.x.com/x-api/users/get-users-by-ids) | Username batch resolve covers allowlist; id lookup unused |
| Users / lookup | [Get users by username](https://docs.x.com/x-api/users/get-user-by-username) | Redundant — batch accepts 1–100; use [Get users by usernames](#get-users-by-usernames) |
| Users / lookup | [Get users me](https://docs.x.com/x-api/users/get-my-user) | App identity, not monitored sources |
| Users / follows | [Get users followers](https://docs.x.com/x-api/users/get-followers) | Graph crawl; soft priors come from post + user `public_metrics` on poll/resolve, not follower lists |
| Users / follows | [Get users following](https://docs.x.com/x-api/users/get-following) / follow / unfollow | Graph / write |
| Users / mutes · blocks · affiliates | Mute / unmute / muting / blocking / affiliates | Account-state, not ingest |
| Direct messages | Entire DM manage / lookup / blocks family | Private messaging; out of Tempo scope |
| Likes | Liked posts / liking users / like / unlike | Engagement graph / write |
| Lists | Entire lists lookup / manage / members / pinned family | List surfaces not in v0 ingest model |
| Spaces | Entire family | Not post ingest |
| Communities | Entire family | Not post ingest |
| Community notes | Entire family | Not post ingest |
| News | [Get news stories by id](https://docs.x.com/x-api/news/get-news-stories-by-id) / [Search news](https://docs.x.com/x-api/news/search-news) | Second news corpus; news lane is NewsAPI.ai Stream |
| Media | Entire family | Upload/manage; not ingest |
| X activity | Entire family | Not ingest |
| Stream connections | Entire family | Stream ops |
| Compliance | Streams / other than batch jobs | Enterprise streams not in MVP; batch jobs are `in` above |
| Webhooks | Entire family | v0 is poll, not push |

### Usage (ops note — still `out`)

| Endpoint | Status | Note |
| --- | --- | --- |
| [Get usage](https://docs.x.com/x-api/usage/get-usage) | `out` | Not ingest. Revisit for billing/health observability when we build cost checks against [post-cap](https://docs.x.com/x-api/fundamentals/post-cap). |
| [Get usage credits](https://docs.x.com/x-api/usage/get-usage-credits) | `out` | Same |

### Decision log (endpoint matrix)

| Date | Change | Why |
| --- | --- | --- |
| 20 Sep 2026 | Locked v0 `in`: recent search, user posts, usernames batch lookup | Shared pool = handles + open search; poll not stream |
| 20 Sep 2026 | Mentions / search users / trends → `later`; followers / X news / post lookup → `out` | Mentions & trends are different jobs; graph & X news fight Tempo layers; post detail = poll fields |
| 20 Sep 2026 | Usage endpoints `out` with ops note | Keep cost APIs visible without expanding ingest scope |
| 20 Sep 2026 | Single username lookup → `out`; batch sole resolve | Batch accepts 1–100; chunk allowlists larger than 100 |
| 27 Oct 2026 | Batch compliance jobs `in`; Get posts by ids `in` for edit re-read only | Honor delete/protect/suspend; edits need a re-read within the edit window |
| 28 Oct 2026 | Edit re-read cadence owned by ingestion IR-14 | ~10–15 min job (not 60‑min clock); eligibility from `published_at`; no extra `x_posts` column |
| 28 Oct 2026 | Batch compliance field table locked | Verified against docs.x.com batch-compliance guides + OpenAPI `ComplianceJob`; see [Batch compliance jobs](#batch-compliance-jobs) |
| 27 Oct 2026 | Post lookup not a general hydrate path | Poll fields remain SoT for first store |

---

## Batch compliance jobs

> **Docs:** [Introduction](https://docs.x.com/x-api/compliance/batch-compliance/introduction) · [Quickstart](https://docs.x.com/x-api/compliance/batch-compliance/quickstart) · [Integration guide](https://docs.x.com/x-api/compliance/batch-compliance/integrate) · API: [Create](https://docs.x.com/x-api/compliance/create-compliance-job) · [Get by id](https://docs.x.com/x-api/compliance/get-compliance-job-by-id) · [List](https://docs.x.com/x-api/compliance/get-compliance-jobs)  
> **OpenAPI:** `ComplianceJob` / `CreateComplianceJobsRequest` (`GET https://api.x.com/2/openapi.json`)  
> **Section status:** locked for v0 job object + flow (28 Oct 2026). Verified from docs.x.com markdown alternates + OpenAPI (docs HTML/WebFetch often 403; `.md` + OpenAPI OK).

**Tempo job:** On the shared clock (IR-07; daily if per-ID pricing): create job(s) → upload id file → poll until terminal → download NDJSON → apply to pool. Persist job rows on `x_compliance_jobs`. **Do not** persist upload id lists or result payloads.

**Flow (vendor):**

1. `POST /2/compliance/jobs` with `type` (`tweets` | `users`) + optional `name` (≤64).
2. `PUT` plain-text IDs (one per line, ≤100 MB decompressed; optional `Content-Encoding: gzip`) to `upload_url` **with Bearer** (~15 min window).
3. Poll `GET /2/compliance/jobs/:id` until `complete` / `failed` / `expired` (backoff ~30–60s; processing ceiling ~36h → `failed`).
4. On `complete`, `GET` `download_url` **with Bearer** (~7 day window); NDJSON results.
5. Optional: `DELETE /2/compliance/jobs/:id` to cancel `created` / `in_progress` and free the one-active-job slot.

**Ops**

| Rule | Detail |
| --- | --- |
| Concurrency | **One active** (`created` or `in_progress`) job **per type**; `tweets` and `users` may run concurrently; second create → `409` |
| Upload expiry | ~15 minutes from create (`upload_expires_at`); not refreshable — cancel + recreate |
| Download expiry | ~7 days from create (`download_expires_at`); download promptly |
| Auth on byte paths | Signed `upload_url` / `download_url` **require** `Authorization: Bearer` (migration from old GCS pre-signed URLs) |
| Absence in results | ID missing from NDJSON ⇒ **no action** (clean) |
| `resumable` | Create body flag exists in OpenAPI; integration guide: **no** resumable/chunked upload — send whole PUT or cancel/retry. **Do not persist** |

### Create body

| Field | Status | Tempo use |
| --- | --- | --- |
| `type` | `in` | Required. `tweets` = stored `x_posts.post_id`s; `users` = author / watched `x_user_id`s |
| `name` | `in` | Optional label (≤64); store on `x_compliance_jobs.name` |
| `resumable` | `out` | Unused — no chunked upload in current integrate guide |

### ComplianceJob object (create/get/list `data`)

| Field | Status | Tempo column / use |
| --- | --- | --- |
| `id` | `in` | `x_compliance_jobs.vendor_job_id` (PK) |
| `type` | `in` | `type` (`tweets` \| `users`) |
| `status` | `in` | `status` — see enum below |
| `name` | `in` | `name` |
| `upload_url` | `in` | `upload_url` (secret; do not log) |
| `upload_expires_at` | `in` | `upload_expires_at` |
| `download_url` | `in` | `download_url` (secret; do not log) |
| `download_expires_at` | `in` | `download_expires_at` |
| `created_at` | `in` | `vendor_created_at` |
| `resumable` | `out` | Do not persist |
| — | Tempo | `results_applied_at` when NDJSON applied to pool; `updated_at` |

**Status values** (quickstart job-status table; list filter OpenAPI enum is the same four plus docs also document `expired`):

| Status | Meaning |
| --- | --- |
| `created` | Awaiting upload |
| `in_progress` | Processing |
| `complete` | Results ready |
| `failed` | Failed (incl. ~36h ceiling) |
| `expired` | Expired before completion (e.g. `created` without timely upload) |

List filter query `status` OpenAPI enum today: `created` \| `in_progress` \| `failed` \| `complete` (no `expired` filter) — still **store** `expired` when GET-by-id returns it.

### Results NDJSON (download — do not persist file)

| `action` | Typical `reason` | Tempo apply |
| --- | --- | --- |
| `delete` | `deleted` | Soft-remove story → `story_removal_reason = compliance_delete` |
| `delete` | `protected` | → `compliance_protect` |
| `delete` | `suspended` | → `compliance_suspend` |
| `delete` | `deactivated` | → `compliance_delete` (account gone) |
| `rehydrate` | `tweet_edited` | **Not** a pool drop — refresh text via Get posts by ids / IR-14 path |
| `scrub_geo` | `geo_scrubbed` | **No-op** in v0 (keep-list has no post geo) |
| error row | `invalid_id` | Log; ignore |

User-type jobs: same `delete` + reason pattern for account delete/protect/deactivate/suspend → drop that author’s stored posts (map reasons as above). Highest-impact wins when multiple events exist (`delete` > `rehydrate` > `scrub_geo`).

### `compliance_job.fields` (optional sparse get/list)

Wire enum: `created_at`, `download_expires_at`, `download_url`, `id`, `name`, `resumable`, `status`, `type`, `upload_expires_at`, `upload_url`. Tempo requests the full job object (default) — no need to sparse-field in v0.

### Decision log

| Date | Change | Why |
| --- | --- | --- |
| 28 Oct 2026 | Locked ComplianceJob field table + result actions | Close rigor gap vs Search/timelines; verified docs.x.com + OpenAPI |
| 28 Oct 2026 | `expired` status kept on `x_compliance_jobs` | Documented in quickstart status table |
| 28 Oct 2026 | `resumable` out of persist | Integrate: no chunked upload |
| 28 Oct 2026 | `rehydrate` ≠ compliance remove | Routes to post lookup / IR-14; edits are not deletes |

---

## Search posts recent

**Section status:** locked for v0 request + consume fields (20 Sep 2026).

**Endpoint:** `GET https://api.x.com/2/tweets/search/recent`  
**Docs:** [Search Posts Recent](https://docs.x.com/x-api/posts/search-recent-posts)

**Tempo job:** Poll the shared term query for handles whose `fetch_mode` is `word_search`. Persist posts once; tag and personalize in Tempo.

**Param name note:** Current OpenAPI uses `post.fields` and expansion `referenced_posts`. Older docs/clients used `tweet.fields` / `referenced_tweets`. This contract locks the **current** names; verify wire aliases at implement time.

**Vendor mutual exclusions:** at most one of `start_time` / `since_id`; at most one of `end_time` / `until_id`; at most one of `pagination_token` / `next_token`.

### Ops (not request fields)

| Rule | Detail |
| --- | --- |
| Auth | Bearer (app-only) `in` |
| Steady poll | `since_id` = prior `meta.newest_id`; omit `start_time` / `end_time` / `until_id` |
| Bootstrap / lost cursor | `start_time` only (e.g. now − poll window); must be within last **7 days** |
| Within-poll pages | Repeat with same query + same cursor + `next_token` until no token |
| Cost | Pay-per-use: ~**$0.005 / post returned**, ~**$0.010 / user** in `includes` — verify [console](https://developer.x.com) / [Usage & Billing](https://docs.x.com/x-api/fundamentals/post-cap). Same post same day typically deduped once. |
| Deeplink out | Build `https://x.com/{username}/status/{id}` (or `/i/web/status/{id}`) — **not** from `entities` |

### Query parameters

| Field | Status | Tempo use |
| --- | --- | --- |
| `query` | `in` (required) | Shared keyword / topic / geo search string Tempo builds |
| `max_results` | `in` = **100** | Page size (vendor max); cost scales with posts returned |
| `since_id` | `in` (steady poll) | Only posts newer than last seen id |
| `start_time` | `in` (bootstrap only) | Time lower bound when no id cursor exists |
| `next_token` | `in` (within poll) | Next page of the same search |
| `end_time` | `out` | Steady poll defaults upper bound ≈ now |
| `until_id` | `out` | Upper id bound — not the poll cursor |
| `pagination_token` | `out` | Alias of `next_token`; use one |
| `sort_order` | `out` | Default recency; Tempo ranks later |

### `post.fields`

| Field | Status | Tempo use |
| --- | --- | --- |
| `id` | `in` | Dedupe + cursors + deeplink |
| `text` | `in` | Post body |
| `created_at` | `in` | Publish time |
| `lang` | `in` | Detected language |
| `author_id` | `in` | Join to author in `includes` (may be default on wire — still required for Tempo) |
| `public_metrics` | `in` | Soft engagement prior (likes / reposts / replies / quotes) |
| `entities` | `later` | In-post URLs / hashtags / mentions — not required for deeplink |
| `geo` | `later` | Sparse author geo; best-effort |
| `referenced_posts` | `later` | Quote / reply / repost parents (needs expansion) |
| `conversation_id` | `later` | Thread root — only if we build thread views |
| `attachments` | `out` | Media/poll keys; deferred with media |
| `context_annotations` | `out` | Vendor topic labels; Tempo owns themes |
| `non_public_metrics` / `organic_metrics` / `promoted_metrics` | `out` | Elevated/ads access; not app-only search |
| `article` / `article_title` / `card_uri` / `suggested_source_*` | `out` | Long-form / card / niche |
| `community_id` / `note_post` / `matched_media_notes` / `note_request_suggestions` | `out` | Surfaces we excluded at endpoint level |
| `edit_controls` / `source` / `reply_settings` / `scopes` / `withheld` / `possibly_sensitive` / `paid_partnership` / `display_text_range` / `media_metadata` | `out` | Not needed for v0 ingest → meta-stories |

### `expansions`

| Expansion | Status | Tempo use |
| --- | --- | --- |
| `author_id` | `in` | Author object in `includes` (required for handle + user metrics) |
| `referenced_posts` | `later` | Parent posts in `includes` |
| `attachments.media_keys` | `out` | Media objects — text-first v0 |
| `geo.place_id` | `later` | Place object when geo is used |
| `entities.mentions.username` / `in_reply_to_user_id` / poll / article / edit history | `out` | Extra hydration not needed yet |

### `user.fields` (requires `expansions=author_id`)

| Field | Status | Tempo use |
| --- | --- | --- |
| `id` | `in` | Author user id |
| `username` | `in` | `@handle` + deeplink |
| `name` | `in` | Display name |
| `public_metrics` | `in` | Soft author-influence prior (followers etc.) |
| `verified` / `verified_type` | `later` | Checkmark flavor |
| `profile_image_url` / `description` / `location` / `url` | `later` | Profile chrome for UI |
| All other user fields | `out` | Irrelevant to shared-pool ingest |

### Nested field params (whole family)

| Param | Status | Why |
| --- | --- | --- |
| `media.fields` | `out` | Deferred with media expansion |
| `poll.fields` | `out` | Not ingest priority |
| `place.fields` | `later` | Only with `geo.place_id` |

### Response `meta` (consume)

| Field | Status | Tempo use |
| --- | --- | --- |
| `newest_id` | `in` | Next poll’s `since_id` |
| `next_token` | `in` | Continue paging inside this poll |
| `result_count` | `in` | Ops / diagnostics |
| `oldest_id` | `in` | Ops / diagnostics |

### Decision log

| Date | Change | Why |
| --- | --- | --- |
| 20 Sep 2026 | Locked Recent Search fields | Open-search poll: `since_id` + bootstrap `start_time`; `max_results` 100; author expansion + post/user `public_metrics` as soft priors; media/entities/annotations out or later |
| 20 Sep 2026 | `entities` stays `later` | Deeplink = `id` + `username`, not in-post entity URLs |
| 20 Sep 2026 | User `public_metrics` `in` | Soft handle-influence prior alongside post engagement |

---

## Get users posts

**Section status:** locked for v0 request + consume fields (20 Sep 2026).

**Endpoint:** `GET https://api.x.com/2/users/:id/tweets`  
**Docs:** [Get Users Posts](https://docs.x.com/x-api/users/get-posts)

**Tempo job:** Poll new posts from each handle whose `fetch_mode` is `post_download`. Persist once; tag and personalize in Tempo. Requires prior username → id resolve. Handles in `word_search` do not use this endpoint.

**Param name note:** Same as Recent Search — lock current OpenAPI names (`post.fields`, `referenced_posts`); verify `tweet.fields` aliases at implement time.

**Vendor constraints:** When both provided, `start_time` must be earlier than `end_time`; `since_id` must be less than `until_id`.

**Parity:** `post.fields`, `expansions`, `user.fields`, nested families, and `meta` consume match [Search posts recent](#search-posts-recent) unless noted below.

### Ops (not request fields)

| Rule | Detail |
| --- | --- |
| Auth | Bearer (app-only) `in` |
| Path | `id` = numeric user id from [Get users by usernames](#get-users-by-usernames) |
| Steady poll | Per-handle `since_id` = that handle’s prior `meta.newest_id` |
| Bootstrap / lost cursor | `start_time` = now − poll window (do **not** backfill to 2010) |
| Within-poll pages | Request `pagination_token` = prior `meta.next_token` until empty |
| Exclude | `exclude=retweets` — drop pure reposts of others; do **not** exclude replies |
| History window | Unlike Recent Search’s 7‑day cap, timelines allow `start_time` back to **2010-11-06** — still only use the poll window for bootstrap |
| Cost | Same pay-per-use as search (~$0.005/post; ~$0.01/user in includes — usually one author) |
| Deeplink out | `https://x.com/{username}/status/{id}` — not from `entities` |

### Path / query parameters

| Field | Status | Tempo use |
| --- | --- | --- |
| `id` (path) | `in` (required) | Watched user’s numeric id |
| `max_results` | `in` = **100** | Page size (vendor max 100, min 5) |
| `since_id` | `in` (steady poll) | Only posts newer than last seen for this handle |
| `start_time` | `in` (bootstrap only) | Time lower bound when no id cursor |
| `pagination_token` | `in` (within poll) | Next page (value from `meta.next_token`) |
| `exclude` | `in` = **`retweets`** | Drop retweets; keep original posts and the account’s replies |
| `end_time` | `out` | Steady poll defaults upper bound ≈ now |
| `until_id` | `out` | Upper id bound — not the poll cursor |
| `exclude=replies` | `out` | Do not pass — replies from the account can be substantive |

### `post.fields` / `expansions` / `user.fields` / nested / `meta`

Identical to [Search posts recent](#search-posts-recent):

| Area | `in` | Notes |
| --- | --- | --- |
| `post.fields` | `id`, `text`, `created_at`, `lang`, `author_id`, `public_metrics` | `entities` / `geo` / `referenced_posts` / `conversation_id` → `later`; media/annotations/ads metrics/etc. → `out` |
| `expansions` | `author_id` | `referenced_posts` / `geo.place_id` → `later`; media → `out` |
| `user.fields` | `id`, `username`, `name`, `public_metrics` | Author is always this handle; expansion still refreshes handle + soft influence prior |
| Nested | — | `media.fields` / `poll.fields` → `out`; `place.fields` → `later` |
| `meta` | `newest_id`, `next_token`, `result_count`, `oldest_id` | Store `newest_id` **per handle** |

### Decision log

| Date | Change | Why |
| --- | --- | --- |
| 20 Sep 2026 | Locked Get users posts fields | Handle-lane poll; field parity with Recent Search; `exclude=retweets` only; `pagination_token` for pages; per-handle `since_id` |

---

## Get users by usernames

**Section status:** locked for v0 request + consume fields (20 Sep 2026).

**Endpoint:** `GET https://api.x.com/2/users/by`  
**Docs:** [Get Users by Usernames](https://docs.x.com/x-api/users/get-users-by-usernames)

**Tempo job:** Sole resolve path — map shared allowlist `@handle`(s) → numeric user id(s) (+ display name, soft influence metrics, protected flag) before [Get users posts](#get-users-posts). Not a content poll.

**Companion:** [Get users by username](https://docs.x.com/x-api/users/get-user-by-username) is **`out`** — batch accepts 1–100 names, including a single handle.

### Ops (not request fields)

| Rule | Detail |
| --- | --- |
| Auth | Bearer (app-only) `in` |
| Chunking | Vendor max **100** usernames per call. Allowlists larger than 100 → normalize/dedupe, split into chunks of ≤100, call once per chunk, merge results (e.g. 110 → chunks of 100 + 10) |
| Cache | Username → id is stable; cache aggressively; refresh `public_metrics` on a slower cadence if desired |
| Cost | ~**$0.010 / user returned** (User: Read) — verify [console](https://developer.x.com) / [Usage & Billing](https://docs.x.com/x-api/fundamentals/post-cap) |
| Partial failure | Unknown/suspended handles may appear in response `errors` while others succeed — mark broken handles; do not abort the whole allowlist |
| Expansions | Do **not** expand pinned/recent posts — content comes from timelines |

### Query parameters

| Field | Status | Tempo use |
| --- | --- | --- |
| `usernames` | `in` (required) | Comma-separated handles without `@` (1–100; pattern letters/numbers/`_`, ≤15 chars each) |

### `user.fields`

| Field | Status | Tempo use |
| --- | --- | --- |
| `id` | `in` | Numeric id for Get users posts path |
| `username` | `in` | Canonical `@handle` + deeplink |
| `name` | `in` | Display name |
| `public_metrics` | `in` | Soft influence prior at resolve time |
| `protected` | `in` | Locked account — timeline may be unavailable |
| `verified` / `verified_type` | `later` | Checkmark flavor for UI |
| `profile_image_url` / `description` / `location` / `url` / `created_at` | `later` | Profile chrome |
| All other user fields | `out` | Not needed to resolve + poll |

### `expansions` / `post.fields`

| Item | Status | Why |
| --- | --- | --- |
| `expansions=pinned_post_id` | `out` | Hydrates pinned post — not resolve; costs a post read |
| `expansions=most_recent_post_id` | `out` | Content belongs on timelines |
| `expansions=affiliation` | `out` | Org graph — not v0 |
| `post.fields` (whole param) | `out` | Only useful with pinned/recent expansions |

### Decision log

| Date | Change | Why |
| --- | --- | --- |
| 20 Sep 2026 | Locked Get users by usernames fields; single username `out` | Batch is sole resolve path; chunk >100; `id`/`username`/`name`/`public_metrics`/`protected` `in`; no post expansions |
