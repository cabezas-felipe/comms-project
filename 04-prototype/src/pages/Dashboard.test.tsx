import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dashboard, { buildHeadline, shouldAdvanceClockForBootstrap } from "@/pages/Dashboard";
import { CONTRACT_VERSION, type StoryDto } from "@tempo/contracts";
import type { DashboardFetchResult } from "@/lib/api";
import { REFRESH_INTERVAL_MS } from "@/lib/refresh-heartbeat";

const fetchSpy = vi.fn();
const bootstrapSpy = vi.fn();
const notifyErrorSpy = vi.fn();
const seedAnchorIfMissingSpy = vi.fn();
const recordAttemptStartSpy = vi.fn();
const recordAttemptFinishedSpy = vi.fn();

// Heartbeat result is mutable across renders so individual tests can drive
// "the app-scope scheduler just succeeded" without spinning up the real
// provider (which would need auth + storage scaffolding).
let mockHeartbeatResult: DashboardFetchResult | null = null;
// Footer state is mutable so individual tests can drive the 2-state copy
// without simulating the full provider lifecycle.
let mockLastAttemptAt: number | null = null;
let mockIsRefreshing = false;
let mockLastRefreshedAt: string | null = null;

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
  DashboardFetchError: MockDashboardFetchError,
}));

