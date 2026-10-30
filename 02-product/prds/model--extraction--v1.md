# Extraction model — structured scope from blurbs

Turn onboarding and Account Context blurbs into structured watch-scope Tempo can store, confirm (onboarding), merge (Account), and use for retrieval.

Status: Draft  
Owner: Felipe  
Update: 26 Oct 26  
Intent: ship  

**Thin ship shell.** Do not duplicate lane rules, prompt text, or gold — change those in the SoTs below first. This PRD owns **invoke contract**, build deltas vs live legacy, and ship sequencing. UX chrome lives in sibling PRDs.

**SoT (behavior — not a second copy here)**

- Product contract: [Extraction](../contracts/extraction.md)
- Prompt: [extraction.md](../../06-engineering/docs/prompts/extraction.md) (`extraction-v1`)
- Pipeline: [extraction.md](../../06-engineering/docs/pipelines/extraction.md)
- Runs schema: [extraction-runs.dbml](../../06-engineering/docs/data/extraction-runs.dbml) · [Extraction runs](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d)
- Evals / gold: [extraction.md](../../06-engineering/docs/evals/extraction.md) · [extraction.gold.json](../../06-engineering/docs/evals/extraction.gold.json)
- Build handoff: [extraction-build-handoff.md](../../06-engineering/docs/evals/extraction-build-handoff.md)
- Product data: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)

**Sibling UX**

- Onboarding (Build → extract → Review): [onboarding--v1.md](./onboarding--v1.md)
- Account (Context Save → rebuild, no Review): [account--v1.md](./account--v1.md)

**Walk status:** **UX/UI invoke** + **`extraction_runs`** + **Identity** + **priorities topics/keywords** + **geographies** + **stakeholders** + **sources** + **chip-acceptance guardrail** (22 Oct 26) + **gold cases** (24 Oct 26). `function_label` is chosen from live `functions.name` or omitted. v1 seed: `communications`, `policy`, `operations`, `partnerships` (24 Oct 26). Stakeholder mentions are every distinct class the blurb states. 24 cases are locked in [extraction.gold.json](../../06-engineering/docs/evals/extraction.gold.json). `extraction_invoke` is specified (24 Oct 26). Remaining: an advisory gold pass once a runner scores `extraction-v1` against that file.

**Ops pricing:** [07-ops/model-pricing.json](../../07-ops/model-pricing.json) (SoT) · runtime copy under API `pricing/model-prices.json` · weekly Slack review → `#ops-pricing-models`.

**Ops extraction identity:** `#model-extraction-organization` · `#model-extraction-function` · `#model-extraction-role` (`tempo-comms.slack.com`) — secrets on Actions; mirror to API/Vercel when the resolve write path posts.

---

## Problem

**Primary user:** p1 — solo bilateral/comms operator ([Personas](../../01-research/personas.md)).

**Pain:** Scope is expressed as free-text blurbs. Tempo cannot monitor from prose alone; it must derive structured facets **without inventing** watch scope the user did not state ([pp2](../principles.md)).

**Why now:** Onboarding and Account CTAs are locking write→invoke; live code still runs legacy single-narrative extraction. Ship must reconcile runtime to five-lane `extraction-v1` without dual SoTs.

### Runtime gap (current vs target)

| Dimension | Live today | Target (this PRD + SoTs) |
| --- | --- | --- |
| Trigger | `PUT /api/settings` + `onboardingRawText` (post-save, non-fatal) | Explicit Build / Build anyway / Context Save / Retry only |
| Input | One narrative blob | Five lane blurbs (omit empty) |
| Prompt | `extract-v8` in `onboarding-extractor.mjs` | `extraction-v1` prompt SoT |
| Output | Flat T/K/G/sources arrays | Lane-keyed JSON (+ identity / stakeholders) |
| Review | None (merge into settings) | **Onboarding:** O5 required before live · **Account:** no Review; merge live |
| Lineage | None | `extraction_runs` per attempt ([runs ERD](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d)) |
| SKUs (defaults) | Opus 4.7 → Sonnet 4.6 in code | Opus 5.5 → Sonnet 5.5 (D-073); cutover after gold |

---

## Goals

