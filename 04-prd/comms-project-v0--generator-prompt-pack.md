# Comms project v0 | Generator prompt pack

Use this document to prompt UI generators such as v0 and Lovable. This is derived from the PRD and optimized for generation quality.

## Master prompt (copy/paste)

Build a web app prototype (laptop-first) for a solo comms operator who monitors narratives in the United States and Colombia while drafting responses.

Goal:

- Reduce tab switching across Google, X/Twitter, and other sources.
- Present trusted, readable story monitoring in one dashboard.

Scope for this prototype:

- Use fake but realistic story data.
- 2 geographies: United States, Colombia.
- 3 topics.
- Story objects are clustered across outlets (not one card per article).
- Every story must show source provenance (clickable source links and timestamps).
- Slow mode default behavior (hourly updates shown in UI as metadata only for prototype).
- Web/laptop-first only. Do not design native mobile screens in this pass.

Required screens:

1. Onboarding (single screen, typed or optional voice path)
2. Main dashboard (story feed with clear hierarchy)
3. Story detail (summary + source list, without losing feed context)
4. Settings/management (edit topics, keywords, geographies, and sources)

Interaction rules:

- Keep feed context visible while user reads a story or opens a source.
- Emphasize top stories visually without hiding lower-priority stories.
- Include "what changed since last update" in story cards and story detail.
- Include trust signal UI in story detail (thumbs up/down).

Content and UX constraints:

- Keep copy concise and plain-language.
- Avoid speculative features outside V0 (no notification matrix, no auto slow/fast switching, no watch-list lifecycle logic).
- Show loading, empty, and error states.
- Prioritize clear readability and scan speed.

Style direction:

- Professional monitoring dashboard style.
- High information clarity, low visual clutter.
- Neutral base palette with clear emphasis for priority states.

Output expectation:

- Return complete page-level UI with realistic component hierarchy and sample content.

## Screen prompt: onboarding

Design a one-screen onboarding flow for a monitoring dashboard.

Include:

- Intro value proposition in one short paragraph.
- Input options:
  - Typed input (primary)
  - Optional voice input (secondary)
- Fields captured from user intent:
  - Topics of interest
  - Keywords
  - Geographies
  - Trusted sources/accounts
- Transcript review/edit step for voice path.
- Clear disclosure copy:
  - what is stored
  - what is not stored
- Scope confirmation summary before continue.

State requirements:

- Empty state guidance
- Validation state for missing required info
- Success transition to dashboard

## Screen prompt: dashboard

Design a laptop-first dashboard for clustered story monitoring.

Include:

- Header with last updated timestamp and mode indicator (Slow).
- Main feed of story cards ranked by relevance.
- Story card content:
  - AI story title
  - 2-3 line summary
  - "What changed since last update"
  - Top sources preview (with outlet + time)
- Visual hierarchy:
  - Top stories clearly emphasized
  - Remaining stories still scannable
- Filters:
  - Topic filter
  - Geography filter

Behavior requirements:

- Clicking a story opens detail while keeping feed visible.
- Source provenance must always be visible at a glance.
- Include loading, empty feed, and error UI states.

## Screen prompt: story detail

Design a story detail panel/page that preserves monitoring context.

Include:

- Story title
- Short AI summary
- "Why this matters" line
- "What changed" section
- Source list with clickable outlets/articles and timestamps
- Trust input: thumbs up/down

Layout requirement:

- Keep main feed visible (split view or persistent side panel).

## Screen prompt: settings and management

Design a settings/management screen for monitoring scope.

Include editable sections:

- Topics
- Keywords
- Geographies
- Sources/accounts

Interaction requirements:

- Add/remove items
- Simple confirmation for destructive actions
- Save/apply feedback

Out of scope in this screen:

- Advanced weighting sliders
- Full watch-list lifecycle logic

## Fake story seed data (for UI generation)

Use the following sample story objects:

1. Story title: "OFAC scrutiny expands around Colombia leadership narrative"
  - Geography: US, Colombia
  - Topic: Diplomatic relations
  - Summary: Coverage across US and Colombian outlets frames possible sanctions implications and response pressure. Narrative is widening from policy reporting to political reaction.
  - What changed: Two major outlets added legal-context framing in the last hour.
  - Sources:
    - New York Times (20 min ago)
    - Washington Post (34 min ago)
    - El Pais (50 min ago)
2. Story title: "US deportation-routing discussion involving Rwanda resurfaces"
  - Geography: US, Colombia
  - Topic: Migration policy
  - Summary: Early signals from policy and regional outlets suggest renewed attention on deportation routing and bilateral implications.
  - What changed: Local coverage volume increased and one new government statement appeared.
  - Sources:
    - Reuters (15 min ago)
    - Semana (41 min ago)
    - AP (55 min ago)
3. Story title: "Regional security coordination debate grows after congressional comments"
  - Geography: US
  - Topic: Security cooperation
  - Summary: Commentary has shifted from isolated remarks to broader debate about diplomatic and security alignment.
  - What changed: Social discussion accelerated and one mainstream source reframed the story.
  - Sources:
    - Politico (12 min ago)
    - El Tiempo (38 min ago)
    - Bloomberg (59 min ago)

## Fast fallback prompt (short version)

Create a laptop-first monitoring dashboard prototype for a solo comms operator tracking US and Colombia narratives. Use fake realistic data. Include: one-screen onboarding (typed + optional voice with transcript edit and storage disclosure), dashboard with ranked clustered story cards (title, 2-3 line summary, what changed, source links/timestamps), story detail that keeps feed visible, and settings to edit topics/keywords/geographies/sources. Prioritize readability, trust/provenance, and low clutter. Show loading/empty/error states. Exclude auto mode switching, notification matrix, and advanced watch-list logic.