export const GEO_CATEGORY = {
  EXPLICIT_MATCH: "explicit_match",
  EXPLICIT_CONFLICT: "explicit_conflict",
  IMPLICIT_GEO: "implicit_geo",
};

export const CONFLICT_THRESHOLD = 0.90;
export const IMPLICIT_THRESHOLD = 0.80;

/**
 * Categorize a single item relative to the user's configured geographies.
 *
 * - explicit_match:    item.geographies overlaps with configuredGeos
 * - explicit_conflict: item has geographies but none match configuredGeos
 * - implicit_geo:      item.geographies is empty
 */
export function categorizeItem(item, configuredGeos) {
  if (!item.geographies || item.geographies.length === 0) {
    return GEO_CATEGORY.IMPLICIT_GEO;
  }
  const geoSet = new Set(configuredGeos);
  if (item.geographies.some((g) => geoSet.has(g))) {
    return GEO_CATEGORY.EXPLICIT_MATCH;
  }
  return GEO_CATEGORY.EXPLICIT_CONFLICT;
}

/**
 * Mock geo-confidence assessor. Used in tests and as the default when no
 * real LLM assessor is injected. Returns a confidence that passes the
 * implicit threshold (0.85 > 0.80) but fails the conflict threshold (0.85 < 0.90).
 *
 * @param {object} _item
 * @param {string[]} _configuredGeos
 * @returns {{ confidence: number }}
 */
export function mockAssessGeoConfidence(_item, _configuredGeos) {
  return { confidence: 0.85 };
}

/**
 * Apply geo-confidence filtering to a pool of items.
 *
 * Rules:
 * - If configuredGeos is empty, all items are included (topic+keyword-only mode).
 * - explicit_match items are always included (confidence = 1.0).
 * - explicit_conflict items: call assessFn; include if confidence >= CONFLICT_THRESHOLD (0.90).
 * - implicit_geo items:      call assessFn; include if confidence >= IMPLICIT_THRESHOLD (0.80).
 * - Items below threshold go into the held array (hold bucket).
 *
 * @param {object[]} items
 * @param {string[]} configuredGeos
 * @param {Function} [assessFn]
 * @returns {Promise<{ included: object[], held: object[] }>}
 */
export async function applyGeoFilter(items, configuredGeos, assessFn = mockAssessGeoConfidence) {
  if (configuredGeos.length === 0) {
    return { included: items, held: [] };
  }

  const included = [];
  const held = [];

  for (const item of items) {
    const category = categorizeItem(item, configuredGeos);

    if (category === GEO_CATEGORY.EXPLICIT_MATCH) {
      included.push({ ...item, geoCategory: category, geoConfidence: 1.0 });
      continue;
    }

    const { confidence } = await assessFn(item, configuredGeos);
    const threshold =
      category === GEO_CATEGORY.EXPLICIT_CONFLICT ? CONFLICT_THRESHOLD : IMPLICIT_THRESHOLD;

    if (confidence >= threshold) {
      included.push({ ...item, geoCategory: category, geoConfidence: confidence });
    } else {
      held.push({ ...item, geoCategory: category, geoConfidence: confidence });
    }
  }

  return { included, held };
}
