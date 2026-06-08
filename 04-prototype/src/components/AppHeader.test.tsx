import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppHeader from "@/components/AppHeader";
import { formatClock } from "@/lib/format";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(),
}));

const RECOGNIZED = {
  recognizedIdentity: { email: "user@example.com", userId: "u1" },
  logout: vi.fn().mockResolvedValue(undefined),
} as unknown as ReturnType<typeof auth.useAuth>;

const ANONYMOUS = {
  recognizedIdentity: null,
  logout: vi.fn().mockResolvedValue(undefined),
} as unknown as ReturnType<typeof auth.useAuth>;

function renderHeaderAt(
  path: string,
  props: { lastRefreshedAt?: string | null; isRefreshing?: boolean } = {}
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<AppHeader {...props} />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AppHeader", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Last refresh display", () => {
    it("renders formatted local time when lastRefreshedAt is a valid ISO string", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      const iso = "2026-05-08T12:34:56Z";
      renderHeaderAt("/dashboard", { lastRefreshedAt: iso });
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
      expect(screen.getByText(formatClock(new Date(iso)))).toBeInTheDocument();
      expect(screen.queryByText("—")).not.toBeInTheDocument();
    });

    it("renders '—' when lastRefreshedAt is undefined", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      renderHeaderAt("/dashboard");
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
      expect(screen.getByText("—")).toBeInTheDocument();
    });

    it("renders '—' when lastRefreshedAt is null", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      renderHeaderAt("/dashboard", { lastRefreshedAt: null });
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
      expect(screen.getByText("—")).toBeInTheDocument();
    });

    it("renders '—' when lastRefreshedAt is an unparseable date string", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      renderHeaderAt("/dashboard", { lastRefreshedAt: "not-a-date" });
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
      expect(screen.getByText("—")).toBeInTheDocument();
    });
  });

  describe("Refresh in progress", () => {
    it("shows 'Refreshing…' instead of a stale clock while a refresh is in flight", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      const staleIso = "2026-05-08T06:30:00Z";
      renderHeaderAt("/dashboard", { lastRefreshedAt: staleIso, isRefreshing: true });
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
      // The explicit in-progress label is shown…
      expect(screen.getByText("Refreshing…")).toBeInTheDocument();
      // …and the stale timestamp is NOT rendered.
      expect(screen.queryByText(formatClock(new Date(staleIso)))).not.toBeInTheDocument();
    });

    it("reverts to the settled timestamp once refresh completes (isRefreshing=false)", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      const iso = "2026-05-08T12:34:56Z";
      renderHeaderAt("/dashboard", { lastRefreshedAt: iso, isRefreshing: false });
      expect(screen.getByText(formatClock(new Date(iso)))).toBeInTheDocument();
      expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();
    });

    it("does not surface the in-progress label on /settings (Last refresh block stays hidden)", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      renderHeaderAt("/settings", { lastRefreshedAt: "2026-05-08T06:30:00Z", isRefreshing: true });
      expect(screen.getByText("Tempo")).toBeInTheDocument();
      expect(screen.queryByText("Last refresh")).not.toBeInTheDocument();
      expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();
    });

    it("renders nothing on the landing route (/) even while refreshing", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      const { container } = renderHeaderAt("/", {
        lastRefreshedAt: "2026-05-08T06:30:00Z",
        isRefreshing: true,
      });
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("Visibility rules", () => {
    it("hides the Last refresh block on /settings (but still renders the header itself)", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      renderHeaderAt("/settings", { lastRefreshedAt: "2026-05-08T12:34:56Z" });
      // Header still rendered (Tempo brand visible) — but the Last refresh block is suppressed.
      expect(screen.getByText("Tempo")).toBeInTheDocument();
      expect(screen.queryByText("Last refresh")).not.toBeInTheDocument();
    });

    it("renders nothing on the landing route (/)", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      const { container } = renderHeaderAt("/", { lastRefreshedAt: "2026-05-08T12:34:56Z" });
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing on /onboarding", () => {
      vi.mocked(auth.useAuth).mockReturnValue(RECOGNIZED);
      const { container } = renderHeaderAt("/onboarding", {
        lastRefreshedAt: "2026-05-08T12:34:56Z",
      });
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when there is no recognized identity", () => {
      vi.mocked(auth.useAuth).mockReturnValue(ANONYMOUS);
      const { container } = renderHeaderAt("/dashboard", {
        lastRefreshedAt: "2026-05-08T12:34:56Z",
      });
      expect(container).toBeEmptyDOMElement();
    });
  });
});
