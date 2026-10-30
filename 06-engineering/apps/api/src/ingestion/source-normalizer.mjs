// Normalize raw feed items → canonical sourceItem shape.
// Required fields: sourceId, outlet, kind, weight, url, minutesAgo, headline, body.
// `clusterId` is OPTIONAL on raw input — when omitted (e.g. live RSS items that
// haven't been clustered yet), it defaults to `provisional:${sourceId}`.  Real
// clusterIds get assigned downstream by the clustering engine.
// Optional fields receive defaults when absent so downstream pipeline always sees a consistent shape.

const REQUIRED_FIELDS = ["sourceId", "outlet", "kind", "weight", "url", "minutesAgo", "headline", "body"];

export function normalizeSourceItem(raw) {
  if (raw == null || typeof raw !== "object") {
    throw new TypeError("raw item must be an object");
  }
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  const clusterId =
    raw.clusterId !== undefined && raw.clusterId !== null
      ? String(raw.clusterId)
      : `provisional:${String(raw.sourceId)}`;
  return {
    clusterId,
    title: String(raw.title ?? clusterId),
    topic: String(raw.topic ?? ""),
    geographies: Array.isArray(raw.geographies) ? raw.geographies.map(String) : [],
    priority: raw.priority ?? "standard",
    takeaway: String(raw.takeaway ?? ""),
    summary: String(raw.summary ?? ""),
    whyItMatters: String(raw.whyItMatters ?? ""),
    whatChanged: String(raw.whatChanged ?? ""),
    sourceId: String(raw.sourceId),
    // Optional manifest-row id from feed-reader's mapEntry — preserved when
    // present so source-selection can match by stable id rather than fragile
    // outlet-name normalization.  Legacy fixture items (no feedId) get
    // `undefined` and fall back to outlet-based matching downstream.
    feedId: raw.feedId != null && String(raw.feedId).length > 0 ? String(raw.feedId) : undefined,
    outlet: String(raw.outlet),
    byline: raw.byline != null ? String(raw.byline) : undefined,
    // Optional BCP-47-ish language tag from the feed (e.g. "es", "es-CO").
    // Preserved so the translation-first normalization stage (Slice 14) can
    // tell non-English evidence apart from English. Absent → undefined →
    // treated as English downstream (no translation).
    lang: raw.lang != null && String(raw.lang).trim().length > 0 ? String(raw.lang).trim() : undefined,
    kind: String(raw.kind),
    weight: Number(raw.weight),
    url: String(raw.url),
    minutesAgo: Number(raw.minutesAgo),
    headline: String(raw.headline),
    body: Array.isArray(raw.body) ? raw.body.map(String) : [String(raw.body)],
  };
}

// Processes an array of raw items. Invalid items are skipped and reported in errors[] rather than
// aborting the run — one bad feed item should not block the rest of the ingestion pipeline.
export function normalizeSourceItems(rawItems) {
  if (!Array.isArray(rawItems)) {
    throw new TypeError("rawItems must be an array");
  }
  const items = [];
  const errors = [];
  for (let i = 0; i < rawItems.length; i++) {
    try {
      items.push(normalizeSourceItem(rawItems[i]));
    } catch (err) {
      errors.push({ index: i, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { items, errors };
}
