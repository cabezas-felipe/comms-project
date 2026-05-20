# Why this matters — strategy spec

**Status:** In progress (planning program)  
**Owner:** Felipe  
**Last updated:** 20 May 26  

**Phases:** §0a–0c Anchor — locked · §1 Taxonomy/voice — locked · §2 State machine — locked · §3 Doctrine/grounding — locked · §4 Rubric/goldens — locked · §5 Eval/trust — locked · §6 Engineer spec — locked · §7 Prompt pack — pending  

**Eval set (v0, collaborative draft):** [why-this-matters-eval-set-v0.json](why-this-matters-eval-set-v0.json)

Product-facing source of truth for `story.whyItMatters`. Built section-by-section before implementation. Engineer handoff: [why-this-matters-spec.md](../05-engineering/docs/why-this-matters-spec.md) (Phase 6, locked).

**Related artifacts:**

- [Comms project v0 | MVP](comms-project-v0--mvp.md)
- [What changed — engineer spec (v1)](../05-engineering/docs/what-changed-spec.md)
- [Interview synthesis — Mercedes Osma](../01-research/interview-synthesis--zero-to-one--mercedes-osma.md)
- [Prototype story fixtures](../04-prototype/src/data/stories.ts)

---

## 0a. Purpose (locked 19 May 26)

### Value proposition

**Why this matters** tells the comms professional **how this meta-story — and how it is playing across its sources — may affect their monitoring posture and comms readiness**, combining **strategic context** (what kind of narrative this is becoming) with **near-term watchpoints** (what to track more closely as coverage evolves), **without** restating the full story or duplicating what changed in the evidence.

### Alignment with professional comms intelligence

Stakeholder input (embassy comms / PR lead, US–Colombia context) describes useful briefs as: a **complete picture of what is happening**, plus **potential implications** for the role — at greater length in consultant reports (e.g. election intelligence, geopolitical memos), with a similar **analysis logic** at dashboard scale on Tempo.

Tempo splits that logic across fields:

| Brief ingredient | Tempo field |
|------------------|-------------|
| Complete picture of what is happening | **Summary** + **sources** (provenance) |
| What moved since the user last looked | **What changed** |
| Implications for the comms role | **Why this matters** |

### Definitions (planning vocabulary)

| Term | Meaning for this product |
|------|---------------------------|
| **Monitoring posture** | How closely and in what mode the comms professional should treat this narrative right now (attention level, not a task list). |
| **Comms readiness** | How prepared they need to be to respond or coordinate (drafting-window pressure, stakeholder exposure, coordination risk) — implications, not approved messaging. |
| **Reproductions** | The same event **framed differently by different outlets** (angle spread across sources), not syndication volume alone. |
| **Developments** | How the narrative evolves over time; primarily carried by **What changed** on repeat views; shapes the **watchpoints** side of Why this matters when the story is evolving. |

### Primary user (MVP)

Every user is treated as a **comms / public-affairs professional** (e.g. solo bilateral lead, embassy comms). No persona detection, geo-side inference, or role picker in this slice.

### What this field is not (MVP)

- Not the full “picture” of the story (that is **Summary** + sources).
- Not the evidence changelog (**What changed**).
- Not prescriptive instructions (“issue a statement,” “approve message X”).
- Not side-taking for US vs Colombia audiences (neutral bilateral framing is a constraint in §0c).

---

## 0b. Field boundaries

### Field roles (MVP)

| Field | Contains | Does not contain |
|------|----------|------------------|
| **Title** | Meta-story headline (what narrative this cluster is). | Implications, delta framing, recommendations. |
| **Subtitle** | One-sentence contextual placement of the story right now (deck line). | Full narrative synthesis, implications, action guidance. |
| **Summary** | Narrative synthesis across sources (what happened / what is being reported across outlets). | User-relative delta framing, comms-readiness implications. |
| **What changed** | User-relative delta since last view (new/shifted/unchanged narrative signals). | Full recap of the story, broad implication analysis not tied to observed delta. |
| **Why this matters** | Implications for monitoring posture and comms readiness given current narrative shape (strategic context + near-term watchpoints). | Raw recap, duplicate delta line, prescriptive instructions, side-taking framing. |

