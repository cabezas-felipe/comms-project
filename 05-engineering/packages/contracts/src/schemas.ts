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

export const storySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  geographies: z.array(geographySchema).min(1),
  topic: topicSchema,
  takeaway: z.string().min(1),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  whatChanged: z.string().min(1),
  priority: storyPrioritySchema,
  outletCount: z.number().int().nonnegative(),
  sources: z.array(sourceSchema).min(1),
});

export const dashboardPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  stories: z.array(storySchema),
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
export type StoryDto = z.infer<typeof storySchema>;
export type DashboardPayload = z.infer<typeof dashboardPayloadSchema>;
export type SettingsPayload = z.infer<typeof settingsPayloadSchema>;