- Explicit commit of blurbs then one multi-lane extraction invoke produces structured scope for Review (onboarding) or live merge (Account).
- Fail closed: write failure ⇒ no invoke; extract failure ⇒ no fake success chips; Retry re-invokes with correct `trigger_kind` / `trigger_id`.
- Chip-acceptance guardrail (onboarding Review): precision and recall per shelf, below. Baseline and target are `PM input required` — no committed accepts yet.
- Gold quality: 24 cases are locked in [extraction.gold.json](../../06-engineering/docs/evals/extraction.gold.json). Rules stay in the [eval SoT](../../06-engineering/docs/evals/extraction.md). Advisory precision and recall wait until a runner scores `extraction-v1` against that file. Examples stay in the eval file.

---

## Solution

### Overview

Five optional blurbs → **write** to Database library blurb tables → **one** LLM call on filled lanes (`extraction-v1`) → hygiene/resolve → **onboarding Review** or **Account merge** (no second Review). Attempt lineage in Extraction runs. Chip memberships stay in Database library.

### User flow (invoke — UX locked)

Blurb columns ([Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)):

| Field | Table · column |
| --- | --- |
| Your role and organization | `user_role_organization.blurb` |
| Your priorities | `user_priorities.blurb` |
| Your organization's priorities | `user_organization_priorities.blurb` |
| Your stakeholders | `user_stakeholders.blurb` |
| Your sources | `user_sources.blurb` |

**Order (always):** write blurbs (empty → `NULL`) → then invoke. **Atomic write:** any lane write failure ⇒ whole commit failed ⇒ **do not** invoke.

| CTA / land | Surface | Persist blurbs? | Invoke? | `trigger_kind` | `trigger_id` |
| --- | --- | --- | --- | --- | --- |
| **Build my scope →** (complete path; e.g. o03f) | Onboarding | Yes (all five) | Yes | `build` | **New** |
| **Build anyway** (o03g) | Onboarding | Yes (filled; empty → `NULL`) | Yes | `build` | **New** |
| Incomplete **Build my scope** (o03a–e) | Onboarding | **No** — opens o03g first | No | — | — |
| **Try again →** (o04a) | Onboarding extract fail | Already stored | Yes | `retry` | **Same** as failed `build` |
| **Save →** (Account Context a03a / a03f) | Account | Yes (all five) | Yes | `rebuild` | **New** |
| **Try again** (a03g, `fail_kind=write`) | Account | Re-write then… | …then yes | `rebuild` | **New** |
| **Try again** (a03g, `fail_kind=extract`) | Account | Already stored | Yes | `retry` | **Same** as failed `rebuild` |

**Primary → fallback** within one invoke: same `trigger_id` (and same parent `trigger_kind`).

**After success**

| Surface | Next |
| --- | --- |
| Onboarding | O5 Review required before scope live ([onboarding--v1.md](./onboarding--v1.md)) |
| Account | Merge into live chips; no Review; operator prunes in Tags ([account--v1.md](./account--v1.md)) |

**a03g (Account fail):** one screen, dual-mode. Client holds `fail_kind: write \| extract` (not a DB column). MVP copy: **one generic** fail line. Chrome owned by Account PRD.

**`accepted_at` (runs):** onboarding = **Start monitoring** warm-accept (scope confirmed; any O5 state where gate is met); Account = **successful merge** after extract for that `trigger_id` (not Save click).

### Data — `extraction_runs` (locked)

One row per LLM **attempt**. Product chips stay in Database library. Push [Extraction runs](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d) when migrating.

| Field | Lock |
| --- | --- |
| Grain | Per attempt; primary + fallback + retry share `trigger_id` when same user intent; new `trigger_id` on each `build` / `rebuild` |
| `input_hash` | SHA-256 of canonical **filled-blurb** user payload (omit empty); excludes system prompt (`prompt_version` covers that) |
| `estimated_cost_usd` | `tokens ×` [07-ops/model-pricing.json](../../07-ops/model-pricing.json) at write time; **null** if `model_id` missing from catalog; no per-run web fetch |
| `error_kind` | Closed enum: `timeout` · `provider_http_error` · `provider_error` · `config_error` · `schema_error` · `empty_response` · `unknown` |
| `accepted_at` | See above |

