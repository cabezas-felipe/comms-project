// Phase 3 — deterministic meta-story tag assignment.
//
// Replaces the source-only `deriveStoryTags` helper as the production tag
// emitter for shipped stories.  Compared to the Phase 1/2 behavior, this
// module:
//
//   1. Operates on the **meta-story evidence bundle** (title + subtitle +
//      summary + source headline/body) instead of source structural fields
//      alone — a meta-story whose source `topic` is weak can still surface a
//      canonical topic when the narrative text supports it.
//   2. Applies a **deterministic geography alias map** (Beijing → China,
//      Montevideo → Latin America, …) gated on `settings.geographies`.
//   3. Stays strictly inside the **settings vocabulary** — output values are
//      always the canonical setting string (preserving the user's casing),
//      never the alias surface form, and never a fabricated value.
//
// Phase 3 keeps keyword matching **deterministic** (whole-word phrase match
// only).  Semantic keyword aliasing (e.g. "petroleum" → "oil") is explicitly
// deferred to Phase 4 — the assigner does NOT consult any synonym/embedding
// step for keywords here.  Phase 4 will introduce a constrained semantic
// mapper that still gates on settings; until then, "petroleum" in text with
// "oil" in settings yields no keyword tag.
//
// One-way invariant (Chunk K — K1a) still holds: tags **explain** a card.
// They do not widen the candidate pool, recall, clustering, or dedupe.  The
// only behavioral change from Phase 1/2 is *how* tags are populated for the
// shipped payload.

import {
  GEOGRAPHY_ALIASES,
  normalizeTopicLabel,
  resolveGeographyAlias,
} from "@tempo/contracts";

// Precomputed alias entries for the per-story matching loop.  Tiny map
// (low tens of entries in v1), pre-frozen at module load — no per-call work.
const ALIAS_ENTRIES = Object.entries(GEOGRAPHY_ALIASES);

// Regex-escape characters with RegExp metacharacter meaning.  Mirrors the
// helper in refresh-pipeline.mjs so phrase matching here behaves identically
// to the lexical recall stage (same word-boundary semantics, same handling of
// multi-word phrases like "border policy").
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word, case-insensitive phrase match.  Multi-word phrases match as a
// contiguous run of tokens — consistent with `buildKeywordTokenRegex` in the
// pipeline.  Substring matches inside a larger word ("ofacility" vs "OFAC")
// are deliberately excluded via the `\b` anchors.
function phraseAppearsInText(phrase, text) {
  if (typeof phrase !== "string" || typeof text !== "string") return false;
  const trimmed = phrase.trim();
  if (!trimmed || !text) return false;
  const re = new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i");
  return re.test(text);
}

function sanitizeStringList(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function sortAlphaLocale(arr) {
  return arr.slice().sort((a, b) => a.localeCompare(b));
}

function dedupePreserveOrder(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Build the text bundle that drives phrase matching for Phase 3 tag assignment.
 *
 * Includes (in order, newline-separated):
 *   - meta-story `title`, `subtitle`, `summary`
 *   - each source's `headline` and `body` (body joined by space when it is the
 *     usual paragraph array shape; passed through when it is already a string)
 *
 * Missing or non-string fields are silently skipped — the assigner is
 * defensive against the legacy cluster output shape and against partial
 * source records (e.g. minimal fixtures).  Source-level structural fields
 * (`source.topic`, `source.geographies`) are NOT included in the text bundle;
 * they are consulted separately by `assignMetaStoryTags` as canonical
 * evidence on their respective axes.
 */
export function buildMetaStoryEvidenceText(metaStory, sourceItems) {
  const parts = [];
  const ms = metaStory && typeof metaStory === "object" ? metaStory : {};
  if (typeof ms.title === "string") parts.push(ms.title);
  if (typeof ms.subtitle === "string") parts.push(ms.subtitle);
  if (typeof ms.summary === "string") parts.push(ms.summary);
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (typeof it.headline === "string") parts.push(it.headline);
    if (Array.isArray(it.body)) {
      parts.push(it.body.filter((p) => typeof p === "string").join(" "));
    } else if (typeof it.body === "string") {
      parts.push(it.body);
    }
  }
  return parts.join("\n");
}

// ─── Topics ──────────────────────────────────────────────────────────────────
//
// Topic evidence is the union of:
//   (a) phrase match of each `settings.topics` value against the evidence
//       bundle (case-insensitive, whole-word);
//   (b) structural `source.topic` field on each source item, normalized via
//       `normalizeTopicLabel` (synonym map → canonical) and matched against
//       settings vocabulary case-insensitively.
//
// (b) is what preserves Phase 1/2 behavior for fixtures whose summary text
// is generic ("Summary.") but whose source items carry a canonical topic on
// the structural field.  Output uses the settings string spelling.