### Boundary test (anti-duplication)

- If a sentence could move to **Summary** with no loss, it does **not** belong in **Why this matters**.
- If a sentence could move to **What changed** with no loss, it does **not** belong in **Why this matters**.

---

## 0c. MVP constraints

### Scope and audience

- Every user is treated as a comms / public-affairs professional (no persona or side inference in this slice).
- Neutral bilateral framing (no US-vs-Colombia side-taking language).

### Tone and behavior

- Analytical, concise, non-prescriptive.
- No direct tasking language (avoid “do X now” instructions).
- Fail closed when evidence is weak: prefer conservative low-assertion wording over strong inference.

### Length and structure (card coherence)

- **Subtitle:** 1 sentence (short contextual deck line).
- **Summary:** 1–3 sentences, max ~420 characters (or ~70 words).
- **What changed:** 1–2 sentences, max ~300 characters.
- **Why this matters:** 1–2 sentences, max ~300 characters.

### Anti-duplication and evidence discipline

- Why this matters must not restate Summary or What changed verbatim.
- Summary should describe the narrative across sources; What changed should describe user-relative delta; Why this matters should describe monitoring posture/comms-readiness implications.
- Implication claims must be grounded in current narrative evidence shape (summary + source pattern), not speculative assertions.

---

## 1. Implication taxonomy and voice rules (MVP)

### 1a) Taxonomy (locked for MVP)

1. **Monitoring intensity** — how closely this narrative likely needs to be watched in the near term.
2. **Narrative stability** — whether framing appears stable vs drifting/fragmenting across sources.
3. **Stakeholder exposure** — likelihood this narrative creates inbound pressure/questions from stakeholders or media.
4. **Coordination pressure** — likely need for tighter internal alignment across comms/policy/legal teams.
5. **Readiness urgency** — how quickly comms readiness might need to move from passive to prepared posture.
6. **Signal uncertainty** — confidence caveat when source spread/evidence is thin or ambiguous.

### 1b) Voice rules (global)

- Lead with implication, not recap.
- Use posture/readiness language, not directives.
- Anchor claims to observable coverage patterns (source spread, framing divergence, cadence shifts), not speculation.
- Keep neutral bilateral framing.
- Calibrate certainty to evidence strength (e.g., “suggests/indicates” vs “may/early signal”).
- Keep one core idea per sentence for scanability.

### 1c) Starter examples (good / bad)

| Category | Good | Bad |
|----------|------|-----|
| Monitoring intensity | “Coverage cadence is accelerating across core outlets, suggesting closer monitoring is warranted in the next cycle.” | “This story is huge — watch everything now.” |
| Narrative stability | “Framing is beginning to diverge across sources, which may reduce predictability of how the narrative lands.” | “Everyone is saying different things, so the narrative is chaos.” |
| Stakeholder exposure | “As the narrative appears in broader outlets, inbound stakeholder questions may become more likely.” | “You will definitely get media calls today.” |
| Coordination pressure | “The shift from policy detail to political framing suggests tighter cross-team alignment may be needed.” | “Legal, policy, and comms must meet immediately.” |
| Readiness urgency | “Signals point to increasing readiness pressure, even if a full response cycle is not yet evident.” | “Respond now before it’s too late.” |
| Signal uncertainty | “Current signals are early and concentrated in a narrow source set, so implication confidence remains limited.” | “We don’t really know anything.” |

---

## 2. State machine (MVP)

### 2a) States

1. **Intro** — first meaningful appearance of this meta-story for the user.
2. **Steady** — story persists without material change since last check.
3. **Evolving** — story persists with material change since last check.

### 2b) Transition logic

- `whatChanged = firstSeen` → **Intro**
- `whatChanged = unchanged` → **Steady**
- `whatChanged = changed` → **Evolving**

If `whatChanged` is unavailable or fails closed:

- story not in ever-seen set → **Intro**
- story in ever-seen set → **Steady** (conservative default)

### 2c) Writing intent by state

- **Intro:** establish baseline implication (why this narrative category matters for monitoring/readiness).
- **Steady:** reinforce ongoing relevance without implying fresh escalation.
- **Evolving:** highlight implication shift caused by detected narrative movement (posture/readiness adjustment, non-prescriptive).

### 2d) Guardrails

- State controls emphasis, not factual claims.
- Why this matters must not contradict What changed:
  - **Steady** cannot imply major fresh movement.
  - **Evolving** must reflect meaningful movement.
- Signal uncertainty can soften wording in any state when evidence is thin.

---

## 3. Doctrine corpus and grounding policy (MVP)

### 3a) Doctrine source scope (locked — internal-first)

**Governance:** allowlist-only. A source is usable only when explicitly listed with an ID and rationale.

**Include now**

1. **Internal validated research artifacts**
   - [Interview synthesis — Mercedes Osma](../01-research/interview-synthesis--zero-to-one--mercedes-osma.md)
   - future interview syntheses once promoted to the same evidence tier

2. **Internal feature canon**
   - this strategy spec (`why-this-matters--strategy-spec.md`)
   - future why-this-matters prompt pack / writer spec docs explicitly marked canonical

**Optional (MVP)**

- Up to **2 pre-vetted external doctrine sources**, only if already curated with ID + provenance note before use.

**Defer (post-MVP)**

- Broad external doctrine expansion or open-ended ingestion pipelines.

**Exclude**

- Uncurated web search results
- Social posts / opinion threads
- Any source without explicit provenance metadata
- Model-generated summaries treated as doctrine
- Internal notes not promoted to canonical evidence/docs

### 3b) Usage contract (locked)

**Doctrine frames. Evidence grounds.**

| Layer | May do | Must not do |
|--------|--------|-------------|
| **Story evidence** (summary, source pattern, what-changed state) | Ground what happened, what shifted, how coverage is behaving | Invent implications unsupported by current cluster evidence |
| **Doctrine** (internal research + feature canon) | Shape how implications are expressed (posture language, category emphasis, tone, uncertainty calibration) | Assert current-event facts unless those facts are present in story evidence |
| **Why this matters output** | Combine evidence-grounded observation + doctrine-guided framing | Restate Summary or What changed; prescribe actions; take sides |

**Rules**

1. Fact claims must trace to current meta-story evidence (summary + sources + delta state).
2. Implication claims must map to one taxonomy category and the current state (`intro` / `steady` / `evolving`).
3. Doctrine snippets inform wording and emphasis only; they are not user-visible citations (“because [source] said…”).
4. If evidence and doctrine conflict, **evidence wins**.
5. If evidence is thin, use **Signal uncertainty** framing with softened language.

**Writer test:** “Could this implication still hold if all doctrine inputs were removed but story evidence stayed the same?” If yes, doctrine is framing correctly. If the fact depends on doctrine, reject.

### 3c) Traceability schema (locked)

Every generated `whyItMatters` carries a machine-readable trace (stored server-side; not shown in UI for MVP).

**Required fields**

| Field | Values | Purpose |
|--------|--------|---------|
| `metaStoryId` | string | Tie trace to cluster |
| `state` | `intro` \| `steady` \| `evolving` | Phase 2 output mode |
| `whatChangedState` | `firstSeen` \| `unchanged` \| `changed` | Coupling to delta engine |
| `taxonomyPrimary` | one of six MVP categories | Main implication lens |
| `confidence` | `high` \| `medium` \| `low` | Grounding strength |
| `evidenceRefs` | object (feature flags below) | Evidence features used |
| `doctrineRefs` | string[] (may be empty) | Doctrine snippets that influenced framing |

**`evidenceRefs` (MVP minimum)**

```json
{
  "summaryChars": 312,
  "sourceCount": 4,
  "uniqueOutletCount": 3,
  "framingDivergence": "low",
  "cadenceSignal": "stable"
}
```

