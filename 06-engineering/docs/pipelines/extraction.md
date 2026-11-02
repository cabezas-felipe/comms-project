# Extraction — pipeline / runtime SoT

> **Stage:** Extraction · **Status:** Locked (Session C) · **Last updated:** 2 Nov 2026 (MVP carry-over)  
> **Altitude:** Engineer pipeline SoT (pre-runtime). Does **not** duplicate prompt text — see [prompts/extraction.md](../prompts/extraction.md). Invoke CTAs, identity write timing, and per-facet resolve locks live in [model--extraction--v1.md](../../../02-product/prds/model--extraction--v1.md).

**Related**

- Product contract: [extraction.md](../../../02-product/contracts/extraction.md)
- Model PRD (invoke / resolve / chip acceptance): [model--extraction--v1.md](../../../02-product/prds/model--extraction--v1.md)
- Onboarding UX (Review gate): [onboarding--v1.md](../../../02-product/prds/onboarding--v1.md)
- Prompt SoT (`extraction-v1`): [prompts/extraction.md](../prompts/extraction.md)
- Product data ERD: [tempo.dbml](../data/tempo.dbml) · [Database library](https://dbdiagram.io/d/6ab4852e58694256127b2a37)
- Extraction runs (Session D, locked): [extraction-runs.dbml](../data/extraction-runs.dbml) · [dbdiagram](https://dbdiagram.io/d/Extraction-runs-6ab952050f25a52d011d406d)
- Eval / gold (Session E, locked): [evals/extraction.md](../evals/extraction.md) · [extraction.gold.json](../evals/extraction.gold.json)
- UX happy path: [Paper — Onboarding](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/4-0/70H-0)
- UX extract fail: [O4a · Extract fail](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0)
- Pattern: stage pipelines live at `06-engineering/docs/pipelines/{stage}.md`

---

## 1. Purpose

Orchestrate **when** extraction runs, **what happens** on success/failure, how chips **merge** with user edits, and which **behavioral signals** we keep — without owning prompt wording or the runs schema.

---

## 2. Happy path (sequence)

```mermaid
flowchart TD
  edit[Edit_blurbs_O3_or_Settings]
  trigger[Explicit_Build_or_Rebuild_or_Retry]
  o4[O4_Extracting]
  llm[One_multi_lane_LLM_call]
  val[Parse_and_schema_validate]
  hyg[Deterministic_hygiene]
  res[Catalog_resolve]
  o5[O5_Review_onboarding_only]
  live[Scope_live]
  o4a[O4a_Extract_fail]
  edit --> trigger
  trigger --> o4
  o4 --> llm
  llm -->|success| val
  llm -->|primary_and_fallback_fail| o4a
  val -->|invalid| o4a
  val -->|ok| hyg
  hyg --> res
  res -->|onboarding| o5
  res -->|settings_Rebuild| live
  o5 -->|confirm| live
  o4a -->|Retry| o4
  o4a -->|Edit_answers| edit
```

| Step | Rule |
|------|------|
| Trigger | **Explicit only:** onboarding **Build my scope** / **Build anyway**; O4a **Try again**; Account Context **Save** (persist + rebuild); Account a03g **Try again**. Field edits alone do **not** call the LLM. |
| Blurb edits before trigger | User may change **1–5** blurbs. No requirement to touch all five. |
| LLM payload | **Always multi-lane:** all **currently filled** blurbs in one call ([prompt SoT](../prompts/extraction.md)). |
| Success UI — **onboarding** | **Review required** (O5) before scope is live. |
| Success UI — **Account** | **No Review surface.** Apply merge (§4) and update live chips. Operator removes unwanted tags in Account Tags. |
| Failure UI | Onboarding: **[`O4a · Extract fail`](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/IB7-0)**. Account: **a03g** (dual-mode write \| extract — [account--v1.md](../../../02-product/prds/account--v1.md)). Do not pretend extract succeeded. |
| Empty-but-valid extract | Onboarding: Review empty/thin states (e.g. `O5a`), not extract-fail. Account: apply empty merge (no new chips); keep prior live chips. |

**Account trust rule:** Live chips must not change from **blurb field edits alone**. Context **Save** is the explicit rebuild commit (write blurbs → invoke `rebuild`). After success, new extracts **merge in** (add / resurrect per §4); prior T/K/G/Press/Platforms chips are **not** auto-dropped. Operator prunes in Tags — no second Review product for MVP ([account--v1.md](../../../02-product/prds/account--v1.md) · [model--extraction--v1.md](../../../02-product/prds/model--extraction--v1.md)).

**Deferred:** single-lane LLM call when only one settings blurb changed. Not in v1.

---

## 3. Post-model order (success path)

1. **Parse / schema-validate** lane-keyed JSON (`extraction-v1` shape).  
2. **Deterministic hygiene** — **hygiene-only** (pathology guards). See [§3.1](#31-hygiene-allowlist-mvp-carry-over). Within one lane, after lower+trim, if the same string is in both `topics` and `keywords`, **keep the topic and drop the keyword**. Personal and organization lanes stay separate, so the same string may exist on both with different `source` values.  
3. **Catalog resolve** — Model never emits UUIDs. Match `function_label` → `functions.name` → `function_id`; treat `organization_submitted` as alias → `organizations` → `organization_id`; facet/press/X normalize per [tempo.dbml](../data/tempo.dbml) and the resolve locks in [model--extraction--v1.md](../../../02-product/prds/model--extraction--v1.md). Unresolved FKs may be null pending ops.  
4. **Identity write (lane 1 filled):** on successful parse + resolve, **before** onboarding Review — INSERT/UPDATE `user_role_organization` (labels + resolved FKs). Chip memberships for lanes 2–5 are **not** written here.  
5. **Onboarding only:** present Review chips (canonical forms the user will confirm). Session draft only for Topics / Keywords / Geographies / Press / Platforms.  
6. **Commit memberships:** onboarding on **Start monitoring** (warm accept); Account **immediately** after resolve — apply merge rules (§4) and mark scope live / update memberships. Stamp run `accepted_at` at this moment.

Hard failure at (1) (or equivalent unusable payload) → same as LLM failure → **O4a** (or Account fail equivalent). Do **not** write identity or memberships on hard fail.

### 3.1 Hygiene allowlist (MVP carry-over)

**In (structural only):**

| Guard | Rule |
|-------|------|
| Trim / empty | Drop empty / whitespace-only after trim |
| Lower+trim | Product store match keys: **lowercase + trim** only — **no** synonym / canonicalize map in extraction hygiene |
| Junk | Drop strings with no Unicode letter or number |
| Caps | **64** chars max per item; **24** items max per array (after sort); apply per lane array |
| Handles | Social axis: well-formed `@` handle shape; non-social axes: drop items that start with `@` |
| Dedupe | Case-insensitive; first occurrence wins |
| Sort | Case-insensitive stable sort, then list cap |
| Geo≠keyword | After lower+trim, strip keywords that **exactly** match a geography string in that lane — **no** geo synonym/alias table in hygiene |
| Topic≠keyword | Same string in both → keep topic, drop keyword |
| Sources | Same junk / trim / dedupe / caps package; **no** taste filters (e.g. WHO / “bulletins”) |

**Out (do not port from legacy `extract-v8` sanitizer):**

- Additive recall (`KEYWORD_PATTERNS`, `deriveTopicHints`, handle→keyword injects)
- Noise / qualifier denylists (`NOISE_TOPICS`, `NOISE_KEYWORDS`, qualifier-token stripping, contextual topic suppress)
- Synonym / canonicalize rewrites (e.g. `election` → `Elections`, “Migration policy” folds)
- “Additive pattern hints” as permission to inject labels the model did not emit

Prompt + gold own canonical labels and conservatism. Revisit a tiny evidence-based denylist or fold only with advisory-suite citation — not from as-is memory.

### 3.2 Timeouts (MVP carry-over)

| Knob | Default | Env (build) |
|------|---------|-------------|
| Per-attempt timeout | **15000** ms (ceiling; return as soon as the model finishes) | `TEMPO_AI_TIMEOUT_MS` or extraction-specific override at build |

Primary and fallback each get their **own** 15s budget (do not share one wall clock across both attempts). Same **15s** default applies to summarization and story-tagging per-attempt timeouts ([summarization.md](./summarization.md) · [story-tagging.md](./story-tagging.md)).

---

## 4. Chip merge / re-extract (from product DBML)

Adopt [tempo.dbml](../data/tempo.dbml) / [data README](../data/README.md), with the **MVP Account amend** from [onboarding--v1.md](../../../02-product/prds/onboarding--v1.md):

| Event | Behavior |
|-------|----------|
| Extract proposes item | INSERT/upsert join with `origin = extracted` |
| User removes chip | `deleted_at` + `end_reason = user_removed` |
| User adds chip | `origin = user_added` (or clear end on same PK) |
| Re-extract drops an `extracted` item (T/K/G/Press/Platforms) | **MVP: do not auto-drop** — keep prior chips; `superseded` unused in these product flows |
| Re-extract proposes again after `user_removed` | **Resurrect** (clear `deleted_at` / `end_reason`) |
| `user_added` on re-extract | **Untouched** |
| Stakeholders | Extract-only (no Add/x); drop → `deleted_at` (schema may still use `superseded` here / later) |
| Active scope | `deleted_at IS NULL` |
| Later analytics reject (stored then removed) | `extracted` + `user_removed` — not first-Review chip acceptance (that is PostHog `extraction_chip_acceptance` in the model PRD) |

---

## 5. Behavioral signals map

| UX event | Label meaning | Stored how (target) |
|----------|---------------|---------------------|
| Extract proposes chip | Model suggestion | `origin = extracted` |
| User removes chip | Reject | `user_removed` |
| User adds chip | Fill gap / preference | `user_added` |
| Re-extract would drop extracted (T/K/G/Press/Platforms) | MVP: no-op keep | Prior row stays active |
| Re-extract resurrects after remove | Model proposes again | Clear `deleted_at` |
| Leave chip unchanged through Review | Soft accept (onboarding) | No row change |
| O4a Retry | Infra/model failure recovery | Runs row `failed`, then new run |
| Start monitoring (warm accept) | Scope committed (onboarding) | Memberships written; run `accepted_at`; PostHog `extraction_chip_acceptance` |
| Account Context Save success | Scope updated without Review | Merge applied; run `accepted_at` on successful merge |
| Model invoke finished | One LLM invoke completed (success or fail; primary→fallback = **one** event, not per attempt) | PostHog `extraction_invoke` (not a quality score; not per `extraction_runs` row) |

Per-run model metadata → [extraction-runs.dbml](../data/extraction-runs.dbml). Each extract **attempt** must write a run record once migrated to Supabase.

---

## 6. Runtime gap (build phase)

This pipeline describes the **target** (five blurbs, multi-lane call, onboarding Review, settings add-only merge, O4a, DBML joins). Live prototype may still use a single-narrative `extract-v8` + sanitizer into a settings blob until reconcile. Do **not** port additive recall, noise denylists, or synonym maps from that sanitizer into `extraction-v1` hygiene ([§3.1](#31-hygiene-allowlist-mvp-carry-over)). Do not assume five-lane migrations already ship.

---

## 7. Out of this document

- Prompt instructions / JSON field semantics → [prompts/extraction.md](../prompts/extraction.md)
- Product intent / non-goals → [contracts/extraction.md](../../../02-product/contracts/extraction.md)
- Onboarding Review UX → [onboarding--v1.md](../../../02-product/prds/onboarding--v1.md) · Paper O5
- Eval / gold → [evals/extraction.md](../evals/extraction.md)
- Per-facet resolve / Slack ops / invoke CTA table → [model--extraction--v1.md](../../../02-product/prds/model--extraction--v1.md)
- Production chip-efficacy reports → later analytics (join runs ↔ memberships)
- Account Tags / Context prune UX → Account / design SoT (no Review gate)

---

## Decision log (Session C)

| Date | Lock | Choice |
|------|------|--------|
| 27 Sep 2026 | Path | `06-engineering/docs/pipelines/extraction.md` |
| 27 Sep 2026 | Fail-closed | Persist blurbs; O4a; no Review on call failure |
| 27 Sep 2026 | Merge | DBML rules as written (incl. resurrect) |
| 27 Sep 2026 | Triggers | Explicit Build/Rebuild/Retry; edit 1–5 blurbs OK; always full multi-lane on filled set |
| 27 Sep 2026 | Post-model | Validate → hygiene → resolve → (Review if onboarding) |
| 27 Sep 2026 | Signals | Behavioral map above; run schema → Session D (`extraction runs`) |
| 27 Sep 2026 | Deferred | Single-lane settings extract |
| 17 Oct 2026 | Review gate | **Onboarding only.** Account Rebuild applies merge live; no second Review UI ([account--v1.md](../../../02-product/prds/account--v1.md)). |
| 17 Oct 2026 | Account merge | T/K/G/Press/Platforms: no auto-drop on re-extract; operator removes in Tags. |
| 17 Oct 2026 | Account Save | Persist + rebuild (not blurb-edit-alone). Invoke table → [model--extraction--v1.md](../../../02-product/prds/model--extraction--v1.md). |
| 17 Oct 2026 | a03g | Dual-mode fail (`fail_kind` client-only); generic MVP copy. |
| 02 Nov 2026 | Identity vs chips | Identity upsert at resolve (pre-Review); lane 2–5 memberships at Start monitoring / Account merge. Aligns model PRD. |
| 02 Nov 2026 | Signals | Clarify chip acceptance vs stored `user_removed`; name `extraction_invoke`. |
| 2 Nov 2026 | Carry-over 1 | **B′** — hygiene-only; no additive recall; retire “additive pattern hints” as injectors |
| 2 Nov 2026 | Carry-over 2 | **B** — no noise / qualifier denylist in v1 |
| 2 Nov 2026 | Carry-over 3 | **B** — lower+trim only; no synonym map in extraction hygiene |
| 2 Nov 2026 | Carry-over 4 | **A** — caps **64** chars / item, **24** items / array |
| 2 Nov 2026 | Carry-over 5 | **15s** per LLM attempt (extraction + summarization + story-tagging); ceiling only |
| 2 Nov 2026 | Carry-over 6 | **A** — structural package only (junk/handles/dedupe/sort/exact geo≠keyword/topic≠keyword); no source taste filters |
| 2 Nov 2026 | `extraction_invoke` grain | Once per invoke (not per attempt) — aligns PRD / D-088 |
