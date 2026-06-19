import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CONTRACT_VERSION } from "@tempo/contracts";
import Onboarding from "@/pages/Onboarding";
import * as analytics from "@/lib/analytics";
import * as settingsApi from "@/lib/settings-api";
import { SaveSettingsError } from "@/lib/settings-api";
import * as notify from "@/lib/notify";

vi.mock("@/lib/analytics", () => ({
  trackOnboardingViewed: vi.fn(),
  trackOnboardingCtaClicked: vi.fn(),
  trackOnboardingSucceeded: vi.fn(),
  trackOnboardingFailed: vi.fn(),
}));

vi.mock("@/lib/voice-upload", () => ({
  transcribeAudio: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({
  notifyWarning: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/lib/settings-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings-api")>();
  return { ...actual, saveSettingsPayload: vi.fn() };
});

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const BASE_PAYLOAD = {
  contractVersion: CONTRACT_VERSION,
  topics: [],
  keywords: [],
  geographies: [],
  traditionalSources: [],
  socialSources: [],
};

function renderOnboarding() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Onboarding />
    </MemoryRouter>
  );
}

async function submitWithText(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), text);
  await user.click(screen.getByRole("button", { name: /set the tempo/i }));
}

describe("Onboarding — analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits trackOnboardingViewed on mount", () => {
    renderOnboarding();
    expect(vi.mocked(analytics.trackOnboardingViewed)).toHaveBeenCalledOnce();
  });

  it("emits trackOnboardingCtaClicked on any submit attempt", async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(screen.getByRole("button", { name: /set the tempo/i }));
    expect(vi.mocked(analytics.trackOnboardingCtaClicked)).toHaveBeenCalledOnce();
  });

  it("emits trackOnboardingFailed validation empty when topics is blank", async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(screen.getByRole("button", { name: /set the tempo/i }));
    expect(vi.mocked(analytics.trackOnboardingFailed)).toHaveBeenCalledWith({
      failureStage: "validation",
      validationReason: "empty",
    });
    expect(vi.mocked(analytics.trackOnboardingSucceeded)).not.toHaveBeenCalled();
  });

  it("emits trackOnboardingFailed backend with statusCode when save throws SaveSettingsError(backend)", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockRejectedValueOnce(
      new SaveSettingsError("backend", 503)
    );
    renderOnboarding();
    await submitWithText("Colombia diplomacy.");
    await waitFor(() => {
      expect(vi.mocked(analytics.trackOnboardingFailed)).toHaveBeenCalledWith({
        failureStage: "backend",
        statusCode: 503,
      });
    });
    expect(vi.mocked(analytics.trackOnboardingSucceeded)).not.toHaveBeenCalled();
  });

  it("emits trackOnboardingFailed network when save throws SaveSettingsError(network)", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockRejectedValueOnce(
      new SaveSettingsError("network")
    );
    renderOnboarding();
    await submitWithText("Colombia diplomacy.");
    await waitFor(() => {
      expect(vi.mocked(analytics.trackOnboardingFailed)).toHaveBeenCalledWith({
        failureStage: "network",
      });
    });
    expect(vi.mocked(analytics.trackOnboardingSucceeded)).not.toHaveBeenCalled();
  });

  it("emits trackOnboardingFailed backend (default) when save throws unknown error", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockRejectedValueOnce(new Error("unexpected"));
    renderOnboarding();
    await submitWithText("Colombia diplomacy.");
    await waitFor(() => {
      expect(vi.mocked(analytics.trackOnboardingFailed)).toHaveBeenCalledWith({
        failureStage: "backend",
      });
    });
  });

  it("emits trackOnboardingSucceeded on happy path", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce(BASE_PAYLOAD);
    renderOnboarding();
    await submitWithText("Colombia diplomacy.");
    await waitFor(() => {
      expect(vi.mocked(analytics.trackOnboardingSucceeded)).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(analytics.trackOnboardingFailed)).not.toHaveBeenCalled();
  });
});

