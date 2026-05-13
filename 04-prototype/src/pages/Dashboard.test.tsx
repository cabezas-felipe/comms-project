import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dashboard, { buildHeadline } from "@/pages/Dashboard";
import { CONTRACT_VERSION, type StoryDto } from "@tempo/contracts";
import type { DashboardFetchResult } from "@/lib/api";
import { REFRESH_INTERVAL_MS } from "@/lib/refresh-heartbeat";

const fetchSpy = vi.fn();
const bootstrapSpy = vi.fn();
const notifyErrorSpy = vi.fn();
const recordSpy = vi.fn();
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
    recordSuccessfulRefresh: recordSpy,
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
  recordSpy.mockReset();
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

// ─── App-scope refresh heartbeat → Dashboard overlay ─────────────────────────
// The 60-minute attempt scheduler now lives in `lib/refresh-heartbeat` and is
// mounted by `RefreshHeartbeatProvider` at app scope.  The Dashboard's local
// responsibility shrinks to two things: (1) call `recordSuccessfulRefresh` on
// its initial bootstrap/GET loader, and (2) overlay heartbeat-driven payloads
// onto the on-screen story list so a long-lived dashboard view doesn't show
// stale content while the header timestamp moves forward.

describe("Dashboard initial loader integration with refresh context", () => {
  it("calls recordSuccessfulRefresh with the result of an initial GET", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      refreshedAt: "2026-05-11T12:00:00Z",
    });
    renderAt(null);
    await screen.findByTestId("dashboard-empty");
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0]).toMatchObject({
      refreshedAt: "2026-05-11T12:00:00Z",
    });
  });

  it("calls recordSuccessfulRefresh with the result of an initial bootstrap", async () => {
    bootstrapSpy.mockResolvedValue({
      ...OK_RESULT,
      decision: "served_fresh_snapshot",
      refreshedAt: "2026-05-11T12:30:00Z",
    });
    renderAt({ bootstrap: true });
    await screen.findByTestId("dashboard-empty");
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0]).toMatchObject({
      refreshedAt: "2026-05-11T12:30:00Z",
    });
  });

  it("does NOT call recordSuccessfulRefresh when the initial loader fails", async () => {
    fetchSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    renderAt(null);
    await screen.findByTestId("dashboard-error");
    expect(recordSpy).not.toHaveBeenCalled();
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
// `lastAttemptAt` (and `lastRefreshedAt` is the preferred baseline), while
// the dashboard loader only toggles `isRefreshing` via recordAttemptStart /
// recordAttemptFinished.  Two states only: "Next refresh in ~Xm"
// (countdown) or "Refreshing now…" (due/in-flight).

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

  it("shows 'Refreshing now…' once now >= nextAttemptAt even without an in-flight tick (no negative countdown)", async () => {
    // Last attempt happened just past the heartbeat interval — past the
    // boundary, but no in-flight tick yet (scheduling jitter, hidden tab).
    mockLastAttemptAt = Date.now() - REFRESH_INTERVAL_MS - 60 * 1000;
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Refreshing now…");
  });

  it("shows 'Refreshing now…' before any attempt timestamp exists (initial-mount fallback)", async () => {
    mockLastAttemptAt = null;
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Refreshing now…");
  });
});

