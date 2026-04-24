import {
  buildDashboardViewed,
  buildSourceOpenError,
  buildSourceOpened,
  buildStoryExpanded,
  createPostHogSink,
  emitAnalyticsEvent,
  setAnalyticsSink,
} from "@tempo/analytics";

/**
 * Wire PostHog as the analytics sink. Call once at app startup (e.g. main.tsx).
 * Reads VITE_POSTHOG_API_KEY and optional VITE_POSTHOG_HOST from the Vite env.
 * No-op when the key is absent — analytics failures must never crash the app.
 */
export function initPostHog(): void {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const apiKey = env?.VITE_POSTHOG_API_KEY;
  if (!apiKey) return;
  const host = env?.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";

  let distinctId = "tempo-anonymous";
  try {
    const stored = sessionStorage.getItem("tempo_sid");
    if (stored) {
      distinctId = stored;
    } else {
      distinctId = `tempo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      sessionStorage.setItem("tempo_sid", distinctId);
    }
  } catch {
    // sessionStorage unavailable (privacy mode, SSR) — use anonymous ID
  }

  setAnalyticsSink(createPostHogSink({ apiKey, host, distinctId }));
}

export function trackDashboardViewed(): void {
  emitAnalyticsEvent(buildDashboardViewed({ route: "/dashboard" }));
}

export function trackStoryExpanded(storyId: string): void {
  emitAnalyticsEvent(buildStoryExpanded({ storyId }));
}

export function trackSourceOpened(storyId: string, sourceId: string): void {
  emitAnalyticsEvent(buildSourceOpened({ storyId, sourceId }));
}

export function trackSourceOpenError(payload: {
  storyId?: string;
  sourceId?: string;
  message: string;
  code?: string;
}): void {
  emitAnalyticsEvent(buildSourceOpenError(payload));
}
