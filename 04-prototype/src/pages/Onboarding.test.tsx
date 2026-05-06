import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CONTRACT_VERSION } from "@tempo/contracts";
import Onboarding from "@/pages/Onboarding";
import * as settingsApi from "@/lib/settings-api";
import * as notify from "@/lib/notify";

vi.mock("@/lib/analytics", () => ({
  trackOnboardingViewed: vi.fn(),
  trackOnboardingSubmitted: vi.fn(),
  trackOnboardingCompleted: vi.fn(),
}));

vi.mock("@/lib/voice-upload", () => ({
  transcribeAudio: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({
  notifyWarning: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/lib/settings-api", () => ({
  saveSettingsPayload: vi.fn(),
}));

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

describe("Onboarding — extraction status toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows warning toast when _meta.extractionStatus is 'failed'", async () => {
    vi.mocked(settingsApi.saveSettingsPayload).mockResolvedValueOnce({
      ...BASE_PAYLOAD,
      _meta: { extractionStatus: "failed" },
    });

    renderOnboarding();
    await submitWithText("Colombia diplomacy.");

    await waitFor(() => {
      expect(notify.notifyWarning).toHaveBeenCalledWith(
        "We hit an issue on our side. You can keep going and complete what you're monitoring in Settings."
      );
    });
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