describe("Dashboard loader records refresh attempts", () => {
  it("calls recordAttemptStart synchronously and recordAttemptFinished on a successful GET", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    // In-flight state must flip on first render (before the fetch promise
    // resolves) so the footer transitions to "Refreshing now…" immediately.
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    await screen.findByTestId("dashboard-empty");
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
  });

  it("calls recordAttemptStart + recordAttemptFinished even when the loader fails", async () => {
    fetchSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    renderAt(null);
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    await screen.findByTestId("dashboard-error");
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
  });

  it("retry action counts as a fresh attempt (new start + finish pair)", async () => {
    fetchSpy
      .mockRejectedValueOnce(new MockDashboardFetchError("network", "boom"))
      .mockResolvedValueOnce(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByTestId("dashboard-empty");

    // Two attempts total — one initial + one retry.
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(2);
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(2);
  });

  it("calls recordAttemptFinished even when the loader is canceled mid-flight (unmount)", async () => {
    // Repro: user opens the dashboard, fetch is slow, user navigates away
    // (or auth flips) before it resolves.  The previous implementation
    // skipped recordAttemptFinished on the canceled path, leaving the
    // refresh context's in-flight flag stuck true.
    let resolveFetch: ((v: unknown) => void) | null = null;
    fetchSpy.mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; })
    );
    const view = renderAt(null);
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    expect(recordAttemptFinishedSpy).not.toHaveBeenCalled();

    // Tear the component down before the fetch resolves.
    view.unmount();
    expect(recordAttemptFinishedSpy).not.toHaveBeenCalled();

    // Now let the stale fetch settle — finally must still fire the cleanup.
    await act(async () => {
      resolveFetch?.(OK_RESULT);
    });
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
  });

  it("calls recordAttemptFinished on the canceled path when the loader rejects", async () => {
    let rejectFetch: ((e: unknown) => void) | null = null;
    fetchSpy.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectFetch = reject; })
    );
    const view = renderAt(null);
    view.unmount();
    await act(async () => {
      rejectFetch?.(new MockDashboardFetchError("network", "boom"));
    });
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Footer baseline alignment with the header ───────────────────────────────
// Real-world bug: header read "Last refresh 9:24 PM" while the footer claimed
// "Next refresh in ~59m" because the dashboard's page-load loader stamped a
// fresh `lastAttemptAt` even though the server's `lastCheckedAt` (what the
// header surfaces) was still 9:24 PM.  Footer must use the same anchor as
// the header so the math is coherent.

describe("Footer baseline alignment with lastRefreshedAt", () => {
  it("uses lastRefreshedAt as the countdown baseline even when lastAttemptAt is fresher", async () => {
    // Header shows ~37 min ago; current time is "now".  Footer should read
    // ~23m (60 - 37) — NOT ~60m anchored to a freshly-stamped lastAttemptAt.
    const elapsedMs = 37 * 60 * 1000 + 1000;
    mockLastRefreshedAt = new Date(Date.now() - elapsedMs).toISOString();
    mockLastAttemptAt = Date.now() - 1000; // just stamped — must be ignored
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Next refresh in ~23m");
  });

  it("falls back to lastAttemptAt only when lastRefreshedAt is null", async () => {
    // No server timestamp yet (e.g. pre-first-refresh on a fresh session) —
    // local stamp is the only baseline.  Still renders a sensible countdown.
    mockLastRefreshedAt = null;
    mockLastAttemptAt = Date.now() - (20 * 60 * 1000 + 1000);
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Next refresh in ~40m");
  });

  it("isRefreshing wins over the baseline (true in-flight always shows 'Refreshing now…')", async () => {
    // Baseline would render "~30m" but a fetch is genuinely in flight —
    // the in-flight copy must dominate.
    mockLastRefreshedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockLastAttemptAt = Date.now() - 30 * 60 * 1000;
    mockIsRefreshing = true;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Refreshing now…");
  });

  it("renders 'Refreshing now…' when the lastRefreshedAt-derived baseline is past-due", async () => {
    // Heartbeat scheduling jitter (or a backgrounded tab) can produce a
    // baseline that's just past the 60-min boundary with no in-flight tick.
    // Footer prefers the in-flight copy over a negative/zero countdown.
    mockLastRefreshedAt = new Date(Date.now() - REFRESH_INTERVAL_MS - 60 * 1000).toISOString();
    mockLastAttemptAt = null;
    mockIsRefreshing = false;
    fetchSpy.mockResolvedValue(OK_RESULT);

    renderAt(null);
    await screen.findByTestId("dashboard-empty");

    expect(screen.getByTestId("refresh-footer").textContent).toBe("Refreshing now…");
  });
});

