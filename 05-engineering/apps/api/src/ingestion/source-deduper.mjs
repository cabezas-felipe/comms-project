// Cross-feed source-item deduplication.
//
// Why this stage exists:
//   The same article can be published into multiple RSS feeds (e.g. Washington
//   Post — National AND Washington Post — World).  feed-reader.mapEntry hashes
//   `${feed.id}::${guid|link}`, so the two surface as two distinct sourceItems.
//   Without dedupe, downstream sees two pieces of evidence where there is one
//   article, inflating story.sources.length, the "Top 5 of N" denominator in
//   the StoryCard, outletCount, and lineage Jaccard scores.
//
// Match policy (strict — favor avoiding false merges over maximizing merges):
//
//   With URL  : merge only when ALL three hold —
//                 (a) same canonicalized URL
//                 (b) same normalized headline (exact equality)
//                 (c) |Δ minutesAgo| ≤ PUBLISH_WINDOW_MINUTES
//   Without URL: merge only when normalized headlines are exactly equal.
//   Cross-publisher / cross-feed merges are permitted whenever the rules
//   above pass; outlet identity is NOT itself a gate.
//   Empty normalized headlines never merge (insufficient signal).
//
//   Canonical URL alone is NOT enough to merge — the same URL can be reused
//   for distinct articles (URL recycling) or returned across very different
//   publish times (republish years later).  Headline equality + publish-time
//   proximity guard against both failure modes.
//
// Provenance:
//   The canonical winner carries `_duplicates: [{ sourceId, feedId, outlet,
//   url, weight }]` for the losers.  `_duplicates` is internal-only —
//   `buildStory` projects an explicit field whitelist, so duplicate
//   provenance and the internal `_canonicalUrl` / `_normHeadline`
//   annotations are stripped before the response payload is assembled.

const TRACKING_PARAM_PREFIXES = ["utm_", "wt_", "mc_"];
const TRACKING_PARAM_EXACT = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "cmpid",
  "ref",
  "referer",
  "referrer",
  "spm",
  "yclid",
]);

/**
 * Publication-time window for the strict merge rule.
 *
 * Two items with the same canonical URL AND same normalized headline must
 * additionally lie within this many minutes of each other on `minutesAgo` to
 * be merged.  60 minutes is tight enough that legitimate cross-feed syndication
 * (observed in the same refresh tick — `minutesAgo` values within seconds of
 * each other) trivially passes, while same-URL items separated by hours (the
 * usual sign of a URL recycle or a long-after republish) stay distinct.
 *
 * Exported so callers / tests can compute "just inside" and "just outside"
 * fixtures without hard-coding the magic number.
 */
export const PUBLISH_WINDOW_MINUTES = 60;

function shouldDropParam(name) {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(lower)) return true;
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Canonicalize a URL string for cross-feed equality:
 *   - lowercase scheme + host
 *   - drop fragment
 *   - drop tracking query params (utm_*, fbclid, gclid, mc_*, _ga, …)
 *   - sort the surviving query keys for stable ordering
 *   - strip a single trailing slash on non-root paths
 *
 * Returns `null` when the input is missing, empty, or unparsable.  A `null`
 * canonical pushes the item onto the no-URL path: merge only on exact
 * normalized headline.
 */
export function canonicalizeUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  // Sort query keys in place
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !shouldDropParam(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.toString();
}

/**
 * Normalize a headline for cross-feed exact-equality matching:
 *   - lowercase (case-insensitive)
 *   - smart quotes / curly apostrophes → straight equivalents
 *   - strip all characters that are not Unicode letters, digits, or whitespace
 *   - collapse runs of whitespace to a single space
 *   - trim leading/trailing whitespace
 *
 * Returns "" when input is missing/empty/non-string.  An empty normalized
 * headline never merges with anything — without a confirming title we treat
 * the item as insufficient evidence and force it into a singleton group.
 *
 * The transform is intentionally lossless w.r.t. semantically-identical
 * headlines that differ only in punctuation (trailing periods, smart quotes,
 * em-dashes vs hyphens) — that's the equivalence class we want.  Variants
 * that differ by even one content word stay distinct.
 */
