import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { useRefreshHeartbeat } from "./refresh-heartbeat";
import type { DashboardFetchResult } from "./api";
import { trackSourceOpenError } from "./analytics";
import { notifyError } from "./notify";

// App-scope refresh state.  Two writers:
//   1. The heartbeat (runs every 60 min of real elapsed time when authenticated)
//   2. The dashboard's initial-mount loader (bootstrap / GET) — records the
//      `refreshedAt` it just received so the header updates immediately on
//      first paint, without waiting on the heartbeat.
//
// Readers:
//   - <AppHeader> consumes `lastRefreshedAt` for the "Last refresh" badge.
//   - <Dashboard> consumes `heartbeatResult` to overlay refreshed stories
//     while the page is mounted.

interface RefreshContextValue {
  lastRefreshedAt: string | null;
  /** Latest heartbeat-driven refresh result. Null until the first tick succeeds. */
  heartbeatResult: DashboardFetchResult | null;
  /** Called by Dashboard's initial loader after a successful bootstrap/GET. */
  recordSuccessfulRefresh: (result: DashboardFetchResult) => void;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function RefreshHeartbeatProvider({ children }: { children: ReactNode }) {
  const { recognizedIdentity } = useAuth();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [heartbeatResult, setHeartbeatResult] = useState<DashboardFetchResult | null>(null);

  useRefreshHeartbeat({
    enabled: !!recognizedIdentity,
    onSuccess: (result) => {
      setHeartbeatResult(result);
      setLastRefreshedAt(result.refreshedAt ?? null);
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Heartbeat refresh failed";
      trackSourceOpenError({ message, code: "dashboard_refresh_failed" });
      notifyError("We couldn't refresh stories. Showing previous run.");
    },
  });

  const recordSuccessfulRefresh = useCallback((result: DashboardFetchResult) => {
    setLastRefreshedAt(result.refreshedAt ?? null);
  }, []);

  const value = useMemo<RefreshContextValue>(
    () => ({ lastRefreshedAt, heartbeatResult, recordSuccessfulRefresh }),
    [lastRefreshedAt, heartbeatResult, recordSuccessfulRefresh]
  );

  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefreshContext(): RefreshContextValue {
  const v = useContext(RefreshContext);
  if (!v) throw new Error("useRefreshContext must be used within RefreshHeartbeatProvider");
  return v;
}
