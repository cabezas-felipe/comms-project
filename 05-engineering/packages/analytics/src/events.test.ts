import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsEventSchema,
  buildAuthCtaClicked,
  buildAuthStarted,
  buildAuthSucceeded,
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

describe("buildAuthCtaClicked", () => {
  it("builds a secondary event for login ctaType", () => {
    const e = buildAuthCtaClicked({ ctaType: "login", route: "/" });
    expect(e.name).toBe("auth_cta_clicked");
    expect(e.tier).toBe("secondary");
    expect(e.payload.ctaType).toBe("login");
  });

  it("builds a secondary event for signup ctaType", () => {
    const e = buildAuthCtaClicked({ ctaType: "signup", route: "/" });
    expect(e.payload.ctaType).toBe("signup");
  });

  it("rejects invalid ctaType", () => {
    expect(() =>
      buildAuthCtaClicked({ ctaType: "unknown" as "login", route: "/" })
    ).toThrow();
  });
});

describe("buildAuthStarted", () => {
  it("builds a primary event for login mode", () => {
    const e = buildAuthStarted({ mode: "login", route: "/auth/login", authAttemptId: "att_1_abc" });
    expect(e.name).toBe("auth_started");
    expect(e.tier).toBe("primary");
    expect(e.payload.mode).toBe("login");
    expect(e.payload.authAttemptId).toBe("att_1_abc");
  });

  it("builds a primary event for signup mode", () => {
    const e = buildAuthStarted({ mode: "signup", route: "/auth/signup", authAttemptId: "att_2_def" });
    expect(e.payload.mode).toBe("signup");
  });

  it("rejects invalid mode", () => {
    expect(() =>
      buildAuthStarted({ mode: "magic" as "login", route: "/auth/login", authAttemptId: "att_x" })
    ).toThrow();
  });

  it("rejects missing authAttemptId", () => {
    expect(() =>
      buildAuthStarted({ mode: "login", route: "/auth/login" } as Parameters<typeof buildAuthStarted>[0])
    ).toThrow();
  });

  it("rejects empty authAttemptId", () => {
    expect(() =>
      buildAuthStarted({ mode: "login", route: "/auth/login", authAttemptId: "" })
    ).toThrow();
  });
});

describe("buildAuthSucceeded", () => {
  it("builds a primary event for login mode", () => {
    const e = buildAuthSucceeded({ mode: "login", route: "/auth/callback", authAttemptId: "att_1_abc" });
    expect(e.name).toBe("auth_succeeded");
    expect(e.tier).toBe("primary");
    expect(e.payload.mode).toBe("login");
    expect(e.payload.authAttemptId).toBe("att_1_abc");
  });

  it("builds a primary event for signup mode", () => {
    const e = buildAuthSucceeded({ mode: "signup", route: "/auth/callback", authAttemptId: "att_2_def" });
    expect(e.payload.mode).toBe("signup");
  });

  it("rejects invalid mode", () => {
    expect(() =>
      buildAuthSucceeded({ mode: "magic" as "login", route: "/auth/callback", authAttemptId: "att_x" })
    ).toThrow();
  });

  it("rejects missing authAttemptId", () => {
    expect(() =>
      buildAuthSucceeded({ mode: "login", route: "/auth/callback" } as Parameters<typeof buildAuthSucceeded>[0])
    ).toThrow();
  });

  it("rejects empty authAttemptId", () => {
    expect(() =>
      buildAuthSucceeded({ mode: "login", route: "/auth/callback", authAttemptId: "" })
    ).toThrow();
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
