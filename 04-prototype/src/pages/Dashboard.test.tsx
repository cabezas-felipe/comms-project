import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dashboard, { buildHeadline, shouldAdvanceClockForBootstrap } from "@/pages/Dashboard";
import { CONTRACT_VERSION, type StoryDto } from "@tempo/contracts";
import type { DashboardFetchResult } from "@/lib/api";
import { REFRESH_INTERVAL_MS } from "@/lib/refresh-heartbeat";

const fetchSpy = vi.fn();
const bootstrapSpy = vi.fn();
const refreshSpy = vi.fn();
const recoverSpy = vi.fn();
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
  refreshDashboard: (...args: unknown[]) => refreshSpy(...args),
  recoverDashboardViaGet: (...args: unknown[]) => recoverSpy(...args),
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

// Canonical mock result — matches the real DashboardFetchResult shape returned
// by fetchDashboardWithMeta / bootstrapDashboard / refreshDashboard. Spread
// from this base in every test ({ ...OK_RESULT, clusteringFailed: true }) so a
// mock never leaves a parsed field `undefined` and leaks stale state from a
// prior test (e.g. clusteringFailed left true without a remount).
const OK_RESULT = {
  payload: { contractVersion: CONTRACT_VERSION, stories: [] },
  selection: null,
  refreshedAt: null,
  lastCheckedAt: null,
  clusteringFailed: false,
  clusteringFailureReason: null,
  clusteringAttempts: null,
  clusteringLatencyMs: null,
  funnel: null,
  recall: null,
  whyEnrichment: null,
};

