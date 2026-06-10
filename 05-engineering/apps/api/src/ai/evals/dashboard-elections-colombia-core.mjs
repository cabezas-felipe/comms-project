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

// ── Cap-pressure scenario (Step 1.8) ──────────────────────────────────────────
//
// A SEPARATE, larger pool whose post-hard-fail/dedupe candidate set exceeds the
// C1 cluster-input cap (15), so the cap actually bites and we can prove election
// relevance survives INTO cluster input (not only into final stories). Kept
// distinct from the 14-item acceptance scenario so the existing checks stay
// exact and unbrittle.
//
// Composition (all survive recall + geo): 8 Colombia election positives (reuse),
// 3 cross-country elections (untagged geo → implicit, NOT hard-failed → they
// reach clustering and classify as crossCountryElection), 9 Colombia geo-noise
// distractors, plus the 2 explicit wrong-geo controls (hard-failed, never reach
// the cap). Surviving pool = 8 + 3 + 9 = 20 > 15.

// Cross-country elections: no explicit geography tag (so the explicit-conflict
// geo hard-fail does NOT drop them) and no "Colombia" mention (so they classify
// as cross-country, not configured-geo). They clear keyword recall via "election".
export const CROSS_COUNTRY_ELECTION_ITEMS = Object.freeze([
  makeItem({
    sourceId: "xc-elec-peru",
    outlet: "Reuters",
    geographies: [],
    headline: "Peru election runoff results spark protests in Lima",
    body: ["Voters across Peru awaited the final election tally."],
  }),
  makeItem({
    sourceId: "xc-elec-brazil",
    outlet: "The Washington Post",
    geographies: [],
    headline: "Brazil presidential election debate heats up over the economy",
    body: ["The Brazil election campaign entered its final stretch."],
  }),
  makeItem({
    sourceId: "xc-elec-mexico",
    outlet: "Reuters",
    geographies: [],
    headline: "Mexico election ballot count underway after record turnout",
    body: ["Officials tallied the Mexico election vote overnight."],
  }),
]);

// 9 Colombia geo-noise distractors — right geography, wrong beat. All name
// "Colombia" so they clear recall via the geo lexical gate; none are election.
export const CAP_PRESSURE_NOISE_ITEMS = Object.freeze(
  [
    { sourceId: "cap-noise-volcano", outlet: "El Tiempo", headline: "Colombia volcano alert raised near the Nevado del Ruiz" },
    { sourceId: "cap-noise-weather", outlet: "Semana", headline: "Colombia braces for heavy rains across the Andean region" },
    { sourceId: "cap-noise-flood", outlet: "Infobae", headline: "Colombia flooding displaces families on the Caribbean coast" },
    { sourceId: "cap-noise-coffee", outlet: "El Espectador", headline: "Colombia coffee exports hit a seasonal high" },
    { sourceId: "cap-noise-traffic", outlet: "El Tiempo", headline: "Bogota traffic snarls as a Colombia transit strike spreads" },
    { sourceId: "cap-noise-power", outlet: "Semana", headline: "Colombia power outage leaves towns dark after a storm" },
    { sourceId: "cap-noise-football", outlet: "Infobae", headline: "Colombia football side names its squad for the friendlies" },
    { sourceId: "cap-noise-festival", outlet: "El Espectador", headline: "Colombia music festival returns to Medellin this month" },
    { sourceId: "cap-noise-quake", outlet: "El Tiempo", headline: "Colombia earthquake tremor felt across the central region" },
  ].map((spec, i) =>
    makeItem({
      ...spec,
      geographies: ["Colombia"],
      minutesAgo: 20 + i * 5, // varied freshness; deterministic
      // Body deliberately carries NO election-cycle vocabulary (no
      // election/vote/ballot/candidate/campaign/runoff/presidential) so these
      // stay pure geo-noise and never score as election-relevant.
      body: [`A Colombia local affairs report from ${spec.outlet}.`],
    })
  )
);

export const CAP_PRESSURE_RAW_ITEMS = Object.freeze([
  ...COLOMBIA_ELECTION_ITEMS,
  ...CROSS_COUNTRY_ELECTION_ITEMS,
  ...CAP_PRESSURE_NOISE_ITEMS,
  SENEGAL_ELECTION_DECOY,
  ARGENTINA_FILM_DECOY,
]);

