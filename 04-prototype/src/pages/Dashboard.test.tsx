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
const statusSpy = vi.fn();
const notifyErrorSpy = vi.fn();
const notifyWarningSpy = vi.fn();
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

// Phase 1.2: the dashboard fetches the saved settings vocabulary on load and
// intersects the pill row against it.  Tests drive the vocabulary (and a
// fetch-failure path) through these mutable knobs.  The default is a superset
// of every tag carried by PHASE6_STORIES so the pre-existing pill tests keep
// rendering the same pills.
const DEFAULT_SETTINGS_VOCAB = {
  topics: ["Diplomatic relations", "Migration policy"],
  keywords: ["sanctions", "OFAC", "asylum", "iran trade"],
  geographies: ["US", "Colombia"],
};
let mockSettingsVocab: { topics: string[]; keywords: string[]; geographies: string[] } = {
  ...DEFAULT_SETTINGS_VOCAB,
};
let mockSettingsShouldReject = false;

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
  fetchRefreshStatus: (...args: unknown[]) => statusSpy(...args),
  DashboardFetchError: MockDashboardFetchError,
}));

vi.mock("@/lib/analytics", () => ({
  trackDashboardViewed: vi.fn(),
  trackSourceOpenError: vi.fn(),
  trackSourceOpened: vi.fn(),
  trackStoryExpanded: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({
  notifyError: (...args: unknown[]) => notifyErrorSpy(...args),
  notifyWarning: (...args: unknown[]) => notifyWarningSpy(...args),
}));

vi.mock("@/lib/settings-api", () => ({
  fetchSettingsPayload: () =>
    mockSettingsShouldReject
      ? Promise.reject(new Error("settings unavailable"))
      : Promise.resolve({
          contractVersion: CONTRACT_VERSION,
          topics: mockSettingsVocab.topics,
          keywords: mockSettingsVocab.keywords,
          geographies: mockSettingsVocab.geographies,
          traditionalSources: [],
          socialSources: [],
        }),
}));

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
  // Phase 4 · Step 3 fail-safe contract — default healthy.
  refreshStatus: "ok",
  refreshFailure: null,
  usedPriorSnapshot: false,
  // B6: deterministic-rescue (B3) + background-upgrade (B5) signals — default off.
  usedDeterministicClustering: false,
  clusteringLlmFailed: false,
  deterministicClusteringDiagnostics: null,
  upgradeRefreshScheduled: false,
  upgradeRefreshReason: null,
};

afterEach(() => {
  fetchSpy.mockReset();
  bootstrapSpy.mockReset();
  refreshSpy.mockReset();
  recoverSpy.mockReset();
  statusSpy.mockReset();
  notifyErrorSpy.mockReset();
  notifyWarningSpy.mockReset();
  seedAnchorIfMissingSpy.mockReset();
  recordAttemptStartSpy.mockReset();
  recordAttemptFinishedSpy.mockReset();
  mockHeartbeatResult = null;
  mockLastAttemptAt = null;
  mockIsRefreshing = false;
  mockLastRefreshedAt = null;
  mockSettingsVocab = { ...DEFAULT_SETTINGS_VOCAB };
  mockSettingsShouldReject = false;
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

  // ── Phase 4 · Step 3: refresh fail-safe surface ──────────────────────────
  it("Step 3: ok + 0 stories → quiet empty state (NOT a failure surface)", async () => {
    fetchSpy.mockResolvedValue({ ...OK_RESULT, refreshStatus: "ok", refreshFailure: null });
    renderAt(null);
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    expect(screen.getByText("No stories yet.")).toBeInTheDocument();
    // No failure surfaces.
    expect(screen.queryByTestId("dashboard-refresh-failed")).toBeNull();
    expect(screen.queryByTestId("dashboard-refresh-banner")).toBeNull();
  });

  it("Step 3: failed + 0 stories → failure-aware empty state, distinct from quiet", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      refreshStatus: "failed",
      usedPriorSnapshot: false,
      refreshFailure: { reason: "pipeline_exception", subtype: "unknown", attempts: 1, retryable: true, retryAfterMs: null, nextRetryAt: null },
    });
    renderAt(null);
    expect(await screen.findByTestId("dashboard-refresh-failed")).toBeInTheDocument();
    expect(screen.getByText("Couldn't refresh stories right now")).toBeInTheDocument();
    // Must NOT read as the quiet beat.
    expect(screen.queryByTestId("dashboard-empty")).toBeNull();
    expect(screen.queryByText("No stories yet.")).toBeNull();
  });

  it("Step 3: failed + stories + usedPriorSnapshot=true → renders stories WITH a non-blocking banner", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "kept-1", title: "Kept story" })] },
      refreshStatus: "failed",
      usedPriorSnapshot: true,
      refreshFailure: { reason: "clustering_failure", subtype: "timeout", attempts: 2, retryable: true, retryAfterMs: null, nextRetryAt: null },
    });
    renderAt(null);
    // Stories stay on-screen…
    expect(await screen.findByText("Kept story")).toBeInTheDocument();
    // …under the fail-safe warning banner.
    expect(screen.getByTestId("dashboard-refresh-banner")).toBeInTheDocument();
    // Neither the failure-empty nor the quiet-empty surfaces show with stories present.
    expect(screen.queryByTestId("dashboard-refresh-failed")).toBeNull();
    expect(screen.queryByTestId("dashboard-empty")).toBeNull();
  });

  it("Step 3: failed + stories + usedPriorSnapshot=false → NO banner (continuity not guaranteed)", async () => {
    // The "Showing your last results" copy must only appear when the server
    // explicitly marked the stories as preserved prior-snapshot continuity.
    // Without that guarantee we render the stories but suppress the banner.
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "kept-1", title: "Kept story" })] },
      refreshStatus: "failed",
      usedPriorSnapshot: false,
      refreshFailure: { reason: "clustering_failure", subtype: "timeout", attempts: 2, retryable: true, retryAfterMs: null, nextRetryAt: null },
    });
    renderAt(null);
    // Stories still render…
    expect(await screen.findByText("Kept story")).toBeInTheDocument();
    // …but the misleading banner is suppressed.
    expect(screen.queryByTestId("dashboard-refresh-banner")).toBeNull();
  });

  it("Step 3: the fail-safe banner retry routes through the default-profile refresh", async () => {
    fetchSpy.mockResolvedValueOnce({
      ...OK_RESULT,
      payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "kept-1", title: "Kept story" })] },
      refreshStatus: "failed",
      usedPriorSnapshot: true,
      refreshFailure: { reason: "clustering_failure", subtype: "timeout", attempts: 2, retryable: true, retryAfterMs: null, nextRetryAt: null },
    });
    refreshSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-refresh-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    // After a clean retry the banner clears and the quiet-beat empty returns.
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    expect(refreshSpy).toHaveBeenCalledWith({ endpoint: "/api/dashboard/refresh?profile=default" });
  });

  // ── B6: degraded deterministic-rescue surface ────────────────────────────
  it("B6: degraded + stories → renders stories WITH the non-blocking degraded banner, no hard failure", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "det-1", title: "Deterministic story" })] },
      refreshStatus: "degraded",
      usedPriorSnapshot: false,
      refreshFailure: { reason: "clustering_failure", subtype: "parse", attempts: 2, retryable: false, retryAfterMs: null, nextRetryAt: null },
      clusteringLlmFailed: true,
      usedDeterministicClustering: true,
      upgradeRefreshScheduled: true,
      upgradeRefreshReason: "degraded_deterministic_rescue",
    });
    renderAt(null);
    // Stories render normally…
    expect(await screen.findByText("Deterministic story")).toBeInTheDocument();
    // …under the subtle degraded cue (upgrade-in-progress copy).
    expect(screen.getByTestId("dashboard-refresh-degraded")).toBeInTheDocument();
    expect(screen.getByText(/Refining your story grouping in the background/i)).toBeInTheDocument();
    // NEVER the hard-failure / quiet-empty / failed-banner surfaces.
    expect(screen.queryByTestId("dashboard-refresh-failed")).toBeNull();
    expect(screen.queryByTestId("dashboard-refresh-banner")).toBeNull();
    expect(screen.queryByTestId("dashboard-empty")).toBeNull();
  });

  it("B6: degraded WITHOUT a scheduled upgrade → still renders the simpler-grouping cue", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "det-1", title: "Deterministic story" })] },
      refreshStatus: "degraded",
      refreshFailure: { reason: "clustering_failure", subtype: "parse", attempts: 2, retryable: false, retryAfterMs: null, nextRetryAt: null },
      clusteringLlmFailed: true,
      usedDeterministicClustering: true,
      upgradeRefreshScheduled: false,
    });
    renderAt(null);
    expect(await screen.findByText("Deterministic story")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-refresh-degraded")).toBeInTheDocument();
    expect(screen.getByText(/simpler grouping for now/i)).toBeInTheDocument();
  });

  it("B6: ok + stories → unchanged (stories render, no degraded/failure banners)", async () => {
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: { contractVersion: CONTRACT_VERSION, stories: [makeStoryDto({ id: "s-1", title: "Healthy story" })] },
      refreshStatus: "ok",
      refreshFailure: null,
    });
    renderAt(null);
    expect(await screen.findByText("Healthy story")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-refresh-degraded")).toBeNull();
    expect(screen.queryByTestId("dashboard-refresh-banner")).toBeNull();
    expect(screen.queryByTestId("dashboard-refresh-failed")).toBeNull();
  });

  it("Slice 10: clustering-failed Refresh action retries via the default-profile endpoint", async () => {
    fetchSpy.mockResolvedValueOnce({
      ...OK_RESULT,
      clusteringFailed: true,
      clusteringFailureReason: "error",
    });
    // Slice 10: retry routes through refreshDashboard (POST), not a GET.
    refreshSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-clustering-failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    // Second load is a normal empty → generic quiet-beat copy returns.
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    // Initial load was the GET; the retry ran the default-profile refresh POST.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith({
      endpoint: "/api/dashboard/refresh?profile=default",
    });
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

  it("Slice 10: error-state retry re-invokes the loader via the default-profile endpoint", async () => {
    fetchSpy.mockRejectedValueOnce(new MockDashboardFetchError("network", "boom"));
    // Slice 10: retry runs the default-profile refresh POST (not a GET).
    refreshSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("dashboard-empty")).toBeInTheDocument();
    // Initial failed load was the GET; the retry ran the default-profile refresh.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith({
      endpoint: "/api/dashboard/refresh?profile=default",
    });
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
    clusterCap: {
      dedupedCount: 20,
      clusterInputCount: 15,
      clusterDroppedCount: 5,
      clusterDroppedSourceIds: ["src-15", "src-16", "src-17", "src-18", "src-19"],
      clusterDropped: [
        { sourceId: "src-15", preClusterScore: 6.13, rank: 16, electionGeoClass: "crossCountryElection" },
        { sourceId: "src-16", preClusterScore: 5.91, rank: 17, electionGeoClass: "nonElection" },
        { sourceId: "src-17", preClusterScore: 5.44, rank: 18, electionGeoClass: "nonElection" },
      ],
      clusterInputCapEffective: 15,
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

  it("renders the cluster_cap row with deduped/kept/cap/dropped + scored top drops when ?debug=1", async () => {
    fetchSpy.mockResolvedValue(DIAG_RESULT);
    renderAtSearch("?debug=1");
    await screen.findByTestId("dashboard-empty");
    const row = await screen.findByTestId("diag-cluster-cap");
    expect(row.textContent).toContain("deduped=20 kept=15 cap=15 dropped=5");
    expect(row.textContent).toContain("top=[src-15(6.13), src-16(5.91), src-17(5.44)]");
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

// ─── Phase 1.2: settings-backed pill row ─────────────────────────────────────
//
// Pills shown = (current visible story tags) ∩ (saved settings vocabulary).
// The "All" pill is permanent, and filter semantics are unchanged (tags-only
// matching on the full story tags via `storyMatchesSelection`).  A story tag
// that is NOT in the saved settings vocabulary must never surface as a pill,
// and a settings-fetch failure must degrade gracefully (no out-of-settings
// pills, stories still render).

describe("Phase 1.2: settings-backed pills", () => {
  it("renders only pills whose values are in the fetched settings vocabulary (per-axis subset)", async () => {
    // Settings DROP "OFAC" (keyword) and "Colombia" (geography) relative to the
    // story tags.  Those values appear in PHASE6_STORIES tags but must NOT
    // render as pills; every other in-settings value still does.
    mockSettingsVocab = {
      topics: ["Diplomatic relations", "Migration policy"],
      keywords: ["sanctions", "asylum"],
      geographies: ["US"],
    };
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // In-settings values still render.
    await screen.findByTestId("pill-topic-Diplomatic relations");
    expect(screen.getByTestId("pill-topic-Migration policy")).toBeInTheDocument();
    expect(screen.getByTestId("pill-keyword-sanctions")).toBeInTheDocument();
    expect(screen.getByTestId("pill-keyword-asylum")).toBeInTheDocument();
    expect(screen.getByTestId("pill-geo-US")).toBeInTheDocument();

    // Out-of-settings story tags are NOT rendered as pills.
    expect(screen.queryByTestId("pill-keyword-OFAC")).toBeNull();
    expect(screen.queryByTestId("pill-geo-Colombia")).toBeNull();

    // Every rendered pill is a subset of the fetched settings, per axis.
    const row = screen.getByTestId("header-pill-row");
    const valuesFor = (prefix: string) =>
      Array.from(row.querySelectorAll(`[data-testid^='${prefix}']`)).map(
        (el) => el.getAttribute("data-testid")?.replace(prefix, "") ?? ""
      );
    for (const t of valuesFor("pill-topic-")) {
      expect(mockSettingsVocab.topics).toContain(t);
    }
    for (const k of valuesFor("pill-keyword-")) {
      expect(mockSettingsVocab.keywords).toContain(k);
    }
    for (const g of valuesFor("pill-geo-")) {
      expect(mockSettingsVocab.geographies).toContain(g);
    }
  });

  it("'All' pill is always present and clears filters even with a constrained settings vocabulary", async () => {
    mockSettingsVocab = {
      topics: ["Migration policy"],
      keywords: [],
      geographies: [],
    };
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // Permanent "All" pill.
    const all = await screen.findByTestId("pill-all");
    expect(all).toBeInTheDocument();
    // Only the in-settings topic surfaced.
    await screen.findByTestId("pill-topic-Migration policy");
    expect(screen.queryByTestId("pill-topic-Diplomatic relations")).toBeNull();

    // Filter by it → only Story B remains; "All" resets to the full feed.
    fireEvent.click(screen.getByTestId("pill-topic-Migration policy"));
    await waitFor(() => expect(screen.queryByText("Story A")).toBeNull());
    expect(screen.getByText("Story B")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pill-all"));
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    expect(screen.getByText("Story B")).toBeInTheDocument();
  });

  it("filtering stays tags-only and unchanged when pills are settings-backed", async () => {
    // Settings expose Migration policy + OFAC.  Selecting an in-settings pill
    // must still match against the FULL story tags (not the settings list):
    // Story A carries OFAC, Story B does not → AND across axes yields zero.
    mockSettingsVocab = {
      topics: ["Migration policy"],
      keywords: ["OFAC"],
      geographies: [],
    };
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    fireEvent.click(await screen.findByTestId("pill-topic-Migration policy"));
    fireEvent.click(screen.getByTestId("pill-keyword-OFAC"));
    // Story A has OFAC but topic=Diplomatic relations; Story B has Migration
    // policy but no OFAC → identical AND-across-sections result as Phase 6.
    await waitFor(() => {
      expect(screen.queryByText("Story A")).toBeNull();
      expect(screen.queryByText("Story B")).toBeNull();
    });
  });

  it("degrades gracefully when the settings fetch fails: no out-of-settings pills, stories still render", async () => {
    mockSettingsShouldReject = true;
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());

    // Story rendering + the permanent "All" pill survive the failure.
    expect(screen.getByText("Story B")).toBeInTheDocument();
    expect(screen.getByTestId("pill-all")).toBeInTheDocument();
    // Conservative posture: NO tag pills are introduced without a settings list.
    expect(screen.queryByTestId(/pill-topic-/)).toBeNull();
    expect(screen.queryByTestId(/pill-keyword-/)).toBeNull();
    expect(screen.queryByTestId(/pill-geo-/)).toBeNull();
  });

  it("applies the settings intersection to heartbeat-overlaid stories too", async () => {
    // Initial feed: in-settings story.  Settings expose only "Migration
    // policy" + "asylum" + "Colombia".
    mockSettingsVocab = {
      topics: ["Migration policy"],
      keywords: ["asylum"],
      geographies: ["Colombia"],
    };
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [
          makeStoryDto({
            id: "init",
            title: "Initial Story",
            tags: { topics: ["Migration policy"], keywords: ["asylum"], geographies: ["Colombia"] },
          }),
        ],
      },
    });
    renderAt(null);
    expect(await screen.findByText("Initial Story")).toBeInTheDocument();
    await screen.findByTestId("pill-topic-Migration policy");

    // Heartbeat overlays a story whose tags mix in-settings + out-of-settings
    // values.  The intersection must apply to the overlaid feed: only the
    // in-settings axis values become pills.
    mockHeartbeatResult = {
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [
          makeStoryDto({
            id: "next",
            title: "Refreshed Story",
            tags: {
              topics: ["Migration policy", "Diplomatic relations"],
              keywords: ["asylum", "OFAC"],
              geographies: ["Colombia", "US"],
            },
          }),
        ],
      },
      refreshedAt: "2026-05-11T13:00:00Z",
    };
    fireEvent.click(screen.getByTestId("pill-all"));
    await waitFor(() => expect(screen.queryByText("Initial Story")).toBeNull());
    expect(screen.getByText("Refreshed Story")).toBeInTheDocument();

    // In-settings values from the OVERLAID story render…
    expect(screen.getByTestId("pill-topic-Migration policy")).toBeInTheDocument();
    expect(screen.getByTestId("pill-keyword-asylum")).toBeInTheDocument();
    expect(screen.getByTestId("pill-geo-Colombia")).toBeInTheDocument();
    // …its out-of-settings tags do NOT.
    expect(screen.queryByTestId("pill-topic-Diplomatic relations")).toBeNull();
    expect(screen.queryByTestId("pill-keyword-OFAC")).toBeNull();
    expect(screen.queryByTestId("pill-geo-US")).toBeNull();
  });
});

