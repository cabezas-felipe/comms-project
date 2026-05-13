import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./auth";
import {
  LAST_REFRESH_ATTEMPT_KEY,
  readLastAttemptAt,
  useRefreshHeartbeat,
} from "./refresh-heartbeat";
import type { DashboardFetchResult } from "./api";
import { trackSourceOpenError } from "./analytics";
import { notifyError } from "./notify";

// App-scope refresh state.  Single visible anchor (`lastAttemptAt`) drives
// BOTH the header's "Last refresh HH:MM" badge and the footer's "Next refresh
// in ~Xm" countdown so they remain mathematically consistent across the
// app's lifetime.
//
// Writers:
//   1. The heartbeat hook (runs every 60 min of real elapsed time once
//      authenticated).  Bumps in-flight on attempt start, advances the
//      anchor on attempt settlement (success OR failure — every settlement
//      counts as "we checked feeds at this moment").
//   2. The dashboard loader (bootstrap / GET) — same lifecycle: in-flight
//      on start, anchor advances on settlement.  On success it prefers the
//      server's `lastCheckedAt` so the badge reflects the server clock for
//      the first paint.
//
// Readers:
//   - <AppHeader> consumes `lastRefreshedAt` (ISO derived from the anchor).
//   - <Dashboard> consumes `heartbeatResult` to overlay refreshed stories,
//     and `lastAttemptAt` (number ms) + `isRefreshing` for the footer.
//
// A provider-level watchdog clamps the in-flight UI flag so a hung fetch
// (or a runaway promise) cannot strand the footer on "Refreshing now…".  The
// watchdog does NOT abort the in-flight request — server work continues; we
// only unblock the UI and snap the anchor forward so the next countdown
// remains coherent.

function resolveLastCheckDisplayAt(result: DashboardFetchResult): string | null {
  return result.lastCheckedAt ?? result.refreshedAt ?? null;
}

// Upper bound on how long the footer can sit on "Refreshing now…" before the
// UI gives up and snaps back to countdown.  Generous enough to cover slow
// pipelines (the backend timeout dominates) but short enough that a truly
// dropped promise can't pin the footer indefinitely.
export const REFRESH_WATCHDOG_MS = 90_000;

/**
 * Opaque per-attempt identifier.  Issued by `recordAttemptStart` and
 * accepted by `recordAttemptFinished` so callers can settle the specific
 * slot they started, even when attempts complete out of order.  Numeric
 * type kept simple — uniqueness is guaranteed within a provider instance
 * via a monotonic counter.
 */
export type AttemptToken = number;

interface RefreshContextValue {
  /**
   * ISO display value for the header's "Last refresh" badge.  Derived from
   * `lastAttemptAt` so the header and the footer always agree to the
   * minute, regardless of attempt outcome.
   */
  lastRefreshedAt: string | null;
  /** Latest heartbeat-driven refresh result. Null until the first tick succeeds. */
  heartbeatResult: DashboardFetchResult | null;
  /** Called by Dashboard's initial loader after a successful bootstrap/GET. */
  recordSuccessfulRefresh: (result: DashboardFetchResult) => void;
  /**
   * Single attempt anchor (epoch ms).  Advances on every refresh attempt
   * settlement — success, no-op, or failure — so the footer's countdown and
   * the header's badge are always derived from the same moment in time.
   */
  lastAttemptAt: number | null;
  /** True while any refresh attempt (heartbeat or dashboard loader) is in flight. */
  isRefreshing: boolean;
  /**
   * Signal that a refresh attempt is starting.  Returns a token that
   * uniquely identifies this attempt; pass it back to
   * `recordAttemptFinished` so the exact slot is settled even when
   * attempts complete out of order.  The anchor advances only on
   * settlement so the header doesn't tick forward mid-fetch.
   */
  recordAttemptStart: () => AttemptToken;
  /**
   * Mark a refresh attempt as settled (success or failure).  Pass the
   * token returned by the paired `recordAttemptStart` to remove that
   * specific slot.  Omitting the token falls back to FIFO settlement
   * (remove the oldest in-flight slot) — safe for legacy call sites that
   * predate token threading.
   */
  recordAttemptFinished: (token?: AttemptToken) => void;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

// Per-attempt in-flight slot.  Each `recordAttemptStart` / `onAttemptStart`
// pushes a slot, returning its `id` as an `AttemptToken` so the caller can
// settle the exact slot later — out-of-order completions no longer pop the
// wrong slot.  Tracking `startedAt` per slot lets the watchdog expire only
// slots that have actually hung, preserving newer overlapping attempts so
// the UI doesn't briefly hide active concurrency state.
type InFlightSlot = {
  readonly id: AttemptToken;
  readonly startedAt: number;
};

export function RefreshHeartbeatProvider({ children }: { children: ReactNode }) {
  const { recognizedIdentity } = useAuth();
  const [heartbeatResult, setHeartbeatResult] = useState<DashboardFetchResult | null>(null);
  // Single anchor for both header + footer.  Seeded from localStorage so a
  // remount / cross-tab return keeps the visible badge stable while the
  // heartbeat re-evaluates due-ness in the background.
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(() => readLastAttemptAt());
  // Per-attempt slots replace the older `pendingAttempts: number` counter so
  // the watchdog can expire one specific stale attempt without flushing
  // newer overlapping ones.
  const [inFlight, setInFlight] = useState<readonly InFlightSlot[]>([]);
  const nextSlotIdRef = useRef(1);
  const isRefreshing = inFlight.length > 0;

  // Anchor never moves backward — that would let an out-of-order callback
  // (e.g. a stale storage event after a fresh local settlement) regress the
  // badge.
  const advanceAnchor = useCallback((toMs: number) => {
    setLastAttemptAt((prev) => (prev === null ? toMs : Math.max(prev, toMs)));
  }, []);

  // Push a new in-flight slot stamped with the current time.  Returns the
  // slot's `AttemptToken` so the caller can settle the exact slot later
  // even when attempts complete out of order.
  const pushSlot = useCallback((): AttemptToken => {
    const id: AttemptToken = nextSlotIdRef.current++;
    const startedAt = Date.now();
    setInFlight((prev) => [...prev, { id, startedAt }]);
    return id;
  }, []);

  // Settlement helpers.  Token-based path matches the slot precisely;
  // legacy callers that omit the token fall back to oldest-slot pop, which
  // preserves prior behavior for any code path that hasn't been threaded.
  const removeSlotById = useCallback((id: AttemptToken) => {
    setInFlight((prev) => prev.filter((slot) => slot.id !== id));
  }, []);

  const popOldestSlot = useCallback(() => {
    setInFlight((prev) => (prev.length === 0 ? prev : prev.slice(1)));
  }, []);

  const settleSlot = useCallback(
    (token: unknown) => {
      advanceAnchor(Date.now());
      if (typeof token === "number") removeSlotById(token);
      else popOldestSlot();
    },
    [advanceAnchor, popOldestSlot, removeSlotById]
  );

  useRefreshHeartbeat({
    enabled: !!recognizedIdentity,
    onAttemptStart: () => {
      // Anchor advances on settlement, not on start — keeps the header from
      // racing ahead of the user while a long fetch is still in flight.
      // The returned token is threaded back via `onAttemptComplete` so the
      // hook can settle the exact slot it started.
      return pushSlot();
    },
    onAttemptComplete: (token) => {
      // Every settlement (success, no-op, failure) advances the anchor so
      // the header + footer move together and "attempt happened" is the
      // unambiguous signal.
      settleSlot(token);
    },
    onSuccess: (result) => {
      setHeartbeatResult(result);
      // Prefer the server's check timestamp when it's later than our local
      // settlement — keeps the display aligned with server clock for
      // successful runs.  advanceAnchor's monotonic guard handles the
      // ordering against the prior onAttemptStart bump.
      const serverIso = resolveLastCheckDisplayAt(result);
      if (serverIso) {
        const ms = Date.parse(serverIso);
        if (Number.isFinite(ms)) advanceAnchor(ms);
      }
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Heartbeat refresh failed";
      trackSourceOpenError({ message, code: "dashboard_refresh_failed" });
      notifyError("We couldn't refresh stories. Showing previous run.");
    },
  });

  // Cross-tab sync: another tab stamping a fresh attempt mirrors into local
  // state so the badge tracks reality.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: StorageEvent) => {
      if (e.key !== LAST_REFRESH_ATTEMPT_KEY) return;
      const t = readLastAttemptAt();
      if (t !== null) advanceAnchor(t);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [advanceAnchor]);

