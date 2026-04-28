import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsEventSchema,
  buildDashboardViewed,
  buildLandingViewed,
  buildOnboardingCompleted,
  buildOnboardingSubmitted,
  buildOnboardingViewed,
  buildSourceOpenError,
  buildSourceOpened,
  buildStoryExpanded,
  emitAnalyticsEvent,
} from "./index.js";
import { setAnalyticsSink } from "./sink.js";


afterEach(() => {
  setAnalyticsSink(null);
});

describe("analyticsEventSchema", () => {
  it("rejects invalid event names", () => {
    expect(() =>
      analyticsEventSchema.parse({
        name: "unknown",
        tier: "primary",
        occurredAt: new Date().toISOString(),
        payload: {},
      })
    ).toThrow();
  });

  it("accepts dashboard_viewed", () => {
    const e = buildDashboardViewed({ route: "/dashboard" });
    expect(e.tier).toBe("primary");
    expect(emitAnalyticsEvent(e).name).toBe("dashboard_viewed");
  });

  it("accepts source_open_error guardrail", () => {
    const e = buildSourceOpenError({
      storyId: "s1",
      sourceId: "x",
      message: "network failed",
    });
    expect(e.tier).toBe("guardrail");
    emitAnalyticsEvent(e);
  });
});

describe("buildStoryExpanded", () => {
  it("builds a secondary event with the given storyId", () => {
    const e = buildStoryExpanded({ storyId: "story-42" });
    expect(e.name).toBe("story_expanded");
    expect(e.tier).toBe("secondary");
    expect(e.payload.storyId).toBe("story-42");
  });

  it("rejects empty storyId", () => {
    expect(() => buildStoryExpanded({ storyId: "" })).toThrow();
  });
});

describe("buildSourceOpened", () => {
  it("builds a secondary event with storyId and sourceId", () => {
    const e = buildSourceOpened({ storyId: "story-1", sourceId: "src-2" });
    expect(e.name).toBe("source_opened");
    expect(e.tier).toBe("secondary");
    expect(e.payload.sourceId).toBe("src-2");
  });

  it("rejects missing sourceId", () => {
    expect(() =>
      buildSourceOpened({ storyId: "s1", sourceId: "" })
    ).toThrow();
  });
});

describe("buildSourceOpenError", () => {
  it("builds a guardrail event with the given message", () => {
    const e = buildSourceOpenError({ message: "fetch failed" });
    expect(e.name).toBe("source_open_error");
    expect(e.tier).toBe("guardrail");
    expect(e.payload.message).toBe("fetch failed");
  });

  it("rejects empty message", () => {
    expect(() => buildSourceOpenError({ message: "" })).toThrow();
  });
});

describe("buildLandingViewed", () => {
  it("builds a primary event with the given route", () => {
    const e = buildLandingViewed({ route: "/" });
    expect(e.name).toBe("landing_viewed");
    expect(e.tier).toBe("primary");
    expect(e.payload.route).toBe("/");
  });

  it("rejects empty route", () => {
    expect(() => buildLandingViewed({ route: "" })).toThrow();
  });
});

describe("buildOnboardingViewed", () => {
  it("builds a primary event with the given route", () => {
    const e = buildOnboardingViewed({ route: "/onboarding" });
    expect(e.name).toBe("onboarding_viewed");
    expect(e.tier).toBe("primary");
    expect(e.payload.route).toBe("/onboarding");
  });

  it("rejects empty route", () => {
    expect(() => buildOnboardingViewed({ route: "" })).toThrow();
  });
});

describe("buildOnboardingSubmitted", () => {
  it("builds a secondary event with the given route", () => {
    const e = buildOnboardingSubmitted({ route: "/onboarding" });
    expect(e.name).toBe("onboarding_submitted");
    expect(e.tier).toBe("secondary");
    expect(e.payload.route).toBe("/onboarding");
  });

  it("rejects empty route", () => {
    expect(() => buildOnboardingSubmitted({ route: "" })).toThrow();
  });
});

describe("buildOnboardingCompleted", () => {
  it("builds a primary event with the given route", () => {
    const e = buildOnboardingCompleted({ route: "/onboarding" });
    expect(e.name).toBe("onboarding_completed");
    expect(e.tier).toBe("primary");
    expect(e.payload.route).toBe("/onboarding");
  });

  it("rejects empty route", () => {
    expect(() => buildOnboardingCompleted({ route: "" })).toThrow();
  });
});

describe("setAnalyticsSink", () => {
  it("routes emitted events to a custom sink", () => {
    const received: string[] = [];
    setAnalyticsSink((e) => received.push(e.name));

    emitAnalyticsEvent(buildDashboardViewed({ route: "/dashboard" }));
    emitAnalyticsEvent(buildStoryExpanded({ storyId: "s1" }));

    expect(received).toEqual(["dashboard_viewed", "story_expanded"]);
  });

  it("restores default behavior when sink is set to null", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    setAnalyticsSink(() => {});
    setAnalyticsSink(null);

    emitAnalyticsEvent(buildDashboardViewed({ route: "/dashboard" }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
