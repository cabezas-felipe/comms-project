export {
  CONTRACT_VERSION,
  geographySchema,
  topicSchema,
  sourceKindSchema,
  storyPrioritySchema,
  trendSchema,
  sourceSchema,
  storySchema,
  dashboardPayloadSchema,
  settingsPayloadSchema,
} from "./schemas.js";
export type {
  GeographyDto,
  TopicDto,
  SourceKindDto,
  StoryPriorityDto,
  TrendDto,
  SourceDto,
  StoryDto,
  DashboardPayload,
  SettingsPayload,
} from "./schemas.js";
export { classifySources } from "./source-classification.js";
export type { ClassifiedSources } from "./source-classification.js";
export {
  normalizeTopicLabel,
  normalizeKeywordLabel,
  normalizeSourceName,
  TOPIC_SYNONYMS,
  KEYWORD_SYNONYMS,
  SOURCE_NAME_ALIASES,
} from "./label-normalization.js";
