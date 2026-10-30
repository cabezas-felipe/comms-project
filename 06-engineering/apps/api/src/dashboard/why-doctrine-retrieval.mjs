// Why-this-matters doctrine retrieval (MVP).
// Spec: docs/why-this-matters-spec.md §5; strategy §3a-§3b.
//
// Pure / sync.  Reads the hand-curated JSON allowlist (`doctrine-snippets.v0.json`)
// once at module load and exposes `retrieveDoctrineSnippetsForStory` for the
// Phase 5 pipeline loop to call per shipped story.  Never throws — any
// malformed input or runtime error resolves to `[]`, so the implications
// writer always sees a valid (possibly empty) snippets array.
//
// Matching rules (locked, spec §5):
//   1. Primary gate (eligibility): snippet survives if
//        story topic set overlaps snippet.topics, OR
//        story geography set overlaps snippet.geographies.
//   2. Secondary narrow: if story has keywords, prefer snippets with
//        >= 1 keyword overlap.  Implemented as a soft rank boost — the
//        primary ranking key — so keyword-light snippets stay eligible
//        when nothing else matches.
//   3. Ranking (desc unless noted):
//        a. keyword overlap count
//        b. geography overlap count
//        c. stateVariant match (1 when snippet.stateVariant === state, else 0)
//        d. id asc — deterministic tie-break so the same story always
//                    returns the same snippets across refreshes.
//   4. Cap: top 0..maxSnippets (default 3).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOCTRINE_CORPUS_PATH = path.resolve(__dirname, "doctrine-snippets.v0.json");

// Load the JSON allowlist at import time.  A malformed / missing corpus
// fails closed to `[]` — retrieval then never matches anything and the
// writer proceeds without doctrine framing (spec §5 "retrieval error /
// timeout").  We log once on module load rather than per-call so a broken
// corpus is loud in startup logs but not noisy at runtime.
function loadCorpus() {
  try {
    const raw = readFileSync(DOCTRINE_CORPUS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const snippets = Array.isArray(parsed?.snippets) ? parsed.snippets : [];
    return snippets.filter((s) => s && typeof s === "object" && typeof s.id === "string");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[why-doctrine] corpus load failed: ${msg}; retrieval will return []`);
    return [];
  }
}

export const DEFAULT_SNIPPETS = Object.freeze(loadCorpus());

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectTopicsFromStory(story) {
  const out = new Set();
  if (typeof story?.topic === "string" && story.topic.length > 0) out.add(story.topic);
  for (const t of asArray(story?.tags?.topics)) {
    if (typeof t === "string" && t.length > 0) out.add(t);
  }
  return out;
}

function collectGeographiesFromStory(story) {
  const out = new Set();
  for (const g of asArray(story?.geographies)) {
    if (typeof g === "string" && g.length > 0) out.add(g);
  }
  for (const g of asArray(story?.tags?.geographies)) {
    if (typeof g === "string" && g.length > 0) out.add(g);
  }
  return out;
}

function collectKeywordsFromStory(story) {
  const out = new Set();
  for (const k of asArray(story?.tags?.keywords)) {
    if (typeof k === "string" && k.length > 0) out.add(k.toLowerCase());
  }
  return out;
}

function snippetTopics(snippet) {
  return asArray(snippet?.topics).filter((s) => typeof s === "string");
}

function snippetGeographies(snippet) {
  return asArray(snippet?.geographies).filter((s) => typeof s === "string");
}

function snippetKeywords(snippet) {
  return asArray(snippet?.keywords)
    .filter((s) => typeof s === "string")
    .map((s) => s.toLowerCase());
}

function overlapCount(setA, listB) {
  if (!setA || setA.size === 0) return 0;
  let n = 0;
  for (const v of listB) {
    if (setA.has(v)) n += 1;
  }
  return n;
}

function compareForRanking(a, b) {
  if (b.keywordOverlap !== a.keywordOverlap) return b.keywordOverlap - a.keywordOverlap;
  if (b.geographyOverlap !== a.geographyOverlap) return b.geographyOverlap - a.geographyOverlap;
  if (b.stateMatch !== a.stateMatch) return b.stateMatch - a.stateMatch;
  // Deterministic tie-break: lexicographic id ascending so the same story
  // always returns the same snippet set across refreshes.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Retrieve up to `maxSnippets` doctrine snippets for a story+state pair.
 *
 * Returns `[]` for any of:
 *   - falsy / non-object `story`
 *   - non-array / empty `snippets`
 *   - no snippet passes the primary gate
 *   - retrieval throws (caught internally; never rethrown)
 *
 * @param {{
 *   story: object,
 *   state?: "intro" | "steady" | "evolving" | string,
 *   maxSnippets?: number,
 *   snippets?: Array<object>,
 * }} input
 * @returns {Array<object>}  Sliced + ranked snippet array; never null/undefined.
 */
export function retrieveDoctrineSnippetsForStory({
  story,
  state,
  maxSnippets = 3,
  snippets = DEFAULT_SNIPPETS,
} = {}) {
  try {
    if (!story || typeof story !== "object") return [];
    const corpus = Array.isArray(snippets) ? snippets : [];
    if (corpus.length === 0) return [];
    const cap = Number.isInteger(maxSnippets) && maxSnippets > 0 ? maxSnippets : 3;

    const storyTopics = collectTopicsFromStory(story);
    const storyGeographies = collectGeographiesFromStory(story);
    const storyKeywords = collectKeywordsFromStory(story);

    const ranked = [];
    for (const snippet of corpus) {
      if (!snippet || typeof snippet !== "object" || typeof snippet.id !== "string") continue;
      const topics = snippetTopics(snippet);
      const geographies = snippetGeographies(snippet);
      const keywords = snippetKeywords(snippet);

      const topicOverlap = overlapCount(storyTopics, topics);
      const geographyOverlap = overlapCount(storyGeographies, geographies);
      // Primary gate (spec §5): topic OR geography overlap.  Snippets that
      // miss both are not eligible — no keyword-only retrieval, no
      // state-only retrieval.
      if (topicOverlap === 0 && geographyOverlap === 0) continue;

      const keywordOverlap = overlapCount(storyKeywords, keywords);
      const stateMatch =
        typeof snippet.stateVariant === "string" && snippet.stateVariant === state ? 1 : 0;

      ranked.push({
        id: snippet.id,
        snippet,
        geographyOverlap,
        keywordOverlap,
        stateMatch,
      });
    }

    ranked.sort(compareForRanking);
    return ranked.slice(0, cap).map((r) => r.snippet);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[why-doctrine] retrieval failed: ${msg}; fail-closed to []`);
    return [];
  }
}