vi.mock("@/lib/analytics", () => ({
  trackDashboardViewed: vi.fn(),
  trackSourceOpenError: vi.fn(),
  trackSourceOpened: vi.fn(),
  trackStoryExpanded: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({ notifyError: (...args: unknown[]) => notifyErrorSpy(...args) }));

vi.mock("@/lib/refresh-context", () => ({
  useRefreshContext: () => ({
    lastRefreshedAt: mockLastRefreshedAt,
    heartbeatResult: mockHeartbeatResult,
    seedAnchorIfMissing: seedAnchorIfMissingSpy,
    lastAttemptAt: mockLastAttemptAt,
    isRefreshing: mockIsRefreshing,
    recordAttemptStart: recordAttemptStartSpy,
    recordAttemptFinished: recordAttemptFinishedSpy,
  }),
}));

const OK_RESULT = { payload: { contractVersion: CONTRACT_VERSION, stories: [] }, selection: null };

afterEach(() => {
  fetchSpy.mockReset();
  bootstrapSpy.mockReset();
  notifyErrorSpy.mockReset();
  seedAnchorIfMissingSpy.mockReset();
  recordAttemptStartSpy.mockReset();
  recordAttemptFinishedSpy.mockReset();
  mockHeartbeatResult = null;
  mockLastAttemptAt = null;
  mockIsRefreshing = false;
  mockLastRefreshedAt = null;
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

// ─── Phase 7: keyword pill display formatting (presentation-only) ───────────
//
// Settings keywords are often lowercase ("oil", "sanctions"); next to
// canonical-cased topics/geographies they look inconsistent.  The dashboard
// title-cases keyword pills for display ONLY — the canonical raw value still
// powers testId/key/selection/filtering.  Acronyms (all-uppercase) pass
// through unchanged.

describe("Phase 7: keyword pill display formatting", () => {
  it("renders a lowercase keyword as title-case in the pill label", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    // `pill-keyword-sanctions` testId stays on the canonical raw value;
    // only the visible text is formatted.
    const pill = screen.getByTestId("pill-keyword-sanctions");
    expect(pill.textContent).toBe("Sanctions");
    expect(screen.getByTestId("pill-keyword-asylum").textContent).toBe("Asylum");
  });

  it("preserves an all-uppercase acronym keyword as-is", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    const pill = screen.getByTestId("pill-keyword-OFAC");
    expect(pill.textContent).toBe("OFAC");
  });

  it("title-cases each word in a multi-word keyword (e.g. 'iran trade')", async () => {
    renderWithStories([
      makeStoryDto({
        id: "multi",
        title: "Multi-word Story",
        tags: {
          topics: ["Diplomatic relations"],
          keywords: ["iran trade"],
          geographies: ["US"],
        },
      }),
    ]);
    await waitFor(() => expect(screen.getByText("Multi-word Story")).toBeInTheDocument());
    const pill = screen.getByTestId("pill-keyword-iran trade");
    expect(pill.textContent).toBe("Iran Trade");
  });

  it("clicking a formatted pill filters by the canonical raw value (not the display label)", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    // Pill label reads "Sanctions" but canonical filter value is "sanctions".
    const pill = screen.getByTestId("pill-keyword-sanctions");
    expect(pill.textContent).toBe("Sanctions");
    fireEvent.click(pill);
    await waitFor(() => {
      expect(screen.getByText("Story A")).toBeInTheDocument();
      expect(screen.queryByText("Story B")).toBeNull();
    });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not re-format topic or geography pill labels (canonical display preserved)", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    expect(screen.getByTestId("pill-topic-Diplomatic relations").textContent).toBe(
      "Diplomatic relations"
    );
    expect(screen.getByTestId("pill-topic-Migration policy").textContent).toBe(
      "Migration policy"
    );
    expect(screen.getByTestId("pill-geo-US").textContent).toBe("US");
    expect(screen.getByTestId("pill-geo-Colombia").textContent).toBe("Colombia");
  });

  it("preserves existing section order and filter semantics with formatted labels", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // Order check (still by testId / canonical value): All → Topics → Keywords → Geographies.
    const row = screen.getByTestId("header-pill-row");
    const ids = Array.from(row.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => id.startsWith("pill-"));
    const firstIndex = (prefix: string) => ids.findIndex((id) => id.startsWith(prefix));
    expect(firstIndex("pill-all")).toBeLessThan(firstIndex("pill-topic-"));
    expect(firstIndex("pill-topic-")).toBeLessThan(firstIndex("pill-keyword-"));
    expect(firstIndex("pill-keyword-")).toBeLessThan(firstIndex("pill-geo-"));

    // OR-within / AND-across semantics still hold even though one pill's
    // label changed casing.  Selecting topic + a (formatted) keyword that
    // mismatches yields zero stories.
    fireEvent.click(screen.getByTestId("pill-topic-Migration policy"));
    fireEvent.click(screen.getByTestId("pill-keyword-OFAC"));
    await waitFor(() => {
      expect(screen.queryByText("Story A")).toBeNull();
      expect(screen.queryByText("Story B")).toBeNull();
    });
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

// ─── shouldAdvanceClockForBootstrap (pure decision helper) ───────────────────
// Owns the "did this bootstrap call count as a refresh attempt?" decision.
// Extracted from the Dashboard effect so the matrix is easy to read and the
// rule (served_fresh_snapshot → no-op; everything else → advance) is
// unit-testable without spinning up the component.

describe("shouldAdvanceClockForBootstrap", () => {
  it("returns false ONLY for served_fresh_snapshot on a successful response", () => {
    expect(shouldAdvanceClockForBootstrap({ failed: false, decision: "served_fresh_snapshot" })).toBe(false);
  });

  it("returns true for ran_refresh", () => {
    expect(shouldAdvanceClockForBootstrap({ failed: false, decision: "ran_refresh" })).toBe(true);
  });

  it("returns true for no_snapshot", () => {
    expect(shouldAdvanceClockForBootstrap({ failed: false, decision: "no_snapshot" })).toBe(true);
  });

  it("returns true for a null/unknown decision (older API forward-compat)", () => {
    expect(shouldAdvanceClockForBootstrap({ failed: false, decision: null })).toBe(true);
  });

  it("returns true on failure even when decision claims served_fresh_snapshot", () => {
    // A failed call shouldn't have a meaningful decision attached, but if
    // a caller plumbs through a stale value the failure path must still
    // win — otherwise a transient error would silently freeze the badge.
    expect(shouldAdvanceClockForBootstrap({ failed: true, decision: "served_fresh_snapshot" })).toBe(true);
  });

  it("returns true on failure with a null decision (typical error path)", () => {
    expect(shouldAdvanceClockForBootstrap({ failed: true, decision: null })).toBe(true);
  });
});

// ─── App-scope refresh heartbeat → Dashboard overlay ─────────────────────────
// The 60-minute attempt scheduler now lives in `lib/refresh-heartbeat` and is
// mounted by `RefreshHeartbeatProvider` at app scope.  The Dashboard's local
// responsibility shrinks to: (1) call `seedAnchorIfMissing` on a successful
// initial bootstrap/GET load so the very first dashboard entry establishes
// the header timestamp, (2) drive in-flight ONLY for bootstrap (a real
// refresh-style attempt), and (3) overlay heartbeat-driven payloads onto the
// on-screen story list so a long-lived dashboard view doesn't show stale
// content while the header timestamp moves forward.

describe("Dashboard initial loader integration with refresh context", () => {
  it("calls seedAnchorIfMissing with the result of an initial GET (first-paint seed)", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      refreshedAt: "2026-05-11T12:00:00Z",
    });
    renderAt(null);
    await screen.findByTestId("dashboard-empty");
    expect(seedAnchorIfMissingSpy).toHaveBeenCalledTimes(1);
    expect(seedAnchorIfMissingSpy.mock.calls[0][0]).toMatchObject({
      refreshedAt: "2026-05-11T12:00:00Z",
    });
  });

  it("calls seedAnchorIfMissing with the result of an initial bootstrap", async () => {
    bootstrapSpy.mockResolvedValue({
      ...OK_RESULT,
      decision: "served_fresh_snapshot",
      refreshedAt: "2026-05-11T12:30:00Z",
    });
    renderAt({ bootstrap: true });
    await screen.findByTestId("dashboard-empty");
    expect(seedAnchorIfMissingSpy).toHaveBeenCalledTimes(1);
    expect(seedAnchorIfMissingSpy.mock.calls[0][0]).toMatchObject({
      refreshedAt: "2026-05-11T12:30:00Z",
    });
  });

  it("does NOT call seedAnchorIfMissing when the initial loader fails", async () => {
    fetchSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    renderAt(null);
    await screen.findByTestId("dashboard-error");
    expect(seedAnchorIfMissingSpy).not.toHaveBeenCalled();
  });
});

