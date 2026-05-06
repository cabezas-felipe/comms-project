import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { fetchSettingsPayload, saveSettingsPayload } from "@/lib/settings-api";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "test-token", user: { id: "test-user-id" } } },
      }),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  getProtoSession: vi.fn().mockReturnValue(null),
}));

describe("settings-api", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("loads default validated settings payload when API is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const payload = await fetchSettingsPayload();
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.topics.length).toBeGreaterThan(0);
  });

  it("persists and reloads saved settings via API", async () => {
    const apiStore = {
      contractVersion: CONTRACT_VERSION,
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
      traditionalSources: ["Reuters"],
      socialSources: ["@latamwatcher"],
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (typeof input === "string" && input.includes("/api/settings")) {
        if (init?.method === "PUT") {
          return {
            ok: true,
            status: 200,
            json: async () => apiStore,
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => apiStore,
        } as Response;
      }
      throw new Error("Unexpected fetch call");
    });

    const saved = await saveSettingsPayload({
      contractVersion: CONTRACT_VERSION,
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
      traditionalSources: ["Reuters"],
      socialSources: ["@latamwatcher"],
    });
    expect(saved.keywords[0]).toBe("OFAC");

    const reloaded = await fetchSettingsPayload();
    expect(reloaded.topics).toEqual(["Diplomatic relations"]);
    expect(reloaded.socialSources).toContain("@latamwatcher");
  });
});

describe("saveSettingsPayload — empty settings (both-models-failed path)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("accepts and persists an all-empty settings payload without throwing", async () => {
    const emptyPayload = {
      contractVersion: CONTRACT_VERSION,
      topics: [] as string[],
      keywords: [] as string[],
      geographies: [] as string[],
      traditionalSources: [] as string[],
      socialSources: [] as string[],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => emptyPayload,
    } as Response);
    const result = await saveSettingsPayload(emptyPayload);
    expect(result.topics).toEqual([]);
    expect(result.keywords).toEqual([]);
    expect(result.geographies).toEqual([]);
    expect(result.traditionalSources).toEqual([]);
    expect(result.socialSources).toEqual([]);
  });

  it("falls back to localStorage with empty arrays when API is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const emptyPayload = {
      contractVersion: CONTRACT_VERSION,
      topics: [] as string[],
      keywords: [] as string[],
      geographies: [] as string[],
      traditionalSources: [] as string[],
      socialSources: [] as string[],
    };
    const result = await saveSettingsPayload(emptyPayload);
    expect(result.topics).toEqual([]);
    expect(result.keywords).toEqual([]);
  });
});

describe("fetchSettingsPayload — identity-bound fallback policy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("throws when API fails and user has a Supabase session (bearer path)", async () => {
    const { supabase } = await import("@/lib/supabase");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-token", user: { id: "test-user-id" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(fetchSettingsPayload()).rejects.toThrow(
      "Identity-bound settings read failed: API unavailable."
    );
  });

  it("throws when API fails and proto session is active (email_recognition path)", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(fetchSettingsPayload()).rejects.toThrow(
      "Identity-bound settings read failed: API unavailable."
    );
  });

  it("falls back to localStorage when API fails and no identity is present", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue(null);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const payload = await fetchSettingsPayload();
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.topics.length).toBeGreaterThan(0);
  });
});

describe("saveSettingsPayload — identity-bound fallback policy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("throws when API fails and user has a Supabase session (bearer path)", async () => {
    const { supabase } = await import("@/lib/supabase");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-token", user: { id: "test-user-id" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(
      saveSettingsPayload({
        contractVersion: CONTRACT_VERSION,
        topics: ["Diplomatic relations"],
        keywords: ["OFAC"],
        geographies: ["US"],
        traditionalSources: ["Reuters"],
        socialSources: [],
      })
    ).rejects.toThrow("Identity-bound settings write failed: API unavailable.");
  });

  it("throws when API fails and proto session is active (email_recognition path)", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(
      saveSettingsPayload({
        contractVersion: CONTRACT_VERSION,
        topics: ["Topic"],
        keywords: [],
        geographies: [],
        traditionalSources: [],
        socialSources: [],
      })
    ).rejects.toThrow("Identity-bound settings write failed: API unavailable.");
  });
});

