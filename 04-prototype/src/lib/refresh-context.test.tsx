import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { RefreshHeartbeatProvider, useRefreshContext } from "@/lib/refresh-context";
import type { DashboardFetchResult } from "@/lib/api";

const writeLastAttemptAtSpy = vi.fn();

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ recognizedIdentity: { email: "u@example.com", userId: "u1" } }),
}));
vi.mock("@/lib/refresh-heartbeat", () => ({
  useRefreshHeartbeat: () => {},
  readLastAttemptAt: () => null,
  writeLastAttemptAt: (...args: unknown[]) => writeLastAttemptAtSpy(...args),
  LAST_REFRESH_ATTEMPT_KEY: "tempo_dashboard_last_refresh_attempt_at",
  REFRESH_INTERVAL_MS: 60 * 60 * 1000,
}));
vi.mock("@/lib/analytics", () => ({
  trackSourceOpenError: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({
  notifyError: vi.fn(),
}));

afterEach(() => {
  writeLastAttemptAtSpy.mockReset();
});

function HarnessConsumer({ onRecord }: { onRecord: (record: (r: DashboardFetchResult) => void, value: string | null) => void }) {
  const { lastRefreshedAt, recordSuccessfulRefresh } = useRefreshContext();
  onRecord(recordSuccessfulRefresh, lastRefreshedAt);
  return <div data-testid="ts">{lastRefreshedAt ?? "none"}</div>;
}

function renderProvider(children: ReactNode) {
  return render(<RefreshHeartbeatProvider>{children}</RefreshHeartbeatProvider>);
}

function makeResult(overrides: Partial<DashboardFetchResult>): DashboardFetchResult {
  return {
    payload: { contractVersion: CONTRACT_VERSION, stories: [] },
    selection: null,
    refreshedAt: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

describe("RefreshHeartbeatProvider — last-check display precedence", () => {
  it("prefers lastCheckedAt over refreshedAt when both are present", () => {
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => {
      recordFn!(
        makeResult({
          refreshedAt: "2026-05-08T08:00:00Z",
          lastCheckedAt: "2026-05-08T09:00:00Z",
        })
      );
    });
    expect(screen.getByTestId("ts").textContent).toBe("2026-05-08T09:00:00Z");
  });

  it("falls back to refreshedAt when lastCheckedAt is null (older API response)", () => {
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => {
      recordFn!(makeResult({ refreshedAt: "2026-05-08T08:00:00Z", lastCheckedAt: null }));
    });
    expect(screen.getByTestId("ts").textContent).toBe("2026-05-08T08:00:00Z");
  });

  it("yields null when both timestamps are absent", () => {
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => {
      recordFn!(makeResult({ refreshedAt: null, lastCheckedAt: null }));
    });
    expect(screen.getByTestId("ts").textContent).toBe("none");
  });
});

// ─── recordAttemptStart / recordAttemptFinished semantics ────────────────────
// `recordAttemptStart` must NOT stamp `lastAttemptAt` — only the heartbeat
// hook owns that timer anchor.  Otherwise every page-load would push the
// heartbeat's next-attempt window forward by 60 min, and the footer's
// countdown would diverge from the header's "Last refresh HH:MM" reading.
// Overlapping attempts (heartbeat + dashboard loader) use a counter so an
// early settle from one doesn't clear the in-flight flag while the other is
// still pending.

interface AttemptHarnessApi {
  isRefreshing: boolean;
  lastAttemptAt: number | null;
  recordAttemptStart: () => void;
  recordAttemptFinished: () => void;
}

function AttemptHarness({ onApi }: { onApi: (api: AttemptHarnessApi) => void }) {
  const ctx = useRefreshContext();
  onApi({
    isRefreshing: ctx.isRefreshing,
    lastAttemptAt: ctx.lastAttemptAt,
    recordAttemptStart: ctx.recordAttemptStart,
    recordAttemptFinished: ctx.recordAttemptFinished,
  });
  return (
    <div>
      <span data-testid="refreshing">{String(ctx.isRefreshing)}</span>
      <span data-testid="last-attempt">{String(ctx.lastAttemptAt)}</span>
    </div>
  );
}

describe("RefreshHeartbeatProvider — attempt lifecycle", () => {
  it("recordAttemptStart flips isRefreshing without stamping lastAttemptAt or touching storage", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    expect(screen.getByTestId("last-attempt").textContent).toBe("null");
    expect(writeLastAttemptAtSpy).not.toHaveBeenCalled();

    act(() => { api!.recordAttemptStart(); });

    expect(screen.getByTestId("refreshing").textContent).toBe("true");
    // Critical: must NOT stamp lastAttemptAt — that would reset the
    // heartbeat schedule on every page load.
    expect(screen.getByTestId("last-attempt").textContent).toBe("null");
    expect(writeLastAttemptAtSpy).not.toHaveBeenCalled();
  });

  it("recordAttemptFinished clears isRefreshing", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });

  it("counter semantics: two starts + one finish keeps isRefreshing true (overlapping attempts)", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // Simulate the heartbeat firing while the dashboard loader is also in
    // flight — both increment.  The first one to settle must not clear the
    // flag while the second is still pending.
    act(() => { api!.recordAttemptStart(); });
    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });

  it("recordAttemptFinished is clamped — extra finishes don't drive isRefreshing into an inconsistent state", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // Defensive: a stray finish (e.g. duplicate cleanup) must not leave the
    // counter negative so the next start still flips refreshing immediately.
    act(() => { api!.recordAttemptFinished(); });
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
  });
});
