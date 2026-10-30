import type { AnalyticsEvent } from "./events.js";

export type AnalyticsSink = (event: AnalyticsEvent) => void;

let sink: AnalyticsSink | null = null;

export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
}

function defaultSink(event: AnalyticsEvent): void {
  const inTest = typeof process !== "undefined" && process.env.NODE_ENV === "test";
  const dev =
    !inTest &&
    typeof import.meta !== "undefined" &&
    Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  if (dev) {
    console.debug("[tempo.analytics]", event.name, event.tier, event.payload);
  }
}

/**
 * Forward a pre-validated analytics event to the configured sink.
 * Use analyticsEventSchema.parse() before this call when receiving events from
 * untrusted/external sources.
 */
export function emitAnalyticsEvent(event: AnalyticsEvent): AnalyticsEvent {
  (sink ?? defaultSink)(event);
  return event;
}
