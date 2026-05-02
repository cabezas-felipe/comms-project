import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import EntryLandingPage from "@/pages/EntryLandingPage";
import * as analytics from "@/lib/analytics";

vi.mock("@/lib/analytics", () => ({
  trackLandingViewed: vi.fn(),
  trackLandingCtaClicked: vi.fn(),
  trackLandingFailed: vi.fn(),
  trackLandingSucceeded: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(() => ({ setRecognizedIdentity: vi.fn() })),
}));

vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <EntryLandingPage />
    </MemoryRouter>
  );
}

function fillEmail(value: string) {
  fireEvent.change(screen.getByPlaceholderText("you@domain.com"), {
    target: { value },
  });
}

function clickSubmit() {
  fireEvent.click(screen.getByRole("button", { name: /stay in sync/i }));
}

describe("EntryLandingPage — analytics event emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires trackLandingViewed on mount", async () => {
    renderPage();
    await waitFor(() =>
      expect(analytics.trackLandingViewed).toHaveBeenCalledTimes(1)
    );
  });

  it("fires trackLandingCtaClicked on every submit attempt", async () => {
    renderPage();
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingCtaClicked).toHaveBeenCalledTimes(1)
    );
  });

  it("fires trackLandingFailed(validation/empty) on empty submit", async () => {
    renderPage();
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingFailed).toHaveBeenCalledWith({
        failureStage: "validation",
        validationReason: "empty",
      })
    );
  });

  it("fires trackLandingFailed(validation/missing_at) for email without @", async () => {
    renderPage();
    fillEmail("notanemail");
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingFailed).toHaveBeenCalledWith({
        failureStage: "validation",
        validationReason: "missing_at",
      })
    );
  });

  it("fires trackLandingFailed(validation/invalid_domain) for email with @ but bad domain", async () => {
    renderPage();
    fillEmail("user@nodot");
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingFailed).toHaveBeenCalledWith({
        failureStage: "validation",
        validationReason: "invalid_domain",
      })
    );
  });

  it("fires trackLandingFailed(backend) with statusCode and mappedErrorKey on 403", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        message:
          "This email is not enabled for the prototype yet. Contact the team to be added.",
      }),
    });
    renderPage();
    fillEmail("user@example.com");
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingFailed).toHaveBeenCalledWith({
        failureStage: "backend",
        statusCode: 403,
        mappedErrorKey: "not_enabled",
      })
    );
  });

  it("fires trackLandingFailed(backend/unknown_without_message) when body has no message", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    renderPage();
    fillEmail("user@example.com");
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingFailed).toHaveBeenCalledWith({
        failureStage: "backend",
        statusCode: 500,
        mappedErrorKey: "unknown_without_message",
      })
    );
  });

  it("fires trackLandingFailed(network) when fetch throws", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down")
    );
    renderPage();
    fillEmail("user@example.com");
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingFailed).toHaveBeenCalledWith({
        failureStage: "network",
      })
    );
  });

  it("fires trackLandingSucceeded(dashboard) on /dashboard response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        destination: "/dashboard",
        user: { id: "u1", email: "user@example.com" },
      }),
    });
    renderPage();
    fillEmail("user@example.com");
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingSucceeded).toHaveBeenCalledWith("dashboard")
    );
  });

  it("fires trackLandingSucceeded(onboarding) on /onboarding response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        destination: "/onboarding",
        user: { id: "u2", email: "user@example.com" },
      }),
    });
    renderPage();
    fillEmail("user@example.com");
    clickSubmit();
    await waitFor(() =>
      expect(analytics.trackLandingSucceeded).toHaveBeenCalledWith("onboarding")
    );
  });
});