### Metrics — chip acceptance (locked)

Onboarding guardrail for Topics, Keywords, Geographies, Press, and Platforms. It measures whether the operator kept the proposal. It is not an eval, and it is not the product primary metric. Stakeholders, identity, and Account merge are out. A removed proposal is not inserted, so the account keeps the chips that feed metastories, and memberships cannot reconstruct this delta.

| Metric | Definition | Baseline | Target | Window | Source of truth |
| --- | --- | --- | --- | --- | --- |
| Precision, per shelf | `kept / (kept + removed)`. Absent when that shelf proposed nothing | None yet | PM input required | One successful onboarding commit | PostHog `extraction_chip_acceptance` |
| Recall, per shelf | `kept / (kept + added)`. Absent when that shelf is empty at accept | None yet | PM input required | Same | Same |

| Rule | Lock |
| --- | --- |
| When it fires | Once, when the warm trigger commits: **Start monitoring** succeeds, or **Try again** on o05e succeeds. A failed Try again does not fire. **Build my scope**, **Build anyway**, and o04a **Try again** start an extract; they do not start this metric |
| Proposed set | Chips on screen when that successful extract first lands on Review |
| Accepted set | Chips still on screen at commit |
| Grain | One normalized label per shelf. The same label from both priority blurbs counts once |
| Counts | `kept` = proposed and accepted. `removed` = proposed and absent. `added` = accepted and not proposed |
| Event properties | `trigger_id`, `prompt_version`, `model_id` of the attempt that produced the draft, `review_state` at landing (`empty` · `missing_sources` · `missing_facets` · `thin` · `ready`), and `kept` / `removed` / `added` for each shelf |
| Left out of the event | Chip text. F1. All-shelf totals. F1 and sums can be charted from the counts |
| Not stored on | `extraction_runs`. That row is the model attempt. These counts exist only at commit |

### Metrics — extract invoke (locked)

PostHog event for a finished model invoke. It records that the attempt finished, including when the person never commits Review. It is not chip acceptance, and it is not a quality score. It does not wait for the `extraction_runs` table. A write failure does not call the model, so it does not emit this event.

| Rule | Lock |
| --- | --- |
| When it fires | Once, when a model invoke finishes, on success or fail. Onboarding and Account. A retry is a new event with the same `trigger_id` |
| Event | `extraction_invoke` |
| Properties | `trigger_id`. `trigger_kind`: `build`, `rebuild`, or `retry`. `surface`: `onboarding` or `account`. `outcome`: `success` or `fail`. `prompt_version`. `model_id` of the attempt the person got. `error_kind` only when `outcome` is `fail`, from the closed enum above |
| Left out | Chip counts, chip text, a quality score, and Account `fail_kind` |
| Wiring | Specified, not instrumented. Baseline and target are `PM input required` |

### Data — Identity / `user_role_organization` (locked)

One row per user (`user_id` PK) in [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37) / [tempo.dbml](../../06-engineering/docs/data/tempo.dbml). Chip memberships (lanes 2–5) stay separate.

| Rule | Lock |
| --- | --- |
| When blurb 1 is filled | Blurb already written on Build / Save; extract does not create the blurb |
| First successful identity write | INSERT; stamp `created_at` |
| Later successful writes | UPDATE same row; stamp `updated_at` |
| Write timing | On **successful parse + resolve** (before onboarding Review). Account: same moment as merge resolve |
| Model emits | `role_submitted`, `organization_submitted`, `function_label` (strings) — **never** UUIDs |
| Post-model resolve | `function_label` must match a live `functions.name` (list passed into the system prompt at call time) or the model omits it. A match sets `function_id`. No match leaves `function_id` null and does not create a `functions` row. `organization_submitted` → `organization_aliases.alias` → `organization_id`. Unresolved org FK stays **null** |
| Catalog ownership | `functions`, `organizations`, `organization_aliases`, `industries` — **team-maintained**, not model-created |
| No roles table (v1) | `role_submitted` is display-only; durable function SoT is **`functions`**. No role→function mapping table |
| Industries | Not written by extract; `industry_id` lives on `organizations` |

