import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dashboard, { buildHeadline } from "@/pages/Dashboard";
import { CONTRACT_VERSION, type StoryDto } from "@tempo/contracts";

const fetchSpy = vi.fn();
const bootstrapSpy = vi.fn();
const refreshSpy = vi.fn();
const notifyErrorSpy = vi.fn();

const { MockDashboardFetchError } = vi.hoisted(() => {
  class MockDashboardFetchError extends Error {
    kind: string;
    status?: number;
    constructor(kind: string, message: string, status?: number) {
      super(message);
      this.name = "DashboardFetchError";
      this.kind = kind;
      this.status = status;
    }
  }
  return { MockDashboardFetchError };
});

vi.mock("@/lib/api", () => ({
  fetchDashboardWithMeta: (...args: unknown[]) => fetchSpy(...args),
  bootstrapDashboard: (...args: unknown[]) => bootstrapSpy(...args),
  refreshDashboard: (...args: unknown[]) => refreshSpy(...args),
  DashboardFetchError: MockDashboardFetchError,
}));

vi.mock("@/lib/analytics", () => ({
  trackDashboardViewed: vi.fn(),
  trackSourceOpenError: vi.fn(),
  trackSourceOpened: vi.fn(),
  trackStoryExpanded: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({ notifyError: (...args: unknown[]) => notifyErrorSpy(...args) }));

const OK_RESULT = { payload: { contractVersion: CONTRACT_VERSION, stories: [] }, selection: null };

afterEach(() => {
  fetchSpy.mockReset();
  bootstrapSpy.mockReset();
  refreshSpy.mockReset();
  notifyErrorSpy.mockReset();
});

function renderAt(state: object | null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/dashboard", state }]}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Phase 5: Dashboard load path selection", () => {
  it("calls bootstrapDashboard when router state has bootstrap: true (Landing/Onboarding entry)", async () => {
    bootstrapSpy.mockResolvedValue({ ...OK_RESULT, decision: "served_fresh_snapshot" });
    renderAt({ bootstrap: true });
    await waitFor(() => expect(bootstrapSpy).toHaveBeenCalledTimes(1));
    // Await the post-resolution UI so the trailing state update flushes inside act().
    await screen.findByTestId("dashboard-empty");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetchDashboardWithMeta (GET) when router state is null (in-app navigation / direct URL)", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await screen.findByTestId("dashboard-empty");
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  it("calls fetchDashboardWithMeta when router state is present but bootstrap flag is absent", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    renderAt({ from: "settings" });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await screen.findByTestId("dashboard-empty");
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });
});

describe("Dashboard load states (no fake-story fallback)", () => {
  it("renders Loading state on initial mount before fetch resolves", async () => {
    let resolveFetch: ((v: unknown) => void) | null = null;
    fetchSpy.mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; })
    );
    renderAt(null);
    expect(await screen.findByTestId("dashboard-loading")).toBeInTheDocument();
    // Settle the pending promise and await the next state so the post-resolve
    // setState fires inside Testing Library's act() boundary, not after the
    // test exits.
    await act(async () => {
      resolveFetch?.(OK_RESULT);
    });
    await screen.findByTestId("dashboard-empty");
  });

  it("renders Empty state (briefing) when backend returns 0 stories on success", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    expect(screen.getByText("No stories yet.")).toBeInTheDocument();
    // Critical: no fake-story fallback rendered
    expect(screen.queryByTestId("dashboard-error")).toBeNull();
  });

  it("renders Error state with retry when fetch fails (no STORIES rendered)", async () => {
    fetchSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    renderAt(null);
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    expect(screen.getByText("We couldn't load your stories.")).toBeInTheDocument();
    // No fake stories should leak through — the dashboard must not render the
    // static demo set when the API errors.
    expect(screen.queryByText("Story A")).toBeNull();
  });

  it("renders Error state when bootstrap fails (Landing/Onboarding entry)", async () => {
    bootstrapSpy.mockRejectedValue(new MockDashboardFetchError("http", "503", 503));
    renderAt({ bootstrap: true });
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
  });

  it("retry button re-invokes the loader after an error", async () => {
    fetchSpy
      .mockRejectedValueOnce(new MockDashboardFetchError("network", "boom"))
      .mockResolvedValueOnce(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Phase 6: dynamic header pills ───────────────────────────────────────────

function makeStoryDto(overrides: Partial<StoryDto> = {}): StoryDto {
  return {
    id: "s",
    title: "T",
    geographies: ["US"],
    topic: "Diplomatic relations",
    takeaway: "k",
    summary: "s",
    whyItMatters: "w",
    whatChanged: "c",
    priority: "standard",
    outletCount: 1,
    sources: [
      {
        id: "src-1",
        outlet: "Reuters",
        kind: "traditional",
        weight: 50,
        url: "#",
        minutesAgo: 10,
        headline: "h",
        body: ["b"],
      },
    ],
    ...overrides,
  };
}

const PHASE6_STORIES: StoryDto[] = [
  makeStoryDto({
    id: "story-a",
    title: "Story A",
    topic: "Diplomatic relations",
    geographies: ["US"],
    tags: {
      topics: ["Diplomatic relations"],
      keywords: ["sanctions", "OFAC"],
      geographies: ["US", "Colombia"],
    },
  }),
  makeStoryDto({
    id: "story-b",
    title: "Story B",
    topic: "Migration policy",
    geographies: ["Colombia"],
    tags: {
      topics: ["Migration policy"],
      keywords: ["asylum"],
      geographies: ["Colombia"],
    },
  }),
];

function renderWithStories(stories: StoryDto[]) {
  fetchSpy.mockResolvedValue({
    payload: { contractVersion: CONTRACT_VERSION, stories },
    selection: null,
  });
  return renderAt(null);
}

describe("Phase 6: dynamic header pills", () => {
  it("renders pills derived from current payload stories (All + non-empty sections only)", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // All pill always present
    expect(screen.getByTestId("pill-all")).toBeInTheDocument();
    // Topics from tags
    expect(screen.getByTestId("pill-topic-Diplomatic relations")).toBeInTheDocument();
    expect(screen.getByTestId("pill-topic-Migration policy")).toBeInTheDocument();
    // Keywords from tags only
    expect(screen.getByTestId("pill-keyword-OFAC")).toBeInTheDocument();
    expect(screen.getByTestId("pill-keyword-asylum")).toBeInTheDocument();
    expect(screen.getByTestId("pill-keyword-sanctions")).toBeInTheDocument();
    // Geographies
    expect(screen.getByTestId("pill-geo-US")).toBeInTheDocument();
    expect(screen.getByTestId("pill-geo-Colombia")).toBeInTheDocument();
  });

  it("section order in DOM is All → Topics → Keywords → Geographies", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    const row = screen.getByTestId("header-pill-row");
    const ids = Array.from(row.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => id.startsWith("pill-"));

    // Find first index of each section
    const firstIndex = (prefix: string) => ids.findIndex((id) => id.startsWith(prefix));
    const allIdx = firstIndex("pill-all");
    const topicIdx = firstIndex("pill-topic-");
    const keywordIdx = firstIndex("pill-keyword-");
    const geoIdx = firstIndex("pill-geo-");

    expect(allIdx).toBeLessThan(topicIdx);
    expect(topicIdx).toBeLessThan(keywordIdx);
    expect(keywordIdx).toBeLessThan(geoIdx);
  });

  it("pills inside a section are alphabetical", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    const row = screen.getByTestId("header-pill-row");
    const keywordPills = Array.from(row.querySelectorAll("[data-testid^='pill-keyword-']")).map(
      (el) => el.getAttribute("data-testid")?.replace("pill-keyword-", "") ?? ""
    );
    expect(keywordPills).toEqual(["asylum", "OFAC", "sanctions"]);
  });

  it("hides keyword section when no stories carry keyword tags", async () => {
    // Stories without `tags` at all — keywords section must not render.
    renderWithStories([
      makeStoryDto({ id: "x", title: "X", topic: "Diplomatic relations", geographies: ["US"] }),
    ]);
    await waitFor(() => expect(screen.getByText("X")).toBeInTheDocument());
    expect(screen.queryByTestId(/pill-keyword-/)).toBeNull();
    // Topics + geographies still present from canonical fields
    expect(screen.getByTestId("pill-topic-Diplomatic relations")).toBeInTheDocument();
    expect(screen.getByTestId("pill-geo-US")).toBeInTheDocument();
  });

  it("All clears active filters and returns full feed", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // Select Migration policy → only Story B should remain visible
    fireEvent.click(screen.getByTestId("pill-topic-Migration policy"));
    await waitFor(() => expect(screen.queryByText("Story A")).toBeNull());
    expect(screen.getByText("Story B")).toBeInTheDocument();

    // Click All → both back
    fireEvent.click(screen.getByTestId("pill-all"));
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    expect(screen.getByText("Story B")).toBeInTheDocument();
  });

  it("multi-select within a section uses OR semantics", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // Select two keywords (one from each story) — OR within section means both
    // stories qualify because each has at least one matching keyword.
    fireEvent.click(screen.getByTestId("pill-keyword-OFAC"));
    fireEvent.click(screen.getByTestId("pill-keyword-asylum"));
    await waitFor(() => {
      expect(screen.getByText("Story A")).toBeInTheDocument();
      expect(screen.getByText("Story B")).toBeInTheDocument();
    });
  });

  it("AND across sections — both axes must match", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // Select topic=Migration policy AND keyword=OFAC.  Story A has OFAC but
    // wrong topic; Story B has right topic but no OFAC.  Result: zero stories.
    fireEvent.click(screen.getByTestId("pill-topic-Migration policy"));
    fireEvent.click(screen.getByTestId("pill-keyword-OFAC"));
    await waitFor(() => {
      expect(screen.queryByText("Story A")).toBeNull();
      expect(screen.queryByText("Story B")).toBeNull();
    });
  });

  it("All pill is active (aria-pressed=true) when no filters are selected", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    expect(screen.getByTestId("pill-all").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("pill-topic-Migration policy"));
    await waitFor(() =>
      expect(screen.getByTestId("pill-all").getAttribute("aria-pressed")).toBe("false")
    );
    // Active filter pill is also pressed
    expect(
      screen.getByTestId("pill-topic-Migration policy").getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("toggling a selected pill removes it (deselect)", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    const pill = screen.getByTestId("pill-keyword-OFAC");
    fireEvent.click(pill);
    await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(pill);
    await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("false"));
  });
});

