import type { AnalyticsEvent } from "./events.js";

export interface PostHogSinkOptions {
  apiKey: string;
  host?: string;
  distinctId?: string;
}

export interface PostHogIdentifyOptions {
  apiKey: string;
  host?: string;
  /** Authenticated user ID (e.g. "supabase:<uuid>"). Becomes the new distinct_id. */
  userId: string;
  /** Anonymous distinct ID used before login. PostHog merges this person's history into userId. */
  anonymousId: string;
}

/**
 * Sends a PostHog $identify event so anonymous pre-login events are stitched
 * into the authenticated user's funnel. Never throws.
 */
export function identifyPostHogUser(options: PostHogIdentifyOptions): void {
  const { apiKey, host = "https://us.i.posthog.com", userId, anonymousId } = options;
  fetch(`${host}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      event: "$identify",
      distinct_id: userId,
      timestamp: new Date().toISOString(),
      properties: {
        $anon_distinct_id: anonymousId,
        $lib: "tempo-analytics",
      },
    }),
  }).catch(() => {
    // Swallow — telemetry must never crash the app
  });
}

/**
 * Returns an AnalyticsSink that POSTs events to PostHog's capture API via fetch.
 * No external SDK dependency — uses the platform fetch available in Node 18+ and browsers.
 * Telemetry failures are swallowed: this sink never throws or rejects.
 */
export function createPostHogSink(options: PostHogSinkOptions): (event: AnalyticsEvent) => void {
  const { apiKey, host = "https://us.i.posthog.com", distinctId = "tempo-anonymous" } = options;

  return (event: AnalyticsEvent): void => {
    fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event: event.name,
        distinct_id: distinctId,
        timestamp: event.occurredAt,
        properties: {
          ...event.payload,
          $lib: "tempo-analytics",
          tier: event.tier,
        },
      }),
    }).catch(() => {
      // Swallow — telemetry must never crash the app
    });
  };
}
