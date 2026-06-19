import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { fetchSettingsPayload, saveSettingsPayload, SaveSettingsError } from "@/lib/settings-api";

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
    // Phase 1 trust cleanup: defaults are fully empty.  The bootstrap path
    // returns a schema-valid payload with no fabricated taxonomy or sources.
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.topics).toEqual([]);
    expect(payload.keywords).toEqual([]);
    expect(payload.geographies).toEqual([]);
    expect(payload.traditionalSources).toEqual([]);
    expect(payload.socialSources).toEqual([]);
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
    // Phase 1 trust cleanup: default settings are fully empty.  The fallback
    // returns the empty default rather than a fabricated baseline.
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.topics).toEqual([]);
    expect(payload.keywords).toEqual([]);
    expect(payload.geographies).toEqual([]);
    expect(payload.traditionalSources).toEqual([]);
    expect(payload.socialSources).toEqual([]);
  });
});

describe("saveSettingsPayload — identity-bound fallback policy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("throws SaveSettingsError when API fails and user has a Supabase session (bearer path)", async () => {
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
    ).rejects.toBeInstanceOf(SaveSettingsError);
  });

  it("throws SaveSettingsError when API fails and proto session is active (email_recognition path)", async () => {
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
    ).rejects.toBeInstanceOf(SaveSettingsError);
  });
});

// ─── MVP recognized-identity fallback — per-user storage isolation ────────────

describe("settings-api — MVP recognized-identity fallback", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("DEFAULT mode: Bearer wins over recognized-email + storage isolates by Supabase session id", async () => {
    // No E2E override → production-safe precedence (High-finding fix). Auth header
    // and storage key both follow the Bearer/Supabase session, not the proto user.
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-token", user: { id: "supa-user-1" } } },
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

    expect(capturedHeaders["Authorization"]).toBe("Bearer test-token");
    expect(capturedHeaders["x-recognized-email"]).toBeUndefined();
    // No client-side userId leakage even in default mode.
    expect(capturedHeaders["x-recognized-user-id"]).toBeUndefined();
    // Storage isolates by the Supabase session id, not the proto user.
    expect(localStorage.getItem("tempo.settings.v1.supa-user-1")).not.toBeNull();
    expect(localStorage.getItem("tempo.settings.v1.proto-user-123")).toBeNull();
  });

  it("E2E override mode: prefers recognized-email over Bearer + storage isolates by recognized identity", async () => {
    vi.stubEnv("VITE_E2E_IDENTITY_PRECEDENCE", "recognized_email");
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-token", user: { id: "supa-user-1" } } },
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
    expect(capturedHeaders["Authorization"]).toBeUndefined();
    expect(capturedHeaders["x-recognized-user-id"]).toBeUndefined();
    // Storage isolation follows recognized identity, not stale Supabase session.
    expect(localStorage.getItem("tempo.settings.v1.proto-user-123")).not.toBeNull();
    expect(localStorage.getItem("tempo.settings.v1.supa-user-1")).toBeNull();
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

describe("saveSettingsPayload — failure classification", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("throws SaveSettingsError with stage=backend for non-ok HTTP response", async () => {
    const { supabase } = await import("@/lib/supabase");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-token", user: { id: "test-user-id" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);

    const err = await saveSettingsPayload({
      contractVersion: CONTRACT_VERSION,
      topics: ["T"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SaveSettingsError);
    expect(err.stage).toBe("backend");
    expect(err.statusCode).toBe(503);
  });

  it("throws SaveSettingsError with stage=network when fetch throws", async () => {
    const { supabase } = await import("@/lib/supabase");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-token", user: { id: "test-user-id" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Failed to fetch"));

    const err = await saveSettingsPayload({
      contractVersion: CONTRACT_VERSION,
      topics: ["T"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SaveSettingsError);
    expect(err.stage).toBe("network");
    expect(err.statusCode).toBeUndefined();
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

  it("preserves _meta.refreshJobId (cold-start prefetch handle) when present", async () => {
    const apiResponse = {
      contractVersion: CONTRACT_VERSION,
      topics: ["Diplomatic relations"],
      keywords: [],
      geographies: ["US"],
      traditionalSources: [],
      socialSources: [],
      _meta: { extractionStatus: "succeeded", refreshJobId: "user-123" },
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
    expect(result._meta?.refreshJobId).toBe("user-123");
    // Extraction status is preserved alongside the job handle.
    expect(result._meta?.extractionStatus).toBe("succeeded");
  });

  it("preserves Step 1 viability metadata (totalSourceCount + onboardingViable) when present", async () => {
    // Viable onboarding shape: extraction succeeded, sources present, viable=true,
    // plus the cold-start handle. All four _meta fields must survive the client
    // pass-through unchanged (the client does no derivation — it trusts the API).
    const apiResponse = {
      contractVersion: CONTRACT_VERSION,
      topics: ["Diplomatic relations"],
      keywords: [],
      geographies: ["US"],
      traditionalSources: ["Reuters"],
      socialSources: ["@latamwatcher"],
      _meta: {
        extractionStatus: "succeeded",
        refreshJobId: "user-123",
        totalSourceCount: 2,
        onboardingViable: true,
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => apiResponse,
    } as Response);

    const result = await saveSettingsPayload(
      { contractVersion: CONTRACT_VERSION, topics: ["Diplomatic relations"], keywords: [], geographies: ["US"], traditionalSources: ["Reuters"], socialSources: ["@latamwatcher"] },
      { onboardingRawText: "Colombia diplomacy." }
    );
    expect(result._meta?.totalSourceCount).toBe(2);
    expect(result._meta?.onboardingViable).toBe(true);
    expect(result._meta?.extractionStatus).toBe("succeeded");
    expect(result._meta?.refreshJobId).toBe("user-123");
  });

  it("preserves the non-viable viability shape (onboardingViable=false, totalSourceCount=0) — falsy values are not dropped", async () => {
    // Regression guard: a `false`/`0` viability signal must pass through intact so
    // the client routes to Settings rather than mis-reading absent-as-viable.
    const apiResponse = {
      contractVersion: CONTRACT_VERSION,
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
      _meta: {
        extractionStatus: "succeeded",
        totalSourceCount: 0,
        onboardingViable: false,
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => apiResponse,
    } as Response);

    const result = await saveSettingsPayload(
      { contractVersion: CONTRACT_VERSION, topics: [], keywords: [], geographies: [], traditionalSources: [], socialSources: [] },
      { onboardingRawText: "thin narrative" }
    );
    expect(result._meta?.totalSourceCount).toBe(0);
    expect(result._meta?.onboardingViable).toBe(false);
    // No cold-start handle on a non-viable save.
    expect(result._meta?.refreshJobId).toBeUndefined();
  });
});

