/**
 * Dashboard Elections — Colombia — Core (side-effect-free)
 *
 * Q6B primary acceptance test for the relevance strategy. A single hermetic
 * refresh over a realistic Colombia-presidential-election news mix proves the
 * whole pipeline does the right thing end-to-end:
 *
 *   • Recall (Q2 / translation-first): every fixture reaches the candidate stage;
 *     Spanish-language election coverage is admitted alongside English via the
 *     configured-geography lexical gate (no translateFn needed — they name
 *     "Colombia").
 *   • Geo precision (geo hard-fail): explicit wrong-geography controls (a Senegal
 *     election, an Argentina film story) are dropped before clustering.
 *   • Overflow + relevance survival (Q3 / Q3A): the dashboard ships AT MOST 5
 *     meta-stories, and when the clustered set overflows the cap the relevance
 *     ranking keeps the election stories and drops the generic same-geography
 *     noise story.
 *   • Corroboration / bundling (Q3B): at least one shipped election meta-story is
 *     multi-source.
 *   • Grounded tags + entities (Q1 / B1): the injected clusters carry
 *     `associated_entities` + tags, which feed the relevance score that decides
 *     survival.
 *
 * Hermetic: in-code RSS-shaped fixtures + an injected deterministic `clusterFn`.
 * No live RSS, no Anthropic, no embedding provider. Recall runs in `keyword`
 * (lexical) mode and beat-fit precision is disabled so the run stays
 * threshold-independent (mirrors the dual-beat / intra-beat cores).
 *
 * Import-safe: no env reads, no console, no `process.exit`. The `.test.mjs`
 * (wired as `npm run eval:dashboard-elections-colombia`) drives node:test, and
 * the dashboard quality gate imports `runDashboardElectionsColombia` directly.
 */

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

// Lexical-only recall: no embeddings, so admission depends purely on the lexical
// gates (keyword / configured-geo-in-text) — the surface Q2 widens. Pinned
// per-run so behavior doesn't depend on the process-wide TEMPO_RECALL_MODE.
const KEYWORD_RECALL = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

// Elections-focused monitoring persona: Colombia, election vocabulary, a realistic
// mix of international wires + Colombian / Spanish-language outlets. Every fixture
// outlet appears here so all 14 clear source selection and reach the candidate
// stage.
export const ELECTIONS_COLOMBIA_PERSONA = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  topics: ["Elections"],
  keywords: ["elections", "ballot"],
  geographies: ["Colombia"],
  traditionalSources: [
    "Reuters",
    "The Washington Post",
    "El Tiempo",
    "Semana",
    "La Silla Vacía",
    "Infobae",
    "El Espectador",
  ],
  socialSources: [],
});

