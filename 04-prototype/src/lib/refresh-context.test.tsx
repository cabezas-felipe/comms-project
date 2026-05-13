import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { RefreshHeartbeatProvider, useRefreshContext } from "@/lib/refresh-context";
import type { DashboardFetchResult } from "@/lib/api";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ recognizedIdentity: { email: "u@example.com", userId: "u1" } }),
}));
vi.mock("@/lib/refresh-heartbeat", () => ({
  useRefreshHeartbeat: () => {},
}));
vi.mock("@/lib/analytics", () => ({
  trackSourceOpenError: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({
  notifyError: vi.fn(),
}));

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
