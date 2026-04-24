import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostHogSink } from "./posthog-sink.js";
import { buildDashboardViewed, buildApiDashboardRequested, buildApiError } from "./events.js";

describe("createPostHogSink", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a callable sink function", () => {
    expect(typeof createPostHogSink({ apiKey: "phc-test" })).toBe("function");
  });

  it("POSTs event to the PostHog capture endpoint", async () => {
    const sink = createPostHogSink({ apiKey: "phc-test", host: "https://ph.test", distinctId: "user-1" });
    sink(buildDashboardViewed({ route: "/dashboard" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ph.test/capture/");
    const body = JSON.parse(init.body as string);
    expect(body.api_key).toBe("phc-test");
    expect(body.event).toBe("dashboard_viewed");
    expect(body.distinct_id).toBe("user-1");
    expect(body.properties.tier).toBe("primary");
    expect(body.properties.$lib).toBe("tempo-analytics");
  });

  it("uses default PostHog host when not specified", async () => {
    const sink = createPostHogSink({ apiKey: "phc-test" });
    sink(buildDashboardViewed({ route: "/" }));
    await new Promise((r) => setTimeout(r, 0));
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/capture/");
  });

  it("uses default distinctId when not specified", async () => {
    const sink = createPostHogSink({ apiKey: "phc-test" });
    sink(buildDashboardViewed({ route: "/" }));
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.distinct_id).toBe("tempo-anonymous");
  });

  it("swallows fetch errors without throwing", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const sink = createPostHogSink({ apiKey: "phc-test" });
    expect(() => sink(buildDashboardViewed({ route: "/" }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("captures server-side api_dashboard_requested event", async () => {
    const sink = createPostHogSink({ apiKey: "phc-test" });
    const event = buildApiDashboardRequested({
      storyCount: 5, normErrorCount: 0, limitApplied: 10,
      fallbackCount: 1, totalCostUsd: 0.000042, aiModel: "mock-openai-mini",
    });
    sink(event);
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.event).toBe("api_dashboard_requested");
    expect(body.properties.tier).toBe("primary");
    expect(body.properties.storyCount).toBe(5);
  });

  it("captures server-side api_error event", async () => {
    const sink = createPostHogSink({ apiKey: "phc-test" });
    sink(buildApiError({ route: "/api/dashboard", statusCode: 500, message: "fail" }));
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.event).toBe("api_error");
    expect(body.properties.tier).toBe("guardrail");
    expect(body.properties.statusCode).toBe(500);
  });
});