afterEach(() => {
  fetchSpy.mockReset();
  bootstrapSpy.mockReset();
  refreshSpy.mockReset();
  recoverSpy.mockReset();
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

function renderAtSearch(search: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/dashboard", search }]}>
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

// ─── Slice 2: forceRefresh routing + POST→GET silent recovery ────────────────
// 1) Onboarding handoff (`forceRefresh: true`) routes straight to POST /refresh
//    so the first view reflects freshly-saved settings (no stale-snapshot
//    bootstrap reuse).
// 2) When a POST loader fails after retries, a best-effort GET recovers the
//    persisted snapshot and renders it SILENTLY — no error block / banner /
//    toast — while still counting as a refresh attempt that advances the clock.
// 3) When the GET recovery also fails, the existing error UI is preserved.

describe("Slice 2: forceRefresh routing + POST→GET silent recovery", () => {
  it("forceRefresh state routes to the POST /refresh endpoint (not bootstrap, not GET)", async () => {
    refreshSpy.mockResolvedValue(OK_RESULT);
    // Onboarding navigates with BOTH flags; forceRefresh must win.
    renderAt({ bootstrap: true, forceRefresh: true });
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    await screen.findByTestId("dashboard-empty");
    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recoverSpy).not.toHaveBeenCalled();
  });

  it("Slice 4: forceRefresh requests the interactive fast-path profile (?interactive=1)", async () => {
    refreshSpy.mockResolvedValue(OK_RESULT);
    renderAt({ bootstrap: true, forceRefresh: true });
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    await screen.findByTestId("dashboard-empty");
    // The onboarding interactive entry must hit the interactive refresh endpoint
    // so the backend applies the balanced fast-path profile.
    const arg = refreshSpy.mock.calls[0][0] as { endpoint?: string } | undefined;
    expect(arg?.endpoint).toMatch(/\/api\/dashboard\/refresh\?interactive=1$/);
  });

  it("POST fail + GET success → silent recovery render (no error UI, no toast)", async () => {
    refreshSpy.mockRejectedValue(new MockDashboardFetchError("http", "503", 503));
    recoverSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "rec", title: "Recovered Story" })],
      },
    });
    renderAt({ bootstrap: true, forceRefresh: true });

    // The recovered snapshot's stories render…
    expect(await screen.findByText("Recovered Story")).toBeInTheDocument();
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    // …with zero error surfaces: no full-page error, no clustering-failed block,
    // no inline retry banner, no toast.
    expect(screen.queryByTestId("dashboard-error")).toBeNull();
    expect(screen.queryByTestId("dashboard-clustering-failed")).toBeNull();
    expect(notifyErrorSpy).not.toHaveBeenCalled();
  });

  it("POST fail + GET success advances the clock (recovered run still counts as an attempt)", async () => {
    refreshSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    recoverSpy.mockResolvedValue({ ...OK_RESULT, lastCheckedAt: "2026-05-11T14:00:00Z" });
    renderAt({ bootstrap: true, forceRefresh: true });
    await screen.findByTestId("dashboard-empty");

    // Exactly one attempt opened and one settled — no double-counting across
    // the POST + recovery legs.
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1));
    const [, options] = recordAttemptFinishedSpy.mock.calls[0];
    expect(options?.advanceClock).toBe(true);
    // The recovered GET result is threaded through so the anchor can prefer
    // its server-stamped lastCheckedAt.
    expect(options?.result).toMatchObject({ lastCheckedAt: "2026-05-11T14:00:00Z" });
  });

  it("POST fail + GET fail → existing error UI remains (recovery exhausted)", async () => {
    refreshSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    recoverSpy.mockResolvedValue(null); // GET recovery also failed
    renderAt({ bootstrap: true, forceRefresh: true });

    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    // Still settled as an attempt; failures advance the clock.
    await waitFor(() => expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1));
    const [, options] = recordAttemptFinishedSpy.mock.calls[0];
    expect(options?.advanceClock).toBe(true);
  });

  it("bootstrap POST fail + GET success also recovers silently (recovery covers both POST loaders)", async () => {
    bootstrapSpy.mockRejectedValue(new MockDashboardFetchError("http", "500", 500));
    recoverSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "rec-b", title: "Recovered Via Bootstrap" })],
      },
    });
    renderAt({ bootstrap: true });
    expect(await screen.findByText("Recovered Via Bootstrap")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-error")).toBeNull();
    expect(notifyErrorSpy).not.toHaveBeenCalled();
  });

  it("GET-path failure does NOT attempt recovery (GET is already the snapshot read)", async () => {
    fetchSpy.mockRejectedValue(new MockDashboardFetchError("network", "boom"));
    renderAt(null);
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    expect(recoverSpy).not.toHaveBeenCalled();
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

  it("renders the dedicated clustering-failed empty state (NOT the quiet-beat copy) when clusteringFailed=true", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      clusteringFailed: true,
      clusteringFailureReason: "timeout",
    });
    renderAt(null);
    expect(await screen.findByTestId("dashboard-clustering-failed")).toBeInTheDocument();
    expect(screen.getByText("Couldn't compose stories this refresh.")).toBeInTheDocument();
    // Must NOT show the generic quiet-beat empty state.
    expect(screen.queryByTestId("dashboard-empty")).toBeNull();
    expect(screen.queryByText("No stories yet.")).toBeNull();
  });

  it("clustering-failed empty state offers a Refresh action that re-invokes the loader", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ...OK_RESULT,
        clusteringFailed: true,
        clusteringFailureReason: "error",
      })
      .mockResolvedValueOnce(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-clustering-failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    // Second load is a normal empty → generic quiet-beat copy returns.
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("quiet beat (empty stories, clusteringFailed=false) keeps the generic empty state", async () => {
    fetchSpy.mockResolvedValue({ ...OK_RESULT, clusteringFailed: false });
    renderAt(null);
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-clustering-failed")).toBeNull();
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
    subtitle: "k",
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
    ...OK_RESULT,
    payload: { contractVersion: CONTRACT_VERSION, stories },
  });
  return renderAt(null);
}