export function normalizeHeadline(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Liveblog / rolling-coverage prefix detector.
 *
 * Wire services and WaPo re-emit a single rolling story many times across a
 * day under a stable "Live updates: <subject>" headline (the subject stays put
 * while the body churns).  Each re-emission surfaces as a distinct sourceItem —
 * often with case drift ("LIVE UPDATES"), singular/plural ("Live update"), or
 * a changing URL — so the exact-headline cross-feed rule under-merges them.
 *
 * Matches: "Live updates: …", "Live update: …", "Live blog: …" (case-insensitive,
 * flexible inner whitespace).  WaPo "Quick Post" style live items can be added
 * to the alternation here as we observe them in feed data.
 */
const LIVEBLOG_PREFIX_RE = /^\s*live\s+(?:updates?|blog)\s*:\s*/i;

/**
 * Derive a liveblog merge key from a headline, or `null` when the headline is
 * not a liveblog item (or carries no subject after the marker).  The key is the
 * subject AFTER the live marker, run through `normalizeHeadline` so casing,
 * punctuation, and whitespace drift collapse to one identity.  Exported for
 * unit testing.
 */
export function extractLiveblogSubject(headline) {
  if (typeof headline !== "string") return null;
  const m = headline.match(LIVEBLOG_PREFIX_RE);
  if (!m) return null;
  const subject = normalizeHeadline(headline.slice(m[0].length));
  return subject.length > 0 ? subject : null;
}

/**
 * Publisher/domain bucket for liveblog grouping.  Subject alone is too coarse —
 * two different outlets running "Live updates: <same big story>" are distinct
 * rolling stories and must NOT collapse into one.  We scope the liveblog merge
 * to a single publisher:
 *   1. canonical URL present → bucket by hostname (most reliable identity);
 *   2. else → bucket by normalized outlet (lowercased, whitespace-collapsed);
 *   3. else (no URL host and no outlet) → a per-item bucket so two unknown
 *      publishers never merge on subject alone.
 *
 * `canonicalUrl` is the already-canonicalized string from `canonicalizeUrl`
 * (hostname lowercased), so re-parsing is cheap and stable.  Exported for unit
 * testing.
 */
export function liveblogBucket(canonicalUrl, outlet, fallbackId) {
  if (typeof canonicalUrl === "string" && canonicalUrl) {
    try {
      const host = new URL(canonicalUrl).hostname.toLowerCase();
      if (host) return `host:${host}`;
    } catch {
      /* fall through to outlet */
    }
  }
  const normOutlet =
    typeof outlet === "string" ? outlet.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (normOutlet) return `outlet:${normOutlet}`;
  return `nopub:${fallbackId}`;
}

function evidenceRichness(item) {
  const bodyLen = Array.isArray(item.body)
    ? item.body.reduce((acc, s) => acc + (typeof s === "string" ? s.length : 0), 0)
    : typeof item.body === "string"
    ? item.body.length
    : 0;
  const headlineLen = typeof item.headline === "string" ? item.headline.length : 0;
  const bylineBonus = typeof item.byline === "string" && item.byline.trim().length > 0 ? 1 : 0;
  return bodyLen * 2 + headlineLen + bylineBonus * 50;
}

/**
 * Deterministic comparator implementing the product tie-break order:
 *   1. evidence richness (body length × 2 + headline length + byline bonus)
 *   2. freshness (smaller `minutesAgo` wins)
 *   3. feed weight (higher wins)
 *   4. feedId lexicographic (lower wins)
 *   5. sourceId lexicographic (lower wins — final guaranteed tiebreaker)
 *
 * Returns negative when `a` should win over `b`.  URL confidence is NOT
 * compared here: within a single merge group the composite key already
 * guarantees all members share the same URL status (all have a canonical, or
 * all have none).
 */
function pickWinnerCmp(a, b) {
  const ar = evidenceRichness(a);
  const br = evidenceRichness(b);
  if (ar !== br) return br - ar;
  const am = Number.isFinite(a.minutesAgo) ? a.minutesAgo : Number.POSITIVE_INFINITY;
  const bm = Number.isFinite(b.minutesAgo) ? b.minutesAgo : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm;
  const aw = Number.isFinite(a.weight) ? a.weight : 0;
  const bw = Number.isFinite(b.weight) ? b.weight : 0;
  if (aw !== bw) return bw - aw;
  const af = String(a.feedId ?? "");
  const bf = String(b.feedId ?? "");
  if (af !== bf) return af < bf ? -1 : 1;
  const as = String(a.sourceId ?? "");
  const bs = String(b.sourceId ?? "");
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

/**
 * Winner comparator for a liveblog cluster.  Unlike `pickWinnerCmp` (evidence
 * richness first), the canonical liveblog item is the NEWEST snapshot — that's
 * the current state of the rolling story.  Order:
 *   1. freshness (smaller `minutesAgo` wins)
 *   2. evidence richness (longer body/headline as a tie-break)
 *   3. feed weight (higher wins)
 *   4. feedId, then sourceId lexicographic (final stable tie-breaks)
 * Returns negative when `a` should win over `b`.
 */
function pickLiveblogWinnerCmp(a, b) {
  const am = Number.isFinite(a.minutesAgo) ? a.minutesAgo : Number.POSITIVE_INFINITY;
  const bm = Number.isFinite(b.minutesAgo) ? b.minutesAgo : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm;
  const ar = evidenceRichness(a);
  const br = evidenceRichness(b);
  if (ar !== br) return br - ar;
  const aw = Number.isFinite(a.weight) ? a.weight : 0;
  const bw = Number.isFinite(b.weight) ? b.weight : 0;
  if (aw !== bw) return bw - aw;
  const af = String(a.feedId ?? "");
  const bf = String(b.feedId ?? "");
  if (af !== bf) return af < bf ? -1 : 1;
  const as = String(a.sourceId ?? "");
  const bs = String(b.sourceId ?? "");
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

function loserProvenance(item) {
  return {
    sourceId: item.sourceId,
    feedId: item.feedId,
    outlet: item.outlet,
    url: item.url,
    weight: item.weight,
  };
}

function stripInternalAnnotations(item) {
  // Drop all underscore-prefixed annotations the deduper attached during
  // grouping.  Downstream callers must not depend on these.
  const { _canonicalUrl: _c, _normHeadline: _h, ...rest } = item;
  return rest;
}

/**
 * Split a same-(URL,headline) group into time-window sub-clusters so two
 * items that share canonical URL + headline but were published far apart
 * (e.g. URL recycle, very-late republish) are kept distinct.
 *
 * **Anchor-based strict partitioning (NOT chain/transitive merging).**
 *   Sort members by `minutesAgo` ascending.  The first member of each new
 *   cluster is the anchor; subsequent members join that cluster only while
 *   `minutesAgo - anchor.minutesAgo ≤ windowMinutes`.  As soon as an item
 *   crosses the window relative to the ANCHOR, it seeds a new cluster
 *   (whose anchor is itself).  This is intentional: we explicitly do NOT
 *   chain-link items by adjacency, because chain-linking would let three
 *   items at e.g. minutesAgo=[0, 50, 100] (window=60) all merge by
 *   transitivity (0↔50 ok, 50↔100 ok), even though the 0 and 100 items are
 *   100 minutes apart — well outside the close-window guarantee the policy
 *   promises.
 *
 *   Concretely with window=60:
 *     [0, 50, 100]  → cluster A = {0, 50}  (anchor=0; 50-0=50 ≤ 60)
 *                     cluster B = {100}    (100-0=100 > 60 → new anchor)
 *     [0, 70, 80]   → cluster A = {0}      (70-0=70 > 60 → new anchor)
 *                     cluster B = {70, 80} (anchor=70; 80-70=10 ≤ 60)
 *
 *   This biases toward false splits over false merges, which is the MVP
 *   posture.  Operators who later want a more permissive "transitively
 *   close" policy should change this function deliberately.
 *
 *   Items with non-finite `minutesAgo` always sit alone (we cannot apply
 *   the window without a time signal).  Determinism: a secondary sort by
 *   `sourceId` lex breaks `minutesAgo` ties so shuffled inputs produce
 *   identical clusters.
 */
function partitionByTimeWindow(members, windowMinutes) {
  const sorted = [...members].sort((a, b) => {
    const am = Number.isFinite(a.minutesAgo) ? a.minutesAgo : Number.POSITIVE_INFINITY;
    const bm = Number.isFinite(b.minutesAgo) ? b.minutesAgo : Number.POSITIVE_INFINITY;
    if (am !== bm) return am - bm;
    const as = String(a.sourceId ?? "");
    const bs = String(b.sourceId ?? "");
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
  const clusters = [];
  let current = null;
  let anchor = null;
  for (const m of sorted) {
    const t = Number.isFinite(m.minutesAgo) ? m.minutesAgo : Number.POSITIVE_INFINITY;
    const startNew =
      current === null ||
      !Number.isFinite(anchor) ||
      !Number.isFinite(t) ||
      t - anchor > windowMinutes;
    if (startNew) {
      current = [m];
      anchor = t;
      clusters.push(current);
    } else {
      current.push(m);
    }
  }
  return clusters;
}

/**
 * Collapse same-article items across feeds under the strict merge rules.
 *
 * Returns:
 *   {
 *     unique:         array of canonical winners (each winner of a multi-
 *                     member cluster carries `_duplicates` listing loser
 *                     provenance — internal only)
 *     duplicateCount: number of items folded into a winner (input.length
 *                     - unique.length)
 *     groups:         number of distinct emitted groups (== unique.length)
 *   }
 *
 * Output order is stable: items appear in the same order as the FIRST
 * occurrence of each composite key in the input.  Time-window sub-clusters
 * within a composite-key group emerge in ascending `minutesAgo` order
 * (freshest first), with `sourceId` lex breaking ties.
 */
export function dedupeSourceItems(items) {
  const list = Array.isArray(items) ? items : [];
  const groups = new Map();
  const order = [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== "object") continue;
    const canonical = canonicalizeUrl(raw.url);
    const normHeadline = normalizeHeadline(raw.headline);
    const liveblogSubject = extractLiveblogSubject(raw.headline);
    const annotated = {
      ...raw,
      _canonicalUrl: canonical,
      _normHeadline: normHeadline,
    };
    let key;
    let hasUrl;
    let isLiveblog = false;
    if (liveblogSubject) {
      // Liveblog: group by publisher/domain bucket + subject after the live
      // marker (ignoring URL/headline drift across the day) and gate merges by
      // the publish-time window.  Takes precedence over the URL/headline paths
      // so case/plural/URL variations of the same rolling story collapse — but
      // the publisher bucket keeps two outlets' same-subject liveblogs distinct
      // (no cross-publisher over-merge on subject alone).
      const bucket = liveblogBucket(canonical, raw.outlet, raw.sourceId ?? `idx${i}`);
      key = `liveblog::${bucket}::${liveblogSubject}`;
      hasUrl = false;
      isLiveblog = true;
    } else if (!normHeadline) {
      // No usable headline → unique singleton (insufficient signal to merge).
      key = `__nohl__::${raw.sourceId ?? `idx${i}`}`;
      hasUrl = false;
    } else if (canonical) {
      key = `url::${canonical}::hl::${normHeadline}`;
      hasUrl = true;
    } else {
      // No URL — merge only on exact normalized headline (no time gate per spec).
      key = `nourl::hl::${normHeadline}`;
      hasUrl = false;
    }
    if (!groups.has(key)) {
      groups.set(key, { members: [], hasUrl, isLiveblog });
      order.push(key);
    }
    groups.get(key).members.push(annotated);
  }

  const unique = [];
  let duplicateCount = 0;

  for (const key of order) {
    const { members, hasUrl, isLiveblog } = groups.get(key);
    if (members.length === 1) {
      unique.push(stripInternalAnnotations(members[0]));
      continue;
    }
    // Both the URL path and the liveblog path gate merges by the publish-time
    // window so far-apart items (URL recycle, or a same-subject liveblog from a
    // different cycle) stay distinct.
    const subClusters = hasUrl || isLiveblog
      ? partitionByTimeWindow(members, PUBLISH_WINDOW_MINUTES)
      : [members];
    // Liveblog clusters keep the NEWEST snapshot as canonical; everything else
    // uses the evidence-richness-first tie-break.
    const winnerCmp = isLiveblog ? pickLiveblogWinnerCmp : pickWinnerCmp;
    for (const cluster of subClusters) {
      if (cluster.length === 1) {
        unique.push(stripInternalAnnotations(cluster[0]));
        continue;
      }
      const sorted = [...cluster].sort(winnerCmp);
      const winner = sorted[0];
      const losers = sorted.slice(1);
      duplicateCount += losers.length;
      const out = stripInternalAnnotations(winner);
      out._duplicates = losers.map(loserProvenance);
      unique.push(out);
    }
  }

  return { unique, duplicateCount, groups: unique.length };
}
