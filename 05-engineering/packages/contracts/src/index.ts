export {
  CONTRACT_VERSION,
  geographySchema,
  topicSchema,
  sourceKindSchema,
  storyPrioritySchema,
  trendSchema,
  sourceSchema,
  storyTagsSchema,
  storySchema,
  dashboardPayloadSchema,
  dashboardSelectionMetaSchema,
  settingsPayloadSchema,
} from "./schemas.js";
export type {
  GeographyDto,
  TopicDto,
  SourceKindDto,
  StoryPriorityDto,
  TrendDto,
  SourceDto,
  StoryTagsDto,
  StoryDto,
  DashboardPayload,
  DashboardSelectionMeta,
  SettingsPayload,
} from "./schemas.js";
export { classifySources } from "./source-classification.js";
export type { ClassifiedSources } from "./source-classification.js";
export {
  normalizeTopicLabel,
  normalizeKeywordLabel,
  normalizeSourceName,
  normalizeSourceIdentity,
  TOPIC_SYNONYMS,
  KEYWORD_SYNONYMS,
  SOURCE_NAME_ALIASES,
} from "./label-normalization.js";
export {
  GEOGRAPHY_ALIASES,
  GEOGRAPHY_SYNONYMS,
  resolveGeographyAlias,
} from "./geography-aliases.js";
