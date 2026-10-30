# User personas

**Update:** 11 Sep 26

> **Usage rules:**
>
> - Only personas with `status: validated` or `status: working` may inform product decisions. If `status: hypothesized`, treat as a question to test — do not present as fact.
> - Never invent personas. Missing evidence → do not state claims as facts.
> - This file is the persona source of truth. [Research context](ops/research-context.md) keeps a one-line snapshot; do not fork a second persona list in `02-product`.
> - The active [personas and pains discovery](guide--personas-and-pains-discovery.md) guide stays blank-slate in session. Do not use this document to shape live questions. After a session, add or update a row here.

---

## Personas


| id  | name                  | role     | priority | status  | confidence | last evidence |
| --- | --------------------- | -------- | -------- | ------- | ---------- | ------------- |
| p1  | solo comms operator   | end user | primary  | working | low        | 17 Apr 26     |
| p2  | embassy press/political operator (small team) | end user | secondary | hypothesized | low | 11 Sep 26 |


**Role:** relationship to product (e.g., administrator, buyer, end user, etc.)
**Status:** `hypothesized`  `working`  `validated`  `retired`
**Confidence:** `low`  `medium`  `high` (require cited evidence for medium/high)

`working` (p1): two sessions, one participant. Strong enough to keep the current prototype aimed here; not strong enough to treat this as a market.

`hypothesized` (p2): one session (Vanessa Aguirre). Adjacent embassy bilateral information work with a small press cell — **not** product scope until status moves and the [evidence → action trigger table](guide--personas-and-pains-discovery.md) licenses widening. Do not stretch p1 “solo” to cover her.

Open: does p2 stay distinct, or become a solo vs small-team variant of one embassy-bilateral type? Needs ≥1 more similar participant + comparison of top-3 codes.

---

## Anti-personas

Personas explicitly **not** to optimize for. Secondary personas still in scope (lower priority); anti-personas out of primary design focus.

These are where-not-to-play choices, not researched types. Labeled *inferred — strategy* until evidence confirms or challenges them. The discovery wave may still *interview* adjacent information professionals; that does not put them in product scope until the [evidence → action trigger table](guide--personas-and-pains-discovery.md) licenses widening.

### Casual news reader

- **Why out of scope:** Not a professional whose output informs others' opinions, policies, or actions. Different job, different success metric. — inferred — strategy
- **Implication:** No consumer news-app surface (personalized feed, “for you,” social sharing).

### Executive who only consumes finished briefs

- **Why out of scope:** Receives analysis; does not run the consume → analyze → act loop. The discovery screener would exclude. — inferred — strategy
- **Implication:** No executive-dashboard-first surface. Briefs are an output of p1's work, not the primary user.

### Reporter whose job is to publish the story

- **Why out of scope:** Adjacent information work, opposite success condition. p1's crisis job is often to answer or contain a narrative; a reporter's job is to keep it moving. — inferred — strategy
- **Implication:** Don't optimize for beat reporting, sourcing, or publishing. Interviewing journalists in discovery does not change this until evidence says the pain shape is the same *and* the trigger table licenses a wider product.

---

## p1 — Solo comms operator

**priority:** primary
**status:** working
**confidence:** low
**one_liner:** End user responsible for the full comms loop alone — consuming what moves, writing what responds, distributing what shapes — with no margin for a missed update.

### Design for

- Surface what moved in the landscape since the last check
- Support monitoring alongside drafting (laptop / split-view surface)
- Reflect story mode: calm cadence (periodic) vs fast-public (near-continuous)
- Support triage: distinguish reputable / known sources from noise without requiring manual lookup
- Support read-before-respond for inbound media: outlet-specific framing, check their published copy first
- Support outbound distribution: push a finalized statement to segmented contact lists
- Preserve human judgment — monitoring is an information input, not a writing substitute

### Do not design for

