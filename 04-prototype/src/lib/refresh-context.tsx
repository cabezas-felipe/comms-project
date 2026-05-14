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
  writeLastAttemptAt,
} from "./refresh-heartbeat";
import type { DashboardFetchResult } from "./api";
import { trackSourceOpenError } from "./analytics";
import { notifyError } from "./notify";

// App-scope refresh state.  Single visible anchor (`lastAttemptAt`) drives
// BOTH the header's "Last refresh HH:MM" badge and the footer's "Next refresh
// in ~Xm" countdown so they remain mathematically consistent across the
// app's lifetime.
//
// Who writes the anchor:
//   1. The heartbeat hook (every 60 min of real elapsed time once
//      authenticated).  In-flight on attempt start; anchor advances on every
//      settlement (success or failure).  Heartbeat hits POST /refresh.
//   2. The Dashboard loader's BOOTSTRAP path (Landing → Dashboard,
//      Onboarding → Dashboard).  In-flight on attempt start; anchor advances
//      on settlement UNLESS the server reports `served_fresh_snapshot` (the
//      bootstrap route didn't actually run the refresh executor — no attempt
//      was made, so the clock must not move).
//   3. The Dashboard loader's GET path (in-app navigation, direct URL, retry).
//      Does NOT toggle in-flight and does NOT advance the anchor.  Its only
//      anchor interaction is `seedAnchorIfMissing` on success — used to plant
//      the first-paint timestamp when no anchor exists yet.  When the GET
//      response carries no parseable `_meta.lastCheckedAt` / `refreshedAt`
//      the anchor stays null and the header renders "—"; GET never invents
//      an anchor from client wall-clock.
//
// Why the GET path is decoupled: GET serves the persisted snapshot — it is
// not a refresh attempt.  Mounting the dashboard from Settings → Dashboard
// must not tick the "Last refresh" badge forward, because nothing fresh
// happened.  After the very first response seeds the anchor, subsequent GET
// remounts leave the anchor exactly where the last real refresh attempt put
// it.
//
// Readers:
//   - <AppHeader> consumes `lastRefreshedAt` (ISO derived from the anchor).
//   - <Dashboard> consumes `heartbeatResult` to overlay refreshed stories,
//     and `lastAttemptAt` + `isRefreshing` for the footer.
//
// A provider-level watchdog clamps the in-flight UI flag so a hung fetch
// (or a runaway promise) cannot strand the footer on "Refreshing now…".  The
// watchdog does NOT abort the in-flight request — server work continues; we
// only unblock the UI and snap the anchor forward so the next countdown
// remains coherent.

function resolveLastCheckDisplayAt(result: DashboardFetchResult): string | null {
  return result.lastCheckedAt ?? result.refreshedAt ?? null;
}

