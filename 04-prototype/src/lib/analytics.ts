import {
  buildDashboardViewed,
  buildSourceOpenError,
  buildSourceOpened,
  buildStoryExpanded,
  emitAnalyticsEvent,
} from "@tempo/analytics";

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
