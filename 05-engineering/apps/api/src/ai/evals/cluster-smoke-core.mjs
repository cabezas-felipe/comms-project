/**
 * Cluster Shape Smoke — Core (side-effect-free)
 *
 * Pure helpers and fixtures for the M8 cluster shape smoke.  This module is
 * safe to import from tests: no env reads, no logging, no `process.exit`,
 * no CLI side effects.  The CLI runner (`run-cluster-smoke.mjs`) is a thin
 * wrapper around `runClusterSmoke` that adds env loading, formatted logging,
 * and exit-code handling.
 *
 * Responsibilities:
 *   - canonical fixture (`FIXTURE_ITEMS`, `FIXTURE_SETTINGS`)
 *   - shape validation (`validateSmokeOutput`)
 *   - pure orchestrator (`runClusterSmoke`) that invokes an injected
 *     clustering function and returns a structured `{ ok, stories, failures,
 *     error }` result — no process exits, no console output
 */

import { metaStoryOutputSchema } from "../cluster-engine.mjs";

// ─── Fixture ─────────────────────────────────────────────────────────────────
// Three items across two topics — enough for the model (or mock) to produce
// at least one cluster, while keeping the prompt small and the diagnostic
// surface tight.  Shape mirrors the normalized item shape the refresh
// pipeline feeds into clusterItems().
export const FIXTURE_ITEMS = Object.freeze([
  {
    sourceId: "smoke-src-1",
    outlet: "Reuters",
    topic: "Diplomatic relations",
    geographies: ["US", "Colombia"],
    weight: 90,
    url: "https://example.com/a",
    minutesAgo: 30,
    headline: "US and Colombia hold bilateral diplomacy talks on security",
    body: ["Officials from both governments met to discuss bilateral cooperation."],
    kind: "traditional",
  },
  {
    sourceId: "smoke-src-2",
    outlet: "El Tiempo",
    topic: "Diplomatic relations",
    geographies: ["Colombia", "US"],
    weight: 85,
    url: "https://example.com/b",
    minutesAgo: 45,
    headline: "Colombia–US joint statement after bilateral diplomacy meetings",
    body: ["The two countries issued a joint statement on cooperation."],
    kind: "traditional",
  },
  {
    sourceId: "smoke-src-3",
    outlet: "Washington Post",
    topic: "Migration policy",
    geographies: ["US"],
    weight: 80,
    url: "https://example.com/c",
    minutesAgo: 60,
    headline: "US migration policy update affects deportation procedures",
    body: ["New guidance changes how deportation cases are reviewed."],
    kind: "traditional",
  },
]);

export const FIXTURE_SETTINGS = Object.freeze({
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["deportation", "diplomacy"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["Reuters", "El Tiempo", "Washington Post"],
  socialSources: [],
});

export const FIXTURE_SOURCE_IDS = new Set(FIXTURE_ITEMS.map((i) => i.sourceId));

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate clusterItems output against the same contract the refresh
 * pipeline relies on.  Pure function — returns `{ ok, failures }` so callers
 * (runner OR tests) can act on the result without parsing log output.
 *
 * @param {unknown} stories — value returned by clusterItems
 * @param {Set<string>} [knownSourceIds] — defaults to FIXTURE_SOURCE_IDS
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function validateSmokeOutput(stories, knownSourceIds = FIXTURE_SOURCE_IDS) {
  const failures = [];

  if (!Array.isArray(stories)) {
    failures.push(`clusterItems must return an array — got ${typeof stories}`);
    return { ok: false, failures };
  }
  if (stories.length === 0) {
    failures.push("clusterItems returned 0 meta-stories for a 3-item fixture");
    return { ok: false, failures };
  }

  stories.forEach((story, idx) => {
    const parsed = metaStoryOutputSchema.safeParse(story);
    if (!parsed.success) {
      failures.push(
        `meta_stories[${idx}] failed schema: ${parsed.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; ")}`
      );
      return;
    }
    if (typeof story.meta_story_id !== "string" || story.meta_story_id.length === 0) {
      failures.push(`meta_stories[${idx}] is missing a non-empty meta_story_id`);
    }
    const unknown = (story.source_item_ids ?? []).filter((id) => !knownSourceIds.has(id));
    if (unknown.length > 0) {
      failures.push(
        `meta_stories[${idx}] references unknown source_item_ids: [${unknown.join(", ")}]`
      );
    }
  });

  return { ok: failures.length === 0, failures };
}

// ─── Pure orchestrator ───────────────────────────────────────────────────────

/**
 * Run the smoke flow against an injected clustering function.  No env reads,
 * no logging, no process exits — returns a structured result the caller is
 * responsible for formatting / acting on.
 *
 * @param {object} opts
 * @param {(items: unknown[], settings: object, model: string) => Promise<unknown[]>} opts.clusterFn
 *   Clustering function with the same shape as `clusterItems` from
 *   cluster-engine.mjs.  Injected (not imported here) to keep this module
 *   provider-agnostic and trivially mockable in tests.
 * @param {string} opts.model — model id passed through to `clusterFn`
 * @returns {Promise<{
 *   ok: boolean,
 *   stories: unknown[] | null,
 *   failures: string[],
 *   error: Error | null,
 * }>}
 */
export async function runClusterSmoke({ clusterFn, model }) {
  let stories;
  try {
    stories = await clusterFn(FIXTURE_ITEMS, FIXTURE_SETTINGS, model);
  } catch (err) {
    return {
      ok: false,
      stories: null,
      failures: [],
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  const { ok, failures } = validateSmokeOutput(stories);
  return { ok, stories, failures, error: null };
}
