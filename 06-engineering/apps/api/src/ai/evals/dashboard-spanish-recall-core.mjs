/**
 * Dashboard Spanish Recall — Core (side-effect-free)
 *
 * Phase 3 Slice 14 recall/admission proof for translation-first normalization.
 *
 * Scenarios (all hermetic — injected `translateFn` + `clusterFn`, no network):
 *   1. baseline-no-translation  — Spanish RSS-shaped items + English settings
 *      with translation DISABLED → recall is empty (the items never reach
 *      clustering). Proves the gap the slice closes.
 *   2. translated-recall        — same fixture with translation ENABLED via a
 *      deterministic ES→EN stub → every item reaches the clustering pool via
 *      normalized English evidence, and a grounded story ships.
 *   3. degraded-partial-failure — a Spanish cluster where translation fails for
 *      a subset (fail-open). The refresh still COMPLETES, the translated subset
 *      ships, and the affected story is marked low-confidence/degraded in
 *      `_meta.translation` (coverage below the 60% threshold).
 *
 * Import-safe: no env reads, no console, no process.exit. The `.test.mjs`
 * (wired as `npm run eval:dashboard-spanish-recall`) drives node:test.
 */

import { runRefreshPipeline } from "../../dashboard/refresh-pipeline.mjs";

const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

// Keyword recall mode keeps the proof deterministic (no embedder needed): the
// recall stage is exactly `applyTopicKeywordFilter`, which reads normalized
// English evidence when present.
const KEYWORD_RECALL = Object.freeze({
  mode: "keyword",
  embedTopK: 5,
  embedMaxItems: 100,
  embeddingModel: "text-embedding-3-small",
});

const TRANSLATION_ENABLED = Object.freeze({
  mode: "auto",
  concurrency: 4,
  timeoutMs: 8000,
  maxChars: 700,
  maxSnippets: 2,
});

const TRANSLATION_DISABLED = Object.freeze({
  mode: "off",
  concurrency: 4,
  timeoutMs: 8000,
  maxChars: 700,
  maxSnippets: 2,
});

// English user beat: Colombia geography + English topic keywords. Sources are
// the Spanish outlets so the legacy outlet-match source selection admits them.
const SPANISH_PERSONA = Object.freeze({
  topics: [],
  keywords: ["migration", "elections", "security"],
  geographies: ["Colombia"],
  traditionalSources: ["La Silla Vacía", "Semana", "Infobae"],
  socialSources: [],
});

// ─── Deterministic ES→EN translation stub ────────────────────────────────────
//
// Whole-word replacement of the Spanish terms that map to the English user
// keywords. Leaves the rest of the sentence untouched — recall only needs the
// English keyword to surface as a whole word in the normalized text.
const ES_EN_REPLACEMENTS = [
  [/migraci[oó]n/gi, "migration"],
  [/elecciones/gi, "elections"],
  [/seguridad/gi, "security"],
];

function translateSegment(s) {
  return ES_EN_REPLACEMENTS.reduce((acc, [re, en]) => acc.replace(re, en), String(s ?? ""));
}

