/**
 * Dashboard Dual-Beat — Core (side-effect-free)
 *
 * Regression harness proving that a SINGLE onboarding profile can yield TWO
 * separate beats in ONE refresh run:
 *   1) Colombia elections
 *   2) Kenya Ebola
 *
 * Why this exists: the recall-widening work (Slices 1–3) made geography a
 * lexical recall signal (shared geo matcher + recall geo gate) so a multi-beat
 * monitor isn't collapsed to a single dominant topic. This harness pins that a
 * persona watching Colombia-elections AND Kenya-Ebola surfaces BOTH beats as
 * distinct meta-stories — not merged, not dropped — in a single deterministic
 * run.
 *
 * Hermetic: in-code fixtures + injected stubs (clusterFn). No live RSS, no
 * Anthropic, no embedding provider. Recall runs in `keyword` mode so the only
 * recall gates are lexical (topic / keyword / configured-geo-in-text) — exactly
 * the Slice 2 surface under test. beat-fit precision is disabled so the run
 * stays independent of the ambient threshold (mirrors the golden/calibration
 * cores).
 *
 * Import-safe: no env reads, no console, no `process.exit`. The `.test.mjs`
 * (wired as `npm run eval:dashboard-dual-beat`) drives formatting + exit.
 */

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

// Recall in lexical-only mode: no embeddings, so the geo lexical gate is the
// thing exercised. Pinned per-run so behavior doesn't depend on the process-
// wide TEMPO_RECALL_MODE (mutated by other test files).
const KEYWORD_RECALL = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

// One onboarding profile spanning two beats: Colombia elections + Kenya Ebola.
// geographies carry BOTH countries; keywords cover the elections + Ebola
// monitoring vocabulary. Sources are the Batch-1 publishers used elsewhere in
// the eval suite. Topics are descriptive (not canonical contract topics) — geo
// + keyword carry recall, which is the point.
export const DUAL_BEAT_PERSONA = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  topics: ["Elections", "Public health"],
  keywords: ["election", "elections", "ballot", "Ebola", "outbreak"],
  geographies: ["Colombia", "Kenya"],
  traditionalSources: ["Reuters", "The Washington Post"],
  socialSources: [],
});

