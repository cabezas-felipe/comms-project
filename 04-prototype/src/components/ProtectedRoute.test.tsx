import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(),
}));

function renderProtected(initialPath = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div>landing</div>} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div>protected content</div>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <div>settings content</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when recognized identity is set", () => {
    vi.mocked(auth.useAuth).mockReturnValue({
      recognizedIdentity: { email: "user@example.com", userId: "u1" },
    } as ReturnType<typeof auth.useAuth>);
    renderProtected();
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("redirects to / and hides children when no recognized identity", () => {
    vi.mocked(auth.useAuth).mockReturnValue({
      recognizedIdentity: null,
    } as ReturnType<typeof auth.useAuth>);
    renderProtected();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(screen.getByText("landing")).toBeInTheDocument();
  });

  it("identity persists across protected route navigation", () => {
    const identity = { email: "user@example.com", userId: "u1" };
    vi.mocked(auth.useAuth).mockReturnValue({
      recognizedIdentity: identity,
    } as ReturnType<typeof auth.useAuth>);

    // Dashboard is protected and renders without redirecting
    renderProtected("/dashboard");
    expect(screen.getByText("protected content")).toBeInTheDocument();
    expect(screen.queryByText("landing")).not.toBeInTheDocument();
  });

  it("logout clears identity and redirects to landing", () => {
    // After logout, recognizedIdentity is null — ProtectedRoute redirects
    vi.mocked(auth.useAuth).mockReturnValue({
      recognizedIdentity: null,
    } as ReturnType<typeof auth.useAuth>);
    renderProtected("/dashboard");
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(screen.getByText("landing")).toBeInTheDocument();
  });
});