function makeItem(overrides) {
  return {
    feedId: "elections-colombia",
    kind: "traditional",
    byline: "Staff",
    weight: 82,
    minutesAgo: 45,
    topic: "",
    geographies: ["Colombia"],
    body: ["Placeholder body."],
    ...overrides,
    // Neutral URL path — must NOT contain a configured-geography token (e.g.
    // "colombia"), or the geo lexical gate would read every item as a Colombia
    // mention via its URL and defeat both the geo hard-fail and recall filtering.
    url: `https://news.example.com/feed/${overrides.sourceId}`,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// 8 positives — Colombia presidential-election cycle, Spanish + English, across
// multiple outlets. All name "Colombia" so the configured-geo lexical gate admits
// them even without translation (the Spanish ones carry no English keyword).
export const COLOMBIA_ELECTION_ITEMS = Object.freeze([
  makeItem({
    sourceId: "col-elec-en-1",
    outlet: "Reuters",
    geographies: ["Colombia"],
    headline: "Colombia presidential election race tightens before the vote",
    body: ["Candidates crisscross the country ahead of the ballot."],
  }),
  makeItem({
    sourceId: "col-elec-en-2",
    outlet: "The Washington Post",
    geographies: ["Colombia"],
    headline: "Colombian candidates clash in final presidential debate",
    body: ["The debate in Colombia turned on tax reform and security."],
  }),
  makeItem({
    sourceId: "col-elec-es-1",
    outlet: "El Tiempo",
    lang: "es",
    geographies: ["Colombia"],
    headline: "Colombia define su elección presidencial en segunda vuelta",
    body: ["Los candidatos se preparan para el balotaje en Colombia."],
  }),
  makeItem({
    sourceId: "col-elec-es-2",
    outlet: "Semana",
    lang: "es",
    geographies: ["Colombia"],
    headline: "La campaña presidencial en Colombia entra en su recta final",
    body: ["Los aspirantes recorren Colombia antes de las elecciones."],
  }),
  makeItem({
    sourceId: "col-elec-es-3",
    outlet: "La Silla Vacía",
    lang: "es",
    geographies: ["Colombia"],
    headline: "Colombia: los candidatos cierran sus campañas antes del balotaje",
    body: ["La segunda vuelta definirá la presidencia de Colombia."],
  }),
  makeItem({
    sourceId: "col-elec-en-3",
    outlet: "Reuters",
    geographies: ["Colombia"],
    headline: "Colombia electoral authority finalizes the ballot for the runoff",
    body: ["Officials in Colombia prepared voting stations nationwide."],
  }),
  makeItem({
    sourceId: "col-elec-es-4",
    outlet: "Infobae",
    lang: "es",
    geographies: ["Colombia"],
    headline: "Elecciones en Colombia: la registraduría ultima los preparativos",
    body: ["La votación en Colombia se acerca y crece la expectativa."],
  }),
  makeItem({
    sourceId: "col-elec-en-4",
    outlet: "El Espectador",
    geographies: ["Colombia"],
    headline: "Colombia presidential vote: turnout is expected to break records",
    body: ["Analysts in Colombia watch the election turnout closely."],
  }),
]);

// 6 negatives — wrong-geo and wrong-beat noise.
//   • Wrong-geo (explicit conflict, no Colombia mention) → geo hard-fail before
//     clustering: a Senegal election and an Argentina film story.
//   • Wrong-beat but right-geo (Colombia) → reach clustering; the healer/cluster
//     stub never builds a shipped election story from them, and the one that IS
//     bundled as a story is trimmed by the overflow cap.
//   • Off-geo / off-beat with no geography → dropped at recall (neither gate).
export const SENEGAL_ELECTION_DECOY = Object.freeze(
  makeItem({
    sourceId: "sen-elec",
    outlet: "Reuters",
    geographies: ["Senegal"],
    headline: "Senegal holds presidential election amid record turnout",
    body: ["Voters across Senegal lined up to choose a new president."],
  })
);
export const ARGENTINA_FILM_DECOY = Object.freeze(
  makeItem({
    sourceId: "arg-film",
    outlet: "The Washington Post",
    geographies: ["Argentina"],
    headline: "Argentina film festival opens to crowds in Buenos Aires",
    body: ["The festival drew directors from across Argentina."],
  })
);
export const COLOMBIA_NOISE_ITEMS = Object.freeze([
  makeItem({
    sourceId: "col-tremor",
    outlet: "El Tiempo",
    lang: "es",
    geographies: ["Colombia"],
    headline: "Colombia: un sismo de magnitud moderada sacude la región andina",
    body: ["El temblor en Colombia no dejó víctimas, según las autoridades."],
  }),
  makeItem({
    sourceId: "col-traffic",
    outlet: "Semana",
    geographies: ["Colombia"],
    headline: "Bogotá gridlock worsens as a Colombia transit strike spreads",
    body: ["Commuters across Colombia faced long delays this week."],
  }),
  makeItem({
    sourceId: "col-coffee",
    outlet: "Infobae",
    lang: "es",
    geographies: ["Colombia"],
    headline: "Colombia: los precios del café alcanzan un récord histórico",
    body: ["La cosecha de café en Colombia supera las previsiones."],
  }),
  makeItem({
    sourceId: "generic-markets",
    outlet: "Reuters",
    geographies: [],
    topic: "Markets",
    headline: "Tokyo stock exchange posts modest gains in light trading",
    body: ["Markets in Japan edged higher amid thin volume."],
  }),
]);

export const ELECTIONS_COLOMBIA_RAW_ITEMS = Object.freeze([
  ...COLOMBIA_ELECTION_ITEMS,
  SENEGAL_ELECTION_DECOY,
  ARGENTINA_FILM_DECOY,
  ...COLOMBIA_NOISE_ITEMS,
]);

// Source-id groupings for assertions.
export const ELECTION_IDS = COLOMBIA_ELECTION_ITEMS.map((i) => i.sourceId);
export const SPANISH_ELECTION_IDS = COLOMBIA_ELECTION_ITEMS.filter((i) => i.lang === "es").map(
  (i) => i.sourceId
);
export const HARD_FAIL_IDS = [SENEGAL_ELECTION_DECOY.sourceId, ARGENTINA_FILM_DECOY.sourceId];
export const NEGATIVE_IDS = [
  ...HARD_FAIL_IDS,
  ...COLOMBIA_NOISE_ITEMS.map((i) => i.sourceId),
];
export const TOTAL_FIXTURES = ELECTIONS_COLOMBIA_RAW_ITEMS.length; // 14

// ── Cluster stub (deterministic, grounded, no provider) ───────────────────────
//
// Partitions whatever survives recall into the election cycle's facets plus a
// single Colombia geo-noise story. Election stories carry grounded `tags` +
// `associated_entities` (so they score high on relevance); the noise story is
// geo-only (low relevance). Emitting 6 meta-stories forces the post-grounding
// overflow cap (MAX_META_STORIES = 5) to fire — the relevance ranking must keep
// the 5 election facets and drop the noise story. Colombia noise items that are
// NOT part of the noise story (traffic, coffee) are intentionally left
// unclustered, so they never ship.
function groundedCluster({ id, title, sourceItems, electionTags }) {
  const sourceIds = sourceItems.map((i) => i.sourceId);
  // Corroborated claim map (one claim citing every source) so the split healer's
  // corroboration guard keeps multi-source stories merged rather than atomizing.
  const tags = electionTags
    ? {
        topics: ["Elections"],
        keywords: ["elections", "ballot"],
        geographies: ["Colombia"],
      }
    : { topics: [], keywords: [], geographies: ["Colombia"] };
  const associated_entities = electionTags
    ? ["Colombia", "presidential election", "Registraduría", "segunda vuelta"]
    : [];
  return {
    meta_story_id: id,
    title,
    subtitle: "Composed from grounded sources.",
    source_item_ids: sourceIds,
    summary: `${title}.`,
    tags,
    associated_entities,
    factual_claims: ["A claim grounded in every cited source."],
    claim_evidence_map: { "0": [...sourceIds] },
  };
}

function byId(items, ids) {
  const map = new Map(items.map((i) => [i.sourceId, i]));
  return ids.map((id) => map.get(id)).filter(Boolean);
}

function electionsClusterFn(capture) {
  return (items) => {
    capture.input = items;
    const present = new Set(items.map((i) => i.sourceId));
    const has = (id) => present.has(id);
    const pick = (ids) => byId(items, ids.filter(has));

    const clusters = [];
    // Five election facets (two multi-source, three smaller) — at least one is
    // multi-source so the corroboration/bundling assertion holds.
    const facets = [
      { id: "ms-elec-race", title: "Colombia presidential race tightens", ids: ["col-elec-en-1", "col-elec-es-2"] },
      { id: "ms-elec-debate", title: "Colombia presidential debate", ids: ["col-elec-en-2", "col-elec-es-1"] },
      { id: "ms-elec-runoff", title: "Colombia heads to a presidential runoff", ids: ["col-elec-es-3", "col-elec-en-3"] },
      { id: "ms-elec-ballot", title: "Colombia finalizes the election ballot", ids: ["col-elec-es-4"] },
      { id: "ms-elec-turnout", title: "Colombia election turnout in focus", ids: ["col-elec-en-4"] },
    ];
    for (const f of facets) {
      const sourceItems = pick(f.ids);
      if (sourceItems.length > 0) {
        clusters.push(groundedCluster({ id: f.id, title: f.title, sourceItems, electionTags: true }));
      }
    }
    // One generic Colombia geo-noise story (geo-only, low relevance). The other
    // Colombia noise items (traffic, coffee) are deliberately left unclustered.
    const tremor = pick(["col-tremor"]);
    if (tremor.length > 0) {
      clusters.push(
        groundedCluster({ id: "ms-noise-tremor", title: "Colombia earthquake tremor", sourceItems: tremor, electionTags: false })
      );
    }
    return Promise.resolve(clusters);
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────

/** Run the elections-colombia refresh once. Pure: no console, no exits. */
export async function runElectionsColombiaPipeline() {
  const capture = { input: null };
  const { payload, log } = await runRefreshPipeline({
    settings: ELECTIONS_COLOMBIA_PERSONA,
    rawItems: ELECTIONS_COLOMBIA_RAW_ITEMS.map((i) => ({ ...i })),
    clusterFn: electionsClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
  });
  return { payload, log, clusterInput: capture.input ?? [] };
}

// ── Acceptance checks (shared by the .test.mjs and the quality gate) ──────────

function shippedSourceIds(payload) {
  return (payload?.stories ?? []).flatMap((s) => (s.sources ?? []).map((src) => src.id));
}

/**
 * Run the refresh and evaluate every acceptance check. Returns the spanish-
 * recall/golden-style `{ results, summary }` shape so the dashboard quality gate
 * can consume it uniformly. Each result is `{ id, ok, reasons }`.
 */
export async function runDashboardElectionsColombia() {
  let run;
  try {
    run = await runElectionsColombiaPipeline();
  } catch (err) {
    const reason = `pipeline threw: ${err instanceof Error ? err.message : String(err)}`;
    return {
      results: [{ id: "pipeline-run", ok: false, reasons: [reason] }],
      summary: { total: 1, passed: 0, failed: 1, hardFail: true },
    };
  }

  const { payload, log } = run;
  const stories = payload?.stories ?? [];
  const shipped = shippedSourceIds(payload);
  const shippedSet = new Set(shipped);
  const results = [];
  const check = (id, ok, reasons = []) => results.push({ id, ok, reasons });

  // Q2 (recall): all 14 fixtures reach the candidate stage (source-selected).
  const afterSourceSelection = log?.decisionTrace?.stageCounts?.afterSourceSelection;
  check(
    "all-14-reach-candidate-stage",
    afterSourceSelection === TOTAL_FIXTURES,
    [`expected afterSourceSelection=${TOTAL_FIXTURES}, got ${afterSourceSelection}`]
  );

  // Geo precision: the two explicit wrong-geography controls are hard-failed
  // before clustering (no LLM) and never ship.
  const hardFailCount = log?.geo?.geoHardFailDroppedCount;
  check(
    "wrong-geo-controls-hard-failed",
    hardFailCount === HARD_FAIL_IDS.length && HARD_FAIL_IDS.every((id) => !shippedSet.has(id)),
    [`expected geoHardFailDroppedCount=${HARD_FAIL_IDS.length}, got ${hardFailCount}`,
     `wrong-geo controls in shipped: ${HARD_FAIL_IDS.filter((id) => shippedSet.has(id)).join(", ") || "none"}`]
  );

  // Q3: the dashboard ships AT MOST 5 meta-stories.
  check(
    "ships-at-most-5-meta-stories",
    stories.length <= 5 && (log?.metaStoryCount ?? stories.length) <= 5,
    [`shipped ${stories.length} stories (cap is 5)`]
  );

  // Q3A: the clustered set overflowed and the overflow cap dropped the generic
  // geo-noise story — election relevance survives over same-geography noise.
  const overflow = log?.overflowCap ?? {};
  check(
    "overflow-cap-drops-geo-noise",
    overflow.overflowCapApplied === true &&
      overflow.overflowDroppedMetaStoryIds?.includes("ms-noise-tremor"),
    [`overflowCapApplied=${overflow.overflowCapApplied}`,
     `dropped=${JSON.stringify(overflow.overflowDroppedMetaStoryIds ?? [])} (expected to include ms-noise-tremor)`]
  );

  // Election stories survive: every shipped story is an election story (its
  // sources are all election positives) and at least one ships.
  const electionSet = new Set(ELECTION_IDS);
  const allShippedAreElection = stories.length > 0 && shipped.every((id) => electionSet.has(id));
  check(
    "election-stories-survive-over-noise",
    allShippedAreElection,
    [`shipped sources: ${shipped.join(", ")}`]
  );

  // Q3B: at least one shipped election meta-story is multi-source (corroborated).
  const multiSource = stories.filter((s) => (s.sources ?? []).length >= 2);
  check(
    "at-least-one-multi-source-election-story",
    multiSource.length >= 1,
    [`multi-source story count: ${multiSource.length}`]
  );

  // All wrong-region / wrong-beat controls are absent from shipped stories.
  const leakedNegatives = NEGATIVE_IDS.filter((id) => shippedSet.has(id));
  check(
    "wrong-region-and-wrong-beat-controls-absent",
    leakedNegatives.length === 0,
    [`controls leaked into shipped: ${leakedNegatives.join(", ") || "none"}`]
  );

  // Q2 (translation-first / lexical geo gate): Spanish-language election coverage
  // is admitted and ships alongside the English coverage.
  const spanishShipped = SPANISH_ELECTION_IDS.filter((id) => shippedSet.has(id));
  check(
    "spanish-election-coverage-ships",
    spanishShipped.length >= 1,
    [`spanish election sources shipped: ${spanishShipped.join(", ") || "none"} of ${SPANISH_ELECTION_IDS.join(", ")}`]
  );

  const passed = results.filter((r) => r.ok).length;
  return {
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      hardFail: results.some((r) => !r.ok),
    },
  };
}
