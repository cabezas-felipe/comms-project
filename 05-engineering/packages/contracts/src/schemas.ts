import { z } from "zod";

/** API / persistence contract version for migrations and clients. */
export const CONTRACT_VERSION = "2026-04-22-slice1" as const;

export const geographySchema = z.enum(["US", "Colombia"]);
export const topicSchema = z.enum([
  "Diplomatic relations",
  "Migration policy",
  "Security cooperation",
]);
export const sourceKindSchema = z.enum(["traditional", "social"]);
export const storyPrioritySchema = z.enum(["top", "standard"]);
export const trendSchema = z.enum(["rising", "steady", "falling"]);

export const sourceSchema = z.object({
  id: z.string().min(1),
  outlet: z.string().min(1),
  byline: z.string().optional(),
  kind: sourceKindSchema,
  weight: z.number().min(0).max(100),
  url: z.string().min(1),
  minutesAgo: z.number().nonnegative(),
  headline: z.string().min(1),
  body: z.array(z.string()).min(1),
});

export const storyTagsSchema = z.object({
  topics: z.array(z.string()),
  keywords: z.array(z.string()),
  geographies: z.array(z.string()),
});

export const storySchema = z.object({
  id: z.string().min(1),
  metaStoryId: z.string().optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  geographies: z.array(geographySchema),
  topic: topicSchema,
  takeaway: z.string().min(1),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  whatChanged: z.string().min(1),
  priority: storyPrioritySchema,
  outletCount: z.number().int().nonnegative(),
  tags: storyTagsSchema.optional(),
  sources: z.array(sourceSchema).min(1),
});

export const dashboardPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  stories: z.array(storySchema),
});

/**
 * Selection metadata surfaced through `_meta.selection` on dashboard responses
 * (Phase 2).  Reports source-resolution outcome so the frontend can show small
 * status cues (fallback used / unmatched names / strict-empty).  All fields
 * are optional for forward compatibility — older snapshots won't carry them.
 */
export const dashboardSelectionMetaSchema = z.object({
  sourceSelectionMode: z.enum(["strict", "fallback"]).optional(),
  sourceFallbackUsed: z.boolean().optional(),
  sourceFallbackReason: z.string().nullable().optional(),
  matchedSourceCount: z.number().int().nonnegative().optional(),
  selectedSourceCount: z.number().int().nonnegative().optional(),
  unmatchedSelectedSources: z.array(z.string()).optional(),
  unavailableConnectorCount: z.number().int().nonnegative().optional(),
  unavailableConnectorSources: z.array(z.string()).optional(),
  matchedFeedIds: z.array(z.string()).optional(),
  relevantItemCount: z.number().int().nonnegative().optional(),
});

export const settingsPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});

export type GeographyDto = z.infer<typeof geographySchema>;
export type TopicDto = z.infer<typeof topicSchema>;
export type SourceKindDto = z.infer<typeof sourceKindSchema>;
export type StoryPriorityDto = z.infer<typeof storyPrioritySchema>;
export type TrendDto = z.infer<typeof trendSchema>;
export type SourceDto = z.infer<typeof sourceSchema>;
export type StoryTagsDto = z.infer<typeof storyTagsSchema>;
export type StoryDto = z.infer<typeof storySchema>;
export type DashboardPayload = z.infer<typeof dashboardPayloadSchema>;
export type DashboardSelectionMeta = z.infer<typeof dashboardSelectionMetaSchema>;
export type SettingsPayload = z.infer<typeof settingsPayloadSchema>;
