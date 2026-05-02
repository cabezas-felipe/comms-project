import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", () => ({
  getProtoSession: vi.fn(),
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
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when proto session exists", () => {
    vi.mocked(auth.getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });
    renderProtected();
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("redirects to / and hides children when no proto session", () => {
    vi.mocked(auth.getProtoSession).mockReturnValue(null);
    renderProtected();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(screen.getByText("landing")).toBeInTheDocument();
  });
});