- Graphic / promotional production (explicit third in p1's 70/20/10 split)
- Auto-drafted or auto-approved public statements
- Proactive content loop (social posts, web articles, planned-event prep, publication scheduling) — real p1 work, not the reactive loop Tempo addresses
- Persona detection, geo-side inference, or a role picker
- Crisis-team routing / shared monitoring handoff (named in session 1; classified Strategic Bet — later)
- Institutional IT / legal / procurement as a product surface in this slice

### Jobs to be done

1. **When** a story is still forming, **I want** clear mode signals **so that** I know when to switch from periodic to continuous monitoring. — [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md) JTBD 3
2. **When** a sensitive story starts moving across outlets, **I want** to monitor shifts while drafting **so that** my response covers likely escalation points. — [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md) JTBD 1
3. **When** I'm ready to finalize a reactive statement, **I want** confidence that I haven't missed a new angle **so that** the response closes the story rather than keeps it alive. — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9): *"My whole purpose is to kill that story"*; *"It cannot be a halfway cooked message"*
4. **When** journalists request comments across channels, **I want** to tailor responses to each outlet's published framing **so that** my statement fits what they've already published. — [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md) JTBD 2

### Top pains (max 5, only primary listed)

1. Interruptive self-checking while drafting: constant self-initiated switching between Word and browser / Twitter / Google to avoid missing an update — with zero tolerance for gaps (a missed angle keeps the story alive). — observation — [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md) Theme 1; [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9): *"I am interrupting myself"*; *"My whole purpose is to kill that story"*
2. Source triage cost: manually assessing each mention for trust and relevance — especially unfamiliar geographies where she cannot quickly rule out small outlets. — observation — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9): *"I rather spend more time ruling out things in the US"*
3. Multi-channel inbound media: urgent, deadline-compressed, outlet-specific; must read each outlet's published copy before responding; ranked second (20 of 70/20/10). — observation — [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md) Theme 3; [Granola — session 1](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51): *"I will never respond… not knowing what they have already published"*

Graphic / promotional production is a real p1 task (10 of 70/20/10) and is listed under **Do not design for**, not here.

### Current alternatives

- Twitter / X keyword search — fast landscape scan; constant self-initiation — observation — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)
- Google (latest 24h / 1h time filter) — completeness pass; same interruptive loop — observation — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)
- Microsoft Word + browser split screen — drafting alongside monitoring; the de facto workflow — inferred — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)
- WhatsApp / phone calls — inbound media intake (~60–70% of contact volume) — observation — [Granola — session 1](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51)
- WhatsApp distribution lists (segmented: US/DC contacts, Colombian media) — outbound statement push after drafting — observation — [Granola — session 1](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51)
- Direct journalist calls — real-time information gathering during active drafting episodes — observation — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)
- Colleagues monitoring in crisis so one person can write — observation; hypothesized as non-default day-to-day — [Granola — session 1](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51)
- No dedicated monitoring tool, social listening platform, or aggregator — all manual — observation — [Granola — session 1](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51) + [session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)

### Success looks like

- Trust the sourced, clustered view enough to stop switching to Google / X — reducing self-interruption without increasing missed updates — inferred — [Granola — session 1](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51) + [session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)
- Know which mode applies (calm periodic vs fast-public near-continuous) and act on it without guessing — observation — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)
- Complete a reactive statement within ~1 hour of story break, covering all live angles — observation — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9): *“we have an hour at most”*
- Finalize and push without fear that a gap will reopen the story — observation — [Granola — session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9): *“My whole purpose is to kill that story”*

### Evidence

- 2 generative interviews, 1 participant (P1), 16–17 Apr 26. Confidence 🟠 Low — not replicated.
- Informal observation (Apr–Sep 26, date unconfirmed, same participant): embassy WhatsApp channel used by staff to share media articles on mobile — suggests mobile is already in the information-sharing loop. Not a formal session; not citable for product decisions without a follow-up.
- [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md)
- [Session log](ops/session-log.md)
- [Quote library](ops/quote-library.md)
- Granola [session 1 — intro](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51), [session 2 — monitoring](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9)

Open: does “solo comms operator” describe a real segment beyond this one participant, or is it specific to this institutional context? Wave 2 added an adjacent **non-solo** embassy operator (p2 hypothesized) — load-as-#1 recurs, but mechanism and team shape diverge. All other open questions tracked in [research context](ops/research-context.md).

---

## p2 — Embassy press/political operator (small team)

**priority:** secondary
**status:** hypothesized
**confidence:** low
**one_liner:** Small press cell inside embassy political work — spends the morning finding and interpreting bilateral coverage, then briefs the capital; congressional and social sit alongside.

### Design for

*Hypothesized only — do not aim the live pilot here yet.*

