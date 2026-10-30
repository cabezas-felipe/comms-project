# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Nature

This is primarily a **product discovery research repository** (Markdown-first). Product work lives under [`02-product`](02-product). Engineering for the Tempo prototype and shared packages lives under [`06-engineering`](06-engineering): run **`cd 06-engineering && npm install`** then **`npm run dev`**, **`npm run build`**, **`npm run test:packages`**, etc. See [`06-engineering/README.md`](06-engineering/README.md).

Vercel Git Root Directory (repo-relative): frontend `05-prototype` (`tempo-web`); API `06-engineering/apps/api` (`tempo-api` / `tempo-gray-psi`).

Dashboard `story.whatChanged` is produced by the **3-state delta engine** — deterministic structural gate plus optional Haiku + Sonnet stages, **default off** until `TEMPO_AI_DELTA_ENABLED=true`. See [`what-changed-spec.md`](06-engineering/docs/what-changed-spec.md) and the [handoff](06-engineering/docs/what-changed-handoff.md).

## Linking Convention

Per `.cursor/rules/markdown-links.mdc`:

- Internal docs use Markdown hyperlinks with **relative paths** (relative to the editing file)
- External URLs use full HTTPS

## Research Architecture

The research follows a structured flow:

```
Interview Guides → Sessions → Synthesis → Context Map → Backlog → Decisions
```

**Key files (read these first when resuming work):**

- `01-research/personas.md` — persona source of truth (status gates what may inform product)
- `01-research/ops/research-context.md` — living snapshot of current beliefs, open questions, and confidence levels
- `01-research/ops/session-log.md` — interview timeline, verdicts, and decision impact per session
- `01-research/ops/quote-library.md` — verbatim evidence indexed by theme
- `01-research/synthesis--personas-and-pains-discovery.md` — primary evidence base (rolling synthesis; wave 1: N=1 participant, two sessions, Apr 16–17 2026; extended as additional participants are added)

**Raw transcripts:** `01-research/interviews/` holds local, lightly-redacted backups of Granola transcripts (`interview--...md`), gitignored — evidence preservation only, not tracked in git and not a citation source. Cite the synthesis or session log instead.

**Supporting files:**

- `01-research/guide--personas-and-pains-discovery.md` — active discovery protocol (personas + pains, ongoing)
- `01-research/archive/brief--zero-to-one.md` — decision frame and guiding questions (wave 1, archived)
- `01-research/archive/guide--zero-to-one.md` — baseline workflow discovery protocol (wave 1, archived)
- `01-research/archive/guide--zero-to-one--monitoring.md` — monitoring deep-dive protocol (wave 1, archived)

Archive note: treat `01-research/archive/` as historical context only — these are completed, round-specific interview instruments (wave 1) superseded by the current discovery guide above. Do not use as current research protocol unless explicitly requested.

## Product

Product strategy, roadmap, and product decisions live under [`02-product`](02-product).

- **Strategy:** [`02-product/strategy/tempo.md`](02-product/strategy/tempo.md) — living spine; add `strategy/archive/` only when a strategy doc is superseded
- **PRDs:** [`02-product/prds/`](02-product/prds/) — active slice PRDs named `{capability}--v{n}.md` (e.g. `onboarding--v1.md`); model PRDs `model--{capability}--v{n}.md` (e.g. `model--extraction--v1.md`); retired PRDs in [`prds/archive/`](02-product/prds/archive/)
- **Contracts / field doctrine:** [`02-product/contracts/`](02-product/contracts/); archived doctrine in [`contracts/archive/`](02-product/contracts/archive/)
- **Evals (datasets + eng briefs):** [`06-engineering/docs/evals/`](06-engineering/docs/evals/) — e.g. `{capability}.gold.json`

Archive folders are historical only — do not use as build source unless superseding them deliberately.

## Design system (prototypes)

When building or describing UI prototypes (Cursor, Claude Code, v0, etc.), use `03-design/design-system/` as the single source of truth (**Gravel & Fire system, v1.2.60 — Newsreader + Inter**):

- [Principles](03-design/principles.md) — experience and interface constraints (lives at `03-design/` level, not inside `design-system/`)
- [Design system README](03-design/design-system/README.md) — master index; start here
- [Design tokens (JSON)](03-design/design-system/tokens/design-tokens.json) — canonical values (Option-C semantic names)
- [Design tokens (CSS)](03-design/design-system/tokens/tokens.css) — CSS custom properties with `prefers-reduced-motion` overrides
- [DS mapping](03-design/design-system/ds-mapping.md) — decision log and Option-C → shadcn bridge table
- [AI usage](03-design/design-system/ai-usage.md) — copy-paste instructions for prompts

**Prototype note:** `05-prototype/src/index.css` uses shadcn-style variable names (`--background`, `--foreground`, `--ember`) for shadcn component compatibility. The DS docs use Option-C names. See `ds-mapping.md` for the bridge.

Archive note: treat `03-design/archive/` as historical context only. Do not use archived files as implementation source unless explicitly requested.

## Research State & Conventions

**Confidence scoring used throughout:**

- 🟠 Low — N=1, not yet replicated
- (Higher tiers undefined until more sessions)

**Roadmap classifications:** Validate Further, Strategic Bet, Monitor, Fix Now

**Citation pattern:** Every claim links back to source (Granola notes + meeting ID)

## Current Research Status (as of Apr 2026)

- **Subject:** Solo bilateral comms leads managing cross-country/language communications (Colombia–US context)
- **Primary participant:** Mercedes Osma (2 sessions)
- **Top validated pain:** Monitoring narrative shifts while drafting — constant self-interruption to check if the story changed before a response is finalized
- **Priority split:** Monitoring (70%) > Inbound media requests (20%) > Graphic production (10%)
- **Confidence:** 🟠 Low — all findings pending replication with 2–3 more participants
- **Next step:** Run additional interviews with similar solo bilateral operators to validate or challenge the monitoring-first hypothesis

