# Data model (DBML)

First-principles database design for Tempo. dbdiagram renders version-controlled `.dbml` — locally via the Cursor extension, or in the cloud. **Intent:** define what we will build in **Supabase**. Supabase is the runtime database when migrated; schemas may evolve. DBML is the design map, not auto-sync to production.

## Diagrams

| Diagram | File | Cloud | Purpose |
|---------|------|-------|---------|
| **Database library** | [tempo.dbml](tempo.dbml) | [dbdiagram](https://dbdiagram.io/d/6ab4852e58694256127b2a37) | Product data — extraction lanes 1–5 + monitoring 6–11 (shared pool, metastories, feed, ops) |
| **Extraction runs** | [extraction-runs.dbml](extraction-runs.dbml) | [dbdiagram](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d) | Per-attempt LLM lineage for stage `extraction` |
| **Summarization runs** | [summarization-runs.dbml](summarization-runs.dbml) | [dbdiagram](https://dbdiagram.io/d/6ae28ffced134e407e37a6d0) | Per-attempt lineage for stage `summarization` |
| **Story-tagging runs** | [story-tagging-runs.dbml](story-tagging-runs.dbml) | [dbdiagram](https://dbdiagram.io/d/6ae28fe9ed134e407e37a621) | Per-attempt lineage for stage `story-tagging` |
| **Metastory runs** | [metastory-runs.dbml](metastory-runs.dbml) | [dbdiagram](https://dbdiagram.io/d/6ae28fb1ed134e407e37a484) | Per-attempt lineage for stage `metastory` (`call_kind` = boundary \| writer) |
| **Personalization runs** | [personalization-runs.dbml](personalization-runs.dbml) | [dbdiagram](https://dbdiagram.io/d/6ae28fcfaac33014104ead45) | Per-attempt lineage for stage `personalization` |

Ingestion has **no** runs page (rules + vendor jobs). Embed / cluster-propose are **not** metastory-runs rows.

Related engineer SoTs (extraction example): [prompts/extraction.md](../prompts/extraction.md) · [pipelines/extraction.md](../pipelines/extraction.md) · product contract [extraction.md](../../../02-product/contracts/extraction.md).

---

## Database library — how to read the ERD

Two bands on [the diagram](https://dbdiagram.io/d/6ab4852e58694256127b2a37): **extraction / scope (1–5)** and **monitoring (6–11)**. Layout **Account on the left**, extraction lanes **2–5 left → right**, then monitoring groups. Inside each extraction lane, read **top → bottom**: blurb → extract/join → catalog.

| # | Band | Group | Flow |
|---|------|-------|------|
| 1 | Extraction | **Account** | `users` (hub — `uid` + email; Supabase identity intent) |
| 2 | Extraction | **Identity (blurb 1)** | blurb → model labels → post-model resolve → `function_id` + `organization_id` |
| 3 | Extraction | **Priorities & retrieval (blurbs 2–3)** | blurbs → `user_topics\|keywords\|geographies` → facet catalogs (+ `vendor_concept_uri` on T/G) |
| 4 | Extraction | **Stakeholders (blurb 4)** | blurb → per-user `mention` strings (no shared catalog) |
| 5 | Extraction | **Sources (blurb 5)** | blurb → press/social membership → catalogs (+ `vendor_source_uri` / `x_user_id`) |
| 6 | Monitoring | **Shared stories** | `stories` + `press_articles` / `x_posts` keep-lists (**no body**; press `excerpt` reserved/NULL; `article_summary` = source-reader snippet) |
| 7 | Monitoring | **Story chips** | `story_topics\|keywords\|geographies` → shared catalogs ([story-tagging](../../../02-product/contracts/story-tagging.md); IR-08 invoke) |
| 8 | Monitoring | **Metastories** | shared copy + `metastory_stories` M:N (chips roll up; no `metastory_chips`) |
| 9 | Monitoring | **Story embeddings** | `story_embeddings` (1:1 pgvector; MR-04 hash; skip on model+hash; dims N with embed SKU) |
| 10 | Monitoring | **Feed membership** | join result + `why_this_matters` / `what_comes_next` + cache key |
| 11 | Monitoring | **Ingest ops** | NewsAPI drain cursors, X word-search + post-download cursors, compliance jobs (hour/warm = cron + handlers) |

Canvas positions live in [tempo.dbdiagram](tempo.dbdiagram) (sidecar pushed with the DBML).

**How to read the canvas**

| Band | Direction | Intent |
|------|-----------|--------|
| **Top — extraction 1–5** | Left → right by lane | Account → identity → priorities → stakeholders → sources. Inside a lane, **top → bottom**: blurb → joins → catalogs. |
| **Bottom — monitoring 6–11** | Left → right by process | **Ingest ops → shared stories → story chips → embeddings → metastories → feed**. Clear vertical gap below extraction (~y 2200). |
| **Catalog alignment** | Same X (~1520) | `topics` / `keywords` / `geographies` sit directly above `story_*` chips — short vertical FKs. |
| **Sources / feed alignment** | Right X (~3080) | Press/social catalogs above `user_feed_membership` (join uses sources + chips). |
| **Tall keep-lists** | Shared-stories column | `stories` → `press_articles` → `x_posts` stacked with generous gaps so notes stay readable. |

Canvas positions live in [tempo.dbdiagram](tempo.dbdiagram). After push, **fit-to-screen**; prefer editing the sidecar over one-off drags so layout stays in git.

### Current model (first principles)

| Area | Tables | Status |
|------|--------|--------|
| 1 · Account | `users` | Landed |
| 2 · Identity (blurb 1) | `user_role_organization` + `functions` + org/industry catalogs (`roles` dropped in v1) | Landed |
| 3 · Priorities & retrieval (blurbs 2–3) | priority blurbs + `user_topics\|keywords\|geographies` + facet catalogs (+ vendor concept URIs) | Landed |
| 4 · Stakeholders (blurb 4) | `user_stakeholders`, `user_stakeholder_mentions` | Landed |
| 5 · Sources (blurb 5) | `user_sources` + press/social membership + catalogs (+ vendor source URI / X user id) | Landed |
| 6 · Shared stories | `stories`, `press_articles`, `x_posts` | Closed (A3) |
| 7 · Story chips | `story_topics\|keywords\|geographies` | Closed (A3) |
| 8 · Metastories | `metastories`, `metastory_stories` | Closed (A3) |
| 9 · Story embeddings | `story_embeddings` | Closed (A3) — dims N with embed SKU |
| 10 · Feed membership | `user_feed_membership` | Closed (A3) |
| 11 · Ingest ops | NewsAPI drain cursors, `x_word_search_cursor`, `x_post_download_cursors`, compliance jobs | Closed (A3) |
| LLM run lineage | `extraction` + `summarization` + `story-tagging` + `metastory` + `personalization` `*-runs.dbml` | Closed (A4) |

**Phase A closed** (28 Oct 2026, [D-085](../../DECISIONS.md#2026-10-28---d-085---phase-a-closed-extraction--metastory-foundations)): contracts ↔ ERD ↔ vendor SoTs aligned; A3 monitoring SoT + A4 runs stubs done. Next: Phase B vertical deepen.

**Blurbs (v1):** all five are **optional** — UX highly suggests; do not block finishing onboarding. Skip = no row, or row with NULL `blurb`. Dashboard is weak until filled; editable in account settings.

**Stakeholders:** blurb kept for nuance; `mention` strings are per-user only (no shared catalog). Extract-only — no user Add/x. Blurb re-extract: dropped mention → `deleted_at`; proposed again → clear `deleted_at`. Next-step prompts use `deleted_at IS NULL` only.

**Sources:** press uses alias normalization (`nyt` → publisher). Social is X `handle_normalized` only in v1 (Platforms on Review your scope). `social_accounts.fetch_mode` is `word_search` (default) or `post_download`. The operator sets it. A new handle pages `#model-extraction-source` the same way a new press alias does.

**Scope chips (Review your scope / account):** extract → INSERT joins (`origin = extracted`) at commit (onboarding: Start monitoring; Account: successful merge). User **x** → `deleted_at` + `end_reason = user_removed`. **Add** → INSERT `user_added` (or clear end on same PK). Re-extract does **not** auto-drop Topics, Keywords, Geographies, Press, or Platforms (`superseded` unused on those joins). Newly proposed → INSERT or **resurrect** (clear `deleted_at` / `end_reason`, including prior `user_removed`). `user_added` untouched by re-extract. Active = `deleted_at IS NULL`. Eval reject = `extracted` + `user_removed`.

**Identity (blurb 1):** Model emits `role_submitted` (display-only), `organization_submitted`, and `function_label` — never UUIDs. Post-model resolve: `function_label` → `functions.name` → `function_id`; `organization_submitted` → `organization_aliases` → `organization_id`. No `roles` / title catalog in v1. Durable function SoT is `functions`.

**Conventions:** **FK** = foreign key. Match keys (catalog names, aliases, handles, emails, mentions) store **lowercase**. Blurbs and `*_submitted` keep original casing for display. Blurb columns and blurb-1 resolved FKs / submitted extracts are **nullable**. Timestamps: user-owned + correctable catalogs (orgs, press, social) → `created_at` + `updated_at`; near-enums / lexicon (`functions`, `industries`, `topics`, `keywords`, `geographies`) and aliases → `created_at` only; scope memberships → `created_at` + `deleted_at` + `end_reason`.

---

## LLM runs pages — how to read

Shared grain across all `*-runs.dbml` siblings: **one row per generative LLM attempt**. `trigger_id` groups primary + retry for one invoke. **No row** when the stage skips without a model call. **No** `output_json` / eval scores / publisher body columns — product tables + offline `evals/*` are SoT.

| Stage | Subject FK (stub) | Notes |
|-------|-------------------|--------|
| Extraction | `user_id` | Closed `trigger_kind`; has `accepted_at` (onboarding/account only) |
| Summarization | `story_id` | Press only; ≤2 attempts |
| Story-tagging | `story_id` | Admit + IR-14 re-tag; ≤2 attempts |
| Metastory | `metastory_id` (nullable pre-mint) | `call_kind` = `boundary` \| `writer`; each ≤2; embed/cluster out |
| Personalization | `user_id` + `metastory_id` | PR-08 cache skip → no row; UI gate on membership `personalized_at` |

**Extraction detail:** Primary and fallback for the same Build/Rebuild/Retry share **`trigger_id`**. Stub `users` FK only; canonical shape in [tempo.dbml](tempo.dbml) → Supabase. Process / UX control flow (O4 → Review / O4a) lives in [pipelines/extraction.md](../pipelines/extraction.md) (Mermaid), not in dbdiagram.

**Metastory craft split:** one pipeline ([pipelines/metastory.md](../pipelines/metastory.md)); prompts/evals split by call kind (`metastory-boundary` / `metastory-writer`).

---

## What this is / is not

| Is | Is not |
|----|--------|
| Conversational modeling in Cursor | Auto-sync to production migrations |
| Version-controlled `.dbml` design intent for Supabase | A second runtime identity store in extraction-runs |
| Blank slate until you invite history | Reverse-engineering `apps/api/src/db` by default |

Running SQL lives under [`../../apps/api/src/db/`](../../apps/api/src/db/). Keep that out of these DBML files until you explicitly want to reconcile.

## One-time setup

### A. Live preview in Cursor

1. Install the [dbdiagram extension](https://open-vsx.org/extension/dbdiagram/dbdiagram-vscode) (Open VSX / VSIX — not always on the Cursor marketplace).
2. Open [tempo.dbml](tempo.dbml) or [extraction-runs.dbml](extraction-runs.dbml).
3. Command Palette → **DBML: Open Preview to the Side**.

### B. Cloud sync via CLI ([announcement](https://community.dbdiagram.io/t/introducing-the-dbdiagram-cli/5853) · [docs](https://docs.dbdiagram.io/cli/))

Requires Node ≥ 22.14 (this machine has it).

```sh
npm install -g dbdiagram
dbdiagram auth login
```

From this directory (`06-engineering/docs/data/`):

**Database library** (settings currently point here — [`.dbdiagram/settings.json`](.dbdiagram/settings.json)):

```sh
dbdiagram init --entry tempo.dbml --diagram-id 6ab4852e58694256127b2a37
dbdiagram push
```

**Runs siblings** (separate cloud docs — push with filepath; omit `--diagram-id` / use `--new` to create):

```sh
dbdiagram push --name "Extraction runs" --diagram-id 6ab952050f25a52d011d406d extraction-runs.dbml
dbdiagram push --name "Summarization runs" --diagram-id 6ae28ffced134e407e37a6d0 summarization-runs.dbml
dbdiagram push --name "Story-tagging runs" --diagram-id 6ae28fe9ed134e407e37a621 story-tagging-runs.dbml
dbdiagram push --name "Metastory runs" --diagram-id 6ae28fb1ed134e407e37a484 metastory-runs.dbml
dbdiagram push --name "Personalization runs" --diagram-id 6ae28fcfaac33014104ead45 personalization-runs.dbml
```

Note: CLI settings are single-entry (Database library by default). Prefer `dbdiagram push <file> ...` with explicit name/id so you do not overwrite `tempo.dbml`’s diagram. After create, paste the cloud URL into the file header + the Diagrams table above.

## Day-to-day loop

```text
You describe intent in chat
        │
        ▼
Agent edits the relevant .dbml
        │
        ├─► Cursor extension preview updates live
        │
        └─► dbdiagram push   →  matching cloud ERD
             dbdiagram pull  ←  if you edited on the web
```

Example prompts that stay first-principles:

> Model a user account and a separate profile. Profile holds org, role, country, and an onboarding blurb. Extracted topics should be reusable across users — propose tables and update `06-engineering/docs/data/tempo.dbml`.

> Add soft-delete and audit timestamps consistently; update the DBML.

## Conventions (lightweight)

- Prefer PostgreSQL types and explicit `Ref:` relationships.
- Name tables plural snake_case (`users`, `topics`, `extraction_runs`).
- Put shared vocabulary (topics, keywords, geographies) in their own tables + join tables when many-to-many.
- Leave layout/position files (e.g. `*.dbdiagram`) to the extension/CLI if they appear; commit them if you care about shared canvas layout.

## When to bring in the existing app

Only after you ask. Until then, treat these DBML files as clean design space, not a mirror of migrations.
