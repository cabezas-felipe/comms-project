// User-specific source matching module.
//
// Resolves the user's selected source names (from settings.traditionalSources +
// settings.socialSources) against the ingestion manifest, applying:
//   1. Alias mapping (canonical aliases from Supabase registry when available;
//      otherwise repo's SOURCE_NAME_ALIASES from ../contracts-runtime).
//   2. Normalization (lowercase, drop "the ", strip punctuation, collapse spaces).
//   3. Substring matching against normalized feed names AND the feed's curated
//      `publisher` brand — so a publisher-level selection like "Washington Post"
//      matches every section feed (Politics, World, Business, ...) in the
//      manifest.  Most feed names already embed the publisher ("The Washington
//      Post — Politics"), but a section-only name that omits it ("Silla
//      Nacional", publisher "La Silla Vacía") would otherwise never resolve
//      from a publisher-level selection.  Matching the curated `publisher` field
//      closes that gap; it is strict curated-field matching, NOT fuzzy widening.
//   4. Connector availability filtering — only feeds whose `kind` has an
//      implemented connector (currently `rss`) are eligible.  Selected sources
//      that match the manifest but only via unimplemented connectors are
//      reported as `unavailableConnectorCount`.
//
// Returns rich selection metadata so the route handler can surface it through
// `_meta.selection` for telemetry + frontend status cues.

import { SOURCE_NAME_ALIASES } from "../contracts-runtime/index.mjs";

// Connector kinds that have an implemented ingestion path.  `social` joined
// `rss` once the X ingestion path landed (Phase 1, Step 1.3 — handles are read
// via `x-reader.mjs` and merged into the refresh pool); extend this set when
// further connectors land.
const IMPLEMENTED_CONNECTOR_KINDS = new Set(["rss", "social"]);

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
      // Second, equally-strict match target: the curated `publisher` brand (see
      // header step 3 for why). Empty/absent → "" (never matches a non-empty needle).
      normalizedPublisher: f.publisher ? normalizeForMatching(f.publisher) : "",
    }));
}

function feedHasImplementedConnector(feed) {
  return IMPLEMENTED_CONNECTOR_KINDS.has(feed?.kind);
}

/**
 * Manifest rows with `active === false` are operator-disabled and must NOT
 * be treated as selectable matches.  Rows with `active` omitted (`undefined`)
 * stay eligible — older fixtures and tests don't carry the field, and
 * forcing it to `true` everywhere would be a breaking schema change for no
 * trust-bearing reason.  Only the explicit `false` flag disqualifies a row.
 */
