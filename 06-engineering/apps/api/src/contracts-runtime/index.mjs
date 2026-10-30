// Barrel for the API's runtime-safe contract surface.  All API runtime files
// (server, pipeline, ingestion, dashboard, ai, ops) MUST import from here
// rather than from `@tempo/contracts` so cold-start does not depend on a
// workspace package's `dist/` build artifact.  Tests are free to import from
// `@tempo/contracts` for cross-validation; a parity test enforces that this
// runtime copy stays equivalent to the published package.

export {
  CONTRACT_VERSION,
  geographySchema,
  topicSchema,
  sourceKindSchema,
  storyPrioritySchema,
  sourceSchema,
  storyTagsSchema,
  storySchema,
  dashboardPayloadSchema,
  settingsPayloadSchema,
  refreshFailureSubtypeSchema,
  refreshFailureSchema,
  deterministicClusteringDiagnosticsSchema,
  dashboardRefreshFailsafeMetaSchema,
} from "./schemas.mjs";

export {
  TOPIC_SYNONYMS,
  KEYWORD_SYNONYMS,
  SOURCE_NAME_ALIASES,
  normalizeTopicLabel,
  normalizeKeywordLabel,
  normalizeSourceName,
  normalizeSourceIdentity,
} from "./label-normalization.mjs";

export { classifySources } from "./source-classification.mjs";

export {
  GEOGRAPHY_ALIASES,
  GEOGRAPHY_SYNONYMS,
  resolveGeographyAlias,
  stripKeywordsMatchingGeographies,
} from "./geography-aliases.mjs";

export { REFRESH_INTERVAL_MS } from "./refresh-cadence.mjs";
