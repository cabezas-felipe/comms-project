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

// ─── Server-side events ─────────────────────────────────────────────────────

export const apiDashboardRequestedPayloadSchema = z.object({
  storyCount: z.number().int().nonnegative(),
  normErrorCount: z.number().int().nonnegative(),
  limitApplied: z.number().int().positive(),
  fallbackCount: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  aiModel: z.string().min(1),
});

export const apiErrorPayloadSchema = z.object({
  route: z.string().min(1),
  statusCode: z.number().int(),
  message: z.string().min(1),
});

export const settingsUpdatedPayloadSchema = z.object({
  topicCount: z.number().int().nonnegative(),
  geoCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
});

export const apiDashboardRequestedEventSchema = z.object({
  name: z.literal("api_dashboard_requested"),
  tier: z.literal("primary"),
  occurredAt: occurredAtSchema,
  payload: apiDashboardRequestedPayloadSchema,
});

export const apiErrorEventSchema = z.object({
  name: z.literal("api_error"),
  tier: z.literal("guardrail"),
  occurredAt: occurredAtSchema,
  payload: apiErrorPayloadSchema,
});

export const settingsUpdatedEventSchema = z.object({
  name: z.literal("settings_updated"),
  tier: z.literal("secondary"),
  occurredAt: occurredAtSchema,
  payload: settingsUpdatedPayloadSchema,
});

export const analyticsEventSchema = z.discriminatedUnion("name", [
  dashboardViewedEventSchema,
  storyExpandedEventSchema,
  sourceOpenedEventSchema,
  sourceOpenErrorEventSchema,
  apiDashboardRequestedEventSchema,
  apiErrorEventSchema,
  settingsUpdatedEventSchema,
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

export function buildApiDashboardRequested(
  payload: z.infer<typeof apiDashboardRequestedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof apiDashboardRequestedEventSchema> {
  return apiDashboardRequestedEventSchema.parse({
    name: "api_dashboard_requested",
    tier: "primary",
    occurredAt,
    payload,
  });
}

export function buildApiError(
  payload: z.infer<typeof apiErrorPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof apiErrorEventSchema> {
  return apiErrorEventSchema.parse({
    name: "api_error",
    tier: "guardrail",
    occurredAt,
    payload,
  });
}

export function buildSettingsUpdated(
  payload: z.infer<typeof settingsUpdatedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof settingsUpdatedEventSchema> {
  return settingsUpdatedEventSchema.parse({
    name: "settings_updated",
    tier: "secondary",
    occurredAt,
    payload,
  });
}
