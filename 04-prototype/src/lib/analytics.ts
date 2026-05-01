import {
  buildDashboardViewed,
  buildLandingViewed,
  buildLandingCtaClicked,
  buildLandingSucceeded,
  buildLandingFailed,
  buildOnboardingCompleted,
  buildOnboardingSubmitted,
  buildOnboardingViewed,
  buildSourceOpenError,
  buildSourceOpened,
  buildStoryExpanded,
  createPostHogSink,
  emitAnalyticsEvent,
  setAnalyticsSink,
  type LandingFailedPayload,
} from "@tempo/analytics";

// Falls back through sessionStorage (legacy key tempo_sid) to a generated value.
// Never throws in privacy/SSR contexts.
function resolveDistinctId(): string {
  const generate = () =>
    `tempo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  try {
    const fromLocal = localStorage.getItem("tempo_did");
    if (fromLocal) return fromLocal;
  } catch { /* localStorage blocked */ }

  try {
    const fromSession = sessionStorage.getItem("tempo_sid");
    if (fromSession) {
      try { localStorage.setItem("tempo_did", fromSession); } catch { /* blocked */ }
      return fromSession;
    }
  } catch { /* sessionStorage blocked */ }

  const id = generate();
  try { localStorage.setItem("tempo_did", id); } catch { /* blocked */ }
  try { sessionStorage.setItem("tempo_sid", id); } catch { /* blocked */ }
  return id;
}

// Anon→identified user stitching is intentionally absent: the prototype uses a
// lightweight ProtoSession marker rather than real Supabase auth, so there is no
// stable user ID to $identify against in PostHog until full auth is wired.

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
  setAnalyticsSink(createPostHogSink({ apiKey, host, distinctId: resolveDistinctId() }));
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

export function trackLandingViewed(): void {
  emitAnalyticsEvent(buildLandingViewed({ route: "/" }));
}

export function trackLandingCtaClicked(): void {
  emitAnalyticsEvent(buildLandingCtaClicked({ route: "/" }));
}

export function trackLandingSucceeded(destination: "dashboard" | "onboarding"): void {
  emitAnalyticsEvent(buildLandingSucceeded({ route: "/", destination }));
}

export function trackLandingFailed(payload: Omit<LandingFailedPayload, "route">): void {
  emitAnalyticsEvent(buildLandingFailed({ route: "/", ...payload }));
}

export function trackOnboardingViewed(): void {
  emitAnalyticsEvent(buildOnboardingViewed({ route: "/onboarding" }));
}

export function trackOnboardingSubmitted(): void {
  emitAnalyticsEvent(buildOnboardingSubmitted({ route: "/onboarding" }));
}

export function trackOnboardingCompleted(): void {
  emitAnalyticsEvent(buildOnboardingCompleted({ route: "/onboarding" }));
}