  // Watchdog — guarantees the footer never stays stuck on "Refreshing now…".
  // Schedules at the oldest slot's deadline and, when it fires, expires only
  // those slots whose `startedAt` actually crossed the ceiling.  Newer
  // overlapping slots survive so legitimate concurrent attempts still hold
  // the in-flight flag until they themselves settle (or expire).  Server
  // work continues — we don't abort it; we just unblock the UI for the
  // stale slot(s) and snap the anchor forward.
  useEffect(() => {
    if (inFlight.length === 0) return;
    const now = Date.now();
    const oldestStart = inFlight.reduce<number>(
      (min, slot) => (slot.startedAt < min ? slot.startedAt : min),
      inFlight[0].startedAt
    );
    const fireIn = Math.max(0, oldestStart + REFRESH_WATCHDOG_MS - now);
    const id = setTimeout(() => {
      const cutoff = Date.now() - REFRESH_WATCHDOG_MS;
      setInFlight((prev) => prev.filter((slot) => slot.startedAt > cutoff));
      advanceAnchor(Date.now());
    }, fireIn);
    return () => clearTimeout(id);
  }, [inFlight, advanceAnchor]);

  const recordSuccessfulRefresh = useCallback((result: DashboardFetchResult) => {
    // Initial page-load loader: pick the server's check timestamp when
    // available so the header reflects server clock.  Falls back to "now"
    // for older API responses that omit `lastCheckedAt` / `refreshedAt`.
    const serverIso = resolveLastCheckDisplayAt(result);
    const serverMs = serverIso ? Date.parse(serverIso) : NaN;
    advanceAnchor(Number.isFinite(serverMs) ? serverMs : Date.now());
  }, [advanceAnchor]);

  const recordAttemptStart = useCallback((): AttemptToken => {
    // Mirrors the heartbeat semantics: in-flight flag goes up, anchor only
    // moves on settlement so the header stays stable during the fetch.
    // Returning the token lets the caller settle this exact slot even when
    // attempts complete out of order.
    return pushSlot();
  }, [pushSlot]);

  const recordAttemptFinished = useCallback(
    (token?: AttemptToken) => {
      // Always advance on settlement — even when the loader failed and no
      // server timestamp arrived — so the header and footer remain coupled.
      // Token-aware settlement removes the exact slot; omitting the token
      // falls back to oldest-slot pop for legacy call sites.
      settleSlot(token);
    },
    [settleSlot]
  );

  const lastRefreshedAt = useMemo<string | null>(() => {
    if (lastAttemptAt === null) return null;
    return new Date(lastAttemptAt).toISOString();
  }, [lastAttemptAt]);

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
