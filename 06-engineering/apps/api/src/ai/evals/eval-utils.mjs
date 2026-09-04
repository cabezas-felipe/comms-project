import { normalizeTopicLabel, normalizeKeywordLabel, normalizeSourceName } from "../../contracts-runtime/index.mjs";

/**
 * Build and validate the telemetry payload for onboarding_extraction_scored.
 * Numeric metrics must be in [0, 1]; string fields must be non-empty.
 */
export function buildExtractionScoredPayload({
  f1,
  precision,
  recall,
  modelVersion,
  datasetVersion,
  sampleSize,
  runType,
}) {
  if (typeof f1 !== "number" || f1 < 0 || f1 > 1)
    throw new RangeError("f1 must be a number in [0, 1]");
  if (typeof precision !== "number" || precision < 0 || precision > 1)
    throw new RangeError("precision must be a number in [0, 1]");
  if (typeof recall !== "number" || recall < 0 || recall > 1)
    throw new RangeError("recall must be a number in [0, 1]");
  if (!modelVersion || typeof modelVersion !== "string")
    throw new TypeError("modelVersion must be a non-empty string");
  if (!datasetVersion || typeof datasetVersion !== "string")
    throw new TypeError("datasetVersion must be a non-empty string");
  if (!Number.isInteger(sampleSize) || sampleSize < 1)
    throw new RangeError("sampleSize must be a positive integer");
  if (!runType || typeof runType !== "string")
    throw new TypeError("runType must be a non-empty string");
  return { f1, precision, recall, modelVersion, datasetVersion, sampleSize, runType };
}

export const EVAL_FIELDS = [
  "topics",
  "keywords",
  "geographies",
  "traditionalSources",
  "socialSources",
];

/**
 * Normalise a raw array for eval comparison:
 *   trim → case-insensitive dedupe (first occurrence wins) → case-insensitive sort.
 * Non-string items and empty strings are dropped.
 * Idempotent: safe to call on already-normalised arrays.
 */
export function normalizeForEval(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    const s = typeof item === "string" ? item.trim() : "";
    if (!s) continue;
    const key = s.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(s);
    }
  }
  return result.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

const FIELD_NORMALIZERS = {
  topics: normalizeTopicLabel,
  keywords: normalizeKeywordLabel,
  traditionalSources: normalizeSourceName,
};

/**
 * Like normalizeForEval but also applies field-specific synonym normalization
 * (topic labels, keyword labels, source name aliases) before deduplication.
 * Use for both predicted and expected arrays when scoring to ensure synonyms match.
 */
export function normalizeForEvalField(field, arr) {
  const fn = FIELD_NORMALIZERS[field];
  if (!fn) return normalizeForEval(arr);
  return normalizeForEval(normalizeForEval(arr).map(fn));
}

/**
 * Set-based precision / recall / F1 / exactMatch for two already-normalised arrays.
 * Comparison is case-insensitive.
 *
 * Edge cases:
 *   both empty        → { precision:1, recall:1, f1:1, exactMatch:true }
 *   predicted empty,
 *    expected non-empty → all 0, exactMatch false
 *   predicted non-empty,
 *    expected empty   → precision 0, recall 0, exactMatch false
 */
export function setMetrics(predicted, expected) {
  const predLower = new Set(predicted.map((s) => s.toLowerCase()));
  const expLower = new Set(expected.map((s) => s.toLowerCase()));

  if (predLower.size === 0 && expLower.size === 0) {
    return { precision: 1, recall: 1, f1: 1, exactMatch: true };
  }

  let truePositives = 0;
  for (const item of predLower) {
    if (expLower.has(item)) truePositives++;
  }

  const precision = predLower.size > 0 ? truePositives / predLower.size : 0;
  const recall = expLower.size > 0 ? truePositives / expLower.size : 0;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const exactMatch =
    predLower.size === expLower.size && truePositives === expLower.size;

  return { precision, recall, f1, exactMatch };
}