(`framingDivergence` and `cadenceSignal` use enum values: `low|medium|high` and `stable|accelerating|decelerating` respectively.)

**Optional fields:** `taxonomySecondary`, `writerVersion`, `promptVersion`, `generatedAt`.

**Trace rules**

1. Trace is written at generation time.
2. Empty `doctrineRefs` is valid.
3. When `confidence = low`, `taxonomyPrimary` should usually be `signal_uncertainty` (alone or with one secondary category).
4. Trace must support eval/debug (“why did we say this?”) without exposing internal metadata to end users in MVP.

### 3d) Failure behavior (locked)

| Condition | Behavior |
|-----------|----------|
| **Doctrine retrieval fails** | Do not block publish. Generate from evidence + state + taxonomy + voice rules. Set `doctrineRefs: []`. |
| **Evidence thin/weak** | Do not block publish. Force `confidence: low`, primary taxonomy `signal_uncertainty`, softened wording (“may”, “early signal”, “limited confidence”). No strong implication verbs. |
| **whatChanged unavailable** | Apply Phase 2 fallback: not ever-seen → `intro`; ever-seen → `steady`. Keep copy conservative. |
| **Writer validation fails** (length, duplication, directive tone, side-taking) | Fail closed on implication text only: replace with safe state-aware fallback; trace as low-confidence `signal_uncertainty`. Do not drop story from dashboard. |
| **Hard block only if** | Required story fields unusable, or output still violates hard safety after retry (prescriptive directive, side-taking, factual hallucination). |

**Safe fallback templates (last resort)**

- **Intro:** “This narrative is newly entering your monitoring set; treat initial signals as baseline context before stronger implications.”
- **Steady:** “No material shift detected since your last check; maintain standard monitoring posture for now.”
- **Evolving:** “Recent movement suggests monitoring posture may need adjustment, though confidence remains limited by current evidence spread.”

---

## 4. Writer rubric and golden examples (MVP)

### 4a) Core writer rubric (locked)

An output **passes** only if all checks pass:

| # | Check | Pass | Fail |
|---|--------|------|------|
| 1 | Role fit | Monitoring posture / comms readiness implication | Recap, task list, or opinion |
| 2 | Non-duplication | Does not repeat Summary or What changed verbatim | Restates narrative or delta |
| 3 | Non-prescriptive | No “do X now” / “must respond” language | Directive instructions |
| 4 | Neutral framing | No US-vs-Colombia side-taking | Favors one national narrative frame |
| 5 | Evidence discipline | Calibrated certainty when evidence is thin | Overconfident claims |
| 6 | Length | 1–2 sentences, ≤ ~300 chars | Too long or multi-topic |
| 7 | Taxonomy fit | One clear primary taxonomy category | Unclear or unsupported category mix |
| 8 | State coherence | Matches intro/steady/evolving intent | Contradicts what-changed state |

**Auto-fail phrases (MVP):** “respond now”, “issue a statement”, “must meet immediately”, “definitely will”, “chaos”, “huge story”.

Production copy may run slightly longer than the shortest goldens, but must remain within §0c length limits.

### 4b) State-specific emphasis (locked)

- **Intro:** baseline relevance; no escalation alarm.
- **Steady:** ongoing relevance without implying fresh movement.
- **Evolving:** implication shift tied to detected movement, without re-reporting the movement.

State changes emphasis, not facts.

### 4c) Golden examples — good (locked, tone-aligned)

Tone matches operational comms voice in app fixtures (direct, concise, non-bureaucratic). Goldens are quality anchors, not max-length targets.

| State | Category | Example |
|-------|----------|---------|
| Intro | Monitoring intensity | “New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.” |
| Intro | Stakeholder exposure | “New narrative — expect early inbound interest before direction is clear.” |
| Steady | Narrative stability | “No material shift since last check; framing still looks consistent across sources.” |
| Steady | Readiness urgency | “Still in view, still relevant — stay prepared even without fresh movement.” |
| Evolving | Coordination pressure | “Coverage is shifting toward political framing — internal alignment pressure may rise.” |
| Evolving | Monitoring intensity | “Movement picked up again — watch this closer over the next cycle.” |