export const CROSS_COUNTRY_ELECTION_IDS = CROSS_COUNTRY_ELECTION_ITEMS.map((i) => i.sourceId);
export const CAP_PRESSURE_NOISE_IDS = CAP_PRESSURE_NOISE_ITEMS.map((i) => i.sourceId);
// Post-hard-fail candidate count: everything except the 2 explicit wrong-geo
// controls (20), which is > CLUSTER_INPUT_CAP (15).
export const CAP_PRESSURE_SURVIVING_COUNT =
  ELECTION_IDS.length + CROSS_COUNTRY_ELECTION_IDS.length + CAP_PRESSURE_NOISE_IDS.length; // 20

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

/**
 * Run the larger cap-pressure scenario once. Same hermetic harness; the only
 * difference is the >cap candidate pool, so the C1 cluster-input cap fires and
 * `clusterInput` (what `clusterFn` actually saw) reflects the relevance ranking.
 */
export async function runElectionsColombiaCapPressure() {
  const capture = { input: null };
  const { payload, log } = await runRefreshPipeline({
    settings: ELECTIONS_COLOMBIA_PERSONA,
    rawItems: CAP_PRESSURE_RAW_ITEMS.map((i) => ({ ...i })),
    clusterFn: electionsClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
  });
  return { payload, log, clusterInput: capture.input ?? [] };
}

// ── Phase 4.1: same-event bundling scenario ───────────────────────────────────
//
// Pins the cross-cluster election bundle-merge end to end: clustering FRAGMENTS
// the SAME event (a presidential debate covered by two wires, EN + ES) into two
// separate single-source meta-stories; the deterministic merge must reunify them
// into ONE published story. A third, DIFFERENT-event election cluster (a vote
// count) must stay separate — proving the merge is same-event, not same-cycle.
export const SAME_EVENT_BUNDLE_ITEMS = Object.freeze([
  makeItem({
    sourceId: "se-debate-en",
    outlet: "Reuters",
    geographies: ["Colombia"],
    headline: "Colombia presidential debate: Petro and Gutierrez clash over tax reform",
    body: ["The two contenders sparred over the proposed tax reform plan in the election."],
  }),
  makeItem({
    sourceId: "se-debate-es",
    outlet: "El Tiempo",
    lang: "es",
    geographies: ["Colombia"],
    headline: "Petro, Gutierrez spar on tax reform in Colombia presidential debate",
    body: ["Tax reform dominated the election debate between the candidates."],
  }),
  makeItem({
    sourceId: "se-count",
    outlet: "El Espectador",
    geographies: ["Colombia"],
    headline: "Colombia electoral authority certifies the first-round vote count",
    body: ["Officials finalized the ballot tally across the country in the election."],
  }),
]);

// ClusterFn that FRAGMENTS the same debate into two separate stories (the failure
// mode), plus a distinct vote-count story.
function sameEventFragmentingClusterFn() {
  const grounded = (id, ids) => ({
    meta_story_id: id,
    title: id,
    subtitle: "",
    source_item_ids: [...ids],
    summary: id,
    tags: { topics: ["Elections"], keywords: ["election"], geographies: ["Colombia"] },
    associated_entities: ["Colombia", "presidential election"],
    factual_claims: ids.map((sid) => `claim ${sid}`),
    claim_evidence_map: Object.fromEntries(ids.map((sid, i) => [String(i), [sid]])),
  });
  return (items) => {
    const present = new Set(items.map((i) => i.sourceId));
    const clusters = [];
    if (present.has("se-debate-en")) clusters.push(grounded("ms-se-debate-en", ["se-debate-en"]));
    if (present.has("se-debate-es")) clusters.push(grounded("ms-se-debate-es", ["se-debate-es"]));
    if (present.has("se-count")) clusters.push(grounded("ms-se-count", ["se-count"]));
    return Promise.resolve(clusters);
  };
}