// ─── Phase 1.3: pill subset regression sweep ─────────────────────────────────
//
// Mapping-agnostic guardrails: rather than naming specific in/out values,
// these sweep EVERY rendered pill and assert membership in the fetched
// settings vocabulary, per axis.  They make a regression obvious if the client
// ever leaks an out-of-settings pill label — through the initial-load path OR
// the heartbeat overlay path — and lock that filtering stays tags-only
// (independent of the settings vocabulary, no hidden client-side mapping).

describe("Phase 1.3: pill subset regression sweep", () => {
  // Read the rendered pill values per axis straight off the DOM testIds so the
  // assertion never assumes which values are in/out of settings.
  function renderedPillValues() {
    const row = screen.getByTestId("header-pill-row");
    const valuesFor = (prefix: string) =>
      Array.from(row.querySelectorAll(`[data-testid^='${prefix}']`)).map(
        (el) => el.getAttribute("data-testid")?.replace(prefix, "") ?? ""
      );
    return {
      topics: valuesFor("pill-topic-"),
      keywords: valuesFor("pill-keyword-"),
      geographies: valuesFor("pill-geo-"),
    };
  }

  function expectEveryPillWithin(vocab: {
    topics: string[];
    keywords: string[];
    geographies: string[];
  }) {
    const rendered = renderedPillValues();
    for (const t of rendered.topics) expect(vocab.topics).toContain(t);
    for (const k of rendered.keywords) expect(vocab.keywords).toContain(k);
    for (const g of rendered.geographies) expect(vocab.geographies).toContain(g);
    return rendered;
  }

  it("every rendered pill is within the settings vocabulary on initial load (story tags exceed the vocab)", async () => {
    // Vocab is a strict subset of the PHASE6_STORIES tag universe.
    mockSettingsVocab = {
      topics: ["Migration policy"],
      keywords: ["asylum"],
      geographies: ["US"],
    };
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    await screen.findByTestId("pill-topic-Migration policy");

    const rendered = expectEveryPillWithin(mockSettingsVocab);
    // Non-vacuous: the in-settings values that the stories carry DID render.
    expect(rendered.topics).toContain("Migration policy");
    expect(rendered.keywords).toContain("asylum");
    expect(rendered.geographies).toContain("US");
    // And the union of out-of-settings tag values is fully absent.
    expect(rendered.topics).not.toContain("Diplomatic relations");
    expect(rendered.keywords).not.toContain("OFAC");
    expect(rendered.keywords).not.toContain("sanctions");
    expect(rendered.geographies).not.toContain("Colombia");
  });

  it("every rendered pill stays within the settings vocabulary after a heartbeat overlay", async () => {
    mockSettingsVocab = {
      topics: ["Migration policy"],
      keywords: ["asylum"],
      geographies: ["Colombia"],
    };
    fetchSpy.mockResolvedValue({
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [
          makeStoryDto({
            id: "init",
            title: "Initial Story",
            tags: { topics: ["Migration policy"], keywords: ["asylum"], geographies: ["Colombia"] },
          }),
        ],
      },
    });
    renderAt(null);
    expect(await screen.findByText("Initial Story")).toBeInTheDocument();
    await screen.findByTestId("pill-topic-Migration policy");
    expectEveryPillWithin(mockSettingsVocab);

    // Heartbeat overlays a feed whose tags mix in- and out-of-settings values.
    mockHeartbeatResult = {
      ...OK_RESULT,
      payload: {
        contractVersion: CONTRACT_VERSION,
        stories: [
          makeStoryDto({
            id: "next",
            title: "Refreshed Story",
            tags: {
              topics: ["Migration policy", "Diplomatic relations"],
              keywords: ["asylum", "OFAC", "sanctions"],
              geographies: ["Colombia", "US"],
            },
          }),
        ],
      },
      refreshedAt: "2026-05-11T13:00:00Z",
    };
    fireEvent.click(screen.getByTestId("pill-all"));
    await waitFor(() => expect(screen.queryByText("Initial Story")).toBeNull());
    expect(screen.getByText("Refreshed Story")).toBeInTheDocument();

    // The sweep must still hold against the OVERLAID story's larger tag set.
    const rendered = expectEveryPillWithin(mockSettingsVocab);
    expect(rendered.topics).toContain("Migration policy");
    expect(rendered.keywords).toContain("asylum");
    expect(rendered.geographies).toContain("Colombia");
  });

  it("settings-fetch failure keeps the conservative posture: zero tag pills, All present, stories render", async () => {
    mockSettingsShouldReject = true;
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    expect(screen.getByText("Story B")).toBeInTheDocument();
    expect(screen.getByTestId("pill-all")).toBeInTheDocument();

    const rendered = renderedPillValues();
    expect(rendered.topics).toEqual([]);
    expect(rendered.keywords).toEqual([]);
    expect(rendered.geographies).toEqual([]);
  });

  it("filtering is tags-only and independent of the settings vocabulary (no hidden client mapping)", async () => {
    // Settings expose ONLY a topic — no keywords/geographies in the vocab.
    mockSettingsVocab = { topics: ["Diplomatic relations"], keywords: [], geographies: [] };
    renderWithStories(PHASE6_STORIES);
    await waitFor(() => expect(screen.getByText("Story A")).toBeInTheDocument());
    // Only the in-settings topic pill renders.
    await screen.findByTestId("pill-topic-Diplomatic relations");
    expect(screen.queryByTestId("pill-topic-Migration policy")).toBeNull();
    expect(screen.queryByTestId(/pill-keyword-/)).toBeNull();
    expect(screen.queryByTestId(/pill-geo-/)).toBeNull();

    // Selecting it filters by the story's FULL tags: Story A matches on its
    // "Diplomatic relations" topic and stays visible even though its keyword
    // and geography tags are entirely outside the (empty) settings vocab —
    // proving the filter never consults the settings list.
    fireEvent.click(screen.getByTestId("pill-topic-Diplomatic relations"));
    await waitFor(() => expect(screen.queryByText("Story B")).toBeNull());
    expect(screen.getByText("Story A")).toBeInTheDocument();
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

  it("Slice 10: retry of a failed GET engages the attempt lifecycle (it's now a refresh)", async () => {
    fetchSpy.mockRejectedValueOnce(new MockDashboardFetchError("network", "boom"));
    refreshSpy.mockResolvedValue(OK_RESULT);
    renderAt(null);
    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    // Initial GET failed → not an attempt.
    expect(recordAttemptStartSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByTestId("dashboard-empty");

    // Slice 10: the retry runs the default-profile refresh POST, which IS a
    // refresh attempt — the lifecycle now engages exactly once for it.
    expect(recordAttemptStartSpy).toHaveBeenCalledTimes(1);
    expect(recordAttemptFinishedSpy).toHaveBeenCalledTimes(1);
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

  it("does not overlap poll requests: a slow poll blocks the next tick until it resolves", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(v: unknown) => void> = [];
    try {
      refreshSpy.mockResolvedValue(deferredResult(FALLBACK_WHY)); // interactive first paint
      // Each poll GET returns a promise we resolve manually, so we can hold the
      // first request "in flight" across interval ticks.
      fetchSpy.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
      renderAt({ bootstrap: true, forceRefresh: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      // First interval tick → exactly one GET, left pending (unresolved).
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(fetchSpy.mock.calls.length).toBe(1);

      // Next tick while the first poll is STILL in flight → no second GET.
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(fetchSpy.mock.calls.length).toBe(1);

      // Resolve the first poll with a still-pending result → polling continues.
      // Flush microtasks inside act() so the resolved-poll continuation
      // (setStories / setWhyEnrichment) is wrapped — no act(...) warning.
      await act(async () => {
        resolvers[0](deferredResult(FALLBACK_WHY));
        await vi.advanceTimersByTimeAsync(0);
      });

      // Now the next tick may proceed normally → a second GET fires.
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(fetchSpy.mock.calls.length).toBe(2);
    } finally {
      // Drain any outstanding poll promises INSIDE act() and flush their
      // continuations so no post-test state update leaks (no act warning).
      await act(async () => {
        resolvers.forEach((r) => r(deferredResult(FALLBACK_WHY)));
        await vi.advanceTimersByTimeAsync(0);
      });
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

// ─── Slice 9: cold-start JOIN (poll prefetch status, minimal progress UI) ─────

describe("Slice 9: cold-start JOIN mode", () => {
  const runningStatus = (phase: string) => ({
    jobId: "u1",
    status: "running" as const,
    phase,
    storyCount: null,
    failureReason: null,
  });
  const doneStatus = {
    jobId: "u1",
    status: "done" as const,
    phase: "done",
    storyCount: 1,
    failureReason: null,
  };
  const failedStatus = {
    jobId: "u1",
    status: "failed" as const,
    phase: "done",
    storyCount: null,
    failureReason: "clustering_timeout",
  };

  it("polls refresh-status and does NOT immediately fire a refresh POST while JOIN is active", async () => {
    vi.useFakeTimers();
    try {
      statusSpy.mockResolvedValue(runningStatus("ingesting"));
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // Status polled with the handed-off job id…
      expect(statusSpy).toHaveBeenCalledWith("u1");
      // …and NO refresh/bootstrap/GET kicked off while the join is active.
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(bootstrapSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      // Minimal progress UI is present.
      expect(screen.getByTestId("cold-start-progress")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates phase progress copy as the running phase advances", async () => {
    vi.useFakeTimers();
    try {
      statusSpy
        .mockResolvedValueOnce(runningStatus("ingesting"))
        .mockResolvedValue(runningStatus("matching"));
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId("cold-start-progress").textContent).toBe("Gathering sources…");
      // Next 2s poll reports the matching phase → copy updates in place.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.getByTestId("cold-start-progress").textContent).toBe("Matching your beat…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("running → done exits JOIN and renders loaded data via GET (no duplicate refresh POST)", async () => {
    vi.useFakeTimers();
    try {
      statusSpy
        .mockResolvedValueOnce(runningStatus("clustering"))
        .mockResolvedValue(doneStatus);
      fetchSpy.mockResolvedValue({
        ...OK_RESULT,
        payload: {
          contractVersion: CONTRACT_VERSION,
          stories: [makeStoryDto({ id: "j1", title: "Joined Story" })],
        },
      });
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // running
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // done → load
      await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // flush GET render
      expect(screen.getByText("Joined Story")).toBeInTheDocument();
      // Loaded via GET; the prefetch already ran the refresh — no duplicate POST.
      expect(fetchSpy).toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(bootstrapSpy).not.toHaveBeenCalled();
      // Progress UI is gone once the data renders.
      expect(screen.queryByTestId("cold-start-progress")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("running → failed exits JOIN and routes into the clustering-failed empty path (no auto-retry)", async () => {
    vi.useFakeTimers();
    try {
      statusSpy
        .mockResolvedValueOnce(runningStatus("clustering"))
        .mockResolvedValue(failedStatus);
      // The fail-closed snapshot the GET returns: 0 stories, clusteringFailed.
      fetchSpy.mockResolvedValue({
        ...OK_RESULT,
        clusteringFailed: true,
        clusteringFailureReason: "timeout",
      });
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // running
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // failed → load
      await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // flush GET render
      expect(screen.getByTestId("dashboard-clustering-failed")).toBeInTheDocument();
      // GET loaded the fail-closed snapshot; no duplicate refresh POST, no auto-retry.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out at 60s → warning toast + falls back to the existing loader path (refresh POST)", async () => {
    vi.useFakeTimers();
    try {
      statusSpy.mockResolvedValue(runningStatus("ingesting")); // never settles
      refreshSpy.mockResolvedValue(OK_RESULT);
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // No fallback load yet while still polling.
      expect(refreshSpy).not.toHaveBeenCalled();
      // Cross the 60s budget → timeout.
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // flush fallback loader
      expect(notifyWarningSpy).toHaveBeenCalledTimes(1);
      // Falls back to the existing onboarding loader path: POST /refresh.
      expect(refreshSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("short-circuits on a terminal HTTP error (404) → immediate fallback, no 60s wait", async () => {
    vi.useFakeTimers();
    try {
      // The status endpoint forbids/misses the job — retrying can never recover.
      statusSpy.mockRejectedValue(new MockDashboardFetchError("http", "not found", 404));
      refreshSpy.mockResolvedValue(OK_RESULT);
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      // First poll (t=0) rejects with 404 → immediate terminal fallback. No need
      // to advance anywhere near the 60s budget.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // flush fallback loader
      expect(notifyWarningSpy).toHaveBeenCalledTimes(1);
      // Fell back to the existing loader path immediately…
      expect(refreshSpy).toHaveBeenCalled();
      // …and only polled once (did NOT keep retrying to the deadline).
      expect(statusSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("also short-circuits on a 403 terminal HTTP error", async () => {
    vi.useFakeTimers();
    try {
      statusSpy.mockRejectedValue(new MockDashboardFetchError("http", "forbidden", 403));
      refreshSpy.mockResolvedValue(OK_RESULT);
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(notifyWarningSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying transient errors (network / 500) until the 60s deadline", async () => {
    vi.useFakeTimers();
    try {
      // Network errors and non-terminal HTTP statuses must NOT short-circuit.
      statusSpy
        .mockRejectedValueOnce(new MockDashboardFetchError("network", "offline"))
        .mockRejectedValue(new MockDashboardFetchError("http", "server error", 500));
      refreshSpy.mockResolvedValue(OK_RESULT);
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // Still polling after the first failure — no early fallback.
      expect(notifyWarningSpy).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
      // Multiple retries occur as the budget elapses…
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(statusSpy.mock.calls.length).toBeGreaterThan(1);
      // …and only at the 60s deadline do we fall back.
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(notifyWarningSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores JOIN mode and uses the normal loader when no coldStartJobId is present", async () => {
    fetchSpy.mockResolvedValue(OK_RESULT);
    refreshSpy.mockResolvedValue(OK_RESULT);
    renderAt({ bootstrap: true, forceRefresh: true }); // no coldStartJobId
    await screen.findByTestId("dashboard-empty");
    // Existing behavior: forceRefresh path POSTs /refresh; status never polled.
    expect(refreshSpy).toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cold-start-progress")).toBeNull();
  });

  // ─── Slice 10: retry clears JOIN and runs default profile ──────────────────

  it("Slice 10: retry from a join-derived state clears join + does not resume polling, loads via default-profile refresh", async () => {
    vi.useFakeTimers();
    try {
      // Join is polling (never settles); a fail-closed snapshot is available so a
      // Retry control is on screen once we exit the join.
      statusSpy.mockResolvedValue({
        jobId: "u1", status: "running", phase: "ingesting", storyCount: null, failureReason: null,
      });
      refreshSpy.mockResolvedValue({ ...OK_RESULT, clusteringFailed: true, clusteringFailureReason: "timeout" });
      renderAt({ bootstrap: true, forceRefresh: true, coldStartJobId: "u1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // JOIN owns the screen: progress shown, no refresh POST yet.
      expect(screen.getByTestId("cold-start-progress")).toBeInTheDocument();
      expect(refreshSpy).not.toHaveBeenCalled();

      // Force a timeout so the fail-closed snapshot + Retry control render.
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const pollsBeforeRetry = statusSpy.mock.calls.length;

      // User retries from the fail-closed state.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
        await vi.advanceTimersByTimeAsync(0);
      });

      // JOIN is cleared (no progress UI) and status polling does not resume.
      expect(screen.queryByTestId("cold-start-progress")).toBeNull();
      expect(statusSpy.mock.calls.length).toBe(pollsBeforeRetry);
      // The retry ran the default-profile refresh (overriding the prior path).
      expect(refreshSpy).toHaveBeenCalledWith({
        endpoint: "/api/dashboard/refresh?profile=default",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Slice 10: the onboarding first paint still uses the interactive endpoint (retry-only override)", async () => {
    refreshSpy.mockResolvedValue(OK_RESULT);
    renderAt({ bootstrap: true, forceRefresh: true }); // onboarding handoff, no retry yet
    await screen.findByTestId("dashboard-empty");
    // Untouched: the first onboarding paint requests the interactive fast-path.
    expect(refreshSpy).toHaveBeenCalledWith({
      endpoint: "/api/dashboard/refresh?interactive=1",
    });
    expect(refreshSpy).not.toHaveBeenCalledWith({
      endpoint: "/api/dashboard/refresh?profile=default",
    });
  });
});
