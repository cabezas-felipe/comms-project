import { useEffect, useRef } from "react";
import { REFRESH_INTERVAL_MS } from "@tempo/contracts";
import { refreshDashboard, type DashboardFetchResult } from "./api";

// App-scope refresh heartbeat.
//
// Guarantees that, once a user is authenticated, the app attempts a dashboard
// refresh at least once every `intervalMs` of real elapsed time — independent
// of whether the dashboard page is mounted, whether the user navigates, or
// whether route transitions reset component-level timers.  The last-attempt
// timestamp is persisted in localStorage so the invariant survives remounts,
// soft reloads, and (when the user returns within the window) cross-tab use.

// Known limitation: this key is global to the browser, not scoped to the
// signed-in user.  Two accounts that use the same browser will share one
// anchor — switching accounts will surface the previous account's last
// attempt timestamp until a real attempt overwrites it.  Acceptable for the
// prototype; revisit by keying the storage entry on `recognizedIdentity.userId`
// (e.g. `tempo_dashboard_last_refresh_attempt_at:<uid>`) before multi-user
// production rollout.
export const LAST_REFRESH_ATTEMPT_KEY = "tempo_dashboard_last_refresh_attempt_at";
// Re-exported from @tempo/contracts so prototype callers keep their existing
// import path; contracts is the single source of truth for refresh cadence.
export { REFRESH_INTERVAL_MS };

function getDefaultStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLastAttemptAt(storage: Storage | null = getDefaultStorage()): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_REFRESH_ATTEMPT_KEY);
    if (!raw) return null;
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLastAttemptAt(
  timestamp: number,
  storage: Storage | null = getDefaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(LAST_REFRESH_ATTEMPT_KEY, new Date(timestamp).toISOString());
  } catch {
    /* storage blocked / quota */
  }
}

export interface RefreshHeartbeatOptions {
  /** Active when truthy (recognized identity).  Toggling to false stops timers. */
  enabled: boolean;
  /** Called after a successful refresh tick. */
  onSuccess?: (result: DashboardFetchResult) => void;
  /** Called after a failed refresh tick (used for logging/telemetry). */
  onError?: (error: unknown) => void;
  /**
   * Called synchronously when a heartbeat attempt begins — *after* the
   * attempt timestamp is stamped, *before* the network call.  Fires for
   * every attempt, success or failure.  May return an opaque token (e.g.
   * a slot ID) identifying this attempt; the same token is threaded back
   * to `onAttemptComplete` so the consumer can settle the exact slot it
   * started even if attempts complete out of order.  Returning nothing is
   * supported — the consumer can fall back to its own correlation
   * strategy (e.g. oldest-slot pop).
   */
  onAttemptStart?: (timestamp: number) => unknown;
  /**
   * Called when a heartbeat attempt settles (success or failure), regardless
   * of cancellation.  Receives whatever token (if any) was returned by the
   * paired `onAttemptStart`, so the consumer can correlate the settlement
   * to the exact in-flight slot.
   */
  onAttemptComplete?: (token?: unknown) => void;
  /** Injection seams for tests. */
  fetcher?: () => Promise<DashboardFetchResult>;
  now?: () => number;
  storage?: Storage | null;
  intervalMs?: number;
}

/**
 * Mounts a single elapsed-time refresh heartbeat for the lifetime of the
 * provider component.  Place at app scope (above `<Routes>`) so route
 * transitions never reset its timer.
 */
export function useRefreshHeartbeat(options: RefreshHeartbeatOptions): void {
  const {
    enabled,
    onSuccess,
    onError,
    onAttemptStart,
    onAttemptComplete,
    fetcher = refreshDashboard,
    now = Date.now,
    storage = getDefaultStorage(),
    intervalMs = REFRESH_INTERVAL_MS,
  } = options;

  // Pin callbacks/fetcher behind refs so we don't re-run the scheduling effect
  // every time a parent renders with a new function identity.  The effect's
  // own dependencies are limited to `enabled` and `intervalMs`.
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  const onAttemptStartRef = useRef(onAttemptStart);
  const onAttemptCompleteRef = useRef(onAttemptComplete);
  const fetcherRef = useRef(fetcher);
  const nowRef = useRef(now);
  const storageRef = useRef<Storage | null>(storage);
  const inFlightRef = useRef(false);

  useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onAttemptStartRef.current = onAttemptStart; }, [onAttemptStart]);
  useEffect(() => { onAttemptCompleteRef.current = onAttemptComplete; }, [onAttemptComplete]);
  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);
  useEffect(() => { nowRef.current = now; }, [now]);
  useEffect(() => { storageRef.current = storage; }, [storage]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const clearPending = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const schedule = (delayMs: number) => {
      clearPending();
      timeoutId = setTimeout(tick, Math.max(0, delayMs));
    };

    const tick = async () => {
      if (cancelled) return;
      // Defensive: a re-entrant tick (e.g. storage event firing mid-flight)
      // is swallowed.  The in-flight fetch will reschedule on completion.
      if (inFlightRef.current) return;

      inFlightRef.current = true;
      // Stamp BEFORE the network call so concurrent tabs / a remount during
      // the in-flight fetch don't double-attempt.  Failure doesn't reset
      // this — we deliberately want a 60-minute pace even after errors.
      const startedAt = nowRef.current();
      writeLastAttemptAt(startedAt, storageRef.current);
      // Capture the token (if any) from onAttemptStart so onAttemptComplete
      // can settle the exact slot this tick owns — protects against
      // out-of-order completions when consumers run multiple attempts.
      const attemptToken = onAttemptStartRef.current?.(startedAt);

      try {
        const result = await fetcherRef.current();
        if (!cancelled) onSuccessRef.current?.(result);
      } catch (err) {
        if (!cancelled) onErrorRef.current?.(err);
      } finally {
        inFlightRef.current = false;
        onAttemptCompleteRef.current?.(attemptToken);
        if (!cancelled) schedule(intervalMs);
      }
    };

    const evaluate = () => {
      if (cancelled) return;
      const last = readLastAttemptAt(storageRef.current);
      if (last === null) {
        // Fresh start (no prior attempt recorded).  Treat *now* as the
        // baseline so we don't fire on every cold boot, and schedule the
        // first tick a full interval out.
        writeLastAttemptAt(nowRef.current(), storageRef.current);
        schedule(intervalMs);
        return;
      }
      const delay = last + intervalMs - nowRef.current();
      if (delay <= 0) {
        void tick();
      } else {
        schedule(delay);
      }
    };

    evaluate();

    // Cross-tab sync: when another tab writes the timestamp (or the user
    // clears it manually), recompute due-ness.
    const onStorageEvent = (e: StorageEvent) => {
      if (e.key === LAST_REFRESH_ATTEMPT_KEY) evaluate();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorageEvent);
    }

    return () => {
      cancelled = true;
      clearPending();
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorageEvent);
      }
    };
  }, [enabled, intervalMs]);
}
