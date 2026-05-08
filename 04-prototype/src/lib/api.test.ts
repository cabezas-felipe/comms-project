import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { fetchDashboardPayload, fetchDashboardWithMeta } from "@/lib/api";
import { STORIES } from "@/data/stories";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  getProtoSession: vi.fn().mockReturnValue(null),
}));

describe("fetchDashboardPayload", () => {
  it("returns a contract-validated dashboard payload from HTTP response", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
      }),
    });
    const payload = await fetchDashboardPayload({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.stories.length).toBeGreaterThan(0);
  });

  it("retries and then falls back to local payload", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const payload = await fetchDashboardPayload({
      fetcher,
      retries: 2,
      sleep,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.stories.length).toBe(STORIES.length);
  });

  it("falls back immediately when retries is 0", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const payload = await fetchDashboardPayload({ fetcher, retries: 0, sleep });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.stories.length).toBe(STORIES.length);
  });

  it("falls back to local payload when server returns HTTP error", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const payload = await fetchDashboardPayload({ fetcher, retries: 1, sleep });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.stories.length).toBe(STORIES.length);
  });

  it("falls back to local payload when server response fails contract validation", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: "wrong-version", stories: [] }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const payload = await fetchDashboardPayload({ fetcher, retries: 1, sleep });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
  });

  it("Phase 2: fetchDashboardWithMeta surfaces _meta.selection from API response", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          refreshedAt: "2026-05-08T00:00:00Z",
          hasSnapshot: true,
          selection: {
            sourceSelectionMode: "fallback",
            sourceFallbackUsed: true,
            sourceFallbackReason: "no_selected_sources",
            matchedSourceCount: 0,
            selectedSourceCount: 0,
            unmatchedSelectedSources: [],
            unavailableConnectorCount: 0,
            relevantItemCount: 0,
          },
        },
      }),
    });
    const { payload, selection } = await fetchDashboardWithMeta({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(selection).not.toBeNull();
    expect(selection?.sourceSelectionMode).toBe("fallback");
    expect(selection?.sourceFallbackUsed).toBe(true);
    expect(selection?.sourceFallbackReason).toBe("no_selected_sources");
  });

  it("Phase 2: fetchDashboardWithMeta returns selection=null when API omits _meta.selection", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }),
    });
    const { selection } = await fetchDashboardWithMeta({ fetcher });
    expect(selection).toBeNull();
  });

  it("Phase 4: fetchDashboardWithMeta tolerates new optional _meta fields (unchanged/watermark/refreshSkippedReason)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          refreshedAt: "2026-05-08T00:00:00Z",
          hasSnapshot: true,
          unchanged: true,
          refreshSkippedReason: "unchanged_watermark",
          watermark: "wm-abc",
          candidateCount: 5,
          selectedFeedCount: 2,
        },
      }),
    });
    const { payload, selection } = await fetchDashboardWithMeta({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    // No selection field provided here — parser must not throw and just returns null
    expect(selection).toBeNull();
  });

  it("Phase 4: fetchDashboardWithMeta tolerates refreshSkippedReason=in_flight without selection meta", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          hasSnapshot: true,
          refreshSkippedReason: "in_flight",
          unchanged: false,
        },
      }),
    });
    const { payload } = await fetchDashboardWithMeta({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
  });

  it("Phase 2: fetchDashboardWithMeta tolerates malformed _meta.selection (returns null without throwing)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { selection: { sourceSelectionMode: "not-a-valid-mode" } },
      }),
    });
    const { selection } = await fetchDashboardWithMeta({ fetcher });
    expect(selection).toBeNull();
  });

  it("rethrows AbortError immediately without retrying or sleeping", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetcher = vi.fn().mockRejectedValue(abortError);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchDashboardPayload({ fetcher, retries: 2, sleep })
    ).rejects.toThrow("aborted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("fetchDashboardPayload — identity header propagation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Authorization Bearer when Supabase session is present (bearer takes precedence)", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-bearer-token", user: { id: "u1" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });

    let capturedHeaders: Record<string, string> = {};
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return { ok: true, status: 200, json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }) } as Response;
    });

    await fetchDashboardPayload({ fetcher, retries: 0 });

    expect(capturedHeaders["Authorization"]).toBe("Bearer test-bearer-token");
    expect(capturedHeaders["x-recognized-email"]).toBeUndefined();
  });

  it("sends x-recognized-email when no bearer but proto session exists", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });

    let capturedHeaders: Record<string, string> = {};
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    });

    await fetchDashboardPayload({ fetcher, retries: 0 });

    expect(capturedHeaders["x-recognized-email"]).toBe("user@example.com");
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("sends no identity headers when neither bearer nor proto session is present", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue(null);

    let capturedHeaders: Record<string, string> = {};
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return { ok: false, status: 401, json: async () => ({}) } as Response;
    });

    await fetchDashboardPayload({ fetcher, retries: 0 });

    expect(capturedHeaders["Authorization"]).toBeUndefined();
    expect(capturedHeaders["x-recognized-email"]).toBeUndefined();
  });
});