// ─── H1 headline rules ───────────────────────────────────────────────────────

describe("buildHeadline", () => {
  it("mixed three-part: rising → steady → falling, only the first chunk says 'narratives'", () => {
    expect(buildHeadline({ rising: 3, steady: 2, falling: 1 })).toBe(
      "3 narratives rising · 2 steady · 1 falling"
    );
  });

  it("steady-first when rising is zero, falling second uses short form", () => {
    expect(buildHeadline({ rising: 0, steady: 2, falling: 1 })).toBe(
      "2 narratives steady · 1 falling"
    );
  });

  it("only falling — singular form", () => {
    expect(buildHeadline({ rising: 0, steady: 0, falling: 1 })).toBe("1 narrative falling");
  });

  it("only rising — singular form", () => {
    expect(buildHeadline({ rising: 1, steady: 0, falling: 0 })).toBe("1 narrative rising");
  });

  it("only rising — plural form", () => {
    expect(buildHeadline({ rising: 4, steady: 0, falling: 0 })).toBe("4 narratives rising");
  });

  it("only steady — plural form (replaces the old 'All steady.' branch)", () => {
    expect(buildHeadline({ rising: 0, steady: 3, falling: 0 })).toBe("3 narratives steady");
  });

  it("nothing in view → 'Quiet for this view.'", () => {
    expect(buildHeadline({ rising: 0, steady: 0, falling: 0 })).toBe("Quiet for this view.");
  });
});