/** Run the same-event bundling scenario once. Pure: no console, no exits. */
export async function runElectionsColombiaSameEventBundle() {
  const { payload, log } = await runRefreshPipeline({
    settings: ELECTIONS_COLOMBIA_PERSONA,
    rawItems: SAME_EVENT_BUNDLE_ITEMS.map((i) => ({ ...i })),
    clusterFn: sameEventFragmentingClusterFn(),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
  });
  return { payload, log };
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

  // ── Cap-pressure block (Step 1.8): election survival INTO cluster input ──────
  //
  // A second hermetic run over the >cap pool. These checks inspect the capped
  // `clusterInput` (what clustering actually saw) — proving relevance survival at
  // the C1 cap stage, not only in the final shipped stories.
  try {
    const cap = await runElectionsColombiaCapPressure();
    const input = cap.clusterInput ?? [];
    const inputIds = input.map((i) => i.sourceId);
    const inputSet = new Set(inputIds);
    const countIn = (ids) => ids.filter((id) => inputSet.has(id)).length;
    const electionInInput = countIn(ELECTION_IDS);
    const crossInInput = countIn(CROSS_COUNTRY_ELECTION_IDS);
    const noiseInInput = countIn(CAP_PRESSURE_NOISE_IDS);
    const capDiag = cap.log?.clusterCap ?? {};

    // 1) The cap actually bit: the pool exceeded 15 and clusterInput == cap.
    check(
      "cap-pressure-pool-exceeds-cap",
      capDiag.dedupedCount > 15 && input.length === 15,
      [`dedupedCount=${capDiag.dedupedCount} (expected >15), clusterInput=${input.length} (expected 15)`]
    );

    // 2) Election positives survive into cluster input under cap pressure.
    check(
      "cap-pressure-colombia-elections-survive-cluster-input",
      electionInInput >= 6,
      [`Colombia election positives in clusterInput: ${electionInInput}/8 (expected >=6)`]
    );

    // 3) Geo-noise does not dominate the capped cluster input.
    check(
      "cap-pressure-noise-does-not-dominate-cluster-input",
      electionInInput > noiseInInput,
      [`elections=${electionInInput} vs noise=${noiseInInput} in clusterInput`]
    );

    // 4) Decision 5C: configured-geo elections outrank cross-country peers ON
    //    AVERAGE in the ranked cluster input. (Mean rank — robust to a weak-signal
    //    Colombia item that names only "candidates/debate" legitimately sitting
    //    below a cross-country item that explicitly says "election ballot".)
    const meanRank = (ids) => {
      const ranks = ids.map((id) => inputIds.indexOf(id)).filter((r) => r >= 0);
      return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : Infinity;
    };
    const colombiaMeanRank = meanRank(ELECTION_IDS);
    const crossMeanRank = meanRank(CROSS_COUNTRY_ELECTION_IDS);
    check(
      "cap-pressure-configured-geo-outranks-cross-country",
      colombiaMeanRank < crossMeanRank,
      [`Colombia mean rank=${colombiaMeanRank.toFixed(2)} vs cross-country mean rank=${crossMeanRank.toFixed(2)} (lower = better)`]
    );

    // 5) Cross-country elections are deprioritized but can still survive when
    //    relevant, while configured-geo presence stays stronger.
    check(
      "cap-pressure-cross-country-survives-but-weaker",
      crossInInput >= 1 && electionInInput > crossInInput,
      [`cross-country in clusterInput=${crossInInput} (expected >=1), elections=${electionInInput} (must exceed cross-country)`]
    );

    // 6) Drop diagnostics: clusterDropped aligns with clusterDroppedSourceIds and
    //    the dropped set is dominated by noise/off-beat (no election dropped).
    const droppedIds = capDiag.clusterDroppedSourceIds ?? [];
    const droppedDetail = capDiag.clusterDropped ?? [];
    const droppedElections = droppedIds.filter(
      (id) => ELECTION_IDS.includes(id) || CROSS_COUNTRY_ELECTION_IDS.includes(id)
    );
    const detailAligned =
      Array.isArray(droppedDetail) &&
      droppedDetail.every((d, i) => d.sourceId === droppedIds[i]) &&
      droppedDetail.every((d) => typeof d.preClusterScore === "number" && d.components && d.electionGeoClass);
    check(
      "cap-pressure-drop-diagnostics-noise-dominated",
      droppedElections.length === 0 && detailAligned,
      [`dropped elections: ${droppedElections.join(", ") || "none"}`,
       `dropped detail aligned + scored: ${detailAligned}`,
       `droppedIds: ${droppedIds.join(", ")}`]
    );
  } catch (err) {
    check("cap-pressure-run", false, [
      `cap-pressure pipeline threw: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

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