describe("Slice 3: debug run-diagnostics panel", () => {
  const DIAG_RESULT = {
    ...OK_RESULT,
    payload: { contractVersion: CONTRACT_VERSION, stories: [] },
    clusteringFailed: false,
    clusteringAttempts: 1,
    funnel: {
      totalNormalized: 33,
      afterTimeWindow: 30,
      afterSourceSelection: 20,
      afterGeoFilter: 18,
      afterTopicKeyword: 12,
      afterBeatFit: 8,
      afterDedupe: 6,
      finalStories: 2,
      primaryDropStage: "geo_filter",
      executionMode: "full_run",
    },
    recall: {
      mode: "hybrid_strict",
      keywordRecallCount: 12,
      finalRelevant: 8,
      similarityRejected: 3,
      minSimilarityThreshold: 0.4,
    },
    selection: {
      matchedSourceCount: 2,
      selectedSourceCount: 2,
      unavailableConnectorSources: [],
      matchedFeedIds: ["reuters-world-us"],
    },
  };

  it("renders the panel with clustering/funnel/recall/selection when ?debug=1 and _meta carries diagnostics", async () => {
    fetchSpy.mockResolvedValue(DIAG_RESULT);
    renderAtSearch("?debug=1");
    await screen.findByTestId("dashboard-empty");
    expect(screen.getByTestId("dashboard-run-diagnostics")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("diag-funnel").textContent).toContain("33 → 30")
    );
    expect(screen.getByTestId("diag-funnel").textContent).toContain("primary_drop=geo_filter");
    expect(screen.getByTestId("diag-recall").textContent).toContain("keyword=12");
    expect(screen.getByTestId("diag-recall").textContent).toContain("semantic_rejected=3");
    expect(screen.getByTestId("diag-recall").textContent).toContain("floor=0.40");
    expect(screen.getByTestId("diag-clustering").textContent).toContain("ok");
    expect(screen.getByTestId("diag-selection").textContent).toContain("matched=2/2");
    expect(screen.getByTestId("diag-selection").textContent).toContain("reuters-world-us");
  });

  it("shows clustering-failed detail in the panel when the run failed closed", async () => {
    fetchSpy.mockResolvedValue({
      ...DIAG_RESULT,
      clusteringFailed: true,
      clusteringFailureReason: "timeout",
      clusteringAttempts: 2,
    });
    renderAtSearch("?debug=1");
    await screen.findByTestId("dashboard-clustering-failed");
    await waitFor(() =>
      expect(screen.getByTestId("diag-clustering").textContent).toContain("failed")
    );
    expect(screen.getByTestId("diag-clustering").textContent).toContain("reason=timeout");
    expect(screen.getByTestId("diag-clustering").textContent).toContain("attempts=2");
  });

  it("hides the panel by default (no debug flag, UX test mode off)", async () => {
    fetchSpy.mockResolvedValue(DIAG_RESULT);
    renderAt(null);
    await screen.findByTestId("dashboard-empty");
    expect(screen.queryByTestId("dashboard-run-diagnostics")).toBeNull();
  });
});

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

  it("hides all sections when no stories carry tags (no fallback to root topic/geographies)", async () => {
    // Stories without `tags` at all — every header-pill section must stay
    // empty.  Tags are now the sole source of truth; root `story.topic` and
    // `story.geographies` are never used to fabricate pills.
    renderWithStories([
      makeStoryDto({ id: "x", title: "X", topic: "Diplomatic relations", geographies: ["US"] }),
    ]);
    await waitFor(() => expect(screen.getByText("X")).toBeInTheDocument());
    expect(screen.queryByTestId(/pill-keyword-/)).toBeNull();
    expect(screen.queryByTestId(/pill-topic-/)).toBeNull();
    expect(screen.queryByTestId(/pill-geo-/)).toBeNull();
  });

  // ─── Phase 6: UI polish + trust-first empty states ────────────────────────
  //
  // The following tests cover the new Phase 6 behavior on the pill row:
  //   1. Empty-tag caption appears when stories exist but no tag axis has
  //      values; suppressed when ANY axis has values.
  //   2. The row carries assistive-tech semantics (role="group" + label).
  //   3. Semantic diagnostics never leak into the rendered output.
  //   4. Section separators only render between non-empty sections — no
  //      orphan "· ·" double-dot regression.

  it("shows the trust-first 'No tag groups yet' caption when stories exist but no tags surface", async () => {
    renderWithStories([
      makeStoryDto({ id: "x", title: "Story X" }), // no `tags` field
    ]);
    await waitFor(() => expect(screen.getByText("Story X")).toBeInTheDocument());
    expect(screen.getByTestId("pill-row-empty-caption").textContent).toMatch(
      /No tag groups yet/i
    );
    // Only the "All" pill is present alongside the caption — no fake pills.
    expect(screen.queryByTestId(/pill-topic-/)).toBeNull();
    expect(screen.queryByTestId(/pill-keyword-/)).toBeNull();
    expect(screen.queryByTestId(/pill-geo-/)).toBeNull();
    expect(screen.getByTestId("pill-all")).toBeInTheDocument();
  });

  it("hides the empty caption when at least one tag section has values", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    expect(screen.queryByTestId("pill-row-empty-caption")).toBeNull();
  });

  it("renders the pill row with assistive-tech semantics (role='group' + aria-label)", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    const row = screen.getByTestId("header-pill-row");
    expect(row.getAttribute("role")).toBe("group");
    expect(row.getAttribute("aria-label")).toMatch(/filter stories by tag/i);
  });

  it("does not render any operator-only diagnostic strings (runtimeState, latency, fallback reasons)", async () => {
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    expect(screen.queryByText(/runtimeState/i)).toBeNull();
    expect(screen.queryByText(/scorerLatencyMs/i)).toBeNull();
    expect(screen.queryByText(/belowThresholdCount/i)).toBeNull();
    expect(screen.queryByText(/semanticApplied/i)).toBeNull();
    expect(screen.queryByText(/fallbackReasonCounts/i)).toBeNull();
  });

  it("does NOT render a section separator before the first non-empty section (no leading dot)", async () => {
    // Single story with ONLY keywords — the row should be "All [·] keyword-pills",
    // never "All · · keyword-pills" with an orphan separator.
    renderWithStories([
      makeStoryDto({
        id: "kw-only",
        title: "Keywords Only",
        tags: { topics: [], keywords: ["OFAC"], geographies: [] },
      }),
    ]);
    await waitFor(() => expect(screen.getByText("Keywords Only")).toBeInTheDocument());
    const row = screen.getByTestId("header-pill-row");
    const text = row.textContent ?? "";
    // No double-dot regression — the row should never contain "· ·".
    expect(text).not.toMatch(/·\s*·/);
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
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "init", title: "Initial Story" })],
      },
    });
    renderAt(null);
    expect(await screen.findByText("Initial Story")).toBeInTheDocument();

    // Heartbeat tick succeeds at app scope — provider pushes a new result.
    mockHeartbeatResult = {
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "next", title: "Refreshed Story" })],
      },
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
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "next", title: "Refreshed Story" })],
      },
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


