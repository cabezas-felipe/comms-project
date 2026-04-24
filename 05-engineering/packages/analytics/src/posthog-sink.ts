import type { AnalyticsEvent } from "./events.js";

export interface PostHogSinkOptions {
  apiKey: string;
  host?: string;
  distinctId?: string;
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