**Function correctness without a mapping DB:** the call passes current `functions.name` values into the system prompt. The model picks one or omits `function_label`. Exact normalized match sets `function_id`. An unmatched label does not create a catalog row. Slack carries that label so the team can add the `functions` row and then set `function_id` on that user's `user_role_organization`. The row does not store the unmatched label, so the Slack message is the queue.

**v1 seed:** `communications`, `policy`, `operations`, `partnerships`. Build inserts these four lowercase rows before the first live extract. The prompt file does not list them. The call appends the live `functions.name` values. A label outside this set still goes to `#model-extraction-function` and does not create a row.

### Ops — Identity Slack queues (locked)

Post **after** successful identity write/resolve only (not on hard extract fail). Omit secret → no-op / log dry-run. Channels on `tempo-comms.slack.com`:

| Channel | Fire when | Ops action |
| --- | --- | --- |
| `#model-extraction-organization` | `organization_submitted` non-empty **and** `organization_id` null | Add org and/or alias |
| `#model-extraction-function` | Emitted `function_label` matches no `functions.name`, so `function_id` is null | Add the `functions` row, then set `function_id` on that user's `user_role_organization` |
| `#model-extraction-role` | `role_submitted` non-null **and** normalized string (**lower + trim**) never seen before in `user_role_organization.role_submitted` (global first sighting) | QA: confirm `function_id` / label; extend `functions` or prompt examples — **not** a durable roles table |

**Payload (all three):** `role_submitted` and/or `organization_submitted`, resolved `function_label` / `function_id` / `organization_id` (or null), `user_id`, `trigger_id` (and run id when migrated).

**Dedupe**

| Kind | Rule |
| --- | --- |
| Shared | At most **one** Slack per kind per `trigger_id` (primary wins; fallback/retry silent if already notified) |
| Organization / function | First unresolved `(kind, normalized value)`; stay silent on repeats until resolved or value changes |
| Role | **Once ever** per normalized `role_submitted` (first global sighting) |

**Secrets (names only):** `TEMPO_OPS_SLACK_WEBHOOK_URL_EXTRACTION_ORG` · `_FUNCTION` · `_ROLE` — set on GitHub Actions (18 Oct 26). Mirror onto the API runtime (Vercel) when the write path posts; do not commit URLs.

### Data — Your priorities / topics and keywords (locked)

Blurb 2 only. Geographies on this blurb are the next beat. Schema: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml). Chip lifetime: [onboarding--v1.md](./onboarding--v1.md) (Review draft + Start monitoring). Merge: [extraction pipeline](../../06-engineering/docs/pipelines/extraction.md) §4. Topic vs keyword: [extraction prompt](../../06-engineering/docs/prompts/extraction.md) Lanes 2–3. Contract points there.

| Rule | Lock |
| --- | --- |
| `user_priorities` | Created when the blurb is saved (Build / Save). `created_at` on insert. `updated_at` only when blurb text changes. Extraction does not insert this row and does not bump `updated_at` |
| Model emits | `personalPriorities.topics` and `personalPriorities.keywords` as strings. Never UUIDs. Never `origin` |
| Normalize | Lowercase + trim before catalog match. Reuse `topics.name` / `keywords.name` when present. Within this lane, the same normalized string in both topics and keywords keeps the topic and drops the keyword |
| Names | A person, organization, or product in this blurb is a keyword, never a topic. Do not copy it into stakeholders unless that blurb states it |
| New catalog row | Post-model write path inserts `topics` or `keywords` only when the normalized name is missing. Open lexicon (not a team-closed list, unlike `functions`). Stamp `created_at` only. User remove does not delete the catalog row |
| Onboarding commit | Review is a session draft. Catalog upsert + `user_topics` / `user_keywords` write only when Start monitoring warm-accepts. Chips the operator removed in the draft are not inserted |
| Account commit | Same catalog + membership writes on successful merge. No Review |
| `source` | `personal_priorities` for this blurb |
| `origin` | Model proposals → `extracted`. Operator Add → `user_added`. The model never writes `user_added` |
| Re-extract | Do not auto-drop prior Topics or Keywords. Insert newly proposed `extracted` rows. If the same key was `user_removed`, resurrect (clear `deleted_at` and `end_reason`). Leave `user_added` untouched. `superseded` unused on these joins |
| Timestamps on joins | Write path sets `created_at`. `deleted_at` + `end_reason = user_removed` only when the operator removes a chip that was already stored |
| Ops | No Slack when a topic or keyword is new. Catalogs are expected to grow |

