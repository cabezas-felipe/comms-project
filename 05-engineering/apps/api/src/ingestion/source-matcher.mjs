// User-specific source matching module.
//
// Resolves the user's selected source names (from settings.traditionalSources +
// settings.socialSources) against the ingestion manifest, applying:
//   1. Alias mapping (canonical aliases from Supabase registry when available;
//      otherwise repo's SOURCE_NAME_ALIASES from @tempo/contracts).
//   2. Normalization (lowercase, drop "the ", strip punctuation, collapse spaces).
//   3. Substring matching against normalized feed names — so a publisher-level
//      selection like "Washington Post" matches every section feed (Politics,
//      World, Business, ...) in the manifest.
//   4. Connector availability filtering — only feeds whose `kind` has an
//      implemented connector (currently `rss`) are eligible.  Selected sources
//      that match the manifest but only via unimplemented connectors are
//      reported as `unavailableConnectorCount`.
//
// Returns rich selection metadata so the route handler can surface it through
// `_meta.selection` for telemetry + frontend status cues.

import { SOURCE_NAME_ALIASES } from "@tempo/contracts";

// Connector kinds that have an implemented ingestion path.  Extend this set
// when new connectors land (e.g. social scraping in Phase 4).
const IMPLEMENTED_CONNECTOR_KINDS = new Set(["rss"]);

export const FALLBACK_REASON = Object.freeze({
  NO_SELECTED_SOURCES: "no_selected_sources",
  ALL_UNMATCHED: "all_unmatched",
  ALL_UNAVAILABLE_CONNECTORS: "all_unavailable_connectors",
  FALLBACK_DISABLED: "fallback_disabled",
});

export const SELECTION_MODE = Object.freeze({
  STRICT: "strict",
  FALLBACK: "fallback",
});

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize a source name for matching:
 *   - lowercase
 *   - drop a leading "the "
 *   - replace dashes and other punctuation with spaces
 *   - collapse runs of whitespace to single spaces
 *   - trim
 *
 * Goal is to make publisher-level intent ("Washington Post") substring-match
 * against section-level feed names ("The Washington Post — Politics").
 */
export function normalizeForMatching(name) {
  if (name == null) return "";
  return String(name)
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/[—–\-_/]/g, " ")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Apply alias map to a raw name (case-insensitive lookup), then normalize.
 * Aliases are merged "supabase canonical" + "repo fallback" (Supabase wins on
 * conflict — see resolveSelectedSources).
 */
export function aliasAndNormalize(name, aliasMap = SOURCE_NAME_ALIASES) {
  if (name == null) return "";
  const lower = String(name).trim().toLowerCase();
  const canonical = aliasMap[lower] ?? name;
  return normalizeForMatching(canonical);
}

// ─── Manifest preprocessing ──────────────────────────────────────────────────

function indexManifest(manifestFeeds) {
  return (manifestFeeds ?? [])
    .filter((f) => f && typeof f === "object")
    .map((f) => ({
      feed: f,
      normalized: normalizeForMatching(f.name ?? f.id ?? ""),
    }));
}

function feedHasImplementedConnector(feed) {
  return IMPLEMENTED_CONNECTOR_KINDS.has(feed?.kind);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} ResolveOpts
 * @property {string[]} selectedSources              — user-selected names (traditional + social)
 * @property {Array}    manifestFeeds                — feeds from manifest (Supabase or file)
 * @property {Record<string,string>} [aliasMap]      — merged alias map (Supabase ∪ repo fallback)
 * @property {string[]} [fallbackFeedIds]            — env-configured fallback feed IDs
 * @property {boolean}  [fallbackEnabled]            — env-configured fallback toggle
 *
 * @typedef {object} SelectionResult
 * @property {"strict"|"fallback"} mode
 * @property {Array}    matchedFeeds                  — manifest feeds the run will ingest
 * @property {number}   matchedSourceCount            — distinct user sources that matched ≥1 feed
 * @property {number}   selectedSourceCount
 * @property {string[]} unmatchedSelectedSources      — user names that matched zero manifest rows
 * @property {number}   unavailableConnectorCount     — user names matched but only via unimplemented connector
 * @property {string[]} unavailableConnectorSources   — list of those names
 * @property {boolean}  fallbackUsed
 * @property {string|null} fallbackReason
 *
 * @param {ResolveOpts} opts
 * @returns {SelectionResult}
 */