- Surface new mentions of the home country / LatAm-interest topics with sentiment (pos/neu/neg)
- Show which outlets are repeating a story; weight wire agencies (AP/Reuters) vs single-outlet analysis
- Support narrative-axis summary (what is dominating the US conversation)
- Respect institutional AI constraints (no sensitive/reserved uploads)
- Desktop-morning briefing workflow (hours of consume→analyze before other duties)

### Do not design for

- Treating this as validated product scope
- Collapsing into p1 “solo” without more evidence
- Auto-sending briefs to the capital without human review
- Assuming Meltwater-class tools are already available at post

### Jobs to be done

1. **When** I must process a large volume of coverage each morning, **I want** auto identification + sentiment + outlet breakdown **so that** I spend time on judgment and stakeholder work instead of finding/reading everything. — [Synthesis](synthesis--personas-and-pains-discovery.md) JTBD 4; [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:41:26–00:42:10
2. **When** a high-profile visit/story is unfolding, **I want** coverage to stay current despite late articles **so that** the Lima impact brief is not already stale. — [Synthesis](synthesis--personas-and-pains-discovery.md) JTBD 5

### Top pains (max 5, only primary listed)

1. Volume / time-to-process: ~3–4 hours (sometimes more) of morning consume→analyze; even AI summaries need re-read. — observation — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:33:54–00:34:42, ~00:44:15–00:44:42
2. Discovery/search friction: X search weak; manual find; no embassy monitoring platform (Lima has one). — observation — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:24:25–00:25:25, ~00:05:05–00:06:01
3. *(Incomplete third — participant collapsed further pains into #1.)* — observation — same pain block

### Current alternatives

- X (immediacy) + Google (deepen) — observation — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:19:06–00:21:27
- Subscriptions (NYT, WaPo, regional papers) + YouTube for hearings — observation — warm-up / tools block
- Politico Pro (event calendar) — observation — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:23:27–00:24:21
- ChatGPT / Claude via copy-paste; conversation-only “training”; no sensitive folders — observation — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:04:29–00:05:05, ~00:38:59–00:39:38
- Interns: article collection + social/graphics for non-sensitive tasks — observation — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:46:57–00:48:09
- No dedicated monitoring platform at post — observation — same

### Success looks like

- Alerts when Peru is mentioned, with sentiment + repeating outlets, without losing morning to manual scan — observation / ask — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:41:26–00:42:40
- Reclaimed morning time for press relationships and congressional work — observation — [Whisper —02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md) ~00:44:42–00:45:06

### Evidence

- 1 generative interview, 1 participant, 11 Sep 26. Confidence 🟠 Low — hypothesized only.
- [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md)
- [Session log](ops/session-log.md) — Session 3
- [Quote library](ops/quote-library.md)
- Granola [notes](https://notes.granola.ai/d/d64e5925-392f-439c-af5d-5a91e287dabe); local [—01](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--01.md) · [—02](interviews/interview--personas-and-pains-discovery--vanessa-aguirre--260911--02.md)

---

## Changelog


| date      | change                                                                                                                                 | source |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 11 Sep 26 | Added p2 hypothesized from Vanessa Aguirre session; noted p1 open question updated (adjacent non-solo embassy operator). No product-scope change. | [Granola — Vanessa](https://notes.granola.ai/d/d64e5925-392f-439c-af5d-5a91e287dabe) · [Synthesis](synthesis--personas-and-pains-discovery.md) |
| 06 Sep 26 | Section-by-section review against raw Granola transcripts: renamed p1 “solo comms operator”; updated one_liner, Design for, Do not design for (removed mobile exclusion, added proactive content loop), Jobs to be done (reordered + added finalization JTBD), Top pains (removed mobile pain, added source triage, folded completeness into pain 1), Current alternatives (split WhatsApp inbound/outbound, added journalist calls, added no-dedicated-tool row), Success looks like (consolidated overlap, added 1-hour window), Evidence (added informal WhatsApp observation, tightened open questions). | [Granola — session 1](https://notes.granola.ai/d/bc3d8060-773b-4e87-98e6-b72076ceaa51) + [session 2](https://notes.granola.ai/d/6db72093-4248-402c-a237-be05c54e07d9) |
| 06 Sep 26 | Created from the Passplate personas format. p1 set to `working` / low from wave 1. No hypothesized p2+. | [Synthesis — personas and pains](synthesis--personas-and-pains-discovery.md) |