// ─── Chunk 2: hourly background refresh ──────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function renderAtPath(path: string, state: object | null = null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path.split("?")[0], search: path.includes("?") ? `?${path.split("?")[1]}` : "", state }]}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Chunk 2: hourly dashboard refresh", () => {
  it("schedules an hourly refresh tick once the dashboard mounts (non-empty mode)", async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockResolvedValue(OK_RESULT);
      refreshSpy.mockResolvedValue({ ...OK_RESULT, refreshedAt: "2026-05-11T13:00:00Z" });
      renderAt(null);
      // Initial loader settles
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).not.toHaveBeenCalled();
      // Cross the hour boundary — refresh tick fires exactly once.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOUR_MS);
      });
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule refresh ticks in emptyMode (?empty=1)", async () => {
    vi.useFakeTimers();
    try {
      renderAtPath("/dashboard?empty=1");
      // Initial loader skipped in emptyMode
      expect(fetchSpy).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOUR_MS * 3);
      });
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates stories from the refresh tick payload on success", async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockResolvedValue({
        payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "init", title: "Initial Story" })] },
        selection: null,
      });
      refreshSpy.mockResolvedValue({
        payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "next", title: "Refreshed Story" })] },
        selection: null,
        refreshedAt: "2026-05-11T13:00:00Z",
      });
      renderAt(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Initial Story")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOUR_MS);
      });
      expect(screen.getByText("Refreshed Story")).toBeInTheDocument();
      expect(screen.queryByText("Initial Story")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps existing stories on refresh failure and notifies without crashing the page", async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockResolvedValue({
        payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "init", title: "Initial Story" })] },
        selection: null,
      });
      refreshSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
      renderAt(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Initial Story")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOUR_MS);
      });
      // Prior story still on screen; full-page error block did not render.
      expect(screen.getByText("Initial Story")).toBeInTheDocument();
      expect(screen.queryByTestId("dashboard-error")).toBeNull();
      expect(notifyErrorSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the interval on unmount (no further refresh calls)", async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockResolvedValue(OK_RESULT);
      refreshSpy.mockResolvedValue({ ...OK_RESULT, refreshedAt: null });
      const { unmount } = renderAt(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOUR_MS * 5);
      });
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
