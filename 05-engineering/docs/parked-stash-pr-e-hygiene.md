# PR E — parked stash hygiene closeout

Final hygiene pass for the parked-stash sequence (PRs A → E). No runtime files changed; nothing in `apps/api/src/**` or `04-prototype/**` was touched.

## What this PR does

1. **Lockfile / dependency sanity.** Ran `npm install` from `05-engineering/` against current `origin/main`. Result: **zero diff** in `package.json` or `package-lock.json` — no registry drift, no leftover stash lockfile noise to clean up. PR B [#24](https://github.com/cabezas-felipe/comms-project/pull/24) deliberately regenerated the lockfile via `npm install` (rather than restoring `package-lock.json` from `stash@{0}`), so this re-run was confirmation that PR B's lockfile choice has not silently rotted under subsequent merges.
2. **Repo cleanliness.** Branch carries only this hygiene doc; no drive-by edits.
3. **Stash closeout** — see [next steps](#next-steps-for-felipe-drop-the-parked-stash) below.

## Status of the parked-stash sequence

| PR | Title | Result |
|---|---|---|
| A | [#23 — `docs(ops): add parked stash triage`](https://github.com/cabezas-felipe/comms-project/pull/23) | Triage doc: 31 paths classified across keep-now / obsolete / defer; conflict-driver routing established. |
| B | [#24 — `chore(api): DB migrate + Phase-1 source-scope scripts and docs`](https://github.com/cabezas-felipe/comms-project/pull/24) | Three ops scripts restored, `pg` dep + `db:*` npm scripts added, three previously-orphaned tests registered in the runner, README ops docs added (`TEMPO_RSS_ALLOWLIST` primary). Lockfile regenerated via `npm install`, not restored from stash. |
| C | [#25 — `refactor(prototype): typed DashboardFetchError and real empty/error states`](https://github.com/cabezas-felipe/comms-project/pull/25) | Seven `04-prototype/**` paths restored: typed `DashboardFetchError`, real empty/error UI, no `STORIES` runtime fallback. Forward-compatible with `_meta.{recall, funnel, beatFit, hasSnapshot, watermark, …}` via Zod's strip-unknown default. |
| D | [#26 — `docs(ops): PR D stash residual audit`](https://github.com/cabezas-felipe/comms-project/pull/26) | Independent re-verification of the 18 `apps/api/src/**` "obsolete" paths: **12 identical · 6 superset(main wins) · 0 novel hunks.** No runtime changes warranted. |
| E | this PR | Lockfile zero-diff confirmation; `npm run test:api` baseline preserved (610 pass, 1 skipped); closeout doc + stash-drop instructions. |

The two earlier docs are still the source of truth for *why* each path landed where it did:

- [`parked-stash-triage-pr-a.md`](parked-stash-triage-pr-a.md) — the per-file classification table, conflict-driver routing, PR split rationale, and "next command" for PR B.
- [`parked-stash-pr-d-audit.md`](parked-stash-pr-d-audit.md) — the per-path verdict (identical / superset / novel) verified against `origin/main` after PRs A–C had landed, plus the audit driver script.

## Verification

```sh
cd 05-engineering
npm install                          # zero diff in package.json + package-lock.json
git status                           # clean — no untracked node_modules churn, no stray lockfile updates
npm run test:api                     # 610 pass, 1 skipped (live-RSS smoke; expected)
```

## Next steps for Felipe (drop the parked stash)

The parked stash is fully accounted for. After PR E merges, you can drop it. Run these locally — **do not run them inside an automated agent**:

```sh
git status                           # tree should be clean
git stash list                       # expect a SINGLE entry; verify message includes "phase0-defer-mixed-scope-files"

# Sanity-check the top stash is still the parked one (NOT some new WIP you might
# have stashed since). Look for the same set of files this sequence audited:
git stash show --name-only stash@{0} | head     # 26 tracked entries; the 5 untracked
                                                 # ones live at stash@{0}^3 — see below.
git stash show stash@{0}^3 --name-only          # untracked files: scripts/run-migrations.mjs,
                                                 # scripts/source-scope-phase1.{mjs,test.mjs},
                                                 # dashboard/beat-fit-scorer.{mjs,test.mjs}

# Only after the two checks above match the parked-stash fingerprint:
git stash drop stash@{0}

# Optional — keep your local refs tidy with the merged branches:
git fetch --prune
git branch -d phase1/scripts-ops phase1/prototype-followup phase1/residual-backend-delta phase1/parked-hygiene-closeout parked/triage-pass-1
```

**Do NOT drop if:**

- `git stash list` shows the top entry is something *other* than `On fix/supabase-migrations-010-014: phase0-defer-mixed-scope-files`.
- The fingerprint check returns a different file count or different paths from what PR A's triage and PR D's audit recorded — that means a new stash got pushed on top after this work, and `stash@{0}` is no longer the parked one.
- You have any local work-in-progress you intended to stash since the original parked stash was created. Reach for `git stash show -p stash@{N}` for any entry you're unsure about before dropping.

If in doubt, leave the stash in place — it's harmless to keep around. The dependency on it is fully replaced by PRs A–E.