export function resolveSelectedSources(opts) {
  const {
    selectedSources = [],
    manifestFeeds = [],
    aliasMap = SOURCE_NAME_ALIASES,
    fallbackFeedIds = [],
    fallbackEnabled = true,
  } = opts ?? {};

  const indexed = indexManifest(manifestFeeds);
  const matchedFeedById = new Map(); // feedId → feed
  const unmatched = [];
  const unavailable = [];

  // Distinct, trimmed selected names (preserve original casing for reporting).
  const selectedClean = (selectedSources ?? [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  const seenLower = new Set();
  const uniqueSelected = [];
  for (const s of selectedClean) {
    const k = s.toLowerCase();
    if (!seenLower.has(k)) {
      seenLower.add(k);
      uniqueSelected.push(s);
    }
  }

  for (const name of uniqueSelected) {
    const needle = aliasAndNormalize(name, aliasMap);
    if (!needle) {
      unmatched.push(name);
      continue;
    }
    const allMatches = indexed.filter(({ normalized }) => normalized.includes(needle));
    if (allMatches.length === 0) {
      unmatched.push(name);
      continue;
    }
    const availableMatches = allMatches.filter(({ feed }) => feedHasImplementedConnector(feed));
    if (availableMatches.length === 0) {
      unavailable.push(name);
      continue;
    }
    for (const { feed } of availableMatches) {
      const id = feed.id ?? feed.name ?? "";
      if (id && !matchedFeedById.has(id)) matchedFeedById.set(id, feed);
    }
  }

  const matchedFeeds = [...matchedFeedById.values()];
  const matchedSourceCount = uniqueSelected.length - unmatched.length - unavailable.length;

  // Strict path: at least one source matched an available connector.
  if (matchedFeeds.length > 0) {
    return {
      mode: SELECTION_MODE.STRICT,
      matchedFeeds,
      matchedSourceCount,
      selectedSourceCount: uniqueSelected.length,
      unmatchedSelectedSources: unmatched,
      unavailableConnectorCount: unavailable.length,
      unavailableConnectorSources: unavailable,
      fallbackUsed: false,
      fallbackReason: null,
    };
  }

  // Fallback path: pick a reason that captures *why* strict was empty.
  let reason;
  if (uniqueSelected.length === 0) reason = FALLBACK_REASON.NO_SELECTED_SOURCES;
  else if (unavailable.length > 0 && unmatched.length === 0)
    reason = FALLBACK_REASON.ALL_UNAVAILABLE_CONNECTORS;
  else reason = FALLBACK_REASON.ALL_UNMATCHED;

  // Honor the toggle: if disabled, return empty matched set (strict empty).
  if (!fallbackEnabled) {
    return {
      mode: SELECTION_MODE.STRICT,
      matchedFeeds: [],
      matchedSourceCount,
      selectedSourceCount: uniqueSelected.length,
      unmatchedSelectedSources: unmatched,
      unavailableConnectorCount: unavailable.length,
      unavailableConnectorSources: unavailable,
      fallbackUsed: false,
      fallbackReason: FALLBACK_REASON.FALLBACK_DISABLED,
    };
  }

  const fallbackSet = new Set(fallbackFeedIds.map(String));
  const fallbackFeeds = (manifestFeeds ?? []).filter(
    (f) => f && fallbackSet.has(String(f.id)) && feedHasImplementedConnector(f)
  );

  return {
    mode: SELECTION_MODE.FALLBACK,
    matchedFeeds: fallbackFeeds,
    matchedSourceCount,
    selectedSourceCount: uniqueSelected.length,
    unmatchedSelectedSources: unmatched,
    unavailableConnectorCount: unavailable.length,
    unavailableConnectorSources: unavailable,
    fallbackUsed: true,
    fallbackReason: reason,
  };
}

// ─── Env config helpers (route-handler glue) ─────────────────────────────────

/**
 * Parse `TEMPO_FALLBACK_SOURCE_IDS` (comma-separated feed IDs).
 * Returns [] when unset.  Whitespace tolerated; empty entries dropped.
 */
export function parseFallbackFeedIdsEnv(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `TEMPO_FALLBACK_ENABLED` defaults to true; explicit `"false"` disables.
 */
export function parseFallbackEnabledEnv(raw) {
  if (raw == null) return true;
  return String(raw).toLowerCase() !== "false";
}

// ─── Outlet → matched-feed filter (used in pipeline) ─────────────────────────

/**
 * Build a Set of normalized outlet names corresponding to matched feeds.
 * Items in the candidate pool whose `outlet` (normalized) is in this set are
 * considered "in pool" for the user's selection.
 */
export function buildMatchedOutletSet(matchedFeeds) {
  const set = new Set();
  for (const f of matchedFeeds ?? []) {
    if (f?.name) set.add(normalizeForMatching(f.name));
  }
  return set;
}

/**
 * Filter normalized items down to those whose outlet matches one of the
 * selected feeds (by normalized name).  Bidirectional substring match — so a
 * fixture item with outlet "Reuters" matches a manifest feed named
 * "Reuters — World News" (feed contains item) AND a live RSS item with
 * outlet "Reuters — World News" matches a publisher selection that resolved
 * to that same feed (item contains feed string after normalization).
 *
 * When `matchedOutlets` is empty, returns an empty array (caller should
 * distinguish "strict empty" from "no selection").
 */
export function filterItemsToMatchedFeeds(items, matchedOutlets) {
  if (!matchedOutlets || matchedOutlets.size === 0) return [];
  return items.filter((it) => {
    const itemNorm = normalizeForMatching(it.outlet);
    if (!itemNorm) return false;
    for (const feedNorm of matchedOutlets) {
      if (feedNorm === itemNorm) return true;
      if (feedNorm.includes(itemNorm) || itemNorm.includes(feedNorm)) return true;
    }
    return false;
  });
}