// ─── Slice 5: progressive whyItMatters enrichment (defer → poll → patch) ─────
// The interactive onboarding path first-paints stories with non-empty fallback
// whyItMatters, then the dashboard polls GET /api/dashboard while enrichment is
// pending and patches the open story card's "Why this matters" copy in place —
// no full-page reset — stopping once pending hits 0 or the budget is exhausted.

describe("Slice 5: progressive whyItMatters enrichment", () => {
  const FALLBACK_WHY = "Fallback why copy (baseline).";
  const RICH_WHY = "Upgraded, richer why-this-matters copy.";

  function deferredResult(why: string) {
    return {
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "m1", title: "Story M1", whyItMatters: why })],
      },
      whyEnrichment: { deferred: true, pending: 1, completed: 0, total: 1, upgradeLatencyMs: null },
    };
  }
  function upgradedResult(why: string) {
    return {
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [makeStoryDto({ id: "m1", title: "Story M1", whyItMatters: why })],
      },
      whyEnrichment: { deferred: false, pending: 0, completed: 1, total: 1, upgradeLatencyMs: 42 },
    };
  }

  it("polls and upgrades whyItMatters IN PLACE while the card is open, then stops polling", async () => {
    vi.useFakeTimers();
    try {
      refreshSpy.mockResolvedValue(deferredResult(FALLBACK_WHY)); // interactive first paint
      fetchSpy.mockResolvedValue(upgradedResult(RICH_WHY)); // poll GET returns upgraded
      renderAt({ bootstrap: true, forceRefresh: true });
      // Flush the interactive first-paint load.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // Expand the card to reveal "Why this matters"; fallback shows first.
      fireEvent.click(screen.getByText("Story M1"));
      expect(screen.getByText(FALLBACK_WHY)).toBeInTheDocument();
      // Poll fires at the 3s interval → patches whyItMatters in place. The card
      // stays expanded (no reset), so the upgraded copy appears immediately.
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(screen.getByText(RICH_WHY)).toBeInTheDocument();
      expect(screen.queryByText(FALLBACK_WHY)).toBeNull();
      // Pending hit 0 → polling stops: no further GET calls.
      const callsAfterUpgrade = fetchSpy.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
      expect(fetchSpy.mock.calls.length).toBe(callsAfterUpgrade);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the non-empty fallback copy and stops polling at the timeout budget when enrichment never completes", async () => {
    vi.useFakeTimers();
    try {
      refreshSpy.mockResolvedValue(deferredResult(FALLBACK_WHY));
      // Every poll still reports pending (slow / failing enrichment).
      fetchSpy.mockResolvedValue(deferredResult(FALLBACK_WHY));
      renderAt({ bootstrap: true, forceRefresh: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByText("Story M1"));
      expect(screen.getByText(FALLBACK_WHY)).toBeInTheDocument();
      // Advance past the 60s budget → polling stops; fallback persists; no error UI.
      await act(async () => { await vi.advanceTimersByTimeAsync(70000); });
      expect(screen.getByText(FALLBACK_WHY)).toBeInTheDocument();
      expect(screen.queryByTestId("dashboard-error")).toBeNull();
      const callsAtStop = fetchSpy.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(fetchSpy.mock.calls.length).toBe(callsAtStop); // stopped after budget
    } finally {
      vi.useRealTimers();
    }
  });

  it("Slice 6 follow-through: after bounded polling stops at budget, a later heartbeat refresh still upgrades the why copy in place", async () => {
    vi.useFakeTimers();
    try {
      refreshSpy.mockResolvedValue(deferredResult(FALLBACK_WHY)); // interactive first paint
      fetchSpy.mockResolvedValue(deferredResult(FALLBACK_WHY)); // poll never completes
      renderAt({ bootstrap: true, forceRefresh: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByText("Story M1"));
      expect(screen.getByText(FALLBACK_WHY)).toBeInTheDocument();
      // Exhaust the 60s poll budget → active polling stops; fallback persists.
      await act(async () => { await vi.advanceTimersByTimeAsync(70000); });
      const callsAtStop = fetchSpy.mock.calls.length;
      expect(screen.getByText(FALLBACK_WHY)).toBeInTheDocument();
      // A later BACKGROUND heartbeat refresh produces the upgraded copy — proves
      // no permanent template lock-in. The overlay patches the open card in place.
      mockHeartbeatResult = upgradedResult(RICH_WHY);
      await act(async () => { fireEvent.click(screen.getByTestId("pill-all")); });
      expect(screen.getByText(RICH_WHY)).toBeInTheDocument();
      // Active polling did NOT resume (still stopped after the budget).
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(fetchSpy.mock.calls.length).toBe(callsAtStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT poll when the run is not deferred (default/non-interactive load)", async () => {
    vi.useFakeTimers();
    try {
      // Non-deferred GET load — whyEnrichment null → no polling.
      fetchSpy.mockResolvedValue({ ...OK_RESULT, payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "m1", title: "Story M1" })] } });
      renderAt(null);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const callsAfterLoad = fetchSpy.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      // No poll cadence engaged — call count unchanged.
      expect(fetchSpy.mock.calls.length).toBe(callsAfterLoad);
    } finally {
      vi.useRealTimers();
    }
  });
});
