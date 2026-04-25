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

// ─── Auth funnel events ──────────────────────────────────────────────────────

export const landingViewedPayloadSchema = z.object({
  route: z.string().min(1),
});

export const authCtaClickedPayloadSchema = z.object({
  ctaType: z.enum(["login", "signup"]),
  route: z.string().min(1),
});

export const authStartedPayloadSchema = z.object({
  mode: z.enum(["login", "signup"]),
  route: z.string().min(1),
  authAttemptId: z.string().min(1),
});

export const authSucceededPayloadSchema = z.object({
  mode: z.enum(["login", "signup"]),
  route: z.string().min(1),
  authAttemptId: z.string().min(1),
});

export const landingViewedEventSchema = z.object({
  name: z.literal("landing_viewed"),
  tier: z.literal("primary"),
  occurredAt: occurredAtSchema,
  payload: landingViewedPayloadSchema,
});

export const authCtaClickedEventSchema = z.object({
  name: z.literal("auth_cta_clicked"),
  tier: z.literal("secondary"),
  occurredAt: occurredAtSchema,
  payload: authCtaClickedPayloadSchema,
});

export const authStartedEventSchema = z.object({
  name: z.literal("auth_started"),
  tier: z.literal("primary"),
  occurredAt: occurredAtSchema,
  payload: authStartedPayloadSchema,
});

export const authSucceededEventSchema = z.object({
  name: z.literal("auth_succeeded"),
  tier: z.literal("primary"),
  occurredAt: occurredAtSchema,
  payload: authSucceededPayloadSchema,
});

// ─── Onboarding funnel events ────────────────────────────────────────────────

export const onboardingViewedPayloadSchema = z.object({
  route: z.string().min(1),
});

export const onboardingSubmittedPayloadSchema = z.object({
  route: z.string().min(1),
});

export const onboardingCompletedPayloadSchema = z.object({
  route: z.string().min(1),
});

export const onboardingViewedEventSchema = z.object({
  name: z.literal("onboarding_viewed"),
  tier: z.literal("primary"),
  occurredAt: occurredAtSchema,
  payload: onboardingViewedPayloadSchema,
});

export const onboardingSubmittedEventSchema = z.object({
  name: z.literal("onboarding_submitted"),
  tier: z.literal("secondary"),
  occurredAt: occurredAtSchema,
  payload: onboardingSubmittedPayloadSchema,
});

export const onboardingCompletedEventSchema = z.object({
  name: z.literal("onboarding_completed"),
  tier: z.literal("primary"),
  occurredAt: occurredAtSchema,
  payload: onboardingCompletedPayloadSchema,
});

export const analyticsEventSchema = z.discriminatedUnion("name", [
  dashboardViewedEventSchema,
  storyExpandedEventSchema,
  sourceOpenedEventSchema,
  sourceOpenErrorEventSchema,
  apiDashboardRequestedEventSchema,
  apiErrorEventSchema,
  settingsUpdatedEventSchema,
  landingViewedEventSchema,
  authCtaClickedEventSchema,
  authStartedEventSchema,
  authSucceededEventSchema,
  onboardingViewedEventSchema,
  onboardingSubmittedEventSchema,
  onboardingCompletedEventSchema,
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

export function buildLandingViewed(
  payload: z.infer<typeof landingViewedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof landingViewedEventSchema> {
  return landingViewedEventSchema.parse({
    name: "landing_viewed",
    tier: "primary",
    occurredAt,
    payload,
  });
}

export function buildAuthCtaClicked(
  payload: z.infer<typeof authCtaClickedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof authCtaClickedEventSchema> {
  return authCtaClickedEventSchema.parse({
    name: "auth_cta_clicked",
    tier: "secondary",
    occurredAt,
    payload,
  });
}

export function buildAuthStarted(
  payload: z.infer<typeof authStartedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof authStartedEventSchema> {
  return authStartedEventSchema.parse({
    name: "auth_started",
    tier: "primary",
    occurredAt,
    payload,
  });
}

export function buildAuthSucceeded(
  payload: z.infer<typeof authSucceededPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof authSucceededEventSchema> {
  return authSucceededEventSchema.parse({
    name: "auth_succeeded",
    tier: "primary",
    occurredAt,
    payload,
  });
}

export function buildOnboardingViewed(
  payload: z.infer<typeof onboardingViewedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof onboardingViewedEventSchema> {
  return onboardingViewedEventSchema.parse({
    name: "onboarding_viewed",
    tier: "primary",
    occurredAt,
    payload,
  });
}

export function buildOnboardingSubmitted(
  payload: z.infer<typeof onboardingSubmittedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof onboardingSubmittedEventSchema> {
  return onboardingSubmittedEventSchema.parse({
    name: "onboarding_submitted",
    tier: "secondary",
    occurredAt,
    payload,
  });
}

export function buildOnboardingCompleted(
  payload: z.infer<typeof onboardingCompletedPayloadSchema>,
  occurredAt = new Date().toISOString()
): z.infer<typeof onboardingCompletedEventSchema> {
  return onboardingCompletedEventSchema.parse({
    name: "onboarding_completed",
    tier: "primary",
    occurredAt,
    payload,
  });
}
