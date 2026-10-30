// Frozen eval set for the relevance & precision strategy (Phase 0).
//
// Twelve locked cases that gate any tuning of the cross-cutting relevance
// rules (Points 1–7 in [docs/relevance-precision-strategy.md]). The shape is
// intentionally minimal so this module can be consumed by deterministic node
// --test runs without pulling in the refresh pipeline's network/db plumbing.
//
// Per-case fields:
//   id                — stable kebab-case slug, also the test name.
//   notes             — short description of what this case isolates.
//   story             — RSS-shape story passed to scoreBeatFit / pipeline.
//   settings          — user settings the scorer reads (topics, keywords,
//                       geographies, narrative, source allow-list).
//   semanticIntentScore — optional injected semantic score (null = unset).
//   targetExpected    — locked end-state outcome after Points 1–7 land
//                       (in_dashboard, excluded, rescued, rescueReason).
//   currentBaseline   — outcome current code produces today; the eval test
//                       asserts this so the suite is green pre-implementation.
//                       When currentBaseline ≠ targetExpected the test reports
//                       the gap (informational) instead of failing.
//
// Editing rules:
//   - Headline/body text is canonical from the locked spec. Do not edit
//     wording without updating the strategy doc and DECISIONS entry.
//   - currentBaseline must be re-derived (not guessed) when scorer behavior
//     changes — the eval test will fail loudly if it drifts.

// Shared user profile for WaPo-style cases 1–3. Mirrors the State-Department
// monitoring beat used to surface the original failed-test pair.
const STATE_DEPT_SETTINGS = Object.freeze({
  topics: ["Diplomatic relations"],
  keywords: ["sanctions", "diplomacy"],
  geographies: ["Nigeria", "China", "US", "Iran"],
  traditionalSources: ["The Washington Post"],
  socialSources: [],
  onboardingNarrative:
    "Monitor U.S. foreign policy — terrorism in West Africa, " +
    "China relations, Iran/Gulf energy.",
});

const NEUTRAL_SOURCES = Object.freeze({
  traditionalSources: ["Test Outlet"],
  socialSources: [],
});

// Helpers — keep tests honest by always going through the same item shape.
function makeStory(overrides = {}) {
  return Object.freeze({
    sourceId: overrides.sourceId ?? "src-eval",
    outlet: overrides.outlet ?? "The Washington Post — World",
    kind: overrides.kind ?? "traditional",
    weight: overrides.weight ?? 90,
    url: overrides.url ?? "https://example.com/eval",
    minutesAgo: overrides.minutesAgo ?? 30,
    headline: overrides.headline ?? "",
    body: Array.isArray(overrides.body) ? overrides.body : [overrides.body ?? ""],
    subtitle: overrides.subtitle ?? "",
    topic: overrides.topic ?? "",
    geographies: overrides.geographies ?? [],
    title: "",
    takeaway: "",
    summary: "",
    whyItMatters: "",
    whatChanged: "",
  });
}

