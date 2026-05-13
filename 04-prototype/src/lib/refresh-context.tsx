import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import {
  LAST_REFRESH_ATTEMPT_KEY,
  readLastAttemptAt,
  useRefreshHeartbeat,
} from "./refresh-heartbeat";
import type { DashboardFetchResult } from "./api";
import { trackSourceOpenError } from "./analytics";
import { notifyError } from "./notify";

// App-scope refresh state.  Two writers:
//   1. The heartbeat (runs every 60 min of real elapsed time when authenticated)
//   2. The dashboard's initial-mount loader (bootstrap / GET) — records the
//      check timestamp it just received so the header updates immediately on
//      first paint, without waiting on the heartbeat.
//
// Readers:
//   - <AppHeader> consumes `lastRefreshedAt` for the "Last refresh" badge.
//   - <Dashboard> consumes `heartbeatResult` to overlay refreshed stories
//     while the page is mounted, and `lastAttemptAt` / `isRefreshing` to drive
//     the "Next refresh in ~Xm" / "Refreshing now…" footer.
//
// Header display prefers `lastCheckedAt` (the server's most recent feed-check
// timestamp) over `refreshedAt` (the most recent snapshot write) so the clock
// advances on every refresh attempt — even watermark short-circuits where the
// story list doesn't change.  Older API responses without `lastCheckedAt`
// fall back to `refreshedAt` so prerelease clients still get a sensible value.

function resolveLastCheckDisplayAt(result: DashboardFetchResult): string | null {
  return result.lastCheckedAt ?? result.refreshedAt ?? null;
}

interface RefreshContextValue {
  lastRefreshedAt: string | null;
  /** Latest heartbeat-driven refresh result. Null until the first tick succeeds. */
  heartbeatResult: DashboardFetchResult | null;
  /** Called by Dashboard's initial loader after a successful bootstrap/GET. */
  recordSuccessfulRefresh: (result: DashboardFetchResult) => void;
  /**
   * Client-side timestamp (epoch ms) of the most recent *heartbeat* attempt.
   * Only the heartbeat hook writes to this — dashboard page loads must not
   * reset it, otherwise every visit would push the next attempt 60 minutes
   * out from "now" and the footer's countdown would diverge from the
   * header's `Last refresh HH:MM` reading.  Used purely as a fallback
   * baseline for the footer when no server `lastRefreshedAt` is available.
   */
  lastAttemptAt: number | null;
  /** True while any refresh attempt (heartbeat or dashboard loader) is in flight. */
  isRefreshing: boolean;
  /**
   * Signal that a dashboard-driven refresh attempt is starting.  Only flips
   * the in-flight flag — does NOT stamp `lastAttemptAt` (see the field doc
   * above for the rationale).
   */
  recordAttemptStart: () => void;
  /** Mark a dashboard-driven refresh attempt as settled (success or failure). */
  recordAttemptFinished: () => void;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function RefreshHeartbeatProvider({ children }: { children: ReactNode }) {
  const { recognizedIdentity } = useAuth();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [heartbeatResult, setHeartbeatResult] = useState<DashboardFetchResult | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(() => readLastAttemptAt());
  // Counter (not boolean) so overlapping attempts — e.g. a heartbeat tick
  // while the dashboard loader is still in flight — don't clear the
  // in-flight flag prematurely when one of them settles first.
  const [pendingAttempts, setPendingAttempts] = useState(0);
  const isRefreshing = pendingAttempts > 0;

  useRefreshHeartbeat({
    enabled: !!recognizedIdentity,
    onAttemptStart: (t) => {
      setLastAttemptAt(t);
      setPendingAttempts((n) => n + 1);
    },
    onAttemptComplete: () => {
      setPendingAttempts((n) => Math.max(0, n - 1));
    },
    onSuccess: (result) => {
      setHeartbeatResult(result);
      setLastRefreshedAt(resolveLastCheckDisplayAt(result));
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Heartbeat refresh failed";
      trackSourceOpenError({ message, code: "dashboard_refresh_failed" });
      notifyError("We couldn't refresh stories. Showing previous run.");
    },
  });

  // Cross-tab sync: when another tab stamps a fresh attempt, mirror it into
  // local state so the footer's countdown stays accurate.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: StorageEvent) => {
      if (e.key !== LAST_REFRESH_ATTEMPT_KEY) return;
      setLastAttemptAt(readLastAttemptAt());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const recordSuccessfulRefresh = useCallback((result: DashboardFetchResult) => {
    setLastRefreshedAt(resolveLastCheckDisplayAt(result));
  }, []);

  const recordAttemptStart = useCallback(() => {
    // Intentionally does NOT touch `lastAttemptAt` / storage: the dashboard
    // loader is not a heartbeat tick, and stamping here would push the
    // footer's countdown back to 60 min on every navigation regardless of
    // the server's `lastCheckedAt`.  Only flip the in-flight counter so
    // the footer shows "Refreshing now…" during the fetch.
    setPendingAttempts((n) => n + 1);
  }, []);

  const recordAttemptFinished = useCallback(() => {
    setPendingAttempts((n) => Math.max(0, n - 1));
  }, []);

  const value = useMemo<RefreshContextValue>(
    () => ({
      lastRefreshedAt,
      heartbeatResult,
      recordSuccessfulRefresh,
      lastAttemptAt,
      isRefreshing,
      recordAttemptStart,
      recordAttemptFinished,
    }),
    [
      lastRefreshedAt,
      heartbeatResult,
      recordSuccessfulRefresh,
      lastAttemptAt,
      isRefreshing,
      recordAttemptStart,
      recordAttemptFinished,
    ]
  );

  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefreshContext(): RefreshContextValue {
  const v = useContext(RefreshContext);
  if (!v) throw new Error("useRefreshContext must be used within RefreshHeartbeatProvider");
  return v;
}