function assignTopics(evidenceText, sourceItems, settingsTopics) {
  if (settingsTopics.length === 0) return [];
  const settingsByCanonical = new Map();
  for (const t of settingsTopics) {
    settingsByCanonical.set(normalizeTopicLabel(t).toLowerCase(), t);
    settingsByCanonical.set(t.toLowerCase(), t);
  }
  const out = [];
  // (a) phrase match in evidence text — surface canonical form per settings
  for (const t of settingsTopics) {
    if (phraseAppearsInText(t, evidenceText)) out.push(t);
  }
  // (b) structural `source.topic` (with synonym normalization)
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  for (const it of items) {
    const raw = typeof it?.topic === "string" ? it.topic.trim() : "";
    if (!raw) continue;
    const normKey = normalizeTopicLabel(raw).toLowerCase();
    const canonical =
      settingsByCanonical.get(normKey) ?? settingsByCanonical.get(raw.toLowerCase());
    if (canonical) out.push(canonical);
  }
  return sortAlphaLocale(dedupePreserveOrder(out));
}

// ─── Keywords (deterministic only — Phase 3) ─────────────────────────────────
//
// Whole-word phrase match of each `settings.keywords` entry against the
// evidence bundle.  No semantic widening — "petroleum" in the bundle plus
// "oil" in settings yields no tag in this phase (regression-covered to lock
// the Phase 3/4 split).

function assignKeywords(evidenceText, settingsKeywords) {
  if (settingsKeywords.length === 0 || !evidenceText) return [];
  const out = [];
  for (const k of settingsKeywords) {
    if (phraseAppearsInText(k, evidenceText)) out.push(k);
  }
  return sortAlphaLocale(dedupePreserveOrder(out));
}

// ─── Geographies ─────────────────────────────────────────────────────────────
//
// Geography evidence is the union of:
//   (a) direct phrase match of each `settings.geographies` value in evidence
//       text (case-insensitive, whole-word);
//   (b) structural `source.geographies` arrays intersected with settings;
//   (c) deterministic alias hits — for each known alias whose canonical
//       target is opted into via `settings.geographies`, emit the canonical
//       settings entry when the alias surface form appears in the bundle.
//
// (c) is the new Phase 3 capability.  The alias map and settings gate live in
// `@tempo/contracts/src/geography-aliases.ts` so both server and tests share
// a single source of truth.

function assignGeographies(evidenceText, sourceItems, settingsGeographies) {
  if (settingsGeographies.length === 0) return [];
  const settingsLookup = new Map(
    settingsGeographies.map((g) => [g.trim().toLowerCase(), g])
  );
  const out = [];
  // (a) direct phrase match in evidence text
  for (const g of settingsGeographies) {
    if (phraseAppearsInText(g, evidenceText)) out.push(g);
  }
  // (b) structural source.geographies → settings intersection
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  for (const it of items) {
    const geos = Array.isArray(it?.geographies) ? it.geographies : [];
    for (const g of geos) {
      if (typeof g !== "string") continue;
      const canonical = settingsLookup.get(g.trim().toLowerCase());
      if (canonical) out.push(canonical);
    }
  }
  // (c) deterministic alias hits — gated on settings vocabulary
  if (evidenceText) {
    for (const [aliasLower] of ALIAS_ENTRIES) {
      if (!phraseAppearsInText(aliasLower, evidenceText)) continue;
      const canonical = resolveGeographyAlias(aliasLower, settingsGeographies);
      if (canonical) out.push(canonical);
    }
  }
  return sortAlphaLocale(dedupePreserveOrder(out));
}

/**
 * Phase 3 entry point: derive the three-axis `tags` object for a shipped
 * story from the meta-story evidence bundle, source structural fields, and
 * settings vocabulary.  Returns a fresh `{ topics, keywords, geographies }`
 * shape with each axis deduped and locale-sorted; never mutates inputs.
 *
 * Strictness contract (Phase 1/2 carry-over):
 *   - Empty arrays are valid — "no evidence on this axis" must NOT become a
 *     fabricated placeholder.
 *   - All emitted values are members of the corresponding `settings.*` list
 *     (canonical settings casing preserved).
 *
 * Phase 3 additions:
 *   - Geography alias map (e.g. Beijing → China) when the canonical target
 *     is in `settings.geographies`.
 *   - Topic/keyword/geography matching against the evidence text bundle in
 *     addition to source structural fields.
 *
 * Phase 4 (deferred): semantic keyword aliasing.  Until that lands, keyword
 * matching here is deterministic whole-word only.
 */
export function assignMetaStoryTags({ metaStory, sourceItems, settings }) {
  const evidenceText = buildMetaStoryEvidenceText(metaStory, sourceItems);
  const settingsTopics = sanitizeStringList(settings?.topics);
  const settingsKeywords = sanitizeStringList(settings?.keywords);
  const settingsGeographies = sanitizeStringList(settings?.geographies);
  return {
    topics: assignTopics(evidenceText, sourceItems, settingsTopics),
    keywords: assignKeywords(evidenceText, settingsKeywords),
    geographies: assignGeographies(evidenceText, sourceItems, settingsGeographies),
  };
}