// 12 locked cases, in spec order.
export const RELEVANCE_PRECISION_CASES = Object.freeze([
  // 1 — Nigeria ISIS attack. After P7 removes actor signal, deterministic
  //     score falls into the rescue band; rescue_semantic_geo (P6) covers it
  //     because configured geo Nigeria matches in text and semantic ≥ 0.60.
  {
    id: "wapo_nigeria_isis",
    notes:
      "Semantic-geo rescue target. Geo Nigeria matches; topic/keyword do not. " +
      "Today passes via actor signal (current); after P7 actor drops out and " +
      "rescue_semantic_geo carries it.",
    story: makeStory({
      sourceId: "wapo-nigeria",
      headline: "ISIS militants attack village in northeast Nigeria, dozens killed",
      body: [
        "Security officials said militants link to ISIS attacked a village in " +
          "Borno state overnight, killing dozens and displacing residents.",
        "The assault has raised concerns among regional partners and U.S. " +
          "diplomats monitoring terrorism threats and cross-border instability " +
          "in West Africa.",
      ],
    }),
    settings: STATE_DEPT_SETTINGS,
    semanticIntentScore: 0.65,
    targetExpected: {
      in_dashboard: true,
      excluded: false,
      rescued: true,
      rescueReason: "rescue_semantic_geo",
    },
    currentBaseline: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
    },
  },

  // 2 — China summit. Same shape as case 1: lexical topic/keyword absent,
  //     semantic high, configured geo (China, US) matches in text.
  {
    id: "wapo_china_summit",
    notes:
      "Semantic-geo rescue target. Geo China + US match in text; configured " +
      "keywords (sanctions, diplomacy) do not match verbatim. Currently passes " +
      "via actor + geo + recency.",
    story: makeStory({
      sourceId: "wapo-china",
      headline:
        "U.S. and China officials hold high-stakes summit as trade and " +
        "security tensions persist",
      body: [
        "Senior U.S. and Chinese officials met for a multi-hour summit focused " +
          "on trade restrictions, military communication channels, and regional " +
          "stability.",
        "Diplomats said the talks aimed to prevent escalation while preserving " +
          "room for cooperation on priority bilateral issues.",
      ],
    }),
    settings: STATE_DEPT_SETTINGS,
    semanticIntentScore: 0.65,
    targetExpected: {
      in_dashboard: true,
      excluded: false,
      rescued: true,
      rescueReason: "rescue_semantic_geo",
    },
    currentBaseline: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
    },
  },

  // 3 — Iran/Gulf oil. Lexical anchor: configured keyword (sanctions) matches
  //     in body; deterministic alone clears threshold. Must still pass when
  //     semantic stage degrades.
  {
    id: "wapo_iran_oil",
    notes:
      "Lexical safety anchor. Sanctions + geo (Iran) lift deterministic past " +
      "0.40 without rescue; must still pass when semantic is unavailable.",
    story: makeStory({
      sourceId: "wapo-iran",
      headline: "Gulf nations hoped to move beyond oil. The Iran war made that much harder.",
      body: [
        "Sanctions and military strikes have rerouted petroleum trade across " +
          "the Gulf, with U.S. allies recalibrating long-term energy posture " +
          "and export strategy.",
        "Analysts say the conflict is reversing plans to reduce dependence on " +
          "oil-linked revenues.",
      ],
    }),
    settings: STATE_DEPT_SETTINGS,
    semanticIntentScore: null,
    targetExpected: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
    },
    currentBaseline: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
    },
  },

  // 4 — Topic-in-text with empty item.topic. Point 1: configured "War" topic
  //     should match because "war" appears in body, even though item.topic="".
  //     Today this fails because lexical recall keys off item.topic.
  {
    id: "topic_in_text_item_topic_empty",
    notes:
      "Isolates the item.topic → text fix (P1). keywords=[] so only the topic " +
      "gate runs. Today excluded at recall; target passes lexical stage.",
    story: makeStory({
      sourceId: "topic-in-text",
      headline: "War tensions rise after overnight strikes near border",
      body: [
        "Diplomatic envoys said the latest exchanges could broaden the " +
          "conflict unless talks resume quickly.",
      ],
      topic: "",
    }),
    settings: Object.freeze({
      topics: ["War"],
      keywords: [],
      geographies: [],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "",
    }),
    semanticIntentScore: null,
    // P1 (D-054 / D-056) flips this case fully — lexical recall passes because
    // the topic phrase appears in text, beat-fit's topic component fires, and
    // the single-signal item is excluded only by the 0.40 threshold (not by
    // the recall gate). On this branch P1 is not yet applied, so observed
    // recall still keys off `item.topic` and the item drops. When the P1 PR
    // lands the `currentBaseline.passesLexicalRecall` flips to `true`.
    targetExpected: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      passesLexicalRecall: true,
    },
    currentBaseline: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      passesLexicalRecall: false,
    },
  },

  // 5 — Topic absent from text AND from keywords. Pure lexical negative;
  //     stays excluded both today and after P1.
  {
    id: "topic_not_in_text_no_keyword",
    notes:
      "Pure lexical negative. No keyword, topic absent from text; semantic " +
      "is not invoked. Stays excluded both today and at target state.",
    story: makeStory({
      sourceId: "topic-not-in-text",
      headline: "Celebrity couple announces surprise engagement in Los Angeles",
      body: [
        "Fans reacted on social media after the announcement during a weekend event.",
      ],
      topic: "",
    }),
    settings: Object.freeze({
      topics: ["War"],
      keywords: [],
      geographies: [],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "",
    }),
    semanticIntentScore: null,
    targetExpected: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      passesLexicalRecall: false,
    },
    currentBaseline: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      passesLexicalRecall: false,
    },
  },

  // 6 — Topic-keyword symmetry. Topic "sanctions policy" appears verbatim in
  //     body; after Point 4 a topic configured here behaves the same as a
  //     keyword configured with the same phrase, in recall, beat-fit, and
  //     tag evidence. Today asymmetric because recall reads item.topic.
  {
    id: "topic_keyword_symmetry_tags",
    notes:
      "Point 4 symmetry test. Same phrase as topic vs keyword should produce " +
      "the same recall/beat-fit/tag behavior. No dependency on item.topic.",
    story: makeStory({
      sourceId: "topic-keyword-symmetry",
      headline: "State Department pushes new diplomatic initiative after regional escalation",
      body: [
        "Officials said the initiative aims to stabilize bilateral talks and " +
          "coordinate sanctions policy with allies.",
      ],
      topic: "",
    }),
    settings: Object.freeze({
      topics: ["sanctions policy"],
      keywords: [],
      geographies: [],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "",
    }),
    semanticIntentScore: null,
    // P1 (D-054 / D-057) flips this case to symmetric — topic and keyword
    // paths both use the same shared matcher against item text. On this
    // branch P1 isn't applied, so recall remains asymmetric: an
    // `item.topic === ""` candidate drops at the topic gate but a same-
    // phrase keyword would have admitted it. When P1 lands, both
    // `passesLexicalRecall` and `symmetricWithKeyword` flip to `true`.
    targetExpected: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      passesLexicalRecall: true,
      symmetricWithKeyword: true,
    },
    currentBaseline: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      passesLexicalRecall: false,
      symmetricWithKeyword: false,
    },
  },

  // 7a — "Africa" as a configured geography string. After Point 7 the
  //      off-beat penalty list is gone; Africa-monitor users are not punished.
  //      Item carries an explicit geographies tag so the geo gate fires.
  //      Assumption: scoreBeatFit accepts any string in settings.geographies
  //      (no enum gate at this layer); the canonical contracts enum is
  //      currently ["US", "Colombia"] — see relevance-precision-strategy.md.
  {
    id: "africa_configured_no_offbeat_penalty__africa_string",
    notes:
      "7a: configured ['Africa']. Locked: no off-beat-geo penalty (P7), " +
      "included via geo + keyword. Item carries explicit geo tag to bypass " +
      "the canonical-name text-match requirement for 'Africa'.",
    story: makeStory({
      sourceId: "africa-config-africa",
      headline: "African Union mediates ceasefire talks after cross-border clashes",
      body: [
        "Diplomats said the mediation effort could shape regional security " +
          "coordination and reduce escalation risk.",
      ],
      geographies: ["Africa"],
    }),
    settings: Object.freeze({
      topics: ["Diplomatic relations"],
      keywords: ["ceasefire"],
      geographies: ["Africa"],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "",
    }),
    semanticIntentScore: null,
    targetExpected: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
      offBeatPenaltyApplied: false,
    },
    currentBaseline: {
      // Today the off-beat penalty does NOT apply because geoHit=true via
      // explicit item.geographies → ["Africa"] ∩ configured ["Africa"].
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
      offBeatPenaltyApplied: false,
    },
  },

  // 7b — Concrete-country variant. Configured Nigeria, African framing in the
  //      body. Mirrors 7a's intent without depending on an enum-extension.
  {
    id: "africa_configured_no_offbeat_penalty__nigeria_string",
    notes:
      "7b: configured ['Nigeria'] with African framing in body. Locked: no " +
      "off-beat penalty (P7); included via geo + keyword.",
    story: makeStory({
      sourceId: "africa-config-nigeria",
      headline: "African Union mediates ceasefire talks after cross-border clashes",
      body: [
        "Diplomats from Nigeria said the mediation effort could shape regional " +
          "security coordination and reduce escalation risk.",
      ],
      geographies: ["Nigeria"],
    }),
    settings: Object.freeze({
      topics: ["Diplomatic relations"],
      keywords: ["ceasefire"],
      geographies: ["Nigeria"],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "",
    }),
    semanticIntentScore: null,
    targetExpected: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
      offBeatPenaltyApplied: false,
    },
    currentBaseline: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
      offBeatPenaltyApplied: false,
    },
  },

  // 8 — Pass without leaning on the legacy actor cue list (P7 removes it).
  //     Geo + keyword + semantic blend carry the item. Inject moderate
  //     semantic (0.62) so it crosses 0.40 via blend.
  {
    id: "no_actor_bonus_needed",
    notes:
      "P7 leaves topic + keyword + geo + recency as core signals. Actor list " +
      "is gone; this item passes without any actor_match reason code.",
    story: makeStory({
      sourceId: "no-actor",
      headline: "Regional officials coordinate sanctions response after militant financing report",
      body: [
        "Diplomatic teams from multiple countries said they will align " +
          "enforcement steps and intelligence sharing after new evidence of " +
          "cross-border financing networks.",
      ],
    }),
    settings: Object.freeze({
      topics: ["Diplomatic relations"],
      keywords: ["sanctions", "financing"],
      geographies: [],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "",
    }),
    semanticIntentScore: 0.62,
    targetExpected: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
      mustNotIncludeReasonCodePrefix: "actor_match",
    },
    currentBaseline: {
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
      mustNotIncludeReasonCodePrefix: "actor_match",
    },
  },

  // 9 — Commodity-noise. Pure agricultural framing with no configured signal;
  //     commodity penalty must keep firing post-P7. Off-beat penalty also
  //     fires today (P7 removes it) but exclusion stands either way.
  {
    id: "commodity_noise_filtered",
    notes:
      "Commodity penalty is intentionally kept by P7. Item must stay excluded " +
      "and carry a commodity_framing:* reason code.",
    story: makeStory({
      sourceId: "commodity-noise",
      headline: "Asian farmers brace for crop losses as fertilizer prices surge",
      body: [
        "Agricultural producers warned that commodity volatility and input " +
          "costs could reduce harvest output this season.",
      ],
    }),
    settings: Object.freeze({
      topics: ["Diplomatic relations"],
      keywords: ["sanctions"],
      geographies: ["US"],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "",
    }),
    semanticIntentScore: null,
    targetExpected: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      mustIncludeReasonCodePrefix: "commodity_framing",
    },
    currentBaseline: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      mustIncludeReasonCodePrefix: "commodity_framing",
    },
  },

  // 10 — Celebrity noise sentinel. No configured signal, no penalty list
  //      relevance, no rescue eligibility. Permanent precision floor.
  {
    id: "celebrity_noise",
    notes:
      "Permanent precision sentinel. Must be excluded BEFORE any rescue path " +
      "even considers it (no signal, semantic not injected).",
    story: makeStory({
      sourceId: "celebrity",
      headline: "Pop star announces world tour dates after surprise album release",
      body: [
        "Fans flooded social media as promoters confirmed ticket sales would " +
          "begin next week across major cities.",
      ],
    }),
    settings: STATE_DEPT_SETTINGS,
    semanticIntentScore: null,
    targetExpected: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      excludedBeforeRescue: true,
    },
    currentBaseline: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      excludedBeforeRescue: true,
    },
  },

  // 11 — Geo mismatch blocks semantic-geo rescue. Item is on a Sahel/ISIS
  //      story; configured geos intentionally only US + Colombia. Even with
  //      strong semantic, rescue must NOT fire.
  {
    id: "geo_mismatch_no_rescue",
    notes:
      "Geo gate on rescue_semantic_geo. Configured geos (US, Colombia) do not " +
      "match item; rescue blocked even though semantic ≥ 0.60.",
    story: makeStory({
      sourceId: "geo-mismatch",
      headline: "ISIS-linked cell claims attack near border town in Sahel",
      body: [
        "Analysts said the operation follows months of extremist activity and " +
          "could affect regional diplomatic coordination.",
      ],
    }),
    settings: Object.freeze({
      topics: ["Diplomatic relations"],
      keywords: ["sanctions"],
      geographies: ["US", "Colombia"],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "Monitor US–Colombia bilateral activity.",
    }),
    semanticIntentScore: 0.68,
    targetExpected: {
      in_dashboard: false,
      excluded: true,
      rescued: false,
      rescueReason: null,
      rescueBlockedReason: "geo_gate",
    },
    currentBaseline: {
      // D-063: with the MVP threshold lowered to 0.20 the semantic-only blend
      // contribution (det 0.00 + semantic 0.68 * 0.35 ≈ 0.238) now clears the
      // gate, so this item is admitted via the normal pass path — no rescue
      // path fires (geo, topic, keyword breakdown all 0) and no rescue-blocked
      // annotation is emitted because the item was never excluded.
      in_dashboard: true,
      excluded: false,
      rescued: false,
      rescueReason: null,
      rescueBlockedReason: null,
    },
  },

  // 12 — Amended uncapped rescue policy. Three eligible candidates in the
  //      rescue band, all matching the semantic-geo rescue criteria. After
  //      Point 6 (amended), ALL THREE are rescued (no cap). Today none of
  //      them are rescued because the semantic_geo path is not yet wired.
  {
    id: "rescue_cap_behavior",
    notes:
      "Amended rescue policy (uncapped). Three rescue-band candidates with " +
      "semantic ≥ 0.60 and configured geo; expect all three rescued at target. " +
      "Today the semantic_geo path does not exist → rescuedCount = 0.",
    isBatch: true,
    batch: [
      {
        story: makeStory({
          sourceId: "cap-1",
          headline: "China and U.S. envoys meet on technology export controls",
          body: [
            "Officials discussed semiconductor licensing and cross-border " +
              "investment screening between the United States and China.",
          ],
          minutesAgo: 20,
        }),
        semanticIntentScore: 0.66,
      },
      {
        story: makeStory({
          sourceId: "cap-2",
          headline: "Nigeria steps up coordination with U.S. on counterterrorism",
          body: [
            "Officials from Nigeria and the United States outlined joint " +
              "investigations into militant financing networks.",
          ],
          minutesAgo: 40,
        }),
        semanticIntentScore: 0.64,
      },
      {
        story: makeStory({
          sourceId: "cap-3",
          headline: "U.S. and China resume bilateral working group on trade",
          body: [
            "Officials from the United States and China said a working group " +
              "would meet quarterly on tariffs and supply chain risk.",
          ],
          minutesAgo: 60,
        }),
        semanticIntentScore: 0.61,
      },
    ],
    settings: Object.freeze({
      topics: ["Diplomatic relations"],
      // Intentionally narrow so each candidate sits in the rescue band on
      // deterministic alone — the semantic blend lifts the blended score
      // into the rescue band but not past 0.40.
      keywords: [],
      geographies: ["US", "China", "Nigeria"],
      ...NEUTRAL_SOURCES,
      onboardingNarrative: "Monitor U.S. diplomatic engagements with China and Nigeria.",
    }),
    targetExpected: {
      rescuedCount: 3,
      capBlockedCount: 0,
      perItem: [
        { sourceId: "cap-1", rescued: true, rescueReason: "rescue_semantic_geo" },
        { sourceId: "cap-2", rescued: true, rescueReason: "rescue_semantic_geo" },
        { sourceId: "cap-3", rescued: true, rescueReason: "rescue_semantic_geo" },
      ],
    },
    currentBaseline: {
      rescuedCount: 0,
      capBlockedCount: 0,
      perItem: [
        { sourceId: "cap-1", rescued: false, rescueReason: null },
        { sourceId: "cap-2", rescued: false, rescueReason: null },
        { sourceId: "cap-3", rescued: false, rescueReason: null },
      ],
    },
  },
]);

// Convenience accessor for tests that want to look up a single case by id.
export function getCaseById(id) {
  return RELEVANCE_PRECISION_CASES.find((c) => c.id === id) ?? null;
}

export const RELEVANCE_PRECISION_CASE_IDS = Object.freeze(
  RELEVANCE_PRECISION_CASES.map((c) => c.id)
);