**Build order for one kept chip:** normalize label → find or insert catalog row → upsert `(user_id, topic_id|keyword_id, source)` with the `origin` above.

### Data — Your organization's priorities / topics and keywords (locked)

Blurb 3 topics and keywords only. Same topic-versus-keyword rules, commit timing, open lexicon, and no-auto-drop rule as the section above. Do not merge this lane into personal priorities. Schema primary key `(user_id, topic_id|keyword_id, source)` allows the same label on both sources.

| Rule | Lock |
| --- | --- |
| `user_organization_priorities` | Created when the blurb is saved (Build / Save). `created_at` on insert. `updated_at` only when blurb text changes. Extraction does not insert this row and does not bump `updated_at` |
| Model emits | `organizationPriorities.topics` and `organizationPriorities.keywords` as strings in the session draft. Never UUIDs. Never `origin`. Catalog and membership rows are not written at extraction time |
| Commit | Onboarding: catalog upsert + memberships only for labels still in the draft when Start monitoring warm-accepts. Account: same writes on successful merge. A chip removed on Review never creates a catalog row |
| `source` | `organization_priorities` for chips extracted from this blurb |
| Operator Add | On the shared Topics or Keywords shelf, Add stores `source = personal_priorities` and `origin = user_added`. Org source is set only by extraction from this blurb |
| Remove | Deleting an org chip clears only the `organization_priorities` membership. A personal membership with the same label can remain |

**Build order for one kept extracted chip:** same as personal priorities, with `source = organization_priorities`.

### Data — Geographies (locked)

From either priorities blurb. The model emits geography strings into the session draft. It does not write rows or ids. Country and region names stay out of topics and keywords. Schema: [tempo.dbml](../../06-engineering/docs/data/tempo.dbml).

| Rule | Lock |
| --- | --- |
| Commit | Same as topics and keywords. Catalog and `user_geographies` write only for labels still in the draft at Start monitoring, or on Account merge. A chip removed on Review creates nothing |
| Normalize | Lowercase + trim |
| Resolve | 1. `geography_aliases.alias` → `geography_id`. 2. Else `geographies.name_normalized`. 3. Else insert a provisional `geographies` row and a `geography_aliases` row with that same string, then point the membership at the new id |
| `source` | `personal_priorities` from "Your priorities". `organization_priorities` from "Your organization's priorities" |
| Operator Add | Shared Geographies shelf: Add stores `source = personal_priorities` and `origin = user_added`. Org source comes only from extraction |
| `origin` | Model proposals → `extracted`. The model never writes `user_added` |
| Re-extract | Do not auto-drop. Resurrect `user_removed`. Leave `user_added` untouched |
| Remove | Clears only that source's membership. The other source's row for the same place can remain |
| Ops | First insert of a new alias posts to `#model-extraction-geography`. At most one post per `trigger_id`. The operator can use the place immediately. Secret `TEMPO_OPS_SLACK_WEBHOOK_URL_EXTRACTION_GEOGRAPHY` is set on Actions (21 Oct 26). Mirror to the API when the write path posts. Omit the secret → no-op |
| Team merge | When a provisional place is the same as an existing one, repoint the alias and the `user_geographies` rows onto the canonical `geography_id`, then drop the provisional `geographies` row |

**Build order for one kept extracted chip:** normalize → resolve or insert provisional pair → upsert `(user_id, geography_id, source)`.

### Data — Stakeholders (locked)

Blurb 4. Per user only. No shared stakeholder catalog and no team-maintained class list. "What comes next" reads this user's active mentions. Cross-user sameness is not a v1 requirement.

