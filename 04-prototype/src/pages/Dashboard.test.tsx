import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dashboard from "@/pages/Dashboard";
import { CONTRACT_VERSION, type StoryDto } from "@tempo/contracts";

const fetchSpy = vi.fn();
const bootstrapSpy = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchDashboardWithMeta: (...args: unknown[]) => fetchSpy(...args),
  bootstrapDashboard: (...args: unknown[]) => bootstrapSpy(...args),
}));

vi.mock("@/lib/analytics", () => ({
  trackDashboardViewed: vi.fn(),
  trackSourceOpenError: vi.fn(),
  trackSourceOpened: vi.fn(),
  trackStoryExpanded: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({ notifyError: vi.fn() }));

const OK_RESULT = { payload: { contractVersion: CONTRACT_VERSION, stories: [] }, selection: null };

afterEach(() => {
  fetchSpy.mockReset();
  bootstrapSpy.mockReset();
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
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetchDashboardWithMeta (GET) when router state is null (in-app navigation / direct URL)", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  it("calls fetchDashboardWithMeta when router state is present but bootstrap flag is absent", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    renderAt({ from: "settings" });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(bootstrapSpy).not.toHaveBeenCalled();
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
