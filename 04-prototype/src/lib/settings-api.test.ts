import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { ExtractionApiError, extractOnboardingText, fetchSettingsPayload, saveSettingsPayload } from "@/lib/settings-api";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "test-token", user: { id: "test-user-id" } } },
      }),
    },
  },
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

describe("fetchSettingsPayload — auth-aware fallback policy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("throws when API fails and user is authenticated", async () => {
    const { supabase } = await import("@/lib/supabase");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-token", user: { id: "test-user-id" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(fetchSettingsPayload()).rejects.toThrow(
      "Authenticated settings read failed (API unavailable)."
    );
  });

  it("falls back to localStorage when API fails and user is unauthenticated", async () => {
    const { supabase } = await import("@/lib/supabase");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const payload = await fetchSettingsPayload();
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.topics.length).toBeGreaterThan(0);
  });
});

describe("saveSettingsPayload — auth-aware fallback policy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("throws when API fails and user is authenticated", async () => {
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
    ).rejects.toThrow("Authenticated settings write failed (API unavailable).");
  });
});

describe("extractOnboardingText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws ExtractionApiError with status 500 when API returns 500", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: "Extraction failed: all configured models unavailable." }),
    } as Response);
    await expect(extractOnboardingText("some text")).rejects.toMatchObject({
      name: "ExtractionApiError",
      status: 500,
    });
  });

  it("ExtractionApiError is also an instance of Error", async () => {
    const err = new ExtractionApiError(500);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ExtractionApiError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/500/);
  });

  it("throws ExtractionApiError with correct status for non-500 failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);
    await expect(extractOnboardingText("some text")).rejects.toMatchObject({
      name: "ExtractionApiError",
      status: 404,
    });
  });
});