describe("Heartbeat → Dashboard story overlay", () => {
  it("replaces on-screen stories when a heartbeat-driven refresh result arrives via context", async () => {
    fetchSpy.mockResolvedValue({
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "init", title: "Initial Story" })],
      },
      selection: null,
    });
    renderAt(null);
    expect(await screen.findByText("Initial Story")).toBeInTheDocument();

    // Heartbeat tick succeeds at app scope — provider pushes a new result.
    mockHeartbeatResult = {
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "next", title: "Refreshed Story" })],
      },
      selection: null,
      refreshedAt: "2026-05-11T13:00:00Z",
    };
    // Force a re-render by triggering a state change in the dashboard (router
    // unaware of context changes from this mock); fastest path is to
    // re-render the tree.
    fireEvent.click(screen.getByTestId("pill-all"));
    // Now bump the context value — Dashboard's effect should pick it up.
    // (mockHeartbeatResult is mutated in-place; the click triggers a re-render
    // which re-runs useRefreshContext and yields the new value.)
    await waitFor(() => {
      expect(screen.queryByText("Initial Story")).toBeNull();
    });
    expect(screen.getByText("Refreshed Story")).toBeInTheDocument();
  });

  it("does not overlay in emptyMode (?empty=1)", async () => {
    mockHeartbeatResult = {
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "next", title: "Refreshed Story" })],
      },
      selection: null,
      refreshedAt: "2026-05-11T13:00:00Z",
    };
    render(
      <MemoryRouter initialEntries={[{ pathname: "/dashboard", search: "?empty=1" }]}>
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    );
    // emptyMode renders the empty block from the synchronous initial state —
    // no overlay should leak the heartbeat payload into view.
    expect(screen.queryByText("Refreshed Story")).toBeNull();
  });
});

// ─── 2-state "Next refresh" footer ───────────────────────────────────────────
// Footer drives off the refresh context: the heartbeat owns / stamps
// `lastAttemptAt`, while the dashboard loader only toggles `isRefreshing` via
// recordAttemptStart / recordAttemptFinished.  Two states only:
// "Next refresh in ~Xm" (countdown) or "Refreshing now…" (in-flight).