| Rule | Lock |
| --- | --- |
| `user_stakeholders` | Created when the blurb is saved. `updated_at` only when blurb text changes. Extraction does not insert this row |
| Model emits | One short class per party this blurb says the user must be ready for. Person names are omitted. A named institution is stored as the stable class (`congress`), not the full proper name. Every distinct class in the blurb is emitted. Not chosen from a list in the prompt |
| Prompt text | Lane 4. See [extraction prompt](../../06-engineering/docs/prompts/extraction.md) |
| Commit | `user_stakeholder_mentions` write at Start monitoring, or on Account merge. No Review shelf and no operator Add |
| Normalize | Lowercase + trim. Unique `(user_id, mention)` |
| Add | New mention → insert, `created_at` set |
| Keep | Mention still present → leave the row |
| Drop | Mention absent on a later extract → set `deleted_at`. Row stays. Proposed again → clear `deleted_at` |
| Consumer | Active rows (`deleted_at` empty) for that `user_id` inform "what comes next." The blurb keeps the fuller wording |

### Data — Sources (locked)

Blurb 5. The model emits `traditionalSources` and `socialSources` as strings. It does not write rows or ids. `@` handles are X. Publications and wires are press. Uncertain cases stay press. Catalog and membership rows are written at commit, only for chips the operator kept. Press and platforms do not auto-drop.

| Rule | Lock |
| --- | --- |
| `user_sources` | Created when the blurb is saved. `updated_at` only when blurb text changes. Extraction does not insert this row |
| Press resolve | 1. `press_source_aliases.alias`. 2. Else `press_sources.name_normalized`. 3. Else insert a provisional press row and an alias with the same normalized string |
| Press merge | The team repoints the alias and `user_press_sources` onto the canonical `press_source_id`, then drops the provisional row |
| Press ops | First new alias posts to `#model-extraction-source`, at most once per `trigger_id`. The operator can use the outlet immediately. Secret `TEMPO_OPS_SLACK_WEBHOOK_URL_EXTRACTION_SOURCE` is set on Actions (21 Oct 26). Mirror to the API when the write path posts. Omit the secret → no-op |
| Social resolve | Strip `@`, lowercase. Reuse `social_accounts.handle_normalized` when present. Else insert a new row with `fetch_mode = word_search`. No alias table in v1 |
| `fetch_mode` | On `social_accounts` only. `word_search` or `post_download`. Default `word_search` on insert. The operator changes it. Not on `user_social_accounts`. No reason column |
| Social edit | An operator correction moves only that user's `user_social_accounts` row. It never rewrites `handle_normalized` or `fetch_mode`. A new handle inserts a new catalog row. An existing handle reuses that `social_account_id`. The previous membership is `user_removed` when it was already stored |
| Social `updated_at` | Team correction of a catalog row, including `fetch_mode`, or a team merge that repoints memberships and then drops the old row. Not an operator edit |
| Social ops | First insert of a new handle posts to `#model-extraction-source`, at most once per `trigger_id`, same channel and secret as a new press alias. The message names the handle and that `fetch_mode` is `word_search` until the operator sets it. The operator can use the handle immediately. Omit the secret → no-op |
| `origin` | Model proposals → `extracted`. Operator Add → `user_added` |
| Lifetime | `created_at`, `deleted_at`, and `end_reason` follow [onboarding--v1.md](./onboarding--v1.md). Resurrect `user_removed` when a later extract proposes the same source |

**Build order for one kept press chip:** normalize → resolve or insert provisional pair → upsert `(user_id, press_source_id)`.

**Build order for one kept social chip:** normalize handle → reuse or insert `social_accounts` (`fetch_mode = word_search` on insert) → upsert `(user_id, social_account_id)`. If the catalog row was inserted, post to `#model-extraction-source`.

### Scope

| In | Out |
| --- | --- |
| Invoke contract (table above), `trigger_kind` / `trigger_id`, fail/retry semantics, chip-acceptance guardrail | Onboarding / Account chrome copy and layout (siblings) |
| Model I/O, hygiene/resolve, eval/gold, runs persist (later slices) | Magic link, Incomplete modal UX, Tags prune UX detail |
| SKU cutover after gold (D-073) | Dashboard ranking after scope is live; LLM-judge; blocking CI gate (MVP) |

### Ship sequencing (one train)

1. Five-lane `extraction-v1` + fail-closed invoke  
2. Onboarding Review handoff (product largely locked)  
3. Account merge-without-Review  
4. `extraction_runs` migrate (can parallelize after 1)  
5. Promote gold → advisory pass → SKU cutover  

---

## Execution spec (agent-ready)

