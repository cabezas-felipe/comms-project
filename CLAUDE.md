# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Nature

This is a **product discovery research repository**, not a software project. There are no build, lint, or test commands. All work is in Markdown documents.

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

- `01-research/00-ops/research-context.md` — living snapshot of current beliefs, personas, open questions, and confidence levels
- `01-research/00-ops/session-log.md` — interview timeline, verdicts, and decision impact per session
- `01-research/00-ops/quote-library.md` — verbatim evidence indexed by theme
- `01-research/interview-synthesis--zero-to-one--mercedes-osma.md` — primary evidence base (N=1, two sessions, Apr 16–17 2026)

**Supporting files:**

- `01-research/research-brief--zero-to-one.md` — research decision frame and guiding questions
- `01-research/interview-guide--zero-to-one.md` — baseline workflow discovery protocol
- `01-research/interview-guide--zero-to-one--monitoring.md` — monitoring deep-dive protocol

## Design system (prototypes)

When building or describing UI prototypes (Cursor, Claude Code, v0, etc.), use `02-design/` as the single source of truth:

- [Design system README](02-design/README.md) — entrypoint, foundations, components, tokens, AI usage
- [Design tokens (JSON)](02-design/tokens/design-tokens.json) — canonical values
- [Design tokens (CSS)](02-design/tokens/tokens.css) — CSS variables, including `prefers-reduced-motion` overrides
- [Color preview](02-design/color-preview.html) — single visual artifact explaining final color decisions and rationale

Archive note: treat `02-design/archive/` as historical context only. Do not use archived files as implementation source unless explicitly requested.

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