describe("Next refresh footer (2-state)", () => {
  it("shows minute-rounded countdown when lastAttemptAt is set and not yet due", async () => {
    // Anchor lastAttemptAt to real Date.now() (minus a small skew so the
    // ceil() result is stable against test-runner jitter).  Component reads
    // Date.now() shortly after, so the remaining window is ~40 minutes.
    mockLastAttemptAt = Date.now() - 20 * 60 * 1000 - 1000;
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Next refresh in ~40m");
  });

  it("shows 'Refreshing now…' while isRefreshing=true (mid-attempt)", async () => {
    // 30 minutes into the window — countdown would say "~30m" — but a fetch
    // is in flight, so the footer must prefer the in-flight copy.
    mockLastAttemptAt = Date.now() - 30 * 60 * 1000;
    mockIsRefreshing = true;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Refreshing now…");
  });

  it("clamps to 'Next refresh in ~1m' once now >= nextAttemptAt without an in-flight tick", async () => {
    // Last attempt happened just past the heartbeat interval — past the
    // boundary, but no in-flight tick yet (scheduling jitter, hidden tab).
    mockLastAttemptAt = Date.now() - REFRESH_INTERVAL_MS - 60 * 1000;
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Next refresh in ~1m");
  });

  it("shows '—' after a GET-only load when no anchor exists (no synthetic anchor from GET)", async () => {
    // A GET that returns no parseable timestamps must leave the anchor
    // null and surface a neutral state — never invent a countdown from
    // client time alone.  Once the GET settles (isLoading=false), with no
    // anchor and no in-flight POST attempt the footer reads "—".
    mockLastAttemptAt = null;
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("—");
  });

  it("shows 'Loading stories…' during an in-flight GET (no implication of refresh)", async () => {
    // Rule: GET is not a refresh attempt, so the footer must not say
    // "Refreshing now…" while a GET is in flight.  Local `isLoading` drives
    // a distinct copy.
    let resolveFetch: ((v: unknown) => void) | null = null;
    fetchSpy.mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; })
    );
    mockLastAttemptAt = null;
    mockIsRefreshing = false;

    renderAt(null);
    // Loading copy is visible before the fetch resolves.
    expect(await screen.findByTestId("refresh-footer")).toHaveTextContent("Loading stories…");

    await act(async () => { resolveFetch?.(OK_RESULT); });
    await screen.findByTestId("dashboard-empty");
  });
});

describe("Dashboard loader records refresh attempts (bootstrap path only)", () => {
  // Only POST-style refresh attempts (bootstrap, heartbeat) participate in
  // the in-flight slot lifecycle.  GET serves the persisted snapshot — it
  // is not a refresh attempt, so it must not toggle the global isRefreshing
  // flag and must not advance the anchor.

  it("does NOT call recordAttemptStart / recordAttemptFinished for a GET load", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    await screen.findByTestId("dashboard-empty");
    expect(recordAttemptStartSpy).not.toHaveBeenCalled();
    expect(recordAttemptFinishedSpy).not.toHaveBeenCalled();
  });

  it("does NOT call attempt lifecycle for a failed GET either", async () => {
    fetchSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    renderAt(null);
    await screen.findByTestId("dashboard-error");
    expect(recordAttemptStartSpy).not.toHaveBeenCalled();
    expect(recordAttemptFinishedSpy).not.toHaveBeenCalled();
  });

  it("calls recordAttemptStart synchronously and recordAttemptFinished on a successful bootstrap", async () => {
    bootstrapSpy.mockResolvedValue({
      ...OK_RESULT,
      decision: "ran_refresh",
      lastCheckedAt: "2026-05-11T13:00:00Z",
    });
    renderAt({ bootstrap: true });
    // In-flight state must flip on first render so the footer transitions
    // to "Refreshing now…" immediately while the bootstrap fetch is pending.
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    await screen.findByTestId("dashboard-empty");
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
  });

  it("settles bootstrap served_fresh_snapshot with advanceClock:false (no clock movement)", async () => {
    // When the backend served the persisted snapshot without running the
    // refresh executor, this caller did not perform a refresh attempt —
    // the anchor must NOT advance.
    bootstrapSpy.mockResolvedValue({
      ...OK_RESULT,
      decision: "served_fresh_snapshot",
      lastCheckedAt: "2026-05-11T13:00:00Z",
    });
    renderAt({ bootstrap: true });
    await screen.findByTestId("dashboard-empty");
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
    const [, options] = recordAttemptFinishedSpy.mock.calls[0];
    expect(options).toMatchObject({ advanceClock: false });
    expect(options?.result).toMatchObject({ decision: "served_fresh_snapshot" });
  });

  it("settles bootstrap ran_refresh by advancing the clock", async () => {
    bootstrapSpy.mockResolvedValue({
      ...OK_RESULT,
      decision: "ran_refresh",
      lastCheckedAt: "2026-05-11T13:00:00Z",
    });
    renderAt({ bootstrap: true });
    await screen.findByTestId("dashboard-empty");
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
    const [, options] = recordAttemptFinishedSpy.mock.calls[0];
    // advanceClock left default (true) for any non-served_fresh_snapshot
    // decision — settlement advances the anchor.
    expect(options?.advanceClock).not.toBe(false);
    expect(options?.result).toMatchObject({ decision: "ran_refresh" });
  });

  it("settles a failed bootstrap by advancing the clock (failures still move clock)", async () => {
    // A refresh attempt that fails still counts as an attempt — the clock
    // advances to client now() so the next countdown is bounded; treating
    // failure as no-op would strand the badge on a stale anchor.
    bootstrapSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    renderAt({ bootstrap: true });
    await screen.findByTestId("dashboard-error");
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
    const [, options] = recordAttemptFinishedSpy.mock.calls[0];
    // No server result captured on failure — advanceClock stays default
    // (true), the provider falls back to client now().
    expect(options?.advanceClock).not.toBe(false);
  });

  it("retry of a failed GET does NOT engage the attempt lifecycle", async () => {
    fetchSpy
      .mockRejectedValueOnce(new MockDashboardFetchError("network", "boom"))
      .mockResolvedValueOnce(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByTestId("dashboard-empty");

    // Two GET loads (initial + retry), neither participates in the attempt
    // lifecycle.
    expect(recordAttemptStartSpy).not.toHaveBeenCalled();
    expect(recordAttemptFinishedSpy).not.toHaveBeenCalled();
  });

  it("calls recordAttemptFinished even when a bootstrap is canceled mid-flight (unmount)", async () => {
    // Repro: user opens the dashboard via bootstrap, fetch is slow, user
    // navigates away before it resolves.  The cleanup must still settle
    // the in-flight slot so the footer doesn't stay stuck on "Refreshing
    // now…" after the cancelled promise resolves.
    let resolveFetch: ((v: unknown) => void) | null = null;
    bootstrapSpy.mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; })
    );
    const view = renderAt({ bootstrap: true });
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    expect(recordAttemptFinishedSpy).not.toHaveBeenCalled();

    view.unmount();
    expect(recordAttemptFinishedSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch?.({ ...OK_RESULT, decision: "ran_refresh" });
    });
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
  });

  it("calls recordAttemptFinished on the canceled path when a bootstrap rejects", async () => {
    let rejectFetch: ((e: unknown) => void) | null = null;
    bootstrapSpy.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectFetch = reject; })
    );
    const view = renderAt({ bootstrap: true });
    view.unmount();
    await act(async () => {
      rejectFetch?.(new MockDashboardFetchError("network", "boom"));
    });
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Footer + header anchored to one source of truth ────────────────────────
// The provider exposes `lastRefreshedAt` (ISO) and `lastAttemptAt` (ms) as
// two views of a single anchor.  The footer's countdown reads `lastAttemptAt`
// directly; the header reads the derived ISO.  These tests guard the footer's
// behavior under the unified contract.