**Goal:** Honor the invoke table; implement against prompt/pipeline/runs SoTs; retire legacy single-blob path.

**Inputs:** Committed blurbs from the five tables (omit empty lanes in model payload per prompt SoT).

**Outputs:** Lane-keyed extract per prompt SoT; run row(s) per attempt once migrated; on a finished model invoke → `extraction_invoke`; onboarding → Review draft chips; on successful onboarding commit → `extraction_chip_acceptance`; Account → merged memberships.

**Core logic (UX slice locked)**

1. On Build / Build anyway / Context Save: persist blurbs atomically → mint `trigger_id` → invoke (`build` or `rebuild`).  
2. On extract fail Try again (o04a / a03g extract): no blurb rewrite → `retry` + same `trigger_id`.  
3. On a03g write fail Try again: re-persist → new `rebuild` `trigger_id`.  
4. Primary then fallback share `trigger_id`; both fail → fail UI (o04a / a03g extract).  
5. Do not call LLM on blurb field edits alone — only the CTAs above (Account **Save** counts as rebuild commit).

**Edge cases**

- Empty-but-valid extract ≠ extract-fail (onboarding → thin Review; Account → empty merge, keep prior chips).  
- Incomplete onboarding Build → o03g before any write.  

**Constraints**

- No second Review on Account.  
- No second enrichment LLM.  
- `fail_kind` client-only — not Database library / not a runs column.  

**Open (next slices)**

- Exact Account in-flight chrome (busy vs o04-class).  
- Advisory runner: a new command loads the 24 cases in [extraction.gold.json](../../06-engineering/docs/evals/extraction.gold.json), calls `extraction-v1`, and reports precision and recall per field. Each identity case passes that case’s `function_list` into the prompt. The score does not block release. The same build retires or quarantines `eval:onboarding-extraction`. Do not import `ex-01`–`ex-23`. SKU cutover checklist stays in the build handoff. Runner code is a later build, not this lock.  
- Billing reconcile vs sum(`estimated_cost_usd`) — later.  
- Wire identity Slack posts on resolve (API env + omit-secret dry-run).  

---

## Dependencies & Path 2

- **Schema:** five blurb tables + memberships (Database library); `extraction_runs` migration (sibling ERD).  
- **Pricing:** [07-ops/model-pricing.json](../../07-ops/model-pricing.json); weekly Action [model-pricing-review.yml](../../.github/workflows/model-pricing-review.yml); secret `TEMPO_OPS_SLACK_WEBHOOK_URL`.  
- **Identity ops Slack:** `#model-extraction-organization` / `-function` / `-role`; secrets `TEMPO_OPS_SLACK_WEBHOOK_URL_EXTRACTION_{ORG,FUNCTION,ROLE}` (Actions set; API/Vercel when posting).  
- **Path 2:** migrate runs + SKU cutover — revert: keep legacy extract path / env SKUs until gold; disable new invoke behind flag if needed. Owner: eng build train.

---

## Decisions & open questions