function makeItem(overrides) {
  return {
    feedId: "dual-beat",
    kind: "traditional",
    byline: "Staff",
    weight: 82,
    minutesAgo: 30,
    topic: "",
    geographies: [],
    body: ["Placeholder body."],
    ...overrides,
    url: `https://example.com/dual-beat/${overrides.sourceId}`,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
//
// Each beat has TWO items by design:
//   • a keyword item   — matches a settings keyword (election / Ebola) → admitted
//                        via the keyword gate.
//   • a geo-only item  — mentions the configured country in text but NO settings
//                        keyword → admitted ONLY via the Slice 2 geo lexical gate
//                        (this is the signal the harness protects).
// item.geographies is set to the configured country so the upstream geo-filter
// admits via explicit_match (no LLM assessor needed); the recall geo gate is
// text-based and independent of that field.
export const COLOMBIA_ITEMS = Object.freeze([
  makeItem({
    sourceId: "col-elect-kw",
    outlet: "Reuters",
    geographies: ["Colombia"],
    headline: "Colombia presidential election race tightens before the vote",
    body: ["Candidates crisscross the country ahead of the ballot."],
  }),
  makeItem({
    sourceId: "col-elect-geo",
    outlet: "The Washington Post",
    geographies: ["Colombia"],
    // No settings keyword here ("campaign"/"rally" are not keywords). Mentions
    // Colombia in text → admitted via geo lexical gate only.
    headline: "Colombians rally in Bogotá as candidates make a final push",
    body: ["Crowds gathered across Colombia for the campaign's closing weekend."],
  }),
]);

export const KENYA_ITEMS = Object.freeze([
  makeItem({
    sourceId: "ken-ebola-kw",
    outlet: "Reuters",
    geographies: ["Kenya"],
    headline: "Kenya confirms new Ebola outbreak in an eastern county",
    body: ["Health officials are tracing contacts after the outbreak."],
  }),
  makeItem({
    sourceId: "ken-ebola-geo",
    outlet: "The Washington Post",
    geographies: ["Kenya"],
    // No settings keyword ("surveillance"/"monitoring" are not keywords). The
    // body mentions Kenya as a standalone token → admitted via geo lexical gate
    // only (note: "Kenyan" alone would not match the \bKenya\b boundary).
    headline: "Kenyan hospitals brace as health teams widen surveillance",
    body: ["Authorities across Kenya stepped up monitoring efforts this week."],
  }),
]);

// Off-beat decoy: empty geographies (passes the geo-filter implicit gate via the
// mock assessor) but mentions neither configured country nor any keyword, so the
// recall lexical gate must drop it. Proves recall — not the geo-filter — is what
// holds the line.
export const DECOY_ITEM = Object.freeze(
  makeItem({
    sourceId: "decoy-markets-1",
    outlet: "Reuters",
    geographies: [],
    topic: "Markets",
    headline: "Tokyo stock exchange posts modest gains",
    body: ["Markets in Japan edged higher in light trading."],
  })
);

export const DUAL_BEAT_RAW_ITEMS = Object.freeze([
  ...COLOMBIA_ITEMS,
  ...KENYA_ITEMS,
  DECOY_ITEM,
]);

// ── Cluster stub ────────────────────────────────────────────────────────────
//
// Partitions whatever survived recall into a Colombia beat and a Kenya beat by
// the country token in each item's text, and emits ONE grounded meta-story per
// non-empty beat. Beat-aware (not a naive split) so the test fails loudly if
// recall ever drops one beat entirely — that beat's partition would be empty and
// only one story would ship.
function mentionsColombia(item) {
  const t = `${item.headline ?? ""} ${(item.body ?? []).join(" ")}`.toLowerCase();
  return t.includes("colombia") || t.includes("bogot");
}
function mentionsKenya(item) {
  const t = `${item.headline ?? ""} ${(item.body ?? []).join(" ")}`.toLowerCase();
  return t.includes("kenya");
}

function makeGroundedCluster({ id, title, sourceItems }) {
  const sourceIds = sourceItems.map((i) => i.sourceId);
  return {
    meta_story_id: id,
    title,
    subtitle: "Composed from grounded sources.",
    source_item_ids: sourceIds,
    summary: `${title}.`,
    tags: {
      topics: [],
      keywords: [],
      geographies: [...new Set(sourceItems.flatMap((i) => i.geographies ?? []))],
    },
    factual_claims: ["A claim grounded in the cited sources."],
    claim_evidence_map: { "0": sourceIds },
  };
}

function dualBeatClusterFn(capture) {
  return (items) => {
    capture.input = items;
    const colombia = items.filter(mentionsColombia);
    const kenya = items.filter((i) => mentionsKenya(i) && !mentionsColombia(i));
    const clusters = [];
    if (colombia.length > 0) {
      clusters.push(
        makeGroundedCluster({
          id: "dual-ms-colombia",
          title: "Colombia presidential election race",
          sourceItems: colombia,
        })
      );
    }
    if (kenya.length > 0) {
      clusters.push(
        makeGroundedCluster({
          id: "dual-ms-kenya",
          title: "Kenya Ebola outbreak response",
          sourceItems: kenya,
        })
      );
    }
    return Promise.resolve(clusters);
  };
}

// ── Run ───────────────────────────────────────────────────────────────────
//
// Returns the raw pipeline output plus the captured cluster-input so the test
// can assert both the final payload and the recall diagnostics. Pure: no
// console, no exits.
export async function runDashboardDualBeat() {
  const capture = { input: null };
  const { payload, log } = await runRefreshPipeline({
    settings: DUAL_BEAT_PERSONA,
    rawItems: DUAL_BEAT_RAW_ITEMS.map((i) => ({ ...i })),
    clusterFn: dualBeatClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
  });
  return { payload, log, clusterInput: capture.input ?? [] };
}
