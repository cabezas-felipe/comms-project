# api-newsapi-ai — Tempo consumption contract

> **Status:** v0 locked (vendor consumption)  
> **Vendor:** [NewsAPI.ai](https://newsapi.ai) / Event Registry — **not** [newsapi.org](https://newsapi.org)  
> **Owner:** Tempo engineering  
> **Last updated:** 28 Oct 2026 (no vendor excerpt field; truncated body ≠ keep-list excerpt)  
> **Vendor docs:** [https://newsapi.ai/documentation](https://newsapi.ai/documentation)

Tempo’s map of **which NewsAPI.ai endpoints and fields we call**, and **what we use them for**. This is a consumption contract, not a mirror of the vendor docs.

| Status | Meaning |
| --- | --- |
| `in` | We plan to call this in the prototype / v0 path |
| `out` | Explicitly will not call |
| `later` | Possible later; not in current scope |
| `candidate` | Under discussion; not locked |

**How to read an `in` endpoint:** endpoint → data point → brief Tempo use.  
**How to read an `out` / `later` endpoint:** reason only — no field tables.

**Landing zone:** map consumed fields into Tempo’s ingest normalization boundary ([`source-normalizer`](../MODE2-SLICE-12-INGESTION-SOURCES.md#source-normalization-contract)), not provisional Supabase column names.

**Ingest architecture (locked direction):** shared article pool from the **union of users’ traditional sources** and terms. **Two Stream drains** (never `keyword` + `conceptUri` on one request): (1) concepts = topics + place geos as concept URIs; (2) keywords. Union in Tempo; dedupe by article `uri`; multi-tag every matching keyword/concept. **Tag and personalize in Tempo**. NewsAPI does not attach per-user tags. Cost = articles returned (overlap of both drains billed twice). MVP shared clock: **every 60 minutes**; onboarding / Account Context Save warm when scope changes.

**Vendor ops:** `apiKey` required. Article stream host: `eventregistry.org`. Text analytics host: `analytics.eventregistry.org` (unused — see below). Tokens: see [plans](https://newsapi.ai/plans). Stream tokens scale with **returned** article count (~100 arts ≈ 1 token).

**Reference — data models:** Vendor object shapes (article, source, concept, location, event, …) are documented at [Response format / data models](https://newsapi.ai/documentation?tab=data_models). That page is **not** an endpoint and is **not** field-locked here. Implement only fields marked `in` on Stream (and Autosuggest responses we consume); do not invent fields from the full model. Revisit a data-model field only when a locked `in` property’s shape is ambiguous in practice.

---

## Text Analytics

**Section status:** locked `out` (18 Sep 2026)

**Host:** `http://analytics.eventregistry.org` (analytics service — not the article index API)

**Family rule:** NLP (or URL scrape) on **content Tempo sends in**. They do **not** search Event Registry’s news corpus.

| Endpoint | Status | Why out |
| --- | --- | --- |
| [`/api/v1/annotate`](https://newsapi.ai/documentation?tab=annotate) | `out` | NER on caller-provided `text`; not corpus retrieval. |
| [`/api/v1/categorize`](https://newsapi.ai/documentation?tab=categorize) | `out` | DMOZ / news / IPTC on caller text. Operator beat ≠ publisher categories. |
| [`/api/v1/semanticSimilarity`](https://newsapi.ai/documentation?tab=semanticSimilarity) | `out` | Pairwise `text1`/`text2` only. Tempo owns recall similarity. |
| [`/api/v1/sentiment`](https://newsapi.ai/documentation?tab=sentiment) | `out` | Not required for v0 ingest / synthesis. |
| [`/api/v1/extractArticleInfo`](https://newsapi.ai/documentation?tab=extractArticleInfo) | `out` | URL scrape, not index query. Article fields come from Stream. |
| [`/api/v1/detectLanguage`](https://newsapi.ai/documentation?tab=detectLanguage) | `out` | Overlaps Tempo lang / translation posture. |
| Train topic | `out` | Same analytics family; not corpus search. |

### Decision log

| Date | Change | Why |
| --- | --- | --- |
| 18 Sep 2026 | Locked Text Analytics `out` | Wrong layer for Tempo ingest; duplicates Tempo-owned NLP. |

---

## Articles — endpoint choice

| Endpoint | Status | Role |
| --- | --- | --- |
| [Stream of new articles](https://newsapi.ai/documentation?tab=feedOfArticles) (`minuteStreamArticles`) | **`in`** | Sole article **retrieval** path for v0 |
| [Get articles](https://newsapi.ai/documentation?tab=searchArticles) | **`out`** | No backfill / historical search in this contract |
| [Get articles for topic page](https://newsapi.ai/documentation?tab=searchArticlesForTopic) | **`out`** | Requires newsapi.ai UI topic pages; fights Tempo-owned settings |
| [Get article details](https://newsapi.ai/documentation?tab=articleDetails) | **`out`** (unless Stream payload proves insufficient) | URI hydrate only; not discovery |

**Accepted limit:** no Get articles backfill → cold start / missed polls only see what Stream delivers after go-live (plus Uri catch-up when the cursor exists). Agents must not reintroduce Get articles “for completeness.”

---

## Stream of new articles

**Section status:** locked for v0 request + returned details (19 Sep 2026).

**Endpoint:** `GET|POST https://eventregistry.org/api/v1/minuteStreamArticles`  
**Docs:** [feedOfArticles](https://newsapi.ai/documentation?tab=feedOfArticles)

**Tempo job:** Poll for newly **collected** articles matching shared-pool filters; persist once; tag topics/keywords/geos in Tempo; personalize metastories per user.

### Ops requirement (not a request field)

Tempo **must** call this endpoint on a fixed cadence. **MVP: every 60 minutes.** Persist and replay `newestUri` cursors each poll (see below). Cadence lives in Tempo scheduling, not in a Stream “interval” parameter.

### Core / incremental parameters

| Param | Status | Tempo use |
| --- | --- | --- |
| `apiKey` | `in` (must) | Auth |
| `recentActivityArticlesMaxArticleCount` | `in` = `100` | Cap returned volume / tokens per call. Raise later if truncation shows data loss. |
| `recentActivityArticlesNewsUpdatesAfterUri` | `in` | Primary incremental cursor for **news**. Send last response’s `newestUri.news`. |
| `recentActivityArticlesPrUpdatesAfterUri` | `in` | Primary incremental cursor for **pr**. Send last response’s `newestUri.pr`. |
| `recentActivityArticlesBlogUpdatesAfterUri` | `out` | Blogs not in v0 `dataType`. |
| `recentActivityArticlesUpdatesAfterMinsAgo` | `out` | Uri + 60‑min cadence replaces MinsAgo for “since last poll.” |
| `recentActivityArticlesUpdatesAfterTm` | `out` | Weaker than Uri (clock skew); not needed when Uri is primary. |

**Cursor semantics:** With Uri cursors and a reliable 60‑min poll, each call returns matching articles **added after** the last seen uris — achieving “everything new since the last call” without MinsAgo.

**Caveats:** First call / lost cursor has no Uri (bootstrap gap). If &gt;100 matching articles arrive in a gap, `maxArticleCount: 100` truncates until cap is raised or the gap is drained.

### Additional request parameters (locked — reuse prior filter alignment)

| Param | Status | Tempo use |
| --- | --- | --- |
| `articleBodyLen` | `in` = `-1` | Full body **in memory only** for summarization + same-refresh what happened. **Do not store** the body (full or truncated). There is **no** separate vendor `excerpt` / teaser field — positive `articleBodyLen` only truncates response `body` in place; do **not** persist that as keep-list `excerpt`. Persist Tempo’s **article summary** ([summarization](../../../02-product/contracts/summarization.md); also source-reader snippet). |
| `dataType` | `in` = `["news","pr"]` | Exclude `blog` |
| `sourceUri` | `in` | Union of users’ traditional sources (required for shared pool) |
| `keyword` | `in` | Array of user keywords |
| `keywordOper` | `in` = `or` | Any keyword may match |
| `keywordLoc` | `in` = `body,title` | Match in title or body |
| `keywordSearchMode` | `in` = `phrase` | Exact phrase match; **not** synonym expansion (`simple` ≠ synonyms) |
| `conceptUri` | `in` | Topics **and** place geos (resolve via Suggest concepts) |
| `conceptOper` | `in` = `or` | Any listed concept may match |
| `categoryUri` / `categoryOper` | `out` | Categories ≠ Tempo topics |
| `sourceLocationUri` | `out` | Outlet HQ ≠ story geography |
| `sourceGroupUri` | `out` | Users name sources, not conglomerates |
| `authorUri` | `out` | Users name sources, not authors |
| `locationUri` | `out` | Dateline-only; geo via place `conceptUri` |
| `lang` | `in` on **keyword** drains (per observed source language) | Language D: one keyword query per observed language of those sources (translated phrase + `lang`); also search the user’s original wording. New source starts in the user’s language until `lang` is observed. **Omit** on concept drains (concepts are language-agnostic). |
| `query` | `out` | Flat filters + (if needed) two calls for keyword∪concept union; Advanced Query not required for v0 |
| Rank percentile filters | `out` | Ranking → returned details, not drop filters |
| Sentiment min/max filters | `out` | Same; also forces English-only |
| `isDuplicateFilter` | `in` = `skipDuplicates` | One copy of near-duplicates |
| `eventFilter` | `out` | Leave default `keepAll` |

**Union of keywords OR concepts:** one call with both `keyword` OR and `conceptUri` OR **ANDs** the two families. For a true union within `sourceUri`s, use **two Stream calls** (keywords-only + concepts-only), same sources, dedupe by article `uri` in Tempo — or sources-only + tag in Tempo.

### Returned details

`include*` flags add fields to each article; vendor pricing FAQ: **no extra token cost** for richer returned properties.

| Flag | Status | Tempo use |
| --- | --- | --- |
| `includeArticleTitle` | `in` = true | Headline for cards / clustering input |
| `includeArticleBasicInfo` | `in` = true | Core fields incl. `url`, `lang`, `date` / `time` / **`dateTime`** (use `dateTime` for “published x ago”; idempotency via `uri`) |
| `includeArticleBody` | `in` = true | Body for **transient** summarization only (`articleBodyLen: -1`). Discard after article summary is written; never show, log, or store the body (including truncated forms). |
| `includeArticleEventUri` | `out` | Vendor **event cluster** id — not incremental “newness” (Uri cursors handle that). Revisit only if Events family is adopted |
| `includeArticleSocialScore` | `in` = true | Persist wire **`shares`** object on `press_articles.shares` (jsonb). Soft prior for rank is **derived in app** — do not collapse to a stored float. Secondary to beat fit / trust / freshness |
| `includeArticleSentiment` | `in` = true | Persist wire **`sentiment`** (−1…1) on `press_articles.sentiment`. **English-only** when non-null; soft prior; not velocity |
| `includeArticleConcepts` | `in` = true | Wikipedia-style entities ≈ Tempo **topics** + **place geos**; aids tagging against user `conceptUri`s. Not free-text keywords |
| `includeArticleCategories` | `out` | Categories ≠ Tempo topics |
| `includeArticleLocation` | `out` | Dateline / “where it occurred”; sparse. Prefer geo via concepts |
| `includeArticleImage` | `out` | |
| `includeArticleAuthors` | `in` = true | Provenance |
| `includeArticleVideos` | `out` | |
| `includeArticleLinks` | `out` | Outbound URLs **in the body** — not the article permalink (`url` from basicInfo). Not an inbound citation count; source order uses original vs follow-on, `includeSourceRanking`, freshness, and metastory corroboration instead. |
| `includeArticleExtractedDates` | `out` | Dates **mentioned in text**, not publish time |
| `includeArticleDuplicateList` | `out` | Redundant with `isDuplicateFilter: skipDuplicates` |
| `includeArticleOriginalArticle` | `out` | |
| `includeSourceTitle` | `in` = true | Outlet display name |
| `includeSourceDescription` | `out` | |
| `includeSourceLocation` | `out` | Publisher HQ; not required for v0 |
| `includeSourceRanking` | `in` = true | Persist wire **`source.ranking.importanceRank`** on `press_articles.importance_rank`. Soft prestige prior **derived in app** for metastory source order — do not collapse other ranking fields into a stored float unless product adds them later |
| `includeConceptLabel` | `in` = true | Human-readable concept names (requires concepts) |
| `includeConceptImage` | `out` | |
| `includeConceptSynonyms` | `out` | Alternate labels on **returned** concepts — does **not** expand search synonyms for user keywords |
| `conceptLang` | `in` = `eng` | Label language for concepts |
| `includeCategoryParentUri` | `out` | Categories are `out` |
| `includeLocationGeoLocation` | `out` | Article location is `out` |
| `includeLocationPopulation` | `out` | |
| `includeLocationGeoNamesId` | `out` | |
| `includeLocationCountryArea` | `out` | |
| `includeLocationCountryContinent` | `out` | |

### Decision log

| Date | Change | Why |
| --- | --- | --- |
| 19 Sep 2026 | Stream = sole article retrieval `in`; Get articles / topic page / article details `out` | Minute refresh without backfill; Tempo-owned settings |
| 19 Sep 2026 | Uri cursors + 60‑min poll; MinsAgo/Tm `out`; max count 100 | Reliable incremental without stacking time params |
| 19 Sep 2026 | Additional filters reused from prior Get articles alignment | Same semantics on Stream; avoid re-litigation |
| 19 Sep 2026 | Returned details locked (social + sentiment `in` as soft priors; concepts + source ranking `in`; synonyms/links/eventUri `out`) | Prioritize/tag/display without confusing vendor fields for Tempo jobs |
| 19 Sep 2026 | Autosuggest: Suggest sources + Suggest concepts `in`; other suggest tabs `out` | Resolve labels → URIs for Stream filters at settings time |
| 27 Oct 2026 | Two drains (concepts OR keywords); never both families on one request | Avoid AND drop; union in Tempo by `uri` |
| 27 Oct 2026 | Body transient only; store article summary, not publisher body | Publisher keep-list lock; summarization stage |
| 28 Oct 2026 | No vendor excerpt; do not persist truncated `body` as excerpt | Docs: Article data model has `body` only; `articleBodyLen` truncates `body`; Tempo `excerpt` stays NULL until a true outlet/feed teaser exists |
| 28 Oct 2026 | Soft priors wire-shaped on press_articles | Persist `shares` jsonb + `importance_rank` + `sentiment`; derive rank floats in app ([D-077](../DECISIONS.md)) |
| 27 Oct 2026 | `lang` `in` on keyword drains (language D); omit on concept drains | Cost/noise control; concepts language-agnostic |
| 27 Oct 2026 | `includeArticleLinks` stays `out` for source rank | Flag is outbound body links; use corroboration + vendor rank + freshness + original/follow-on |
| 27 Oct 2026 | Shared refresh cadence confirmed 60 min (+ warm on scope change) | Process lock |

---

## Autosuggest

**Section status:** locked (19 Sep 2026)

**Tempo job:** At **onboarding / settings** (not on the 60‑min Stream poll), map user-facing labels to vendor URIs, persist those URIs, and pass them on Stream as `sourceUri` / `conceptUri`. Keywords stay plain strings — no suggest call.

### Suggest sources — `in`

**Endpoint:** `GET|POST https://eventregistry.org/api/v1/suggestSourcesFast`  
**Docs:** [Suggest sources](https://newsapi.ai/documentation?tab=suggSources)

Maps a source name or partial domain to candidates whose URIs are clean domains (e.g. `nytimes.com`) for Stream `sourceUri`.

| Param | Status | Tempo use |
| --- | --- | --- |
| `apiKey` | `in` (must) | Auth |
| `prefix` | `in` (must) | User-typed outlet name or domain fragment |

**Consume (response):** pick a candidate `uri` (+ display label) → store for the shared source allowlist. Sorted by how much content ER has collected from that source.

### Suggest concepts — `in`

**Endpoint:** `GET|POST https://eventregistry.org/api/v1/suggestConceptsFast`  
**Docs:** [Suggest concepts](https://newsapi.ai/documentation?tab=suggConcepts)

Maps a concept label/prefix to Wikipedia-style `conceptUri`s for Stream (topics + place geos).

| Param | Status | Tempo use |
| --- | --- | --- |
| `apiKey` | `in` (must) | Auth |
| `prefix` | `in` (must) | User-typed topic or geography label |

**Consume (response):** pick a candidate `uri` (+ `label`) → store for topic/geo concept lists. Sorted by frequency in ER data; first hit is often correct but disambiguate when several match.

**Agent rule:** If Suggest concepts returns no usable URI for a label, treat that label as a Stream `keyword` instead (same fallback as Event Registry’s `getConceptUri()` → `None` guidance).

### Other autosuggest — `out`

| Endpoint | Status | Why |
| --- | --- | --- |
| [Suggest categories](https://newsapi.ai/documentation?tab=suggCategories) | `out` | `categoryUri` is `out` on Stream |
| [Suggest authors](https://newsapi.ai/documentation?tab=suggAuthors) | `out` | `authorUri` is `out` |
| [Suggest locations](https://newsapi.ai/documentation?tab=suggLocations) | `out` | Geo via place **concepts**, not `locationUri` / `sourceLocationUri` |
| [Suggest event types](https://newsapi.ai/documentation?tab=suggEventTypes) | `out` | Event types / mentions not in v0 |

**Note:** SDKs may expose optional paging/`lang` knobs beyond the docs sandbox fields; v0 consumption contract uses only **`apiKey` + `prefix`** as documented on these tabs.

---

## Endpoints (remaining)

Events family, Event types / mentions, MCP/n8n, and other reference tabs — not required for the Stream-first v0 contract. Walk only if product scope expands.
