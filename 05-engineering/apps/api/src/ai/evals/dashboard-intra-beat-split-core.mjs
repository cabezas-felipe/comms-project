/**
 * Dashboard Intra-Beat Split — Core (side-effect-free)
 *
 * Regression harness locking the exact failure mode the cluster-split healer
 * (Slices 1–3) exists to fix: WITHIN a single country, two UNRELATED events
 * must surface as SEPARATE meta-stories — even when the clustering stage merges
 * them into one (the over-merge bug). The canonical case is Colombia:
 *   1) a presidential election
 *   2) an armed attack on a gold mine
 * These share only the country; merging them is wrong. The healer must split a
 * merged cluster back into one meta-story per source item.
 *
 * It also pins the inverse guard: a SAME-EVENT pair (two election variants that
 * genuinely belong together) must STAY merged — the healer must not over-split
 * a legitimate multi-source story.
 *
 * Hermetic: in-code fixtures + an injected cluster stub that intentionally
 * over-merges. No live RSS, no Anthropic, no embedding provider. Recall runs in
 * `keyword` mode so the only recall gates are lexical (topic / keyword /
 * configured-geo-in-text); beat-fit precision is disabled so the run stays
 * threshold-independent (mirrors the golden / dual-beat cores). The healer runs
 * at its production default (ENABLED) — no `clusterSplitConfig` override — so
 * the eval exercises real pipeline behavior.
 *
 * Import-safe: no env reads, no console, no `process.exit`. The `.test.mjs`
 * (wired as `npm run eval:dashboard-intra-beat-split`) drives formatting + exit.
 */

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

// Recall in lexical-only mode: no embeddings, so the run depends only on the
// lexical gates. Pinned per-run so behavior doesn't depend on the process-wide
// TEMPO_RECALL_MODE (mutated by other test files).
const KEYWORD_RECALL = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

// One country, elections vocabulary. Both unrelated items still reach recall:
// the election item via the "election" keyword, the mine-attack item via the
// configured-geography ("Colombia") lexical gate (it carries no settings
// keyword). Same-country, different events — the over-merge trap.
export const INTRA_BEAT_PERSONA = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  topics: ["Elections"],
  keywords: ["election", "elections", "ballot"],
  geographies: ["Colombia"],
  traditionalSources: ["Reuters", "The Washington Post"],
  socialSources: [],
});

function makeItem(overrides) {
  return {
    feedId: "intra-beat-split",
    kind: "traditional",
    byline: "Staff",
    weight: 82,
    minutesAgo: 30,
    topic: "",
    geographies: ["Colombia"],
    body: ["Placeholder body."],
    ...overrides,
    url: `https://example.com/intra-beat-split/${overrides.sourceId}`,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
//
// Scenario A — two UNRELATED Colombia events. Share only the country token; the
// rest of the vocabulary is disjoint, so once geography is stripped their token
// overlap is ~0. This is the merge the healer must undo.
export const COLOMBIA_UNRELATED_ITEMS = Object.freeze([
  makeItem({
    sourceId: "co-election",
    outlet: "Reuters",
    headline: "Colombia presidential election race tightens before the vote",
    body: ["Candidates crisscross the country ahead of the ballot."],
  }),
  makeItem({
    sourceId: "co-mine",
    outlet: "The Washington Post",
    // No settings keyword → admitted ONLY via the configured-geo lexical gate.
    headline: "Armed group attacks Colombia gold mine, killing several workers",
    body: ["Authorities blame an illegal armed faction for the deadly assault."],
  }),
]);

// Scenario B — a SAME-EVENT pair: two variants of the SAME Colombia election
// story. High token overlap; the cluster stub grounds them under one shared,
// corroborated claim. The healer must leave this merged (no over-split).
export const COLOMBIA_SAME_EVENT_ITEMS = Object.freeze([
  makeItem({
    sourceId: "co-elect-a",
    outlet: "Reuters",
    headline: "Colombia presidential election debate draws record viewers",
    body: ["The presidential debate covered tax reform and security policy."],
  }),
  makeItem({
    sourceId: "co-elect-b",
    outlet: "The Washington Post",
    headline: "Colombia presidential election debate sparks tax reform clash",
    body: ["Candidates argued over tax reform and security during the debate."],
  }),
]);

// ── Cluster stub ────────────────────────────────────────────────────────────
//
// Intentionally OVER-MERGES: collapses every survivor into a SINGLE meta-story.
// That is the behavior the healer corrects (Scenario A) or correctly leaves
// alone (Scenario B). The claim_evidence_map shape encodes the realistic
// difference between the two cases:
//   • disjoint  — one claim per source, no source shared. The fingerprint of an
//                 over-merge of independent stories (each claim stands alone).
//   • corroborated — a single claim grounded in BOTH sources. The fingerprint
//                 of a genuine multi-source story (the healer's corroboration
//                 guard must keep this merged).
function makeMergedCluster({ id, title, sourceItems, corroborated }) {
  const sourceIds = sourceItems.map((i) => i.sourceId);
  const factual_claims = corroborated
    ? ["A claim grounded in every cited source."]
    : sourceIds.map((_, i) => `Independent claim ${i} grounded in its own source.`);
  const claim_evidence_map = corroborated
    ? { "0": [...sourceIds] }
    : Object.fromEntries(sourceIds.map((sid, i) => [String(i), [sid]]));
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
    factual_claims,
    claim_evidence_map,
  };
}

// Merge ALL survivors into one meta-story with the given evidence shape. Captures
// the cluster input so a test can assert recall didn't drop an item upstream.
function overMergeClusterFn(capture, { id, title, corroborated }) {
  return (items) => {
    capture.input = items;
    if (!items || items.length === 0) return Promise.resolve([]);
    return Promise.resolve([
      makeMergedCluster({ id, title, sourceItems: items, corroborated }),
    ]);
  };
}

// ── Runs ─────────────────────────────────────────────────────────────────────
//
// Both runs leave the split healer at its production default (ENABLED) — no
// `clusterSplitConfig` override — so the eval pins real pipeline behavior.

/**
 * Scenario A: two unrelated Colombia events merged by the stub into ONE
 * meta-story (disjoint single-source claims). The healer should split them back
 * into two distinct stories.
 */
export async function runIntraBeatSplit() {
  const capture = { input: null };
  const { payload, log } = await runRefreshPipeline({
    settings: INTRA_BEAT_PERSONA,
    rawItems: COLOMBIA_UNRELATED_ITEMS.map((i) => ({ ...i })),
    clusterFn: overMergeClusterFn(capture, {
      id: "intra-merged-unrelated",
      title: "Colombia developments",
      corroborated: false,
    }),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
  });
  return { payload, log, clusterInput: capture.input ?? [] };
}

/**
 * Scenario B: a same-event election pair merged by the stub into ONE meta-story
 * (single corroborated claim). The healer should leave it merged.
 */
export async function runIntraBeatControl() {
  const capture = { input: null };
  const { payload, log } = await runRefreshPipeline({
    settings: INTRA_BEAT_PERSONA,
    rawItems: COLOMBIA_SAME_EVENT_ITEMS.map((i) => ({ ...i })),
    clusterFn: overMergeClusterFn(capture, {
      id: "intra-merged-same-event",
      title: "Colombia presidential election debate",
      corroborated: true,
    }),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
  });
  return { payload, log, clusterInput: capture.input ?? [] };
}