describe("Footer reads single attempt anchor (header + footer share state)", () => {
  it("derives the countdown from lastAttemptAt — independent of any drift in lastRefreshedAt", async () => {
    // Even when the mocks deliberately set divergent values, the footer must
    // only consult `lastAttemptAt`.  Under the real provider contract these
    // would already be in sync; this is a defensive guard against future
    // regressions that re-introduce a second baseline.
    const attemptMs = Date.now() - 1000;
    mockLastRefreshedAt = new Date(Date.now() - 37 * 60 * 1000).toISOString();
    mockLastAttemptAt = attemptMs;
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Next refresh in ~60m");
  });

  it("renders a 40-min countdown when lastAttemptAt is 20 min old (no in-flight)", async () => {
    mockLastAttemptAt = Date.now() - (20 * 60 * 1000 + 1000);
    mockLastRefreshedAt = new Date(mockLastAttemptAt).toISOString();
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Next refresh in ~40m");
  });

  it("isRefreshing wins over the anchor (true in-flight always shows 'Refreshing now…')", async () => {
    mockLastAttemptAt = Date.now() - 30 * 60 * 1000;
    mockLastRefreshedAt = new Date(mockLastAttemptAt).toISOString();
    mockIsRefreshing = true;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Refreshing now…");
  });

  it("clamps to 'Next refresh in ~1m' when the anchor is past-due and no in-flight attempt exists", async () => {
    // Heartbeat scheduling jitter (or a backgrounded tab) can produce a
    // baseline that's just past the 60-min boundary with no in-flight tick.
    // Keep a bounded countdown until an actual attempt flips `isRefreshing`
    // — never render a negative or zero countdown, never invent a new copy.
    mockLastAttemptAt = Date.now() - REFRESH_INTERVAL_MS - 60 * 1000;
    mockLastRefreshedAt = new Date(mockLastAttemptAt).toISOString();
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Next refresh in ~1m");
  });
});