### 4d) Anti-patterns and rejection rules (locked)

**Bad examples (auto-fail)**

| Anti-pattern | Bad example | Why fail |
|--------------|-------------|----------|
| Recap | “Two outlets reported new legal-context framing this morning.” | Summary/What changed territory |
| Directive | “Issue a statement now before narrative hardens.” | Prescriptive |
| Overconfidence | “You will definitely get media calls today.” | Unsupported certainty |
| Side-taking | “US outlets are framing this correctly; Colombian coverage is misleading.” | Side-taking |
| Hype | “Narrative is chaotic and out of control.” | Not comms intelligence |
| State mismatch | “Nothing to monitor here.” (in steady context) | Contradicts steady intent |

**Rejection rules**

- Hard reject on any failed 4a/4b check, auto-fail phrase, or clear duplication.
- If `confidence = low`, reject strong certainty language.
- One rewrite attempt with rubric constraints; if still failing, use Phase 3d safe fallback and mark trace as low-confidence `signal_uncertainty`.

---

## 5. Evaluation scorecard and trust policy (MVP)

### 5a) Scoring dimensions (locked)

Score each output on **8 required dimensions** (aligned to Phase 4a), plus **2 meta checks**:

| Dimension ID | Pass criteria |
|--------------|---------------|
| `role_fit` | Posture/readiness implication present |
| `non_duplication` | No verbatim/near-verbatim repeat of Summary/What changed |
| `non_prescriptive` | No directive language |
| `neutral_framing` | No side-taking framing |
| `evidence_discipline` | Language strength matches `confidence` |
| `length` | 1–2 sentences, ≤300 chars |
| `taxonomy_fit` | Valid `taxonomyPrimary`, plausible for trace |
| `state_coherence` | Matches `state` + `whatChangedState` |

| Meta ID | Pass criteria |
|---------|---------------|
| `trace_complete` | Required trace fields present and valid |
| `fallback_used` | `true` only when safe-fallback path is expected/allowed |

**Hard-fail overrides:** directive tone, side-taking, recap-as-main, state contradiction, strong certainty with `confidence=low`.

Per-item outputs: `dimensionScores`, `hardFail`, `pass`, `failReasons[]`.

### 5b) Minimum quality bar to ship (locked)

**Per-output:** `pass=true`, `hardFail=false`, and no unexpected fallback.

**Regression run targets (18-case set):**

| Metric | MVP target |
|--------|------------|
| Pass rate overall | ≥ 90% |
| Hard-fail rate | ≤ 2% |
| Fallback rate | ≤ 10% |
| Duplication failures | ≤ 5% |
| State mismatch failures | ≤ 5% |

**Release blockers:** any Group A failure; pass rate below target on two consecutive runs; new auto-fail phrase regressions.

`confidence=low` outputs may ship with softened copy but are tracked separately.

### 5c) Regression set structure (locked)

Fixed **18-case** set in [why-this-matters-eval-set-v0.json](why-this-matters-eval-set-v0.json):

| Group | Count | Purpose |
|-------|-------|---------|
| **A** Core goldens | 6 | Must-pass every run (Phase 4c anchors) |
| **B** State edge cases | 4 | Intro/steady/evolving under thin or mixed evidence |
| **C** Failure-mode probes | 4 | Duplication, directive, side-taking, state mismatch |
| **D** Ops/failure paths | 4 | Doctrine missing, delta unavailable, writer fail, low-confidence evolving |

**Policy:** any Group A failure blocks release.

### 5d) Metrics to track (locked)

**Per-run:** passRateOverall, passRateGroupA–D, hardFailRate, fallbackRate, lowConfidenceRate, duplicationRate, stateMismatchRate, directiveToneRate, sideTakingRate, avgCharCount.

**Per-release:** deltas vs previous run, new failure types, taxonomy/state distribution drift.

**Alerts:** blocker on Group A <100% or hard-fail >2%; warn on pass <90%, fallback >10%, duplication >5%.
