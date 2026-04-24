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
