// Normalize raw feed items → canonical sourceItem shape.
// Required fields: clusterId, sourceId, outlet, kind, weight, url, minutesAgo, headline, body.
// Optional fields receive defaults when absent so downstream pipeline always sees a consistent shape.

const REQUIRED_FIELDS = ["clusterId", "sourceId", "outlet", "kind", "weight", "url", "minutesAgo", "headline", "body"];

export function normalizeSourceItem(raw) {
  if (raw == null || typeof raw !== "object") {
    throw new TypeError("raw item must be an object");
  }
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  return {
    clusterId: String(raw.clusterId),
    title: String(raw.title ?? raw.clusterId),
    topic: String(raw.topic ?? ""),
    geographies: Array.isArray(raw.geographies) ? raw.geographies.map(String) : [],
    priority: raw.priority ?? "standard",
    takeaway: String(raw.takeaway ?? ""),
    summary: String(raw.summary ?? ""),
    whyItMatters: String(raw.whyItMatters ?? ""),
    whatChanged: String(raw.whatChanged ?? ""),
    sourceId: String(raw.sourceId),
    outlet: String(raw.outlet),
    byline: raw.byline != null ? String(raw.byline) : undefined,
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
