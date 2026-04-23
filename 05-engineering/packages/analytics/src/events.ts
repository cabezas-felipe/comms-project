import { z } from "zod";

/** Metric tier: primary success path, secondary product signals, guardrail failures. */
export const eventTierSchema = z.enum(["primary", "secondary", "guardrail"]);

export const dashboardViewedPayloadSchema = z.object({
  route: z.string().min(1),
});

export const storyExpandedPayloadSchema = z.object({
  storyId: z.string().min(1),
});

export const sourceOpenedPayloadSchema = z.object({
  storyId: z.string().min(1),
  sourceId: z.string().min(1),
});

export const sourceOpenErrorPayloadSchema = z.object({
  storyId: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  message: z.string().min(1),
  code: z.string().optional(),
});

const occurredAtSchema = z.string().min(1);

export const dashboardViewedEventSchema = z.object({
  name: z.literal("dashboard_viewed"),
  tier: z.literal("primary"),
  occurredAt: occurredAtSchema,
  payload: dashboardViewedPayloadSchema,
});

export const storyExpandedEventSchema = z.object({
  name: z.literal("story_expanded"),
  tier: z.literal("secondary"),
  occurredAt: occurredAtSchema,
  payload: storyExpandedPayloadSchema,
});

export const sourceOpenedEventSchema = z.object({
  name: z.literal("source_opened"),
  tier: z.literal("secondary"),
  occurredAt: occurredAtSchema,
  payload: sourceOpenedPayloadSchema,
});

export const sourceOpenErrorEventSchema = z.object({
  name: z.literal("source_open_error"),
  tier: z.literal("guardrail"),
  occurredAt: occurredAtSchema,
  payload: sourceOpenErrorPayloadSchema,
});

export const analyticsEventSchema = z.discriminatedUnion("name", [
  dashboardViewedEventSchema,
  storyExpandedEventSchema,
  sourceOpenedEventSchema,
  sourceOpenErrorEventSchema,
]);

export type EventTier = z.infer<typeof eventTierSchema>;
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

export function buildDashboardViewed(
  payload: z.infer<typeof dashboardViewedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof dashboardViewedEventSchema> {
  return dashboardViewedEventSchema.parse({
    name: "dashboard_viewed",
    tier: "primary",
    occurredAt,
    payload,
  });
}

export function buildStoryExpanded(
  payload: z.infer<typeof storyExpandedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof storyExpandedEventSchema> {
  return storyExpandedEventSchema.parse({
    name: "story_expanded",
    tier: "secondary",
    occurredAt,
    payload,
  });
}

export function buildSourceOpened(
  payload: z.infer<typeof sourceOpenedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof sourceOpenedEventSchema> {
  return sourceOpenedEventSchema.parse({
    name: "source_opened",
    tier: "secondary",
    occurredAt,
    payload,
  });
}

export function buildSourceOpenError(
  payload: z.infer<typeof sourceOpenErrorPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof sourceOpenErrorEventSchema> {
  return sourceOpenErrorEventSchema.parse({
    name: "source_open_error",
    tier: "guardrail",
    occurredAt,
    payload,
  });
}
