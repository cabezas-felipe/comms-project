# Features

**Update:** 8 Sep 26

> **Scope:** This bank is for the **solo comms operator** persona only ([p1 — User personas](../01-research/personas.md)).
> **What counts as a feature:** A distinct capability p1 can use to make progress across the consume → analyze → act loop. One row = one capability a user would recognize by name.
> **What does not count as a feature:** A UI copy decision, a single screen state, an edge-case exception, an analytics event, an implementation detail, or a ticket-sized change that only refines an existing capability.
> **Split test:** If removing it would not change what the product *does* for the operator, it is not a feature. If two rows only differ by screen or control, merge them.

---

## Conventions

| Field           | Guidance / Values                                             |
| --------------- | ------------------------------------------------------------- |
| **Workstream**  | Group of related features; features nest under one workstream |
| **Feature**     | Short, user-recognizable name                                 |
| **Description** | One or two sentences: what it is, stated as the user outcome  |
| **MoSCoW**      | `must` · `should` · `could` · `won't`                         |
| **Status**      | `backlog` · `build` · `ship` · `sunset`                       |

**MoSCoW**

| Value    | Meaning                                 |
| -------- | --------------------------------------- |
| `must`   | Prototype fails without it              |
| `should` | Important; cut only with a clear reason |
| `could`  | Nice if cheap; do not block launch      |
| `won't`  | Explicitly out of this prototype        |

**Status**

| Value     | Meaning                                  |
| --------- | ---------------------------------------- |
| `backlog` | Agreed as a feature; not in active build |
| `build`   | In progress for the prototype            |
| `ship`    | Live in the prototype                    |
| `sunset`  | Was in; retiring or retired              |

---

## Workstreams

| id           | workstream   | intent                                                                                                        |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------- |
| onboarding   | onboarding   | Collect role, scope, and source preferences so models are seeded with enough signal to make the dashboard useful from the first load |
| dashboard    | dashboard    | Surface the monitored landscape at a glance so the operator sees what moved and what needs attention          |
| story        | story        | Deliver per-narrative intelligence: synthesis, delta, implications, and source provenance                     |
| drafting     | drafting     | Support both reactive drafting (urgent story, writing now) and proactive drafting (developing story, options ready to act on) |
| distribution | distribution | Enable the operator to share monitoring signals and finalized content through segmented professional networks  |

---

## Features

| id                              | workstream   | feature               | description                                                                                                                                                                       | moscow   | status  |
| ------------------------------- | ------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| onboarding_profile              | onboarding   | profile               | Describe your role, institutional context, and what your role and organization care about most — so implications are framed against your actual stakes                            | `must`   | `backlog` |
| onboarding_scope                | onboarding   | monitoring scope      | Define topics, keywords, geographies, and outlets to watch — the full picture of what to monitor and where                                                                        | `must`   | `ship`  |
| onboarding_extraction           | onboarding   | profile extraction    | A model parses your natural language blurb(s) to derive structured monitoring parameters (topics, keywords, geographies, sources, role, organizational priorities) so the dashboard is seeded without manual form-filling | `must`   | `ship`  |
| onboarding_profile_management   | onboarding   | profile management    | Edit topics, keywords, geographies, and sources after initial setup as monitoring needs evolve                                                                                    | `must`   | `ship`  |
| dashboard_feed                  | dashboard    | narrative feed        | Browse meta-stories currently in the monitoring set                                                                                                                               | `must`   | `ship`  |
| dashboard_filter                | dashboard    | feed filter           | Narrow the feed by topic, keyword, geography, or source to quickly target what matters most                                                                                       | `should` | `ship`  |
| dashboard_story_clustering      | dashboard    | story clustering      | A model groups raw stories from monitored sources into coherent meta-stories that reflect how coverage is clustering around a narrative                                            | `must`   | `ship`  |
| dashboard_feed_ranking          | dashboard    | feed ranking          | A model surfaces and orders meta-stories by relevance to the user's monitoring scope, preventing information overload; implementation shipped, needs strengthening                 | `must`   | `ship`  |
| dashboard_mode_signal           | dashboard    | monitoring mode       | Show an aggregate of current story states (e.g. *3 narratives steady · 2 falling*) derived from per-story velocity signals, giving the operator a dashboard-level read at a glance; implementation shipped, needs strengthening | `should` | `ship`  |
| dashboard_refresh               | dashboard    | feed refresh          | A model pulls the latest coverage state at regular intervals, keeping the feed current                                                                                            | `must`   | `ship`  |
| dashboard_adaptive_refresh      | dashboard    | adaptive refresh      | Adjust refresh cadence in response to story velocity signals — more frequent when narratives are developing fast, less so during calm periods                                      | `should` | `backlog` |
| story_headline                  | story        | headline              | A model generates the meta-story title and one-sentence contextual placement (subtitle) from clustered story data                                                                 | `must`   | `ship`  |
| story_summary                   | story        | summary               | A model synthesizes what is being reported across sources into a narrative-level view                                                                                             | `must`   | `ship`  |
| story_what_changed              | story        | what changed          | A model determines whether this story is new to the feed, unchanged since last check, or has evolved — and surfaces what shifted when it has; implementation exists, needs strengthening | `must`   | `ship`  |
| story_why_it_matters            | story        | why it matters        | A model generates a posture signal for the operator — how to frame attention and readiness given how this narrative is currently behaving across sources; implementation exists, needs strengthening | `must`   | `ship`  |
| story_sources                   | story        | source list           | A model selects and orders up to five key stories from monitored sources within the meta-story, with source type signals to aid trust assessment                                   | `must`   | `ship`  |
| story_velocity_signal           | story        | velocity signal       | Show per-story direction (rising / steady / falling), time since last source, and source count — signals that calibrate how urgently this story needs attention                    | `should` | `ship`  |
| story_source_trust              | story        | source trust          | A model assesses outlet credibility and geographic relevance beyond basic source type — deeper triage without manual lookup                                                        | `could`  | `backlog` |
| story_outlet_framing            | story        | outlet framing        | Research what a specific outlet has already published before responding to their media request — source panel with article headline, snippet, and link to original covers this need sufficiently for now | `won't`  | `backlog` |
| drafting_compose                | drafting     | reactive compose      | A model supports drafting a reactive statement within Tempo while monitoring context (current story state, what changed, why it matters) remains visible alongside the draft — eliminating mid-draft switching to external sources | `should` | `backlog` |
| drafting_proactive_options      | drafting     | proactive options     | When a story is developing but not yet urgent, a model surfaces draft options (e.g. response variations, X post alternatives) so the user is ready to act when the moment arrives | `could`  | `backlog` |
| drafting_finalization_signal    | drafting     | finalization signal   | Removed: Tempo surfaces the information (velocity, delta, posture); the operator decides when to finalize — a dedicated signal would collapse human judgment that should remain with the user | `won't`  | `backlog` |
| distribution_contacts           | distribution | contact lists         | Manage segmented contact lists (e.g. US press, Colombia media, embassy staff) for targeted outbound                                                                               | `could`  | `backlog` |
| distribution_share              | distribution | share                 | Send information — statements, story summaries, or Tempo story links — to one or more contact lists through preferred channels (e.g. WhatsApp); Tempo links may extend reach to recipients outside the product | `could`  | `backlog` |
| distribution_conversation       | distribution | conversation          | Discuss and coordinate around Tempo content with colleagues — workshopping drafts, reacting to stories; bidirectional; speculative — revisit if upcoming interviews confirm coordination behavior | `won't`  | `backlog` |