| Decision | Rationale | Date | Revisit trigger |
| --- | --- | --- | --- |
| Thin PRD + SoT pointers | Avoid third behavior SoT | 04 Oct 26 | Contract split |
| UX invoke locks (table) | Align onboarding + Account commit paths | 17 Oct 26 | Paper CTA rename |
| Account Save = persist + rebuild | Updated blurbs imply scope change | 17 Oct 26 | Need Save-without-extract |
| `trigger_id` new on build/rebuild; shared on retry + primary/fallback | One user intent until success/abandon | 17 Oct 26 | Analytics want retry as new intent |
| a03g dual-mode + generic copy | Rare fails; one Account fail UI | 17 Oct 26 | Confused recovery |
| `accepted_at` = live scope entry | Start monitoring / Account merge success — not Save click | 17 Oct 26 | Runs analytics redefine |
| `input_hash` / cost / `error_kind` enum | Durable lineage + ops cost; closed fail labels | 17 Oct 26 | Need free-text errors |
| Pricing SoT in `07-ops` + weekly Slack review | Ops altitude; no per-run web fetch | 17 Oct 26 | Provider pricing API appears |
| `#ops-pricing-models` + `TEMPO_OPS_SLACK_WEBHOOK_URL` live | Incoming Webhook + repo secret; Action posts (verified 17 Oct 26) | 17 Oct 26 | Rotate webhook / change channel |
| Identity upsert on resolve (pre-Review) | Blurb 1 filled → INSERT/UPDATE `user_role_organization`; model emits labels, post-model resolves FKs | 18 Oct 26 | Need draft-only identity until Start monitoring |
| No roles catalog; `functions` is function SoT | Avoid mapping-table rot; QA novel roles via Slack | 18 Oct 26 | Chip efficacy needs title lexicon |
| `function_label` from live `functions.name` | Unmatched label does not create a row. Slack is the queue. Team adds the function, then sets `function_id` on that user | 21 Oct 26 | Unmatched labels need a queryable column |
| `#model-extraction-*` queues + dedupe | Org/function unresolved; role = first global sighting; ≤1 per `trigger_id` per kind | 18 Oct 26 | Alert fatigue / need snooze UI |
| Extraction identity webhook secrets on Actions | ORG / FUNCTION / ROLE set 18 Oct 26; API mirror at wire-up | 18 Oct 26 | Rotate webhooks |
| Personal priorities T/K writes | Blurb row on save; memberships at Start monitoring or Account merge; no auto-drop; open topic/keyword lexicon | 21 Oct 26 | Glossary moves off the prompt |
| Organization priorities T/K writes | Same as personal, `source = organization_priorities`. Shared-shelf Add is `personal_priorities`. Catalog rows at commit, not at extraction | 21 Oct 26 | Review gains a source picker |
| Geographies | Alias, else canonical name, else provisional row + alias so the operator is not blocked. Team merge repoints memberships, then drops the provisional row | 21 Oct 26 | A gazetteer replaces provisional inserts |
| Stakeholders are per-user classes | Every distinct class the user must be ready for. Person names omitted. Named institutions stored as the stable class. No team catalog | 21 Oct 26 | A product compares stakeholders across operators |
| Sources | Press uses aliases and provisional rows. X handles are one normalized string. Operator edits repoint that user's membership only | 21 Oct 26 | A second network needs a platform column |
| No auto-drop on T/K/G/Press/Platforms | Account blurb rebuild must not delete chips the operator did not remove | 21 Oct 26 | Product wants absence to mean removal |
| Chip acceptance is a PostHog guardrail | Precision and recall per shelf at onboarding commit. Not an eval. F1 and all-shelf totals are not stored. A Review removal is not inserted | 22 Oct 26 | A target is set, or Account edits become the signal |
| 24 gold cases locked | Expected JSON is locked in extraction.gold.json. The advisory score waits on a runner for `extraction-v1`. The live command still scores `extract-v8` against the old file. Examples stay out of this PRD | 24 Oct 26 | The advisory pass has a score |
| v1 functions seed | `communications`, `policy`, `operations`, `partnerships`. Inserted at build. The prompt file does not hardcode them. Unmatched labels still queue in Slack and do not create a row | 24 Oct 26 | A fifth function is needed for a real invited user |
| Advisory extraction runner | New command scores the 24 cases against `extraction-v1`. Identity cases pass that case’s `function_list`. Score does not block release. Retire or quarantine `eval:onboarding-extraction`. Do not import `ex-01`–`ex-23`. Code is a later build | 24 Oct 26 | The advisory pass has a score |
| `extraction_invoke` | One PostHog event when a model invoke finishes, success or fail. Separate from chip acceptance. No chip counts, no `fail_kind`. Write failures do not emit it. Specified, not instrumented | 24 Oct 26 | A target is set |
| `social_accounts.fetch_mode` | `word_search` (default) or `post_download`, on the shared handle only. Operator sets it for the MVP. A later job may set it from a rolling 30-day post count. No reason column | 26 Oct 26 | The volume job has a threshold |
| New handle pages `#model-extraction-source` | Same channel and secret as a new press alias. Message names the handle and the default `word_search`. At most once per `trigger_id` | 26 Oct 26 | Source alerts need a snooze |

### Blocking open questions

| Question | Default if unresolved |
| --- | --- |
| Account extracting chrome | In-sheet busy; Tags update on success ([account--v1.md](./account--v1.md)) |