describe("Onboarding — payload construction (no seeded defaults)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits empty arrays for keywords/geographies/traditionalSources/socialSources at first onboarding", async () => {
    // Regression guard: legacy code seeded keywords with "OFAC, sanctions, ..."
    // and geographies with ["US", "Colombia"]. When AI extraction failed those
    // unrelated seeds got persisted into the user's settings. The frontend now
    // sends empty arrays for every AI-derivable field; only `topics` carries
    // user input directly.
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce(BASE_PAYLOAD);
    renderOnboarding();
    await submitWithText("Watching Colombia–US bilateral relations.");

    await waitFor(() => {
      expect(vi.mocked(settingsApi.saveSettingsPayload)).toHaveBeenCalledOnce();
    });

    const [submittedPayload] = vi.mocked(settingsApi.saveSettingsPayload).mock.calls[0];
    expect(submittedPayload.keywords).toEqual([]);
    expect(submittedPayload.geographies).toEqual([]);
    expect(submittedPayload.traditionalSources).toEqual([]);
    expect(submittedPayload.socialSources).toEqual([]);
    // Belt and suspenders: none of the legacy seed strings appear anywhere.
    const blob = JSON.stringify(submittedPayload);
    for (const seed of ["OFAC", "sanctions", "deportation", "NYT", "Washington Post", "El Tiempo"]) {
      expect(blob).not.toContain(seed);
    }
  });

  it("baseline topics is a single-entry array containing the full trimmed narrative (no splitting)", async () => {
    // Regression guard: the baseline (pre-extraction) save used to split the
    // narrative on commas/newlines, producing fragmented topic chunks like
    // "Colombia–US bilateral" + "migration policy" + "I read NYT and El Tiempo".
    // The narrative is prose, not a delimited list — splitting it leaks garbage
    // into the persisted settings whenever the extraction pipeline fails. Now
    // baseline carries one entry: the full trimmed text.
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce(BASE_PAYLOAD);
    renderOnboarding();
    const narrative = "Colombia–US bilateral, migration policy. I read NYT and El Tiempo.";
    await submitWithText(narrative);

    await waitFor(() => {
      expect(vi.mocked(settingsApi.saveSettingsPayload)).toHaveBeenCalledOnce();
    });
    const [submittedPayload] = vi.mocked(settingsApi.saveSettingsPayload).mock.calls[0];
    expect(submittedPayload.topics).toEqual([narrative]);
    expect(submittedPayload.topics).toHaveLength(1);
  });

  it("trims surrounding whitespace before placing the narrative into topics", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce(BASE_PAYLOAD);
    renderOnboarding();
    await submitWithText("   Watching Colombia–US bilateral relations.   ");

    await waitFor(() => {
      expect(vi.mocked(settingsApi.saveSettingsPayload)).toHaveBeenCalledOnce();
    });
    const [submittedPayload] = vi.mocked(settingsApi.saveSettingsPayload).mock.calls[0];
    expect(submittedPayload.topics).toEqual(["Watching Colombia–US bilateral relations."]);
  });

  it("the second arg to saveSettingsPayload carries the raw narrative for backend extraction", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce(BASE_PAYLOAD);
    renderOnboarding();
    await submitWithText("  Watching Colombia–US.  ");

    await waitFor(() => {
      expect(vi.mocked(settingsApi.saveSettingsPayload)).toHaveBeenCalledOnce();
    });
    const [, opts] = vi.mocked(settingsApi.saveSettingsPayload).mock.calls[0];
    expect(opts?.onboardingRawText).toBe("Watching Colombia–US.");
  });
});

describe("Onboarding — extraction status toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Step 2 removed the extraction-failed warning toast on the success path —
  // routing to Settings is now the recovery affordance. These guard that the
  // toast never fires regardless of extraction outcome.
  it("never shows the extraction-failed warning toast, even when extraction failed", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "failed", onboardingViable: false },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    expect(notify.notifyWarning).not.toHaveBeenCalledWith(
      expect.stringContaining("issue on our side")
    );
  });

  it("does not show extraction warning toast when _meta.extractionStatus is 'succeeded'", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "succeeded" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(notify.notifySuccess).toHaveBeenCalled();
    });
    expect(notify.notifyWarning).not.toHaveBeenCalledWith(
      expect.stringContaining("issue on our side")
    );
  });

  it("does not show extraction warning toast when _meta is absent", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce(BASE_PAYLOAD);

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(notify.notifySuccess).toHaveBeenCalled();
    });
    expect(notify.notifyWarning).not.toHaveBeenCalled();
  });
});

