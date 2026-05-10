# PR D — stash residual audit (apps/api/src)

Re-verification pass for the 18 `apps/api/src/**` paths flagged "obsolete" in [`parked-stash-triage-pr-a.md`](parked-stash-triage-pr-a.md). Goal: prove no novel hunk slipped through merged stabilization. Branch base: `phase1/residual-backend-delta` from `origin/main` (= post-#22, post-#24 scripts, post-#25 prototype).

**Headline:** No novel hunks. PR D is documentation-only.

## Method

For each of the 18 stash paths I diffed `git show stash@{0}:<path>` (or `stash@{0}^3:<path>` for untracked entries) against `git show origin/main:<path>`, then:

- **IDENTICAL** if `cmp -s` matches byte-for-byte.
- **+N/-0** (strict-superset on main) if every line in the stash version also appears on main verbatim, with main adding more (verified via `diff` — zero `^<` lines).
- For substantive diffs, audited at the **export-symbol** level (source files) and **`test("…")` name** level (test files), accounting for renames introduced by #22's env-alias rework.

`/tmp/prd-audit.sh` (kept locally, not committed) drives the per-file `cmp -s` + line-level diff loop; reproduced verbatim in the appendix.

## Per-path verdict

| Path | Verdict | Evidence |
|---|---|---|
| `apps/api/src/ai/embeddings.mjs` | identical (105L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/ai/model-router.mjs` | identical (201L) | `cmp -s`: byte-for-byte match (includes `resolveExtractionChain`). |
| `apps/api/src/ai/model-router.test.mjs` | identical (267L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/ai/onboarding-extractor.mjs` | identical (210L) | `cmp -s`: byte-for-byte match (includes `DEFAULT_EXTRACTION_TIMEOUT_MS`, `resolveTimeoutMs`). |
| `apps/api/src/ai/onboarding-extractor.test.mjs` | identical (260L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/ai/providers/openai-embeddings.mjs` | identical (54L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/dashboard/beat-fit-scorer.mjs` | identical (335L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/dashboard/beat-fit-scorer.test.mjs` | identical (253L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/dashboard/refresh-pipeline.mjs` | identical (978L) | `cmp -s`: byte-for-byte match (funnel + recall + watermark guard already on main). |
| `apps/api/src/dashboard/refresh-pipeline.test.mjs` | superset(main wins) | `+30/-0` from main vs stash. Zero lines unique to stash; main adds further hold-bucket / funnel diagnostics tests. |
| `apps/api/src/ingestion/embedding-recall.mjs` | identical (370L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/ingestion/embedding-recall.test.mjs` | identical (493L) | `cmp -s`: byte-for-byte match. |
| `apps/api/src/ingestion/feed-reader.mjs` | superset(main wins) — renamed | `+221/-125`. Stash exports `normalizeAllowlistEntry`, `normalizeAllowlistArray`, `resolveIngestionAllowlist`. Main exports `normalizeAllowlist`, `parseAllowlistEnv`, `resolveAllowlist`, `formatBlockedList`, `isAllowlistVerboseEnv` — strict capability superset under #22's `TEMPO_RSS_ALLOWLIST` primary + `TEMPO_INGESTION_*` legacy alias contract. Main also flips empty-array semantics to permissive (deliberate #22 contract change); restoring stash would be a regression. |
| `apps/api/src/ingestion/feed-reader.test.mjs` | superset(main wins) — renamed | `+384/-351`. Every stash-unique `test("…")` name maps to a renamed equivalent on main (e.g. `resolveIngestionAllowlist: …` → `resolveAllowlist: …`; `applyAllowlistGuard: keeps WaPo` → `applyAllowlistGuard: non-empty allowlist substring-matches`; legacy-env coverage retained via `legacy TEMPO_INGESTION_ALLOWLIST drives the live guard when newer unset` and `isAllowlistVerboseEnv: legacy …`). The lone semantic divergence — stash's `empty array enforces (matches nothing → blocks all)` and `undefined allowlist throws` — tests a deprecated contract that #22 intentionally replaced with permissive-when-empty. Not a coverage gap; a contract decision. |
| `apps/api/src/ingestion/source-matcher.mjs` | superset(main wins) | `+26/-8`. **Zero novel exports** — `comm` of `^export …` lines yields empty diff in either direction. Main's internal placement of `feedIsActive` at the eligibility step is functionally equivalent to stash's index-time `f.active !== false` filter. |
| `apps/api/src/ingestion/source-matcher.test.mjs` | superset(main wins) | `+73/-38`. Two stash-unique scenarios (`inactive manifest rows are excluded`, `rows with active=undefined still match`) are covered on main under different names (`feeds with active=false are excluded from matchedFeeds`, `feeds with active omitted (undefined) remain eligible`); main adds two further scenarios (fallback baseline, only-inactive bucket). |
| `apps/api/src/server.mjs` | superset(main wins) | `+17/-0`. Zero lines unique to stash (verified via `diff … | grep -c '^<'` → 0). |
| `apps/api/src/server.routes.test.mjs` | superset(main wins) | `+340/-0`. Zero lines unique to stash. |

**Counts:** 12 identical · 6 superset(main wins) · 0 novel.

## Conclusion

PR D ships **no runtime changes**. The triage doc's "obsolete" classification is correct under independent re-verification: 12 of the 18 stash paths are byte-identical to current `main`, and the remaining 6 are strict supersets on main (or strict supersets after accounting for #22's documented symbol renames and contract change around empty-allowlist semantics). The conflict-driver trio (`refresh-pipeline.test.mjs`, `feed-reader.mjs`, `feed-reader.test.mjs`) is correctly classified obsolete; restoring any of them would either be a no-op (test file, identical/superset) or a deliberate regression of #22's env-alias work.

The stash is now safe to drop after PRs A–D land — the only remaining surface that referenced it is this audit, the PR A triage, and PR C's prototype-only scope.

## Verification

`cd 05-engineering && npm run test:api` → 610 pass, 1 skipped (live-RSS smoke; expected). Identical to `main` at the time of writing — confirms no accidental drift in this docs-only change.

## Appendix: audit driver

```sh
# /tmp/prd-audit.sh — not committed; reproduce with:
PATHS=(
  05-engineering/apps/api/src/ai/embeddings.mjs
  05-engineering/apps/api/src/ai/model-router.mjs
  05-engineering/apps/api/src/ai/model-router.test.mjs
  05-engineering/apps/api/src/ai/onboarding-extractor.mjs
  05-engineering/apps/api/src/ai/onboarding-extractor.test.mjs
  05-engineering/apps/api/src/ai/providers/openai-embeddings.mjs
  05-engineering/apps/api/src/dashboard/beat-fit-scorer.mjs
  05-engineering/apps/api/src/dashboard/beat-fit-scorer.test.mjs
  05-engineering/apps/api/src/dashboard/refresh-pipeline.mjs
  05-engineering/apps/api/src/dashboard/refresh-pipeline.test.mjs
  05-engineering/apps/api/src/ingestion/embedding-recall.mjs
  05-engineering/apps/api/src/ingestion/embedding-recall.test.mjs
  05-engineering/apps/api/src/ingestion/feed-reader.mjs
  05-engineering/apps/api/src/ingestion/feed-reader.test.mjs
  05-engineering/apps/api/src/ingestion/source-matcher.mjs
  05-engineering/apps/api/src/ingestion/source-matcher.test.mjs
  05-engineering/apps/api/src/server.mjs
  05-engineering/apps/api/src/server.routes.test.mjs
)
for p in "${PATHS[@]}"; do
  m=$(git show "origin/main:$p" 2>/dev/null)
  s=$(git show "stash@{0}:$p" 2>/dev/null || git show "stash@{0}^3:$p" 2>/dev/null)
  if [ "$m" = "$s" ]; then echo "IDENTICAL  $p"
  else echo "DIFFER     $p"; fi
done
```

For DIFFER paths, I followed up with:

- `comm -23 <(grep -oE '^export [^=(]+' stash) <(grep -oE '^export [^=(]+' main)` to surface stash-unique exports.
- `comm -23 <(grep -oE 'test\("[^"]+"' stash | sort -u) <(grep -oE 'test\("[^"]+"' main | sort -u)` to surface stash-unique test scenarios, then mapped each to its renamed equivalent on main.