// Batch segment translator matching the evidence-translator contract.
function makeSpanishTranslateFn({ failSourceIds = [] } = {}) {
  const failSet = new Set(failSourceIds);
  return async (segments, { sourceId } = {}) => {
    if (failSet.has(sourceId)) {
      throw new Error(`simulated translation failure for ${sourceId}`);
    }
    return segments.map(translateSegment);
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Scenario 1+2 items: Spanish text that mentions NO configured geography
// literally (so the geo lexical recall gate cannot admit them) and carries an
// empty topic (so the topic gate cannot admit them). `geographies: []` (implicit)
// makes them pass the geo *filter* via the assessor (mock 0.85 >= implicit
// threshold) so they reach recall — the ONLY way they then clear recall is via
// the translated English keyword. This isolates the translation effect.
//
// A1.2: deliberately IMPLICIT geo, not explicit `["Colombia"]`. An explicit-geo
// item from a selected source is a must-see Lane 1 item that survives recall by
// design — it would reach clustering even untranslated, masking the very gap
// this scenario proves. Implicit geo keeps these items non-must-see so recall
// (the translation gate) is the only thing deciding admission.
function recallItems() {
  const base = { kind: "traditional", weight: 70, minutesAgo: 30, lang: "es", topic: "", geographies: [] };
  return [
    {
      ...base,
      sourceId: "es-mig-1",
      outlet: "La Silla Vacía",
      url: "https://example.com/news/es-mig-1",
      headline: "La migración crece en la frontera norte",
      body: ["Las autoridades reportan un aumento sostenido de la migración esta semana."],
    },
    {
      ...base,
      sourceId: "es-elec-2",
      outlet: "Semana",
      url: "https://example.com/news/es-elec-2",
      headline: "Las elecciones regionales se acercan",
      body: ["Los candidatos cierran sus campañas antes de las elecciones del próximo mes."],
    },
    {
      ...base,
      sourceId: "es-seg-3",
      outlet: "Infobae",
      url: "https://example.com/news/es-seg-3",
      headline: "Crece la preocupación por la seguridad",
      body: ["El gobierno anuncia nuevas medidas de seguridad en la región."],
    },
  ];
}

// Scenario 3 items: Spanish text that DOES mention "Colombia" literally, so the
// geo lexical gate admits them to clustering regardless of whether translation
// succeeded. Translation fails for two of three (fail-open) — those reach
// clustering untranslated, dragging the story's translated-source coverage
// below the 60% threshold.
function degradedItems() {
  const base = { kind: "traditional", weight: 70, minutesAgo: 20, lang: "es", topic: "", geographies: ["Colombia"] };
  return [
    {
      ...base,
      sourceId: "es-deg-ok",
      outlet: "La Silla Vacía",
      url: "https://example.com/news/es-deg-ok",
      headline: "Colombia debate la migración en la frontera",
      body: ["El congreso de Colombia discute la política de migración."],
    },
    {
      ...base,
      sourceId: "es-deg-fail-1",
      outlet: "Semana",
      url: "https://example.com/news/es-deg-fail-1",
      headline: "Colombia avanza en materia de seguridad",
      body: ["Nuevas medidas de seguridad en Colombia."],
    },
    {
      ...base,
      sourceId: "es-deg-fail-2",
      outlet: "Infobae",
      url: "https://example.com/news/es-deg-fail-2",
      headline: "Colombia prepara las elecciones",
      body: ["El calendario de elecciones en Colombia."],
    },
  ];
}

// ─── Cluster stubs ───────────────────────────────────────────────────────────

// Records exactly what reached the cluster stage; returns no clusters.
function captureClusterFn(capture) {
  return (items) => {
    capture.input = items;
    return Promise.resolve([]);
  };
}

// One grounded meta-story from everything that reached clustering.
function singleGroundedClusterFn(id, title) {
  return (items) => {
    if (!items || items.length === 0) return Promise.resolve([]);
    const sourceIds = items.map((i) => i.sourceId);
    return Promise.resolve([
      {
        meta_story_id: id,
        title,
        subtitle: "Composed from grounded sources.",
        source_item_ids: sourceIds,
        summary: `${title}.`,
        tags: {
          topics: [],
          keywords: [],
          geographies: [...new Set(items.flatMap((i) => i.geographies ?? []))],
        },
        factual_claims: ["A claim grounded in the cited sources."],
        claim_evidence_map: { "0": sourceIds },
      },
    ]);
  };
}

// ─── Scenario runners ─────────────────────────────────────────────────────────

async function scenarioBaselineNoTranslation() {
  const capture = { input: null };
  const { log } = await runRefreshPipeline({
    settings: SPANISH_PERSONA,
    rawItems: recallItems(),
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
    // Translation OFF — Spanish keywords never match the English settings.
    translationConfig: TRANSLATION_DISABLED,
  });

  const reasons = [];
  const reached = (capture.input ?? []).map((i) => i.sourceId);
  if (reached.length !== 0) {
    reasons.push(`expected 0 items to reach clustering without translation, got ${reached.length} [${reached.join(", ")}]`);
  }
  if ((log?.recall?.finalRelevant ?? -1) !== 0) {
    reasons.push(`expected recall.finalRelevant=0 without translation, got ${log?.recall?.finalRelevant}`);
  }
  if (log?.translation?.mode !== "off") {
    reasons.push(`expected translation.mode=off, got ${log?.translation?.mode}`);
  }
  return { ok: reasons.length === 0, reasons, diagnostics: { reached, finalRelevant: log?.recall?.finalRelevant } };
}

async function scenarioTranslatedRecall() {
  const capture = { input: null };
  const { log: captureLog } = await runRefreshPipeline({
    settings: SPANISH_PERSONA,
    rawItems: recallItems(),
    clusterFn: captureClusterFn(capture),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
    translationConfig: TRANSLATION_ENABLED,
    translateFn: makeSpanishTranslateFn(),
  });

  // Second run produces an actual grounded story so we assert end-to-end
  // admission, not just the pre-cluster capture.
  const { payload, log } = await runRefreshPipeline({
    settings: SPANISH_PERSONA,
    rawItems: recallItems(),
    clusterFn: singleGroundedClusterFn("es-recall-ms-1", "Colombia: migration, elections, security in focus"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
    translationConfig: TRANSLATION_ENABLED,
    translateFn: makeSpanishTranslateFn(),
  });

  const reasons = [];
  const reached = (capture.input ?? []).map((i) => i.sourceId).sort();
  const expected = ["es-elec-2", "es-mig-1", "es-seg-3"];
  if (JSON.stringify(reached) !== JSON.stringify(expected)) {
    reasons.push(`expected all 3 Spanish items to reach clustering via normalized EN, got [${reached.join(", ")}]`);
  }
  // Dual-text retention: originals untouched, normalized English present.
  const sample = (capture.input ?? []).find((i) => i.sourceId === "es-mig-1");
  if (!sample || !/migraci[oó]n/i.test(sample.headline)) {
    reasons.push("original Spanish headline must be retained on the source item");
  }
  if (!sample || !/migration/i.test(sample.normalizedHeadline ?? "")) {
    reasons.push("normalized English headline (normalizedHeadline) must be present");
  }
  const stories = payload?.stories ?? [];
  if (stories.length !== 1) reasons.push(`expected 1 grounded story, got ${stories.length}`);
  if ((captureLog?.translation?.translatedCount ?? 0) !== 3) {
    reasons.push(`expected translatedCount=3, got ${captureLog?.translation?.translatedCount}`);
  }
  // The shipped story is full-confidence (all sources translated/covered).
  const cov = log?.translation?.stories?.["es-recall-ms-1"];
  if (!cov || cov.degraded !== false || cov.coverage !== 1) {
    reasons.push(`expected full-confidence coverage for the story, got ${JSON.stringify(cov)}`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: {
      reached,
      normalizedHeadline: sample?.normalizedHeadline,
      originalHeadline: sample?.headline,
      storyCount: stories.length,
      coverage: cov,
    },
  };
}

async function scenarioDegradedPartialFailure() {
  const { payload, log } = await runRefreshPipeline({
    settings: SPANISH_PERSONA,
    rawItems: degradedItems(),
    clusterFn: singleGroundedClusterFn("es-degraded-ms-1", "Colombia roundup"),
    clusterModel: "mock-anthropic-haiku",
    contractVersion: CONTRACT_VERSION,
    recallConfig: KEYWORD_RECALL,
    beatFitEnabled: false,
    translationConfig: TRANSLATION_ENABLED,
    translateFn: makeSpanishTranslateFn({ failSourceIds: ["es-deg-fail-1", "es-deg-fail-2"] }),
  });

  const reasons = [];
  const stories = payload?.stories ?? [];
  // Refresh COMPLETES despite partial translation failure (no hard block).
  if (stories.length !== 1) {
    reasons.push(`degraded refresh must still complete with the subset, got ${stories.length} stories`);
  }
  const tr = log?.translation;
  if ((tr?.failedCount ?? 0) !== 2) reasons.push(`expected failedCount=2, got ${tr?.failedCount}`);
  if ((tr?.translatedCount ?? 0) !== 1) reasons.push(`expected translatedCount=1, got ${tr?.translatedCount}`);
  if ((tr?.neededCount ?? 0) !== 3) reasons.push(`expected neededCount=3, got ${tr?.neededCount}`);
  // The story carries an explicit low-confidence/degraded marker in _meta.
  const cov = tr?.stories?.["es-degraded-ms-1"];
  if (!cov) {
    reasons.push("expected per-story coverage entry in _meta.translation.stories");
  } else {
    if (cov.degraded !== true) reasons.push(`expected story degraded=true, got ${cov.degraded}`);
    if (cov.confidence !== "low") reasons.push(`expected story confidence="low", got ${cov.confidence}`);
    if (!(cov.coverage < 0.6)) reasons.push(`expected story coverage < 0.6, got ${cov.coverage}`);
  }
  if ((tr?.degraded?.storyCount ?? 0) !== 1) {
    reasons.push(`expected 1 degraded story in run summary, got ${tr?.degraded?.storyCount}`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    diagnostics: {
      storyCount: stories.length,
      failedCount: tr?.failedCount,
      translatedCount: tr?.translatedCount,
      coverage: cov,
      degradedFallbackRate: tr?.degradedFallbackRate,
    },
  };
}

// ─── Scenario registry ─────────────────────────────────────────────────────────

const SCENARIO_DEFS = Object.freeze([
  { id: "es-01-baseline-no-translation", intent: "Spanish items + English settings, translation OFF → recall empty (proves the gap)", run: scenarioBaselineNoTranslation },
  { id: "es-02-translated-recall", intent: "Translation ON → all Spanish items reach clustering via normalized EN; grounded story ships full-confidence", run: scenarioTranslatedRecall },
  { id: "es-03-degraded-partial-failure", intent: "Partial translation failure → refresh completes with subset; story marked low-confidence/degraded in _meta", run: scenarioDegradedPartialFailure },
]);

export const SPANISH_RECALL_SCENARIO_IDS = Object.freeze(SCENARIO_DEFS.map((d) => d.id));

/** Run all Spanish-recall scenarios. Pure: no console, no exits. */
export async function runDashboardSpanishRecall() {
  const results = [];
  for (const def of SCENARIO_DEFS) {
    let outcome;
    try {
      outcome = await def.run();
    } catch (err) {
      outcome = { ok: false, reasons: [`scenario threw: ${err instanceof Error ? err.message : String(err)}`], diagnostics: { error: true } };
    }
    results.push({ id: def.id, intent: def.intent, ok: outcome.ok, reasons: outcome.reasons ?? [], diagnostics: outcome.diagnostics ?? {} });
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    results,
    summary: { total: results.length, passed, failed: results.length - passed, hardFail: results.some((r) => !r.ok) },
  };
}