describe("Onboarding — cold-start handoff (Slice 8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards coldStartJobId in navigate state when _meta.refreshJobId is present", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "succeeded", onboardingViable: true, refreshJobId: "user-abc" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    const [, opts] = mockNavigate.mock.calls[0];
    expect(opts.state).toEqual({
      bootstrap: true,
      forceRefresh: true,
      coldStartJobId: "user-abc",
    });
  });

  it("trims surrounding whitespace from refreshJobId before forwarding", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "succeeded", onboardingViable: true, refreshJobId: "  user-xyz  " },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    const [, opts] = mockNavigate.mock.calls[0];
    expect(opts.state.coldStartJobId).toBe("user-xyz");
  });

  it("omits coldStartJobId from navigate state when _meta.refreshJobId is absent", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "succeeded", onboardingViable: true },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    const [, opts] = mockNavigate.mock.calls[0];
    expect(opts.state).toEqual({ bootstrap: true, forceRefresh: true });
    expect(opts.state).not.toHaveProperty("coldStartJobId");
  });

  it("omits coldStartJobId when refreshJobId is blank/whitespace, navigating exactly as before", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "succeeded", onboardingViable: true, refreshJobId: "   " },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    const [, opts] = mockNavigate.mock.calls[0];
    expect(opts.state).toEqual({ bootstrap: true, forceRefresh: true });
  });

  it("does not throw and omits coldStartJobId when refreshJobId is a non-string value", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      // Simulate malformed backend meta: a non-string truthy value that would
      // throw if `.trim()` were called on it directly.
      _meta: { extractionStatus: "succeeded", onboardingViable: true, refreshJobId: 123 as unknown as string },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    // Save still succeeded — no error toast — and navigation omits the bad id.
    expect(notify.notifyError).not.toHaveBeenCalled();
    const [, opts] = mockNavigate.mock.calls[0];
    expect(opts.state).toEqual({ bootstrap: true, forceRefresh: true });
    expect(opts.state).not.toHaveProperty("coldStartJobId");
  });

  it("navigates with handoff state (no coldStartJobId) for a viable save without refreshJobId", async () => {
    // Fallback-viable: no onboardingViable flag, but extraction succeeded and the
    // returned payload carries a source — so viability is derived and the user
    // still lands on the dashboard, just without a cold-start job to join.
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      traditionalSources: ["Reuters"],
      _meta: { extractionStatus: "succeeded" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    const [dest, opts] = mockNavigate.mock.calls[0];
    expect(String(dest)).toMatch(/^\/dashboard/);
    expect(opts.state).toEqual({ bootstrap: true, forceRefresh: true });
  });
});

describe("Onboarding — viability routing (Step 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes to /dashboard with handoff state when onboarding is viable", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "succeeded", onboardingViable: true, refreshJobId: "user-abc" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    const [dest, opts] = mockNavigate.mock.calls[0];
    expect(String(dest)).toMatch(/^\/dashboard/);
    expect(opts.state).toEqual({
      bootstrap: true,
      forceRefresh: true,
      coldStartJobId: "user-abc",
    });
  });

  it("routes to /settings (no handoff state) when _meta.onboardingViable === false", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      // refreshJobId present but viability false — the flag wins; no dashboard.
      _meta: { extractionStatus: "succeeded", onboardingViable: false, refreshJobId: "user-abc" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/settings");
    });
    // Exactly one navigation, to Settings, with no handoff state argument.
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const [dest, opts] = mockNavigate.mock.calls[0];
    expect(dest).toBe("/settings");
    expect(opts).toBeUndefined();
  });

  it("routes to /settings via fallback when onboardingViable is absent and extraction failed", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      traditionalSources: ["Reuters"], // sources present, but extraction failed
      _meta: { extractionStatus: "failed" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/settings");
    });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it("routes to /settings via fallback when onboardingViable is absent and there are zero sources", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD, // zero sources
      _meta: { extractionStatus: "succeeded" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/settings");
    });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it("routes to /dashboard via fallback when onboardingViable is absent but extraction succeeded with sources", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      traditionalSources: ["Reuters"],
      socialSources: ["@latamwatcher"],
      _meta: { extractionStatus: "succeeded" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    const [dest, opts] = mockNavigate.mock.calls[0];
    expect(String(dest)).toMatch(/^\/dashboard/);
    expect(opts.state).toEqual({ bootstrap: true, forceRefresh: true });
  });
});