function parseServerAnchorMs(result: DashboardFetchResult | null | undefined): number | null {
  if (!result) return null;
  const iso = resolveLastCheckDisplayAt(result);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
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

/**
 * Options passed to `recordAttemptFinished` so callers can both pin the
 * anchor to a server-provided timestamp AND opt out of advancing it when the
 * backend reports that no refresh actually ran (e.g. bootstrap
 * `served_fresh_snapshot`).
 */
export interface SettleOptions {
  /**
   * Server response for this attempt — used to prefer `lastCheckedAt` /
   * `refreshedAt` over client `Date.now()` when advancing the anchor.
   */
  result?: DashboardFetchResult | null;
  /**
   * Default `true`.  When `false`, the slot is released but the anchor does
   * not move.  Use for bootstrap responses that report
   * `served_fresh_snapshot` — the backend served the persisted snapshot
   * without running the refresh executor, so this caller did not perform a
   * refresh attempt.
   */
  advanceClock?: boolean;
}

interface RefreshContextValue {
  /**
   * ISO display value for the header's "Last refresh" badge.  Derived from
   * `lastAttemptAt` so the header and the footer always agree to the
   * minute, regardless of attempt outcome.
   */
  lastRefreshedAt: string | null;
  /** Latest heartbeat-driven refresh result. Null until the first tick succeeds. */
  heartbeatResult: DashboardFetchResult | null;
  /**
   * First-paint seed.  Used by the GET path (and by bootstrap
   * `served_fresh_snapshot` responses) so a brand-new session that has no
   * persisted anchor yet still surfaces a timestamp from the first server
   * response.  No-op once `lastAttemptAt` has been set — GET remounts after
   * the seed must never advance the anchor.
   */
  seedAnchorIfMissing: (result: DashboardFetchResult) => void;
  /**
   * Single attempt anchor (epoch ms).  Advances on every refresh attempt
   * settlement — success, no-op, or failure — so the footer's countdown and
   * the header's badge are always derived from the same moment in time.
   */
  lastAttemptAt: number | null;
  /** True while any refresh attempt (heartbeat or bootstrap) is in flight. */
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
   * token returned by the paired `recordAttemptStart` so the exact slot is
   * removed even when attempts complete out of order.  `options.result`
   * lets the provider prefer the server's `lastCheckedAt` / `refreshedAt`
   * over client wall-clock.  `options.advanceClock=false` releases the
   * slot without moving the anchor (used for bootstrap
   * `served_fresh_snapshot`).
   */
  recordAttemptFinished: (token?: AttemptToken, options?: SettleOptions) => void;
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
  // Live mirror of `lastAttemptAt` for gates that need a synchronous read
  // (e.g. seedAnchorIfMissing's "already seeded?" check fired from a Promise
  // .then() callback).  Reading React state from a closure inside a callback
  // would pin us to the value at the time the callback was created — the ref
  // is always current.  Seeded eagerly from the same `readLastAttemptAt()`
  // initializer so the ref is correct on the very first render.
  const lastAttemptAtRef = useRef<number | null>(lastAttemptAt);
  // Per-attempt slots replace the older `pendingAttempts: number` counter so
  // the watchdog can expire one specific stale attempt without flushing
  // newer overlapping ones.
  const [inFlight, setInFlight] = useState<readonly InFlightSlot[]>([]);
  const nextSlotIdRef = useRef(1);
  const isRefreshing = inFlight.length > 0;

  // Mirror committed state into the ref after every commit.  Lives inside a
  // post-commit effect (not an updater) so it stays a pure read-after-write
  // sync — React's concurrent rendering or StrictMode double-invocation
  // never causes spurious mirror writes.
  useEffect(() => {
    lastAttemptAtRef.current = lastAttemptAt;
  }, [lastAttemptAt]);

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
    (token: unknown, options?: SettleOptions) => {
      const advanceClock = options?.advanceClock !== false;
      if (advanceClock) {
        const serverMs = parseServerAnchorMs(options?.result ?? null);
        // Prefer the server-stamped time when present so the badge tracks
        // the server clock; otherwise fall back to client `now()` so a
        // failed or legacy-API attempt still moves the badge (the
        // alternative would strand the countdown on a stale anchor).
        advanceAnchor(serverMs ?? Date.now());
      }
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
      // Every heartbeat settlement (success, no-op, failure) advances the
      // anchor — heartbeats are POST /refresh attempts, so they always
      // count as "we checked feeds at this moment".  When the success path
      // already pinned the anchor to the server timestamp via onSuccess,
      // the monotonic guard inside `advanceAnchor` ensures we don't regress.
      settleSlot(token);
    },
    onSuccess: (result) => {
      setHeartbeatResult(result);
      // Prefer the server's check timestamp when it's later than our local
      // settlement — keeps the display aligned with server clock for
      // successful runs.  advanceAnchor's monotonic guard handles the
      // ordering against the prior onAttemptStart bump.
      const serverMs = parseServerAnchorMs(result);
      if (serverMs !== null) advanceAnchor(serverMs);
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

  const seedAnchorIfMissing = useCallback((result: DashboardFetchResult) => {
    // GET path / served_fresh_snapshot bootstrap path.  Establishes the
    // anchor on the very first dashboard entry when nothing is persisted
    // yet; never moves an existing anchor.  If the server omits both
    // `lastCheckedAt` and `refreshedAt` we leave the anchor as null so the
    // header renders "—" — the GET path never synthesizes an anchor from
    // client wall-clock.
    //
    // Persistence: when we DO seed (anchor was null AND the response
    // carried a parseable timestamp), mirror `serverMs` into
    // `LAST_REFRESH_ATTEMPT_KEY` so a full reload rehydrates from the same
    // server `lastCheckedAt` the badge is currently showing.  Without this
    // the heartbeat hook's cold-boot "null → write Date.now()" baseline
    // would win on reload and the header would silently snap back to the
    // app-open moment instead of the server clock.
    //
    // Concurrency: the "already seeded?" gate reads `lastAttemptAtRef`
    // (synchronously kept in lockstep with committed state) and updates it
    // synchronously before any setState / LS write.  This makes the seed
    // deterministic under React's concurrent rendering and StrictMode's
    // double-invocation of pure updaters — neither setState updaters nor
    // post-render effects can re-enter and double-write.  The functional
    // form of setLastAttemptAt is a belt-and-braces guard against a racing
    // writer (e.g. a heartbeat storage event handler) committing between
    // the ref check and the commit; if `prev` is non-null when the updater
    // finally runs, we keep their value and skip the regression.
    const serverMs = parseServerAnchorMs(result);
    if (serverMs === null) return;
    if (lastAttemptAtRef.current !== null) return;
    // Synchronous ref bump: a second call in the same tick (StrictMode or a
    // sibling effect firing the same handler) bails at the top above.
    //
    // Intentional ref/state divergence: `lastAttemptAtRef.current` now
    // leads `lastAttemptAt` by one commit cycle.  The post-commit effect
    // re-syncs the ref to whatever state actually commits (including the
    // belt-and-braces functional updater's "keep prev if non-null" guard),
    // so the divergence closes within the same render pass.  We accept the
    // brief lead because it's what guarantees single-entry seed side
    // effects under concurrent rendering and StrictMode — the alternative
    // (waiting for commit before bumping the ref) reopens the very
    // double-write race this design exists to close.
    lastAttemptAtRef.current = serverMs;
    setLastAttemptAt((prev) => (prev === null ? serverMs : prev));
    // Monotonic LS write: a cross-tab refresh that landed between this
    // session's last commit-sync and this call may have stamped a newer
    // value into storage.  We must not regress it.  Re-reading LS at this
    // moment is safe because the ref gate above ensures we run at most
    // once per logical seed; the read happens exactly once and the write
    // is skipped when the persisted value is already at or beyond
    // `serverMs`.  The storage event handler will subsequently advance
    // React state / the ref to the newer value via `advanceAnchor`'s
    // monotonic guard, so the temporary state lag closes on the next tick.
    const persistedMs = readLastAttemptAt();
    if (persistedMs === null || persistedMs < serverMs) {
      writeLastAttemptAt(serverMs);
    }
  }, []);

  const recordAttemptStart = useCallback((): AttemptToken => {
    // Mirrors the heartbeat semantics: in-flight flag goes up, anchor only
    // moves on settlement so the header stays stable during the fetch.
    // Returning the token lets the caller settle this exact slot even when
    // attempts complete out of order.
    return pushSlot();
  }, [pushSlot]);

  const recordAttemptFinished = useCallback(
    (token?: AttemptToken, options?: SettleOptions) => {
      // Refresh-style attempts (POST /refresh, POST /bootstrap that runs the
      // refresh executor) advance on settlement — even on failure — so the
      // header and footer remain coupled.  Token-aware settlement removes
      // the exact slot; omitting the token falls back to oldest-slot pop.
      // `options.advanceClock=false` releases the slot without moving the
      // anchor — bootstrap `served_fresh_snapshot` lands here because the
      // backend did not actually run a refresh.
      settleSlot(token, options);
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
      seedAnchorIfMissing,
      lastAttemptAt,
      isRefreshing,
      recordAttemptStart,
      recordAttemptFinished,
    }),
    [
      lastRefreshedAt,
      heartbeatResult,
      seedAnchorIfMissing,
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