function feedIsActive(feed) {
  return feed?.active !== false;
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
    // Strict substring match against either curated target (feed name or
    // publisher brand) — no fuzzy/approximate logic.
    const allMatches = indexed.filter(
      ({ normalized, normalizedPublisher }) =>
        normalized.includes(needle) ||
        (normalizedPublisher !== "" && normalizedPublisher.includes(needle))
    );
    if (allMatches.length === 0) {
      unmatched.push(name);
      continue;
    }
    // A match is "available" only when the connector is implemented AND the
    // feed is not operator-disabled.  We collapse both checks into one filter
    // so the existing `unavailable` bucket continues to capture both reasons
    // — adding a third bucket would force a schema change at every consumer
    // of `_meta.selection`.  In practice "inactive" is rare (a manual flag
    // flip) and operationally indistinguishable from "no connector" at the
    // selection layer; both mean "we cannot ingest from this row right now".
    const availableMatches = allMatches.filter(
      ({ feed }) => feedHasImplementedConnector(feed) && feedIsActive(feed)
    );
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
  // Fallback baseline must respect the same "active" gate as strict matching
  // — otherwise an operator who flipped a feed off via `active=false` would
  // still see it surface through the fallback path, defeating the kill switch.
  const fallbackFeeds = (manifestFeeds ?? []).filter(
    (f) => f && fallbackSet.has(String(f.id)) && feedHasImplementedConnector(f) && feedIsActive(f)
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
 *
 * When `f.name` is absent we fall back to `f.id` so the index stays in step
 * with `mapEntry`'s `feed.name ?? feed.id ?? "Unknown"` chain — otherwise a
 * Supabase row with `canonical_name=null` (rare but observed) would make
 * `mapEntry` emit items with `outlet=feed.id` that this set could never
 * contain, dropping a legitimate WaPo candidate at source-selection.
 */
export function buildMatchedOutletSet(matchedFeeds) {
  const set = new Set();
  for (const f of matchedFeeds ?? []) {
    const nameOrId = f?.name || f?.id;
    if (nameOrId) set.add(normalizeForMatching(nameOrId));
  }
  return set;
}

/**
 * Build a Set of feed-id strings for the matched feeds.  Pairs with
 * `buildMatchedOutletSet` so callers can match items by stable manifest id
 * (robust against outlet-name drift) AND fall back to outlet substring match
 * for legacy fixtures that don't carry a feedId.
 */
export function buildMatchedFeedIdSet(matchedFeeds) {
  const set = new Set();
  for (const f of matchedFeeds ?? []) {
    if (f?.id != null && String(f.id).length > 0) set.add(String(f.id));
  }
  return set;
}

// ─── Social handle selection (X ingestion — additive, non-manifest) ──────────
//
// User-selected X handles are NOT manifest feeds — `resolveSelectedSources`
// can't match them, so they would be dropped at source selection. These helpers
// build a normalized handle identity used to admit social raw items as a true
// UNION alongside manifest matching, WITHOUT minting synthetic `x:*` feed ids.

/**
 * Canonical social-handle identity: strip a leading `@`, trim, lowercase, then
 * re-prefix `@`.  `"@PetroGustavo"`, `" petrogustavo "`, `"PETROGUSTAVO"` all
 * collapse to `"@petrogustavo"`.  Returns `""` for nullish/blank/`@`-only input.
 */
export function normalizeSocialHandle(raw) {
  if (raw == null) return "";
  const username = String(raw).trim().replace(/^@+/, "").trim().toLowerCase();
  return username ? `@${username}` : "";
}

/**
 * Build a Set of canonical `@handle` identities from the user's selected social
 * sources.  Blank/invalid entries are dropped; the result is the social half of
 * the source-selection union.
 */
export function buildSelectedSocialHandleSet(socialSources) {
  const set = new Set();
  for (const s of socialSources ?? []) {
    const handle = normalizeSocialHandle(s);
    if (handle) set.add(handle);
  }
  return set;
}

// A raw item is "social" when its ingestion kind is the social connector kind.
// X reader emits `kind: "social"`; normalizeSourceItem preserves it verbatim.
function isSocialItem(item) {
  return item?.kind === "social";
}

/**
 * Filter normalized items down to those that belong to one of the selected
 * feeds.  Two layered match strategies, applied per item:
 *
 *   1. Stable feed-id match — when the item carries `feedId` (live RSS
 *      items, set by `mapEntry`), exact equality against `keys.feedIds`.
 *      This is the authoritative path: it survives any canonical-name drift
 *      between the matcher's manifest snapshot and the feed-reader's.
 *
 *   2. Bidirectional outlet substring match — fallback for fixture items
 *      that have no `feedId`.  Preserves the publisher-vs-section behavior
 *      from before this fix (outlet "Reuters" matches feed
 *      "Reuters — World News" and vice versa).
 *
 *   3. Social handle match — when `keys.socialHandles` is provided (X ingestion
 *      enabled for the run), a `kind:"social"` item whose normalized outlet
 *      handle is in the set passes.  This is the additive UNION that keeps
 *      user-selected X handles alive through source selection without ever
 *      contaminating the manifest feed-id index with synthetic `x:*` ids.
 *
 * Backward-compat: when `keys` is a plain `Set`, treats it as the outlet set
 * and uses the legacy outlet-only path verbatim.  Existing tests and
 * external callers that still pass `buildMatchedOutletSet(...)` keep working
 * unchanged.
 *
 * Strict-empty: when feed-id, outlet, AND social-handle sets are all empty (or
 * the legacy Set is empty), returns `[]` — caller distinguishes "strict empty"
 * from "no selection" via `selection.fallbackUsed` upstream.
 */
export function filterItemsToMatchedFeeds(items, keys) {
  // Legacy signature: a plain Set means outlet-only matching (older tests
  // and any external callers that pre-date the feed-id index).  Routing
  // through the same predicate keeps strict-empty + substring semantics
  // identical to the previous implementation.
  if (keys instanceof Set) {
    return _filterByOutletOnly(items, keys);
  }
  const feedIds = keys?.feedIds ?? null;
  const outlets = keys?.outlets ?? null;
  const socialHandles = keys?.socialHandles ?? null;
  const hasFeedIds = feedIds && feedIds.size > 0;
  const hasOutlets = outlets && outlets.size > 0;
  const hasSocial = socialHandles && socialHandles.size > 0;
  if (!hasFeedIds && !hasOutlets && !hasSocial) return [];
  // Pure union: an item passes if it satisfies ANY selected path.
  return items.filter((it) => {
    if (hasFeedIds && it?.feedId && feedIds.has(String(it.feedId))) return true;
    if (hasSocial && isSocialItem(it) && socialHandles.has(normalizeSocialHandle(it.outlet))) return true;
    if (hasOutlets && _itemOutletMatchesAny(it, outlets)) return true;
    return false;
  });
}

function _filterByOutletOnly(items, matchedOutlets) {
  if (!matchedOutlets || matchedOutlets.size === 0) return [];
  return items.filter((it) => _itemOutletMatchesAny(it, matchedOutlets));
}

function _itemOutletMatchesAny(item, outlets) {
  const itemNorm = normalizeForMatching(item?.outlet);
  if (!itemNorm) return false;
  for (const feedNorm of outlets) {
    if (feedNorm === itemNorm) return true;
    if (feedNorm.includes(itemNorm) || itemNorm.includes(feedNorm)) return true;
  }
  return false;
}
