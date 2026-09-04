# Comms project v0 | MVP

Build and test a trusted monitoring dashboard that reduces tab switching for a comms operator tracking US and Colombia narratives.

Status: Draft  
Owner: Felipe  
Last updated: 20 Apr 26  
PRD track: Exploration

## User problem

Primary user: a solo comms operator drafting under time pressure while tracking bilateral narratives.

Pain:

- Monitoring is interruptive and forces constant switching across sources.
- Trust in synthesized output is fragile; if provenance is unclear or incomplete, the user reverts to manual source checking.

Evidence:

- Existing research shows monitoring is the highest pain and closely tied to drafting.
- Success condition: one readable tool with real sources that is trusted enough to reduce Google/X switching.

Hypothesis:

- If the product clusters real-source coverage into clear stories with visible provenance and concise updates, the user will rely on it as the main monitor.

## Business problem

Why now:

- A prototype can be built immediately and evaluated with a known target user in the next few days.
- Early trust and usability learning de-risks later investment in ranking, automation, and notifications.

Strategic fit:

- Monitoring-first directly addresses the top-ranked workflow pain identified in discovery artifacts.

Constraints and assumptions:

- Use real feeds and bounded integrations for V0.
- Do not optimize for institutional policy constraints in this slice.
- Keep onboarding low-friction with clear data handling.
- Product surface is web/laptop-first for V0; mobile is post-MVP unless user testing proves immediate mobile necessity.

## Prioritization logic

This slice is prioritized for fast learning and easy rollback:

- Highest confidence pain area from existing interviews.
- Clear test: does the user rely on this dashboard or return to manual scanning.
- Scope can remain narrow (2 geographies, 3 topics) while still representing real work.

## Goals, success metrics, and guardrails

Goals:

- Deliver a working monitor with real data, story clustering, and provenance.
- Enable onboarding that is fast and understandable.
- Support trust and readability for daily use.

Primary metric:


| Metric           | Definition                | Baseline | Target         | Time window            | Source of truth         |
| ---------------- | ------------------------- | -------- | -------------- | ---------------------- | ----------------------- |
| Daily active use | Days used in a 7-day week | -        | >= 4 of 7 days | First 2 weeks of usage | In-product usage events |


Secondary metrics:


| Metric                       | Definition                                                  | Baseline | Target       | Time window                   | Source of truth                                 |
| ---------------------------- | ----------------------------------------------------------- | -------- | ------------ | ----------------------------- | ----------------------------------------------- |
| Time to first relevant story | Time from app open to first actionable story                | -        | <= 2 minutes | First 1-2 evaluation sessions | Session notes and timestamps                    |
| Trust confirmation rate      | Share of stories marked trustworthy after provenance review | -        | > 75%        | First 2 weeks of usage        | In-product thumbs up/down + brief debrief notes |


Guardrails:

- No fabricated summary content; summaries must map to cited sources.
- Every story summary must expose source links and timestamps.
- Onboarding must include explicit copy for storage/privacy behavior.

## Exploration (AI-assisted)

Hypotheses to test in this slice:

- Clustering across outlets produces a more useful unit than an article-by-article feed.
- A concise AI title, short summary, and "what changed" block support fast scanning.
- Optional voice onboarding can increase completion without reducing trust if transcripts are editable and constraints are explicit.

Alternatives considered:

- Text-only onboarding: lower build risk but potentially more friction.
- Simple article feed without clustering: faster build but weaker fit to story-evolution monitoring.
- UI prototyping with real connectors: highest realism but slower design iteration.

Decision:

- Build a clustered story object now.
- Keep voice onboarding optional and constrained.
- Prioritize trust and provenance over advanced ranking.
- Use fake but realistic stories for UX/UI prototyping before integrating production connectors.

## Solution

### Overview

V0 provides:

- One-screen onboarding (typed or optional voice).
- AI parsing and structuring into topics, keywords, geographies, and source preferences.
- Real feed ingestion from bounded connectors.
- Story clustering across multiple outlets into evolving story objects.
- Story list with concise summaries and change markers.
- Settings-based management for key profile fields.

### User flow

1. User completes onboarding (typed or voice).
2. System produces structured monitoring profile and asks for quick confirmation.
3. Dashboard loads clustered stories for US/Colombia and selected topics.
4. User scans top stories, reads summary, validates through linked sources.
5. User adjusts scope (topics/keywords/geos/sources) in settings as needed.

### Scope

In scope:

- 2 geographies: US and Colombia.
- 3 user-defined topics.
- Optional voice onboarding with transcript editing.
- Real-source ingestion and story clustering.
- Story cards with title, summary, update delta, and provenance links.
- Hourly slow-mode default refresh and visible last-updated stamp.
- Basic add/remove management for topics, keywords, geographies, and sources.

Out of scope:

- Auto slow/fast switching logic.
- Severity and velocity scoring beyond simple ordering.
- Notification channel system (push/email/SMS).
- Watch-list lifecycle and timer logic.
- Ideological balancing automation.

## Execution spec (agent-ready)

Goal:

- Ship an end-to-end prototype that proves trusted story monitoring for US/Colombia and 3 topics.

Inputs:

- Onboarding input (typed text or short voice transcript).
- Seed source connector configuration.
- Geographies: US, Colombia.

Outputs:

- Structured monitoring profile.
- Clustered story feed with provenance.
- Settings updates that alter subsequent feed composition.

Core logic:

1. Collect onboarding input and parse normalized entities: topics, keywords, geographies, and sources/accounts.
2. Resolve obvious duplicates and normalize names.
3. Ingest real articles/posts from bounded connectors and store metadata.
4. Cluster items into story objects by semantic similarity, entity/topic overlap, and time window.
5. Generate AI story title and short summary from clustered items.
6. Compute "what changed since last update" from new items and cluster changes.
7. Render prioritized story cards with title, summary, delta, and source list.
8. Support settings updates and re-run profile/feed filtering.

Edge cases:

- Sparse onboarding input: ask a clarifying prompt for missing required fields.
- Very long onboarding input: truncate with confirmation and keep full text in review.
- Voice transcription uncertainty: flag low-confidence words for user edits before submit.
- Empty feed for selected scope: show actionable guidance to add sources/topics.

Constraints:

- Real-source only; no synthetic source generation.
- Bounded connector count in V0.
- Preserve clear attribution from summaries to source links.
- Keep flow usable on laptop-first surfaces.

Open questions blocking build:

- PM input required: V0 source connector shortlist.
- PM input required: clustering threshold strategy for multilingual content.
- PM input required: exact copy for data handling and storage disclosures.

## Learning agenda

Unknowns:

- Minimum provenance detail needed for user trust.
- Whether optional voice materially improves onboarding completion.
- Whether clustered summaries reduce external tab checks.

Evaluation slice:

- Run 1-2 observed sessions and compare behavior with and without the tool.

Success signals:

- User keeps the dashboard as the primary tab during monitoring periods.
- User validates trust through source links and continues using summaries.

Failure signals:

- Frequent reversion to Google/X despite dashboard updates.
- Repeated distrust in summary accuracy or source coverage.

Rollback / blast radius:

- Prototype-only scope with local rollback: disable voice onboarding or clustering via feature flags/config.
- Kill condition: if trust fails in early sessions, pause expansion and revisit story modeling assumptions.

## Risks, assumptions, and open questions

Risks:

- Clustering errors may merge unrelated stories or split one story into many fragments.
- Summary quality may reduce trust if provenance appears mismatched.
- Voice privacy concerns may lower onboarding completion.

Assumptions:

- User values reduced context switching enough to adopt a new monitoring surface (confidence: medium).
- Hourly slow-mode cadence is acceptable for default behavior (confidence: medium).
- Bounded real sources are enough to test trust in V0 (confidence: medium).

Open questions:


| Question                                                            | Owner  | Due date                         | Default if unresolved                               |
| ------------------------------------------------------------------- | ------ | -------------------------------- | --------------------------------------------------- |
| Which sources/connectors are included in first build?               | Felipe | Before implementation start      | Use minimal RSS + one social/search connector       |
| How will multilingual clustering be tuned for US/Colombia coverage? | Felipe | Before clustering implementation | Start with conservative clustering thresholds       |
| What exact privacy/storage copy is shown in onboarding?             | Felipe | Before onboarding implementation | Use explicit draft copy and revise after first test |


Decision log:


| Decision                                 | Rationale                                                                    | Date      | Revisit trigger                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------- | --------- | --------------------------------------------------------------- |
| Include smarter story clustering in Now  | Core trust/usefulness depends on story-level monitoring across outlets       | 20 Apr 26 | If clustering quality blocks usability                          |
| Keep voice onboarding optional in Now    | Reduces friction while preserving typed fallback for privacy-sensitive users | 20 Apr 26 | If voice adds significant implementation risk or trust concerns |
| Keep scope to US + Colombia and 3 topics | Reflects real user need while constraining V0 complexity                     | 20 Apr 26 | If feed sparsity or overload appears during testing             |