// ─── MVP recognized-identity fallback — per-user storage isolation ────────────

describe("settings-api — MVP recognized-identity fallback", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("uses proto session userId as localStorage key after successful API fetch", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "proto-user-123" });

    const apiPayload = {
      contractVersion: CONTRACT_VERSION,
      topics: ["Test Topic"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => apiPayload,
    } as Response);

    await fetchSettingsPayload();

    // The scoped key (not the global key) must have been written
    const scopedKey = "tempo.settings.v1.proto-user-123";
    expect(localStorage.getItem(scopedKey)).not.toBeNull();
    expect(localStorage.getItem("tempo.settings.v1")).toBeNull();
  });

  it("sends only x-recognized-email header (no userId) when no Supabase session", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "proto-user-123" });

    let capturedHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {})
      );
      return { ok: true, status: 200, json: async () => ({
        contractVersion: CONTRACT_VERSION,
        topics: [],
        keywords: [],
        geographies: [],
        traditionalSources: [],
        socialSources: [],
      }) } as Response;
    });

    await fetchSettingsPayload();

    expect(capturedHeaders["x-recognized-email"]).toBe("user@example.com");
    // userId must NOT be sent from the client — server resolves identity from email only
    expect(capturedHeaders["x-recognized-user-id"]).toBeUndefined();
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("per-user localStorage keys prevent cross-user data reads", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    // Seed user-a's scoped key directly in localStorage
    localStorage.setItem("tempo.settings.v1.user-a", JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      topics: ["User A's Topic"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    }));

    // User B: no proto session (unauthenticated) — reads from global key, not user-a's key
    vi.mocked(getProtoSession).mockReturnValue(null);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const payloadB = await fetchSettingsPayload();

    // User B must not see User A's scoped data
    expect(payloadB.topics).not.toContain("User A's Topic");
  });
});

describe("saveSettingsPayload — _meta pass-through", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns _meta.extractionStatus from API response when present", async () => {
    const apiResponse = {
      contractVersion: CONTRACT_VERSION,
      topics: ["Diplomatic relations"],
      keywords: [],
      geographies: ["US"],
      traditionalSources: [],
      socialSources: [],
      _meta: { extractionStatus: "succeeded" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => apiResponse,
    } as Response);

    const result = await saveSettingsPayload(
      { contractVersion: CONTRACT_VERSION, topics: ["Diplomatic relations"], keywords: [], geographies: ["US"], traditionalSources: [], socialSources: [] },
      { onboardingRawText: "Colombia diplomacy." }
    );
    expect(result._meta?.extractionStatus).toBe("succeeded");
  });

  it("returns _meta.extractionStatus === 'failed' when API signals failure", async () => {
    const apiResponse = {
      contractVersion: CONTRACT_VERSION,
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
      _meta: { extractionStatus: "failed" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => apiResponse,
    } as Response);

    const result = await saveSettingsPayload(
      { contractVersion: CONTRACT_VERSION, topics: [], keywords: [], geographies: [], traditionalSources: [], socialSources: [] },
      { onboardingRawText: "some text" }
    );
    expect(result._meta?.extractionStatus).toBe("failed");
  });

  it("returns no _meta when API response omits it", async () => {
    const apiResponse = {
      contractVersion: CONTRACT_VERSION,
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => apiResponse,
    } as Response);

    const result = await saveSettingsPayload(
      { contractVersion: CONTRACT_VERSION, topics: [], keywords: [], geographies: [], traditionalSources: [], socialSources: [] }
    );
    expect(result._meta).toBeUndefined();
  });
});

